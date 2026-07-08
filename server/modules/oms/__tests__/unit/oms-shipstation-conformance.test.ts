import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

function sourceBlock(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);

  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : source.length;
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);

  return source.slice(start, end);
}

const SHIPSTATION_SRC = readSource("../../shipstation.service.ts");
const FULFILLMENT_PUSH_SRC = readSource("../../fulfillment-push.service.ts");
const SHIP_NOTIFY_TEST_SRC = readSource("ship-notify-v2.test.ts");
const WRITEBACK_GUARDS_TEST_SRC = readSource("c7-writeback-guards.test.ts");
const PUSH_SHOPIFY_FULFILLMENT_TEST_SRC = readSource(
  "push-shopify-fulfillment.test.ts",
);
const SHIPSTATION_SPLIT_INDEX_MIGRATION = readSource(
  "../../../../../migrations/125_shipstation_split_engine_identity_indexes.sql",
);

describe("OMS/WMS authority conformance :: ShipStation handoff", () => {
  it("keeps concurrent Shopify fulfillment pushes idempotent for the same WMS shipment", () => {
    const persistBlock = sourceBlock(
      FULFILLMENT_PUSH_SRC,
      "D-PUSHIDEM",
      "D-PUSHAUDIT",
    );

    expect(WRITEBACK_GUARDS_TEST_SRC).toContain(
      'describe("D-PUSHIDEM: conditional UPDATE serializes concurrent pushes"',
    );
    expect(WRITEBACK_GUARDS_TEST_SRC).toContain(
      'it("uses conditional UPDATE with NULL guard when persisting fulfillment ID"',
    );
    expect(persistBlock).toContain("UPDATE wms.outbound_shipments");
    expect(persistBlock).toContain("shopify_fulfillment_id IS NULL");
    expect(persistBlock).toContain("persistResult?.rowCount");
    expect(persistBlock).toContain("shopify_push_concurrent_skip");
    expect(persistBlock).toContain("alreadyPushed: true");
  });

  it("repairs duplicate ShipStation order-key callbacks instead of creating fake split work", () => {
    // Merged P0 semantics: full/duplicate packages take the read-only
    // repair/adopt branch (`!isPartialPackage`); a second row is never
    // created for a duplicate orderKey callback.
    const duplicateRepairBlock = sourceBlock(
      SHIPSTATION_SRC,
      "if (!isPartialPackage) {",
      "// Genuine partial package",
    );

    expect(SHIP_NOTIFY_TEST_SRC).toContain(
      'describe("processShipNotify V2 :: duplicate orderKey repair"',
    );
    expect(SHIP_NOTIFY_TEST_SRC).toContain(
      "repairs a duplicate ShipStation orderKey mapping instead of creating a fake split shipment",
    );
    expect(SHIP_NOTIFY_TEST_SRC).toContain(
      "expect(sqlText).not.toMatch(/shipstation_split/)",
    );
    expect(duplicateRepairBlock).toContain("UPDATE wms.outbound_shipments");
    expect(duplicateRepairBlock).toContain("shipstation_duplicate_order_key_repaired");
    expect(duplicateRepairBlock).toContain("Repair/adopt the mapping");
    expect(duplicateRepairBlock).toContain(
      "return { ...parent, shipstation_order_id: adoptedSsOrderId }",
    );
  });

  it("allows legitimate shipped splits only when WMS item evidence is present", () => {
    const splitResolutionBlock = sourceBlock(
      SHIPSTATION_SRC,
      "async function resolveShipmentByOrderKey",
      "async function syncShipmentItemsFromShipStation",
    );
    const itemSyncBlock = sourceBlock(
      SHIPSTATION_SRC,
      "async function syncShipmentItemsFromShipStation",
      "async function loadValidatedInventoryShipmentItems",
    );

    expect(SHIP_NOTIFY_TEST_SRC).toContain(
      "ignores ShipStation split/package edits that are not shipped",
    );
    expect(SHIP_NOTIFY_TEST_SRC).toContain(
      "applies shipped split quantities to WMS order_items without completing the remaining quantity",
    );
    expect(SHIPSTATION_SRC).toContain(
      'const SHIPSTATION_SPLIT_SOURCE = "shipstation_split"',
    );
    expect(splitResolutionBlock).toContain("SELECT pg_advisory_lock");
    expect(splitResolutionBlock).toContain("hasSameShipmentItemSet");
    expect(splitResolutionBlock).toContain("${SHIPSTATION_SPLIT_SOURCE}, 'queued'");
    expect(splitResolutionBlock).toContain("SELECT pg_advisory_unlock");
    expect(itemSyncBlock).toContain("parseWmsShipmentItemLineKey");
    expect(itemSyncBlock).toContain("shipstation_split_items_unmapped");
    expect(itemSyncBlock).toContain("shipstation_split_source_item_missing");
    expect(itemSyncBlock).toContain("UPDATE wms.outbound_shipment_items");
    expect(itemSyncBlock).toContain("tracking_id = ${String(shipment.shipmentId)}");
  });

  it("exempts legitimate ShipStation split children from active engine identity uniqueness", () => {
    expect(SHIPSTATION_SPLIT_INDEX_MIGRATION).toContain(
      "DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_shipstation_order_id",
    );
    expect(SHIPSTATION_SPLIT_INDEX_MIGRATION).toContain(
      "DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_shipstation_order_key",
    );
    expect(SHIPSTATION_SPLIT_INDEX_MIGRATION).toContain(
      "DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_engine_order_ref",
    );

    for (const indexName of [
      "uq_outbound_shipments_active_shipstation_order_id",
      "uq_outbound_shipments_active_shipstation_order_key",
      "uq_outbound_shipments_active_engine_order_ref",
    ]) {
      const indexBlock = sourceBlock(
        SHIPSTATION_SPLIT_INDEX_MIGRATION,
        `CREATE UNIQUE INDEX ${indexName}`,
        ";",
      );

      expect(indexBlock).toContain("'echelon_combined_child'");
      expect(indexBlock).toContain("'shipstation_combined_child'");
      expect(indexBlock).toContain("'shipstation_split'");
    }
  });

  it("keeps combined shipment fan-out covered as a first-class conformance path", () => {
    const fanOutBlock = sourceBlock(
      FULFILLMENT_PUSH_SRC,
      "async function pushFulfillmentForCombinedGroup",
      "async function cancelShopifyFulfillment",
    );

    expect(PUSH_SHOPIFY_FULFILLMENT_TEST_SRC).toContain(
      'describe("pushShopifyFulfillment :: combined-orders fan-out (C25)"',
    );
    expect(PUSH_SHOPIFY_FULFILLMENT_TEST_SRC).toContain(
      "fans out parent + 1 child: 2 fulfillments pushed, both saved",
    );
    expect(PUSH_SHOPIFY_FULFILLMENT_TEST_SRC).toContain(
      "Both pushes carry the SAME tracking number",
    );
    expect(PUSH_SHOPIFY_FULFILLMENT_TEST_SRC).toContain(
      "sibling already has shopify_fulfillment_id",
    );
    expect(PUSH_SHOPIFY_FULFILLMENT_TEST_SRC).toContain("voided sibling");
    expect(PUSH_SHOPIFY_FULFILLMENT_TEST_SRC).toContain("cancelled sibling");
    expect(fanOutBlock).toContain("sharedTrackingInfo");
    expect(fanOutBlock).toContain("WHERE o.combined_group_id");
    expect(fanOutBlock).toContain("combined_role = 'parent'");
    expect(fanOutBlock).toContain('sibStatus === "voided" || sibStatus === "cancelled"');
    expect(fanOutBlock).toContain("pushSingleShipmentFulfillment");
    expect(fanOutBlock).toContain("continuing fan-out for remaining siblings");
  });
});
