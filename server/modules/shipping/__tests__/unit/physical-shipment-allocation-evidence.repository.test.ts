import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { readPhysicalShipmentAllocationEvidence, readShipmentItemAllocationSource } from "../../physical-shipment-allocation-evidence.repository";

const rootInput = { legacyWmsShipmentItemId: 502, wmsOrderItemId: 601, wmsOrderId: 701 };
const physicalInput = { legacyWmsShipmentItemId: 502, wmsOrderItemId: 601, fulfillmentPlanLineId: 801 };
const row = { id: "901", allocation_source_id: 501, shipment_request_item_id: "1001", fulfillment_plan_line_id: "801",
  legacy_wms_shipment_item_id: null, label_replacement_source_item_id: null, provider: "shipstation",
  provider_physical_shipment_id: "44010", quantity_shipped: 2, effective_quantity: 2 };

describe("published WMS allocation provenance", () => {
  it("resolves only an exact, conserving source lineage without writes", async () => {
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [{ source_id: 501 }] }) };
    expect(await readShipmentItemAllocationSource(tx, rootInput)).toBe(501);
    const query = new PgDialect().sqlToQuery(tx.execute.mock.calls[0][0]);
    expect(query.params).toEqual([502, 601, 701]);
    for (const identity of ["root.order_item_id = child.order_item_id", "root.product_variant_id IS NOT DISTINCT FROM child.product_variant_id",
      "root.shipment_item_purpose = child.shipment_item_purpose", "root_shipment.order_id = child_shipment.order_id",
      "root.replacement_for_order_item_id IS NOT DISTINCT FROM child.replacement_for_order_item_id",
      "root.correction_for_shipment_item_id IS NOT DISTINCT FROM child.correction_for_shipment_item_id"])
      expect(query.sql).toContain(identity);
    expect(query.sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  it.each([{ rows: [] }, { rows: [{ source_id: 0 }] }, { rows: [{ source_id: 501 }, { source_id: 501 }] }])("rejects missing or ambiguous ancestry %#", async ({ rows }) => {
    await expect(readShipmentItemAllocationSource({ execute: async () => ({ rows }) }, rootInput))
      .rejects.toMatchObject({ code: "SOURCE_LINEAGE_INVALID" });
  });

  it("returns immutable canonical package, request and source provenance", async () => {
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [row] }) };
    const result = await readPhysicalShipmentAllocationEvidence(tx, physicalInput);
    expect(result).toEqual([{ physicalShipmentItemId: 901, allocationSourceShipmentItemId: 501,
      shipmentRequestItemId: 1001, fulfillmentPlanLineId: 801, legacyWmsShipmentItemId: null,
      labelReplacementSourceItemId: null, shippingProvider: "shipstation", providerPhysicalShipmentId: "44010",
      quantityShipped: 2, effectiveQuantityShipped: 2 }]);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result[0])).toBe(true);
    const query = new PgDialect().sqlToQuery(tx.execute.mock.calls[0][0]);
    expect(query.sql).toContain("source.source_wms_shipment_item_id AS allocation_source_id");
    expect(query.sql).toContain("adjustment.adjustment_kind IS DISTINCT FROM 'provider_label_replacement'");
    expect(query.sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  it.each([{ rows: [row, row] }, { rows: [{ ...row, id: "bad" }] }, { rows: [{ ...row, effective_quantity: -1 }] },
    { rows: null }, null])("rejects invalid or duplicate physical evidence %#", async result => {
    await expect(readPhysicalShipmentAllocationEvidence({ execute: async () => result }, physicalInput))
      .rejects.toMatchObject({ code: "INVALID_SOURCE_FACTS" });
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("validates source identity %s before the database", async id => {
    const tx = { execute: vi.fn() };
    await expect(readShipmentItemAllocationSource(tx, { ...rootInput, legacyWmsShipmentItemId: id }))
      .rejects.toMatchObject({ code: "INVALID_SOURCE_FACTS" });
    expect(tx.execute).not.toHaveBeenCalled();
  });
});
