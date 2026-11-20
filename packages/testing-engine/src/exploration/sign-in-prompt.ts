import { ASKS_FOR_SIGN_IN } from "../shared/sign-in-steps";

/**
 * A click that opened the site's sign-in prompt (KI-073): a guest's "Add to wishlist" opens a "Sign in to your account"
 * dialog, or sends the browser to a login page. The step's `act` is marked `signInPrompt`. When the plan does not get
 * past it, exploration does (KI-080): as a guest, with the run's credentials, or with a new account. A criterion that
 * does not pass after a prompt nothing got past is reported BLOCKED / SIGN_IN_REQUIRED (verifier rule 3b), instead of
 * reading an empty wishlist as INCONCLUSIVE or as a failure.
 */

/** What the page shows that tells a sign-in prompt apart. */
export interface SignInState {
  url: string;
  /** Visible password fields. */
  passwordFields: number;
}

/** Reads a SignInState in the page (a string: see INVENTORY_SCRIPT on why not a function). */
export const SIGN_IN_STATE_SCRIPT = String.raw`(() => ({
  url: location.href,
  passwordFields: Array.from(document.querySelectorAll('input[type=password]')).filter(el => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }).length,
}))()`;

/** A login page's path: a whole segment, e.g. /login, /account/login, /signin, /auth. */
const LOGIN_PATH = /(?:^|\/)(?:log-?in|sign-?in|auth|authenticate)(?:\/|$)/i;
const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

/** Whether the click between `before` and `after` opened a sign-in prompt the step did not ask for. */
export function openedSignIn(before: SignInState, after: SignInState, stepDescription: string): boolean {
  if (ASKS_FOR_SIGN_IN.test(stepDescription)) return false;
  if (before.passwordFields === 0 && after.passwordFields > 0) return true;
  return !LOGIN_PATH.test(pathOf(before.url)) && LOGIN_PATH.test(pathOf(after.url));
}
