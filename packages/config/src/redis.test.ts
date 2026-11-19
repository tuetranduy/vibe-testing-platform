import { describe, expect, it } from "vitest";
import { redisTlsOptions } from "./redis";

const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

describe("redisTlsOptions", () => {
  it("adds nothing without a CA", () => {
    expect(redisTlsOptions({})).toEqual({});
    expect(redisTlsOptions({ REDIS_TLS_CA: "  " })).toEqual({});
  });

  it("trusts a PEM, a PEM with escaped newlines, or a base64-encoded PEM", () => {
    expect(redisTlsOptions({ REDIS_TLS_CA: pem })).toEqual({ tls: { ca: pem.trim() } });
    expect(redisTlsOptions({ REDIS_TLS_CA: pem.replace(/\n/g, "\\n") })).toEqual({ tls: { ca: pem.trim() } });
    expect(redisTlsOptions({ REDIS_TLS_CA: Buffer.from(pem).toString("base64") })).toEqual({ tls: { ca: pem.trim() } });
  });

  it("refuses something that is not a certificate", () => {
    expect(() => redisTlsOptions({ REDIS_TLS_CA: "bm90IGEgY2VydA==" })).toThrow(/REDIS_TLS_CA/);
  });
});
