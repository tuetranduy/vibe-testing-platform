import {
  COVERAGE_MAX_RUNS,
  DiscoveryFixturePathSchema,
  findingStatus,
  type CoverageResponse,
} from "@platform/contracts";
import {
  ExplorationStepRepository,
  FindingRepository,
  RunRepository,
  SiteAnalysisRepository,
  SuggestionRepository,
  type RunScope,
} from "@platform/db";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";

const pathOf = (url: string, origin: string): string | null => {
  try {
    const u = new URL(url);
    if (u.origin !== origin) return null;
    return DiscoveryFixturePathSchema.safeParse(u.pathname).success ? u.pathname : null;
  } catch {
    return null;
  }
};

/**
 * Phase C: a site's coverage graph across the caller's recent runs, built on read from what each run already
 * stores (its Browser Use suggestions, routes and findings, and its recorded golden path). Nothing new is persisted.
 */
export class CoverageService {
  constructor(private readonly deps: ApiDeps) {}

  async coverage(scope: RunScope, url: string): Promise<CoverageResponse> {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [{ path: ["url"], message: "Enter a page URL" }]);
    }
    if (origin === "null") throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [{ path: ["url"], message: "Enter an http(s) page URL" }]);
    const db = this.deps.db;
    const runs = await new RunRepository(db).listByOrigin(scope, origin, COVERAGE_MAX_RUNS);
    const pages = new Map<string, { discovered: Set<string>; tested: Set<string>; findings: number; reproduced: number }>();
    const page = (path: string) => {
      let entry = pages.get(path);
      if (!entry) pages.set(path, entry = { discovered: new Set(), tested: new Set(), findings: 0, reproduced: 0 });
      return entry;
    };
    const edges = new Map<string, number>();
    const journey = (paths: readonly string[], runId: string) => {
      paths.forEach((path, i) => {
        page(path).discovered.add(runId);
        const next = paths[i + 1];
        if (next && next !== path) edges.set(`${path}\n${next}`, (edges.get(`${path}\n${next}`) ?? 0) + 1);
      });
    };
    const steps = new ExplorationStepRepository(db);
    const findings = new FindingRepository(db);
    const reproductions = new Map<string, Awaited<ReturnType<RunRepository["getRequired"]>> | null>();
    for (const run of runs) {
      const [set, analysis, recorded, found] = await Promise.all([
        new SuggestionRepository(db).get(run.id),
        new SiteAnalysisRepository(db).get(run.id),
        steps.listByRun(run.id),
        findings.list(run.id),
      ]);
      for (const suggestion of set?.suggestions ?? []) if (suggestion.discovery) journey(suggestion.discovery.relevantPaths, run.id);
      for (const route of analysis?.discovery?.routes ?? []) journey(route.relevantPaths, run.id);
      for (const finding of found) {
        const entry = page(finding.path);
        entry.discovered.add(run.id);
        entry.findings++;
        if (finding.reproductionRunId && !reproductions.has(finding.reproductionRunId)) {
          reproductions.set(finding.reproductionRunId,
            await new RunRepository(db).getRequired({ tenantId: scope.tenantId }, finding.reproductionRunId).catch(() => null));
        }
        const reproduction = finding.reproductionRunId ? reproductions.get(finding.reproductionRunId) ?? null : null;
        if (findingStatus(finding, reproduction).status === "REPRODUCED") entry.reproduced++;
      }
      for (const step of recorded) {
        if (!step.onGoldenPath || step.outcome !== "SUCCESS") continue;
        const path = pathOf(step.urlAfter, origin);
        if (path) page(path).tested.add(run.id);
      }
    }
    const list = [...pages].map(([path, e]) => ({ path, discovered: e.discovered.size, tested: e.tested.size, findings: e.findings, reproduced: e.reproduced }))
      .sort((a, b) => b.discovered + b.tested - (a.discovered + a.tested) || a.path.localeCompare(b.path))
      .slice(0, 300);
    return {
      origin,
      runs: runs.length,
      pages: list,
      edges: [...edges].map(([key, count]) => {
        const [from, to] = key.split("\n") as [string, string];
        return { from, to, count };
      }).sort((a, b) => b.count - a.count).slice(0, 500),
      gaps: list.filter((p) => p.discovered > 0 && p.tested === 0).map((p) => p.path),
    };
  }
}
