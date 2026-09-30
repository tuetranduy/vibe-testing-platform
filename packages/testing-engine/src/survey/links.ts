import { isIP } from "node:net";
import { assertActionAllowed } from "@platform/security";

/** The survey loads the start page and at most this many pages it links to. */
export const MAX_SURVEY_LINKS = 5;

/** A link as the page inventory reads it: its text, absolute URL, and where it sits on the page. */
export interface SurveyLink {
  text: string;
  url: string;
  /** "nav": in the page's header or navigation (the site's own menu); "main": anywhere else. */
  area: "nav" | "main";
}

/** File types a link would download rather than show: documents, archives, images, audio and video. */
export const DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf", "zip", "gz", "tgz", "tar", "rar", "7z", "dmg", "exe", "msi", "apk", "iso",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "csv", "epub",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "avif",
  "mp3", "wav", "ogg", "flac", "m4a", "aac", "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv",
]);

/** Sign-out wording (log out, logout, sign out, signout, sign off), matched after `-` / `_` became spaces. */
const SIGN_OUT = /\b(?:log ?out|sign ?out|sign ?off)\b/;

const normalize = (s: string): string => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A link's path and query as words for the term checks. The host is left out: `pay.example.com` is a site, not an action. */
const pathWords = (url: URL): string => decoded(`${url.pathname}${url.search}`);

/** The page a URL shows: origin + path without a trailing slash (fragment and query ignored). */
export function pageKey(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.origin}${path}`;
}

/** What events and stored pages show of a page's URL: its path — with the host when it isn't the start page's — never the query. */
export function surveyPath(url: URL, start: URL): string {
  const path = url.pathname || "/";
  return url.host === start.host ? path : `${url.host}${path}`;
}

/** The URL a surveyed page is stored under: origin + path, without query or fragment. */
export const surveyPageUrl = (url: URL): string => `${url.origin}${url.pathname || "/"}`;

/**
 * Where a surveyed page may end up after redirects: the run's allowed hosts as the navigation guard
 * has them (the start URL's host, its subdomains, and the additional hosts).
 */
export function isAllowedPageHost(url: URL, start: URL, additionalAllowedHosts: readonly string[]): boolean {
  const host = url.hostname.toLowerCase();
  const base = start.hostname.toLowerCase();
  if (host === base) return true;
  if (isIP(base) === 0 && host.endsWith(`.${base}`)) return true;
  return additionalAllowedHosts.some((h) => h.toLowerCase() === host);
}

const isDownload = (url: URL): boolean => {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(url.pathname)?.[1]?.toLowerCase();
  return ext !== undefined && DOWNLOAD_EXTENSIONS.has(ext);
};

/** A destructive term (the action policy's list, `checkout` + submit included) in the link's text or its path and query. */
const looksDestructive = (link: SurveyLink, url: URL): boolean =>
  !assertActionAllowed({ instruction: pathWords(url), elementText: link.text }, { allowDestructive: false }).allowed;

const looksLikeSignOut = (link: SurveyLink, url: URL): boolean =>
  SIGN_OUT.test(normalize(link.text)) || SIGN_OUT.test(normalize(pathWords(url)));

export interface ChooseLinksInput {
  startUrl: string;
  links: readonly SurveyLink[];
  additionalAllowedHosts: readonly string[];
  /** Other URLs of the start page (where it redirected to): never chosen either. */
  startAliases?: readonly string[];
  /** At most this many (default MAX_SURVEY_LINKS). */
  max?: number;
  /**
   * Orders the candidates, higher first; ties keep the survey's order (V1.3: the requirement analysis ranks
   * links by how many of the requirement's words they share). Default: the survey's order.
   */
  rank?: (link: SurveyLink) => number;
}

/**
 * The pages the survey loads after the start page (spec section 5, step 3): http(s) links on the
 * start URL's host or an additional allowed host, other than the start page, one per path
 * (fragment and query ignored), no downloads, and none whose text or URL reads as destructive or
 * as signing out. Navigation / header links first, then the rest, each in page order (then by `rank`, when
 * given); at most `max` (MAX_SURVEY_LINKS). The returned URLs keep their query (a page may need it) and drop the fragment.
 */
export function chooseSurveyLinks(input: ChooseLinksInput): URL[] {
  const start = new URL(input.startUrl);
  const seen = new Set<string>([pageKey(start)]);
  for (const alias of input.startAliases ?? []) {
    try {
      seen.add(pageKey(new URL(alias)));
    } catch {
      // not a URL: nothing to exclude
    }
  }
  const additional = input.additionalAllowedHosts.map((h) => h.toLowerCase());
  const byArea = [...input.links.filter((l) => l.area === "nav"), ...input.links.filter((l) => l.area !== "nav")];
  const rank = input.rank;
  // Array.prototype.sort is stable: equal ranks keep the survey's order.
  const ordered = rank ? byArea.map((l) => ({ l, r: rank(l) })).sort((a, b) => b.r - a.r).map((x) => x.l) : byArea;
  const max = input.max ?? MAX_SURVEY_LINKS;
  const chosen: URL[] = [];
  for (const link of ordered) {
    if (chosen.length >= max) break;
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.username || url.password) continue;
    if (url.host !== start.host && !additional.includes(url.hostname.toLowerCase())) continue;
    const key = pageKey(url);
    if (seen.has(key)) continue;
    if (isDownload(url) || looksDestructive(link, url) || looksLikeSignOut(link, url)) continue;
    seen.add(key);
    url.hash = "";
    chosen.push(url);
  }
  return chosen;
}
