import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0642_inventory_availability_claim_execution_contract.sql"),
  "utf8",
);
const planner = readFileSync(
  resolve(process.cwd(), "server/modules/inventory-planning/domain/inventory-availability-planner.ts"),
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

describe("canonical claim execution contract migration", () => {
  it("records committed output separately from total physical output", () => {
    expect(migration).toContain("ADD COLUMN committed_output_qty bigint");
    expect(migration).toContain("committed_output_qty <= output_qty");
    expect(planner).toContain("committedOutputQty: fulfilled");
    expect(repository).toContain("output_qty, committed_output_qty, output_location_id");
  });

  it("can attribute a produced resource to its exact operation", () => {
    expect(migration).toContain("ADD COLUMN producer_operation_key varchar(300)");
    expect(migration).toContain("availability_claim_resources_producer_operation_fk");
    expect(migration).toContain("COALESCE(producer_operation_key, '')");
  });

  it("snapshots exact cost components and executes only attributed claim lots", () => {
    expect(migration).toContain("po_unit_cost_mills bigint");
    expect(migration).toContain("availability_claim_lot_allocations_cost_breakdown_chk");
    expect(repository).toContain("CLAIM_OPERATION_COST_EVIDENCE_MISSING");
    expect(repository).toContain("CLAIM_OPERATION_PREREQUISITE_INCOMPLETE");
    expect(repository).toContain("CLAIM_PLAN_HASH_MISMATCH");
    expect(repository).toContain("CLAIM_OPERATION_PLAN_EVIDENCE_MISMATCH");
    expect(inventoryWriter).toContain("async executePackageOperation");
    expect(inventoryWriter).toContain("CLAIM_LOT_COST_CHANGED");
    expect(inventoryWriter).toContain("qty_on_hand = qty_on_hand - $1");
    expect(inventoryWriter).toContain("qty_reserved = qty_reserved - $1");
    expect(inventoryWriter).toContain("reserved_qty = reserved_qty + $2");
  });

  it("is additive and does not mutate authority or physical inventory", () => {
    expect(migration).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_levels/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_lots/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });
});
