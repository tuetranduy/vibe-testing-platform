import type { LlmTransport, LlmTransportRequest, LlmTransportResponse } from "@platform/llm";

/**
 * A scripted model for Stagehand-through-the-sandbox integration tests: an `LlmTransport` under the
 * real `LlmClient` that reads Stagehand's serialized accessibility tree and picks element ids. No
 * network, no API key. Shared by the adapter (Task 14a) and explore-stage (Task 14b) suites.
 */

export function promptOf(req: LlmTransportRequest): string {
  return [
    req.system,
    ...req.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((p) => (p.type === "text" ? p.text : "")))),
  ].join("\n");
}

/** `[<frame>-<backendNodeId>] <role>: <name>` lines of Stagehand's serialized a11y tree. */
export function findElementId(tree: string, role: string, nameIncludes: string): string | undefined {
  const re = /\[(\d+-\d+)\]\s+([^:\n[]+?)(?::\s*([^\n]*))?$/gm;
  for (const m of tree.matchAll(re)) {
    if (m[2]?.trim() === role && (m[3] ?? "").toLowerCase().includes(nameIncludes.toLowerCase())) return m[1];
  }
  return undefined;
}

export interface ScriptTarget {
  /** Lower-case phrase of the instruction that selects this target (only our instructions contain it). */
  when: string;
  role: string;
  name: string;
  method: string;
}

/** Default extraction: the demo shop's cart badge count. */
export const cartCountExtraction = (prompt: string): unknown => ({ cartCount: Number(/Cart \((\d+)\)/.exec(prompt)?.[1] ?? "-1") });

export class ScriptedTransport implements LlmTransport {
  readonly provider = "scripted";
  readonly requests: LlmTransportRequest[] = [];

  constructor(
    private readonly targets: ScriptTarget[],
    private readonly extraction: (prompt: string) => unknown = cartCountExtraction,
  ) {}

  async complete(req: LlmTransportRequest): Promise<LlmTransportResponse> {
    this.requests.push(req);
    const prompt = promptOf(req);
    const lower = prompt.toLowerCase();
    const target = this.targets.find((t) => lower.includes(t.when));
    const pick = () => {
      const id = target ? findElementId(prompt, target.role, target.name) : undefined;
      return id && target
        ? { elementId: id, description: `${target.role} ${target.name}`.trim(), method: target.method, arguments: target.method === "fill" ? ["model-chosen"] : [] }
        : null;
    };
    let json: unknown;
    switch (req.schemaName) {
      case "Act":
        json = { action: pick(), twoStep: false };
        break;
      case "Observation": {
        const el = pick();
        json = { elements: el ? [el] : [] };
        break;
      }
      case "Extraction":
        json = this.extraction(prompt);
        break;
      case "Metadata":
        json = { progress: "extracted", completed: true };
        break;
      default:
        json = { text: "ok" };
    }
    return { text: JSON.stringify(json), model: req.model, usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: 17 } };
  }
}
