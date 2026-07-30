import { describe, expect, it, vi } from "vitest";

import {
  createShipStationLabelTrackingRequest,
  createShipStationTrackingEventsClient,
  isRetryableTrackingEventsError,
  ShipStationTrackingEventsError,
} from "../../shipstation-tracking-events.client";

describe("ShipStation exact-label tracking client", () => {
  it("constructs the exact allowlisted provider-label endpoint", () => {
    expect(createShipStationLabelTrackingRequest({
      providerLabelId: " se-448530246 ",
      carrierCode: " STAMPS_COM ",
      trackingNumber: " 9434650106151112859195 ",
    })).toEqual({
      providerLabelId: "448530246",
      carrierCode: "stamps_com",
      trackingNumber: "9434650106151112859195",
      normalizedTrackingNumber: "9434650106151112859195",
      resourceUrl: "https://api.shipstation.com/v2/labels/se-448530246/track",
    });
  });

  it("fetches a label snapshot and rejects mismatched stored identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tracking_number: "9434650106151112859195",
      carrier_code: "stamps_com",
      status_code: "EX",
      events: [{
        occurred_at: "2026-07-28T23:49:00.000Z",
        description: "Arrived at USPS Regional Facility",
        city_locality: "WARRENDALE",
        state_province: "PA",
      }],
    }), { status: 200 }));
    const client = createShipStationTrackingEventsClient({
      apiKey: "secret",
      fetchImpl,
      minimumRequestIntervalMs: 0,
    });
    const request = createShipStationLabelTrackingRequest({
      providerLabelId: "448530246",
      carrierCode: "stamps_com",
      trackingNumber: "9434650106151112859195",
    });

    await expect(client.getLabelTrackingSnapshot!(request)).resolves.toMatchObject({
      httpStatus: 200,
      payload: { status_code: "EX" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.shipstation.com/v2/labels/se-448530246/track",
      expect.objectContaining({
        method: "GET",
        headers: { "API-Key": "secret" },
      }),
    );

    await expect(client.getLabelTrackingSnapshot!({
      ...request,
      providerLabelId: "448530247",
    })).rejects.toMatchObject({ code: "INVALID_RESOURCE_URL" });
  });

  it("preserves provider label identity for service-level validation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      label_id: "se-448530247",
      tracking_number: "9434650106151112859195",
      carrier_code: "stamps_com",
      status_code: "IT",
      events: [],
    }), { status: 200 }));
    const client = createShipStationTrackingEventsClient({
      apiKey: "secret",
      fetchImpl,
      minimumRequestIntervalMs: 0,
    });
    const request = createShipStationLabelTrackingRequest({
      providerLabelId: "448530246",
      carrierCode: "stamps_com",
      trackingNumber: "9434650106151112859195",
    });

    await expect(client.getLabelTrackingSnapshot!(request)).resolves.toMatchObject({
      payload: { label_id: "se-448530247" },
    });
  });

  it("treats ShipStation's temporary HTTP 400 response as retryable", async () => {
    const client = createShipStationTrackingEventsClient({
      apiKey: "secret",
      minimumRequestIntervalMs: 0,
      fetchImpl: vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ message: "Service Temporarily Unavailable" }),
        { status: 400 },
      )),
    });
    const error = await client.getLabelTrackingSnapshot!(
      createShipStationLabelTrackingRequest({
        providerLabelId: "448530246",
        carrierCode: "stamps_com",
        trackingNumber: "9434650106151112859195",
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ShipStationTrackingEventsError);
    expect(isRetryableTrackingEventsError(error)).toBe(true);
  });
});
