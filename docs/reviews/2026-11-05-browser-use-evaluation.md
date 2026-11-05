# Evaluation: browser-use for the explorer's browser actions

Date: November 5, 2026. Subject: [browser-use/browser-use](https://github.com/browser-use/browser-use) at `main`
(version 0.13.14, MIT). Question: can it, or its techniques, improve how the model acts in the browser here
(locating a planned step's element, extracting facts, judging unclear criteria)?

Read: the README, `pyproject.toml`, the docs' parameter reference, `browser_use/agent/service.py`,
`agent/judge.py`, `dom/views.py` and `tools/service.py`. Not read: the DOM serializer, the system prompts and the
browser's click handlers, so details that depend on them are marked unverified.

## Short answer

Not as a library. Adopt two or three of its techniques in our own executor.

## Why not as a library

- **Python only.** The open-source agent needs Python 3.11+ and drives Chrome over raw CDP (`cdp-use`), not
  Playwright. Its TypeScript offering is the hosted Cloud SDK (`browser-use-sdk`), which runs the agent in their
  cloud: target pages, credentials and secrets would leave our egress proxy and navigation guard.
- **A different model of testing.** browser-use is an autonomous agent: each step the model picks up to 5 actions by
  element index, from a task in plain words, until it calls `done`. Here the planner fixes the steps, the executor
  carries out each one, every value a verdict uses must be read back from the DOM (D2), and the golden path compiles to
  a Playwright test that reruns with no model. An agent loop gives none of that: no plan to check against, no
  replayable locator per step (its `load_and_rerun` replays by element hash and stops at the first mismatch), and its
  own success flag is self-reported (its docs say to verify important outcomes independently).
- **It does not cover our recent failures.** It has no wait for a route change or a quiet network after a click (fixed
  waits and a 3 s / 5 s empty-page recheck only, as far as read; KI-058 here), and nothing for a toast that disappears
  during a slow model call (KI-057, KI-059 here).
- **Its judge** runs once after the whole run, from screenshots and the action trajectory, not the DOM. Ours judges each
  unclear criterion where its subject is on screen, with the page's structure and text.

## Techniques worth adopting

Ranked by expected effect on the failure modes seen in runs:

1. **A deterministic lookup before the model** (browser-use's `find_elements` / `search_page` tools query the page
   without a model). When a planned step names its control ("Click the 'New User' button", "Click Checkout"), look for
   exactly one visible element with that role and accessible name, or that exact text, and use it; call `observe` only
   when that fails. This targets the misses where the model returns nothing although the control is on screen (KI-050,
   KI-048's "Login" button) and wrong picks, it removes a model call per such step (seconds each, which is what lets a
   toast disappear), and the result is still a recorded, replayable locator. Cost: a matcher in `executor.ts` `locate`
   with the same policy checks; unit tests with real Chromium.
2. **An indexed element list for the recovery prompt.** browser-use shows the model numbered interactive elements
   (role, accessible name, visibility, position) and has it answer with an index. Our "Find the link or button that
   leads to where you can: …" recovery is free text, and models read it literally (KI-048, KI-050). Giving that one
   prompt the survey inventory's visible links and buttons as a numbered list, and asking for a number, constrains the
   answer to something that exists.
3. **A fallback model on provider errors.** `fallback_llm` switches to a second model after 429 / 401 / 402 / 5xx
   retries run out. Today a Gemini "503 high demand" (seen during this day's evals) fails the call after our retries;
   an optional fallback in `LlmClient` (same provider's smaller model, or the tenant's other configured provider) would
   keep the run going.

Smaller ideas, already covered or of low value here: re-checking a typed value after `input` (we do since KI-044);
"element index not available, page may have changed" (our transient-error retry, KI-051); loop detection and plan
nudges (our plans are fixed and bounded by `maxExplorationSteps`).

## Recommendation

Keep Stagehand. Implement (1) first and measure it on the planner and live runs (the demoqa and frontends-demo flows):
it is the one change likely to cut both misses and model time. (2) and (3) are independent follow-ups.
