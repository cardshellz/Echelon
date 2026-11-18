import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ALLOWED_EAGER_PAGE_IMPORTS = new Set([
  "@/pages/not-found",
]);

describe("App.tsx route-level code splitting", () => {
  const appPath = resolve(process.cwd(), "client/src/App.tsx");
  const appSource = readFileSync(appPath, "utf8");
  const ast = ts.createSourceFile(appPath, appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  it("keeps only not-found as an eager @/pages/* import so route bundles split cleanly", () => {
    const eagerPageImports: string[] = [];
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      if (statement.importClause?.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith("@/pages/") && !ALLOWED_EAGER_PAGE_IMPORTS.has(specifier)) {
        eagerPageImports.push(specifier);
      }
    }
    expect(eagerPageImports).toEqual([]);
  });

  it("uses literal import() specifiers inside React.lazy so browser-suite-impact AST resolution stays exact", () => {
    const dynamicPageImports: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        expect(node.arguments.length).toBe(1);
        expect(ts.isStringLiteralLike(node.arguments[0]!)).toBe(true);
        if (ts.isStringLiteralLike(node.arguments[0]!)) {
          dynamicPageImports.push(node.arguments[0]!.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(dynamicPageImports.length).toBeGreaterThanOrEqual(95);
    expect(appSource).toContain("<React.Suspense");
  });
});
