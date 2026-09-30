import type { StoredTestRunRequest } from "@platform/contracts";

type Found = NonNullable<StoredTestRunRequest["inlineInputs"]>;

/**
 * The prompt line naming the credentials taken from the requirement text (V1.3.1): names only, never values
 * (the email or username is in the text already; a password is written there as `[secret: <name>]`).
 */
export function inlineInputsLine(found: Found | undefined): string[] {
  if (!found || found.length === 0) return [];
  const names = (kind: Found[number]["kind"]) => [...new Set(found.filter((f) => f.kind === kind).map((f) => f.name))];
  const parts = [
    names("testData").length > 0 ? `test data ${names("testData").join(", ")}` : null,
    names("secret").length > 0 ? `secret ${names("secret").join(", ")}` : null,
  ].filter(Boolean);
  return [`Taken from the requirement text (use them; they were provided): ${parts.join("; ")}`];
}
