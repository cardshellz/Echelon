import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("legacy inventory admin route authority wiring", () => {
  it.each([
    ["post", "/api/channel-feeds/enable", "channelFeed"],
    ["post", "/api/channels", "legacyInventoryChannelControlFor"],
    ["put", "/api/channels/:id", "legacyInventoryChannelControlFor"],
    ["post", "/api/channel-reservations", "channelReserve"],
    ["delete", "/api/channel-reservations/:id", "channelReserve"],
    ["put", "/api/channel-product-allocation", "channelAllocation"],
    ["delete", "/api/channel-product-allocation/:id", "channelAllocation"],
    ["put", "/api/channels/:id/product-lines", "channelAllocation"],
    ["post", "/api/channel-warehouse-assignments", "channelWarehouseAssignment"],
    ["put", "/api/channel-warehouse-assignments/:id", "channelWarehouseAssignment"],
    ["delete", "/api/channel-warehouse-assignments/:id", "channelWarehouseAssignment"],
    ["post", "/api/channel-allocation-rules", "channelAllocation"],
    ["put", "/api/channel-allocation-rules/:id", "channelAllocation"],
    ["delete", "/api/channel-allocation-rules/:id", "channelAllocation"],
  ] as const)("gates %s %s before its legacy write", (method, path, control) => {
    const handler = routeHandler(
      source("server/modules/channels/channels.routes.ts"),
      method,
      path,
    );
    expect(handler).toContain("executeLegacyWrite");
    expect(handler).toContain(control);
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it.each([
    ["put", "/api/sync/channels/:channelId", "channelSync"],
    ["put", "/api/sync/warehouses/:warehouseId/feed", "channelWarehouseAssignment"],
  ] as const)("gates %s %s before its legacy configuration write", (method, path, control) => {
    const handler = routeHandler(
      source("server/modules/channels/sync-control.routes.ts"),
      method,
      path,
    );
    expect(handler).toContain("executeLegacyWrite");
    expect(handler).toContain(control);
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it("gates the legacy channel allocation writer exposed by Inventory routes", () => {
    const handler = routeHandler(
      source("server/modules/inventory/inventory.routes.ts"),
      "put",
      "/api/channels/:id/allocation",
    );
    expect(handler).toContain("executeLegacyWrite");
    expect(handler).toContain("INVENTORY_LEGACY_ADMIN_CONTROLS.channelAllocation");
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it("gates explicit inventoryStrategy when creating a product", () => {
    const handler = routeHandler(
      source("server/modules/catalog/catalog.routes.ts"),
      "post",
      "/api/products",
    );
    expect(handler).toContain("requestedLegacyInventoryStrategy");
    expect(handler).toContain("executeLegacyWrite");
    expect(handler).toContain("INVENTORY_LEGACY_ADMIN_CONTROLS.inventoryStrategy");
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it("pins authority and rejects only a changed inventoryStrategy when updating a product", () => {
    const handler = routeHandler(
      source("server/modules/catalog/catalog.routes.ts"),
      "put",
      "/api/products/:id",
    );
    expect(handler).toContain("requestedLegacyInventoryStrategy");
    expect(handler).toContain("executeGuardedLegacyWrite");
    expect(handler).toContain("currentProduct.inventoryStrategy === requestedInventoryStrategy");
    expect(handler).toContain("assertLegacyInventoryStrategyMutation");
    expect(handler).toContain("delete persistedUpdates.inventoryStrategy");
    expect(handler).toContain("INVENTORY_LEGACY_ADMIN_CONTROLS.inventoryStrategy");
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it.each([
    ["post", "/api/catalog/products"],
    ["post", "/api/inventory/items"],
  ] as const)("gates the legacy inventoryStrategy alias writer at %s %s", (method, path) => {
    const handler = routeHandler(
      source("server/modules/inventory/inventory.routes.ts"),
      method,
      path,
    );
    expect(handler).toContain("hasExplicitLegacyInventoryStrategy");
    expect(handler).toContain("executeLegacyWrite");
    expect(handler).toContain("INVENTORY_LEGACY_ADMIN_CONTROLS.inventoryStrategy");
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it("pins authority and rejects only a changed inventoryStrategy in the catalog alias updater", () => {
    const handler = routeHandler(
      source("server/modules/inventory/inventory.routes.ts"),
      "patch",
      "/api/catalog/products/:id",
    );
    expect(handler).toContain("hasExplicitLegacyInventoryStrategy");
    expect(handler).toContain("executeGuardedLegacyWrite");
    expect(handler).toContain("currentProduct.inventoryStrategy !== validatedData.inventoryStrategy");
    expect(handler).toContain("assertLegacyInventoryStrategyMutation");
    expect(handler).toContain("delete persistedData.inventoryStrategy");
    expect(handler).toContain("INVENTORY_LEGACY_ADMIN_CONTROLS.inventoryStrategy");
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it.each([
    ["/api/products/:productId/allocation", "getAtpBase"],
    ["/api/channel-allocation/grid", "getBulkAtp"],
  ] as const)("retires %s before its legacy-only ATP reader runs", (path, legacyReader) => {
    const handler = routeHandler(
      source("server/modules/channels/channels.routes.ts"),
      "get",
      path,
    );
    expect(handler).toContain("executeLegacyRead");
    expect(handler).toContain("INVENTORY_LEGACY_ADMIN_CONTROLS.channelAllocationRead");
    expect(handler).toContain(legacyReader);
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it("routes the backorder read to scalar ATP only in legacy and exact-SKU ATP in canonical", () => {
    const handler = routeHandler(
      source("server/modules/inventory/inventory.routes.ts"),
      "get",
      "/api/inventory/backorder-status/:itemId",
    );
    expect(handler).toContain("executeAuthorityAwareRead");
    expect(handler).toContain("storage.getProductVariantById(itemId, transaction)");
    expect(handler).toContain("context.legacy.getAtpBase");
    expect(handler).toContain("projectCanonicalVariantsInsideRuntimeTransaction");
    expect(handler).toContain("legacy: (transaction, context)");
    expect(handler).toContain("canonical: (transaction, context)");
    expect(handler).not.toContain("req.app.locals.services.atp");
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it("routes warehouse summaries through the authority-aware projection boundary", () => {
    const handler = routeHandler(
      source("server/modules/inventory/inventory.routes.ts"),
      "get",
      "/api/inventory/summary",
    );
    const authorityPinnedProjection = between(
      handler,
      "const readWarehouseSummary",
      "const summaries = await inventoryLegacyAdminControl.executeAuthorityAwareRead",
    );
    expect(handler).toContain("executeAuthorityAwareRead");
    expect(handler).toContain('readWarehouseSummary("legacy", transaction, context)');
    expect(handler).toContain('readWarehouseSummary("canonical", transaction, context)');
    expect(authorityPinnedProjection).toContain("storage.getAllWarehouseLocations(transaction)");
    expect(authorityPinnedProjection).toContain("storage.getAllInventoryLevels(transaction)");
    expect(authorityPinnedProjection).toContain("storage.getAllProductVariants(false, transaction)");
    expect(authorityPinnedProjection).toContain("storage.getAllProducts(false, transaction)");
    expect(authorityPinnedProjection).toContain("context.legacy");
    expect(authorityPinnedProjection).toContain("projectCanonicalVariantsInsideRuntimeTransaction");
    expect(authorityPinnedProjection).toContain("projectWarehouseInventorySummary");
    expect(authorityPinnedProjection).not.toContain("req.app.locals.services.atp");
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
  });

  it("retires legacy channel-feed divergence instead of comparing it to canonical ATP", () => {
    const handler = routeHandler(
      source("server/modules/inventory/inventory.routes.ts"),
      "get",
      "/api/channel-sync/divergence",
    );
    expect(handler).toContain("executeLegacyRead");
    expect(handler).toContain("INVENTORY_LEGACY_ADMIN_CONTROLS.channelFeedRead");
    expect(handler).toContain("createChannelSyncService(transaction, context.legacy)");
    expect(handler).toContain("sendInventoryLegacyAdminControlError");
    expect(handler).not.toContain("req.app.locals.services.channelSync");
  });
});

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function routeHandler(contents: string, method: string, path: string): string {
  const marker = `app.${method}("${path}"`;
  const start = contents.indexOf(marker);
  if (start < 0) throw new Error(`Missing route ${method.toUpperCase()} ${path}`);
  const next = contents.indexOf("\n  app.", start + marker.length);
  return contents.slice(start, next < 0 ? contents.length : next);
}

function between(contents: string, startMarker: string, endMarker: string): string {
  const start = contents.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing start marker: ${startMarker}`);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing end marker: ${endMarker}`);
  return contents.slice(start, end);
}
