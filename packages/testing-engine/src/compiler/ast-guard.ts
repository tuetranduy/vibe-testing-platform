import ts from "typescript";
import { NAMEABLE_ROLES } from "../shared/locator-policy";
import { HELPER_EXPORTS } from "./helpers-template";

/**
 * AST guard (Task 16): the last check a generated `run.spec.ts` must pass — when the compiler returns
 * it, and whenever a later stage re-checks a source read back from storage. The compiler emits a tiny
 * grammar (D11: compiler-chosen identifiers, criterion ids and fixed template text), so the guard is
 * an allowlist of that grammar, not a denylist of known escapes. Parsed with TypeScript; rejected:
 *
 * - syntax errors;
 * - imports other than `{ expect, test }` from `@playwright/test`, the fixed helpers from `./helpers`
 *   and the default `data` from `./run-data.json` (no aliases); `import x = require()`, exports,
 *   dynamic `import()`, `import.meta`;
 * - any identifier outside the template's vocabulary (`ALLOWED_IDENTIFIERS`, the helpers, and the
 *   compiler's numbered names `factN` / `locN` / `itemN` / `inputN` / `urlN`): no `require`, `arguments`,
 *   `Object`, `fetch`, `globalThis`, `constructor`, `evaluate`, `__dirname`, `Buffer`, …;
 * - any string literal outside the fixed set (import paths, the test title, `"[AC-n] "` prefixes,
 *   criterion ids, allow-listed ARIA roles, regex flags, match modes, the load state); no template
 *   literals or regex literals;
 * - element access other than `data.criteria["AC-n"]`;
 * - `process` anywhere except `secret(process.env.SECRET_<NAME>)` as the whole argument of a `fill`.
 *
 * Returns human-readable violations (empty = accepted). It judges run.spec.ts only; helpers.ts is a
 * fixed template reviewed with the code (and legitimately runs page scripts).
 */

export const ALLOWED_IMPORTS: readonly string[] = ["@playwright/test", "./helpers", "./run-data.json"];

const PLAYWRIGHT_IMPORTS = new Set(["expect", "test"]);
const DATA_IMPORT = "data";

/** Every identifier the compiler's template uses (globals, locals, properties, option keys). */
export const ALLOWED_IDENTIFIERS: ReadonlySet<string> = new Set([
  // imports, locals, globals
  "expect", "test", "data", "page", "softExpect", "message", "Number", "NaN", "RegExp",
  // run data
  "targetUrl", "urls", "locators", "items", "inputs", "criteria", "statement", "name", "text", "value", "selector",
  "pattern", "item", "delta", "right",
  // page and locators
  "goto", "click", "fill", "selectOption", "getByRole", "getByLabel", "getByPlaceholder", "getByText", "getByTestId",
  "locator", "url", "waitForLoadState", "timeout", "catch", "exact",
  // test and expect
  "step", "configure", "soft", "poll", "not", "ignoreCase", "useInnerText",
  "toBeNull", "toBeVisible", "toBeHidden", "toHaveText", "toContainText", "toMatch", "toBe", "toContain", "toBeCloseTo",
  "toBeGreaterThan", "toBeGreaterThanOrEqual", "toBeLessThan", "toBeLessThanOrEqual",
  ...HELPER_EXPORTS,
]);

/** The compiler's numbered names: saved facts, and run-data keys. */
const NUMBERED_IDENTIFIER = /^(?:fact|loc|item|input|url)[1-9]\d{0,3}$/;
const SECRET_ENV_NAME = /^SECRET_[A-Z][A-Z0-9_]{0,31}$/;
const CRITERION_ID = /^AC-\d{1,3}$/;
const CRITERION_PREFIX = /^\[AC-\d{1,3}\] $/;
/** A multi-scenario test's title (V1.1 F9): fixed text and a schema-checked scenario id. */
const SCENARIO_TITLE = /^scenario SC-[1-5]$/;

const ALLOWED_STRINGS: ReadonlySet<string> = new Set([
  ...ALLOWED_IMPORTS,
  "discovered flow",
  "load",
  "networkidle",
  "",
  "i",
  "contains",
  "equals",
  ...NAMEABLE_ROLES,
]);

export class GeneratedSourceRejectedError extends Error {
  constructor(readonly violations: string[]) {
    super(`Generated test source rejected by the AST guard: ${violations.join("; ")}`);
    this.name = "GeneratedSourceRejectedError";
  }
}

const isIdentifierNamed = (node: ts.Node | undefined, name: string): boolean => !!node && ts.isIdentifier(node) && node.text === name;

