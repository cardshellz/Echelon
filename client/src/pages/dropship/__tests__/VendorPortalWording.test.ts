import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Wording guard for the vendor portal (cardshellz.io).
 *
 * Vendors are eBay sellers, not engineers. Words that only make sense to the
 * people who build or run the system must never reach a vendor page. The guard
 * reads the text a vendor can see — string literals, template text and JSX
 * text — not identifiers, so code may still call an idempotency key by its
 * name while no vendor ever reads the words.
 */
const BANNED_VENDOR_WORDS = /smoke|dogfood|idempotency|request hash|phase 2|\bOMS\b|payload|API request failed/i;

const pagesRoot = join(__dirname, "..");

function vendorPageFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : vendorPageFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every piece of text in a file that could be shown, with its line number. */
function visibleTextOf(source: string, fileName: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    // Module paths are code, not words a vendor reads.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      const text = ts.isJsxText(node) ? node.getText(file) : node.text;
      if (text.trim()) found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("vendor portal wording", () => {
  it("finds the text in string literals, templates and JSX, but not in identifiers", () => {
    const sample = [
      'import { createDropshipIdempotencyKey } from "@/lib/x";',
      "const idempotencyKey = createDropshipIdempotencyKey('order');",
      "const a = `Ready for ${'x'} smoke testing`;",
      "const b = <p>Phase 2 surfaces</p>;",
    ].join("\n");
    const texts = visibleTextOf(sample, "sample.tsx").map((entry) => entry.text).join("|");
    expect(texts).not.toMatch(/idempotency/i);
    expect(texts).toMatch(/smoke testing/);
    expect(texts).toMatch(/Phase 2 surfaces/);
  });

  it("never shows engineering words on a vendor page", () => {
    const files = vendorPageFiles(pagesRoot);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.flatMap((path) =>
      visibleTextOf(readFileSync(path, "utf8"), path)
        .filter((entry) => BANNED_VENDOR_WORDS.test(entry.text))
        .map((entry) => `${relative(pagesRoot, path)}:${entry.line}: ${entry.text.trim()}`));
    expect(offenders).toEqual([]);
  });
});
