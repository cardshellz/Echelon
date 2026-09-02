import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0644_inventory_availability_claim_build_handoff.sql"),
  "utf8",
);
const executionMigration = readFileSync(
  resolve(process.cwd(), "migrations/0646_inventory_availability_claim_build_execution.sql"),
  "utf8",
);
const claimRepository = readFileSync(
  resolve(process.cwd(), "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts"),
  "utf8",
);
const buildWriter = readFileSync(
  resolve(process.cwd(), "server/modules/inventory/infrastructure/canonical-claim-build.repository.ts"),
  "utf8",
);
const buildExecution = readFileSync(
  resolve(process.cwd(), "server/modules/inventory/infrastructure/build-execution.repository.ts"),
  "utf8",
);

describe("canonical claim build handoff migration", () => {
  it("links one claim operation to one build order", () => {
    expect(migration).toContain("CREATE TABLE inventory.availability_claim_build_handoffs");
    expect(migration).toContain("availability_claim_build_handoffs_operation_uq UNIQUE (claim_id, claim_operation_id)");
    expect(migration).toContain("availability_claim_build_handoffs_build_order_uq UNIQUE (build_order_id)");
    expect(migration).toContain("availability_claim_build_handoffs_operation_fk");
  });

  it("attributes every adopted build reservation to one exact claim lot allocation", () => {
    expect(migration).toContain("ADD COLUMN reservation_owner varchar(30) NOT NULL DEFAULT 'build_order'");
    expect(migration).toContain("availability_claim_lot_allocation_id bigint");
    expect(migration).toContain("build_component_reservations_claim_allocation_fk");
    expect(migration).toContain("build_component_reservations_claim_allocation_uq");
    expect(buildWriter).toContain("'availability_claim'");
    expect(buildWriter).not.toMatch(/UPDATE\s+inventory\.inventory_(levels|lots)/i);
    expect(buildWriter).not.toMatch(/INSERT\s+INTO\s+inventory\.inventory_transactions/i);
  });

  it("supports multi-location components without pretending they have one source", () => {
    expect(buildWriter).toContain("locationIds.length === 1 ? locationIds[0] : null");
    expect(buildWriter).toContain("availability_claim_lot_allocation_id");
  });

  it("keeps generic build actions closed while exposing only claim-aware execution and cancellation", () => {
    expect(buildExecution).toContain("CLAIM_BUILD_EXECUTION_NOT_AVAILABLE");
    expect(buildExecution).toContain("CLAIM_BUILD_CANCEL_REQUIRES_CLAIM_COMMAND");
    expect(buildExecution).toContain("CLAIM_BUILD_RELEASE_REQUIRES_CLAIM_COMMAND");
    expect(buildExecution).toContain("CLAIM_BUILD_REVERSAL_REQUIRES_CLAIM_COMMAND");
    expect(buildExecution).toContain('assertClaimBuildActionAvailable(tx, buildOrderId, "release")');
    expect(buildExecution).toContain('assertClaimBuildActionAvailable(tx, input.buildOrderId, "execute")');
    expect(buildExecution).toContain('assertClaimBuildActionAvailable(tx, input.buildOrderId, "cancel")');
    expect(buildExecution).toContain('assertClaimBuildActionAvailable(tx, input.buildOrderId, "reverse")');
    expect(claimRepository).toContain("async executeBuildOperation");
    expect(claimRepository).toContain("cancelOpenBuildHandoffs");
    expect(claimRepository).toContain('commandType: "execute_build"');
    expect(executionMigration).toContain("'execute_build'");
  });

  it("does not mutate authority or physical inventory during deployment", () => {
    expect(migration).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_levels/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_lots/i);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+inventory\.inventory_transactions/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(executionMigration).not.toMatch(/UPDATE\s+inventory\.inventory_(levels|lots)/i);
    expect(executionMigration).not.toMatch(/INSERT\s+INTO\s+inventory\.inventory_transactions/i);
  });
});
