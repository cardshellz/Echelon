import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0640_inventory_availability_claim_lineage.sql"),
  "utf8",
);
const repository = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts",
  ),
  "utf8",
);
const inventoryWriter = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts",
  ),
  "utf8",
);

describe("canonical inventory claim lineage contract", () => {
  it("persists whole-order, operation, resource, lot, command, and event evidence", () => {
    for (const table of [
      "availability_claims",
      "availability_claim_lines",
      "availability_claim_operations",
      "availability_claim_operation_inputs",
      "availability_claim_resources",
      "availability_claim_lot_allocations",
      "availability_claim_commands",
      "availability_claim_events",
    ]) {
      expect(migration).toContain(`CREATE TABLE inventory.${table}`);
    }
    expect(migration).toContain("availability_claims_one_active_order_uq");
    expect(migration).toContain("availability_claim_operations_parent_fk");
    expect(migration).toContain("availability_claim_resources_operation_fk");
    expect(migration).toContain("availability_claim_lot_allocations_resource_fk");
  });

  it("makes commands and events append-only and deployment inert", () => {
    expect(migration).toContain("reject_availability_claim_evidence_mutation");
    expect(migration).toContain("availability_claim_commands_append_only");
    expect(migration).toContain("availability_claim_events_append_only");
    expect(migration).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(migration).not.toMatch(/UPDATE\s+catalog\.products/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_levels/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_lots/i);
  });

  it("requires canonical authority and uses the documented deterministic lock order", () => {
    expect(repository).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(repository).toContain("CANONICAL_AUTHORITY_NOT_ACTIVE");
    expect(repository).toContain("TRANSFORMATION_MODEL_LOCK_NAMESPACE = 918422");
    expect(repository).toContain("LEGACY_RESERVATION_LOCK_NAMESPACE = 918410");
    expect(repository.indexOf("TRANSFORMATION_MODEL_LOCK_NAMESPACE, productId"))
      .toBeLessThan(repository.indexOf("LEGACY_RESERVATION_LOCK_NAMESPACE, productId"));
    expect(repository).toContain("ORDER BY warehouse_location_id, product_variant_id, id");
    expect(repository).toContain("ORDER BY warehouse_location_id, product_variant_id, received_at, id");
  });

  it("resolves order variants by active SKU and fails closed on conflicting stored identity", () => {
    expect(repository).toContain("upper(variant.sku) = upper(item.sku)");
    expect(repository).toContain("variant.is_active = true");
    expect(repository).toContain("item.status IN ('cancelled', 'completed', 'short')");
    expect(repository).toContain("ORDER_ITEM_VARIANT_IDENTITY_CONFLICT");
    expect(repository.indexOf("if (itemRequiresShipping === 0) continue"))
      .toBeLessThan(repository.indexOf("ORDER_ITEM_VARIANT_MISSING"));
  });

  it("requires exact FIFO ownership and guarded level/lot reservation writes", () => {
    expect(repository).not.toMatch(/UPDATE\s+inventory\.inventory_(levels|lots)/i);
    expect(repository).not.toMatch(/INSERT\s+INTO\s+inventory\.inventory_transactions/i);
    expect(inventoryWriter).toContain("CLAIM_LOT_SHORTFALL");
    expect(inventoryWriter).toContain("qty_reserved + $1 <= qty_on_hand");
    expect(inventoryWriter).toContain("reserved_qty + $1 <= variant_qty");
    expect(inventoryWriter).toContain("reference_type, reference_id");
    expect(inventoryWriter).toContain("'availability_claim'");
    expect(repository).toContain("CLAIM_RELEASE_LINEAGE_MISMATCH");
    expect(inventoryWriter).toContain("qty_reserved = qty_reserved - $1");
    expect(inventoryWriter).toContain("reserved_qty = reserved_qty - $1");
    expect(inventoryWriter).toContain("'availability_claim_release'");
  });
});
