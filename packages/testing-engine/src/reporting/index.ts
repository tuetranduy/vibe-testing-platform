/**
 * `@platform/testing-engine/reporting` (Ruling R36): the pure report assembler and reconciliation,
 * importable by the API without loading Stagehand, a browser or an LLM client. Keep this entry point's
 * import graph to @platform/contracts, zod and pure modules (guarded by report-builder.test.ts).
 */
export * from "../reconciliation/reconcile";
export * from "./report-builder";
export * from "./rerun-only";
export * from "./markdown";
export * from "./comparison";
