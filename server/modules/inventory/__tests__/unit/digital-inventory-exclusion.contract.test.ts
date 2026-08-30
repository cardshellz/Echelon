import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const atp = read("../../atp.service.ts");

function method(name: string, nextName?: string): string {
  const start = atp.indexOf(`async ${name}(`);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  const end = nextName ? atp.indexOf(`async ${nextName}(`, start + 1) : atp.length;
  expect(end, `${nextName ?? "end of file"} must follow ${name}`).toBeGreaterThan(start);
  return atp.slice(start, end);
}

describe("digital inventory exclusion contract", () => {
  it.each([
    ["getTotalBaseUnits", "getAtpBase"],
    ["getAtpBaseByWarehouse", "getDirectVariantAtpByWarehouse"],
    ["getDirectVariantAtpByWarehouse", "getDirectVariantAtp"],
    ["getDirectVariantAtp", "getAtpPerVariantByWarehouse"],
    ["getAtpPerVariantByWarehouse", "getAtpPerVariant"],
    ["getAtpPerVariant", "getAtpForChannel"],
    ["getAtpForChannel", "getProductSummary"],
    ["getProductSummary", "getInventoryItemSummary"],
    ["getInventoryItemSummary", "getBulkAtp"],
    ["getBulkAtp", undefined],
  ] as const)("keeps %s behind fulfillment and tracking gates", (name, nextName) => {
    const source = method(name, nextName);
    expect(source).toMatch(/requiresShipping|requires_shipping/);
    expect(source).toMatch(/trackInventory|track_inventory/);
  });

  it("guards reservation and picking even when callers bypass ATP readers", () => {
    const reservation = read("../../../channels/reservation.service.ts");
    const picking = read("../../../orders/picking.use-cases.ts");
    const inventoryRoutes = read("../../inventory.routes.ts");
    expect(reservation).toContain(
      "variant.requiresShipping === false || variant.trackInventory === false",
    );
    expect(picking).toContain(
      "productVariant.requiresShipping === false || productVariant.trackInventory === false",
    );
    expect(inventoryRoutes).toContain("!isInventoryManagedVariant(variant)");
  });

  it("keeps unmanaged variants out of warehouse inventory views and searches", () => {
    const repository = read("../../infrastructure/inventory.repository.ts");
    expect(repository.match(/pv\.requires_shipping = true/g)).toHaveLength(7);
    expect(repository.match(/COALESCE\(pv\.track_inventory, true\) = true/g)).toHaveLength(7);
  });

  it("keeps digital variants out of channel inventory publication", () => {
    const sync = read("../../../channels/sync.service.ts");
    const orchestrator = read("../../../channels/echelon-sync-orchestrator.service.ts");
    const availability = read("../../../channels/variant-availability-sync.service.ts");
    expect(sync).toContain("isInventoryManagedVariant(variantRow)");
    expect(orchestrator).toContain("isInventoryManagedVariant(variant)");
    expect(availability).toContain("markVariantAvailabilityNotApplicable");
  });

  it("keeps digital variants out of allocation and new-listing inventory surfaces", () => {
    const channelStorage = read("../../../channels/channels.storage.ts");
    const channelRegistration = read(
      "../../../channels/adapters/ebay/ebay-marketplace-registration-owner.pg-repository.ts",
    );
    const dropshipRegistration = read(
      "../../../dropship/infrastructure/dropship-marketplace-registration-owner.repository.ts",
    );
    const dropshipPreview = read(
      "../../../dropship/infrastructure/dropship-listing-preview.repository.ts",
    );
    const dropshipSelection = read(
      "../../../dropship/infrastructure/dropship-selection-atp.repository.ts",
    );
    expect(channelStorage).toContain("eq(productVariants.requiresShipping, true)");
    expect(channelRegistration).toContain("isInventoryManagedVariant(row)");
    expect(dropshipRegistration).toContain("isInventoryManagedVariant({");
    expect(dropshipPreview).toContain("pv.requires_shipping = true");
    expect(dropshipPreview).toContain("COALESCE(pv.track_inventory, true) = true");
    expect(dropshipSelection).toContain('"pv.requires_shipping = true"');
    expect(dropshipSelection).toContain('"COALESCE(pv.track_inventory, true) = true"');
  });
});
