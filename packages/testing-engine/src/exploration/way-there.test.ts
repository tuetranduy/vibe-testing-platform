import { FakeTransport, LlmClient, type FakeReply } from "@platform/llm";
import { createRunRedactor } from "@platform/security";
import { describe, expect, it } from "vitest";
import type { StageContext } from "../orchestrator/stages";
import type { Candidate } from "../survey/interactive";
import { createWayThere, wayThereCandidates, type WayThereRequest } from "./way-there";

const candidate = (label: string, over: Partial<Candidate> = {}): Candidate => ({
  selector: `xpath=/html[1]/body[1]/a[${label.length}]`,
  label,
  kind: "click",
  type: "",
  href: "",
  submit: false,
  form: "",
  ...over,
});

const ctx = { request: { targetUrl: "https://shop.test/", options: { additionalAllowedHosts: [] } } } as unknown as Pick<StageContext, "request">;

const request = (over: Partial<WayThereRequest> = {}): WayThereRequest => ({
  goal: "Click the 'Grills' link in the category navigation",
  url: "https://shop.test/",
  candidates: [
    { index: 0, label: "Show side menu" },
    { index: 1, label: "Cart" },
  ],
  runId: "run_1",
  signal: new AbortController().signal,
  redact: createRunRedactor(),
  ...over,
});

function setup(...replies: FakeReply[]) {
  const transport = new FakeTransport().enqueue(...replies);
  const llm = new LlmClient({ transport, model: "claude-sonnet-5", sleep: async () => {} });
  return { transport, llm };
}

describe("wayThereCandidates", () => {
  it("keeps the controls a click may open: no fields, nothing destructive, no sign-out, no submit but search or sign-in", () => {
    const kept = wayThereCandidates(
      [
        candidate("Show side menu"),
        candidate("Email", { kind: "fill", type: "email" }),
        candidate("Delete account"),
        candidate("Log out"),
        candidate("Place order", { submit: true, type: "submit" }),
        candidate("Grills", { href: "https://shop.test/Summer-BBQ/Grills/" }),
        candidate("Partner", { href: "https://elsewhere.test/" }),
      ],
      ctx,
    );
    expect(kept.map((c) => c.label)).toEqual(["Show side menu", "Grills"]);
  });

  it("at most 40", () => {
    const many = Array.from({ length: 60 }, (_, i) => candidate(`Link ${i}`));
    expect(wayThereCandidates(many, ctx)).toHaveLength(40);
  });
});

describe("createWayThere", () => {
  it("none without a model", () => {
    expect(createWayThere(null)).toBeNull();
  });

  it("shows the goal and the numbered controls; returns the index the model chose and the usage", async () => {
    const { llm, transport } = setup({ json: { index: 0 }, usage: { inputTokens: 300, outputTokens: 5 } });
    const out = await createWayThere(llm)!.choose(request());
    expect(out).toEqual({ index: 0, llm: { model: "claude-sonnet-5", inputTokens: 300, outputTokens: 5, cacheHit: null } });
    const sent = transport.requests[0]!;
    expect(sent.schemaName).toBe("way_there");
    expect(sent.messages[0]!.content).toContain("Click the 'Grills' link in the category navigation");
    expect(sent.messages[0]!.content).toContain('{"index":0,"label":"Show side menu"}');
  });

  it("-1, or an index that is not listed: nothing to click", async () => {
    const none = setup({ json: { index: -1 } });
    expect((await createWayThere(none.llm)!.choose(request())).index).toBeNull();
    // An unlisted index is corrected once; still unlisted, it chooses nothing.
    const unknown = setup({ json: { index: 7 } }, { json: { index: 7 } });
    expect((await createWayThere(unknown.llm)!.choose(request())).index).toBeNull();
    expect(unknown.transport.requests).toHaveLength(2);
  });
});
