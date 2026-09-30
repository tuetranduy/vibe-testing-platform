/**
 * Synthetic test data (V1.3): a plausible value for a test data key, from its name (and, optionally, its
 * description). Deterministic for a given seed, so the engine's fallback suggestions are reproducible; the
 * web form passes a fresh seed so each "Generate" gives a new value. Pure — no Node or browser API — so the
 * engine and the web app share it.
 *
 * Every value is fictional and safe to submit: example.com addresses (reserved, RFC 2606), 555-01xx phone
 * numbers (reserved for fiction), payment processors' public test card numbers. Keys that name a credential
 * (password, token, API key, …) get nothing: those are secrets, entered as such, never generated.
 */

export type GeneratedTestDataValue = string | number | boolean;

/** Credential-like keys: they belong in secrets, so no value is generated for them. */
const CREDENTIAL = /\b(pass(word|wd|code|phrase)?|pin|secret|token|api ?key|otp|cvv|cvc|credential)s?\b/;

/** FNV-1a (32-bit) — a tiny, dependency-free hash for the seed → token mapping. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Words of a key: `shippingZipCode` / `shipping_zip_code` → "shipping zip code". */
export function keyWords(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a key reads as a credential (a secret, not test data). */
export const isCredentialKey = (key: string): boolean => CREDENTIAL.test(keyWords(key));

const has = (words: string, ...terms: string[]) => terms.some((t) => new RegExp(`\\b${t}\\b`).test(words));

/**
 * A synthetic value for `key`, or null for a credential-like key. `hint` (e.g. the criterion's description of
 * the value) is read too, after the key. `seed` fixes the random part (default: the key alone).
 */
export function generateTestDataValue(key: string, opts: { hint?: string; seed?: string } = {}): GeneratedTestDataValue | null {
  const words = keyWords(key);
  if (isCredentialKey(key)) return null;
  const token = fnv1a(`${opts.seed ?? ""}:${key}`).toString(36).padStart(7, "0").slice(0, 6);
  const n = fnv1a(`${opts.seed ?? ""}#${key}`);
  const text = `${words} ${(opts.hint ?? "").toLowerCase()}`;

  // Order matters: the most specific terms first ("email" before "name" in "userEmail"; "zip" before "code").
  if (has(words, "email", "e ?mail", "mail")) return `qa.${token}@example.com`;
  if (has(words, "expiry", "expiration", "exp")) return "12/34";
  if (has(words, "card number", "card", "cc number", "credit card")) return "4242424242424242";
  if (has(words, "first name", "firstname", "given name", "forename")) return "Alex";
  if (has(words, "last name", "lastname", "surname", "family name")) return "Tester";
  if (has(words, "username", "user name", "login", "handle", "nickname")) return `qa_${token}`;
  if (has(words, "phone", "mobile", "tel", "telephone", "cell")) return `+1 555 01${String(n % 100).padStart(2, "0")}`;
  if (has(words, "zip", "postal", "postcode", "post code", "zipcode")) return "12345";
  if (has(words, "city", "town")) return "Springfield";
  if (has(words, "state", "province", "region")) return "CA";
  if (has(words, "country")) return "United States";
  if (has(words, "street", "address", "address line", "line1", "line 1")) return `${100 + (n % 800)} Test Street`;
  if (has(words, "company", "organization", "organisation", "business", "employer")) return "Example Corp";
  if (has(words, "url", "website", "homepage", "link")) return "https://example.com/";
  if (has(words, "birth", "birthday", "dob", "birthdate")) return "1990-01-15";
  if (has(words, "date", "day")) return "2030-01-15";
  if (has(words, "age")) return 30;
  if (has(words, "quantity", "qty", "count", "number of", "amount of", "items")) return 1;
  if (has(words, "price", "amount", "total", "budget")) return 10;
  if (has(words, "subject", "title", "headline")) return "Automated test";
  if (has(words, "message", "comment", "note", "notes", "body", "review", "feedback", "description", "bio")) {
    return "This is an automated test message.";
  }
  if (has(words, "name", "full name", "fullname", "display name", "contact")) return "Alex Tester";
  if (has(words, "search", "query", "term", "keyword", "keywords", "product", "item")) {
    return has(text, "product", "item") ? "test product" : "test";
  }
  if (has(words, "code", "coupon", "promo", "voucher")) return `TEST${token.toUpperCase()}`;
  if (has(words, "enabled", "agree", "accept", "subscribe", "opt in", "newsletter", "is", "has")) return true;
  return `test-${token}`;
}
