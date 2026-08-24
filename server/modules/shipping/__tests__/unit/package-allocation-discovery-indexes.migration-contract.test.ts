import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function normalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

const migrationSource = normalizedSource(
  "migrations",
  "0619_package_allocation_discovery_indexes.sql",
);
const schemaSource = normalizedSource("shared", "schema", "fulfillment.schema.ts");

const indexContracts = [
  {
    name: "idx_physical_shipment_items_request_item_lookup",
    table: "wms.physical_shipment_items",
    columns: "shipment_request_item_id, physical_shipment_id",
    schemaFields: "table.shipmentRequestItemId, table.physicalShipmentId",
    schemaPredicate: "${table.shipmentRequestItemId} IS NOT NULL",
  },
  {
    name: "idx_physical_shipments_engine_order_lookup",
    table: "wms.physical_shipments",
    columns: "shipping_engine_order_id, id",
    schemaFields: "table.shippingEngineOrderId, table.id",
    schemaPredicate: "${table.shippingEngineOrderId} IS NOT NULL",
  },
  {
    name: "idx_shipping_provider_label_links_request_lookup",
    table: "wms.shipping_provider_label_links",
    columns: "shipment_request_id, shipping_provider_label_id",
    schemaFields: "table.shipmentRequestId, table.shippingProviderLabelId",
    schemaPredicate: "${table.shipmentRequestId} IS NOT NULL",
  },
  {
    name: "idx_shipping_provider_label_links_engine_order_lookup",
    table: "wms.shipping_provider_label_links",
    columns: "shipping_engine_order_id, shipping_provider_label_id",
    schemaFields: "table.shippingEngineOrderId, table.shippingProviderLabelId",
    schemaPredicate: "${table.shippingEngineOrderId} IS NOT NULL",
  },
  {
    name: "idx_shipping_provider_label_links_physical_lookup",
    table: "wms.shipping_provider_label_links",
    columns: "physical_shipment_id, shipping_provider_label_id",
    schemaFields: "table.physicalShipmentId, table.shippingProviderLabelId",
    schemaPredicate: "${table.physicalShipmentId} IS NOT NULL",
  },
  {
    name: "idx_shipping_provider_label_links_legacy_lookup",
    table: "wms.shipping_provider_label_links",
    columns: "legacy_wms_shipment_id, shipping_provider_label_id",
    schemaFields: "table.legacyWmsShipmentId, table.shippingProviderLabelId",
    schemaPredicate: "${table.legacyWmsShipmentId} IS NOT NULL",
  },
  {
    name: "idx_shipping_provider_labels_provider_order_id_lookup",
    table: "wms.shipping_provider_labels",
    columns: "provider, provider_order_id, id",
    schemaFields: "table.provider, table.providerOrderId, table.id",
    schemaPredicate: "${table.providerOrderId} IS NOT NULL",
  },
  {
    name: "idx_shipping_provider_labels_provider_order_key_lookup",
    table: "wms.shipping_provider_labels",
    columns: "provider, provider_order_key, id",
    schemaFields: "table.provider, table.providerOrderKey, table.id",
    schemaPredicate: "${table.providerOrderKey} IS NOT NULL",
  },
] as const;

describe("package allocation discovery index migration contract", () => {
  it("uses the only migration 0619 prefix and contains only the reviewed indexes", () => {
    const migrationFiles = readdirSync(join(process.cwd(), "migrations"))
      .filter((file) => file.match(/^(\d+)_/)?.[1] === "0619")
      .sort();

    expect(migrationFiles).toEqual([
      "0619_package_allocation_discovery_indexes.sql",
    ]);
    expect(migrationSource.match(/CREATE INDEX /g)).toHaveLength(indexContracts.length);
    expect(migrationSource).not.toContain("CREATE INDEX IF NOT EXISTS");
    expect(migrationSource).not.toContain("CREATE INDEX CONCURRENTLY");
  });

  it.each(indexContracts)("keeps $name aligned between SQL and Drizzle", (contract) => {
    const indexedColumns = contract.columns.split(",").map((column) => column.trim());
    const predicateColumn = contract.table === "wms.shipping_provider_labels"
      ? indexedColumns[1]
      : indexedColumns[0];
    expect(migrationSource).toContain(
      `CREATE INDEX ${contract.name} ON ${contract.table} (${contract.columns}) WHERE ${predicateColumn} IS NOT NULL;`,
    );
    expect(schemaSource).toContain(
      `index("${contract.name}") .on(${contract.schemaFields}) .where(sql\`${contract.schemaPredicate}\`)`,
    );
  });
});
