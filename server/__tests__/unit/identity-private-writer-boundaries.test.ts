import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const owner = "server/modules/identity/";
const privateWriters = new Set([
  `${owner}infrastructure/identity.repository.ts`,
  `${owner}infrastructure/access-administration.repository.ts`,
]);

/** Same narrow parsed-edge approach as the staff OAuth boundary guard. Import
 * aliases and re-exports cannot hide a literal dependency. Computed module names,
 * reflection, direct SQL and business semantics still require separate review/tests.
 * Identity's public API is intentionally allowed; its exports need owner review.
 */
function privateWriterImports(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations = new Set<string>();
  function edge(specifier: string) {
    const clean = specifier.replace(/[?#].*$/, "");
    let destination: string;
    if (clean.startsWith(".")) destination = posix.join(posix.dirname(file), clean);
    else if (clean.startsWith("@/")) destination = posix.join("client/src", clean.slice(2));
    else if (clean.startsWith("@shared/")) destination = posix.join("shared", clean.slice(8));
    else return;
    destination = posix.normalize(destination).replace(/\.[cm]?js$/, ".ts");
    if (!/\.[cm]?tsx?$/.test(destination)) destination += ".ts";
    if (privateWriters.has(destination) && !file.startsWith(owner)) violations.add(destination);
  }
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) edge(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      edge(node.moduleReference.expression.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) edge(node.argument.literal.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) edge(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...violations].sort();
}

function productionFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (["__tests__", "node_modules", "dist", "build"].includes(entry.name)) return [];
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return productionFiles(file);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [file] : [];
  });
}

describe("Identity private access-writer imports", () => {
  it("keeps production server/client/scripts entrypoints behind the public Identity commands", () => {
    const failures = ["server", "client/src", "scripts"].flatMap(productionFiles).flatMap(file =>
      privateWriterImports(file, readFileSync(join(root, file), "utf8")).map(destination => ({ file, destination })));
    expect(failures).toEqual([]);
  });

  it.each([
    'import { assignUserRoles as hidden } from "../modules/identity/infrastructure/identity.repository";',
    'import * as hidden from "../modules/identity/infrastructure/access-administration.repository";',
    'export { assignUserRoles as publicName } from "../modules/identity/infrastructure/identity.repository";',
    'export * from "../modules/identity/infrastructure/access-administration.repository.js";',
    'const hidden = await import("../modules/identity/infrastructure/identity.repository");',
    'const hidden = require("../modules/identity/infrastructure/identity.repository");',
    'import hidden = require("../modules/identity/infrastructure/identity.repository");',
    'type Hidden = typeof import("../modules/identity/infrastructure/identity.repository");',
    'import hidden from "../modules/identity/../identity/infrastructure/identity.repository.ts?raw";',
  ])("rejects literal direct/alias/re-export/dynamic dependencies (%#)", source => {
    expect(privateWriterImports("server/jobs/new-access-job.ts", source)).toHaveLength(1);
  });

  it.each([
    ["scripts/renamed-provisioner.mjs", 'import "../server/modules/identity/infrastructure/identity.repository";'],
    ["client/src/features/renamed/access.tsx", 'import "../../../../server/modules/identity/infrastructure/access-administration.repository";'],
    ["client/src/access.tsx", 'import "@/../../server/modules/identity/infrastructure/identity.repository";'],
    ["server/modules/oms/new-role-helper.ts", 'import "../identity/infrastructure/identity.repository";'],
  ])("rejects private access from alternate root %s", (file, source) => {
    expect(privateWriterImports(file, source)).toHaveLength(1);
  });

  it("allows the owning module, public commands/readers, unrelated imports and comments", () => {
    expect(privateWriterImports(`${owner}application/identity.use-cases.ts`,
      'import { assignUserRoles } from "../infrastructure/identity.repository";')).toEqual([]);
    expect(privateWriterImports("server/jobs/staff-job.ts",
      'import { assignUserRoles } from "../modules/identity";')).toEqual([]);
    expect(privateWriterImports("server/modules/shipping/command.ts",
      'import { readStaffSystemRoleAuthorityPg } from "../identity/staff-authority";')).toEqual([]);
    expect(privateWriterImports("server/jobs/other.ts",
      '// import "../modules/identity/infrastructure/identity.repository";\nimport { readFile } from "node:fs";')).toEqual([]);
  });
});
