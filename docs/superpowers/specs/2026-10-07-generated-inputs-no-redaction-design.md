# Generated inputs, no secret redaction, full-HD browser (2026-10-07)

Three changes the user asked for on 2026-10-07, approved as designed in chat:

1. Tests run at 1920×1080, the page filling the screen. **Done** (`2c32818`): exploration sets every page's metrics
   over CDP (new headless Chromium keeps room for browser UI), the rerun sets viewport, screen and video size.
2. A value nobody provided (test data or a secret) is generated from the page instead of blocking the check.
3. The run's secrets are no longer redacted from anything the platform shows or stores.

## 2. Generated inputs

**What the user said:** if the user does not provide test data, explore the page and fill generated test data; do
not block the test. **Decided:** secrets too (a missing password is generated like test data).

### Where values come from, in order

1. The run's own test data and secrets (unchanged).
2. The requirement compiler's suggested test data (V1.3 `siteAnalysis.testData`: read from the site, else generated).
   Today these are applied only when criteria are auto-confirmed. They are now applied at the start of every
   execution, for each suggested key the run still lacks, so a manually confirmed run gets them too. Nothing the
   user entered is replaced.
3. At fill time, the executor generates any value still missing (below).

### Fill-time generation (executor)

A `fill` / `search` / `select` step whose `inputRef` (`testData` or `secret`) has no value no longer stops with
`BLOCKED_BY_POLICY` / `MISSING_*`. The executor:

1. locates the field as for any fill (the existing `fill` path: open its form, never a button or link);
2. reads the field from the page, deterministically: tag, `type`, `name`, `autocomplete`, `placeholder`, label text,
   `maxlength` / `min` / `max` / `pattern`, and a select's option labels and values (capped);
3. asks the model once (`generate_input`, JSON: `{ "value": string }`) for a realistic, obviously fictional value for
   that field, given the step description, the key, whether it is a secret, and the field facts. A select's value
   must be one of its options (else the first non-empty option is used); a value longer than the field's
   `maxlength` is cut; a password follows a strong default shape when the model's answer is empty;
4. keeps the value for the run: later fills of the same key (any scenario) reuse it, so a sign-up and its login agree;
5. fills it, and records the value on the fill's exploration step (`generatedValue`).

If the model call fails or answers nothing usable, a deterministic fallback is used (`generateTestDataValue` for
test data; a random strong password for a secret), so generation never blocks.

### Blocking

`applyBlocking` no longer blocks for a missing secret or test data key (preconditions or step `inputRef`s).
`DESTRUCTIVE_ACTION_NOT_AUTHORIZED` is unchanged. `MISSING_SECRET` / `MISSING_TEST_DATA` stay in the contract (old
runs) and one case remains: a `text_matches` check whose `testDataKey` has no provided, suggested or generated value
(no step filled it), which the verifier still blocks: comparing page text with an invented value would only produce
a false FAIL.

### Downstream

- **Verification:** `resolveTestDataValues` reads the run's test data plus the values generated during exploration
  (from the steps' `generatedValue`).
- **Generated Playwright test:** a generated value is written into `run-data.json` like test data, for a secret ref
  too (it is then not read from `SECRET_*`), so a rerun of the saved test needs nothing typed again for it.
- **Report:** each exploration step with a `generatedValue` shows it; the report lists the generated inputs (key,
  secret or test data, value, step) so a result caused by an invented password is explained (a login the site
  refuses ends `BLOCKED / LOGIN_FAILED`, the verifier's existing reason, as found in the CI E2E run).
- **Storage:** `exploration_steps.generated_value` (text, nullable; migration). No new table.

### Prompts and evals

The planner and compiler prompts already reference names for values that were not provided; no prompt change. The
planner eval's expectations that a missing key blocks (`expect.blocked` with `MISSING_*`) become "not blocked". A
new executor unit test covers generation, reuse, a select's options and the fallback.

## 3. No redaction of run secrets

**Decided:** run secrets only. The platform's own keys stay protected.

**Removed:**
- value-based redaction of the run's secrets: `createRunRedactor` keeps key-based redaction only (no secret values);
  `createValueRedactor`, the trace scrubber and the fill error masking go;
- fingerprint-based redaction in the API (requirement text, edited suggestions and criteria: the KI-022 fix) and in
  the survey; secrets are no longer fingerprinted at creation (the column stays, nullable);
- `SECRET_BEARING` artifacts: every new artifact is `STANDARD`; the API serves an old `SECRET_BEARING` artifact
  without `reveal=true` and writes no `artifact.reveal` audit row; the web app drops the Reveal step;
- the "redacted from all output" wording in the new-test form.

**Kept:** key-based redaction (`authorization`, `cookie`, `token`, `password`-named fields) in logs and stored
payloads; the logger's protection of provider API keys and API tokens; encryption of secrets at rest and their purge
when a run ends (a rerun still asks for the secrets that were typed); a password written in the requirement still
becomes the run's secret.

**Consequence:** a secret's value can appear in screenshots, traces, events, step errors, reports and model prompts
(when a page shows it).

## Testing

Unit tests change with each removed guarantee (assertions that a value is `[REDACTED]` become assertions that it is
kept). The CI E2E specs that check secret hygiene and `MISSING_SECRET` blocking are updated to the new behaviour. The
full unit suite, typecheck and the CI E2E suite pass before merge.
