import { describe, expect, it, vi } from "vitest";

import {
  createShipStationTrackingEventsClient,
  isRetryableTrackingEventsError,
  parseShipStationTrackingResourceUrl,
  ShipStationTrackingEventsError,
} from "../../shipstation-tracking-events.client";

const resourceUrl = "https://api.shipengine.com/v1/tracking"
  + "?carrier_code=ups&tracking_number=1Z999AA10123456784";

describe("ShipStation tracking event hydration client", () => {
  it("accepts only the configured HTTPS tracking endpoint and exact identity parameters", () => {
    expect(parseShipStationTrackingResourceUrl(resourceUrl)).toEqual({
      resourceUrl,
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
      normalizedTrackingNumber: "1Z999AA10123456784",
    });

    const rejected = [
      "http://api.shipengine.com/v1/tracking?carrier_code=ups&tracking_number=1Z1",
      "https://example.com/v1/tracking?carrier_code=ups&tracking_number=1Z1",
      "https://user:secret@api.shipengine.com/v1/tracking?carrier_code=ups&tracking_number=1Z1",
      "https://api.shipengine.com/v1/labels?carrier_code=ups&tracking_number=1Z1",
      "https://api.shipengine.com/v1/tracking?carrier_code=ups",
      "https://api.shipengine.com/v1/tracking?carrier_code=ups&carrier_code=fedex&tracking_number=1Z1",
    ];
    for (const candidate of rejected) {
      expect(() => parseShipStationTrackingResourceUrl(candidate)).toThrow(
        ShipStationTrackingEventsError,
      );
    }
  });

  it("reconstructs the allowlisted request, sends API-Key, and accepts only HTTP 200 objects", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tracking_number: "1Z999AA10123456784",
      carrier_code: "ups",
      status_code: "AC",
      events: [],
    }), { status: 200 }));
    const client = createShipStationTrackingEventsClient({
      apiKey: "tracking-secret",
      fetchImpl,
      minimumRequestIntervalMs: 0,
    });

    await expect(client.getTrackingSnapshot(
      parseShipStationTrackingResourceUrl(resourceUrl),
    )).resolves.toMatchObject({
      httpStatus: 200,
      payload: { tracking_number: "1Z999AA10123456784" },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.shipengine.com/v1/tracking"
        + "?carrier_code=ups&tracking_number=1Z999AA10123456784",
      expect.objectContaining({
        method: "GET",
        headers: { "API-Key": "tracking-secret" },
      }),
    );
  });

  it("classifies rate limits and transport failures as retryable without retrying bad evidence", () => {
    expect(isRetryableTrackingEventsError(new ShipStationTrackingEventsError(
      "HTTP",
      "rate limited",
      { status: 429 },
    ))).toBe(true);
    expect(isRetryableTrackingEventsError(new ShipStationTrackingEventsError(
      "TIMEOUT",
      "timed out",
    ))).toBe(true);
    expect(isRetryableTrackingEventsError(new ShipStationTrackingEventsError(
      "INVALID_RESPONSE",
      "identity mismatch",
    ))).toBe(false);
  });

  it("fails closed on missing credentials and invalid base URL configuration", async () => {
    const client = createShipStationTrackingEventsClient({
      apiKey: "",
      minimumRequestIntervalMs: 0,
    });
    expect(client.isConfigured()).toBe(false);
    await expect(client.getTrackingSnapshot(
      parseShipStationTrackingResourceUrl(resourceUrl),
    )).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(() => createShipStationTrackingEventsClient({
      apiKey: "secret",
      baseUrl: "not-a-url",
    })).toThrowError(ShipStationTrackingEventsError);
    expect(() => createShipStationTrackingEventsClient({
      apiKey: "secret",
      baseUrl: "http://api.shipengine.test/v1",
    })).toThrow(/HTTPS/);
  });

  it("rejects non-200 responses and non-object JSON payloads", async () => {
    const throttled = createShipStationTrackingEventsClient({
      apiKey: "secret",
      minimumRequestIntervalMs: 0,
      fetchImpl: vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })),
    });
    await expect(throttled.getTrackingSnapshot(
      parseShipStationTrackingResourceUrl(resourceUrl),
    )).rejects.toMatchObject({ code: "HTTP", context: { status: 429 } });

    const invalid = createShipStationTrackingEventsClient({
      apiKey: "secret",
      minimumRequestIntervalMs: 0,
      fetchImpl: vi.fn().mockResolvedValue(new Response("[]", { status: 200 })),
    });
    await expect(invalid.getTrackingSnapshot(
      parseShipStationTrackingResourceUrl(resourceUrl),
    )).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("classifies response-stream failures as retryable transport errors", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error("socket closed"));
      },
    }), { status: 200 });
    const client = createShipStationTrackingEventsClient({
      apiKey: "secret",
      minimumRequestIntervalMs: 0,
      fetchImpl: vi.fn().mockResolvedValue(response),
    });

    const error = await client.getTrackingSnapshot(
      parseShipStationTrackingResourceUrl(resourceUrl),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "NETWORK",
      context: { status: 200 },
    });
    expect(isRetryableTrackingEventsError(error)).toBe(true);
  });
});
