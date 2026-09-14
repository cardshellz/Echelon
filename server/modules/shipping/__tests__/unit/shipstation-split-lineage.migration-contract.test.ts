import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = "migrations/0672_shipstation_split_lineage.sql";
const migration = readFileSync(resolve(process.cwd(), migrationPath), "utf8");
const schema = readFileSync(
  resolve(process.cwd(), "shared/schema/orders.schema.ts"),
  "utf8",
);
const repository = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/shipping/package-allocation-ledger.repository.ts",
  ),
  "utf8",
);
const shipStationService = readFileSync(
  resolve(process.cwd(), "server/modules/oms/shipstation.service.ts"),
  "utf8",
);
const integrationSetup = readFileSync(
  resolve(process.cwd(), "test/setup-integration.ts"),
  "utf8",
);

describe("ShipStation split-lineage migration contract", () => {
  it("persists an exact, non-cascading source-item relationship", () => {
    expect(migration).toContain(
      "ADD COLUMN split_root_shipment_item_id INTEGER",
    );
    expect(migration).toContain(
      "FOREIGN KEY (split_root_shipment_item_id)",
    );
    expect(migration).toContain("ON DELETE RESTRICT");
    expect(migration).toContain(
      "WHERE split_root_shipment_item_id IS NOT NULL",
    );
    expect(schema).toContain(
      'splitRootShipmentItemId: integer("split_root_shipment_item_id")',
    );
  });

  it("records split lineage in every normal split creation path", () => {
    expect(shipStationService).toMatch(
      /SET shipment_id = \$\{row\.id\},[\s\S]*split_root_shipment_item_id = COALESCE\([\s\S]*split_root_shipment_item_id,[\s\S]*id/,
    );
    expect(shipStationService).toMatch(
      /INSERT INTO wms\.outbound_shipment_items[\s\S]*correction_for_shipment_item_id, split_root_shipment_item_id,[\s\S]*shipment_item_purpose/,
    );
    expect(shipStationService).toContain(
      "source.split_root_shipment_item_id ?? item.sourceShipmentItemId",
    );
    expect(shipStationService).toContain(
      "sourceRow.split_root_shipment_item_id",
    );
  });

  it("proves package, tracking, order, and line parity before granting continuation authority", () => {
    expect(repository).toContain("WITH candidate_splits AS MATERIALIZED");
    expect(repository).toContain(
      "child.split_root_shipment_item_id IS NOT NULL",
    );
    expect(repository).toContain(
      "source_item.order_item_id IS NOT DISTINCT FROM child.order_item_id",
    );
    expect(repository).toMatch(
      /source_item\.product_variant_id IS NOT DISTINCT FROM\s+child\.product_variant_id/,
    );
    expect(repository).toContain(
      "split_shipment.external_fulfillment_id =",
    );
    expect(repository).not.toContain(
      "COALESCE(child.split_root_shipment_item_id, child.id)",
    );
  });

  it("binds a continuation fulfillment intent to its exact package and split root", () => {
    expect(migration).toContain(
      "intent.package_allocation_package_binding_id IS NOT NULL",
    );
    expect(migration).toContain(
      "binding.id = intent.package_allocation_package_binding_id",
    );
    expect(migration).toContain(
      "source_item.id = lineage.source_wms_shipment_item_id",
    );
    expect(migration).toContain(
      "lineage.package_allocation_package_binding_id IS DISTINCT FROM",
    );
    expect(migration).toContain(
      "lacks exact ShipStation split lineage",
    );
  });

  it("backfills only the two reviewed historical rows without inventory writes", () => {
    expect(migration).toContain(
      "(22442, 22122, 17312, '458438895', '9434650206217286018017')",
    );
    expect(migration).toContain(
      "(22461, 22101, 17329, '458655645', '877076049400')",
    );
    expect(migration).toContain(
      "SET split_root_shipment_item_id = repair.source_item_id",
    );
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?inventory\./i);
  });

  it("runs after the existing package-allocation fulfillment schema in integration tests", () => {
    const fulfillmentIndex = integrationSetup.indexOf(
      '"migrations/0645_package_allocation_commercial_fulfillment_activation.sql"',
    );
    const lineageIndex = integrationSetup.indexOf(`"${migrationPath}"`);
    expect(fulfillmentIndex).toBeGreaterThanOrEqual(0);
    expect(lineageIndex).toBeGreaterThan(fulfillmentIndex);
  });
});
