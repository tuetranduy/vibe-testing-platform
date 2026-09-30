/**
 * Test data written in the requirement itself (V1.3.1): "Log in as admin@shop.test with password Adm1n#2026"
 * must be used, not ignored. Before a run is stored, the platform finds the credentials the text names:
 *
 * - emails and usernames become the run's test data (`email`, `username`, …) — they stay in the text;
 * - passwords become the run's secrets (`password`, …): encrypted, redacted everywhere, and replaced in the text
 *   by `[secret: <name>]`, so the value is never stored in plain text or shown to a model.
 *
 * Values the user entered explicitly always win: a key or secret name they gave is never overwritten, and a
 * value they already entered as a secret is only replaced in the text. Pure (no Node or browser API): the API
 * applies it and the web form previews it.
 *
 * Deliberately conservative: a password needs an explicit label ("password: X", "password is X", `password "X"`,
 * "mật khẩu: X") or a credential pair ("user@x.com / X", "user@x.com:X", "login admin / X"), and a value read
 * after "is" must look like a credential (quoted, or with a digit, symbol or inner capital), so "the password is
 * invalid" is left alone. Standalone emails are taken only when the text is about signing in or registering.
 */

export interface InlineInputFound {
  kind: "testData" | "secret";
  /** The test data key or secret name the value is stored under. */
  name: string;
}

export interface InlineInputs {
  /** The requirement with every password value replaced by `[secret: <name>]`. */
  text: string;
  /** New test data (keys the user did not give). */
  testData: Record<string, string>;
  /** New secrets (values the user had not entered as secrets). */
  secrets: Record<string, string>;
  /** What was taken, in the order found (also secrets that were already entered: their text was replaced). */
  found: InlineInputFound[];
}

export interface ExtractInlineInputsOptions {
  /** The run's own test data: its keys are never reused. */
  testData?: Record<string, unknown>;
  /** The run's own secrets (name → value): a password equal to one of them keeps that name. */
  secrets?: Record<string, string>;
  /** Stop adding secrets beyond this many in all (MAX_SECRETS). */
  maxSecrets?: number;
  /** Stop adding test data beyond this many in all (MAX_TEST_DATA_ENTRIES). */
  maxTestData?: number;
}

/** How a password value is written into the stored requirement in its place. */
export const secretPlaceholder = (name: string): string => `[secret: ${name}]`;

const W = "[\\p{L}\\p{N}_]"; // a word character, Unicode-aware
const NB = `(?<!${W})`; // not preceded by a word character
const NA = `(?!${W})`; // not followed by a word character

const PASSWORD_LABEL = `(?:password|passwd|pass\\s?word|passcode|pwd|pw|pass|pin|mật\\s?khẩu|mat\\s?khau)`;
const USER_LABEL = `(?:user\\s?name|user\\s?id|login\\s?(?:name|id)?|user|account|e-?mail|tài\\s?khoản|tai\\s?khoan|tên\\s?đăng\\s?nhập)`;
const QUOTED = `"([^"\\n]{1,200})"|'([^'\\n]{1,200})'|“([^”\\n]{1,200})”|‘([^’\\n]{1,200})’|\`([^\`\\n]{1,200})\``;
const BARE = `([^\\s"'“”‘’\`,;]{1,200})`;
const EMAIL = "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+";

/** label + separator + value. Groups: sep, then the quoted alternatives (5), then the bare value. */
const labelled = (label: string) =>
  new RegExp(`${NB}${label}${NA}\\s*(:|=|(?:is|of|là|la)(?=\\s))?\\s*(?:${QUOTED}|${BARE})`, "giu");

const PASSWORD_RE = labelled(PASSWORD_LABEL);
const USER_RE = labelled(USER_LABEL);
/** "user@x.com / Secret1", "user@x.com:Secret1" (no space around the colon: a sentence's colon is not a pair). */
const EMAIL_PAIR_RE = new RegExp(`(${EMAIL})(?:\\s*/\\s*|:)(?:${QUOTED}|${BARE})`, "gu");
/** "log in with admin / Secret1", "credentials: admin/Secret1" (a username pair only next to a sign-in word). */
const USER_PAIR_RE = new RegExp(
  `(?:log\\s?in|sign\\s?in|credentials?|account|đăng\\s?nhập)[^.\\n]{0,40}?(?<![\\p{L}\\p{N}_@.-])([A-Za-z0-9._-]{3,64})\\s*/\\s*(?:${QUOTED}|${BARE})`,
  "giu",
);
const EMAIL_RE = new RegExp(`${NB}${EMAIL}`, "gu");
const SIGN_IN_CONTEXT = /log\s?in|sign\s?(?:in|up)|register|credential|account|password|đăng\s?(?:nhập|ký)/iu;

/** Words that follow a password label without being a value ("the password field", "password is required"). */
const NOT_A_VALUE = new Set(
  [
    "field", "fields", "input", "box", "form", "page", "reset", "required", "invalid", "incorrect", "wrong", "empty",
    "blank", "missing", "correct", "valid", "hidden", "masked", "shown", "visible", "strength", "policy", "rules",
    "change", "changed", "forgot", "forgotten", "manager", "and", "or", "with", "for", "then", "must", "should",
    "the", "a", "an", "to", "is", "of", "too", "short", "long", "mismatch", "match", "matches", "confirmation", "error",
  ].map((w) => w.toLowerCase()),
);

