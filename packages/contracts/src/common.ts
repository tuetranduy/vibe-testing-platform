import { z } from "zod";

export const HttpUrlSchema = z.url().refine((u) => {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
}, "Only http(s) URLs without embedded credentials are allowed");

export const HostnameSchema = z.string().regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)*[a-z0-9-]{1,63}$/i);
export const IsoDateTime = z.iso.datetime();
export const CriterionIdSchema = z.string().regex(/^AC-\d{1,3}$/);
export const FactKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/);
export const CheckpointSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const SecretNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export const DataKeySchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);

export const FactRefSchema = z.object({ key: FactKeySchema, checkpoint: CheckpointSchema });
export type FactRef = z.infer<typeof FactRefSchema>;
export type CriterionId = z.infer<typeof CriterionIdSchema>;

/** Reserved fact captured automatically at every checkpoint. */
export const URL_FACT_KEY = "url";
