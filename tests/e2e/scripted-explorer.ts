import {
  ExplorerSessionClosedError,
  NavigationBlockedError,
  type ActResult,
  type BrowserExplorer,
  type ExplorerSession,
  type ExplorerStartInput,
  type ExtractResult,
  type NavigateResult,
  type NavigationBlock,
  type ObserveResult,
  type ObservedElement,
} from "@platform/stagehand-adapter/browser-explorer";
import { readFact, recordElement, type FactReadMode } from "@platform/testing-engine";
import type { Page } from "playwright-core";
import type { ZodType } from "zod";

/**
 * A deterministic `BrowserExplorer` for CI-mode E2E (Task 21): it drives the run's real sandboxed
 * page (egress proxy, navigation guard) but replaces Stagehand's model with a script. `observe`
 * resolves an instruction to the first rule whose phrase it contains and returns that element as
 * an absolute XPath — the shape Stagehand returns. `extract` reads each requested fact with the
 * fact reader the verifier trusts, so the values it "extracts" are DOM-verifiable. No model calls.
 */

export interface ScriptRule {
  /** Lower-case phrase an instruction must contain (our scenarios' step and fact descriptions). */
  when: string;
  /** Tried in order; the first that matches exactly one element is used. */
  selectors: string[];
  /** When set, `extract` answers this fact key by reading the element in this mode. */
  fact?: { key: string; mode: FactReadMode };
}

export interface ExplorerScript {
  rules: ScriptRule[];
}

const NAVIGATION_TIMEOUT_MS = 30_000;
const BLOCK_EVENT_GRACE_MS = 1_000;

export class ScriptedExplorer implements BrowserExplorer {
  constructor(private readonly script: ExplorerScript) {}

  async start(input: ExplorerStartInput): Promise<ExplorerSession> {
    return new ScriptedSession(input, this.script);
  }
}

class ScriptedSession implements ExplorerSession {
  readonly page: Page;
  private closed = false;
  private readonly blocks: NavigationBlock[] = [];
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    private readonly input: ExplorerStartInput,
    private readonly script: ExplorerScript,
  ) {
    this.page = input.page.page;
    this.unsubscribe = input.page.onNavigationBlocked?.((e) => void this.blocks.push(e));
  }

  /** Every operation stops as soon as the run's signal fires (cancel, budget, deadline). */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new ExplorerSessionClosedError("explorer session is closed");
    const { signal } = this.input;
    if (signal.aborted) throw signal.reason;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([fn(), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private rule(instruction: string): ScriptRule | undefined {
    const lower = instruction.toLowerCase();
    return this.script.rules.find((r) => lower.includes(r.when));
  }

  /** The first selector matching exactly one element, as an absolute XPath (Stagehand's shape). */
  private async resolve(rule: ScriptRule): Promise<string | null> {
    for (const selector of rule.selectors) {
      const locator = this.page.locator(selector);
      if ((await locator.count()) !== 1) continue;
      // No named inner functions: tsx's keepNames would inject `__name` into code run in the browser.
      const xpath = await locator.evaluate((el) => {
        const parts: string[] = [];
        for (let node: Element | null = el; node && node.nodeType === 1; node = node.parentElement) {
          let index = 1;
          for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === node.tagName) index += 1;
          parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
        }
        return `/${parts.join("/")}`;
      });
      return `xpath=${xpath}`;
    }
    return null;
  }

  private async waitForBlockEvent(): Promise<void> {
    for (let waited = 0; waited < BLOCK_EVENT_GRACE_MS && this.blocks.length === 0; waited += 50) await new Promise((r) => setTimeout(r, 50));
  }

  navigate(url: string): Promise<NavigateResult> {
    return this.run(async () => {
      this.blocks.length = 0;
      try {
        await this.page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
      } catch (err) {
        if (!/ERR_BLOCKED_BY_CLIENT/.test(err instanceof Error ? err.message : String(err)) && this.blocks.length === 0) throw err;
        await this.waitForBlockEvent();
        const [first] = this.blocks.splice(0);
        throw new NavigationBlockedError(first?.url ?? url, first?.reason ?? null);
      }
      const [first] = this.blocks.splice(0);
      if (first) throw new NavigationBlockedError(first.url, first.reason);
      return { url: this.page.url() };
    });
  }

  observe(instruction: string): Promise<ObserveResult> {
    return this.run(async () => {
      const rule = this.rule(instruction);
      const selector = rule ? await this.resolve(rule) : null;
      const elements: ObservedElement[] = rule && selector ? [{ selector, description: rule.when, method: "click", arguments: [] }] : [];
      return { elements, llm: null };
    });
  }

  act(instruction: string): Promise<ActResult> {
    return this.observe(instruction).then(({ elements: [element] }) =>
      element ? this.actOn(element) : { success: false, message: "no element", element: null, navigationBlocks: [], llm: null },
    );
  }

  actOn(element: ObservedElement): Promise<ActResult> {
    return this.run(async () => {
      this.blocks.length = 0;
      await this.page.locator(element.selector).click({ timeout: NAVIGATION_TIMEOUT_MS });
      await this.page.waitForLoadState("load", { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
      if (this.page.url().startsWith("chrome-error:")) await this.waitForBlockEvent();
      return { success: true, message: "clicked", element, navigationBlocks: this.blocks.splice(0), llm: null };
    });
  }

  extract<T>(instruction: string, schema: ZodType<T>): Promise<ExtractResult<T>> {
    return this.run(async () => {
      const keys = [...instruction.matchAll(/^- ([A-Za-z0-9_]+):/gm)].map((m) => m[1]!);
      const values: Record<string, unknown> = {};
      for (const key of keys) {
        const rule = this.script.rules.find((r) => r.fact?.key === key);
        const selector = rule ? await this.resolve(rule) : null;
        if (!rule?.fact || !selector) {
          values[key] = null;
          continue;
        }
        const ref = await recordElement(this.page, selector).catch(() => null);
        const reading = ref ? await readFact(this.page, ref, rule.fact.mode).catch(() => null) : null;
        values[key] = reading?.value ?? null;
      }
      return { data: schema.parse(values), llm: null };
    });
  }

  screenshot(): Promise<Buffer> {
    return this.run(async () => Buffer.from(await this.page.screenshot({ type: "png" })));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
  }
}
