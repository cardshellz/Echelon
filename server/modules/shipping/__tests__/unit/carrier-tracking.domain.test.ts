import { describe, expect, it } from "vitest";

import {
  CarrierTrackingPayloadError,
  ShippingProviderLabelIdentityConflictError,
  assertStableShippingProviderLabelIdentity,
  normalizeShipStationLabelObservation,
  normalizeShipStationShipmentContentsEvidence,
  normalizeShipStationTrackingWebhook,
  resolveCarrierTrackingMatch,
  type CarrierTrackingMatchCandidate,
} from "../../carrier-tracking.domain";

const receivedAt = new Date("2026-07-20T12:00:00.000Z");

function trackingPayload(overrides: Record<string, unknown> = {}) {
  return {
    resource_type: "API_TRACK",
    resource_url: "https://api.shipstation.com/v2/tracking?carrier_code=ups&tracking_number=1Z999AA10123456784",
    data: {
      tracking_number: "1Z999AA10123456784",
      status_code: "AC",
      status_description: "Package picked up",
      carrier_status_code: "PICKED_UP",
      carrier_detail_code: "PICKED_UP",
      events: [{
        occurred_at: "2026-07-20T11:30:00.000Z",
        status_code: "AC",
        carrier_detail_code: "PICKED_UP",
        event_description: "Package picked up",
      }],
      ...overrides,
    },
  };
}

function candidate(overrides: Partial<CarrierTrackingMatchCandidate> = {}): CarrierTrackingMatchCandidate {
  return {
    shippingProviderLabelId: 10,
    providerLabelId: "label-1",
    labelDirection: "outbound",
    labelStatus: "active",
    linkCount: 1,
    orderNumbers: ["#60001"],
    carrier: "ups",
    serviceCode: "ups_ground",
    ...overrides,
  };
}

