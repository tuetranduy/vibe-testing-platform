import { FakeTransport, LlmClient } from "@platform/llm";
import type { Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { guardrailSystemPrompt } from "./guardrails";
import { StagehandExplorer } from "./stagehand-explorer";

// Stagehand itself is replaced: `create` records its options and stops the start there.
const created = vi.hoisted(() => [] as { systemPrompt?: string }[]);
vi.mock("@browserbasehq/stagehand", () => ({
  localBrowser: { connect: async () => ({}) },
  Stagehand: {
    create: async (options: { systemPrompt?: string }) => {
      created.push(options);
      throw new Error("stop after create");
    },
  },
}));

describe("StagehandExplorer.start guardrail", () => {
  const llm = new LlmClient({ transport: new FakeTransport(), model: "claude-sonnet-5", logger: { warn() {} } });
  beforeEach(() => void created.splice(0));

  it.each([false, true])("gives Stagehand the guardrail for allowDestructive=%s", async (allowDestructive) => {
    const explorer = new StagehandExplorer({ extensionId: "a".repeat(32) });
    await expect(
      explorer.start({
        page: { cdpUrl: "http://127.0.0.1:1", extensionIds: ["a".repeat(32)], page: {} as Page },
        runId: "r",
        llm,
        signal: new AbortController().signal,
        redact: (v) => v,
        allowDestructive,
      }),
    ).rejects.toThrow(/stop after create/);
    expect(created.map((o) => o.systemPrompt)).toEqual([guardrailSystemPrompt({ allowDestructive })]);
  });
});
