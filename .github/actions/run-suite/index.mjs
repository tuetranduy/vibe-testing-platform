// @ts-check
/**
 * The run-suite GitHub Action (V1.2 F5): the platform client with GitHub's inputs, outputs, job summary, token
 * masking and CI context. No dependencies: it runs straight from the checkout.
 */
import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createClient, parseFailOn, runSuiteAndWait, summaryMarkdown } from "../../../integrations/platform-client/client.mjs";

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 */
const input = (env, name) => (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ fetch?: typeof globalThis.fetch; log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; appendFile?: (p: string, t: string) => Promise<void>; writeFile?: (p: string, t: string) => Promise<void> }} [io]
 * @returns {Promise<number>}
 */
export async function main(env, io = {}) {
  const log = io.log ?? ((l) => console.log(l));
  const append = io.appendFile ?? ((p, t) => appendFile(p, t, "utf8"));
  const token = input(env, "api-token");
  // Before anything can print it.
  if (token) log(`::add-mask::${token}`);
  const fail = (/** @type {string} */ message) => {
    log(`::error::${message.replace(/\r?\n/g, " ")}`);
    return 1;
  };

  let client;
  let failOn;
  try {
    client = createClient({ url: input(env, "platform-url"), token, ...(io.fetch ? { fetch: io.fetch } : {}) });
    failOn = parseFailOn(input(env, "fail-on") || "FAILED");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const minutes = Number(input(env, "timeout-minutes") || "30");
  if (!Number.isFinite(minutes) || minutes <= 0) return fail("timeout-minutes must be a positive number");

  const server = env.GITHUB_SERVER_URL ?? "";
  const runUrl = server.startsWith("https://") && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const context = {
    ...(env.GITHUB_REPOSITORY ? { repository: env.GITHUB_REPOSITORY } : {}),
    ...(env.GITHUB_REF ? { ref: env.GITHUB_REF } : {}),
    ...(env.GITHUB_SHA ? { sha: env.GITHUB_SHA } : {}),
    ...(runUrl ? { runUrl } : {}),
  };
  const junitPath = input(env, "junit-path");
  const result = await runSuiteAndWait({
    client,
    suite: input(env, "suite"),
    wait: input(env, "wait").toLowerCase() !== "false",
    timeoutMs: minutes * 60_000,
    failOn,
    context,
    // A re-run of the same job attempt starts a new suite run; retries inside one attempt don't.
    idempotencyKey: `gh-${env.GITHUB_RUN_ID ?? "local"}-${env.GITHUB_RUN_ATTEMPT ?? "1"}-${env.GITHUB_JOB ?? ""}-${randomUUID()}`,
    ...(junitPath ? { junitPath } : {}),
    writeFile: io.writeFile ?? ((p, t) => writeFile(p, t, "utf8")),
    log,
    ...(io.sleep ? { sleep: io.sleep } : {}),
  });

  if (env.GITHUB_OUTPUT) {
    await append(env.GITHUB_OUTPUT, `suite-run-id=${result.suiteRunId ?? ""}\nverdict=${result.verdict ?? ""}\nurl=${result.url ?? ""}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY && result.run) await append(env.GITHUB_STEP_SUMMARY, summaryMarkdown(result.run, client.webUrl));
  if (result.exitCode === 0) {
    log(result.message);
    return 0;
  }
  return fail(result.message);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.env);
}
