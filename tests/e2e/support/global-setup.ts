import type { TestProject } from "vitest/node";
import { startStack, type E2EStack } from "./stack";

declare module "vitest" {
  export interface ProvidedContext {
    e2e: E2EStack;
  }
}

/** One platform stack for the whole E2E run (specs run one file at a time). */
export default async function setup(project: TestProject) {
  const { stack, stop } = await startStack();
  project.provide("e2e", stack);
  return stop;
}