describe("carrier tracking normalization", () => {
  it("treats carrier pickup as confirmed physical dispatch", () => {
    const event = normalizeShipStationTrackingWebhook(trackingPayload(), receivedAt);
    expect(event).toMatchObject({
      canonicalStatus: "accepted",
      dispatchEvidence: "confirmed",
      providerStatusDetailCode: "PICKED_UP",
      normalizedTrackingNumber: "1Z999AA10123456784",
      carrier: "ups",
    });
  });

  it("normalizes provider carrier codes before identity matching", () => {
    const event = normalizeShipStationTrackingWebhook(trackingPayload({
      carrier_code: "UPS",
    }), receivedAt);
    const label = normalizeShipStationLabelObservation({
      shipmentId: 442_000_001,
      trackingNumber: "1Z999AA10123456784",
      carrierCode: "UPS",
    }, receivedAt);

    expect(event.carrier).toBe("ups");
    expect(label.carrier).toBe("ups");
    expect(label.sanitizedPayload.carrierCode).toBe("ups");
  });

  it("does not treat label creation or electronic advice as dispatch", () => {
    const newLabel = normalizeShipStationTrackingWebhook(trackingPayload({
      status_code: "NY",
      status_detail_code: "SHIPMENT_CREATED",
      carrier_status_code: null,
      carrier_detail_code: null,
      status_description: "Label created",
      events: [],
    }), receivedAt);
    const electronicAdvice = normalizeShipStationTrackingWebhook(trackingPayload({
      status_code: "AC",
      status_detail_code: "ELEC_ADVICE_RECD_BY_CARRIER",
      carrier_status_code: null,
      carrier_detail_code: null,
      status_description: "Electronic advice received by carrier",
      events: [],
    }), receivedAt);

    expect(newLabel.dispatchEvidence).toBe("not_confirmed");
    expect(newLabel.canonicalStatus).toBe("pre_transit");
    expect(electronicAdvice.dispatchEvidence).toBe("not_confirmed");
  });

  it("treats in-transit and delivered states as confirmed", () => {
    expect(normalizeShipStationTrackingWebhook(trackingPayload({
      status_code: "IT",
      status_detail_code: null,
      events: [],
    }), receivedAt).dispatchEvidence).toBe("confirmed");
    expect(normalizeShipStationTrackingWebhook(trackingPayload({
      status_code: "DE",
      status_detail_code: null,
      events: [],
    }), receivedAt).dispatchEvidence).toBe("confirmed");
  });

  it("normalizes blank optional provider metadata without rejecting delivered evidence", () => {
    const event = normalizeShipStationTrackingWebhook(trackingPayload({
      status_code: "DE",
      status_description: "Delivered",
      actual_delivery_date: "2026-07-20T11:45:00.000Z",
      label_url: "",
      events: [{
        occurred_at: "2026-07-20T11:45:00.000Z",
        status_code: "DE",
        event_description: "Delivered",
        city_locality: " ",
        state_province: "",
        postal_code: "",
        country_code: "",
      }],
    }), receivedAt);

    expect(event).toMatchObject({
      canonicalStatus: "delivered",
      dispatchEvidence: "confirmed",
      actualDeliveryAt: new Date("2026-07-20T11:45:00.000Z"),
      sanitizedPayload: {
        events: [{
          cityLocality: null,
          stateProvince: null,
          postalCode: null,
          countryCode: null,
        }],
      },
    });
  });

  it("keeps required tracking identity and status strict", () => {
    expect(() => normalizeShipStationTrackingWebhook(trackingPayload({
      tracking_number: "",
    }), receivedAt)).toThrow(CarrierTrackingPayloadError);
    expect(() => normalizeShipStationTrackingWebhook(trackingPayload({
      status_code: "",
    }), receivedAt)).toThrow(CarrierTrackingPayloadError);
  });

  it("preserves earlier possession evidence after a later carrier exception", () => {
    const event = normalizeShipStationTrackingWebhook(trackingPayload({
      status_code: "EX",
      carrier_detail_code: "DELIVERY_EXCEPTION",
      status_description: "Delivery exception",
      events: [{
        occurred_at: "2026-07-20T10:00:00.000Z",
        carrier_detail_code: "PICKED_UP",
        event_description: "Package picked up",
      }, {
        occurred_at: "2026-07-20T11:30:00.000Z",
        carrier_detail_code: "DELIVERY_EXCEPTION",
        event_description: "Delivery exception",
      }],
    }), receivedAt);

    expect(event.dispatchEvidence).toBe("confirmed");
  });

  it("holds accepted status without possession evidence for review", () => {
    const event = normalizeShipStationTrackingWebhook(trackingPayload({
      status_code: "AC",
      status_detail_code: "UNKNOWN_ACCEPTANCE_DETAIL",
      carrier_status_code: null,
      carrier_detail_code: null,
      status_description: "Accepted",
      events: [],
    }), receivedAt);
    expect(event.dispatchEvidence).toBe("review");
  });

  it("produces a stable event identity for the same provider event", () => {
    const first = normalizeShipStationTrackingWebhook(trackingPayload(), receivedAt);
    const replay = normalizeShipStationTrackingWebhook(
      trackingPayload(),
      new Date("2026-07-20T12:05:00.000Z"),
    );
    expect(replay.eventHash).toBe(first.eventHash);
    expect(replay.payloadHash).toBe(first.payloadHash);
  });

  it("includes a resource-url carrier in event identity when data omits the carrier", () => {
    const ups = normalizeShipStationTrackingWebhook(trackingPayload(), receivedAt);
    const fedex = normalizeShipStationTrackingWebhook({
      ...trackingPayload(),
      resource_url: "https://api.shipstation.com/v2/tracking?carrier_code=fedex&tracking_number=1Z999AA10123456784",
    }, receivedAt);

    expect(ups.carrier).toBe("ups");
    expect(fedex.carrier).toBe("fedex");
    expect(ups.sanitizedPayload.carrierCode).toBe("ups");
    expect(fedex.sanitizedPayload.carrierCode).toBe("fedex");
    expect(fedex.payloadHash).not.toBe(ups.payloadHash);
    expect(fedex.eventHash).not.toBe(ups.eventHash);
  });

  it("preserves a later provider snapshot when its event history changes", () => {
    const first = normalizeShipStationTrackingWebhook(trackingPayload(), receivedAt);
    const expanded = normalizeShipStationTrackingWebhook(trackingPayload({
      events: [{
        occurred_at: "2026-07-20T11:30:00.000Z",
        carrier_detail_code: "PICKED_UP",
        event_description: "Package picked up",
      }, {
        occurred_at: "2026-07-20T10:00:00.000Z",
        carrier_detail_code: "ELEC_ADVICE_RECD_BY_CARRIER",
        event_description: "Electronic advice received",
      }],
    }), new Date("2026-07-20T12:05:00.000Z"));

    expect(expanded.payloadHash).not.toBe(first.payloadHash);
    expect(expanded.eventHash).not.toBe(first.eventHash);
  });

  it("rejects malformed provider payloads", () => {
    expect(() => normalizeShipStationTrackingWebhook({ resource_type: "API_TRACK" }, receivedAt))
      .toThrow(CarrierTrackingPayloadError);
  });

  it("classifies a documented tracking envelope without optional data separately", () => {
    try {
      normalizeShipStationTrackingWebhook({
        resource_type: "API_TRACK",
        resource_url: "https://api.shipstation.com/v2/tracking?carrier_code=ups&tracking_number=1Z999AA10123456784",
      }, receivedAt);
      throw new Error("Expected tracking normalization to reject a missing data object");
    } catch (error) {
      expect(error).toBeInstanceOf(CarrierTrackingPayloadError);
      expect(error).toMatchObject({ code: "SHIPSTATION_TRACKING_DATA_MISSING" });
    }
  });
});

