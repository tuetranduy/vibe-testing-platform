import type { ArtifactSensitivity, ArtifactType } from "@platform/contracts";
import { and, asc, eq, lt } from "drizzle-orm";
import type { Executor } from "./client";
import { NotFoundError } from "./errors";
import { newId } from "./ids";
import { artifacts } from "./schema";

export type ArtifactRecord = typeof artifacts.$inferSelect;

export interface CreateArtifactInput {
  tenantId: string;
  runId: string;
  type: ArtifactType;
  objectKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
  sensitivity: ArtifactSensitivity;
  expiresAt: Date;
}

export class ArtifactRepository {
  constructor(private readonly db: Executor) {}

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const [row] = await this.db
      .insert(artifacts)
      .values({ id: newId("art"), ...input })
      .returning();
    return row!;
  }

  async getRequired(tenantId: string, runId: string, artifactId: string): Promise<ArtifactRecord> {
    const [row] = await this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.runId, runId), eq(artifacts.tenantId, tenantId)));
    if (!row) throw new NotFoundError("Artifact", artifactId);
    return row;
  }

  async listByRun(runId: string): Promise<ArtifactRecord[]> {
    return this.db.select().from(artifacts).where(eq(artifacts.runId, runId)).orderBy(asc(artifacts.createdAt));
  }

  async listExpired(now: Date, limit = 500): Promise<ArtifactRecord[]> {
    return this.db.select().from(artifacts).where(lt(artifacts.expiresAt, now)).limit(limit);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(artifacts).where(eq(artifacts.id, id));
  }
}
