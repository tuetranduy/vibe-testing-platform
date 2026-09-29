import { TestDataSetInputSchema, type TestDataSet } from "@platform/contracts";
import { NameTakenError, TestDataSetRepository, UserRepository, type TestDataSetRow } from "@platform/db";
import { actorId, type Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";

const notFound = () => new HttpError(404, "NOT_FOUND", "Not found");
const nameTaken = (err: NameTakenError) => new HttpError(409, "NAME_TAKEN", err.message, [{ path: ["name"], message: err.message }]);

function parseInput(body: unknown) {
  const r = TestDataSetInputSchema.safeParse(body);
  if (!r.success) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(r.error));
  return r.data;
}

/**
 * Saved test data sets (V1.1 F3): tenant-wide, managed by any signed-in user. A run takes a copy of a set's
 * values when it is created (TestRunService), so later edits never change it.
 */
export class TestDataSetService {
  private readonly repo: TestDataSetRepository;

  constructor(private readonly deps: Pick<ApiDeps, "db">) {
    this.repo = new TestDataSetRepository(deps.db);
  }

  private async views(tenantId: string, rows: TestDataSetRow[]): Promise<TestDataSet[]> {
    const names = await new UserRepository(this.deps.db).namesById(
      tenantId,
      rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      values: r.values,
      createdBy: r.createdBy ? { id: r.createdBy, name: names.get(r.createdBy) ?? "Former user" } : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async list(p: Principal): Promise<TestDataSet[]> {
    return this.views(p.tenantId, await this.repo.list(p.tenantId));
  }

  async get(p: Principal, id: string): Promise<TestDataSet> {
    const row = await this.repo.find(p.tenantId, id);
    if (!row) throw notFound();
    return (await this.views(p.tenantId, [row]))[0]!;
  }

  async create(p: Principal, body: unknown): Promise<TestDataSet> {
    const input = parseInput(body);
    try {
      const row = await this.repo.create({ tenantId: p.tenantId, name: input.name, values: input.values, createdBy: actorId(p) });
      return (await this.views(p.tenantId, [row]))[0]!;
    } catch (err) {
      if (err instanceof NameTakenError) throw nameTaken(err);
      throw err;
    }
  }

  async update(p: Principal, id: string, body: unknown): Promise<TestDataSet> {
    const input = parseInput(body);
    try {
      const row = await this.repo.update(p.tenantId, id, input);
      if (!row) throw notFound();
      return (await this.views(p.tenantId, [row]))[0]!;
    } catch (err) {
      if (err instanceof NameTakenError) throw nameTaken(err);
      throw err;
    }
  }

  async remove(p: Principal, id: string): Promise<void> {
    if (!(await this.repo.remove(p.tenantId, id))) throw notFound();
  }
}
