import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(here, "..", "..", "..", "migrations", "0586_dropship_carrier_claim_intake.sql"),
  "utf8",
);

describe("dropship carrier claim migration", () => {
  it("captures shipment cost provenance and never treats default zero as captured cost", () => {
    expect(migration).toContain("carrier_cost_source varchar(40)");
    expect(migration).toContain("carrier_cost_recorded_at timestamptz");
    expect(migration).toMatch(/carrier_cost_recorded_at IS NOT NULL[\s\S]*carrier_cost_cents > 0/);
  });

  it("creates an immutable allocation ledger tied to accepted economics and WMS shipment", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_shipment_shipping_allocations");
    expect(migration).toContain("economics_snapshot_id integer NOT NULL");
    expect(migration).toContain("wms_shipment_id integer NOT NULL");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON dropship.dropship_shipment_shipping_allocations");
  });

  it("locks claim identity, policy, allocation, and financial source snapshots", () => {
    expect(migration).toContain("carrier_protection_assignment_id integer");
    expect(migration).toContain("shipping_allocation_id bigint");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS currency varchar(3)");
    expect(migration).toContain("dropship_carrier_claim_shipment_event_idx");
    expect(migration).toContain("NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot");
    expect(migration).toContain("NEW.intake_id IS DISTINCT FROM OLD.intake_id");
    expect(migration).toContain("NEW.currency IS DISTINCT FROM OLD.currency");
    expect(migration).toContain("dropship_carrier_claim_intake_snapshot_chk");
  });
});
