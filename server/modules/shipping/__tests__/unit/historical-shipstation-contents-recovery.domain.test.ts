import { describe, expect, it } from "vitest";

import {
  buildHistoricalShipStationContentsRecoveryEvidence,
  buildHistoricalShipStationContentsSystemRecoveryEvent,
  buildHistoricalShipStationWmsConfirmationEvidence,
  classifyHistoricalShipStationContentsRecovery,
  historicalShipStationProviderObservationHash,
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
  it("builds deterministic lead-authorized WMS confirmation evidence without SKU data", () => {
    const recoveryEvidence = buildHistoricalShipStationWmsConfirmationEvidence({
      providerObservationHash: "f".repeat(64),
      expectedContents: expected,
    });
    const event = buildHistoricalShipStationContentsSystemRecoveryEvent({
      shippingProviderLabelId: "41",
      providerShipmentId: 44_001,
      trackingNumber: "1Z999AA10123456784",
      labelStatus: "active",
      recoveryEvidence,
      resolvedLabelEventIds: [101],
      authorization: {
        actorUserId: "lead-1",
        actorRole: "lead",
        reason: "Physical packing evidence confirms the WMS package.",
      },
    });

    expect(event).toMatchObject({
      eventType: "contents_recovered",
      sanitizedPayload: {
        observationSource: "historical_shipstation_contents_operator_resolution",
        recoveryStatus: "wms_confirmed_after_provider_conflict",
        providerEvidenceHash: "f".repeat(64),
        actorUserId: "lead-1",
        actorRole: "lead",
        reason: "Physical packing evidence confirms the WMS package.",
        declaredContentsEvidence: {
          status: "authoritative",
          lines: [
            { lineItemKey: "wms-item-7001", quantity: 2 },
            { lineItemKey: "wms-item-7002", quantity: 1 },
          ],
        },
      },
    });
    expect(event.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(event)).not.toMatch(/SKU-A|SKU-B/);
  });

  it("requires operator authorization exactly for manual WMS confirmation", () => {
    const manualEvidence = buildHistoricalShipStationWmsConfirmationEvidence({
      providerObservationHash: "f".repeat(64),
      expectedContents: expected,
    });
    expect(() => buildHistoricalShipStationContentsSystemRecoveryEvent({
      shippingProviderLabelId: "41",
      providerShipmentId: 44_001,
      trackingNumber: "1Z999AA10123456784",
      labelStatus: "active",
      recoveryEvidence: manualEvidence,
      resolvedLabelEventIds: [101],
    })).toThrow(HistoricalShipStationContentsRecoveryError);

    const automaticEvidence = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "authoritative",
      rawProviderItems: [{ lineItemKey: "wms-item-7001", quantity: 2 }],
      expectedContents: expected,
    });
    if (automaticEvidence === null) throw new Error("expected automatic recovery evidence");
    expect(() => buildHistoricalShipStationContentsSystemRecoveryEvent({
      shippingProviderLabelId: "41",
      providerShipmentId: 44_001,
      trackingNumber: "1Z999AA10123456784",
      labelStatus: "active",
      recoveryEvidence: automaticEvidence,
      resolvedLabelEventIds: [101],
      authorization: {
        actorUserId: "lead-1",
        actorRole: "lead",
        reason: "This must not be accepted on an automatic recovery.",
      },
    })).toThrow(HistoricalShipStationContentsRecoveryError);
  });

  it("fingerprints bounded provider evidence independent of line order and detects mixed-line changes", () => {
    const first = historicalShipStationProviderObservationHash({
      providerShipmentId: 44_001,
      providerStatus: "mixed",
      rawProviderItems: [
        { lineItemKey: "wms-item-7001", sku: "SKU-A", quantity: 2 },
        { lineItemKey: "external-1", sku: "SKU-B", quantity: 1 },
      ],
      expectedContents: expected,
    });
    const reordered = historicalShipStationProviderObservationHash({
      providerShipmentId: 44_001,
      providerStatus: "mixed",
      rawProviderItems: [
        { lineItemKey: "external-1", sku: "SKU-B", quantity: 1 },
        { lineItemKey: "wms-item-7001", sku: "SKU-A", quantity: 2 },
      ],
      expectedContents: expected,
    });
    const changed = historicalShipStationProviderObservationHash({
      providerShipmentId: 44_001,
      providerStatus: "mixed",
      rawProviderItems: [
        { lineItemKey: "external-2", sku: "SKU-B", quantity: 1 },
        { lineItemKey: "wms-item-7001", sku: "SKU-A", quantity: 2 },
      ],
      expectedContents: expected,
    });

    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds one deterministic redacted system-recovery event", () => {
    const recoveryEvidence = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "authoritative",
      rawProviderItems: [
        { lineItemKey: "wms-item-7002", sku: "SECRET-B", quantity: 1 },
        { lineItemKey: "wms-item-7001", name: "SECRET-A", quantity: 2 },
      ],
      expectedContents: expected,
    });
    if (recoveryEvidence === null) throw new Error("expected recoverable evidence");

    const first = buildHistoricalShipStationContentsSystemRecoveryEvent({
      shippingProviderLabelId: "41",
      providerShipmentId: 44_001,
      trackingNumber: "1Z999AA10123456784",
      labelStatus: "active",
      recoveryEvidence,
      resolvedLabelEventIds: [102, 101],
    });
    const replay = buildHistoricalShipStationContentsSystemRecoveryEvent({
      shippingProviderLabelId: "41",
      providerShipmentId: 44_001,
      trackingNumber: "1Z999AA10123456784",
      labelStatus: "active",
      recoveryEvidence,
      resolvedLabelEventIds: [101, 102],
    });

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      eventType: "contents_recovered",
      labelStatus: "active",
      providerOccurredAt: null,
      sanitizedPayload: {
        payloadSchemaVersion: 2,
        providerLabelId: "44001",
        observationSource: "historical_shipstation_contents_system_recovery",
        recoveryContractVersion: 1,
        recoveryStatus: "provider_line_keys_authoritative",
        resolvedLabelEventIds: [101, 102],
        declaredContentsEvidence: {
          evidenceSchemaVersion: 1,
          status: "authoritative",
          lines: [
            { lineItemKey: "wms-item-7001", quantity: 2 },
            { lineItemKey: "wms-item-7002", quantity: 1 },
          ],
        },
      },
    });
    expect(first.eventHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sanitizedPayload.recoveryEvidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first)).not.toMatch(/SECRET|SKU-/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sanitizedPayload)).toBe(true);
  });

  it("rejects duplicate system-recovery resolution references", () => {
    const recoveryEvidence = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "authoritative",
      rawProviderItems: [{ lineItemKey: "wms-item-7001", quantity: 2 }],
      expectedContents: expected,
    });
    if (recoveryEvidence === null) throw new Error("expected recoverable evidence");

    expect(() => buildHistoricalShipStationContentsSystemRecoveryEvent({
      shippingProviderLabelId: "41",
      providerShipmentId: 44_001,
      trackingNumber: "1Z999AA10123456784",
      labelStatus: "active",
      recoveryEvidence,
      resolvedLabelEventIds: [101, 101],
    })).toThrow(HistoricalShipStationContentsRecoveryError);
  });

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

  it("builds deterministic redacted provider-line-key recovery evidence", () => {
    const first = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "authoritative",
      rawProviderItems: [
        { lineItemKey: "wms-item-7002", sku: "SECRET-SKU-B", quantity: 1 },
        { lineItemKey: "wms-item-7001", name: "SECRET-NAME-A", quantity: 2 },
      ],
      expectedContents: expected,
    });
    const reordered = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "authoritative",
      rawProviderItems: [
        { lineItemKey: "wms-item-7001", ignored: "OTHER-SECRET", quantity: 2 },
        { lineItemKey: "wms-item-7002", quantity: 1 },
      ],
      expectedContents: expected,
    });
    if (first === null || reordered === null) throw new Error("expected recoverable evidence");

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({
      contractVersion: 1,
      recoveryStatus: "provider_line_keys_authoritative",
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      attestedContents: [
        { wmsShipmentItemId: 7_001, quantity: 2 },
        { wmsShipmentItemId: 7_002, quantity: 1 },
      ],
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.attestedContents)).toBe(true);
    expect(first.attestedContents.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/SECRET|SKU-|44001/);

    const changedProviderIdentity = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_002,
      providerStatus: "authoritative",
      rawProviderItems: [
        { lineItemKey: "wms-item-7001", quantity: 2 },
        { lineItemKey: "wms-item-7002", quantity: 1 },
      ],
      expectedContents: expected,
    });
    const changedQuantity = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "authoritative",
      rawProviderItems: [
        { lineItemKey: "wms-item-7001", quantity: 3 },
        { lineItemKey: "wms-item-7002", quantity: 1 },
      ],
      expectedContents: expected,
    });
    expect(changedProviderIdentity?.evidenceHash).not.toBe(first.evidenceHash);
    expect(changedQuantity?.evidenceHash).not.toBe(first.evidenceHash);
  });

  it("builds stable exact-WMS recovery evidence and binds the WMS source identities", () => {
    const first = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "unrecognized",
      rawProviderItems: [
        { lineItemKey: null, sku: "SKU-B", quantity: 1 },
        { lineItemKey: null, sku: "SKU-A", quantity: 2 },
      ],
      expectedContents: expected,
    });
    const reordered = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "unrecognized",
      rawProviderItems: [
        { lineItemKey: null, sku: "SKU-A", quantity: 2 },
        { lineItemKey: null, sku: "SKU-B", quantity: 1 },
      ],
      expectedContents: {
        kind: "available",
        source: "physical_shipment",
        lines: [...expected.lines].reverse(),
      },
    });
    const reboundSources = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "unrecognized",
      rawProviderItems: [
        { lineItemKey: null, sku: "SKU-A", quantity: 2 },
        { lineItemKey: null, sku: "SKU-B", quantity: 1 },
      ],
      expectedContents: {
        kind: "available",
        source: "physical_shipment",
        lines: [
          { wmsShipmentItemId: 8_001, sku: "SKU-A", quantity: 2 },
          { wmsShipmentItemId: 8_002, sku: "SKU-B", quantity: 1 },
        ],
      },
    });
    if (first === null || reordered === null || reboundSources === null) {
      throw new Error("expected exact WMS recovery evidence");
    }

    expect(first).toEqual(reordered);
    expect(first.attestedContents).toEqual([
      { wmsShipmentItemId: 7_001, quantity: 2 },
      { wmsShipmentItemId: 7_002, quantity: 1 },
    ]);
    expect(reboundSources.evidenceHash).not.toBe(first.evidenceHash);
    expect(JSON.stringify(first)).not.toMatch(/SKU-A|SKU-B|44001/);
  });

  it("returns no recovery evidence for review-only classifications", () => {
    expect(buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "empty",
      rawProviderItems: [],
      expectedContents: expected,
    })).toBeNull();
  });

  it("fails closed when authoritative status contradicts the provider line evidence", () => {
    expect(() => buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 44_001,
      providerStatus: "authoritative",
      rawProviderItems: [{ lineItemKey: "external-1", quantity: 1 }],
      expectedContents: expected,
    })).toThrow(HistoricalShipStationContentsRecoveryError);
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
