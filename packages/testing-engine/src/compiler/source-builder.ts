/**
 * Source emitter for the generated test (Task 16, D11). Deliberately tiny: the compiler builds
 * `run.spec.ts` from compiler-chosen identifiers and fixed template text only, and every string
 * literal goes through `lit` (JSON.stringify). No run value — page text, test data, criterion text,
 * URLs — is ever passed to it: those live in run-data.json and are referenced as `data.<path>`.
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A string / number / boolean literal. */
export function lit(value: string | number | boolean): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("source-builder: non-finite number literal");
  return JSON.stringify(value);
}

/** A compiler-chosen identifier; throws for anything else. */
export function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`source-builder: ${JSON.stringify(name)} is not an identifier`);
  return name;
}

/** `object.key` for an identifier key, else `object["key"]`. */
export function member(object: string, key: string): string {
  return IDENTIFIER.test(key) ? `${object}.${key}` : `${object}[${lit(key)}]`;
}

/** Lines with two-space indentation. */
export class SourceWriter {
  private readonly lines: string[] = [];
  private depth = 0;

  line(text = ""): this {
    this.lines.push(text === "" ? "" : `${"  ".repeat(this.depth)}${text}`);
    return this;
  }

  /** A fixed comment (template text only). */
  comment(text: string): this {
    if (/[\r\n\u2028\u2029]/.test(text)) throw new Error("source-builder: a comment must be one line");
    return this.line(`// ${text}`);
  }

  /** `open` line, the body one level deeper, then `close`. */
  block(open: string, body: () => void, close: string): this {
    this.line(open);
    this.depth++;
    body();
    this.depth--;
    return this.line(close);
  }

  toString(): string {
    return `${this.lines.join("\n")}\n`;
  }
}
