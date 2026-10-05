import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { RunnerProcessResult, SpawnRunner } from "@platform/testing-engine";
import type { WorkerLogger } from "../deps";
import { createRunnerSpawn } from "./runner-process";

/**
 * The Playwright runner as its own container (KI-029, Task 17 Ruling R32): the worker writes each rerun's
 * workspace to a volume it shares with the runner, and the runner runs the Playwright CLI there. The runner is
 * on an internal network with the worker only: no route to the database, Redis, object storage or the internet.
 * Its browser reaches the site through the worker's per-rerun egress proxy, over a loopback forwarder the runner
 * opens for that rerun, so the workspace's proxy URL stays `http://127.0.0.1:<port>`.
 *
 *   POST   /forwards      {proxyPort} → {id, port}: 127.0.0.1:<port> in the runner → <caller>:<proxyPort>
 *   DELETE /forwards/:id  closes it
 *   POST   /spawn         {cwd, cliPath, args, env, tmpDir} → {exitCode, signal} once the CLI has exited; closing
 *                         the request kills it (process group, as in runner-process.ts)
 *   GET    /healthz
 *
 * Every request but /healthz carries `Authorization: Bearer <RUNNER_TOKEN>`. A spawn must name a workspace
 * directly under RUNNER_WORKSPACE_DIR, its own @playwright/test CLI and tmp dir, and exactly the rerun's
 * arguments; only SECRET_<NAME> variables pass (runnerEnv). A forwarder only ever dials the worker that asked.
 */

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RERUN_ARGS = ["test", "--config", "playwright.config.js"];
/** A forwarder outlives no rerun: the longest run is 30 minutes. */
const FORWARD_MAX_MS = 35 * 60_000;
/** The spawn answer's headers go out at once and a space every 30 s, so no HTTP timeout ends a long rerun. */
const KEEPALIVE_MS = 30_000;
const MAX_BODY = 256 * 1024;

export interface RunnerServerOptions {
  host: string;
  port: number;
  token: string;
  /** RUNNER_WORKSPACE_DIR, the volume shared with the worker. */
  workspaceDir: string;
  logger: Pick<WorkerLogger, "info" | "warn" | "error">;
  /** Test seam: how the CLI is run. Default: the child process of runner-process.ts. */
  spawn?: SpawnRunner;
}

export interface RunnerServer {
  url: string;
  close(): Promise<void>;
}

class BadRequest extends Error {}

const sameToken = (header: string | undefined, token: string) => {
  const given = Buffer.from(/^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
};

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest("request body too large");
    chunks.push(chunk as Buffer);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("expected a JSON object");
  return body as Record<string, unknown>;
}

/** The spawn request, checked against the workspace layout (workspace.ts). */
export function checkSpawnRequest(body: Record<string, unknown>, workspaceDir: string) {
  const { cwd, cliPath, args, env, tmpDir } = body;
  if (typeof cwd !== "string" || path.dirname(cwd) !== path.resolve(workspaceDir) || !RUN_ID.test(path.basename(cwd)) || path.resolve(cwd) !== cwd) {
    throw new BadRequest("cwd must be a rerun workspace under RUNNER_WORKSPACE_DIR");
  }
  if (cliPath !== path.join(cwd, "node_modules", "@playwright", "test", "cli.js")) throw new BadRequest("cliPath must be the workspace's Playwright CLI");
  if (tmpDir !== path.join(cwd, "tmp")) throw new BadRequest("tmpDir must be the workspace's tmp dir");
  if (!Array.isArray(args) || JSON.stringify(args) !== JSON.stringify(RERUN_ARGS)) throw new BadRequest("args must be the rerun's");
  if (typeof env !== "object" || env === null || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) {
    throw new BadRequest("env must map names to strings");
  }
  return { cwd, cliPath, args: RERUN_ARGS, env: env as Record<string, string>, tmpDir };
}

