import {
  CreateCredentialProfileRequestSchema,
  MAX_SECRETS,
  UpdateCredentialProfileRequestSchema,
  type CredentialProfile,
} from "@platform/contracts";
import { CredentialProfileRepository, NameTakenError, UserRepository, type CredentialProfileRow } from "@platform/db";
import { decryptProfileSecret, encryptProfileSecret } from "@platform/security";
import type { z } from "zod";
import { actorId, requireAdmin, type Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError, zodIssues } from "../errors";

const notFound = () => new HttpError(404, "NOT_FOUND", "Not found");
const nameTaken = (err: NameTakenError) => new HttpError(409, "NAME_TAKEN", err.message, [{ path: ["name"], message: err.message }]);

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", zodIssues(r.error));
  return r.data;
}

/**
 * Saved credential profiles (V1.1 F4). Values are encrypted here with the profile's AAD and never returned;
 * `secretsFor` decrypts them only for run creation, which re-encrypts them as the run's own secrets (D7
 * amended). Administrators manage profiles; every user may list and use them.
 */
export class CredentialProfileService {
  private readonly repo: CredentialProfileRepository;

  constructor(private readonly deps: Pick<ApiDeps, "db" | "config">) {
    this.repo = new CredentialProfileRepository(deps.db);
  }

  private async views(tenantId: string, rows: CredentialProfileRow[]): Promise<CredentialProfile[]> {
    const names = await new UserRepository(this.deps.db).namesById(
      tenantId,
      rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      secretNames: r.secretNames,
      createdBy: r.createdBy ? { id: r.createdBy, name: names.get(r.createdBy) ?? "Former user" } : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async list(p: Principal): Promise<CredentialProfile[]> {
    return this.views(p.tenantId, await this.repo.list(p.tenantId));
  }

  async create(p: Principal, body: unknown): Promise<CredentialProfile> {
    requireAdmin(p);
    const input = parse(CreateCredentialProfileRequestSchema, body);
    const key = this.deps.config.secretsKey;
    try {
      const row = await this.repo.create(
        { tenantId: p.tenantId, name: input.name, description: input.description, createdBy: actorId(p) },
        Object.entries(input.secrets).map(([name, value]) => ({
          name,
          encrypt: (profileId: string) => encryptProfileSecret(value, { tenantId: p.tenantId, profileId, name }, key),
        })),
      );
      return (await this.views(p.tenantId, [row]))[0]!;
    } catch (err) {
      if (err instanceof NameTakenError) throw nameTaken(err);
      throw err;
    }
  }

  async update(p: Principal, id: string, body: unknown): Promise<CredentialProfile> {
    requireAdmin(p);
    const input = parse(UpdateCredentialProfileRequestSchema, body);
    const current = await this.repo.find(p.tenantId, id);
    if (!current) throw notFound();
    const entries = Object.entries(input.secrets ?? {});
    const remove = entries.filter(([, v]) => v === null).map(([name]) => name);
    const set = entries.flatMap(([name, v]) =>
      v === null
        ? []
        : [{ name, value: encryptProfileSecret(v, { tenantId: p.tenantId, profileId: id, name }, this.deps.config.secretsKey) }],
    );
    const after = new Set([...current.secretNames.filter((n) => !remove.includes(n)), ...set.map((s) => s.name)]);
    if (after.size === 0)
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [
        { path: ["secrets"], message: "Keep at least one secret" },
      ]);
    if (after.size > MAX_SECRETS) {
      throw new HttpError(400, "VALIDATION_FAILED", "Request validation failed", [
        { path: ["secrets"], message: `At most ${MAX_SECRETS} secrets` },
      ]);
    }
    try {
      const row = await this.repo.update(
        p.tenantId,
        id,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
        { set, remove },
      );
      if (!row) throw notFound();
      return (await this.views(p.tenantId, [row]))[0]!;
    } catch (err) {
      if (err instanceof NameTakenError) throw nameTaken(err);
      throw err;
    }
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireAdmin(p);
    if (!(await this.repo.remove(p.tenantId, id))) throw notFound();
  }

  /**
   * Run creation only: the profile's values in plaintext, and its name. 422 when it does not exist, or when a
   * value cannot be opened (e.g. SECRETS_ENCRYPTION_KEY was rotated: its values must be saved again).
   */
  async secretsFor(tenantId: string, id: string): Promise<{ ref: { id: string; name: string }; secrets: Record<string, string> }> {
    const found = await this.repo.getEncrypted(tenantId, id);
    if (!found) {
      throw new HttpError(422, "CREDENTIAL_PROFILE_NOT_FOUND", "The saved credentials do not exist (they may have been deleted)", [
        { path: ["credentialProfileId"], message: "These saved credentials no longer exist" },
      ]);
    }
    const secrets: Record<string, string> = {};
    try {
      for (const s of found.secrets)
        secrets[s.name] = decryptProfileSecret(s, { tenantId, profileId: id, name: s.name }, this.deps.config.secretsKey);
    } catch {
      throw new HttpError(
        422,
        "CREDENTIAL_PROFILE_UNREADABLE",
        "The saved credentials can't be read; an administrator must save their values again",
        [
          {
            path: ["credentialProfileId"],
            message: "These saved credentials can't be read; save their values again in Settings → Credentials",
          },
        ],
      );
    }
    return { ref: { id: found.profile.id, name: found.profile.name }, secrets };
  }
}
