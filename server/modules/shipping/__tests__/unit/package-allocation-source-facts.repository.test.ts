import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { PackageAllocationSourceIdentityError } from "../../package-allocation-source-identity.domain";
import { packageAllocationSourceFactsQuery, readPackageAllocationSourceFacts } from "../../package-allocation-source-facts.repository";

const facts = {
  source_wms_shipment_item_id: 501, shipment_request_item_id: "9001",
  registered_quantity: 3, partition_lineage_valid: true, partitioned_quantity: "3", commercial_requested_quantity: "3",
  shipment_item_purpose: "customer_fulfillment", order_item_id: 601,
  replacement_for_order_item_id: null, correction_for_shipment_item_id: null,
  product_variant_id: 701, order_item_sku: "QUAD-PACK", replacement_order_item_sku: null, product_variant_sku: "QUAD-PACK",
};

describe("shared WMS source evidence", () => {
  it("reads registered capacity with the conserved compatibility partition and exact source identity", async () => {
    const tx = { execute: vi.fn().mockResolvedValue({ rows: [facts] }) };
    const result = await readPackageAllocationSourceFacts(tx, [501, 501]);
    expect(result).toMatchObject([{ sourceWmsShipmentItemId: 501, shipmentRequestItemId: "9001", sourceQuantity: 3,
      commercialRequestedQuantity: 3, orderItemId: 601, productVariantId: 701 }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    const compiled = new PgDialect().sqlToQuery(tx.execute.mock.calls[0][0]);
    expect(compiled.sql).toContain("registered.source_quantity");
    expect(compiled.sql).toContain("split_item.split_root_shipment_item_id = shipment_item.id");
    expect(compiled.sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
    expect(compiled.params).toEqual([501]);
  });
  it("uses the same facts query for locked bootstrap reads", () => {
    const query = new PgDialect().sqlToQuery(packageAllocationSourceFactsQuery([502, 501, 501], true));
    expect(query.sql).toContain("FOR UPDATE OF shipment_item");
    expect(query.params).toEqual([501, 502]);
  });
  it("reads conserved original capacity before immutable registration exists", async () => {
    expect(await readPackageAllocationSourceFacts({ execute: async () => ({ rows: [{ ...facts, registered_quantity: null }] }) }, [501]))
      .toMatchObject([{ sourceQuantity: 3 }]);
  });
  it("rejects drift instead of overriding the original grant", async () => {
    await expect(readPackageAllocationSourceFacts({ execute: async () => ({ rows: [{ ...facts, partitioned_quantity: 4 }] }) }, [501]))
      .rejects.toMatchObject({ code: "SOURCE_LINEAGE_INVALID" });
  });
  it("classifies a split-child lineage conflict instead of borrowing its quantity", async () => {
    await expect(readPackageAllocationSourceFacts({ execute: async () => ({ rows: [{ ...facts, partition_lineage_valid: false }] }) }, [501]))
      .rejects.toMatchObject({ code: "SOURCE_LINEAGE_INVALID" });
  });
  it("does no database work for an empty source selection", async () => {
    const tx = { execute: vi.fn() };
    expect(await readPackageAllocationSourceFacts(tx, [])).toEqual([]);
    expect(tx.execute).not.toHaveBeenCalled();
  });
  it.each([0, -1, 0.5, Number.NaN, 2_147_483_648])("classifies invalid source identity %s before querying", async sourceId => {
    const tx = { execute: vi.fn() };
    await expect(readPackageAllocationSourceFacts(tx, [sourceId])).rejects.toBeInstanceOf(PackageAllocationSourceIdentityError);
    expect(tx.execute).not.toHaveBeenCalled();
  });
  it.each([null, {}, { rows: null }, { rows: [null] }, { rows: [] }, { rows: [facts, facts] },
    { rows: [{ ...facts, source_wms_shipment_item_id: 502 }] }, { rows: [{ ...facts, order_item_id: 0 }] }])(
    "classifies missing, malformed, duplicate and cross-source query evidence %#", async result => {
      await expect(readPackageAllocationSourceFacts({ execute: async () => result }, [501]))
        .rejects.toMatchObject({ code: "INVALID_SOURCE_FACTS" });
    });
});
