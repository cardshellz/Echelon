import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("promise safety administration contract", () => {
  it("role-gates view and every mutation with inventory-planning abilities", () => {
    const routes = source(
      "server/modules/inventory-planning/interfaces/http/inventory-availability-master-data.routes.ts",
    );
    expect(routes).toMatch(
      /promise-safety\/:productId"[\s\S]*?requirePermission\("inventory_planning", "view"\)/,
    );
    expect(routes).toMatch(
      /promise-safety-policies\/drafts\/:policyId"[\s\S]*?requirePermission\("inventory_planning", "edit"\)/,
    );
    expect(routes).toMatch(
      /demand-evidence\/refresh"[\s\S]*?requirePermission\("inventory_planning", "edit"\)/,
    );
  });

  it("derives demand only from physical shipment, ship-ledger gap, and posted component evidence", () => {
    const repository = source(
      "server/modules/inventory-planning/infrastructure/inventory-promise-safety-admin.repository.ts",
    );
    expect(repository).toContain("FROM wms.effective_physical_shipment_items AS item");
    expect(repository).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect(repository).toContain("AND requires_shipping = true");
    expect(repository).toContain("AND COALESCE(track_inventory, true) = true");
    expect(repository).toContain("UPPER(item_sku_variant.sku) = UPPER(item.sku)");
    expect(repository).toContain("item.shipment_item_purpose <> 'omission_correction'");
    expect(repository).toContain("package.status IN ('shipped', 'returned', 'review')");
    expect(repository).toContain("inventory_tx.transaction_type = 'ship'");
    expect(repository).toContain("physical_item.id IS NULL");
    expect(repository).toContain("legacy_item.product_variant_id");
    expect(repository).toContain("FROM inventory.build_run_consumptions AS consumption");
    expect(repository).toContain("run.status = 'posted'");
    expect(repository).not.toContain("transaction_type = 'transfer'");
  });

  it("keeps the UI explicit that safety writes are shadow-only", () => {
    const page = source("client/src/pages/promise-safety-policy-panel.tsx");
    expect(page).toContain("Values saved here are drafts used by");
    expect(page).toContain("shadow planning only");
    expect(page).toContain("Runtime ATP is unchanged");
    expect(page).toContain("The system classifies evidence; this is not an operator toggle");
  });
});
