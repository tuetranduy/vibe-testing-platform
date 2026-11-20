/** What a planned step's description says about signing in (KI-073, KI-080). */

/** A step that asks for sign-in, registration or the account itself: the prompt it opens is what it wants. */
export const ASKS_FOR_SIGN_IN = /\b(?:log\s*-?\s*in|sign\s*-?\s*in|login|signin|sign\s*-?\s*up|register|registration|create\s+(?:an?\s+)?account|my\s+account|account|password|credentials?)\b/i;

/** A step that gets past a sign-in prompt: it signs in, signs up or continues as a guest (KI-080). */
export const getsPastSignIn = (stepDescription: string): boolean => ASKS_FOR_SIGN_IN.test(stepDescription) || /\bguest\b/i.test(stepDescription);
