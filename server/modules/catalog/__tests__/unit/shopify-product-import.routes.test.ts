import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routes = readFileSync(
  resolve(process.cwd(), "server/routes/shopify.routes.ts"),
  "utf8",
).replace(/\r\n/g, "\n");
const productsPage = readFileSync(
  resolve(process.cwd(), "client/src/pages/Products.tsx"),
  "utf8",
);
const shopifyPage = readFileSync(
  resolve(process.cwd(), "client/src/pages/ShopifyChannelPage.tsx"),
  "utf8",
);

describe("Shopify product import HTTP boundary", () => {
  it("requires inventory edit permission for both catalog-mutating sync routes", () => {
    expect(routes).toMatch(
      /app\.post\("\/api\/shopify\/sync", requirePermission\("inventory", "edit"\)/,
    );
    expect(routes).toMatch(
      /app\.post\("\/api\/shopify\/sync-products", requirePermission\("inventory", "edit"\)/,
    );
  });

  it("delegates the combined command to one service owner", () => {
    const productSyncRoute = routes.slice(
      routes.indexOf('app.post("/api/shopify/sync-products"'),
      routes.indexOf('// Sync from oms_orders/oms_order_lines'),
    );
    expect(productSyncRoute).toContain("productImport.syncProductsAndContent()");
    expect(productSyncRoute).not.toContain("syncContentAndAssets");
  });

  it("disables both sync controls without the same inventory edit ability", () => {
    for (const page of [productsPage, shopifyPage]) {
      expect(page).toContain('hasPermission("inventory", "edit")');
      expect(page).toContain("!canSyncShopifyCatalog");
    }
  });
});
