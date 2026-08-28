import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const migration = source("migrations/0623_inventory_claim_simulation_activation_outbox.sql");
const routes = source(
  "server/modules/inventory-planning/interfaces/http/inventory-availability-phase4.routes.ts",
);
const claimRepository = source(
  "server/modules/inventory-planning/infrastructure/inventory-availability-claim-simulation.repository.ts",
);
const activationRepository = source(
  "server/modules/inventory-planning/infrastructure/inventory-availability-activation-dry-run.repository.ts",
);
const adminPage = source("client/src/pages/SupplyTransformations.tsx");

describe("inventory availability Phase 4 inactive contracts", () => {
  it("keeps claim simulation append-only and incapable of operational inventory writes", () => {
    expect(migration).toContain("planner_claim_simulation_runs_nonwriting_chk");
    expect(migration).toContain("operational_write_attempted = false");
    expect(migration).toContain("planner_claim_simulation_runs_append_only_guard");
    expect(claimRepository).toContain("operational_write_attempted");
    expect(claimRepository).not.toMatch(/UPDATE\s+inventory\.inventory_levels/i);
    expect(claimRepository).not.toMatch(/INSERT\s+INTO\s+inventory\.(?:reserv|build_demand|inventory_transactions)/i);
  });

  it("constrains Phase 4 activation runs to terminal non-writing dry-run evidence", () => {
    expect(migration).toContain("availability_activation_runs_dry_run_chk");
    expect(migration).toContain("runtime_authority_changed = false");
    expect(migration).toContain("provider_write_attempted = false");
    expect(migration).toContain("outbox_enqueued = false");
    expect(activationRepository).toContain("'dry_run', 'full_catalog'");
    expect(activationRepository).not.toMatch(/adapter\.(?:push|publish|sync|set)/i);
    expect(activationRepository).not.toMatch(/INSERT\s+INTO\s+inventory\.inventory_publication_outbox/i);
  });

  it("defines exact disabled publication targets and monotonic absolute outbox quantities", () => {
    expect(migration).toContain("inventory.inventory_publication_targets");
    expect(migration).toContain("state VARCHAR(20) NOT NULL DEFAULT 'disabled'");
    expect(migration).toContain("channel_connection_id");
    expect(migration).toContain("fulfillment_node_id");
    expect(migration).toContain("external_scope_id");
    expect(migration).toContain("desired_quantity BIGINT NOT NULL");
    expect(migration).toContain("desired_quantity >= 0");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("NEW.desired_revision <= latest_revision");
    expect(migration).toContain("inventory_publication_outbox_update_guard");
    expect(migration).toContain("inventory_publication_readbacks");
    expect(migration).toContain("publication_target_id INTEGER NOT NULL");
    expect(migration).toContain("product_variant_id INTEGER NOT NULL");
    expect(migration).toContain("outbox_id BIGINT");
    expect(migration).toContain("readback identity differs from its publication outbox row");
  });

  it("gates simulations by edit and activation review by the dedicated activate ability", () => {
    expect(routes).toContain('requirePermission("inventory_planning", "edit")');
    expect(routes).toContain('requirePermission("inventory_planning", "activate")');
    expect(routes).not.toMatch(/adapter\.(?:push|publish|sync|set)/i);
  });

  it("exposes only a role-gated full-catalog dry-run control in the admin UI", () => {
    expect(adminPage).toContain('hasPermission("inventory_planning", "activate")');
    expect(adminPage).toContain("/api/inventory-planning/admin/activation-runs/dry-run");
    expect(adminPage).toContain("There is no live activation endpoint");
    expect(adminPage).toContain("no provider write · no outbox enqueue");
    expect(adminPage).not.toMatch(/\/api\/inventory-planning\/admin\/activation-runs\/(?:activate|publish)/);
  });
});
