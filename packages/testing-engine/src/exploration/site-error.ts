/**
 * A checkpoint taken on the target's own server error page (KI-074): frontends-demo sometimes answers a product page with
 * "500 … Failed to fetch". Facts read there describe the error page, not the feature, so a check that does not pass on
 * it is reported INCONCLUSIVE / SITE_ERROR (verifier rule 6b) rather than FAIL or "not observed".
 */

/** What the page shows that tells an error page apart. */
export interface PageHeadline {
  title: string;
  /** The first few h1 / h2 texts. */
  headings: string[];
  /** The start of the page's visible text. */
  text: string;
}

/** Reads a PageHeadline in the page (a string: see INVENTORY_SCRIPT on why not a function). */
export const SITE_ERROR_SCRIPT = String.raw`(() => ({
  title: String(document.title || ''),
  headings: Array.from(document.querySelectorAll('h1, h2')).slice(0, 3).map(h => String(h.textContent || '').replace(/\s+/g, ' ').trim()),
  text: String((document.body && document.body.innerText) || '').slice(0, 600),
}))()`;

/**
 * A server error status at the start, alone or before a separator or an error word: "500", "Error 502", "503 Service
 * Unavailable", "502 - Bad Gateway". Not a name that starts with a number: "500 GB SSD".
 */
const STATUS = /^\s*(?:(?:http\s*)?error\s*)?5\d\d(?:\s*$|\s*[|:–—-]|\s+(?:internal|server|service|bad|gateway|error)\b)/i;
/** The phrases a server error page shows. */
const PHRASE = /\b(?:internal server error|service unavailable|bad gateway|gateway time-?out|something went wrong|application error|an error occurred)\b/i;
/** Only a page this short that says so is taken as one (a long page that mentions an error is a page with content). */
const SHORT_PAGE_CHARS = 300;

const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
const isError = (s: string) => STATUS.test(s) || PHRASE.test(s);

/**
 * The error heading when the whole page is a server error page, else null: its title says so, its main (first) heading
 * shows a 5xx status, or its main heading or first line says so on a short page. An error panel inside a working page (a
 * later heading, a long page) is not one (review finding).
 */
export function siteErrorOf(page: PageHeadline): string | null {
  if (page.title.trim() !== "" && isError(page.title)) return clip(page.title);
  const text = page.text.trim();
  const short = text.length < SHORT_PAGE_CHARS;
  const main = page.headings[0]?.trim() ?? "";
  if (main !== "" && (STATUS.test(main) || (short && PHRASE.test(main)))) return clip(main);
  if (text === "" || !short) return null;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (!isError(lines[0] ?? "")) return null;
  return clip(lines.find((l) => PHRASE.test(l)) ?? lines[0]!);
}
