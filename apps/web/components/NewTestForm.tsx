"use client";

import {
  CreateTestRunRequestSchema,
  DataKeySchema,
  HttpUrlSchema,
  SecretNameSchema,
  type CreateTestRunRequestInput,
} from "@platform/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiRequestError, createRun, getCriteria, getRun } from "../lib/api";
import { newIdempotencyKey } from "../lib/uuid";
import { Icon, type IconName } from "./Icon";
import { plural } from "./report-format";

interface DataRow {
  id: number;
  key: string;
  value: string;
}
interface SecretRow {
  id: number;
  name: string;
  value: string;
}
interface Options {
  maxExplorationSteps: string;
  maxRunSeconds: string;
  generatePlaywright: boolean;
  rerunGeneratedTest: boolean;
  autoConfirmCriteria: boolean;
  allowDestructiveActions: boolean;
  confirmProductionHost: string;
  additionalAllowedHosts: string;
}
type Errors = Record<string, string>;
interface Banner {
  title: string;
  message: string;
}

const DEFAULT_OPTIONS: Options = {
  maxExplorationSteps: "40",
  maxRunSeconds: "300",
  generatePlaywright: true,
  rerunGeneratedTest: true,
  autoConfirmCriteria: false,
  allowDestructiveActions: false,
  confirmProductionHost: "",
  additionalAllowedHosts: "",
};

const MSG = {
  url: "Enter an http:// or https:// URL, without a username or password.",
  requirement: "Describe the requirement in at least 10 characters.",
  dataKey: "Start with a letter; use letters, digits or _ (up to 64).",
  secretName: "Start with a lowercase letter; use a–z, 0–9 or _ (up to 32).",
  secretValue: "Enter at least 4 characters.",
  secretMissing: "Enter the secret value.",
  duplicate: "This name is already used.",
  confirmHost: (host: string) => `Type ${host} exactly to confirm.`,
};

// Field ids double as error keys, so a server issue path maps straight onto a field.
const fid = {
  url: "targetUrl",
  requirement: "requirement",
  dataKey: (id: number) => `testData-${id}-key`,
  secretName: (id: number) => `secret-${id}-name`,
  secretValue: (id: number) => `secret-${id}-value`,
  option: (name: string) => `options-${name}`,
};

/** The URL's host as the API compares it (lowercase, with a non-default port), or null while the URL is invalid. */
function hostOf(url: string): string | null {
  return HttpUrlSchema.safeParse(url).success ? new URL(url).host : null;
}

function build(
  targetUrl: string,
  requirement: string,
  environment: "staging" | "production",
  data: DataRow[],
  secrets: SecretRow[],
  options: Options,
): { errors: Errors; body: CreateTestRunRequestInput } {
  const errors: Errors = {};
  const url = targetUrl.trim();
  if (!HttpUrlSchema.safeParse(url).success) errors[fid.url] = MSG.url;
  if (requirement.trim().length < 10) errors[fid.requirement] = MSG.requirement;

  const testData: Record<string, string> = {};
  for (const row of data) {
    const key = row.key.trim();
    if (!key && !row.value) continue; // empty rows are omitted
    if (!DataKeySchema.safeParse(key).success) errors[fid.dataKey(row.id)] = MSG.dataKey;
    else if (key in testData) errors[fid.dataKey(row.id)] = MSG.duplicate;
    else testData[key] = row.value;
  }

  const secretValues: Record<string, string> = {};
  for (const row of secrets) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!SecretNameSchema.safeParse(name).success) errors[fid.secretName(row.id)] = MSG.secretName;
    else if (name in secretValues) errors[fid.secretName(row.id)] = MSG.duplicate;
    if (!row.value) errors[fid.secretValue(row.id)] = MSG.secretMissing;
    else if (row.value.length < 4) errors[fid.secretValue(row.id)] = MSG.secretValue;
    if (!errors[fid.secretName(row.id)] && !errors[fid.secretValue(row.id)]) secretValues[name] = row.value;
  }

  // Production needs the target host typed as confirmation; the API enforces the same rule.
  const confirming = environment === "production" && options.allowDestructiveActions;
  const host = hostOf(url);
  if (confirming && host !== null && options.confirmProductionHost.trim().toLowerCase() !== host) {
    errors[fid.option("confirmProductionHost")] = MSG.confirmHost(host);
  }

  const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  const body: CreateTestRunRequestInput = {
    targetUrl: url,
    requirement: requirement.trim(),
    environment,
    testData,
    secrets: secretValues,
    options: {
      maxExplorationSteps: int(options.maxExplorationSteps),
      maxRunSeconds: int(options.maxRunSeconds),
      generatePlaywright: options.generatePlaywright,
      rerunGeneratedTest: options.generatePlaywright && options.rerunGeneratedTest,
      autoConfirmCriteria: options.autoConfirmCriteria,
      allowDestructiveActions: options.allowDestructiveActions,
      // Only sent when there is a non-empty value to confirm: a valid URL with an empty value is
      // already refused above, and an empty string here would otherwise surface the contract's raw
      // min(1) message once the confirmation field renders (it doesn't exist yet while the URL is invalid).
      ...(confirming && options.confirmProductionHost.trim() !== "" ? { confirmProductionHost: options.confirmProductionHost.trim() } : {}),
      additionalAllowedHosts: options.additionalAllowedHosts
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter(Boolean),
    },
  };

  // The contract schema is the final word (option bounds, host names, cross-field rules).
  const parsed = CreateTestRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [head, name] = issue.path;
      const field = head === "options" && typeof name === "string" ? fid.option(name) : null;
      if (field && !errors[field]) errors[field] = OPTION_MSG[name as string] ?? issue.message;
    }
  }
  return { errors, body };
}

