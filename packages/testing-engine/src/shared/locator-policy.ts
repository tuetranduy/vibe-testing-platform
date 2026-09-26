import type { LocatorCandidate } from "@platform/contracts";

/**
 * Locator policy (Task 14 / Task 16): how an element the explorer acted on becomes replayable
 * Playwright locators. Candidates are ranked by how stable and user-facing they are; the recorder
 * then picks the first one that matches exactly the acted element (`ElementRef.chosenIndex`).
 */

export const LOCATOR_STRATEGY_ORDER = ["role", "label", "placeholder", "text", "testId", "css", "xpath"] as const satisfies readonly LocatorCandidate["strategy"][];

const RANK = new Map<LocatorCandidate["strategy"], number>(LOCATOR_STRATEGY_ORDER.map((s, i) => [s, i]));

/** What the recorder reads about one element (DOM + Chromium's accessibility tree). */
export interface ElementDescription {
  /** Lowercase tag name. */
  tag: string;
  /** Computed role from Chromium's accessibility tree (may be a non-ARIA role such as "StaticText"). */
  role: string | null;
  /** Computed accessible name. */
  name: string | null;
  /** Text of associated `<label>` elements. */
  labels: string[];
  placeholder: string | null;
  /** Visible text, whitespace-collapsed. */
  text: string | null;
  /** `data-testid`. */
  testId: string | null;
  id: string | null;
  /** The `name` attribute. */
  nameAttr: string | null;
  /** Absolute positional XPath, without the `xpath=` prefix. */
  xpath: string;
}

/**
 * ARIA roles `page.getByRole` accepts and that identify an element by name (not generic containers).
 * The compiler (Task 16) writes only these roles into generated source.
 */
export const NAMEABLE_ROLES: ReadonlySet<string> = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell", "checkbox",
  "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion", "dialog", "directory",
  "document", "emphasis", "feed", "figure", "form", "grid", "gridcell", "group", "heading", "img", "insertion", "link",
  "list", "listbox", "listitem", "log", "main", "marquee", "math", "meter", "menu", "menubar", "menuitem",
  "menuitemcheckbox", "menuitemradio", "navigation", "note", "option", "paragraph", "progressbar", "radio",
  "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator", "slider",
  "spinbutton", "status", "strong", "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel",
  "term", "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

/** Chromium AX role names that differ from the ARIA role Playwright expects. */
const ROLE_ALIASES: Record<string, string> = { image: "img" };

const FORM_FIELD_TAGS = new Set(["input", "textarea", "select"]);
const MAX_NAME_LENGTH = 200;
const MAX_TEXT_LENGTH = 80;

function valueOf(c: LocatorCandidate): string {
  switch (c.strategy) {
    case "role":
      return c.name;
    case "label":
    case "placeholder":
    case "text":
      return c.text;
    case "testId":
      return c.value;
    case "css":
    case "xpath":
      return c.selector;
  }
}

function keyOf(c: LocatorCandidate): string {
  return JSON.stringify(c);
}

/** Stable sort by strategy rank; drops candidates with empty values and exact duplicates. Pure. */
export function rankLocatorCandidates(candidates: LocatorCandidate[]): LocatorCandidate[] {
  const seen = new Set<string>();
  const kept: LocatorCandidate[] = [];
  for (const c of candidates) {
    if (valueOf(c).trim() === "") continue;
    const key = keyOf(c);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(c);
  }
  return kept
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (RANK.get(a.c.strategy) ?? 99) - (RANK.get(b.c.strategy) ?? 99) || a.i - b.i)
    .map(({ c }) => c);
}

const collapse = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

function cssString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function idSelector(id: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) ? `#${id}` : `[id=${cssString(id)}]`;
}

/** Every locator candidate the policy derives from an element description, ranked. */
export function candidatesFromDescription(d: ElementDescription): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  const role = d.role ? (ROLE_ALIASES[d.role] ?? d.role) : null;
  const name = collapse(d.name);
  if (role && NAMEABLE_ROLES.has(role) && name && name.length <= MAX_NAME_LENGTH) {
    out.push({ strategy: "role", role, name, exact: true });
  }
  for (const label of d.labels) {
    const text = collapse(label);
    if (text) out.push({ strategy: "label", text });
  }
  if (d.placeholder && d.placeholder.trim()) out.push({ strategy: "placeholder", text: d.placeholder.trim() });
  const isField = FORM_FIELD_TAGS.has(d.tag);
  const rawText = (d.text ?? "").trim();
  if (!isField && rawText && !/\n/.test(rawText) && rawText.length <= MAX_TEXT_LENGTH) {
    out.push({ strategy: "text", text: collapse(rawText), exact: true });
  }
  if (d.testId && d.testId.trim()) out.push({ strategy: "testId", value: d.testId });
  if (d.id && d.id.trim()) out.push({ strategy: "css", selector: idSelector(d.id) });
  else if (isField && d.nameAttr) out.push({ strategy: "css", selector: `${d.tag}[name=${cssString(d.nameAttr)}]` });
  out.push({ strategy: "xpath", selector: d.xpath });
  return rankLocatorCandidates(out);
}
