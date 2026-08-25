import { describe, expect, it } from "vitest";

import {
  classifyHistoricalShipStationContentsRecovery,
  HistoricalShipStationContentsRecoveryError,
  type HistoricalShipStationExpectedContentsEvidence,
} from "../../historical-shipstation-contents-recovery.domain";

const expected: HistoricalShipStationExpectedContentsEvidence = Object.freeze({
  kind: "available",
  source: "physical_shipment",
  lines: Object.freeze([
    Object.freeze({ wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 2 }),
    Object.freeze({ wmsShipmentItemId: 7_002, sku: "SKU-B", quantity: 1 }),
  ]),
});

function classify(
  providerStatus: Parameters<typeof classifyHistoricalShipStationContentsRecovery>[0]["providerStatus"],
  rawProviderItems: unknown,
  expectedContents: HistoricalShipStationExpectedContentsEvidence = expected,
) {
  return classifyHistoricalShipStationContentsRecovery({
    providerStatus,
    rawProviderItems,
    expectedContents,
  });
}

describe("historical ShipStation contents recovery", () => {
  it("accepts a deterministic one-to-one SKU and quantity match without relying on input order", () => {
    expect(classify("unrecognized", [
      { orderItemId: 9_002, lineItemKey: null, sku: "SKU-B", quantity: 1 },
      { orderItemId: 9_001, lineItemKey: null, sku: "SKU-A", quantity: 2 },
    ])).toBe("exact_unique_wms_match");
  });

  it("retains provider WMS line keys as the stronger authority", () => {
    expect(classify("authoritative", [
      { lineItemKey: "wms-item-7001", sku: "SKU-A", quantity: 2 },
    ])).toBe("provider_line_keys_authoritative");
  });

  it("keeps a genuinely empty provider shipment in review", () => {
    expect(classify("empty", [])).toBe("provider_empty");
  });

  it.each([
    ["omitted", undefined],
    ["malformed", null],
    ["mixed", [{ lineItemKey: "wms-item-7001", sku: "SKU-A", quantity: 2 }]],
    ["unrecognized", [{ lineItemKey: null, quantity: 2 }]],
    ["unrecognized", [{ lineItemKey: null, sku: " SKU-A ", quantity: 2 }]],
  ] as const)("keeps unusable provider evidence in review (%s)", (providerStatus, rawItems) => {
    expect(classify(providerStatus, rawItems)).toBe("provider_evidence_unavailable");
  });

  it("keeps a nonempty shipment in review when no exact WMS package lineage exists", () => {
    expect(classify("unrecognized", [
      { lineItemKey: null, sku: "SKU-A", quantity: 2 },
    ], {
      kind: "unavailable",
      reason: "no_linked_package",
    })).toBe("wms_lineage_unavailable");
  });

  it.each([
    [[
      { lineItemKey: null, sku: "SKU-A", quantity: 2 },
      { lineItemKey: null, sku: "SKU-B", quantity: 2 },
    ]],
    [[{ lineItemKey: null, sku: "SKU-A", quantity: 1 }]],
    [[
      { lineItemKey: null, sku: "SKU-A", quantity: 2 },
      { lineItemKey: null, sku: "SKU-B", quantity: 1 },
      { lineItemKey: null, sku: "SKU-C", quantity: 1 },
    ]],
  ])("keeps contradictory provider and WMS contents in review", (rawItems) => {
    expect(classify("unrecognized", rawItems)).toBe("provider_wms_conflict");
  });

  it("rejects duplicate SKU and quantity matches because source identity is ambiguous", () => {
    expect(classify("unrecognized", [
      { lineItemKey: null, sku: "SKU-A", quantity: 1 },
      { lineItemKey: null, sku: "SKU-A", quantity: 1 },
    ], {
      kind: "available",
      source: "legacy_wms_shipment",
      lines: [
        { wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 1 },
        { wmsShipmentItemId: 7_002, sku: "SKU-A", quantity: 1 },
      ],
    })).toBe("ambiguous_wms_match");
  });

  it("rejects corrupt expected WMS identity evidence", () => {
    expect(() => classify("unrecognized", [
      { lineItemKey: null, sku: "SKU-A", quantity: 1 },
    ], {
      kind: "available",
      source: "legacy_wms_shipment",
      lines: [
        { wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 1 },
        { wmsShipmentItemId: 7_001, sku: "SKU-B", quantity: 1 },
      ],
    })).toThrow(HistoricalShipStationContentsRecoveryError);
  });
});
