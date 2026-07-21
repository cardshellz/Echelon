import { describe, expect, it } from "vitest";

import {
  CarrierTrackingPayloadError,
  ShippingProviderLabelIdentityConflictError,
  assertStableShippingProviderLabelIdentity,
  normalizeShipStationLabelObservation,
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

describe("shipping-provider label normalization", () => {
  it("records a label artifact without inventing label-purchase time", () => {
    const observation = normalizeShipStationLabelObservation({
      shipmentId: 442_000_001,
      orderId: 755_000_001,
      orderKey: "echelon-wms-shp-4814",
      trackingNumber: "1Z999AA10123456784",
      carrierCode: "ups",
      serviceCode: "ups_ground",
      shipDate: "2026-07-20T10:00:00.000Z",
      voidDate: null,
    }, receivedAt);

    expect(observation).toMatchObject({
      providerLabelId: "442000001",
      providerOrderId: "755000001",
      providerOrderKey: "echelon-wms-shp-4814",
      labelStatus: "active",
      eventType: "label_observed",
      labelCreatedAt: null,
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
