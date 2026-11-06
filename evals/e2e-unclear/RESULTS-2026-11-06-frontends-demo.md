# Unclear-requirement baseline: frontends-demo.vercel.app (2026-11-06)

Corpus: [`frontends-demo.json`](frontends-demo.json) (12 requirements). Engine: local API + worker on `deepseek-flash`
(reasoning default). Every run was auto-confirmed, with default options (300 s, 40 steps, live-site analysis on).
Runs were created 2026-11-06 at about 05:30 UTC, two at a time.

## Headline numbers

| Metric | Value |
|---|---|
| Runs errored | **0 / 12** (analysis and planning never failed) |
| Run verdicts | PASSED 2 · BLOCKED 1 · INCONCLUSIVE 9 · FAILED 0 |
| Criteria | 23 in all: PASS 7 · BLOCKED 1 · INCONCLUSIVE 15 · FAIL 0 → **30% decided** |
| INCONCLUSIVE reasons | FACT_NOT_OBSERVED 10 · AMBIGUOUS_CRITERION 2 · UNVERIFIED_EVIDENCE 2 · AI_JUDGED_ONLY 1 |
| Exploration stopped at one failed planned step | **7 / 12** (5 at step PS-2, 2 at PS-3) |
| Cost / time | $0.20 in all (≈ $0.017 per run) · 70–220 s per run |

| Case | Clarity | Verdict | Criteria (status) | What stopped it |
|---|---|---|---|---|
| FD-01 | specific | PASSED | 1 PASS | — |
| FD-02 | specific | INCONCLUSIVE | 1 INC (AI_JUDGED_ONLY) | search submit (R1) |
| FD-03 | feature | INCONCLUSIVE | 1 INC | search submit (R1) |
| FD-04 | feature | INCONCLUSIVE | 2 INC | planned a product that is not on the home page (R3) |
| FD-05 | feature | INCONCLUSIVE | 1 PASS · 2 INC | "Add to wishlist" click timed out at 60 s (R2) |
| FD-06 | feature | BLOCKED | 1 BLOCKED (LOGIN_FAILED) | the verifier blocks a login that is *meant* to fail (R4) |
| FD-07 | vague | INCONCLUSIVE | 2 INC (one AMBIGUOUS) | product card click timed out at 60 s (R2) |
| FD-08 | vague | INCONCLUSIVE | 2 PASS · 1 INC (UNVERIFIED) | checkpoint read on the wrong page (R5) |
| FD-09 | misnamed | INCONCLUSIVE | 3 INC | "Grills" link is in a closed menu; one-hop recovery fails (R3) |
| FD-10 | misnamed | INCONCLUSIVE | 2 INC (one AMBIGUOUS) | search submit (R1) |
| FD-11 | site-wide | PASSED | 1 PASS (semantic) | — but the only criterion was "the website loads" (R7) |
| FD-12 | feature | INCONCLUSIVE | 2 PASS · 1 INC (UNVERIFIED) | sign-up result not DOM-verified (R5) |

Run ids are in `results.json` in the session scratchpad and in `test_runs` (target `frontends-demo.vercel.app`,
created 2026-11-06 05:30–05:50 UTC).

## Root causes, by runs affected

