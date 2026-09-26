import { parse, type TokenType } from "sugar-high/core";
import { tokenize } from "sugar-high/lang/typescript";

/**
 * Syntax highlighting for the generated Playwright test (Ruling R50). sugar-high is used only as a
 * tokenizer: it returns plain (type, text) tokens, and the viewer renders them as React text nodes,
 * which React escapes. Nothing is ever injected as HTML, so markup in the source shows as text.
 */
export interface CodeToken {
  type: TokenType;
  value: string;
}

/** One array of tokens per source line ("\n"-separated). Lossless: the tokens re-join to the source. */
export function highlightLines(source: string): CodeToken[][] {
  const plain = source.split("\n");
  let lines: CodeToken[][];
  try {
    lines = parse(source, { tokenize }).lines.map((l) =>
      l.tokens.filter((t) => t.value !== "").map((t) => ({ type: t.type, value: t.value })),
    );
  } catch {
    return plain.map((value) => (value ? [{ type: "identifier", value }] : []));
  }
  // If the tokenizer ever dropped or reshaped text, show the source unhighlighted rather than wrong.
  const exact = lines.length === plain.length && lines.every((tokens, i) => tokens.map((t) => t.value).join("") === plain[i]);
  return exact ? lines : plain.map((value) => (value ? [{ type: "identifier", value }] : []));
}
