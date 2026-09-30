import { AuditRepository } from "@platform/db";
import type { FastifyRequest } from "fastify";
import { actorId } from "../auth/principal";
import type { ApiDeps } from "../deps";

export interface AuditInput {
  action: string;
  runId?: string | null;
  /** Never a secret, password, token or e-mail of a failed login (hash it). */
  detail?: Record<string, unknown>;
}

/**
 * Records an audited action three ways: the request's log line, the durable `audit_events` row
 * (closes KI-028), and `deps.audit` (tests, external sinks). A failed row write is logged, never
 * turned into a failed request: the action itself already happened.
 */
export async function audit(deps: Pick<ApiDeps, "db" | "audit">, req: FastifyRequest, input: AuditInput): Promise<void> {
  const p = req.principal;
  const entry = {
    action: input.action,
    tenantId: p.tenantId,
    userId: actorId(p),
    ...(input.runId ? { runId: input.runId } : {}),
    ...input.detail,
    at: new Date().toISOString(),
  };
  req.log.info(entry, "audit");
  deps.audit?.(entry);
  try {
    await new AuditRepository(deps.db).append({
      tenantId: p.tenantId,
      userId: actorId(p),
      action: input.action,
      runId: input.runId ?? null,
      detail: input.detail ?? {},
    });
  } catch (err) {
    req.log.error({ err, action: input.action }, "audit row could not be written");
  }
}
