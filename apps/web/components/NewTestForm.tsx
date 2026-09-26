"use client";

import {
  CreateTestRunRequestSchema,
  DataKeySchema,
  HttpUrlSchema,
  SecretNameSchema,
  type CreateTestRunRequestInput,
} from "@platform/contracts";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { ApiRequestError, createRun } from "../lib/api";
import { Icon } from "./Icon";

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
      allowDestructiveActions: environment === "staging" && options.allowDestructiveActions,
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

export function NewTestForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [targetUrl, setTargetUrl] = useState("");
  const [requirement, setRequirement] = useState("");
  const [environment, setEnvironment] = useState<"staging" | "production">("staging");
  const [data, setData] = useState<DataRow[]>([]);
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const [pending, setPending] = useState(false);
  /** Secret values were wiped after a failed submit and must be typed again. */
  const [secretsCleared, setSecretsCleared] = useState(false);

  /** Focuses the first invalid field in document order (opening Advanced options if it's in there). */
  const focusFirstError = (errs: Errors) => {
    const fields = Array.from(formRef.current?.elements ?? []) as HTMLElement[];
    const first = fields.find((el) => el.id && el.id in errs);
    const details = first?.closest("details");
    if (details) details.open = true;
    first?.focus();
  };

  const setOption = <K extends keyof Options>(name: K, value: Options[K]) => setOptions((o) => ({ ...o, [name]: value }));

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
      const created = await createRun(body, crypto.randomUUID());
      router.push(`/runs/${encodeURIComponent(created.runId)}`);
    } catch (err) {
      setPending(false);
      setSecretsCleared(secrets.some((r) => r.value));
      if (!(err instanceof ApiRequestError)) {
        setBanner({ title: "The test couldn't be started", message: "Something went wrong. Please try again." });
        return;
      }
      if (err.code === "TARGET_NOT_ALLOWED") {
        const next = { [fid.url]: err.message };
        setErrors(next);
        focusFirstError(next);
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

  return (
    <form ref={formRef} className="form" noValidate onSubmit={onSubmit} aria-busy={pending}>
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
        <p id="targetUrl-hint" className="hint">
          The page the test starts from.
        </p>
        <input
          id={fid.url}
          name="targetUrl"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://shop.example.com"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          aria-invalid={errors[fid.url] ? true : undefined}
          aria-describedby={describedBy(fid.url, "targetUrl-hint")}
        />
        {fieldError(fid.url)}
      </div>

      <div className="field">
        <label htmlFor={fid.requirement}>Requirement</label>
        <p id="requirement-hint" className="hint">
          Describe in plain language what should work. You&apos;ll review the acceptance criteria before the test starts.
        </p>
        <textarea
          id={fid.requirement}
          name="requirement"
          rows={5}
          placeholder="Verify that a user can search for an iPhone, add it to the cart, and see it in the cart."
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          aria-invalid={errors[fid.requirement] ? true : undefined}
          aria-describedby={describedBy(fid.requirement, "requirement-hint")}
        />
        {fieldError(fid.requirement)}
      </div>

      <fieldset className="field">
        <legend>Environment</legend>
        <div className="choice-row">
          {(["staging", "production"] as const).map((env) => (
            <label key={env} className="choice">
              <input
                type="radio"
                name="environment"
                value={env}
                checked={environment === env}
                onChange={() => setEnvironment(env)}
              />
              {env === "staging" ? "Staging" : "Production"}
            </label>
          ))}
        </div>
        {environment === "production" && (
          <p className="hint">
            <Icon name="info" /> Destructive actions are always blocked in production.
          </p>
        )}
      </fieldset>

      <fieldset className="field rows">
        <legend>Test data (optional)</legend>
        <p className="hint">Values the test may type, such as a search term. Empty rows are ignored.</p>
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
          Add test data
        </button>
      </fieldset>

      <fieldset className="field rows">
        <legend>Secrets (optional)</legend>
        <p className="hint">
          <Icon name="lock" /> Credentials such as a password. Encrypted, filled in by the platform (never by the AI), redacted from
          all output, and deleted when the run ends.
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
                autoComplete="off"
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
          Add secret
        </button>
      </fieldset>

      <details className="advanced">
        <summary>Advanced options</summary>
        <div className="advanced-body">
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
            <input
              type="checkbox"
              checked={environment === "staging" && options.allowDestructiveActions}
              disabled={environment === "production"}
              onChange={(e) => setOption("allowDestructiveActions", e.target.checked)}
            />
            Allow destructive actions (e.g. placing an order){environment === "production" ? " — not in production" : ""}
          </label>

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
        </div>
      </details>

      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending ? "Starting…" : "Start test"}
        </button>
      </div>
    </form>
  );
}
