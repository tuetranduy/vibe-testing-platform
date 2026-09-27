/** The `retry-after` header (seconds or an HTTP date) in ms; undefined when absent or unparseable. */
export function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
