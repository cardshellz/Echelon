import { describe, expect, it, vi } from "vitest";

import {
  createShipStationTrackingSubscriptionsClient,
  isRetryableTrackingSubscriptionError,
  ShipStationTrackingSubscriptionError,
} from "../../shipstation-tracking-subscriptions.client";

describe("ShipStation tracking subscriptions client", () => {
  it("subscribes one carrier tuple using the documented API-Key contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createShipStationTrackingSubscriptionsClient({
      apiKey: "test-key",
      baseUrl: "https://api.shipstation.test/v2/",
      fetchImpl,
    });

    await expect(client.startTracking({
      carrierCode: "stamps_com",
      trackingNumber: "9400 123",
    })).resolves.toEqual({ httpStatus: 204 });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.shipstation.test/v2/tracking/start?carrier_code=stamps_com&tracking_number=9400+123",
      expect.objectContaining({
        method: "POST",
        headers: { "API-Key": "test-key" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fails closed when the API key is absent", async () => {
    const fetchImpl = vi.fn();
    const client = createShipStationTrackingSubscriptionsClient({ apiKey: "", fetchImpl });

    expect(client.isConfigured()).toBe(false);
    await expect(client.startTracking({
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
    })).rejects.toMatchObject({ code: "CONFIGURATION" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an insecure API base URL before sending credentials", () => {
    expect(() => createShipStationTrackingSubscriptionsClient({
      apiKey: "test-key",
      baseUrl: "http://api.shipstation.test/v2",
    })).toThrow(/HTTPS/);
  });

  it("serializes request starts through the configured provider pacing interval", async () => {
    let nowMs = 1_000;
    const sleepImpl = vi.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createShipStationTrackingSubscriptionsClient({
      apiKey: "test-key",
      fetchImpl,
      minimumRequestIntervalMs: 250,
      nowMs: () => nowMs,
      sleepImpl,
    });

    await Promise.all([
      client.startTracking({ carrierCode: "ups", trackingNumber: "1Z111" }),
      client.startTracking({ carrierCode: "ups", trackingNumber: "1Z222" }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(250);
  });

  it("classifies rate limits and server failures as retryable but bad input as review", () => {
    expect(isRetryableTrackingSubscriptionError(new ShipStationTrackingSubscriptionError(
      "HTTP",
      "rate limited",
      { status: 429 },
    ))).toBe(true);
    expect(isRetryableTrackingSubscriptionError(new ShipStationTrackingSubscriptionError(
      "HTTP",
      "server failed",
      { status: 503 },
    ))).toBe(true);
    expect(isRetryableTrackingSubscriptionError(new ShipStationTrackingSubscriptionError(
      "HTTP",
      "bad carrier",
      { status: 400 },
    ))).toBe(false);
  });

  it("retains a bounded provider response without treating HTTP 200 as activation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: "unexpected" }),
      { status: 200 },
    ));
    const client = createShipStationTrackingSubscriptionsClient({
      apiKey: "test-key",
      fetchImpl,
    });

    await expect(client.startTracking({
      carrierCode: "ups",
      trackingNumber: "1Z999AA10123456784",
    })).rejects.toMatchObject({
      code: "UNEXPECTED_RESPONSE",
      context: expect.objectContaining({ status: 200 }),
    });
  });
});
