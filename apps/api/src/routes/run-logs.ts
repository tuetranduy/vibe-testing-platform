import { ClientLogBatchSchema, RunLogQuerySchema, type LlmCallView, type RunLlmCalls } from "@platform/contracts";
import { LlmCallRepository, LlmExchangeRepository, RunLogRepository, RunRepository, type NewRunLogLine } from "@platform/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireAdmin, runScope } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";

/** Frontend-error lines one person's browser may add to one run. */
export const CLIENT_LOG_BUDGET = 300;
const DAY_MS = 86_400_000;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Routes whose requests are not themselves logged (the live Logs view polls them every few seconds). */
const UNLOGGED_ROUTE = /\/(logs|llm-calls(\/.*)?|client-logs)$/;

/**
 * Admin run logs (2026-11-25): every source's lines about one run and its model calls with their prompts and
 * responses. Reading is admin-only; any signed-in person who can see the run may send its frontend errors.
 */
export async function runLogRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const runs = new RunRepository(deps.db);
  const logs = new RunLogRepository(deps.db);
  const calls = new LlmCallRepository(deps.db);
  const exchanges = new LlmExchangeRepository(deps.db);
  const retentionDays = deps.config.runLogRetentionDays ?? 14;
  const now = () => (deps.now ?? (() => new Date()))();

  // One line per action on, or failed request to, a run's routes (no bodies, no headers).
  app.addHook("onResponse", async (req, reply) => {
    const runId = (req.params as { runId?: unknown } | undefined)?.runId;
    const route = req.routeOptions.url;
    if (!deps.logger || typeof runId !== "string" || !route || UNLOGGED_ROUTE.test(route)) return;
    // A successful read is the page refreshing itself; actions and failures are the run's story.
    if (req.method === "GET" && reply.statusCode < 400) return;
    deps.logger.info(
      {
        runId,
        method: req.method,
        route,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        principal: req.principal?.kind ?? "anonymous",
      },
      `${req.method} ${route} → ${reply.statusCode}`,
    );
  });

  const adminRun = async (req: FastifyRequest<{ Params: { runId: string } }>) => {
    requireAdmin(req.principal);
    return runs.getRequired(runScope(req.principal), req.params.runId);
  };

  app.get<{ Params: { runId: string } }>("/v1/test-runs/:runId/logs", async (req) => {
    const run = await adminRun(req);
    return logs.list(run.tenantId, run.id, RunLogQuerySchema.parse(req.query));
  });

  app.get<{ Params: { runId: string } }>("/v1/test-runs/:runId/llm-calls", async (req): Promise<RunLlmCalls> => {
    const run = await adminRun(req);
    const rows = await calls.listByRun(run.id);
    const available = await exchanges.availability(run.id);
    const expiredBefore = now().getTime() - retentionDays * DAY_MS;
    const views: LlmCallView[] = rows.map((r) => ({
      id: r.id,
      time: r.createdAt.toISOString(),
      stage: r.stage,
      purpose: r.purpose,
      provider: r.provider,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      estimatedCostUsd: r.estimatedCostUsd,
      latencyMs: r.latencyMs,
      status: r.status,
      exchange: available.has(r.id) ? "available" : r.createdAt.getTime() < expiredBefore ? "expired" : "none",
    }));
    return {
      calls: views,
      totals: {
        calls: views.length,
        inputTokens: views.reduce((n, c) => n + c.inputTokens, 0),
        outputTokens: views.reduce((n, c) => n + c.outputTokens, 0),
        estimatedCostUsd: round6(views.reduce((n, c) => n + c.estimatedCostUsd, 0)),
      },
    };
  });

  app.get<{ Params: { runId: string; callId: string } }>("/v1/test-runs/:runId/llm-calls/:callId/exchange", async (req) => {
    const run = await adminRun(req);
    const call = (await calls.listByRun(run.id)).find((c) => c.id === req.params.callId);
    if (!call) throw new HttpError(404, "NOT_FOUND", "No such model call in this run");
    const exchange = await exchanges.get(run.tenantId, call.id);
    if (!exchange) throw new HttpError(410, "EXCHANGE_EXPIRED", `Prompts and responses are kept ${retentionDays} days`);
    return exchange;
  });

  app.post<{ Params: { runId: string } }>("/v1/test-runs/:runId/client-logs", async (req, reply) => {
    const p = req.principal;
    if (p.kind !== "user" || p.token) throw new HttpError(403, "FORBIDDEN", "Only a signed-in person's browser sends its errors");
    const run = await runs.getRequired(runScope(p), req.params.runId);
    const batch = ClientLogBatchSchema.parse(req.body);
    const room = CLIENT_LOG_BUDGET - (await logs.countWebAppLines(run.id, p.userId));
    if (room > 0) {
      const at = now();
      const lines: NewRunLogLine[] = batch.lines.slice(0, room).map((l) => ({
        runId: run.id,
        // The server's clock orders the timeline; the browser's is kept beside it.
        time: at,
        source: "web_app",
        level: l.level,
        stage: null,
        component: "web",
        message: l.message,
        fields: { userId: p.userId, kind: l.kind, url: l.url, clientTime: l.time, ...(l.stack ? { stack: l.stack } : {}) },
      }));
      await logs.appendMany(lines);
    }
    return reply.code(204).send();
  });
}
