import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0639_package_allocation_physical_item_provenance.sql"),
  "utf8",
);
const schema = readFileSync(
  resolve(process.cwd(), "shared/schema/fulfillment.schema.ts"),
  "utf8",
);
const integrationSetup = readFileSync(
  resolve(process.cwd(), "test/setup-integration.ts"),
  "utf8",
);

describe("package-allocation physical-item provenance migration", () => {
  it("adds one immutable allocation-entry identity without changing legacy rows", () => {
    expect(migration).toContain("ADD COLUMN package_allocation_entry_id BIGINT");
    expect(migration).toContain("REFERENCES wms.package_allocation_entries(id)");
    expect(migration).toContain("physical_shipment_items_single_source_provenance_chk");
    expect(migration).toMatch(
      /NUM_NONNULLS\([\s\S]*legacy_wms_shipment_item_id,[\s\S]*package_allocation_entry_id[\s\S]*\) <= 1/,
    );
    expect(migration).toContain("uq_physical_shipment_items_package_allocation_entry");
    expect(migration).not.toMatch(/UPDATE\s+wms\.physical_shipment_items/i);
  });

  it("rejects allocation provenance that does not match package, quantity, or line identity", () => {
    expect(migration).toContain("validate_physical_shipment_item_allocation_provenance");
    expect(migration).toContain("allocation.quantity <> NEW.quantity_shipped");
    expect(migration).toContain("entry.target_kind");
    expect(migration).toContain("plan.outcome AS plan_outcome");
    expect(migration).toContain("allocation.plan_version <> allocation.group_current_version");
    expect(migration).toContain("FOR SHARE OF allocation_group");
    expect(migration).toContain("binding.provider_physical_shipment_id");
    expect(migration).toContain(
      "allocation.shipment_request_item_id IS DISTINCT FROM NEW.shipment_request_item_id",
    );
    expect(migration).toContain("allocation.order_item_id IS DISTINCT FROM NEW.wms_order_item_id");
    expect(migration).toContain("allocation.sku IS DISTINCT FROM NEW.sku");
    expect(migration).toContain("USING ERRCODE = '23514'");
  });

  it("keeps the effective projection and TypeScript schema provenance-aware", () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE VIEW wms\.effective_physical_shipment_items[\s\S]*item\.package_allocation_entry_id/,
    );
    expect(schema).toContain('packageAllocationEntryId: bigint("package_allocation_entry_id"');
    expect(schema).toContain('uniqueIndex("uq_physical_shipment_items_package_allocation_entry")');
    expect(schema).toContain('"physical_shipment_items_single_source_provenance_chk"');
    expect(integrationSetup).toContain(
      '"migrations/0639_package_allocation_physical_item_provenance.sql"',
    );
  });
});
