import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { scanWriterTopology } from "../../../scripts/writer-ratchet/scan";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const composition = "server/modules/channels/shopify-staff-oauth.ts";
const provider = "server/modules/channels/adapters/shopify/shopify-staff-oauth.provider.ts";
const repository = "server/modules/channels/infrastructure/shopify-staff-oauth.repository.ts";
const vendorProvider = "server/modules/dropship/infrastructure/dropship-marketplace-oauth.providers.ts";
const table = "channels.shopify_oauth_authorizations";

/** A deliberately narrow static rule, not whole-program proof: parsed literal
 * import/export/require edges and token-endpoint literals. Aliases cannot evade
 * an import edge. Computed module names/URLs and dynamic SQL still need review.
 * Vendor OAuth is an existing, separate contract; it is not a staff exception.
 */
function boundaryViolations(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const failures = new Set<string>();
  function moduleEdge(specifier: string) {
    if (!specifier.startsWith(".")) return;
    let destination = posix.normalize(posix.join(posix.dirname(file), specifier));
    destination = destination.replace(/\.js$/, ".ts");
    if (!destination.endsWith(".ts")) destination += ".ts";
    if ((destination === provider || destination === repository) && file !== composition) {
      failures.add("private staff OAuth adapter imported outside public composition");
    }
  }
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) moduleEdge(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      moduleEdge(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      moduleEdge(node.arguments[0].text);
    }
    const literal = ts.isStringLiteralLike(node) ? node.text
      : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => span.literal.text).join("") : null;
    if (literal?.includes("/admin/oauth/access_token") && file !== provider && file !== vendorProvider) {
      failures.add("Shopify credential endpoint outside its staff or vendor provider");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...failures];
}

function productionFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (["__tests__", "node_modules", "fixtures"].includes(entry.name)) return [];
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return productionFiles(relative);
    return /\.(?:ts|tsx|js|cjs|mjs)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [relative] : [];
  });
}

function scanFixture(files: Record<string, string>) {
  const temporaryRoot = realpathSync(tmpdir());
  const temporary = mkdtempSync(join(temporaryRoot, "echelon-shopify-oauth-owner-"));
  try {
    mkdirSync(join(temporary, "shared/schema"), { recursive: true });
    mkdirSync(join(temporary, "server"), { recursive: true });
    mkdirSync(join(temporary, "scripts"), { recursive: true });
    writeFileSync(join(temporary, "shared/schema/channels.ts"), [
      'export const channelsSchema = pgSchema("channels");',
      'export const shopifyOAuthAuthorizations = channelsSchema.table("shopify_oauth_authorizations", {});',
    ].join("\n"));
    for (const [file, text] of Object.entries(files)) {
      const target = join(temporary, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return scanWriterTopology(temporary, { roots: ["server", "scripts"] }).writers[table] ?? [];
  } finally {
    // The only recursive deletion is the exact temporary directory created above.
    if (dirname(realpathSync(temporary)) !== temporaryRoot) throw new Error("Unexpected fixture cleanup target");
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe("staff Shopify OAuth private adapter and writer boundaries", () => {
  it("keeps actual private credential adapters behind Channels composition across server and scripts", () => {
    const failures = [...productionFiles("server"), ...productionFiles("scripts")].flatMap(file =>
      boundaryViolations(file, readFileSync(join(root, file), "utf8")).map(reason => ({ file, reason })));
    expect(failures).toEqual([]);
  });

  it.each([
    'import { exchangeShopifyStaffOAuthCode as alias } from "../modules/channels/adapters/shopify/shopify-staff-oauth.provider"; alias(config, code);',
    'import * as hidden from "../modules/channels/infrastructure/shopify-staff-oauth.repository";',
    'export * from "../modules/channels/adapters/shopify/shopify-staff-oauth.provider";',
    'const hidden = await import("../modules/channels/adapters/shopify/shopify-staff-oauth.provider.js");',
    'const hidden = require("../modules/channels/infrastructure/shopify-staff-oauth.repository");',
    'import hidden = require("../modules/channels/infrastructure/shopify-staff-oauth.repository");',
  ])("rejects direct, aliased, re-exported and literal dynamic private dependencies (%#)", source => {
    expect(boundaryViolations("server/routes/new-shopify-entry.ts", source)).toEqual([
      "private staff OAuth adapter imported outside public composition",
    ]);
  });

  it("permits composition, public-command callers and unrelated provider calls", () => {
    expect(boundaryViolations(composition,
      'import { exchangeShopifyStaffOAuthCode } from "./adapters/shopify/shopify-staff-oauth.provider";')).toEqual([]);
    expect(boundaryViolations("server/routes/shopify-oauth.routes.ts",
      'import { getShopifyStaffOAuthService } from "../modules/channels/shopify-staff-oauth";')).toEqual([]);
    expect(boundaryViolations("server/jobs/shopify-refresh.ts",
      'fetch(`https://${shop}/admin/api/2026-10/graphql.json`);')).toEqual([]);
  });

  it("rejects token exchanges in new routes or renamed jobs while allowing both existing provider owners", () => {
    const source = 'const url = `https://${shop}/admin/oauth/access_token`; await request(url);';
    for (const file of ["server/routes/new-oauth.ts", "server/jobs/renamed-refresh.ts", "scripts/repair-token.ts"]) {
      expect(boundaryViolations(file, source)).toEqual(["Shopify credential endpoint outside its staff or vendor provider"]);
    }
    expect(boundaryViolations(provider, source)).toEqual([]);
    expect(boundaryViolations(vendorProvider, source)).toEqual([]);
    expect(boundaryViolations("server/routes/ordinary.ts", '// fetch("/admin/oauth/access_token")')).toEqual([]);
  });

  it("proves the existing writer scanner admits the Channels owner with a table alias", () => {
    expect(scanFixture({ [repository]:
      'import {\n shopifyOAuthAuthorizations as challenge\n } from "@shared/schema"; tx.insert(challenge).values({});',
    })).toEqual(["modules/channels"]);
  });

  it.each([
    ["server/routes/alternate.ts", 'db.query(\'UPDATE "channels"."shopify_oauth_authorizations" SET status=1\');'],
    ["server/jobs/renamed.ts", 'import { shopifyOAuthAuthorizations as challenge } from "@shared/schema"; tx.delete(challenge);'],
    ["scripts/repair.ts", 'db.query("DELETE FROM channels.shopify_oauth_authorizations");'],
    ["server/modules/oms/hidden.ts", 'db.query("INSERT INTO channels.shopify_oauth_authorizations VALUES (1)");'],
  ])("proves an alternate challenge writer is detected at %s", (file, source) => {
    const writers = scanFixture({
      [repository]: 'db.query("INSERT INTO channels.shopify_oauth_authorizations VALUES (1)");',
      [file]: source,
    });
    expect(writers).toContain("modules/channels");
    expect(writers.filter(writer => writer !== "modules/channels")).toEqual([
      file.startsWith("server/modules/") ? "modules/oms" : file,
    ]);
  });
});
