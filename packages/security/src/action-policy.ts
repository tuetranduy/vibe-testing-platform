import type { BlockReason } from "@platform/contracts";

export type ActionDescriptor = {
  instruction: string;
  elementRole?: string | null;
  elementName?: string | null;
  elementText?: string | null;
};

export type ActionPolicy = { allowDestructive: boolean };

export type ActionDecision =
  | { allowed: true }
  | { allowed: false; reason: Extract<BlockReason, "DESTRUCTIVE_ACTION_NOT_AUTHORIZED">; matched: string };

/**
 * Terms that mark an action as destructive (plan, Task 4). Matched
 * case-insensitively on word boundaries against the instruction, the target
 * element's accessible name and its text; `-`/`_` count as spaces, so
 * "place-order" matches "place order".
 *
 * Word boundaries mean a base term does not match its inflections ("delete" ≠
 * "deletion"), so the inflected forms that describe the same action are listed
 * explicitly (Ruling R19), as are the ways of cancelling an order.
 *
 * `checkout` is conditional — see `CHECKOUT_SUBMIT_TERMS`.
 */
export const DESTRUCTIVE_TERMS = [
  "delete",
  "remove account",
  "close account",
  "deactivate",
  "pay",
  "pay now",
  "place order",
  "purchase",
  "buy now",
  "checkout",
  "transfer",
  "send money",
  "unsubscribe",
  "cancel subscription",
  "cancel plan",
  // Ruling R19: inflected forms and order cancellation.
  "deletes",
  "deleted",
  "deleting",
  "deletion",
  "deactivates",
  "deactivated",
  "deactivating",
  "deactivation",
  "purchases",
  "purchased",
  "purchasing",
  "unsubscribes",
  "unsubscribed",
  "unsubscribing",
  "cancel order",
  "cancel my order",
] as const;

export type DestructiveTerm = (typeof DESTRUCTIVE_TERMS)[number];

/**
 * Checkout rule ("`checkout` + submit" in the plan): navigating to checkout
 * ("open checkout page", "proceed to checkout", a plain "Checkout" button) is
 * how most carts are reached, so it stays allowed. It is denied only when
 * "checkout"/"check out" co-occurs with one of these submit-style words anywhere
 * across instruction, element name and element text — e.g. "Click the Checkout
 * submit button", "submit checkout", "Confirm checkout", or instruction "submit
 * the form" on a button named "Checkout". Committing actions inside checkout are
 * also caught by their own terms ("place order", "pay", "buy now", "purchase").
 */
export const CHECKOUT_SUBMIT_TERMS = ["submit", "confirm", "complete", "place", "finalize", "finalise"] as const;

const normalize = (text: string): string => text.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

const termRegex = (term: string): RegExp => new RegExp(`\\b${term.split(" ").join("\\s+")}\\b`);

// Longest first, so "pay now" is reported instead of "pay".
const UNCONDITIONAL: ReadonlyArray<{ term: DestructiveTerm; re: RegExp }> = DESTRUCTIVE_TERMS.filter(
  (t) => t !== "checkout",
)
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((term) => ({ term, re: termRegex(term) }));

const CHECKOUT_RE = /\bcheck ?out\b/;
const CHECKOUT_SUBMIT_RE = new RegExp(`\\b(?:${CHECKOUT_SUBMIT_TERMS.join("|")})\\b`);

const deny = (matched: string): ActionDecision => ({
  allowed: false,
  reason: "DESTRUCTIVE_ACTION_NOT_AUTHORIZED",
  matched,
});

export function assertActionAllowed(action: ActionDescriptor, policy: ActionPolicy): ActionDecision {
  if (policy.allowDestructive) return { allowed: true };

  // Each field is checked on its own so that multi-word terms cannot be
  // assembled across field boundaries (instruction "cancel" + element "Plan").
  const fields = [action.instruction, action.elementName, action.elementText]
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .map(normalize);

  for (const { term, re } of UNCONDITIONAL) {
    if (fields.some((f) => re.test(f))) return deny(term);
  }

  if (fields.some((f) => CHECKOUT_RE.test(f)) && fields.some((f) => CHECKOUT_SUBMIT_RE.test(f))) {
    return deny("checkout");
  }

  return { allowed: true };
}
