import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { api, db, logs, secretForms } from "./support/client";
import { REQUIREMENTS } from "./support/scenarios";

const stack = inject("e2e");
const client = api(stack);
const store = db(stack);
/** The Gemini key this spec saves: printable ASCII, unique per suite run, never a real key. */
const GEMINI_KEY = `AIza-e2e-${randomBytes(12).toString("hex")}`;

afterAll(async () => {
  await client.putProviderKey("gemini", null); // no saved key outlives this spec
  await store.close();
});

// CI mode only: the scripted model answers for any provider, while live mode's environment may hold a real
// Gemini key (then nothing would be refused).
describe.runIf(stack.mode === "ci")("AI provider settings: a run on a model chosen for it (spec 2026-09-28-llm-settings-design.md)", () => {
  it("a Gemini model is refused until a key exists; with the key saved in Settings the run records its choice, its calls carry that model, and the key is nowhere", async () => {
    const body = {
      targetUrl: `${stack.targetUrl}/`,
      requirement: REQUIREMENTS.cart,
      options: { autoConfirmCriteria: true },
      llm: { model: "gemini-3.8-flash", reasoning: "low" },
    };

    const refused = await client.call("POST", "/v1/test-runs", body);
    expect(refused.status).toBe(422);
    expect(refused.json).toMatchObject({
      code: "MODEL_NOT_AVAILABLE",
      issues: [{ path: ["llm", "model"], message: "Add a Google Gemini API key in Settings" }],
    });

    const saved = await client.putProviderKey("gemini", GEMINI_KEY);
    expect(saved.status).toBe(200);
    expect(saved.json.providers).toContainEqual({ provider: "gemini", label: "Google Gemini", key: { source: "settings", updatedAt: expect.any(String) } });

    const runId = await client.create(body);
    expect(await client.finished(runId)).toMatchObject({
      lifecycle: "COMPLETED",
      llm: { provider: "gemini", model: "gemini-3.8-flash", label: "Gemini 3.8 Flash", reasoning: "low" },
    });
    const calls = await store.llmCalls(runId);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.model))).toEqual(new Set(["gemini-3.8-flash"]));

    // Keys are write-only: no settings answer contains it (raw bodies).
    const view = await client.llmSettings();
    for (const text of [saved.text, view.text]) expect(text).not.toContain(GEMINI_KEY);

    // ...and no form of it is in the database, the events or the logs. Each source really holds this run / key.
    const settingsRows = await store.settingsRows();
    expect(settingsRows).toContain('"provider":"gemini"');
    const sources = { "DB rows": `${await store.rowsOf(runId)}\n${settingsRows}`, events: JSON.stringify(await store.events(runId)), logs: logs(stack) };
    for (const text of Object.values(sources)) expect(text).toContain(runId);
    const forms = secretForms(GEMINI_KEY);
    for (const [where, text] of Object.entries(sources)) {
      for (const form of forms) expect(text, `${where} contain ${JSON.stringify(form)}`).not.toContain(form);
    }
  });
});
