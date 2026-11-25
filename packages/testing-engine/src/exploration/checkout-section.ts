import type { PlannedStep } from "@platform/contracts";

const SECTION_NAMES = ["billing address", "shipping address", "shipping method", "payment method", "payment information", "confirm order"] as const;
type SectionName = typeof SECTION_NAMES[number];

export interface CheckoutSection {
  name: SectionName;
  panel: string;
  savedAddress: string | null;
}

export function isCheckoutSection(section: CheckoutSection | null): section is CheckoutSection {
  return !!section && SECTION_NAMES.includes(section.name) && typeof section.panel === "string";
}

export function namedCheckoutSection(description: string): SectionName | undefined {
  return SECTION_NAMES.find((name) => new RegExp(`\\b${name}\\b`, "i").test(description));
}

export function waitedCheckoutSection(description: string): SectionName | undefined {
  const wait = /^wait for (?:the )?["'‘“]?([\w ]+?)["'’”]?(?: (?:section|step|panel))?(?: of (?:the )?checkout)?(?: to (?:open|appear|be (?:visible|active|open)))?\.?$/i.exec(description.trim());
  return SECTION_NAMES.find((name) => name === wait?.[1]?.toLowerCase());
}

function readCheckoutSection(names: readonly SectionName[]): CheckoutSection | null {
  const visible = (el: Element) => !el.closest('[hidden],[aria-hidden="true"]') && el.getClientRects().length > 0 &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const xpath = (el: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const siblings = Array.from(node.parentElement?.children ?? []).filter((sibling) => sibling.tagName === node!.tagName);
      parts.unshift(`${node.localName}[${siblings.indexOf(node) + 1 || 1}]`);
    }
    return `xpath=/${parts.join("/")}`;
  };
  for (const list of Array.from(document.querySelectorAll("ol"))) {
    const sections = Array.from(list.querySelectorAll(":scope > li")).flatMap((item) => {
      const heading = item.querySelector('h2,h3,h4,[role="heading"]');
      const label = heading?.textContent?.trim().replace(/^\d+\s*/, "").replace(/\s+/g, " ").toLowerCase();
      const name = names.find((candidate) => candidate === label);
      return name && heading && visible(heading) ? [{ name, item }] : [];
    });
    if (new Set(sections.map(({ name }) => name)).size < 2) continue;
    const panels = sections.flatMap(({ name, item }) => Array.from(item.querySelectorAll('.step,[role="tabpanel"]'))
      .filter(visible).map((panel) => ({ name, panel })));
    if (panels.length !== 1) continue;
    const { name, panel } = panels[0]!;
    const savedAddress = Array.from(panel.querySelectorAll("select")).find((select) => {
      const option = select.selectedOptions[0];
      return visible(select) && !select.matches(":disabled") && option && /^\d+$/.test(option.value) && Number(option.value) > 0 &&
        Array.from(select.options).some((entry) => /^new address$/i.test(entry.text.trim()));
    })?.selectedOptions[0]?.text ?? null;
    const editableAddress = Array.from(panel.querySelectorAll('textarea,input:not([type]),input:is([type="text"],[type="tel"],[type="email"])')).some(visible);
    const otherShippingChoice = Array.from(panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"],[role="checkbox"]')).some((el) => {
      const label = el.getAttribute("aria-label") ?? Array.from(el.labels ?? [], (label) => label.textContent).join(" ");
      return visible(el) && (el.checked || el.getAttribute("aria-checked") === "true" || !/^in[- ]store pickup$/i.test(label.trim()));
    });
    const id = panel.id ? `#${CSS.escape(panel.id)}` : null;
    const scope = id && document.querySelectorAll(id).length === 1 ? `css=${id}` : xpath(panel);
    return { name, panel: scope, savedAddress: !editableAddress && !otherShippingChoice ? savedAddress : null };
  }
  return null;
}

export const CHECKOUT_SECTION_SCRIPT = `(() => { const __name = (fn) => fn; return (${readCheckoutSection.toString()})(${JSON.stringify(SECTION_NAMES)}); })()`;

const SAME_ADDRESS = /\b(?:ship(?:ping)?\s+to\s+(?:the\s+)?same\s+address|same\s+as\s+(?:the\s+)?billing\s+address)\b/i;
const ADDRESS_FIELD = /\b(?:address|first name|last name|email|company|country|city|state|zip|postal code|phone|fax)\b/i;

function optionalAddressSetup(step: PlannedStep): boolean {
  if (step.destructive || step.inputRef?.source === "secret" || step.inputRef?.source === "literal") return false;
  if (step.kind === "fill" || step.kind === "select") return ADDRESS_FIELD.test(step.description);
  return step.kind === "click" && /\bnew (?:shipping )?address\b/i.test(step.description);
}

/** A missing same-address checkbox can be dropped with its generated form setup when the plan already has Continue. */
export function savedShippingContinue(steps: readonly PlannedStep[], at: number): number | null {
  const first = steps[at];
  const uncheck = first?.kind === "click" && /\b(?:uncheck|deselect|checkbox)\b/i.test(first.description);
  if (!first || !uncheck || first.destructive || !SAME_ADDRESS.test(first.description)) return null;
  for (let i = at + 1; i < steps.length; i++) {
    const next = steps[i]!;
    if ((next.kind === "click" || next.kind === "submit") && !next.destructive && namedCheckoutSection(next.description) === "shipping address" && /\bcontinue\b/i.test(next.description)) return i;
    if (!optionalAddressSetup(next)) return null;
  }
  return null;
}