describe("ShipStation declared-contents evidence", () => {
  it("retains exact positive quantities in deterministic WMS-line order", () => {
    expect(normalizeShipStationShipmentContentsEvidence([
      { lineItemKey: "wms-item-20", quantity: 2, sku: "REDACT-ME" },
      { lineItemKey: "wms-item-3", quantity: 4, unitPrice: 19.99 },
    ])).toEqual({
      status: "authoritative",
      providerItemCount: 2,
      recognizedProviderItemCount: 2,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
      shipmentItems: [
        { lineItemKey: "wms-item-3", quantity: 4 },
        { lineItemKey: "wms-item-20", quantity: 2 },
      ],
    });
  });

  it.each([
    [undefined, "omitted"],
    [[], "empty"],
    [null, "malformed"],
    [[{ lineItemKey: "external-line", quantity: 1 }], "unrecognized"],
    [[{ lineItemKey: "wms-item-10", quantity: "1" }], "malformed"],
    [[{ lineItemKey: "wms-item-10", quantity: 0 }], "malformed"],
    [[{ lineItemKey: "wms-item-10", quantity: 1.5 }], "malformed"],
    [[{ lineItemKey: "wms-item-2147483648", quantity: 1 }], "unrecognized"],
  ])("classifies non-authoritative input %# as %s", (rawItems, status) => {
    expect(normalizeShipStationShipmentContentsEvidence(rawItems)).toMatchObject({
      status,
      shipmentItems: [],
    });
  });

  it("keeps recognized review evidence but quarantines mixed and duplicate rows", () => {
    expect(normalizeShipStationShipmentContentsEvidence([
      { lineItemKey: "wms-item-10", quantity: 1 },
      { lineItemKey: "wms-item-10", quantity: 2 },
      { lineItemKey: "external-line", quantity: 1 },
      { lineItemKey: "wms-item-11", quantity: -1 },
    ])).toEqual({
      status: "mixed",
      providerItemCount: 4,
      recognizedProviderItemCount: 2,
      malformedItemCount: 1,
      unrecognizedItemCount: 1,
      duplicateLineItemCount: 1,
      shipmentItems: [{ lineItemKey: "wms-item-10", quantity: 3 }],
    });
  });

  it.each([
    [[2_147_483_647, 1, 1]],
    [[1, 2_147_483_647, 1]],
    [[1, 1, 2_147_483_647]],
  ])(
    "quarantines every row of an overflowing duplicate line regardless of row order %#",
    (quantities) => {
      const evidence = normalizeShipStationShipmentContentsEvidence([
        ...quantities.map((quantity) => ({
          lineItemKey: "wms-item-10",
          quantity,
        })),
        { lineItemKey: "wms-item-11", quantity: 2 },
      ]);

      expect(evidence).toEqual({
        status: "mixed",
        providerItemCount: 4,
        recognizedProviderItemCount: 1,
        malformedItemCount: 3,
        unrecognizedItemCount: 0,
        duplicateLineItemCount: 2,
        shipmentItems: [{ lineItemKey: "wms-item-11", quantity: 2 }],
      });
    },
  );

  it("quarantines whitespace-modified keys instead of silently normalizing authority", () => {
    expect(normalizeShipStationShipmentContentsEvidence([
      { lineItemKey: " wms-item-10 ", quantity: 1 },
    ])).toMatchObject({
      status: "unrecognized",
      unrecognizedItemCount: 1,
      shipmentItems: [],
    });
  });

  it("quarantines oversized arrays without inspecting or retaining their rows", () => {
    const evidence = normalizeShipStationShipmentContentsEvidence(
      Array.from({ length: 501 }, () => ({
        lineItemKey: "wms-item-10",
        quantity: 1,
      })),
    );
    expect(evidence).toMatchObject({
      status: "malformed",
      providerItemCount: 501,
      malformedItemCount: 501,
      shipmentItems: [],
    });
  });

  it("keeps the legacy key field while versioning exact redacted quantities", () => {
    const base = {
      shipmentId: 442_000_001,
      trackingNumber: "1Z999AA10123456784",
      isReturnLabel: false,
    };
    const quantityOne = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: [{
        lineItemKey: "wms-item-9638",
        quantity: 1,
        sku: "MUST-NOT-PERSIST",
        name: "MUST-NOT-PERSIST",
        unitPrice: 29.99,
        options: [{ secret: "MUST-NOT-PERSIST" }],
      }],
    }, receivedAt);
    const quantityTwo = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: [{ lineItemKey: "wms-item-9638", quantity: 2 }],
    }, receivedAt);

    expect(quantityOne.sanitizedPayload).toMatchObject({
      payloadSchemaVersion: 2,
      shipmentItems: [{ lineItemKey: "wms-item-9638" }],
      declaredContentsEvidence: {
        evidenceSchemaVersion: 1,
        status: "authoritative",
        reviewRequired: false,
        lines: [{ lineItemKey: "wms-item-9638", quantity: 1 }],
      },
    });
    expect(JSON.stringify(quantityOne.sanitizedPayload)).not.toMatch(
      /MUST-NOT-PERSIST|unitPrice|options/,
    );
    expect(quantityOne.eventHash).not.toBe(quantityTwo.eventHash);
  });

  it("bounds integrated legacy identities and rejects oversized raw keys before trimming", () => {
    const oversizedRawKey = " ".repeat(201) + "wms-item-10";
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 442_000_003,
      trackingNumber: "1Z999AA10123456786",
      isReturnLabel: false,
      shipmentItems: [
        { lineItemKey: "wms-item-2147483647", quantity: 1 },
        { lineItemKey: "wms-item-2147483648", quantity: 1 },
        { lineItemKey: oversizedRawKey, quantity: 1 },
      ],
    }, receivedAt);

    expect(observation.sanitizedPayload).toMatchObject({
      shipmentItems: [{ lineItemKey: "wms-item-2147483647" }],
      declaredContentsEvidence: {
        status: "mixed",
        providerItemCount: 3,
        recognizedProviderItemCount: 1,
        canonicalLineCount: 1,
        malformedItemCount: 0,
        unrecognizedItemCount: 2,
        duplicateLineItemCount: 0,
        rejectedItemCount: 2,
        reviewRequired: true,
        lines: [{ lineItemKey: "wms-item-2147483647", quantity: 1 }],
      },
    });
    expect(JSON.stringify(observation.sanitizedPayload)).not.toContain("wms-item-10");
    expect(observation.sourceObservationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes ordered redacted source rows separately from canonical contents", () => {
    const base = {
      shipmentId: 442_000_004,
      trackingNumber: "1Z999AA10123456787",
      isReturnLabel: false,
    };
    const forward = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: [
        { lineItemKey: "wms-item-20", quantity: 2, sku: "DO-NOT-HASH" },
        { lineItemKey: "wms-item-3", quantity: 4 },
      ],
    }, receivedAt);
    const replayWithDifferentUnknownFields = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: [
        {
          lineItemKey: "wms-item-20",
          quantity: 2,
          sku: "DIFFERENT-UNKNOWN-VALUE",
          options: [{ secret: "DO-NOT-HASH" }],
        },
        { lineItemKey: "wms-item-3", quantity: 4, name: "DO-NOT-HASH" },
      ],
    }, receivedAt);
    const reordered = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: [
        { lineItemKey: "wms-item-3", quantity: 4 },
        { lineItemKey: "wms-item-20", quantity: 2 },
      ],
    }, receivedAt);

    expect(forward.shipmentContentsEvidence).toEqual(reordered.shipmentContentsEvidence);
    expect(forward.sourceObservationHash).toBe(
      replayWithDifferentUnknownFields.sourceObservationHash,
    );
    expect(forward.eventHash).toBe(replayWithDifferentUnknownFields.eventHash);
    expect(forward.sourceObservationHash).not.toBe(reordered.sourceObservationHash);
    expect(forward.eventHash).not.toBe(reordered.eventHash);
    expect(JSON.stringify(replayWithDifferentUnknownFields.sanitizedPayload)).not.toMatch(
      /DO-NOT-HASH|DIFFERENT-UNKNOWN-VALUE|options/,
    );
  });

  it("does not collapse different bounded unrecognized source identities", () => {
    const base = {
      shipmentId: 442_000_005,
      trackingNumber: "1Z999AA10123456788",
      isReturnLabel: false,
    };
    const first = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: [{ lineItemKey: "external-line-a", quantity: 1 }],
    }, receivedAt);
    const second = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: [{ lineItemKey: "external-line-b", quantity: 1 }],
    }, receivedAt);

    expect(first.shipmentContentsEvidence).toEqual(second.shipmentContentsEvidence);
    expect(first.sourceObservationHash).not.toBe(second.sourceObservationHash);
    expect(first.eventHash).not.toBe(second.eventHash);
  });

  it("retains legacy link evidence while quarantining a missing quantity", () => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 442_000_002,
      trackingNumber: "1Z999AA10123456785",
      isReturnLabel: false,
      shipmentItems: [{ lineItemKey: "wms-item-9638" }],
    }, receivedAt);

    expect(observation.sanitizedPayload).toMatchObject({
      shipmentItems: [{ lineItemKey: "wms-item-9638" }],
      declaredContentsEvidence: {
        status: "malformed",
        reviewRequired: true,
        lines: [],
      },
    });
  });
});

