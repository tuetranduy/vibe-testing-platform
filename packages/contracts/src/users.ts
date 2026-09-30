import { z } from "zod";
import { IsoDateTime } from "./common";

/**
 * Users and sessions (V1.1 F1, spec 2026-09-29-v1.1-design). An admin manages users and settings and sees
 * every run; a member sees and acts on their own runs only.
 */
export const UserRoleSchema = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+$/, "Enter an e-mail address");

/** 10–200 characters; never trimmed (spaces are part of a password). No message quotes it. */
export const PasswordSchema = z.string().min(10, "A password has at least 10 characters").max(200, "A password has at most 200 characters");

const NameSchema = z.string().trim().min(1, "Enter a name").max(100);

/** A user as the API shows it: never a password hash. */
export const UserViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: UserRoleSchema,
  disabled: z.boolean(),
  createdAt: IsoDateTime,
});
export type UserView = z.infer<typeof UserViewSchema>;

/** A tenant id, as a sign-in names it (KI-035). */
export const TenantIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/, "Enter an organization id");

/**
 * `POST /v1/auth/login`. The password is not length-checked here: a wrong one is just wrong. `tenant`: the
 * organization to sign in to (KI-035); absent, the default tenant. An unknown one is just a failed sign-in.
 */
export const LoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, "Enter your e-mail address").max(254),
  password: z.string().min(1, "Enter your password").max(200),
  tenant: TenantIdSchema.optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/** The API's answer to a login. The web proxy moves `token` into an httpOnly cookie and drops it. */
export const LoginResponseSchema = z.object({
  token: z.string(),
  expiresAt: IsoDateTime,
  user: UserViewSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/** What the browser receives for a login (the proxy's answer): the session stays in the cookie. */
export const SessionViewSchema = z.object({ expiresAt: IsoDateTime, user: UserViewSchema });
export type SessionView = z.infer<typeof SessionViewSchema>;

/** `PUT /v1/auth/password`. */
export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newPassword: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/** One of the signed-in user's live sessions (`GET /v1/auth/sessions`, KI-034). Never the token. */
export const SessionInfoSchema = z.object({
  id: z.string(),
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  expiresAt: IsoDateTime,
  userAgent: z.string().nullable(),
  /** The session this request came from. */
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const SessionListResponseSchema = z.object({ items: z.array(SessionInfoSchema) });

/** `POST /v1/auth/sessions/revoke-others`: how many sessions ended. */
export const RevokeSessionsResponseSchema = z.object({ revoked: z.number().int().nonnegative() });

/** `POST /v1/users` (admin). */
export const CreateUserRequestSchema = z.object({
  email: EmailSchema,
  name: NameSchema,
  password: PasswordSchema,
  role: UserRoleSchema.default("member"),
});
export type CreateUserRequestInput = z.input<typeof CreateUserRequestSchema>;
export type CreateUserRequest = z.output<typeof CreateUserRequestSchema>;

/** `PATCH /v1/users/:userId` (admin). A new password revokes the user's sessions; so does disabling them. */
export const UpdateUserRequestSchema = z
  .object({
    name: NameSchema.optional(),
    role: UserRoleSchema.optional(),
    disabled: z.boolean().optional(),
    password: PasswordSchema.optional(),
  })
  .refine((u) => Object.values(u).some((v) => v !== undefined), "Change at least one field");
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const UserListResponseSchema = z.object({ items: z.array(UserViewSchema) });
export type UserListResponse = z.infer<typeof UserListResponseSchema>;

/** A run's owner as summaries show it; null for runs created by the service token or before V1.1. */
export const RunOwnerSchema = z.object({ id: z.string(), name: z.string() });
export type RunOwner = z.infer<typeof RunOwnerSchema>;