/** Sentence punctuation after an unquoted value ("… password Adm1n#2026."); quote a value to keep a trailing dot. */
const trimValue = (v: string): string => v.replace(/[.,;:]+$/u, "");

/** A value read after "is" / "of" / nothing must look like a credential; after ":" or "=" any token will do. */
function acceptable(value: string, quoted: boolean, sep: string | undefined): boolean {
  if (value.length < 4 || value.length > 200) return false;
  if (/^\[(?:secret:|REDACTED)/i.test(value) || value.startsWith("<") || value.startsWith("{{")) return false;
  if (NOT_A_VALUE.has(value.toLowerCase())) return false;
  if (quoted) return true;
  if (sep === ":" || sep === "=") return true;
  return /[\d\W_]/u.test(value) || /\p{Lu}/u.test(value.slice(1));
}

function valueOf(m: RegExpExecArray, first: number): { value: string; quoted: boolean } | null {
  for (let i = first; i < first + 5; i++) if (m[i] !== undefined) return { value: m[i]!, quoted: true };
  const bare = m[first + 5];
  return bare === undefined ? null : { value: trimValue(bare), quoted: false };
}

export function extractInlineInputs(requirement: string, opts: ExtractInlineInputsOptions = {}): InlineInputs {
  const ownData = opts.testData ?? {};
  const ownSecrets = opts.secrets ?? {};
  const maxSecrets = opts.maxSecrets ?? Number.POSITIVE_INFINITY;
  const maxData = opts.maxTestData ?? Number.POSITIVE_INFINITY;

  const passwords: string[] = [];
  const users: string[] = [];
  const addPassword = (v: string) => void (passwords.includes(v) || passwords.push(v));
  const addUser = (v: string) => void (users.includes(v) || users.push(v));

  for (const m of requirement.matchAll(EMAIL_PAIR_RE)) {
    const pw = valueOf(m, 2);
    if (pw && acceptable(pw.value, pw.quoted, ":")) {
      addUser(m[1]!);
      addPassword(pw.value);
    }
  }
  for (const m of requirement.matchAll(USER_PAIR_RE)) {
    const pw = valueOf(m, 2);
    if (pw && !m[1]!.includes("@") && acceptable(pw.value, pw.quoted, ":")) {
      addUser(m[1]!);
      addPassword(pw.value);
    }
  }
  for (const m of requirement.matchAll(PASSWORD_RE)) {
    const pw = valueOf(m, 2);
    if (pw && acceptable(pw.value, pw.quoted, m[1]?.toLowerCase())) addPassword(pw.value);
  }
  for (const m of requirement.matchAll(USER_RE)) {
    const user = valueOf(m, 2);
    if (!user) continue;
    const isEmail = new RegExp(`^${EMAIL}$`, "u").test(user.value);
    const sep = m[1]?.toLowerCase();
    // A username after "is" (or no separator) must look like one: quoted, an email, or with a digit, dot, _ or -.
    const identifierLike = isEmail || user.quoted || sep === ":" || sep === "=" || /[\d._@-]/.test(user.value);
    if (identifierLike && user.value.length >= 3 && !NOT_A_VALUE.has(user.value.toLowerCase()) && !passwords.includes(user.value)) addUser(user.value);
  }
  if (SIGN_IN_CONTEXT.test(requirement) || passwords.length > 0) {
    for (const m of requirement.matchAll(EMAIL_RE)) addUser(trimValue(m[0]));
  }

  const found: InlineInputFound[] = [];
  const testData: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const taken = (key: string) => Object.hasOwn(ownData, key) || Object.hasOwn(testData, key);
  const nameTaken = (name: string) => Object.hasOwn(ownSecrets, name) || Object.hasOwn(secrets, name);
  const nextName = (base: string, isTaken: (n: string) => boolean) => {
    if (!isTaken(base)) return base;
    for (let i = 2; ; i++) if (!isTaken(`${base}_${i}`)) return `${base}_${i}`;
  };

  let text = requirement;
  for (const value of passwords) {
    const existing = Object.entries(ownSecrets).find(([, v]) => v === value)?.[0];
    let name = existing;
    if (!name) {
      if (Object.keys(ownSecrets).length + Object.keys(secrets).length >= maxSecrets) continue;
      name = nextName("password", nameTaken);
      secrets[name] = value;
    }
    text = text.split(value).join(secretPlaceholder(name));
    found.push({ kind: "secret", name });
  }

  for (const value of users) {
    const already = Object.entries({ ...ownData, ...testData }).find(([, v]) => v === value)?.[0];
    if (already) {
      if (!found.some((f) => f.name === already)) found.push({ kind: "testData", name: already });
      continue;
    }
    const base = /@/.test(value) ? "email" : "username";
    // The user's own key wins: a value for a key they set is not added under another name.
    if (Object.hasOwn(ownData, base)) continue;
    if (Object.keys(ownData).length + Object.keys(testData).length >= maxData) break;
    const key = nextName(base, taken);
    testData[key] = value;
    found.push({ kind: "testData", name: key });
  }

  return { text, testData, secrets, found };
}
