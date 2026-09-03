import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0647_inventory_availability_claim_pick_lineage.sql"),
  "utf8",
);
const claimRepository = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts",
  ),
  "utf8",
);
const inventoryRepository = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts",
  ),
  "utf8",
);

describe("canonical claim pick lineage migration contract", () => {
  it("adds a distinct picked balance at line, resource, and exact lot scope", () => {
    expect(migration).toContain("ADD COLUMN picked_target_qty bigint NOT NULL DEFAULT 0");
    expect(migration.match(/ADD COLUMN picked_qty bigint NOT NULL DEFAULT 0/g)).toHaveLength(2);
    expect(migration).toContain("released_target_qty + consumed_target_qty + picked_target_qty <= planned_qty");
    expect(migration).toContain("released_qty + consumed_qty + picked_qty <= claimed_qty");
  });

  it("persists append-only exact pick and compensating-unpick evidence", () => {
    expect(migration).toContain("CREATE TABLE inventory.availability_claim_pick_movements");
    expect(migration).toContain("reverses_pick_movement_id");
    expect(migration).toContain("order_item_cost_id");
    expect(migration).toContain("availability_claim_pick_movements_append_only");
    expect(migration).toContain("command_type IN");
    expect(migration).toContain("'pick', 'unpick'");
  });

  it("is deployment-inert and leaves runtime authority and physical stock untouched", () => {
    expect(migration).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_levels/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_lots/i);
    expect(migration).not.toMatch(/UPDATE\s+oms\.order_item_costs/i);
  });

  it("keeps orchestration out of the physical inventory writer", () => {
    expect(inventoryRepository).not.toContain("availability_claim_lines");
    expect(inventoryRepository).not.toContain("availability_claim_pick_movements");
    expect(claimRepository).toContain("pickClaimLine");
    expect(claimRepository).toContain("unpickClaimLine");
    expect(claimRepository).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  });
});
