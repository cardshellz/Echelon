import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  allocationAuditLog,
  channelAllocationRules,
  channelProductAllocation,
  channelProductLines,
  channelProductOverrides,
  channelReservations,
  channels,
  channelVariantOverrides,
  channelWarehouseAssignments,
  inventoryLevels,
  inventoryTransactions,
  productLineProducts,
  productLines,
  products,
  productVariants,
  sourceLockConfig,
  warehouseLocations,
  warehouses,
} from "@shared/schema";

const fixtureSql = readFileSync(
  resolve(process.cwd(), "test/fixtures/named-schema-integration.sql"),
  "utf8",
);

const fixtureTables: PgTable[] = [
  products,
  productVariants,
  productLines,
  productLineProducts,
  warehouses,
  warehouseLocations,
  inventoryLevels,
  inventoryTransactions,
  channels,
  channelReservations,
  channelProductAllocation,
  channelProductLines,
  channelProductOverrides,
  channelVariantOverrides,
  channelWarehouseAssignments,
  channelAllocationRules,
  allocationAuditLog,
  sourceLockConfig,
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("named-schema integration fixture", () => {
  for (const table of fixtureTables) {
    const config = getTableConfig(table);

    it(`keeps ${config.schema}.${config.name} aligned with its Drizzle columns`, () => {
      const tablePattern = new RegExp(
        `CREATE TABLE ${escapeRegex(config.schema!)}\\.${escapeRegex(config.name)} \\(([\\s\\S]*?)\\n\\);`,
      );
      const tableBody = fixtureSql.match(tablePattern)?.[1];
      expect(tableBody, `missing fixture table ${config.schema}.${config.name}`).toBeDefined();

      for (const column of config.columns) {
        expect(
          tableBody,
          `missing ${config.schema}.${config.name}.${column.name}`,
        ).toMatch(new RegExp(`^  ${escapeRegex(column.name)}\\s`, "m"));
      }
    });
  }

  it("supports the historical shipment contents operator-identity query", () => {
    const requiredColumns = [
      ["wms.orders", ["id", "order_number"]],
      ["wms.order_items", ["id", "order_id", "name"]],
      ["wms.outbound_shipments", ["id", "order_id"]],
      ["wms.shipment_requests", ["id", "wms_order_id"]],
      [
        "wms.shipping_engine_order_requests",
        ["shipping_engine_order_id", "shipment_request_id"],
      ],
      [
        "wms.physical_shipments",
        ["id", "shipment_request_id", "shipping_engine_order_id"],
      ],
      [
        "wms.shipping_provider_labels",
        ["id", "provider", "provider_order_id", "tracking_number", "label_direction"],
      ],
      [
        "wms.shipping_provider_label_links",
        [
          "id",
          "shipping_provider_label_id",
          "shipment_request_id",
          "shipping_engine_order_id",
          "physical_shipment_id",
          "legacy_wms_shipment_id",
        ],
      ],
      [
        "wms.outbound_shipment_items",
        [
          "id",
          "order_item_id",
          "replacement_for_order_item_id",
          "shipment_item_purpose",
          "product_variant_id",
        ],
      ],
      ["catalog.product_variants", ["id", "name"]],
    ] as const;

    for (const [tableName, columns] of requiredColumns) {
      const tablePattern = new RegExp(
        `CREATE TABLE ${escapeRegex(tableName)} \\(([\\s\\S]*?)\\n\\);`,
      );
      const tableBody = fixtureSql.match(tablePattern)?.[1];
      expect(tableBody, `missing fixture table ${tableName}`).toBeDefined();
      for (const column of columns) {
        expect(tableBody, `missing ${tableName}.${column}`).toMatch(
          new RegExp(`^  ${escapeRegex(column)}\\s`, "m"),
        );
      }
    }
  });
});
