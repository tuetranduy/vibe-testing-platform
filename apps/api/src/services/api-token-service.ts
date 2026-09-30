import {
  API_TOKEN_PREFIX,
  CreateApiTokenRequestSchema,
  MAX_LIVE_TOKENS_PER_USER,
  type ApiTokenView,
  type CreatedApiToken,
} from "@platform/contracts";
import { ApiTokenRepository, UserRepository, type ApiTokenRow } from "@platform/db";
import { apiTokenHash, newApiToken } from "@platform/security";
import { isAdmin, type Principal } from "../auth/principal";
import type { ApiDeps } from "../deps";
import { HttpError } from "../errors";
import { parseBody } from "./suite-service";

/** Token management needs a person signed in to the web app: never the service token, never an API token. */
function requireSession(p: Principal): Extract<Principal, { kind: "user" }> {
  if (p.kind !== "user" || p.token) throw new HttpError(400, "NO_SESSION", "Sign in to the web app to manage API tokens");
  return p;
}

/**
 * API tokens (V1.2 F4): each user creates and revokes their own; administrators see and revoke everyone's. The
 * token is returned once, at creation; the table keeps its SHA-256 and the first characters to recognise it.
 */
export class ApiTokenService {
  private readonly repo: ApiTokenRepository;

  constructor(private readonly deps: Pick<ApiDeps, "db">) {
    this.repo = new ApiTokenRepository(deps.db);
  }

  private async views(tenantId: string, rows: ApiTokenRow[]): Promise<ApiTokenView[]> {
    const names = await new UserRepository(this.deps.db).namesById(
      tenantId,
      rows.map((r) => r.userId),
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      user: { id: r.userId, name: names.get(r.userId) ?? "Former user" },
      expiresAt: r.expiresAt?.toISOString() ?? null,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** The caller's tokens; an administrator's `all` lists the tenant's. */
  async list(p: Principal, all: boolean): Promise<ApiTokenView[]> {
    const user = requireSession(p);
    if (all && !isAdmin(user)) throw new HttpError(403, "FORBIDDEN", "Only an administrator can see everyone's tokens");
    return this.views(user.tenantId, await this.repo.list(user.tenantId, all ? undefined : user.userId));
  }

  async create(p: Principal, body: unknown): Promise<CreatedApiToken> {
    const user = requireSession(p);
    const input = parseBody(CreateApiTokenRequestSchema, body);
    if ((await this.repo.countLive(user.userId)) >= MAX_LIVE_TOKENS_PER_USER) {
      throw new HttpError(409, "TOKEN_LIMIT", `At most ${MAX_LIVE_TOKENS_PER_USER} active tokens per person; revoke one first`);
    }
    const token = newApiToken();
    const row = await this.repo.create({
      tenantId: user.tenantId,
      userId: user.userId,
      name: input.name,
      tokenHash: apiTokenHash(token),
      prefix: token.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + 8),
      scopes: input.scopes,
      expiresAt: input.expiresInDays === null ? null : new Date(Date.now() + input.expiresInDays * 86_400_000),
    });
    const [view] = await this.views(user.tenantId, [row]);
    return { ...view!, token };
  }

  /** Own tokens; an administrator's, anyone's. Revoking twice is `404`. */
  async revoke(p: Principal, id: string): Promise<ApiTokenView> {
    const user = requireSession(p);
    const row = await this.repo.find(user.tenantId, id);
    if (!row || (row.userId !== user.userId && !isAdmin(user))) throw new HttpError(404, "NOT_FOUND", "Not found");
    const revoked = await this.repo.revoke(user.tenantId, id);
    if (!revoked) throw new HttpError(404, "NOT_FOUND", "Not found");
    return (await this.views(user.tenantId, [revoked]))[0]!;
  }
}
