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
 * "place-order" matches "place order". Text is compared without diacritics
 * (and `ß` as `ss`), so terms are written that way: "loschen" matches "Löschen".
 *
 * Word boundaries mean a base term does not match its inflections ("delete" ≠
 * "deletion"), so the inflected forms that describe the same action are listed
 * explicitly (Ruling R19), as are the ways of cancelling an order.
 *
 * `checkout` is conditional — see `CHECKOUT_SUBMIT_TERMS`. A commit verb with an
 * order / payment noun ("Confirm payment", "Submit your order") is caught by
 * `COMMIT_VERBS` × `COMMIT_NOUNS` rather than by listing every pair.
 *
 * The list is a deterministic backstop, not a complete dictionary: a destructive
 * button it misses is still caught when the planner marks the step destructive.
 * It errs on the side of blocking (a blocked criterion is reported, a wrong
 * click is not undoable).
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
  // Audit 2026-09-29: erasing data, closing accounts, revoking access.
  "close my account",
  "terminate",
  "terminates",
  "terminated",
  "terminating",
  "termination",
  "erase",
  "erases",
  "erased",
  "erasing",
  "wipe",
  "wipes",
  "wiped",
  "wiping",
  "destroy",
  "destroys",
  "destroyed",
  "destroying",
  "purge",
  "purged",
  "purging",
  "revoke",
  "revoked",
  "revoking",
  "reset account",
  "factory reset",
  "remove user",
  "remove users",
  "remove member",
  "remove members",
  "trash",
  "empty trash",
  "\u{1F5D1}", // wastebasket icon used as a delete button's only text
  // Audit 2026-09-29: committing money or bookings.
  "order now",
  "book now",
  "reserve now",
  "donate",
  "donate now",
  "withdraw",
  "cancel booking",
  "cancel reservation",
  "cancel membership",
  "cancel account",
  "cancel my subscription",
  "end subscription",
  // Audit 2026-09-29: the same actions in German, French, Spanish, Italian, Portuguese and Dutch
  // (written without diacritics; see above).
  "loschen",
  "konto schliessen",
  "kundigen",
  "deaktivieren",
  "jetzt kaufen",
  "sofort kaufen",
  "bezahlen",
  "jetzt bezahlen",
  "bestellen",
  "zahlungspflichtig bestellen",
  "kostenpflichtig bestellen",
  "uberweisen",
  "supprimer",
  "effacer",
  "desactiver",
  "fermer le compte",
  "fermer mon compte",
  "resilier",
  "payer",
  "acheter maintenant",
  "commander",
  "passer commande",
  "passer la commande",
  "valider la commande",
  "valider ma commande",
  "confirmer la commande",
  "desabonner",
  "se desabonner",
  "desinscrire",
  "eliminar",
  "borrar",
  "desactivar",
  "cerrar cuenta",
  "cerrar mi cuenta",
  "pagar",
  "pagar ahora",
  "comprar ahora",
  "finalizar compra",
  "realizar pedido",
  "confirmar pedido",
  "tramitar pedido",
  "dar de baja",
  "darse de baja",
  "cancelar suscripcion",
  "transferir",
  "elimina",
  "eliminare",
  "cancella account",
  "disattiva",
  "paga",
  "paga ora",
  "acquista ora",
  "conferma ordine",
  "invia ordine",
  "annulla abbonamento",
  "disiscriviti",
  "excluir",
  "apagar",
  "desativar",
  "comprar agora",
  "finalizar pedido",
  "cancelar assinatura",
  "verwijderen",
  "betalen",
  "nu betalen",
  "nu kopen",
  "opzeggen",
  "deactiveren",
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

/**
 * Commit rule: one of these verbs directly followed (after an optional article or possessive) by one of
 * `COMMIT_NOUNS`, within one field — "Confirm payment", "Submit your order", "Complete booking", "Make a
 * donation". Not when the noun names something to look at: "Confirm the order confirmation page is shown",
 * "Complete the order form" (see `COMMIT_NOUN_VIEWS`).
 */
export const COMMIT_VERBS = [
  "submit",
  "confirm",
  "complete",
  "place",
  "finalize",
  "finalise",
  "authorize",
  "authorise",
  "make",
  "process",
  "send",
  "execute",
] as const;
export const COMMIT_NOUNS = ["order", "payment", "purchase", "transfer", "booking", "reservation", "donation", "transaction", "subscription"] as const;
const COMMIT_NOUN_VIEWS = ["confirmation", "summary", "details", "detail", "page", "number", "status", "history", "total", "id", "form", "list"];

/** Lowercase, diacritics removed (`ß` → `ss`), `-`/`_` as spaces, whitespace collapsed. */
const normalize = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Unicode-aware word boundaries (`\b` only knows ASCII letters, so it would split "löschen").
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRegex = (term: string): RegExp => new RegExp(`${B}${term.split(" ").map(escape).join("\\s+")}${E}`, "u");

// Longest first, so "pay now" is reported instead of "pay".
const UNCONDITIONAL: ReadonlyArray<{ term: DestructiveTerm; re: RegExp }> = DESTRUCTIVE_TERMS.filter(
  (t) => t !== "checkout",
)
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((term) => ({ term, re: termRegex(term) }));

const CHECKOUT_RE = new RegExp(`${B}check ?out${E}`, "u");
const CHECKOUT_SUBMIT_RE = new RegExp(`${B}(?:${CHECKOUT_SUBMIT_TERMS.join("|")})${E}`, "u");
const COMMIT_RE = new RegExp(
  `${B}(${COMMIT_VERBS.join("|")})\\s+(?:(?:the|your|my|our|a|an|this)\\s+)?(${COMMIT_NOUNS.join("|")})s?${E}` +
    `(?!\\s+(?:${COMMIT_NOUN_VIEWS.join("|")})${E})`,
  "u",
);

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

  for (const f of fields) {
    const commit = COMMIT_RE.exec(f);
    if (commit) return deny(`${commit[1]} ${commit[2]}`);
  }

  if (fields.some((f) => CHECKOUT_RE.test(f)) && fields.some((f) => CHECKOUT_SUBMIT_RE.test(f))) {
    return deny("checkout");
  }

  return { allowed: true };
}