const OPTION_MSG: Record<string, string> = {
  maxExplorationSteps: "Enter a whole number from 1 to 100.",
  maxRunSeconds: "Enter a whole number from 60 to 1800.",
  additionalAllowedHosts: "Enter up to 10 host names, such as login.example.com.",
};

/** Starting points for an empty requirement; each fills in a full sentence to edit. */
const EXAMPLES = [
  { label: "Adding to cart updates the total", text: "A user can add a product to the cart, and the cart total updates to include its price." },
  { label: "Sign-in opens the account page", text: "A user can sign in with valid credentials and lands on their account page." },
  { label: "Search lists matching products", text: "Searching for a product name lists only products whose names contain it." },
] as const;

/** Maps server validation issues (400) onto the fields they name. */
function issuesToErrors(err: ApiRequestError): Errors {
  const errors: Errors = {};
  for (const issue of err.issues ?? []) {
    const [head, name] = issue.path;
    if (head === "targetUrl" || head === "requirement") errors[head] = issue.message;
    else if (head === "options" && typeof name === "string") errors[fid.option(name)] = issue.message;
  }
  return errors;
}

let nextRowId = 1;

/** `from`: an earlier run to start over from (its website and requirement are copied in). */
export function NewTestForm({ from = null }: { from?: string | null } = {}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const requirementRef = useRef<HTMLTextAreaElement>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [requirement, setRequirement] = useState("");
  /** Pre-fill when starting over from an earlier run (its URL and full requirement text only). */
  const [prefill, setPrefill] = useState<"loading" | "loaded" | "failed" | null>(from ? "loading" : null);
  useEffect(() => {
    if (!from) return;
    let live = true;
    Promise.all([getRun(from), getCriteria(from)]).then(
      ([run, req]) => {
        if (!live) return;
        setTargetUrl((v) => v || run.targetUrl);
        setRequirement((v) => v || req.originalText);
        setPrefill("loaded");
      },
      () => live && setPrefill("failed"),
    );
    return () => {
      live = false;
    };
  }, [from]);
  const [environment, setEnvironment] = useState<"staging" | "production">("staging");
  const [data, setData] = useState<DataRow[]>([]);
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const [pending, setPending] = useState(false);
  /** Secret values were wiped after a failed submit and must be typed again. */
  const [secretsCleared, setSecretsCleared] = useState(false);
  /**
   * One Idempotency-Key per request: a retry after a lost response must replay the run it may have
   * created, not start a second one. A new key only once the request changes. The fingerprint
   * holds secret names, never their values (those are re-entered for every attempt).
   */
  const idempotency = useRef<{ key: string; fingerprint: string } | null>(null);
  const keyFor = (body: CreateTestRunRequestInput) => {
    const fingerprint = JSON.stringify({ ...body, secrets: Object.keys(body.secrets ?? {}).sort() });
    if (idempotency.current?.fingerprint !== fingerprint) idempotency.current = { key: newIdempotencyKey(), fingerprint };
    return idempotency.current.key;
  };

  /** Focuses the first invalid field in document order (opening Advanced options if it's in there). */
  const focusFirstError = (errs: Errors) => {
    const fields = Array.from(formRef.current?.elements ?? []) as HTMLElement[];
    const first = fields.find((el) => el.id && el.id in errs);
    const details = first?.closest("details");
    if (details) details.open = true;
    first?.focus();
  };

  const setOption = <K extends keyof Options>(name: K, value: Options[K]) => setOptions((o) => ({ ...o, [name]: value }));

  /** The rerun setting from before destructive actions were allowed, restored when they are unticked. */
  const rerunBeforeDestructive = useRef<boolean | null>(null);
  const toggleDestructive = (allow: boolean) => {
    if (allow) {
      rerunBeforeDestructive.current = options.rerunGeneratedTest;
      setOptions((o) => ({ ...o, allowDestructiveActions: true, rerunGeneratedTest: false }));
    } else {
      const rerun = rerunBeforeDestructive.current ?? options.rerunGeneratedTest;
      rerunBeforeDestructive.current = null;
      setOptions((o) => ({ ...o, allowDestructiveActions: false, rerunGeneratedTest: rerun }));
    }
  };
  const host = hostOf(targetUrl.trim());
  const rerunOn = options.generatePlaywright && options.rerunGeneratedTest;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    const { errors: errs, body } = build(targetUrl, requirement, environment, data, secrets, options);
    setErrors(errs);
    setBanner(null);
    if (Object.keys(errs).length > 0) {
      focusFirstError(errs);
      return;
    }

    setPending(true);
    // Secret values leave component state as soon as the request is built (success or failure);
    // names stay so they can be re-entered after an error.
    setSecrets((rows) => rows.map((r) => ({ ...r, value: "" })));
    try {
      const created = await createRun(body, keyFor(body));
      router.push(`/runs/${encodeURIComponent(created.runId)}`);
      idempotency.current = null;
    } catch (err) {
      setPending(false);
      setSecretsCleared(secrets.some((r) => r.value));
      if (!(err instanceof ApiRequestError)) {
        // A bug in the page, not a server answer: keep it visible to whoever debugs it. The error
        // comes from our own code, never from the request body, so it carries no secret values.
        console.error("New test: unexpected client-side error", err);
        setBanner({
          title: "The test couldn't be started",
          message: "Something went wrong in the browser (details are in the console). Please try again.",
        });
        return;
      }
      if (err.code === "TARGET_NOT_ALLOWED") {
        const next = { [fid.url]: err.message };
        setErrors(next);
        focusFirstError(next);
      } else if (err.code === "IDEMPOTENCY_CONFLICT") {
        // An earlier attempt with these details reached the server with different secret values.
        idempotency.current = null;
        setBanner({
          title: "This test may already have started",
          message: "An earlier attempt reached the server. Check Test runs before starting it again; submitting again starts a new run.",
        });
      } else if (err.code === "TOO_MANY_ACTIVE_RUNS") {
        setBanner({ title: "Can't start another run yet", message: `${err.message}. You can cancel a run or try again later.` });
      } else if (err.code === "VALIDATION_FAILED" && Object.keys(issuesToErrors(err)).length > 0) {
        const next = issuesToErrors(err);
        setErrors(next);
        focusFirstError(next);
      } else {
        setBanner({ title: "The test couldn't be started", message: err.message });
      }
    }
  }

  const describedBy = (id: string, hint?: string) =>
    [hint, errors[id] ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const fieldError = (id: string) =>
    errors[id] ? (
      <p id={`${id}-error`} className="field-error">
        <Icon name="error" /> {errors[id]}
      </p>
    ) : null;

  const dataCount = data.filter((r) => r.key.trim() || r.value).length;
  const secretCount = secrets.filter((r) => r.name.trim()).length;

  /** Fills the requirement from an example; focus moves to it, since the example buttons go away. */
  const applyExample = (text: string) => {
    setRequirement(text);
    requirementRef.current?.focus();
  };

  return (
    <form ref={formRef} className="composer" noValidate onSubmit={onSubmit} aria-busy={pending}>
      <div className="composer-body">
        {prefill === "loaded" && (
          <div role="status" className="banner banner-info">
            <Icon name="info" />
            <div>
              <p>Copied the website and requirement from your earlier run. Test data and secrets must be entered again — they are never copied.</p>
            </div>
          </div>
        )}
        {prefill === "failed" && (
          <div role="status" className="banner banner-warning">
            <Icon name="warning" />
            <div>
              <p>Couldn&apos;t load the earlier run; fill in the form below.</p>
            </div>
          </div>
        )}
        {banner && (
          <div role="alert" className="banner banner-error">
            <Icon name="warning" />
            <div>
              <p className="banner-title">{banner.title}</p>
              <p>{banner.message}</p>
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor={fid.url}>Website URL</label>
          <div className="input-with-icon">
            <Icon name="globe" />
            <input
              id={fid.url}
              name="targetUrl"
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="https://shop.example.com"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              aria-invalid={errors[fid.url] ? true : undefined}
              aria-describedby={describedBy(fid.url, "targetUrl-hint")}
            />
          </div>
          <p id="targetUrl-hint" className="hint">
            The page the test starts from.
          </p>
          {fieldError(fid.url)}
        </div>

        <div className="field">
          <label htmlFor={fid.requirement}>Requirement</label>
          <div className="prompt-box">
            <textarea
              ref={requirementRef}
              id={fid.requirement}
              name="requirement"
              rows={4}
              placeholder="Verify that a user can search for an iPhone, add it to the cart, and see it in the cart."
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              aria-invalid={errors[fid.requirement] ? true : undefined}
              aria-describedby={describedBy(fid.requirement, "requirement-hint")}
            />
            {requirement === "" && (
              <div className="prompt-examples" role="group" aria-label="Examples to start from">
                <span className="examples-label" aria-hidden="true">
                  Try
                </span>
                {EXAMPLES.map((ex) => (
                  <button key={ex.label} type="button" className="example-chip" onClick={() => applyExample(ex.text)}>
                    {ex.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p id="requirement-hint" className="hint">
            One behaviour per test works best: name the page, the action, and what you expect to see.
          </p>
          {fieldError(fid.requirement)}
        </div>

        <fieldset className="field">
          <legend>Environment</legend>
          <div className="env-row">
            <div className="segmented">
              {(["staging", "production"] as const).map((env) => (
                <label key={env} className="segment">
                  <input
                    type="radio"
                    className="segment-input"
                    name="environment"
                    value={env}
                    checked={environment === env}
                    onChange={() => setEnvironment(env)}
                  />
                  {env === "staging" ? "Staging" : "Production"}
                </label>
              ))}
            </div>
            <p className="hint">Destructive actions are blocked unless you allow them under Advanced options.</p>
          </div>
        </fieldset>
      </div>

      <div className="form-sections">
        <FormSection
          icon="data"
          title="Test data"
          description="Values the test may type, such as a search term. Empty rows are ignored."
          summary={dataCount === 0 ? "None" : plural(dataCount, "value")}
        >
          {data.map((row, i) => (
            <div key={row.id} className="row">
              <div className="row-cell">
                <label className="visually-hidden" htmlFor={fid.dataKey(row.id)}>
                  Test data {i + 1} key
                </label>
                <input
                  id={fid.dataKey(row.id)}
                  placeholder="Key, e.g. searchTerm"
                  autoComplete="off"
                  spellCheck={false}
                  value={row.key}
                  onChange={(e) => setData((rows) => rows.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))}
                  aria-invalid={errors[fid.dataKey(row.id)] ? true : undefined}
                  aria-describedby={describedBy(fid.dataKey(row.id))}
                />
                {fieldError(fid.dataKey(row.id))}
              </div>
              <div className="row-cell">
                <label className="visually-hidden" htmlFor={`testData-${row.id}-value`}>
                  Test data {i + 1} value
                </label>
                <input
                  id={`testData-${row.id}-value`}
                  placeholder="Value"
                  autoComplete="off"
                  value={row.value}
                  onChange={(e) => setData((rows) => rows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))}
                />
              </div>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setData((rows) => rows.filter((r) => r.id !== row.id))}
              >
                Remove<span className="visually-hidden"> test data {i + 1}</span>
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setData((rows) => [...rows, { id: nextRowId++, key: "", value: "" }])}
          >
            <Icon name="plus" />
            Add test data
          </button>
        </FormSection>

        <FormSection
          icon="lock"
          title="Secrets"
          description="Credentials such as a password: encrypted, redacted from all output, deleted when the run ends."
          summary={secretCount === 0 ? "None" : plural(secretCount, "secret")}
        >
          <p className="hint">
            <Icon name="lock" /> Secrets are filled in by the platform, never by the AI.
          </p>
          {secretsCleared && secrets.length > 0 && (
            <p className="hint">
              <Icon name="info" /> Secret values are cleared after every submit, so enter them again before retrying.
            </p>
          )}
          {secrets.map((row, i) => (
            <div key={row.id} className="row">
              <div className="row-cell">
                <label className="visually-hidden" htmlFor={fid.secretName(row.id)}>
                  Secret {i + 1} name
                </label>
                <input
                  id={fid.secretName(row.id)}
                  placeholder="Name, e.g. password"
                  autoComplete="off"
                  spellCheck={false}
                  value={row.name}
                  onChange={(e) => setSecrets((rows) => rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)))}
                  aria-invalid={errors[fid.secretName(row.id)] ? true : undefined}
                  aria-describedby={describedBy(fid.secretName(row.id))}
                />
                {fieldError(fid.secretName(row.id))}
              </div>
              <div className="row-cell">
                <label className="visually-hidden" htmlFor={fid.secretValue(row.id)}>
                  Secret {i + 1} value
                </label>
                <input
                  id={fid.secretValue(row.id)}
                  type="password"
                  placeholder="Value"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={row.value}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSecrets((rows) => rows.map((r) => (r.id === row.id ? { ...r, value } : r)));
                  }}
                  aria-invalid={errors[fid.secretValue(row.id)] ? true : undefined}
                  aria-describedby={describedBy(fid.secretValue(row.id))}
                />
                {fieldError(fid.secretValue(row.id))}
              </div>
              <button
                type="button"
                className="button button-quiet"
                onClick={() => setSecrets((rows) => rows.filter((r) => r.id !== row.id))}
              >
                Remove<span className="visually-hidden"> secret {i + 1}</span>
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button button-secondary"
            onClick={() => setSecrets((rows) => [...rows, { id: nextRowId++, name: "", value: "" }])}
          >
            <Icon name="plus" />
            Add secret
          </button>
        </FormSection>

        <FormSection
          icon="sliders"
          title="Advanced options"
          description="Step and time limits, the Playwright test, confirmation and extra hosts."
          summary={optionsSummary(options)}
        >
          <div className="field-pair">
            <div className="field">
              <label htmlFor={fid.option("maxExplorationSteps")}>Max exploration steps</label>
              <input
                id={fid.option("maxExplorationSteps")}
                inputMode="numeric"
                value={options.maxExplorationSteps}
                onChange={(e) => setOption("maxExplorationSteps", e.target.value)}
                aria-invalid={errors[fid.option("maxExplorationSteps")] ? true : undefined}
                aria-describedby={describedBy(fid.option("maxExplorationSteps"))}
              />
              {fieldError(fid.option("maxExplorationSteps"))}
            </div>
            <div className="field">
              <label htmlFor={fid.option("maxRunSeconds")}>Max run time (seconds)</label>
              <input
                id={fid.option("maxRunSeconds")}
                inputMode="numeric"
                value={options.maxRunSeconds}
                onChange={(e) => setOption("maxRunSeconds", e.target.value)}
                aria-invalid={errors[fid.option("maxRunSeconds")] ? true : undefined}
                aria-describedby={describedBy(fid.option("maxRunSeconds"))}
              />
              {fieldError(fid.option("maxRunSeconds"))}
            </div>
          </div>

          <label className="choice">
            <input
              type="checkbox"
              checked={options.generatePlaywright}
              onChange={(e) => setOption("generatePlaywright", e.target.checked)}
            />
            Generate a Playwright test
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={options.generatePlaywright && options.rerunGeneratedTest}
              disabled={!options.generatePlaywright}
              onChange={(e) => setOption("rerunGeneratedTest", e.target.checked)}
            />
            Rerun the generated test to confirm results
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={options.autoConfirmCriteria}
              onChange={(e) => setOption("autoConfirmCriteria", e.target.checked)}
            />
            Confirm criteria automatically (skip the review step)
          </label>
          <label className="choice">
            <input type="checkbox" checked={options.allowDestructiveActions} onChange={(e) => toggleDestructive(e.target.checked)} />
            Allow destructive actions (create, change or delete data, place orders, pay)
          </label>
          {options.allowDestructiveActions &&
            options.generatePlaywright &&
            (rerunOn ? (
              <p className="hint hint-warning">
                <Icon name="warning" /> Destructive actions will run twice: once while exploring and again in the rerun.
              </p>
            ) : (
              <p className="hint">
                <Icon name="info" /> Rerun is off: it repeats the whole test, so destructive actions would run a second time. You can turn it
                back on.
              </p>
            ))}
          {environment === "production" && options.allowDestructiveActions && (
            <div className="danger-panel">
              {host === null ? (
                <p>Enter the website URL first.</p>
              ) : (
                <>
                  <p>
                    This run can create, change or delete real data and place real orders or payments on <strong>{host}</strong>.
                  </p>
                  <div className="field">
                    <label htmlFor={fid.option("confirmProductionHost")}>
                      Type <strong>{host}</strong> to confirm
                    </label>
                    <input
                      id={fid.option("confirmProductionHost")}
                      autoComplete="off"
                      spellCheck={false}
                      value={options.confirmProductionHost}
                      onChange={(e) => setOption("confirmProductionHost", e.target.value)}
                      aria-invalid={errors[fid.option("confirmProductionHost")] ? true : undefined}
                      aria-describedby={describedBy(fid.option("confirmProductionHost"))}
                    />
                    {fieldError(fid.option("confirmProductionHost"))}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="field">
            <label htmlFor={fid.option("additionalAllowedHosts")}>Additional allowed hosts</label>
            <p id="hosts-hint" className="hint">
              Other host names the test may visit, separated by commas or spaces (e.g. a login provider).
            </p>
            <input
              id={fid.option("additionalAllowedHosts")}
              spellCheck={false}
              autoComplete="off"
              value={options.additionalAllowedHosts}
              onChange={(e) => setOption("additionalAllowedHosts", e.target.value)}
              aria-invalid={errors[fid.option("additionalAllowedHosts")] ? true : undefined}
              aria-describedby={describedBy(fid.option("additionalAllowedHosts"), "hosts-hint")}
            />
            {fieldError(fid.option("additionalAllowedHosts"))}
          </div>
        </FormSection>
      </div>

      <div className="composer-footer">
        <p className="composer-note">
          <Icon name="shield" /> Runs in a sandboxed browser.{" "}
          {options.autoConfirmCriteria ? "Its criteria are confirmed automatically." : "You confirm the criteria before it starts."}
        </p>
        <button type="submit" className="button button-primary button-lg" disabled={pending}>
          {pending ? "Starting…" : "Start test"}
          <Icon name="arrow" />
        </button>
      </div>
    </form>
  );
}

/**
 * An optional part of the form, collapsed to one line that says what is set. Kept in the DOM while
 * collapsed, so values survive and `focusFirstError` can open it to show an invalid field.
 */
function FormSection({
  icon,
  title,
  description,
  summary,
  children,
}: {
  icon: IconName;
  title: string;
  description: string;
  summary: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <details className="form-section">
      <summary>
        <span className="form-section-icon" aria-hidden="true">
          <Icon name={icon} />
        </span>
        <span className="form-section-text">
          <span id={titleId} className="form-section-title">
            {title}
          </span>
          <span className="form-section-desc">{description}</span>
        </span>
        <span className="form-section-summary">{summary}</span>
        <Icon name="chevron" className="form-section-chevron" />
      </summary>
      <div className="form-section-body" role="group" aria-labelledby={titleId}>
        {children}
      </div>
    </details>
  );
}

/** "40 steps · 5 min · rerun on": the advanced options at a glance (only the values that parse). */
function optionsSummary(o: Options): string {
  const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
  const steps = whole(o.maxExplorationSteps);
  const seconds = whole(o.maxRunSeconds);
  const parts = [
    steps !== null ? plural(steps, "step") : null,
    seconds !== null ? (seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`) : null,
    !o.generatePlaywright ? "no Playwright test" : o.rerunGeneratedTest ? "rerun on" : "no rerun",
    o.autoConfirmCriteria ? "auto-confirm" : null,
    o.allowDestructiveActions ? "destructive allowed" : null,
  ];
  return parts.filter(Boolean).join(" · ");
}
