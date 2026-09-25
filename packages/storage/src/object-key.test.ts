import { describe, expect, it } from "vitest";
import type { ArtifactType } from "@platform/contracts";
import { InvalidArtifactKeyError } from "./storage";
import { assertValidObjectKey, buildObjectKey, sanitizeFileName, TYPE_DIRS } from "./object-key";

describe("buildObjectKey", () => {
  it("builds tenants/<t>/runs/<r>/<typeDir>/<base>-<random>.<ext>", () => {
    const key = buildObjectKey({ tenantId: "t_1", runId: "r_1", type: "SCREENSHOT", fileName: "before-add.png" });
    expect(key.startsWith("tenants/t_1/runs/r_1/screenshots/")).toBe(true);
    expect(key).toMatch(/^tenants\/t_1\/runs\/r_1\/screenshots\/before-add-[0-9a-f]{16}\.png$/);
  });

  it("does not collide on repeated names", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 500; i++) {
      keys.add(buildObjectKey({ tenantId: "t_1", runId: "r_1", type: "SCREENSHOT", fileName: "before-add.png" }));
    }
    expect(keys.size).toBe(500);
  });

  it.each<[ArtifactType, string]>([
    ["SCREENSHOT", "screenshots"],
    ["TRACE", "traces"],
    ["VIDEO", "videos"],
    ["GENERATED_TEST", "generated-tests"],
    ["PLAYWRIGHT_REPORT", "playwright-reports"],
  ])("maps %s to %s", (type, dir) => {
    expect(TYPE_DIRS[type]).toBe(dir);
    expect(buildObjectKey({ tenantId: "t", runId: "r", type, fileName: "x.bin" })).toMatch(
      new RegExp(`^tenants/t/runs/r/${dir}/x-[0-9a-f]{16}\\.bin$`),
    );
  });

  it.each([
    ["../../etc/passwd", /^passwd-[0-9a-f]{16}$/],
    ["../secret.png", /^secret-[0-9a-f]{16}\.png$/],
    ["a/b/c.zip", /^c-[0-9a-f]{16}\.zip$/],
    ["..\\..\\win.ini", /^win-[0-9a-f]{16}\.ini$/],
    ["nul\u0000byte.png", /^nul-byte-[0-9a-f]{16}\.png$/],
    ["weird name (1)*?.PNG", /^weird-name-1-[0-9a-f]{16}\.png$/],
    ["..", /^artifact-[0-9a-f]{16}$/],
    ["", /^artifact-[0-9a-f]{16}$/],
    [".hidden", /^hidden-[0-9a-f]{16}$/],
    ["trace.zip/", /^trace-[0-9a-f]{16}\.zip$/],
    ["spec.spec.ts", /^spec-spec-[0-9a-f]{16}\.ts$/],
    ["ünïcødé.png", /^n-c-d-[0-9a-f]{16}\.png$/],
  ])("sanitizes fileName %j", (fileName, expected) => {
    const key = buildObjectKey({ tenantId: "t_1", runId: "r_1", type: "TRACE", fileName });
    const prefix = "tenants/t_1/runs/r_1/traces/";
    expect(key.startsWith(prefix)).toBe(true);
    const last = key.slice(prefix.length);
    expect(last).not.toContain("/");
    expect(last).not.toContain("\\");
    expect(last).not.toContain("..");
    expect(last).toMatch(expected);
    expect(() => assertValidObjectKey(key)).not.toThrow();
  });

  it("caps very long file names", () => {
    const key = buildObjectKey({ tenantId: "t", runId: "r", type: "VIDEO", fileName: `${"a".repeat(1000)}.webm` });
    expect(key.length).toBeLessThan(200);
    expect(key.endsWith(".webm")).toBe(true);
  });

  it("drops overly long or non-alphanumeric extensions", () => {
    expect(sanitizeFileName("x.averyveryverylongext")).toEqual({ base: "x-averyveryverylongext", ext: "" });
    expect(sanitizeFileName("x.p$g")).toEqual({ base: "x-p-g", ext: "" });
  });

  it.each(["", "../t", "t/1", "t 1", "t.1", "t\u0000", "a".repeat(129)])("rejects invalid tenantId %j", (tenantId) => {
    expect(() => buildObjectKey({ tenantId, runId: "r_1", type: "SCREENSHOT", fileName: "a.png" })).toThrow(
      InvalidArtifactKeyError,
    );
  });

  it.each(["", "..", "r/1", "r\\1", "r%2F1"])("rejects invalid runId %j", (runId) => {
    expect(() => buildObjectKey({ tenantId: "t_1", runId, type: "SCREENSHOT", fileName: "a.png" })).toThrow(
      InvalidArtifactKeyError,
    );
  });

  it("rejects unknown artifact types", () => {
    expect(() =>
      buildObjectKey({ tenantId: "t", runId: "r", type: "BOGUS" as ArtifactType, fileName: "a.png" }),
    ).toThrow(InvalidArtifactKeyError);
  });
});

describe("assertValidObjectKey", () => {
  it.each([
    "tenants/t_1/runs/r_1/screenshots/../../../../etc/passwd",
    "tenants/t_1/runs/r_1/screenshots/a/b.png",
    "/tenants/t_1/runs/r_1/screenshots/a.png",
    "tenants/t_1/runs/r_1/unknown/a.png",
    "tenants/../runs/r_1/screenshots/a.png",
    "tenants/t_1/runs/r_1/screenshots/",
    "tenants/t_1/runs/r_1/screenshots/a.png\u0000",
    "../outside",
    "",
  ])("rejects %j", (key) => {
    expect(() => assertValidObjectKey(key)).toThrow(InvalidArtifactKeyError);
  });

  it("accepts keys produced by buildObjectKey", () => {
    expect(() =>
      assertValidObjectKey(buildObjectKey({ tenantId: "t", runId: "r", type: "PLAYWRIGHT_REPORT", fileName: "r.zip" })),
    ).not.toThrow();
  });
});
