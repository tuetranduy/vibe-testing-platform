import { z } from "zod";
import { IsoDateTime } from "./common";
import { SecretNameSchema } from "./common";
import { MAX_SECRETS, SecretRecordSchema, SecretValueSchema, TestDataRecordSchema } from "./run";

/**
 * Reusable test data sets (V1.1 F3): named, tenant-wide maps of test data a new run can start from. Test data
 * is not secret (use a saved credential profile for passwords), so values are returned.
 */
const NameSchema = z.string().trim().min(1, "Enter a name").max(100);

export const TestDataSetInputSchema = z.object({ name: NameSchema, values: TestDataRecordSchema });
export type TestDataSetInput = z.infer<typeof TestDataSetInputSchema>;

export const TestDataSetSchema = z.object({
  id: z.string(),
  name: z.string(),
  values: TestDataRecordSchema,
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TestDataSet = z.infer<typeof TestDataSetSchema>;

export const TestDataSetListSchema = z.object({ items: z.array(TestDataSetSchema) });
export type TestDataSetList = z.infer<typeof TestDataSetListSchema>;

/**
 * Saved credential profiles (V1.1 F4): named sets of secrets, encrypted at rest, write-only. The API shows
 * their secret names, never a value; administrators manage them, everyone may use them for a new run.
 */
const DescriptionSchema = z.string().trim().max(300);

export const CreateCredentialProfileRequestSchema = z.object({
  name: NameSchema,
  description: DescriptionSchema.default(""),
  secrets: SecretRecordSchema.refine((o) => Object.keys(o).length > 0, "Add at least one secret"),
});
export type CreateCredentialProfileRequestInput = z.input<typeof CreateCredentialProfileRequestSchema>;

/** `PUT /v1/credential-profiles/:id`: a value replaces the secret, `null` removes it, an omitted name is kept. */
export const UpdateCredentialProfileRequestSchema = z.object({
  name: NameSchema.optional(),
  description: DescriptionSchema.optional(),
  secrets: z
    .record(SecretNameSchema, SecretValueSchema.nullable())
    .refine((o) => Object.keys(o).length <= MAX_SECRETS, `At most ${MAX_SECRETS} secrets`)
    .optional(),
});
export type UpdateCredentialProfileRequest = z.infer<typeof UpdateCredentialProfileRequestSchema>;

export const CredentialProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Names only: values are never returned. */
  secretNames: z.array(z.string()),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CredentialProfile = z.infer<typeof CredentialProfileSchema>;

export const CredentialProfileListSchema = z.object({ items: z.array(CredentialProfileSchema) });
