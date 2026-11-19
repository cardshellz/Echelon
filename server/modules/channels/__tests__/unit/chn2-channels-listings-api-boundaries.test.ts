import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as channelsIndex from "../../index";
import * as productIdentityApi from "../../product-identity.api";
import * as ebayMaintenanceEvidenceApi from "../../ebay-maintenance-evidence.api";
import * as shopifyIdentityApi from "../../shopify-identity.api";
import * as ebayConnectorApi from "../../ebay-connector.api";
import * as marketplaceListingsIndex from "../../../marketplace-listings/index";
import * as ebayRegistrationApi from "../../../marketplace-listings/ebay-registration.api";
import * as channelSyncBatchApi from "../../../marketplace-listings/channel-sync-batch.api";
import * as listingReplacementApi from "../../../marketplace-listings/listing-replacement.api";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const MODULES_ROOT = path.join(REPO_ROOT, "server/modules");

function collectModuleSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      collectModuleSourceFiles(full, out);
    } else if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function extractModuleSpecifiers(filePath: string): string[] {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

describe("CHN-2 Sales Channels & Marketplace Listings Internal API Boundaries (CI-03)", () => {
  it("forbids peer modules from importing channels/infrastructure/*, channels/adapters/*, channels/*.repository, or channels/*.storage directly", () => {
    const files = collectModuleSourceFiles(MODULES_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const relImporter = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (relImporter.startsWith("server/modules/channels/")) continue;

      for (const spec of extractModuleSpecifiers(file)) {
        if (!spec.startsWith(".")) continue;
        const resolved = path
          .relative(REPO_ROOT, path.resolve(path.dirname(file), spec))
          .replace(/\\/g, "/");

        if (
          resolved.startsWith("server/modules/channels/infrastructure/") ||
          resolved.startsWith("server/modules/channels/adapters/") ||
          (resolved.startsWith("server/modules/channels/") &&
            (resolved.endsWith(".repository") || resolved.endsWith(".storage")))
        ) {
          violations.push(`${relImporter} -> ${resolved} (${spec})`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("forbids peer modules from importing marketplace-listings/infrastructure/* directly", () => {
    const files = collectModuleSourceFiles(MODULES_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const relImporter = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (relImporter.startsWith("server/modules/marketplace-listings/")) continue;

      for (const spec of extractModuleSpecifiers(file)) {
        if (!spec.startsWith(".")) continue;
        const resolved = path
          .relative(REPO_ROOT, path.resolve(path.dirname(file), spec))
          .replace(/\\/g, "/");

        if (resolved.startsWith("server/modules/marketplace-listings/infrastructure/")) {
          violations.push(`${relImporter} -> ${resolved} (${spec})`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("exposes explicit .api.ts facades on channels and marketplace-listings barrels without leaking raw channelCatalogMethods", () => {
    expect("channelCatalogMethods" in channelsIndex).toBe(false);
    expect(typeof channelsIndex.channelsStorage).toBe("object");
    expect(typeof productIdentityApi.upsertChannelProductIdentity).toBe("function");
    expect(typeof productIdentityApi.removeChannelProductIdentities).toBe("function");
    expect(typeof ebayMaintenanceEvidenceApi.PostgresEbayLegacyMaintenanceEvidenceReader).toBe("function");
    expect(typeof shopifyIdentityApi.ShopifyIdentityReader).toBe("function");
    expect(typeof ebayConnectorApi.EbayApiClient).toBe("function");
    expect(typeof ebayConnectorApi.EbayAuthService).toBe("function");
    expect(typeof ebayConnectorApi.readEbayPublishedContent).toBe("function");

    expect(typeof ebayRegistrationApi.EbayMarketplaceRegistrationObserver).toBe("function");
    expect(typeof ebayRegistrationApi.FetchEbayRegistrationReadTransport).toBe("function");
    expect(typeof ebayRegistrationApi.buildEbayRegistrationIdentityNamespace).toBe("function");
    expect(typeof channelSyncBatchApi.PostgresChannelSyncBatchRepository).toBe("function");
    expect(typeof listingReplacementApi.PgMarketplaceListingRegistrationRepository).toBe("function");
    expect(marketplaceListingsIndex.EbayMarketplaceRegistrationObserver).toBe(
      ebayRegistrationApi.EbayMarketplaceRegistrationObserver,
    );
    expect(marketplaceListingsIndex.PostgresChannelSyncBatchRepository).toBe(
      channelSyncBatchApi.PostgresChannelSyncBatchRepository,
    );
  });
});
