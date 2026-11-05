# Investigation: Travel Luggage Set run

Run: `run_0mw3gsjgke3a1923c465bb1e1`, November 5, 2026. Times below are Asia/Ho_Chi_Minh.

The requirement is clear. The recorded execution went off course: it ultimately added Gaming Headset.
Its INCONCLUSIVE result follows the evidence that was recorded; changing that result to PASS would hide the
execution defects. The original stored run has not been edited.

## Recorded sequence

| Time | Recorded behavior |
|---|---|
| 18:31:44.310 | Click Travel Luggage Set reported SUCCESS in 22 ms; URL remained the home page |
| 18:31:44–51 | Product heading extraction returned null; heading lookup found no matching element; checkpoint screenshot still showed the product list |
| 18:31:52–55 | Recovery for the missing Add to cart button selected the Gaming Headset link |
| 18:31:55.332 | Browser reached `/products/gaming_headset` |
| 18:31:58.545 | Clicked Add to cart for Gaming Headset; URL became `?cart=gaming_headset%3A1` |
| 18:31:58.941 | Recorded video frame shows “Item added to cart” with “Gaming Headset” beneath it |
| 18:31:58.825–18:32:00.863 | Model extracted popup visibility as true |
| 18:32:00.866 onward | Popup locator lookup took 7.284 s and failed with “selector must match exactly one element (matched 0)” |
| 18:32:16.899 | Final checkpoint recorded cart count 1, after the popup had disappeared |

## Why each check ended this way

| Check | Result | Evidence |
|---|---|---|
| Travel Luggage Set page displayed | INCONCLUSIVE / FACT_NOT_OBSERVED | Product heading was null; its checkpoint was on the home page |
| Item added to cart popup displayed | INCONCLUSIVE / UNVERIFIED_EVIDENCE | Model read true, but no deterministic DOM reading survived the later lookup |
| Cart count equals 1 | PASS / EXPLORATION_ONLY | DOM read 1, after adding Gaming Headset |

`rerunGeneratedTest` was false in the request. The generated test covers only AC-3. Manually rerunning that saved
test cannot verify AC-1 or AC-2; a new discovery run is needed.

## Fixes in the checkout

1. **Observed clicks use Playwright actionability checks.** The adapter previously synthesized a coordinate click
   through Stagehand and accepted its success response without checking that the intended element received it.
   A local fixture with a fixed banner reproduced SUCCESS while staying on the original page. The corrected
   adapter waits for a stable, unobstructed target and lets Playwright retry scrolling. It retains navigation-policy
   reporting and makes no model call to replay the observed click. The original trace does not identify the exact
   intercepted point; its visible cookie notice is consistent with this reproduced failure mode.
2. **Explicitly named notifications are captured before model latency.** For a confirmed visibility check with a
   quoted literal, the recorder can read a unique visible match inside an alert/status/dialog/live region directly
   from the DOM. It records its replayable locator and takes the checkpoint screenshot before other extraction
   calls. Hidden, ambiguous and unrelated ordinary text do not qualify. Absence still falls back to the existing
   discovery path; it is never treated as proof of failure or success.

The full local luggage flow passes all three checks with deterministic DOM evidence even when a model read takes
1.2 s and the popup disappears after 800 ms. All three checks compile into the saved test.

## Verification and rollout

- Fixed-banner regression: reproduced before the fix, passes after it.
- Engine and adapter suites pass, including notification ambiguity/visibility checks and the complete luggage flow.
- Integration suite: 36 passing tests, including the real Stagehand extension and sandbox.
- Workspace typecheck passes.
- At the end of this initial investigation, changes were local and the Compose worker had not been rebuilt.
  The [follow-up investigation](run_0mw3htjel909be3105ae11b4f.md) records additional capture gaps, deployment
  to the local worker and the subsequent live validation attempts.

Recovery's ability to select an unrelated business object remains a separate hardening opportunity. These fixes
address the missed click and lost notification; they do not claim that every possible recovery preserves the
selected product. Keep the product-page criterion critical so a cart-count-only result cannot certify the flow.
