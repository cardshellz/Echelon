import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
const root = join(dirname(fileURLToPath(import.meta.url)),"../../../../..");
const participant = "server/modules/orders/shipment-order-context.query.ts";
const owner = "server/modules/shipping/outbound-shipment-access.query.ts";
/** A same-transaction projection is private, not an arbitrary-order API.
 * Parsed literal edges cover aliases/re-exports and require/import expressions.
 * Reflection/computed names and SQL/business semantics still require review.
 */
function forbiddenEdges(file: string, text: string) {
  const source = ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const found: string[] = [];
  function edge(specifier: string) {
    const clean = specifier.replace(/[?#].*$/,"");
    const resolved = clean.startsWith(".") ? posix.join(posix.dirname(file),clean)
      : clean.startsWith("@/") ? posix.join("client/src",clean.slice(2))
      : clean.startsWith("@shared/") ? posix.join("shared",clean.slice(8)) : null;
    if (!resolved) return;
    let destination = posix.normalize(resolved).replace(/\.[cm]?js$/,".ts");
    if (!/\.[cm]?tsx?$/.test(destination)) destination += ".ts";
    if (destination === participant && file !== owner && file !== participant) found.push(destination);
  }
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) edge(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) edge(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) edge(node.argument.literal.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) edge(node.moduleReference.expression.text);
    ts.forEachChild(node,visit);
  }
  visit(source); return found;
}
function files(directory: string): string[] {
  return readdirSync(join(root,directory),{ withFileTypes: true }).flatMap(entry => {
    if (["__tests__","node_modules","dist","build"].includes(entry.name)) return [];
    const file = directory+"/"+entry.name;
    return entry.isDirectory() ? files(file) : /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [file] : [];
  });
}
describe("private shipment order-context participant", () => {
  it("only permits the authorized shipment query to consume the projection", () => {
    const rootEntries = readdirSync(root,{ withFileTypes: true }).filter(entry => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)).map(entry => entry.name);
    expect([...rootEntries,...["server","client/src","scripts","script"].flatMap(files)].flatMap(file => forbiddenEdges(file,readFileSync(join(root,file),"utf8")).map(target => ({ file,target })))).toEqual([]);
  });
  it.each([
    'import { readShipmentLinkedOrderSummary as alias } from "../modules/orders/shipment-order-context.query";',
    'export * from "../modules/orders/shipment-order-context.query.js";',
    'const alias = await import("../modules/orders/shipment-order-context.query");',
    'const alias = require("../modules/orders/shipment-order-context.query");',
    'type Alias = typeof import("../modules/orders/shipment-order-context.query");',
    'import Alias = require("../modules/orders/shipment-order-context.query");',
    'import "@/../../server/modules/orders/shipment-order-context.query";',
    'import "@shared/../server/modules/orders/shipment-order-context.query";',
  ])("rejects an alternate entrypoint or re-export %#", text => {
    expect(forbiddenEdges("server/routes/new-order-route.ts",text)).toEqual([participant]);
  });
  it.each(["script/renamed-helper.ts","new-root-entry.cjs"])("rejects literal private access from alternate executable root %s",file => {
    const specifier = file.includes("/") ? "../server/modules/orders/shipment-order-context.query" : "./server/modules/orders/shipment-order-context.query";
    expect(forbiddenEdges(file,`import "${specifier}";`)).toEqual([participant]);
  });
  it("allows the verified caller, unrelated code and comments", () => {
    expect(forbiddenEdges(owner,'import { readShipmentLinkedOrderSummary } from "../orders/shipment-order-context.query";')).toEqual([]);
    expect(forbiddenEdges("server/jobs/other.ts",'// import "../modules/orders/shipment-order-context.query";')).toEqual([]);
  });
});
