import { z } from "zod";
import { IsoDateTime } from "./common";
import { TestDataRecordSchema } from "./run";

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
