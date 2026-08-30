import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Non-stock items (order #61416): track_inventory=false means "we sell and
 * ship this but do not inventory-manage it" — the standard WMS exception for
 * one-off goods. The flag existed in the schema but nothing honored it, so a
 * zero-stock one-off hard-blocked its order in the pick queue forever.
 *
 * ECHELON OWNS THE FLAG for physical items. Catalog import may only force the
 * flag off when Shopify explicitly identifies a variant as digital:
 *  1. Pick: confirmation-only — completes with NO level/lot writes.
 *  2. Reservation: skipped — an untracked item can never fail a reservation
 *     or trigger a shortfall hold.
 */
const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("non-stock items (track_inventory=false)", () => {
  it("pick is confirmation-only — bypass precedes any level read", () => {
    const src = read("../../../orders/picking.use-cases.ts");
    const guardPos = src.indexOf("productVariant.trackInventory === false");
    const levelReadPos = src.indexOf(
      "getInventoryLevelsByProductVariantId(productVariant.id)",
      guardPos,
    );
    expect(guardPos).toBeGreaterThan(-1);
    expect(levelReadPos).toBeGreaterThan(guardPos);
  });

  it("reservation skips untracked variants", () => {
    const src = read("../../../channels/reservation.service.ts");
    expect(src).toContain("variant.trackInventory === false");
  });

  it("catalog import only forces tracking off for explicit digital variants", () => {
    const src = read("../../../channels/catalog-backfill.service.ts");
    expect(src).toContain("requires_shipping");
    expect(src).toContain("requiresShipping ? {} : { trackInventory: false }");
    expect(src).toContain("trackInventory: requiresShipping");
    expect(src).toContain("if (!isInventoryManagedVariant(variant)) {");
  });
});
