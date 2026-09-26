import ts from "typescript";

/**
 * AST guard (Task 16): the last check before a generated `run.spec.ts` leaves the compiler. The
 * compiler only emits identifiers, criterion ids and fixed template text (D11), so this guard is
 * defense in depth: it parses the source with TypeScript and rejects anything a generated test
 * never needs and a hostile one would —
 *
 * - syntax errors;
 * - imports other than `@playwright/test`, `./helpers` and `./run-data.json`; `import x = require()`,
 *   re-exports from a module, dynamic `import()`, `import.meta`;
 * - `require`, `eval`, `Function` (incl. `new Function`), `globalThis` / `global`, `module`,
 *   `exports`, `Reflect`, `Proxy`, `WebAssembly`, and the `constructor` / `__proto__` / `prototype`
 *   escape hatches;
 * - page-script execution (`evaluate*`, `$eval`, `addInitScript`, `expose*`): only the fixed
 *   helpers read the DOM;
 * - computed member access (`x[expr]`) other than with a string or number literal;
 * - any `process` access other than `process.env.SECRET_<NAME>`.
 *
 * Returns human-readable violations (empty = accepted). It judges the source only; helpers.ts is a
 * fixed template reviewed with the code.
 */

export const ALLOWED_IMPORTS: readonly string[] = ["@playwright/test", "./helpers", "./run-data.json"];

const BANNED_IDENTIFIERS = new Set([
  "require",
  "eval",
  "Function",
  "globalThis",
  "global",
  "module",
  "exports",
  "Reflect",
  "Proxy",
  "WebAssembly",
  "constructor",
  "__proto__",
  "prototype",
  "evaluate",
  "evaluateAll",
  "evaluateHandle",
  "$eval",
  "$$eval",
  "addInitScript",
  "exposeFunction",
  "exposeBinding",
]);

const SECRET_ENV_NAME = /^SECRET_[A-Z][A-Z0-9_]{0,31}$/;

export class GeneratedSourceRejectedError extends Error {
  constructor(readonly violations: string[]) {
    super(`Generated test source rejected by the AST guard: ${violations.join("; ")}`);
    this.name = "GeneratedSourceRejectedError";
  }
}

/** `process.env.SECRET_<NAME>`, with `node` being its `process` identifier. */
function isSecretEnvAccess(node: ts.Identifier): boolean {
  const env = node.parent;
  if (!env || !ts.isPropertyAccessExpression(env) || env.expression !== node || env.name.text !== "env") return false;
  const secret = env.parent;
  return !!secret && ts.isPropertyAccessExpression(secret) && secret.expression === env && SECRET_ENV_NAME.test(secret.name.text);
}

function syntaxErrors(source: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName: "run.spec.ts",
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return diagnostics.map((d) => `syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

export function checkGeneratedSource(source: string): string[] {
  const syntax = syntaxErrors(source);
  if (syntax.length > 0) return syntax;

  const file = ts.createSourceFile("run.spec.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const at = (node: ts.Node, message: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`line ${line + 1}: ${message}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(file);
      if (!ALLOWED_IMPORTS.includes(specifier)) at(node, `import from ${JSON.stringify(specifier)} is not allowed`);
    } else if (ts.isImportEqualsDeclaration(node)) {
      at(node, "import = require() is not allowed");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      at(node, "re-export from a module is not allowed");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      at(node, "dynamic import() is not allowed");
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      at(node, "import.meta is not allowed");
    } else if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (!ts.isStringLiteral(key) && !ts.isNumericLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) {
        at(node, "computed member access is not allowed");
      } else if (BANNED_IDENTIFIERS.has(key.text) || key.text === "process") {
        at(node, `access to ${JSON.stringify(key.text)} is not allowed`);
      }
    } else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const name = node.text;
      if (BANNED_IDENTIFIERS.has(name)) at(node, `${name} is not allowed`);
      else if (name === "process" && !(ts.isIdentifier(node) && isSecretEnvAccess(node))) {
        at(node, "process is only allowed as process.env.SECRET_<NAME>");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

/** Throws GeneratedSourceRejectedError unless the source passes the guard. */
export function assertSafeSource(source: string): void {
  const violations = checkGeneratedSource(source);
  if (violations.length > 0) throw new GeneratedSourceRejectedError(violations);
}
