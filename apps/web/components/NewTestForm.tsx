"use client";

import { Field } from "@/components/ui/field";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { CreateTestRunRequestSchema, DiscoveryFixtureUrlSchema, DiscoveryLiveUrlSchema, HttpUrlSchema, type CreateTestRunRequestInput, type LlmSettingsView, type ReasoningLevel } from "@platform/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiRequestError, checkDiscoverySite, createRun, getCriteria, getDiscoveryCapability, getLlmSettings, getRun, getSuggestions } from "../lib/api";
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
  const [maxRunSeconds, setMaxRunSeconds] = useState("600");
  const [maxSteps, setMaxSteps] = useState("40");
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [discoveryFixture, setDiscoveryFixture] = useState<string | null>(null);
  const [verifiedSites, setVerifiedSites] = useState(false);
  const [verification, setVerification] = useState<(Awaited<ReturnType<typeof checkDiscoverySite>> & { origin: string }) | null>(null);
  const [verificationPending, setVerificationPending] = useState(false);
  const [verificationError, setVerificationError] = useState("");
  const [discover, setDiscover] = useState(false);
  const [discoverySeconds, setDiscoverySeconds] = useState("120");
  const [discoverySteps, setDiscoverySteps] = useState("20");
  const [rerun, setRerun] = useState(true);
  const [hosts, setHosts] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const pendingFocus = useRef<string | null>(null);
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
    if (mode !== "explore") return;
    let live = true;
    getDiscoveryCapability().then(({ fixtureUrl, verifiedSites }) => {
      if (!live) return;
      setDiscoveryFixture(fixtureUrl);
      setVerifiedSites(Boolean(verifiedSites));
    }, () => {});
    return () => { live = false; };
  }, [mode]);

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
  const fixture = DiscoveryFixtureUrlSchema.safeParse(targetUrl.trim());
  const liveSite = DiscoveryLiveUrlSchema.safeParse(targetUrl.trim());
  const canVerify = mode === "explore" && verifiedSites && liveSite.success && effectiveModel?.provider !== "fake";
  const siteVerification = canVerify && verification?.origin === liveSite.data.origin ? verification : null;
  const canDiscover = mode === "explore" && effectiveModel?.provider !== "fake" &&
    ((fixture.success && fixture.data === discoveryFixture) || siteVerification?.verified === true);
  const usingDiscovery = canDiscover && discover;
  const usingVerifiedSite = usingDiscovery && siteVerification?.verified === true;

  async function verifySite() {
    if (!liveSite.success) return;
    setVerificationPending(true);
    setVerificationError("");
    try {
      const result = await checkDiscoverySite(liveSite.data.href);
      setVerification({ ...result, origin: liveSite.data.origin });
    } catch (error) {
      setVerificationError(error instanceof Error ? error.message : "Site verification could not be checked");
    } finally {
      setVerificationPending(false);
    }
  }
  const errorFor = (id: string) => errors[id] ? <p id={`${id}-error`} className="flex items-start gap-1.5 text-sm font-medium text-destructive [&_.icon]:mt-px"><Icon name="error" /> {errors[id]}</p> : null;
  const invalid = (id: string) => ({ "aria-invalid": errors[id] ? true as const : undefined, "aria-describedby": errors[id] ? `${id}-error` : undefined });

  useEffect(() => {
    if (!pendingFocus.current) return;
    const field = form.current?.elements.namedItem(pendingFocus.current);
    if (field instanceof HTMLElement) {
      field.focus();
      pendingFocus.current = null;
    }
  }, [errors, settingsOpen]);

  function showErrors(next: Errors) {
    const first = ["targetUrl", "requirement", "autonomousDiscovery", "discoveryMaxSeconds", "discoveryMaxSteps", "model", "reasoning", "maxRunSeconds", "maxExplorationSteps", "additionalAllowedHosts"].find((id) => id in next);
    pendingFocus.current = first ?? null;
    if (first && first !== "targetUrl" && first !== "requirement") setSettingsOpen(true);
    setErrors(next);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setBanner(null);
    const body: CreateTestRunRequestInput = {
      targetUrl: targetUrl.trim(), requirement: mode === "explore" ? "" : requirement.trim(),
      // Action consent is acknowledged for the app. Populate the legacy API authorization fields automatically.
      environment: usingDiscovery && !usingVerifiedSite ? "staging" : "production",
      options: {
        maxRunSeconds: Number(maxRunSeconds), maxExplorationSteps: Number(maxSteps),
        generatePlaywright: true, rerunGeneratedTest: rerun, autoConfirmCriteria: usingDiscovery ? false : autoConfirm,
        allowDestructiveActions: !usingDiscovery,
        ...(host && !usingDiscovery ? { confirmProductionHost: host } : {}),
        ...(usingDiscovery ? { autonomousDiscovery: true, discoveryMaxSeconds: Number(discoverySeconds), discoveryMaxSteps: Number(discoverySteps) } : {}),
        ...(usingVerifiedSite ? { verifiedSiteDiscovery: true } : {}),
        additionalAllowedHosts: usingVerifiedSite ? [] : hosts.split(/[\s,]+/).filter(Boolean),
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
        if (err.code === "DISCOVERY_SITE_UNVERIFIED") {
          setVerification(null);
          setDiscover(false);
          showErrors({ targetUrl: err.message });
          return;
        }
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
        <Field className="setup-field">
          <label htmlFor="targetUrl"><span className="field-number">1</span> Which website?</label>
          <div className="relative block min-w-0 [&>.icon]:pointer-events-none [&>.icon]:absolute [&>.icon]:top-1/2 [&>.icon]:left-3.5 [&>.icon]:-translate-y-1/2 [&>.icon]:text-(--text-subtle) [&>input]:pl-[42px]"><Icon name="globe" /><Input id="targetUrl" type="url" inputMode="url" autoComplete="url" placeholder="https://your-website.com" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} {...invalid("targetUrl")} /></div>
          {errorFor("targetUrl")}
        </Field>
        <div className="setup-field">
          <p className="field-label"><span className="field-number">2</span> What would you like to test?</p>
          <div className="test-mode" role="group" aria-label="How to start">
            <Button variant="plain" type="button" aria-pressed={mode === "describe"} onClick={() => setMode("describe")}><Icon name="file" /><span>Describe a test</span></Button>
            <Button variant="plain" type="button" aria-pressed={mode === "explore"} onClick={() => setMode("explore")}><Icon name="sparkle" /><span>Find test ideas</span></Button>
          </div>
          {mode === "describe" ? <Field>
            <label className="sr-only" htmlFor="requirement">Test instructions</label>
            <Textarea className="field-sizing-fixed" ref={prompt} id="requirement" rows={5} placeholder="For example: Search for a product, add it to the cart, and check that the total updates." value={requirement} onChange={(e) => setRequirement(e.target.value)} {...invalid("requirement")} />
            {errorFor("requirement")}
            <div className="example-row" role="group" aria-label="Example tests"><span className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">Try an example</span>{EXAMPLES.map((ex) => <Button variant="plain" key={ex.label} type="button" className="example-chip" onClick={() => { setRequirement(ex.text); prompt.current?.focus(); }}><Icon name={ex.icon} />{ex.label}</Button>)}</div>
          </Field> : <div className="explore-intro"><Icon name="sparkle" /><div><strong>Let the agent find a starting point.</strong><p>It explores your website and suggests useful tests. Choose an idea, review the checks, and start when you’re ready.</p></div></div>}
          {canVerify && !siteVerification?.verified && <Field className="gap-2">
            <div><Button type="button" variant="outline" disabled={verificationPending} onClick={() => void verifySite()}>
              {verificationPending ? "Checking DNS…" : siteVerification ? "Check DNS record" : "Verify site for Browser Use"}
            </Button></div>
            {siteVerification && <div className="text-sm text-muted-foreground">
              <p>Add this TXT record to verify control of the site.</p>
              <dl className="mt-1 break-all">
                <dt>Name</dt><dd><code>{siteVerification.name}</code></dd>
                <dt>Value</dt><dd><code>{siteVerification.value}</code></dd>
              </dl>
            </div>}
            {verificationError && <p role="alert" className="text-sm text-destructive">{verificationError}</p>}
          </Field>}
          {canDiscover && <Field className="gap-2">
            <div className="flex items-center gap-2">
              <Checkbox id="autonomousDiscovery" checked={discover} onCheckedChange={(checked) => setDiscover(checked === true)} aria-describedby="discovery-hint" />
              <label htmlFor="autonomousDiscovery">Autonomous Discovery (Browser Use)</label>
            </div>
            <p id="discovery-hint" className="text-sm text-muted-foreground">{siteVerification?.verified
              ? "Suggest tests from read-only snapshots of this verified site. This uses extra AI calls and requires criteria review."
              : "Explore the staging fixture for additional test ideas. This uses extra AI calls and requires criteria review."}</p>
            {errorFor("autonomousDiscovery")}
            {usingDiscovery && <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
              <Field><label htmlFor="discoveryMaxSeconds">Discovery time (seconds)</label><Input id="discoveryMaxSeconds" name="discoveryMaxSeconds" type="number" min={15} max={120} value={discoverySeconds} onChange={(e) => setDiscoverySeconds(e.target.value)} {...invalid("discoveryMaxSeconds")} />{errorFor("discoveryMaxSeconds")}</Field>
              <Field><label htmlFor="discoveryMaxSteps">Discovery model calls</label><Input id="discoveryMaxSteps" name="discoveryMaxSteps" type="number" min={2} max={20} value={discoverySteps} onChange={(e) => setDiscoverySteps(e.target.value)} {...invalid("discoveryMaxSteps")} />{errorFor("discoveryMaxSteps")}</Field>
            </div>}
          </Field>}
        </div>
      </div>
      <Collapsible open={settingsOpen} onOpenChange={setSettingsOpen} className="group border-t border-(--border-soft) px-[30px] max-[720px]:px-[22px]">
        <CollapsibleTrigger asChild>
          <Button variant="plain" className="flex w-full cursor-pointer items-center justify-between py-[18px] text-[0.8rem] text-muted-foreground">
            <span className="flex items-center gap-2"><Icon name="sliders" /> Run settings <span>· optional</span></span>
            <Icon name="chevron" className="transition-transform group-data-open:rotate-90" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent forceMount hidden={!settingsOpen} className="flex min-w-0 flex-col gap-5 pt-1 pb-6">
          <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
            <Field><label htmlFor="model">AI model</label><NativeSelect className="w-full" id="model" value={model} disabled={!catalog} onChange={(e) => { setModel(e.target.value); setReasoning(""); }} {...invalid("model")}><option value="">{catalog ? `Default · ${catalog.defaults.label}` : "Default model"}</option>{catalog && modelGroups(catalog.models).map((group) => <optgroup key={group.label} label={group.label}>{group.models.map((m) => <option key={m.id} value={m.id} disabled={!m.available}>{m.label}{m.available ? "" : " · add a key in Settings"}</option>)}</optgroup>)}</NativeSelect>{errorFor("model")}{catalogFailed && <p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">Model choices couldn’t be loaded. The default model will be used.</p>}</Field>
            <Field><label htmlFor="reasoning">Thinking level</label><NativeSelect className="w-full" id="reasoning" value={reasoning} onChange={(e) => setReasoning(e.target.value as ReasoningLevel | "")} {...invalid("reasoning")}><option value="">Model default</option>{levels.map((level) => <option key={level} value={level}>{LEVEL_LABEL[level]}</option>)}</NativeSelect>{errorFor("reasoning")}</Field>
          </div>
          <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
            <Field><label htmlFor="maxRunSeconds">Time limit (seconds)</label><Input id="maxRunSeconds" type="number" min={60} max={1800} value={maxRunSeconds} onChange={(e) => setMaxRunSeconds(e.target.value)} {...invalid("maxRunSeconds")} />{errorFor("maxRunSeconds")}</Field>
            <Field><label htmlFor="maxExplorationSteps">Step limit</label><Input id="maxExplorationSteps" type="number" min={1} max={100} value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} {...invalid("maxExplorationSteps")} /><p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">Steps in the test plan.</p>{errorFor("maxExplorationSteps")}</Field>
          </div>
          <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-[0.9375rem] has-disabled:cursor-not-allowed has-disabled:text-muted-foreground"><Checkbox checked={rerun} onCheckedChange={(checked) => setRerun(checked === true)} />Verify results by rerunning the saved test</label>
          <label className="flex min-h-8 cursor-pointer items-center gap-2.5 text-[0.9375rem] has-disabled:cursor-not-allowed has-disabled:text-muted-foreground"><Checkbox disabled={usingDiscovery} checked={!usingDiscovery && autoConfirm} onCheckedChange={(checked) => setAutoConfirm(checked === true)} />Start immediately after planning (skip review)</label>
          {!usingVerifiedSite && <Field><label htmlFor="additionalAllowedHosts">Other website hosts</label><Input id="additionalAllowedHosts" placeholder="login.example.com, help.example.com" value={hosts} onChange={(e) => setHosts(e.target.value)} {...invalid("additionalAllowedHosts")} /><p className="hint text-[0.8125rem] text-(--text-subtle) [&_.icon]:mr-0.5">Only needed if the test moves to another host.</p>{errorFor("additionalAllowedHosts")}</Field>}
        </CollapsibleContent>
      </Collapsible>
      <div className="composer-footer"><p className="composer-note"><Icon name="shield" />{autoConfirm && !usingDiscovery ? "The test starts after planning." : "Review the checks before the test runs."}</p><Button size="lg" type="submit" disabled={pending || prefill === "loading"}>{pending ? "Starting…" : mode === "explore" ? "Explore website" : "Create test"}<Icon name="arrow" /></Button></div>
    </form>
  );
}
