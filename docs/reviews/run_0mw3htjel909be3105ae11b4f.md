# Follow-up: AC-2 notification evidence

Run: `run_0mw3htjel909be3105ae11b4f`, November 5, 2026. Times below are Asia/Ho_Chi_Minh.

This run reached Travel Luggage Set, added that product and verified cart count 1. AC-2 remained
INCONCLUSIVE / UNVERIFIED_EVIDENCE because the popup was read by the model without a DOM reading.
The original stored result is unchanged.

## Cause

The earlier worker fix was deployed, but its early notification capture required quoted text in the generated
fact description. Here the compiler paraphrased the fact as “Whether a popup stating the item was added to the
cart is visible after clicking Add to cart”, so capture was skipped. The original criterion still contained the
literal requirement: `popup Item added to cart should be displayed`.

At 19:00:30.098 Add to cart began. The subsequent model extraction took about 3.3 seconds, and popup lookup
began at 19:00:33.663. That lookup failed after another 3.5 seconds. The model's true value alone could not
satisfy the platform's DOM evidence requirement. AC-1 and AC-3 passed.

## Correction

- Read notification text from the confirmed criterion's original `sourceText`, including unquoted wording.
  Prefer that literal over the generated fact description.
- Support both compiler representations: boolean visibility and string text matching. Read each directly
  from the DOM with the matching replay mode.
- Wait up to one second for an asynchronously rendered notification. Require a unique, visible exact-text
  match inside an alert, status, dialog or live region. Ordinary text, hidden text and ambiguous matches remain
  insufficient evidence.
- Capture the notification, replayable locator and screenshot immediately after the preceding action when
  only wait steps separate it from the checkpoint. Keep that evidence through those waits and checkpoint
  retries. Other model extraction can then run without losing a short-lived popup.

The first live diagnostic retry, `run_0mw3i642ca92e4fd117a13b46`, exposed the need for the final change:
the planner inserted a model-backed wait before the checkpoint, and its polling outlasted the popup. A local
Chromium regression now includes that wait, a paraphrased fact description, asynchronous popup rendering,
an 800 ms popup lifetime and slow model calls. Both compiler representations verify all three criteria and
compile all three assertions. A second diagnostic retry, `run_0mw3ie2ya9361187108a07d10`, exposed the text
representation and a separate normalization issue: an extra Add to cart button visibility criterion was
proposed. Subsequent validation reviewed the same three assertions as the user's confirmed run.

## Validation

- Engine suite: 753 tests pass across 39 files; workspace typecheck and `git diff --check` pass.
- The local Compose worker was rebuilt and restarted with its existing configuration. Its runtime source
  checksums match the checkout.
- Live validation remains blocked by the target site. After the final deployment,
  `run_0mw3iinmx2a6120b11441d49b` received a **403 Forbidden** page at the Travel Luggage Set URL; its
  product checkpoint screenshot confirms this. It never reached Add to cart. A final retry,
  `run_0mw3ikstj83d1c2110eccba4f`, received HTTP 403 on the home page (confirmed in the browser's network
  trace) and stopped before finding the product link. Neither reached notification
  capture, and neither is evidence of a passing live flow. No historical result was changed to PASS.
