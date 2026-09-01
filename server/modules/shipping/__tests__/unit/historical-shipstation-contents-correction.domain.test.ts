import { describe, expect, it } from "vitest";

import {
  planHistoricalShipStationContentsCorrection,
  type HistoricalShipStationContentsCorrectionFacts,
} from "../../historical-shipstation-contents-correction.domain";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function facts(
  overrides: Partial<HistoricalShipStationContentsCorrectionFacts> = {},
): HistoricalShipStationContentsCorrectionFacts {
  return {
    exceptionId: "91",
    decisionHash: HASH_A,
    providerEvidenceHash: HASH_B,
    reviewPreviewEvidenceHash: HASH_C,
    orderNumber: "1001",
    trackingNumber: "1Z-CORRECTION",
    providerLines: [{ sku: "SKU-A", quantity: 1 }],
    wmsLines: [{
      wmsShipmentItemId: 701,
      wmsShipmentId: 801,
      orderItemId: 901,
      productVariantId: 101,
      sku: "SKU-A",
      itemName: "Regular A",
      quantity: 2,
      fromLocationId: 301,
      inventoryShipTransactions: [{
        inventoryTransactionId: 401,
        productVariantId: 101,
        fromLocationId: 301,
        quantity: 2,
        evidenceKind: "exact_shipment_item",
      }],
    }],
    catalogVariants: [{
      productVariantId: 101,
      sku: "SKU-A",
      itemName: "Regular A",
      isActive: true,
      requiresShipping: true,
      trackInventory: true,
    }],
    ...overrides,
  };
}

