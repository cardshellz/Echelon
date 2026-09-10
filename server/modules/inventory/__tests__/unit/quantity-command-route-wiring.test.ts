import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const inventory = readFileSync(new URL("../../inventory.routes.ts", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../../../catalog/catalog.routes.ts", import.meta.url), "utf8");
function route(source: string, method: string, path: string): string {
  const start = source.indexOf(`app.${method}("${path}"`);
  expect(start, `Missing ${method} ${path}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n  app.", start);
  return source.slice(start, end < 0 ? undefined : end);
}

describe("quantity owner HTTP wiring ratchet", () => {
  it.each(["adjust", "adjust-stock", "receive", "add-stock", "transfer", "convert-sku", "break", "assemble"])(
    "forwards validated client intent for %s", path => {
      const handler = route(inventory, "post", `/api/inventory/${path}`);
      expect(handler).toContain("validateInventoryCommandKey");
      expect(handler).toContain("commandKey: req.body.commandKey");
      expect(handler).toContain("sendInventoryQuantityError(res, error)");
    });
  it.each(["/api/inventory/upload-csv", "/api/inventory/import-csv", "/api/inventory/lots/create-legacy",
    "/api/cogs/manual-entry", "/api/cogs/bulk-import"])("retires the unowned quantity writer %s after opening", path => {
    expect(route(inventory, "post", path)).toContain("requireLegacyQuantityImport");
  });
  it.each(["/api/products/:id/archive", "/api/product-variants/:id/archive", "/api/product-variants/:id/merge"])(
    "uses one atomic exact-lot SKU owner for %s", path => {
      const handler = route(catalog, "post", path);
      expect(handler).toContain("validateInventoryCommandKey");
      expect(handler).toContain("commandKey: req.body.commandKey");
      expect(handler).toContain("owner.execute(");
      expect(handler).toContain('actor: req.session.user?.id ?? ""');
      expect(handler).not.toContain("convertSku(");
      expect(handler).not.toContain("adjustInventory(");
    });
});
