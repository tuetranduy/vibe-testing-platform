import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Where a discovery benchmark result came from: the source revision (with a fingerprint of uncommitted work), the
 * local agent image's identifier, and whether that image holds the same runner and fixture files as the tree.
 * Nothing here reads credentials or environment values.
 */
export interface BenchmarkProvenance {
  generatedAt: string;
  sourceRevision: string | null;
  /** True when tracked changes or untracked files exist; the fingerprint identifies that exact state. */
  dirty: boolean | null;
  dirtyFingerprint: string | null;
  image: { tag: string; id: string | null; contentMatchesTree: boolean | null };
  browserUse: string;
  node: string;
}

const git = (root: string, args: string[]) => execFileSync("git", args, { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });

function sourceState(root: string) {
  try {
    const revision = git(root, ["rev-parse", "HEAD"]).toString().trim();
    const diff = git(root, ["diff", "HEAD", "--binary"]);
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean).sort();
    const hash = createHash("sha256").update(diff);
    for (const file of untracked) {
      hash.update(`\0${file}\0`);
      hash.update(readFileSync(path.join(root, file)));
    }
    const dirty = diff.length > 0 || untracked.length > 0;
    return { sourceRevision: revision, dirty, dirtyFingerprint: dirty ? `sha256:${hash.digest("hex")}` : null };
  } catch {
    return { sourceRevision: null, dirty: null, dirtyFingerprint: null };
  }
}

/** `<sha256>  <relative path>` lines for the files the Dockerfile copies into /app (src and fixture). */
function treeManifest(app: string): string {
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === "__pycache__" || name.endsWith(".pyc")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else lines.push(`${createHash("sha256").update(readFileSync(full)).digest("hex")}  ${path.relative(app, full)}`);
    }
  };
  walk(path.join(app, "src"));
  walk(path.join(app, "fixture"));
  return lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n");
}

function imageState(app: string, tag: string) {
  try {
    const id = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], { encoding: "utf8" }).trim();
    // Offline and read-only: list the image's copies of the same files.
    const listed = execFileSync("docker", [
      "run", "--rm", "--network", "none", "--entrypoint", "sh", tag, "-c",
      'cd /app && find src fixture -type f ! -name "*.pyc" ! -path "*__pycache__*" -exec sha256sum {} +',
    ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const image = listed.trim().split("\n").sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n");
    return { tag, id, contentMatchesTree: image === treeManifest(app) };
  } catch {
    return { tag, id: null, contentMatchesTree: null };
  }
}

export function benchmarkProvenance(root: string, imageTag = "vtp-browser-use-discovery:1.0.6"): BenchmarkProvenance {
  const app = path.join(root, "apps/browser-use-discovery");
  const pin = /browser-use==([\w.]+)/.exec(readFileSync(path.join(app, "pyproject.toml"), "utf8"))?.[1] ?? "unknown";
  return {
    generatedAt: new Date().toISOString(),
    ...sourceState(root),
    image: imageState(app, imageTag),
    browserUse: pin,
    node: process.version,
  };
}

/** The operator's discovery model from a discovery.env file, read without loading any other value from it. */
export function discoveryModelOf(envFile: string): string | null {
  const line = readFileSync(envFile, "utf8").split("\n").find((entry) => /^\s*DISCOVERY_MODEL=/.test(entry));
  return line ? line.split("=", 2)[1]!.trim().replace(/^["']|["']$/g, "") : null;
}
