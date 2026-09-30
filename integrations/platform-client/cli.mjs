#!/usr/bin/env node
// @ts-check
/**
 * `node cli.mjs run-suite --url https://tests.example.com --suite "Checkout smoke"` (V1.2 F5). The API token comes
 * from PLATFORM_API_TOKEN. Exit codes: 0 passed, 1 a verdict in --fail-on, 2 usage or platform error, 3 timed out.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createClient, parseFailOn, runSuiteAndWait } from "./client.mjs";

const USAGE = `Usage: platform-run-suite run-suite --url <platform URL> --suite <name or ste_ id>
       [--no-wait] [--timeout-minutes 30] [--junit <file>] [--fail-on FAILED,BLOCKED,INCONCLUSIVE]
The API token is read from PLATFORM_API_TOKEN.`;

/**
 * @param {string[]} argv
 * @returns {{ command: string | undefined; flags: Record<string, string | boolean> }}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument “${arg}”`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (!name) throw new Error(`Unexpected argument “${arg}”`);
    if (name.startsWith("no-")) flags[name.slice(3)] = false;
    else if (inline !== undefined) flags[name] = inline;
    else if (rest[i + 1] !== undefined && !rest[i + 1]?.startsWith("--")) flags[name] = rest[++i] ?? "";
    else flags[name] = true;
  }
  return { command, flags };
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {{ fetch?: typeof globalThis.fetch; out?: (line: string) => void; err?: (line: string) => void; sleep?: (ms: number) => Promise<void>; writeFile?: (p: string, t: string) => Promise<void> }} [io]
 * @returns {Promise<number>}
 */
export async function cli(argv, env, io = {}) {
  const out = io.out ?? ((l) => console.log(l));
  const err = io.err ?? ((l) => console.error(l));
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(`${e instanceof Error ? e.message : e}\n${USAGE}`);
    return 2;
  }
  const { command, flags } = parsed;
  if (command !== "run-suite" || typeof flags.url !== "string" || typeof flags.suite !== "string") {
    err(USAGE);
    return 2;
  }
  let client;
  let failOn;
  try {
    client = createClient({ url: flags.url, token: env.PLATFORM_API_TOKEN ?? "", ...(io.fetch ? { fetch: io.fetch } : {}) });
    failOn = parseFailOn(typeof flags["fail-on"] === "string" ? flags["fail-on"] : "FAILED");
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const minutes = typeof flags["timeout-minutes"] === "string" ? Number(flags["timeout-minutes"]) : 30;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    err("--timeout-minutes must be a positive number");
    return 2;
  }
  const result = await runSuiteAndWait({
    client,
    suite: flags.suite,
    wait: flags.wait !== false,
    timeoutMs: minutes * 60_000,
    failOn,
    ...(typeof flags.junit === "string" ? { junitPath: flags.junit } : {}),
    writeFile: io.writeFile ?? ((p, t) => writeFile(p, t, "utf8")),
    idempotencyKey: `cli-${randomUUID()}`,
    log: out,
    ...(io.sleep ? { sleep: io.sleep } : {}),
  });
  (result.exitCode === 2 ? err : out)(result.message);
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await cli(process.argv.slice(2), process.env);
}