**R1: A search with no submit button is never submitted (3 runs: FD-02, FD-03, FD-10).**
The header search has no button; it submits on Enter. The executor fills the field, then asks for "the button that
submits this search". The model answers with the field itself, and `act` fails the attempt ("The search's submit
control resolved to the search field itself", `exploration/executor.ts:791`). Nothing ever presses Enter. Both
attempts fail the same way, so the scenario stops.
*Fix:* when the submit control resolves to the filled field, or none is found, press Enter in that field and settle
(record it as the step's `act`). The generated test needs the same (`press("Enter")`). This is deterministic, small,
and decides 3/12 runs.

**R2: A click that times out burns 60 s and is never retried another way (2 runs: FD-05, FD-07).**
`locator.click: Timeout 60000ms exceeded` on the first product card's "Add to wishlist" and on "Open a product detail
page". The element was found but couldn't be clicked: it was probably covered (by a slider control or an overlay) or
outside a scroll container. Two attempts cost 120 s of the 300 s budget.
*Fix:* a short action timeout (about 10 s). On timeout: scroll it into view → check what covers the point
(`elementFromPoint`) and close an overlay if there is one → try the next matching element → for a link, navigate to
its `href`.

**R3: The target is not on the current page, and one-hop recovery can't reach it (2 runs: FD-04, FD-09).**
- FD-09: "Click the 'Grills' link in the category navigation". The link sits in a closed menu ("Show side menu"), so it
  isn't found, and "find the way there" finds nothing either. The analysis had **already read
  `/Summer-BBQ/Grills/`**, yet the planner planned a click instead of a navigate.
- FD-04: the planner picked "EBONY 2 Sparkle Cave", a product from a page the analysis read (Product Slider), but
  opened it from the home page, where it isn't.
*Fix:* (a) planner rule: when a page read is the step's destination, `navigate` to its URL; (b) executor fallback:
when the target and the way there both fail, navigate to a page from the site read whose link text matches the
target, then look again; (c) open menus/disclosures ("Show side menu", hamburger) as one more hop. This is plan items
2.3 + 3.2.

**R4: A login meant to fail is reported BLOCKED / LOGIN_FAILED (1 run: FD-06).**
"Signing in with a wrong password should show an error": the checkpoint read `errorMessageVisible = true` from the
DOM, which is a PASS. Verifier rule 3 still blocks because the URL didn't change after the `login` step. This is
related to KI-065.
*Fix:* rule 3 must not apply when the criterion is about the login being rejected (the expected outcome is an error
or message after a failed login). The planner already knows this: the step uses a wrong password.

**R5: Evidence left unverified (2 runs: FD-08, FD-12).**
- FD-08: the variant checkpoint recorded the URL `/Products/` (the listing), not the product page. The fact read as
  false, while the judge described the variant options, so the facts contradicted each other.
- FD-12: the sign-up result was right (back home, sign-in prompt gone), but an off-path observe failed, so the
  checkpoint was left UNVERIFIED_EVIDENCE.
*Next:* look at both runs' traces. The likely cause is a checkpoint read before the route change (a cousin of KI-058).

**R6: The analysis reads pages unrelated to a vague requirement (seen in FD-02, FD-03).**
"pepper" read `/Summer-Trends/Fashion/`, and "Test the search" read a CMS testing page. It did no harm here (search is
in the header), but it confirms finding A1 in the plan (link ranking by word overlap).

**R7: A vague requirement still yields vague or trivial criteria (FD-07, FD-10, FD-11).**
"look good" and "relevant" became `semantic` + ambiguous criteria, which ended INCONCLUSIVE. "Test this website" became a single
criterion, "the website loads", which PASSED, so the run looks green while testing nothing. This confirms A3/A5.

## What works already
- **No errored runs.** Analysis and planning handled every unclear requirement.
- **The analysis already infers several criteria** from vague text (FD-04: 2, FD-05: 3, FD-08: 3, FD-12: 3), and the
  plans were mostly sensible paths.
- So the main bottleneck is **exploration robustness**, not understanding the requirement.

## Effect on the improvement plan
Bring forward ahead of the plan's phase 1. Each item is small and deterministic:
1. R1: Enter fallback for search (3/12 runs).
2. R4: the verifier must not block a login meant to fail (1/12).
3. R2: shorter click timeout + an alternate way to click (2/12).
4. R3: navigate to known page URLs (planner rule + executor fallback) (2/12).

If each fix works as described, 8 of the 9 INCONCLUSIVE/BLOCKED runs get past the step that stopped them. Then re-run
this corpus and compare with the table above.

---

## After R1–R4 (2026-11-06, same corpus, same model)

All 12 cases were rerun at about 06:45 UTC. FD-02, FD-03, FD-05 and FD-10 were rerun again at 07:00 UTC, after R1 was
extended to plans that split a search into a fill + submit (the values below are from that second run).

| Metric | Before | After |
|---|---|---|
| Runs errored | 0 / 12 | 0 / 12 |
| Run verdicts | PASSED 2 · BLOCKED 1 · INCONCLUSIVE 9 | **PASSED 4** · FAILED 1 · BLOCKED 1 · INCONCLUSIVE 6 |
| Criteria decided (PASS + FAIL) | 7 / 23 (30%) | **14 / 24 (58%)**: PASS 13 · FAIL 1 · BLOCKED 1 · INCONCLUSIVE 9 |
| Runs stopped at the step R1–R4 targeted | 8 | **0** |
| Cost | ≈ $0.017 per run | ≈ $0.03 per run (more of each flow runs) |

| Case | Before | After | What changed |
|---|---|---|---|
| FD-01 | PASSED | PASSED | — |
| FD-02 | INC (search never submitted) | INC (UNVERIFIED_EVIDENCE) | R1: Enter pressed, `/search?search=pepper` reached; the count stayed model-extracted (KI-071) |
| FD-03 | INC (search never submitted) | INC (UNVERIFIED_EVIDENCE) | R1: results page reached; the generated term "Lemonade" found nothing (KI-071) |
| FD-04 | INC (product not on page) | **PASSED** (2/2) | R3 |
| FD-05 | INC (60 s click timeout ×2) | FAILED (1 PASS, 1 FAIL, 1 INC) | R2: the click works and the flow reaches the wishlist; the FAIL is made-up wording (KI-070) |
| FD-06 | BLOCKED (LOGIN_FAILED) | **PASSED** | R4 |
| FD-07 | INC (60 s click timeout ×2) | INC | the product page opened, but the site answered with an Error 500 page |
| FD-08 | INC (1 of 3) | INC (3 PASS, 1 INC) | a variant label read as null |
| FD-09 | INC (Grills link in closed menu) | **PASSED** (2/2) | R3 |
| FD-10 | INC (search never submitted) | INC (2 PASS, 1 INC) | R1: results read and judged relevant; one `visible` fact recorded as a list (KI-071) |
| FD-11 | PASSED (trivial) | INC (AMBIGUOUS) | still a single "site loads" criterion: plan item 1.5 |
| FD-12 | INC (UNVERIFIED) | BLOCKED (destructive) | the planner marked the sign-up submit destructive this time; correct under the policy |

Next blockers, in order: KI-070 (made-up wording → false FAIL), KI-071 (unverified facts on a product grid), and the
plan's analysis items for vague and site-wide requirements (FD-07 "look good", FD-11 "test this website").

## After KI-070 (2026-11-06, about 07:30 UTC: FD-03, FD-05, FD-06)

| Case | Before KI-070 | After | Note |
|---|---|---|---|
| FD-05 | FAILED on "Wishlist is empty" (made-up wording) | FAILED, on another cause | no text check left; the add click went to the header's wishlist link (KI-072) |
| FD-06 | PASSED | PASSED | the error check stays `visible` |
| FD-03 | INCONCLUSIVE | INCONCLUSIVE | the results list is still not DOM-verified for the made-up term "Lemonade" (KI-071) |

Requirement-compiler eval: 35/35, including the new cases 34–35, with no rewrite needed.

## After KI-072 (2026-11-06, about 08:15 UTC: all 12 cases)

| Metric | Baseline | After R1–R4 | After R1–R4 + KI-070 + KI-072 |
|---|---|---|---|
| Run verdicts | PASSED 2 · BLOCKED 1 · INC 9 | PASSED 4 · FAILED 1 · BLOCKED 1 · INC 6 | **PASSED 5** · FAILED 0 · BLOCKED 0 · INC 7 |
| Criteria decided | 7 / 23 (30%) | 14 / 24 (58%) | **16 / 24 (67%)** |
| False FAILs (platform error) | 0 | 1 (FD-05, made-up wording) | **0** |
| Runs errored | 0 | 0 | 0 |

Variance: each run compiles its own criteria and plan, so verdicts move by one or two runs between batches. An
intermediate batch (the first KI-072 version) had 6 PASSED and 2 FAILED. Both FAILs were checked by hand: FD-05 was a
platform error (the KI-072 way-there path, since fixed), and FD-07 found the product page's main area blank
(site-side, as in the earlier Error 500).

FD-05 now: the add click hits a product card's "Add to wishlist" button. As a guest, that opens a sign-in dialog, so
the wishlist stays empty and the run ends INCONCLUSIVE (KI-073).

What is left, by cause:
- **Evidence (KI-071):** counts and lists on product grids are read by the model, not verified in the DOM (FD-02,
  FD-03, FD-04); a cart checkpoint read before the cart page opened (FD-08, FD-09).
- **Rerun disagreement:** FD-12's generated test looked for the exact greeting "Hello, Alex!".
- **Needs a login (KI-073):** FD-05.

## After KI-071 (2026-11-06, about 11:00 UTC: all 12 cases): final

| Metric | Baseline | After R1–R4 | + KI-070, KI-072 | **+ KI-071 (final)** |
|---|---|---|---|---|
| Run verdicts | PASSED 2 · BLOCKED 1 · INC 9 | PASSED 4 · FAILED 1 · BLOCKED 1 · INC 6 | PASSED 5 · INC 7 | **PASSED 8** · BLOCKED 1 · INC 3 |
| Criteria PASS | 7 / 23 (30%) | 13 / 24 | 16 / 24 | **17 / 22 (77%)** |
| UNVERIFIED_EVIDENCE criteria | 2 | 4 | 4 | **1** |
| False FAILs | 0 | 1 | 0 | **0** |
| Runs errored | 0 | 0 | 0 | 0 |

Left:
- FD-04: the rerun disagreed on the cart count (DISCOVERY_RERUN_DISAGREE).
- FD-05: the wishlist needs a sign-in (KI-073).
- FD-08: a "no error message" check stayed unverified.
- FD-12: the sign-up submit is BLOCKED, correctly, by the destructive-action policy.

The site's own intermittent Error 500 is KI-074.

