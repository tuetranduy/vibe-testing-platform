import { RunRepository } from "@platform/db";
import { runAssistKey, runAssistAnswerKey, runAssistChannel, discoveryEnabled, setDiscoveryEnabled } from "@platform/event-bus";
import { runScope, actorId, requireAdmin, requireUser } from "../auth/principal";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";
import { audit } from "../services/audit";
import { RerunService } from "../services/rerun-service";
import { TestRunService } from "../services/test-run-service";

const RunParams = z.object({ runId: z.string().min(1).max(100) });
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
  /** Admins: `me` for their own runs (default: everyone's). Members always get their own. */
  owner: z.enum(["me", "all"]).optional(),
});

export function parseOr400<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(r.error));
  return r.data;
}

export async function testRunRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const service = new TestRunService(deps);

  app.get("/v1/discovery/capability", async (req, reply) => {
    const discovery = deps.config.discovery;
    const { tenantId } = req.principal;
    reply.header("Cache-Control", "no-store");
    const enabled = discovery?.tenantIds.includes(tenantId) && await discoveryEnabled(deps.discoveryRollout, tenantId);
    return {
      fixtureUrl: enabled ? discovery?.fixtureUrl ?? null : null,
      ...(deps.config.verifiedDiscoverySites && { verifiedSites: true }),
      ...(deps.config.verifiedDiscoverySites && deps.config.liveDiscoveryInteraction && { liveInteraction: true }),
    };
  });

  app.get("/v1/settings/discovery", async (req, reply) => {
    requireAdmin(req.principal);
    const { tenantId } = req.principal;
    const available = deps.config.discovery?.tenantIds.includes(tenantId) === true;
    reply.header("Cache-Control", "no-store");
    return { available, enabled: available && await discoveryEnabled(deps.discoveryRollout, tenantId) };
  });

  app.put("/v1/settings/discovery", async (req) => {
    requireAdmin(req.principal);
    const { tenantId } = req.principal;
    const available = deps.config.discovery?.tenantIds.includes(tenantId) === true;
    const { enabled } = parseOr400(z.strictObject({ enabled: z.boolean() }), req.body);
    if (enabled && !available) throw new HttpError(422, "DISCOVERY_UNAVAILABLE", "This tenant has no approved staging fixture");
    if (!deps.discoveryRollout) throw new HttpError(503, "DISCOVERY_UNAVAILABLE", "Could not save the discovery setting");
    try {
      await setDiscoveryEnabled(deps.discoveryRollout, tenantId, enabled);
    } catch {
      throw new HttpError(503, "DISCOVERY_UNAVAILABLE", "Could not save the discovery setting");
    }
    await audit(deps, req, { action: "settings.discovery.updated", detail: { enabled } });
    return { available, enabled };
  });

  // Claim + retain + notify atomically: two tabs cannot both answer, and pub/sub reconnects lose no answer (2026-11-21).
  app.post("/v1/test-runs/:runId/assistance/:requestId", async (req, reply) => {
    const { runId, requestId } = parseOr400(RunParams.extend({ requestId: z.string().min(1).max(100) }), req.params);
    const body = parseOr400(z.union([
      z.object({ instruction: z.string().trim().min(1).max(2000) }).strict(),
      z.object({ stop: z.literal(true) }).strict(),
    ]), req.body);
    const run = await new RunRepository(deps.db).getRequired(runScope(req.principal), runId);
    const redis = deps.assistanceRedis;
    const refuse = () => new HttpError(409, "ASSISTANCE_NOT_PENDING", "This question is no longer waiting for an answer");
    if (!redis || run.lifecycle !== "EXPLORING" || run.cancelRequestedAt) throw refuse();
    const answer = "instruction" in body ? { kind: "instruction", text: body.instruction, by: actorId(req.principal) ?? "service" } : { kind: "stop" };
    const accepted = await redis.eval(`
      local pending = redis.call('GET', KEYS[1])
      if not pending then return 0 end
      local request = cjson.decode(pending)
      if request.requestId ~= ARGV[1] then return 0 end
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl <= 0 then return 0 end
      redis.call('SET', KEYS[2], ARGV[2], 'PX', ttl + 60000)
      redis.call('DEL', KEYS[1])
      redis.call('PUBLISH', ARGV[3], ARGV[1])
      return 1
    `, 2, runAssistKey(runId), runAssistAnswerKey(runId, requestId), requestId, JSON.stringify(answer), runAssistChannel(runId));
    if (accepted !== 1) throw refuse();
    return reply.status(202).send({ accepted: true });
  });

  app.post("/v1/test-runs", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    const result = await service.create(req.principal, req.body, typeof key === "string" && key.length > 0 ? key : undefined);
    // Each use of saved credentials is audited (V1.1 F4): the run, the profile, never a value.
    const profileId = (req.body as { credentialProfileId?: unknown } | undefined)?.credentialProfileId;
    if (typeof profileId === "string") {
      await audit(deps, req, { action: "credential_profile.used", runId: result.body.runId, detail: { profileId } });
    }
    return reply.status(result.status).send(result.body);
  });

  app.get("/v1/test-runs", async (req) => {
    const q = parseOr400(ListQuery, req.query);
    return service.list(req.principal, q.limit, q.cursor ?? null, q.owner);
  });

  app.get("/v1/test-runs/:runId", async (req) => {
    const { runId } = parseOr400(RunParams, req.params);
    return service.get(req.principal, runId);
  });

  // A manual rerun of a finished run's saved Playwright test (V1.1 F5): a new run, no model call.
  const reruns = new RerunService(deps);
  app.post("/v1/test-runs/:runId/rerun", async (req, reply) => {
    const { runId } = parseOr400(RunParams, req.params);
    const key = req.headers["idempotency-key"];
    const result = await reruns.rerun(req.principal, runId, req.body, typeof key === "string" && key.length > 0 ? key : undefined);
    await audit(deps, req, { action: "run.rerun_requested", runId: result.body.runId, detail: { sourceRunId: runId } });
    if (result.credentialProfileId) {
      await audit(deps, req, { action: "credential_profile.used", runId: result.body.runId, detail: { profileId: result.credentialProfileId } });
    }
    return reply.status(result.status).send(result.body);
  });

  app.post("/v1/test-runs/:runId/cancel", async (req, reply) => {
    const { runId } = parseOr400(RunParams, req.params);
    return reply.status(202).send(await service.cancel(req.principal, runId));
  });
}