describe("historical ShipStation contents correction planning", () => {
  it("plans an exact inventory restoration when WMS over-recorded the provider package", () => {
    const plan = planHistoricalShipStationContentsCorrection(facts());

    expect(plan).toMatchObject({
      contractVersion: 1,
      evidenceComplete: true,
      packageLineChangeRequired: true,
      inventoryPostingRequired: true,
      blockers: [],
    });
    expect(plan.lines).toEqual([expect.objectContaining({
      sku: "SKU-A",
      productVariantId: 101,
      providerQuantity: 1,
      wmsQuantity: 2,
      recordedInventoryQuantity: 2,
      packageQuantityDelta: -1,
      inventoryQuantityDelta: -1,
      inventoryAction: "restore",
      packageLineAdjustments: [{
        wmsShipmentItemId: 701,
        currentQuantity: 2,
        proposedQuantity: 1,
        quantityDelta: -1,
      }],
      restorations: [{
        inventoryTransactionId: 401,
        wmsShipmentItemId: 701,
        warehouseLocationId: 301,
        quantity: 1,
      }],
    })]);
  });

  it("retains the WMS line with exact inventory lineage before an unposted duplicate", () => {
    const posted = facts().wmsLines[0];
    const plan = planHistoricalShipStationContentsCorrection(facts({
      providerLines: [{ sku: "SKU-A", quantity: 2 }],
      wmsLines: [
        {
          ...posted,
          wmsShipmentItemId: 702,
          quantity: 2,
          inventoryShipTransactions: [],
        },
        posted,
      ],
    }));

    expect(plan.lines[0]).toMatchObject({
      providerQuantity: 2,
      wmsQuantity: 4,
      recordedInventoryQuantity: 2,
      packageLineAdjustments: [{
        wmsShipmentItemId: 702,
        currentQuantity: 2,
        proposedQuantity: 0,
        quantityDelta: -2,
      }],
      inventoryAction: "none",
    });
  });

  it("blocks an unproven inventory debit and new package-line lineage", () => {
    const plan = planHistoricalShipStationContentsCorrection(facts({
      providerLines: [{ sku: "SKU-A", quantity: 3 }],
    }));

    expect(plan.evidenceComplete).toBe(false);
    expect(plan.lines[0]).toMatchObject({
      packageQuantityDelta: 1,
      inventoryQuantityDelta: 1,
      inventoryAction: "deduct",
    });
    expect(plan.blockers.map((entry) => entry.code)).toEqual([
      "inventory_debit_source_unproven",
      "package_line_mapping_required",
    ]);
  });

  it("returns a complete no-op when provider, WMS, and inventory already match", () => {
    const plan = planHistoricalShipStationContentsCorrection(facts({
      providerLines: [{ sku: "SKU-A", quantity: 2 }],
    }));

    expect(plan).toMatchObject({
      evidenceComplete: true,
      packageLineChangeRequired: false,
      inventoryPostingRequired: false,
      blockers: [],
      lines: [{
        packageQuantityDelta: 0,
        inventoryQuantityDelta: 0,
        inventoryAction: "none",
        packageLineAdjustments: [],
        restorations: [],
      }],
    });
  });

  it("does not invent a catalog identity for an unmatched provider SKU", () => {
    const plan = planHistoricalShipStationContentsCorrection(facts({
      providerLines: [{ sku: "UNKNOWN", quantity: 1 }],
      wmsLines: [],
      catalogVariants: [],
    }));

    expect(plan.lines).toEqual([expect.objectContaining({
      sku: "UNKNOWN",
      productVariantId: null,
      inventoryAction: "deduct",
    })]);
    expect(plan.blockers.map((entry) => entry.code)).toEqual([
      "catalog_variant_unmatched",
      "inventory_debit_source_unproven",
      "package_line_mapping_required",
    ]);
  });

  it("blocks ambiguous and mismatched inventory shipment evidence", () => {
    const base = facts().wmsLines[0];
    const plan = planHistoricalShipStationContentsCorrection(facts({
      providerLines: [{ sku: "SKU-A", quantity: 2 }],
      wmsLines: [{
        ...base,
        inventoryShipTransactions: [
          ...base.inventoryShipTransactions,
          {
            inventoryTransactionId: 402,
            productVariantId: 101,
            fromLocationId: 302,
            quantity: 1,
            evidenceKind: "legacy_order_item",
          },
        ],
      }],
    }));

    expect(plan.evidenceComplete).toBe(false);
    expect(plan.lines[0]).toMatchObject({
      recordedInventoryQuantity: null,
      inventoryQuantityDelta: null,
      inventoryAction: "unknown",
    });
    expect(plan.blockers.map((entry) => entry.code)).toContain(
      "inventory_ship_evidence_ambiguous",
    );
  });

  it("reports provider evidence that cannot support a correction", () => {
    const plan = planHistoricalShipStationContentsCorrection(facts({ providerLines: null }));

    expect(plan.evidenceComplete).toBe(false);
    expect(plan).toMatchObject({
      packageLineChangeRequired: false,
      inventoryPostingRequired: false,
      lines: [{
        providerQuantity: null,
        packageQuantityDelta: null,
        inventoryQuantityDelta: null,
        inventoryAction: "unknown",
        restorations: [],
      }],
    });
    expect(plan.blockers.map((entry) => entry.code)).toContain(
      "provider_contents_unavailable",
    );
  });

  it("blocks a restoration when the original inventory location is not preserved", () => {
    const base = facts().wmsLines[0];
    const plan = planHistoricalShipStationContentsCorrection(facts({
      wmsLines: [{
        ...base,
        inventoryShipTransactions: [{
          ...base.inventoryShipTransactions[0],
          fromLocationId: null,
        }],
      }],
    }));

    expect(plan.inventoryPostingRequired).toBe(true);
    expect(plan.lines[0].restorations).toEqual([]);
    expect(plan.blockers.map((entry) => entry.code)).toContain(
      "inventory_restore_location_unproven",
    );
  });

  it("produces the same plan hash for equivalent fact ordering", () => {
    const first = facts({
      providerLines: [
        { sku: "SKU-B", quantity: 1 },
        { sku: "SKU-A", quantity: 1 },
      ],
      catalogVariants: [
        {
          productVariantId: 102,
          sku: "SKU-B",
          itemName: "Regular B",
          isActive: true,
          requiresShipping: true,
          trackInventory: true,
        },
        ...facts().catalogVariants,
      ],
    });
    const second = {
      ...first,
      providerLines: [...(first.providerLines ?? [])].reverse(),
      catalogVariants: [...first.catalogVariants].reverse(),
    };

    expect(planHistoricalShipStationContentsCorrection(first).correctionPlanHash)
      .toBe(planHistoricalShipStationContentsCorrection(second).correctionPlanHash);
  });
});
