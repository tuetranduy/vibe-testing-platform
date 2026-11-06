"use client";

import { CreateTestRunRequestSchema, HttpUrlSchema, type CreateTestRunRequestInput, type LlmSettingsView, type ReasoningLevel } from "@platform/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, createRun, getCriteria, getLlmSettings, getRun, getSuggestions } from "../lib/api";
import { newIdempotencyKey } from "../lib/uuid";
import { Icon } from "./Icon";
import { LEVEL_LABEL, modelGroups } from "./llm-format";

type Errors = Record<string, string>;
const EXAMPLES = [
  { label: "Search", icon: "search" as const, text: "Search for a product and check that the results match the search term." },
  { label: "Shopping cart", icon: "layers" as const, text: "Add a product to the cart and check that the total includes its price." },
  { label: "Navigation", icon: "globe" as const, text: "Open the main navigation links and check that each page has the expected heading." },
];

/** A test starts with two inputs. Execution settings are optional; legacy data/credential inputs are never copied. */
export function NewTestForm({ from = null, suggestion = null }: { from?: string | null; suggestion?: string | null } = {}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [requirement, setRequirement] = useState("");
  const [mode, setMode] = useState<"describe" | "explore">("describe");
  const [catalog, setCatalog] = useState<LlmSettingsView | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState<ReasoningLevel | "">("");
  const [maxRunSeconds, setMaxRunSeconds] = useState("300");
  const [maxSteps, setMaxSteps] = useState("40");
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [rerun, setRerun] = useState(true);
  const [hosts, setHosts] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<{ message: string; settings?: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [prefill, setPrefill] = useState<"loading" | "ready" | "error" | null>(from ? "loading" : null);
  const key = useRef<{ fingerprint: string; value: string } | null>(null);

  useEffect(() => {
    let live = true;
    getLlmSettings().then((v) => live && setCatalog(v), () => live && setCatalogFailed(true));
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!from) return;
    let live = true;
    const copied = suggestion
      ? getSuggestions(from).then((set) => {
          const chosen = set.suggestions.find((s) => s.id === suggestion);
          if (!chosen) throw new Error("Test idea no longer available");
          return chosen.requirement;
        })
      : getCriteria(from).then((req) => req.originalText, (err: unknown) => {
          if (err instanceof ApiRequestError && err.status === 409) return "";
          throw err;
        });
    Promise.all([getRun(from), copied]).then(([run, text]) => {
      if (!live) return;
      setTargetUrl((v) => v || run.targetUrl);
      setRequirement((v) => v || text);
      if (!text) setMode("explore");
      setPrefill("ready");
    }, () => live && setPrefill("error"));
    return () => { live = false; };
  }, [from, suggestion]);

  const effectiveModel = catalog?.models.find((m) => m.id === (model || catalog.defaults.model));
  const levels = effectiveModel?.reasoningLevels.filter((l) => l !== "default") ?? [];
  const host = HttpUrlSchema.safeParse(targetUrl.trim()).success ? new URL(targetUrl.trim()).host : null;
  const errorFor = (id: string) => errors[id] ? <p id={`${id}-error`} className="field-error"><Icon name="error" /> {errors[id]}</p> : null;
  const invalid = (id: string) => ({ "aria-invalid": errors[id] ? true as const : undefined, "aria-describedby": errors[id] ? `${id}-error` : undefined });

  function showErrors(next: Errors) {
    setErrors(next);
    const first = Array.from(form.current?.elements ?? []).find((el) => (el as HTMLElement).id in next) as HTMLElement | undefined;
    const details = first?.closest("details");
    if (details) details.open = true;
    first?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setBanner(null);
    const body: CreateTestRunRequestInput = {
      targetUrl: targetUrl.trim(), requirement: mode === "explore" ? "" : requirement.trim(),
      // Action consent is acknowledged for the app. Populate the legacy API authorization fields automatically.
      environment: "production",
      options: {
        maxRunSeconds: Number(maxRunSeconds), maxExplorationSteps: Number(maxSteps),
        generatePlaywright: true, rerunGeneratedTest: rerun, autoConfirmCriteria: autoConfirm,
        allowDestructiveActions: true,
        ...(host ? { confirmProductionHost: host } : {}),
        additionalAllowedHosts: hosts.split(/[\s,]+/).filter(Boolean),
      },
      ...((model || reasoning) ? { llm: { ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) } } : {}),
    };
    const next: Errors = {};
    if (mode === "describe" && requirement.trim().length < 10) next.requirement = "Describe what to check in at least 10 characters, or choose Find test ideas.";
    const parsed = CreateTestRunRequestSchema.safeParse(body);
    if (!parsed.success) for (const issue of parsed.error.issues) {
      const id = issue.path[0] === "options" || issue.path[0] === "llm" ? String(issue.path[1]) : String(issue.path[0]);
      next[id] ??= issue.message;
    }
    if (!HttpUrlSchema.safeParse(body.targetUrl).success) next.targetUrl = "Enter a full website URL, such as https://example.com.";
    if (Object.keys(next).length) { showErrors(next); return; }
    showErrors({});
    const fingerprint = JSON.stringify(body);
    if (key.current?.fingerprint !== fingerprint) key.current = { fingerprint, value: newIdempotencyKey() };
    setPending(true);
    try {
      const created = await createRun(body, key.current.value);
      router.push(`/runs/${encodeURIComponent(created.runId)}`);
    } catch (err) {
      setPending(false);
      if (err instanceof ApiRequestError) {
        if (err.code === "TARGET_NOT_ALLOWED") { showErrors({ targetUrl: err.message }); return; }
        if (err.code === "IDEMPOTENCY_CONFLICT") key.current = null;
        const fields = Object.fromEntries((err.issues ?? []).map((i) => [String(i.path.at(-1)), i.message]));
        if (Object.keys(fields).length) showErrors(fields);
        setBanner({ message: err.message, settings: err.code === "MODEL_NOT_AVAILABLE" });
      } else setBanner({ message: "The test couldn’t be started. Please try again." });
    }
  }

  return (
    <form ref={form} className="composer simple-composer" onSubmit={submit} noValidate aria-busy={pending}>
      <div className="composer-body">
        {prefill === "ready" && <p role="status" className="note note-info">Website and instructions copied from your earlier run.</p>}
        {prefill === "error" && <p role="status" className="note note-warning">Couldn’t load the earlier run. You can start a new test below.</p>}
        {banner && <div role="alert" className="banner banner-error"><Icon name="warning" /><div><p>{banner.message}</p>{banner.settings && <a href="/settings">Choose an available model in Settings</a>}</div></div>}
        <div className="field setup-field">
          <label htmlFor="targetUrl"><span className="field-number">1</span> Which website?</label>
          <div className="input-with-icon"><Icon name="globe" /><input id="targetUrl" type="url" inputMode="url" autoComplete="url" placeholder="https://your-website.com" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} {...invalid("targetUrl")} /></div>
          {errorFor("targetUrl")}
        </div>
        <div className="setup-field">
          <p className="field-label"><span className="field-number">2</span> What would you like to test?</p>
          <div className="test-mode" role="group" aria-label="How to start">
            <button type="button" aria-pressed={mode === "describe"} onClick={() => setMode("describe")}><Icon name="file" /><span>Describe a test</span></button>
            <button type="button" aria-pressed={mode === "explore"} onClick={() => setMode("explore")}><Icon name="sparkle" /><span>Find test ideas</span></button>
          </div>
          {mode === "describe" ? <div className="field">
            <label className="visually-hidden" htmlFor="requirement">Test instructions</label>
            <textarea ref={prompt} id="requirement" rows={5} placeholder="For example: Search for a product, add it to the cart, and check that the total updates." value={requirement} onChange={(e) => setRequirement(e.target.value)} {...invalid("requirement")} />
            {errorFor("requirement")}
            <div className="example-row" role="group" aria-label="Example tests"><span className="hint">Try an example</span>{EXAMPLES.map((ex) => <button key={ex.label} type="button" className="example-chip" onClick={() => { setRequirement(ex.text); prompt.current?.focus(); }}><Icon name={ex.icon} />{ex.label}</button>)}</div>
          </div> : <div className="explore-intro"><Icon name="sparkle" /><div><strong>Let the agent find a starting point.</strong><p>It explores your website and suggests useful tests. Choose an idea, review the checks, and start when you’re ready.</p></div></div>}
        </div>
      </div>
      <details className="simple-options">
        <summary><span><Icon name="sliders" /> Run settings <span className="muted">· optional</span></span><Icon name="chevron" /></summary>
        <div className="stack">
          <div className="field-pair">
            <div className="field"><label htmlFor="model">AI model</label><select id="model" value={model} disabled={!catalog} onChange={(e) => { setModel(e.target.value); setReasoning(""); }} {...invalid("model")}><option value="">{catalog ? `Default · ${catalog.defaults.label}` : "Default model"}</option>{catalog && modelGroups(catalog.models).map((group) => <optgroup key={group.label} label={group.label}>{group.models.map((m) => <option key={m.id} value={m.id} disabled={!m.available}>{m.label}{m.available ? "" : " · add a key in Settings"}</option>)}</optgroup>)}</select>{errorFor("model")}{catalogFailed && <p className="hint">Model choices couldn’t be loaded. The default model will be used.</p>}</div>
            <div className="field"><label htmlFor="reasoning">Thinking level</label><select id="reasoning" value={reasoning} onChange={(e) => setReasoning(e.target.value as ReasoningLevel | "")} {...invalid("reasoning")}><option value="">Model default</option>{levels.map((level) => <option key={level} value={level}>{LEVEL_LABEL[level]}</option>)}</select>{errorFor("reasoning")}</div>
          </div>
          <div className="field-pair">
            <div className="field"><label htmlFor="maxRunSeconds">Time limit (seconds)</label><input id="maxRunSeconds" type="number" min={60} max={1800} value={maxRunSeconds} onChange={(e) => setMaxRunSeconds(e.target.value)} {...invalid("maxRunSeconds")} />{errorFor("maxRunSeconds")}</div>
            <div className="field"><label htmlFor="maxExplorationSteps">Step limit</label><input id="maxExplorationSteps" type="number" min={1} max={100} value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} {...invalid("maxExplorationSteps")} />{errorFor("maxExplorationSteps")}</div>
          </div>
          <label className="choice"><input type="checkbox" checked={rerun} onChange={(e) => setRerun(e.target.checked)} />Verify results by rerunning the saved test</label>
          <label className="choice"><input type="checkbox" checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />Start immediately after planning (skip review)</label>
          <div className="field"><label htmlFor="additionalAllowedHosts">Other website hosts</label><input id="additionalAllowedHosts" placeholder="login.example.com, help.example.com" value={hosts} onChange={(e) => setHosts(e.target.value)} {...invalid("additionalAllowedHosts")} /><p className="hint">Only needed if the test moves to another host.</p>{errorFor("additionalAllowedHosts")}</div>
        </div>
      </details>
      <div className="composer-footer"><p className="composer-note"><Icon name="shield" />{autoConfirm ? "The test starts after planning." : "Review the checks before the test runs."}</p><button className="button button-primary button-lg" type="submit" disabled={pending || prefill === "loading"}>{pending ? "Starting…" : mode === "explore" ? "Explore website" : "Create test"}<Icon name="arrow" /></button></div>
    </form>
  );
}
