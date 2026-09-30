import { z } from "zod";
import { IsoDateTime } from "./common";
import { RunOwnerSchema } from "./users";

/**
 * API tokens (V1.2 F4): user-owned credentials for callers outside the browser (CI, scripts). A token acts as its
 * user, limited to its scopes; it is shown once and only its hash is stored.
 */
export const ApiTokenScopeSchema = z.enum(["suites:run", "results:read"]);
export type ApiTokenScope = z.infer<typeof ApiTokenScopeSchema>;

export const API_TOKEN_PREFIX = "tap_";
export const MAX_LIVE_TOKENS_PER_USER = 20;
export const TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;

export const CreateApiTokenRequestSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(100),
  scopes: z
    .array(ApiTokenScopeSchema)
    .min(1, "Choose at least one permission")
    .refine((s) => new Set(s).size === s.length, "Each permission once"),
  /** Null: never expires. */
  expiresInDays: z
    .union([z.literal(30), z.literal(90), z.literal(365), z.null()])
    .default(90),
});
export type CreateApiTokenRequest = z.input<typeof CreateApiTokenRequestSchema>;

export const ApiTokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The first characters after `tap_`, to recognise it. */
  prefix: z.string(),
  scopes: z.array(ApiTokenScopeSchema),
  user: RunOwnerSchema,
  expiresAt: IsoDateTime.nullable(),
  lastUsedAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type ApiTokenView = z.infer<typeof ApiTokenViewSchema>;

/** The answer to a create: the token itself, once. */
export const CreatedApiTokenSchema = ApiTokenViewSchema.extend({ token: z.string() });
export type CreatedApiToken = z.infer<typeof CreatedApiTokenSchema>;

export const ApiTokenListSchema = z.object({ items: z.array(ApiTokenViewSchema) });