/** `<locator>.fill(secret(process.env.SECRET_<NAME>))`, with `node` being its `process` identifier. */
function isSecretFill(node: ts.Identifier): boolean {
  const env = node.parent;
  if (!env || !ts.isPropertyAccessExpression(env) || env.expression !== node || env.name.text !== "env") return false;
  const access = env.parent;
  if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== env || !SECRET_ENV_NAME.test(access.name.text)) return false;
  const secretCall = access.parent;
  if (!secretCall || !ts.isCallExpression(secretCall) || !isIdentifierNamed(secretCall.expression, "secret")) return false;
  if (secretCall.arguments.length !== 1 || secretCall.arguments[0] !== access) return false;
  const fill = secretCall.parent;
  return (
    !!fill &&
    ts.isCallExpression(fill) &&
    ts.isPropertyAccessExpression(fill.expression) &&
    fill.expression.name.text === "fill" &&
    fill.arguments.length === 1 &&
    fill.arguments[0] === secretCall
  );
}

/** `env` / `SECRET_<NAME>` are allowed only as the property names of `process.env.SECRET_<NAME>`. */
function isSecretEnvPart(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent || !ts.isPropertyAccessExpression(parent) || parent.name !== node) return false;
  if (node.text === "env") return isIdentifierNamed(parent.expression, "process");
  return (
    SECRET_ENV_NAME.test(node.text) &&
    ts.isPropertyAccessExpression(parent.expression) &&
    parent.expression.name.text === "env" &&
    isIdentifierNamed(parent.expression.expression, "process")
  );
}

function syntaxErrors(source: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName: "run.spec.ts",
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return diagnostics.map((d) => `syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

/** Import names allowed per module; null = the JSON default import. */
function checkImport(node: ts.ImportDeclaration, at: (node: ts.Node, message: string) => void, file: ts.SourceFile): void {
  const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(file);
  if (!ALLOWED_IMPORTS.includes(specifier)) return at(node, `import from ${JSON.stringify(specifier)} is not allowed`);
  const clause = node.importClause;
  if (!clause) return at(node, `side-effect import of ${JSON.stringify(specifier)} is not allowed`);
  if (specifier === "./run-data.json") {
    if (clause.name?.text !== DATA_IMPORT || clause.namedBindings) at(node, `only "import ${DATA_IMPORT} from './run-data.json'" is allowed`);
    return;
  }
  const allowed = specifier === "@playwright/test" ? PLAYWRIGHT_IMPORTS : new Set(HELPER_EXPORTS);
  if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
    return at(node, `only named imports from ${JSON.stringify(specifier)} are allowed`);
  }
  for (const element of clause.namedBindings.elements) {
    if (element.propertyName || !allowed.has(element.name.text)) {
      at(element, `import of ${JSON.stringify(element.getText(file))} from ${JSON.stringify(specifier)} is not allowed`);
    }
  }
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
      checkImport(node, at, file);
      return; // its specifiers and path are judged by checkImport
    }
    if (ts.isImportEqualsDeclaration(node)) {
      at(node, "import = require() is not allowed");
    } else if (ts.isExportDeclaration(node) || ts.isExportAssignment(node)) {
      at(node, "export is not allowed");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      at(node, "dynamic import() is not allowed");
    } else if (ts.isMetaProperty(node)) {
      at(node, "import.meta / new.target is not allowed");
    } else if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTaggedTemplateExpression(node)) {
      at(node, "template literals are not allowed");
      return;
    } else if (ts.isRegularExpressionLiteral(node)) {
      at(node, "regular expression literals are not allowed");
    } else if (ts.isStringLiteral(node)) {
      const s = node.text;
      if (!ALLOWED_STRINGS.has(s) && !CRITERION_PREFIX.test(s) && !CRITERION_ID.test(s) && !SCENARIO_TITLE.test(s)) {
        at(node, `string literal ${JSON.stringify(s)} is not allowed`);
      }
    } else if (ts.isElementAccessExpression(node)) {
      const target = node.expression;
      const key = node.argumentExpression;
      const criteria =
        ts.isPropertyAccessExpression(target) && target.name.text === "criteria" && isIdentifierNamed(target.expression, DATA_IMPORT);
      if (!criteria || !ts.isStringLiteral(key) || !CRITERION_ID.test(key.text)) {
        at(node, 'computed member access is only allowed as data.criteria["AC-n"]');
      }
    } else if (ts.isPrivateIdentifier(node)) {
      at(node, `${node.text} is not allowed`);
    } else if (ts.isIdentifier(node)) {
      const name = node.text;
      if (name === "process") {
        if (!isSecretFill(node)) at(node, "process is only allowed as <locator>.fill(secret(process.env.SECRET_<NAME>))");
      } else if (name === "env" || SECRET_ENV_NAME.test(name)) {
        if (!isSecretEnvPart(node)) at(node, `${name} is only allowed in process.env.SECRET_<NAME>`);
      } else if (!ALLOWED_IDENTIFIERS.has(name) && !NUMBERED_IDENTIFIER.test(name)) {
        at(node, `identifier ${JSON.stringify(name)} is not allowed`);
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
