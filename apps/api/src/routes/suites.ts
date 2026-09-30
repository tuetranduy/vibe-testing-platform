import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { audit } from "../services/audit";
import { ScheduleService } from "../services/schedule-service";
import { SuiteRunService } from "../services/suite-run-service";
import { SuiteService } from "../services/suite-service";
import { parseOr400 } from "./test-runs";

const Id = z.string().min(1).max(100);
const SuiteParams = z.object({ suiteId: Id });
const EntryParams = z.object({ suiteId: Id, sourceRunId: Id });
const SuiteRunParams = z.object({ suiteRunId: Id });
const ScheduleParams = z.object({ scheduleId: Id });
const ListQuery = z.object({ name: z.string().max(100).optional() });
const RunsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

/** Suites and suite runs (V1.2 F1). Members see their own; administrators and the service, the tenant's. */
export async function suiteRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const suites = new SuiteService(deps);
  const suiteRuns = new SuiteRunService(deps);

  app.get("/v1/suites", async (req) => ({ items: await suites.list(req.principal, parseOr400(ListQuery, req.query).name) }));

  app.post("/v1/suites", async (req, reply) => reply.status(201).send(await suites.create(req.principal, req.body)));

  app.get("/v1/suites/:suiteId", async (req) => suites.detail(req.principal, parseOr400(SuiteParams, req.params).suiteId));

  app.put("/v1/suites/:suiteId", async (req) => suites.update(req.principal, parseOr400(SuiteParams, req.params).suiteId, req.body));

  app.delete("/v1/suites/:suiteId", async (req, reply) => {
    await suites.remove(req.principal, parseOr400(SuiteParams, req.params).suiteId);
    return reply.status(204).send();
  });

  app.post("/v1/suites/:suiteId/entries", async (req, reply) =>
    reply.status(201).send(await suites.addEntry(req.principal, parseOr400(SuiteParams, req.params).suiteId, req.body)),
  );

  app.put("/v1/suites/:suiteId/entries/order", async (req) =>
    suites.reorder(req.principal, parseOr400(SuiteParams, req.params).suiteId, req.body),
  );

  app.delete("/v1/suites/:suiteId/entries/:sourceRunId", async (req, reply) => {
    const { suiteId, sourceRunId } = parseOr400(EntryParams, req.params);
    await suites.removeEntry(req.principal, suiteId, sourceRunId);
    return reply.status(204).send();
  });

  app.post("/v1/suites/:suiteId/runs", async (req, reply) => {
    const { suiteId } = parseOr400(SuiteParams, req.params);
    const key = req.headers["idempotency-key"];
    const result = await suiteRuns.start(req.principal, suiteId, req.body, typeof key === "string" && key.length > 0 ? key : undefined);
    await audit(deps, req, { action: "suite.run_requested", detail: { suiteId, suiteRunId: result.body.suiteRunId } });
    for (const profileId of result.credentialProfileIds) {
      await audit(deps, req, { action: "credential_profile.used", detail: { profileId, suiteRunId: result.body.suiteRunId } });
    }
    return reply.status(result.status).send(result.body);
  });

  app.get("/v1/suites/:suiteId/runs", async (req) =>
    suiteRuns.listForSuite(req.principal, parseOr400(SuiteParams, req.params).suiteId, parseOr400(RunsQuery, req.query).limit),
  );

  // Schedules (V1.2 F3): as visible and manageable as their suite.
  const schedules = new ScheduleService(deps);
  app.get("/v1/suites/:suiteId/schedules", async (req) => ({
    items: await schedules.list(req.principal, parseOr400(SuiteParams, req.params).suiteId),
  }));

  app.post("/v1/suites/:suiteId/schedules", async (req, reply) => {
    const { suiteId } = parseOr400(SuiteParams, req.params);
    const created = await schedules.create(req.principal, suiteId, req.body);
    await audit(deps, req, { action: "schedule.created", detail: { scheduleId: created.id, suiteId, cron: created.cron, timezone: created.timezone } });
    return reply.status(201).send(created);
  });

  app.put("/v1/suite-schedules/:scheduleId", async (req) => {
    const { scheduleId } = parseOr400(ScheduleParams, req.params);
    const updated = await schedules.update(req.principal, scheduleId, req.body);
    await audit(deps, req, { action: "schedule.changed", detail: { scheduleId, cron: updated.cron, timezone: updated.timezone, enabled: updated.enabled } });
    return updated;
  });

  app.delete("/v1/suite-schedules/:scheduleId", async (req, reply) => {
    const { scheduleId } = parseOr400(ScheduleParams, req.params);
    await schedules.remove(req.principal, scheduleId);
    await audit(deps, req, { action: "schedule.deleted", detail: { scheduleId } });
    return reply.status(204).send();
  });

  app.get("/v1/suite-runs/:suiteRunId", async (req) => suiteRuns.get(req.principal, parseOr400(SuiteRunParams, req.params).suiteRunId));

  app.post("/v1/suite-runs/:suiteRunId/cancel", async (req, reply) =>
    reply.status(202).send(await suiteRuns.cancel(req.principal, parseOr400(SuiteRunParams, req.params).suiteRunId)),
  );
}
