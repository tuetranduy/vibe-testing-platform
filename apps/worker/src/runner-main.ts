/**
 * The runner service (KI-029): `pnpm --filter @platform/worker runner` in the runner container. It runs reruns'
 * Playwright CLI for the workers (sandbox/runner-service.ts) and reads only its own settings — the container has
 * no database, Redis, storage or provider settings, and no route to them.
 *
 *   RUNNER_TOKEN          shared with the workers (at least 16 characters)
 *   RUNNER_WORKSPACE_DIR  the volume shared with the workers (default /work/runs)
 *   RUNNER_PORT           default 3100
 */
import { createLogger } from "@platform/config";
import { startRunnerServer } from "./sandbox/runner-service";

const log = createLogger({ component: "runner", level: (process.env.LOG_LEVEL as "info" | undefined) ?? "info" });
const token = process.env.RUNNER_TOKEN ?? "";
if (token.length < 16) {
  log.error({}, "RUNNER_TOKEN must be set (at least 16 characters)");
  process.exit(1);
}
const server = await startRunnerServer({
  host: "0.0.0.0",
  port: Number(process.env.RUNNER_PORT ?? 3100),
  token,
  workspaceDir: process.env.RUNNER_WORKSPACE_DIR ?? "/work/runs",
  logger: log,
});
log.info({ url: server.url }, "runner listening");
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => void server.close().then(() => process.exit(0)));
}
