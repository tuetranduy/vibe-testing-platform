/**
 * ioredis options that go with REDIS_URL. A self-hosted Redis (docs/operations.md) uses a self-signed
 * certificate, so the CA in REDIS_TLS_CA is the only one trusted; the hostname or IP in the URL is still checked.
 */
export function redisTlsOptions(env: { REDIS_TLS_CA?: string | undefined }): { tls?: { ca: string } } {
  const raw = env.REDIS_TLS_CA?.trim();
  if (!raw) return {};
  const ca = (raw.includes("-----BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8")).trim();
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("REDIS_TLS_CA is not a PEM certificate (or one base64-encoded)");
  return { tls: { ca } };
}
