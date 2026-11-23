import { randomBytes } from "node:crypto";

/** Prefixed, URL-safe, sortable-enough random id (e.g. run_3kq9x...). */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  return `${prefix}_${time}${randomBytes(8).toString("hex")}`;
}
