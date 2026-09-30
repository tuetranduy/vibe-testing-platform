import { UsageQuerySchema, type UsageReport } from "@platform/contracts";
import { RunRepository, UsageRepository, UserRepository } from "@platform/db";
import { catalogModel } from "@platform/llm/catalog";
import { listScope, type Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const startOf = (day: string) => new Date(`${day}T00:00:00.000Z`);

/**
 * The cost dashboard (V1.1 F7): model spend from the runs' recorded model calls, over whole UTC days.
 * Members see their own runs; administrators everyone's, or their own with `owner=me`.
 */
export class UsageService {
  constructor(
    private readonly deps: Pick<ApiDeps, "db">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async report(principal: Principal, query: unknown): Promise<UsageReport> {
    const parsed = UsageQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(parsed.error));
    const q = parsed.data;
    const to = q.to ?? dayOf(this.now());
    const from = q.from ?? dayOf(new Date(startOf(to).getTime() - (DEFAULT_DAYS - 1) * DAY_MS));
    if (from > to)
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [
        { path: ["from"], message: "from must not be after to" },
      ]);
    const days = Math.round((startOf(to).getTime() - startOf(from).getTime()) / DAY_MS) + 1;
    if (days > MAX_DAYS) {
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [
        { path: ["from"], message: `At most ${MAX_DAYS} days at a time` },
      ]);
    }

    const scope = listScope(principal, q.owner);
    const rows = await new UsageRepository(this.deps.db).summarize(scope, startOf(from), new Date(startOf(to).getTime() + DAY_MS));

    const perDay = new Map(rows.byDay.map((d) => [d.day, d]));
    const byDay = Array.from({ length: days }, (_, i) => {
      const day = dayOf(new Date(startOf(from).getTime() + i * DAY_MS));
      return perDay.get(day) ?? { day, llmCalls: 0, estimatedCostUsd: 0 };
    });

    const runs = new RunRepository(this.deps.db);
    const top = await Promise.all(rows.topRuns.map(async (r) => ({ ...r, run: await runs.getById(r.runId) })));
    const names = await new UserRepository(this.deps.db).namesById(
      principal.tenantId,
      top.flatMap((t) => (t.run.ownerUserId ? [t.run.ownerUserId] : [])),
    );

    return {
      from,
      to,
      scope: scope.ownerUserId ? "mine" : "all",
      totals: { ...rows.totals, estimatedCostUsd: round(rows.totals.estimatedCostUsd) },
      byDay: byDay.map((d) => ({ ...d, estimatedCostUsd: round(d.estimatedCostUsd) })),
      byModel: rows.byModel.map((m) => ({
        ...m,
        label: catalogModel(m.model)?.label ?? m.model,
        estimatedCostUsd: round(m.estimatedCostUsd),
      })),
      byStage: rows.byStage.map((s) => ({ ...s, estimatedCostUsd: round(s.estimatedCostUsd) })),
      topRuns: top.map(({ run, llmCalls, estimatedCostUsd }) => ({
        runId: run.id,
        targetUrl: run.targetUrl,
        requirementPreview: run.request.requirement.slice(0, 200),
        createdAt: run.createdAt.toISOString(),
        owner: run.ownerUserId ? { id: run.ownerUserId, name: names.get(run.ownerUserId) ?? "Former user" } : null,
        llmCalls,
        estimatedCostUsd: round(estimatedCostUsd),
      })),
    };
  }
}

/** Micro-dollar precision, like the report's usage totals. */
const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