export async function startRunnerServer(opts: RunnerServerOptions): Promise<RunnerServer> {
  if (opts.token.length < 16) throw new Error("RUNNER_TOKEN must be at least 16 characters");
  const spawn = opts.spawn ?? createRunnerSpawn({ logger: opts.logger });
  const forwards = new Map<string, { server: net.Server; timer: NodeJS.Timeout }>();
  let seq = 0;

  const closeForward = (id: string) => {
    const f = forwards.get(id);
    if (!f) return false;
    forwards.delete(id);
    clearTimeout(f.timer);
    f.server.close();
    return true;
  };

  async function openForward(workerAddress: string, proxyPort: number): Promise<{ id: string; port: number }> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((client) => {
      const upstream = net.connect(proxyPort, workerAddress);
      for (const s of [client, upstream]) {
        sockets.add(s);
        s.once("close", () => sockets.delete(s));
        s.on("error", () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    server.on("close", () => {
      for (const s of sockets) s.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const id = `fwd_${++seq}`;
    forwards.set(id, { server, timer: setTimeout(() => closeForward(id), FORWARD_MAX_MS).unref() });
    return { id, port: (server.address() as net.AddressInfo).port };
  }

  async function runSpawn(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>) {
    const input = checkSpawnRequest(body, opts.workspaceDir);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("the worker went away"));
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    const keepalive = setInterval(() => res.write(" "), KEEPALIVE_MS);
    let result: RunnerProcessResult;
    try {
      result = await spawn({ ...input, signal: controller.signal });
    } catch (err) {
      opts.logger.error({ err, cwd: input.cwd }, "Playwright runner could not be started");
      clearInterval(keepalive);
      res.end(JSON.stringify({ error: "SPAWN_FAILED" }));
      return;
    }
    clearInterval(keepalive);
    res.end(JSON.stringify(result));
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://runner");
      if (req.method === "GET" && url.pathname === "/healthz") return void res.end("ok");
      if (!sameToken(req.headers.authorization, opts.token)) {
        res.writeHead(401).end();
        return;
      }
      try {
        if (req.method === "POST" && url.pathname === "/spawn") return await runSpawn(req, res, await readJson(req));
        if (req.method === "POST" && url.pathname === "/forwards") {
          const { proxyPort } = await readJson(req);
          if (typeof proxyPort !== "number" || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new BadRequest("proxyPort");
          const worker = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await openForward(worker, proxyPort)));
          return;
        }
        const del = /^\/forwards\/(fwd_\d+)$/.exec(url.pathname);
        if (req.method === "DELETE" && del) {
          res.writeHead(closeForward(del[1]!) ? 204 : 404).end();
          return;
        }
        res.writeHead(404).end();
      } catch (err) {
        if (res.headersSent) return void res.end();
        const bad = err instanceof BadRequest || err instanceof SyntaxError;
        if (!bad) opts.logger.error({ err }, "runner request failed");
        res.writeHead(bad ? 400 : 500, { "content-type": "application/json" }).end(JSON.stringify({ error: bad ? (err as Error).message : "INTERNAL" }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://${opts.host === "0.0.0.0" ? "127.0.0.1" : opts.host}:${port}`,
    async close() {
      for (const id of [...forwards.keys()]) closeForward(id);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface RunnerClientOptions {
  /** RUNNER_URL, e.g. `http://runner:3100`. */
  url: string;
  token: string;
}

const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

/** The worker's spawn port over the runner service (instead of a child process of its own). */
export function createRemoteRunnerSpawn(opts: RunnerClientOptions): SpawnRunner {
  return async (input) => {
    const killed: RunnerProcessResult = { exitCode: null, signal: "SIGKILL" };
    if (input.signal.aborted) return killed;
    const { cwd, cliPath, args, env, tmpDir } = input;
    let text: string;
    try {
      const res = await fetch(new URL("/spawn", opts.url), {
        method: "POST",
        headers: headers(opts.token),
        body: JSON.stringify({ cwd, cliPath, args, env, tmpDir }),
        signal: input.signal,
      });
      text = await res.text();
      if (!res.ok) throw new Error(`the runner refused the rerun: ${res.status} ${text.trim().slice(0, 200)}`);
    } catch (err) {
      // Closing the request makes the runner kill the CLI's process group.
      if (input.signal.aborted) return killed;
      throw err;
    }
    const out = JSON.parse(text) as { exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string };
    if (out.error) throw new Error(`the runner could not start Playwright (${out.error})`);
    return { exitCode: out.exitCode ?? null, signal: out.signal ?? null };
  };
}

/** Opens a loopback forwarder in the runner to this worker's egress proxy; its port is the rerun's proxy port. */
export async function openRunnerForward(opts: RunnerClientOptions, proxyPort: number): Promise<{ port: number; close(): Promise<void> }> {
  const res = await fetch(new URL("/forwards", opts.url), { method: "POST", headers: headers(opts.token), body: JSON.stringify({ proxyPort }) });
  if (!res.ok) throw new Error(`the runner refused a proxy forwarder: ${res.status}`);
  const { id, port } = (await res.json()) as { id: string; port: number };
  return {
    port,
    async close() {
      await fetch(new URL(`/forwards/${id}`, opts.url), { method: "DELETE", headers: headers(opts.token) }).catch(() => {});
    },
  };
}