describe("shipping-provider label normalization", () => {
  it("records a label artifact without inventing label-purchase time", () => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 442_000_001,
      orderId: 755_000_001,
      orderKey: "echelon-wms-shp-4814",
      trackingNumber: "1Z999AA10123456784",
      carrierCode: "ups",
      serviceCode: "ups_ground",
      createDate: "2026-07-20T09:55:00.000Z",
      shipDate: "2026-07-20T10:00:00.000Z",
      voidDate: null,
      shipmentItems: [
        { lineItemKey: "wms-item-9638", sku: "EG-SLV-VNT-P100" },
        { lineItemKey: "not-owned-9638" },
        { lineItemKey: " wms-item-9638 " },
      ],
    }, receivedAt);

    expect(observation).toMatchObject({
      providerLabelId: "442000001",
      providerOrderId: "755000001",
      providerOrderKey: "echelon-wms-shp-4814",
      labelStatus: "active",
      eventType: "label_observed",
      labelCreatedAt: null,
      observationSource: "shipstation_shipment_observation",
      sourceObservationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      sanitizedPayload: {
        createDate: "2026-07-20T09:55:00.000Z",
        observationSource: "shipstation_shipment_observation",
        sourceObservationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        shipmentItems: [{ lineItemKey: "wms-item-9638" }],
      },
    });
    expect(observation.providerOccurredAt?.toISOString()).toBe(
      "2026-07-20T10:00:00.000Z",
    );
    expect(observation.sanitizedPayload.sourceObservationHash).toBe(
      observation.sourceObservationHash,
    );
  });


  it("rejects an oversized provider createDate instead of retaining it", () => {
    expect(() => normalizeShipStationLabelObservation({
      shipmentId: 442_000_006,
      trackingNumber: "1Z999AA10123456789",
      createDate: "x".repeat(81),
      isReturnLabel: false,
    }, receivedAt)).toThrow(CarrierTrackingPayloadError);
  });

  it("preserves provider-declared return direction without changing label status", () => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 448_076_377,
      orderId: 765_185_209,
      orderKey: "echelon-wms-shp-10374",
      trackingNumber: "9434650206217258521132",
      carrierCode: "stamps_com",
      shipDate: "2026-07-27T20:00:00.000Z",
      voidDate: null,
      isReturnLabel: true,
      shipmentItems: [{ lineItemKey: "wms-item-11013", sku: "SHLZ-BNDR-PSA-BLK-P1" }],
    }, receivedAt);

    expect(observation).toMatchObject({
      labelDirection: "return",
      labelStatus: "active",
      sanitizedPayload: {
        isReturnLabel: true,
        shipmentItems: [{ lineItemKey: "wms-item-11013" }],
      },
    });
  });
  it("keeps omitted return-label direction non-dispatchable", () => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 448_490_235,
      orderId: 768_182_356,
      trackingNumber: "9434650206217259597839",
      carrierCode: "stamps_com",
      shipDate: "2026-07-25T20:00:00.000Z",
      voidDate: null,
      shipmentItems: [{ lineItemKey: "wms-item-311485", quantity: 1 }],
    }, receivedAt);

    expect(observation).toMatchObject({
      labelDirection: "unknown",
      labelStatus: "active",
      sanitizedPayload: {
        isReturnLabel: undefined,
      },
    });
  });
  it("records an explicitly voided label as voided evidence", () => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 442_000_001,
      trackingNumber: "1Z999AA10123456784",
      voidDate: "2026-07-20T11:00:00.000Z",
    }, receivedAt);
    expect(observation.labelStatus).toBe("voided");
    expect(observation.eventType).toBe("label_voided");
    expect(observation.voidedAt?.toISOString()).toBe("2026-07-20T11:00:00.000Z");
  });

  it("allows missing provider-order identity to be filled later", () => {
    expect(() => assertStableShippingProviderLabelIdentity({
      normalizedTrackingNumber: "1Z999AA10123456784",
      providerOrderId: null,
      providerOrderKey: null,
    }, {
      provider: "shipstation",
      providerLabelId: "442000001",
      normalizedTrackingNumber: "1Z999AA10123456784",
      providerOrderId: "755000001",
      providerOrderKey: "echelon-wms-shp-4814",
    })).not.toThrow();
  });

  it.each([
    ["tracking number", { normalizedTrackingNumber: "9400111899223856928499" }],
    ["provider order id", { providerOrderId: "755000002" }],
    ["provider order key", { providerOrderKey: "echelon-wms-shp-9999" }],
  ])("rejects immutable label identity drift in the %s", (_field, override) => {
    expect(() => assertStableShippingProviderLabelIdentity({
      normalizedTrackingNumber: "1Z999AA10123456784",
      providerOrderId: "755000001",
      providerOrderKey: "echelon-wms-shp-4814",
    }, {
      provider: "shipstation",
      providerLabelId: "442000001",
      normalizedTrackingNumber: "1Z999AA10123456784",
      providerOrderId: "755000001",
      providerOrderKey: "echelon-wms-shp-4814",
      ...override,
    })).toThrow(ShippingProviderLabelIdentityConflictError);
  });
  it("rejects unsafe provider numeric identities before string conversion", () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    expect(normalizeShipStationLabelObservation({
      shipmentId: maximum,
      orderId: maximum,
      trackingNumber: "1Z999AA10123456784",
      isReturnLabel: false,
    }, receivedAt)).toMatchObject({
      providerLabelId: String(maximum),
      providerOrderId: String(maximum),
    });

    for (const raw of [
      { shipmentId: Number.MAX_SAFE_INTEGER + 1 },
      { shipmentId: 44_001, orderId: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => normalizeShipStationLabelObservation({
        ...raw,
        trackingNumber: "1Z999AA10123456784",
        isReturnLabel: false,
      }, receivedAt)).toThrow(CarrierTrackingPayloadError);
    }
  });

  it("aligns provider order keys with the persisted varchar(200) boundary", () => {
    const maximumOrderKey = "k".repeat(200);
    expect(normalizeShipStationLabelObservation({
      shipmentId: 44_001,
      orderKey: maximumOrderKey,
      trackingNumber: "1Z999AA10123456784",
      isReturnLabel: false,
    }, receivedAt).providerOrderKey).toBe(maximumOrderKey);
    expect(() => normalizeShipStationLabelObservation({
      shipmentId: 44_001,
      orderKey: "k".repeat(201),
      trackingNumber: "1Z999AA10123456784",
      isReturnLabel: false,
    }, receivedAt)).toThrow(CarrierTrackingPayloadError);
  });

  it("distinguishes malformed containers without retaining their raw values", () => {
    const base = {
      shipmentId: 44_001,
      trackingNumber: "1Z999AA10123456784",
      isReturnLabel: false,
    };
    const first = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: "SECRET-MALFORMED-A",
    }, receivedAt);
    const second = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: "SECRET-MALFORMED-B",
    }, receivedAt);

    expect(first.shipmentContentsEvidence).toEqual(second.shipmentContentsEvidence);
    expect(first.sourceObservationHash).not.toBe(second.sourceObservationHash);
    expect(first.eventHash).not.toBe(second.eventHash);
    expect(JSON.stringify(first.sanitizedPayload)).not.toContain("SECRET-MALFORMED-A");
    expect(JSON.stringify(second.sanitizedPayload)).not.toContain("SECRET-MALFORMED-B");
  });

  it("distinguishes sampled row order in oversized arrays without retaining rows", () => {
    const forwardItems = Array.from({ length: 501 }, (_unused, index) => ({
      lineItemKey: `wms-item-${index + 1}`,
      quantity: 1,
    }));
    const reorderedItems = forwardItems.map((item) => ({ ...item }));
    [reorderedItems[0], reorderedItems[1]] = [reorderedItems[1], reorderedItems[0]];
    const base = {
      shipmentId: 44_001,
      trackingNumber: "1Z999AA10123456784",
      isReturnLabel: false,
    };
    const forward = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: forwardItems,
    }, receivedAt);
    const reordered = normalizeShipStationLabelObservation({
      ...base,
      shipmentItems: reorderedItems,
    }, receivedAt);

    expect(forward.shipmentContentsEvidence).toEqual(reordered.shipmentContentsEvidence);
    expect(forward.sourceObservationHash).not.toBe(reordered.sourceObservationHash);
    expect(forward.eventHash).not.toBe(reordered.eventHash);
    expect(forward.sanitizedPayload).toMatchObject({
      shipmentItems: [],
      declaredContentsEvidence: {
        status: "malformed",
        providerItemCount: 501,
      },
    });
  });
});

describe("carrier tracking label matching", () => {
  it("matches exactly one active label", () => {
    expect(resolveCarrierTrackingMatch([candidate()])).toMatchObject({
      status: "matched",
      candidateCount: 1,
      selectedCandidate: { shippingProviderLabelId: 10 },
    });
  });

  it("does not choose between multiple active labels", () => {
    expect(resolveCarrierTrackingMatch([
      candidate(),
      candidate({ shippingProviderLabelId: 11, providerLabelId: "label-2" }),
    ])).toMatchObject({ status: "ambiguous", candidateCount: 2, selectedCandidate: null });
  });

  it("classifies movement against a voided label separately", () => {
    expect(resolveCarrierTrackingMatch([candidate({ labelStatus: "voided" })]))
      .toMatchObject({ status: "voided_label", candidateCount: 1 });
  });

  it("leaves an event unmatched when no label exists", () => {
    expect(resolveCarrierTrackingMatch([]))
      .toMatchObject({ status: "unmatched", candidateCount: 0, selectedCandidate: null });
  });
});
