import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCarrierTrackingProjectionReader,
  type CarrierTrackingPackageProjection,
} from "../../carrier-tracking-projection.repository";
import {
  CARRIER_TRACKING_PROJECTION_PATH,
  registerCarrierTrackingProjectionRoutes,
} from "../../carrier-tracking-projection.routes";

const openServers: http.Server[] = [];
const originalInternalApiKey = process.env.INTERNAL_API_KEY;

function packageProjection(
  overrides: Partial<CarrierTrackingPackageProjection> = {},
): CarrierTrackingPackageProjection {
  return {
    providerLabelId: "10",
    provider: "shipstation",
    providerLabelReference: "label-10",
    providerOrderId: "order-20",
    providerOrderKey: null,
    trackingNumber: "1Z999",
    normalizedTrackingNumber: "1Z999",
    carrier: "ups",
    canonicalStatus: "in_transit",
    dispatchEvidence: "confirmed",
    dispatchConfirmed: true,
    statusDescription: "In transit",
    eventOccurredAt: new Date("2026-07-21T11:00:00.000Z"),
    estimatedDeliveryAt: new Date("2026-07-23T12:00:00.000Z"),
    actualDeliveryAt: null,
    latestEventId: "30",
    latestMatchId: "40",
    stateChangedAt: new Date("2026-07-21T11:01:00.000Z"),
    ...overrides,
  };
}

async function listen(app: Express): Promise<string> {
  const server = http.createServer(app);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  process.env.INTERNAL_API_KEY = "internal-test-key";
});

afterEach(async () => {
  if (originalInternalApiKey === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = originalInternalApiKey;
  await Promise.all(openServers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("carrier tracking projection repository", () => {
  it("returns a stable keyset page and never exposes the lookahead row", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          provider_label_id: "10",
          provider: "shipstation",
          provider_label_reference: "label-10",
          provider_order_id: "order-20",
          provider_order_key: null,
          tracking_number: "1Z999",
          normalized_tracking_number: "1Z999",
          carrier: "ups",
          canonical_status: "in_transit",
          dispatch_evidence: "confirmed",
          dispatch_confirmed: true,
          status_description: "In transit",
          event_occurred_at: "2026-07-21T11:00:00.000Z",
          estimated_delivery_at: null,
          actual_delivery_at: null,
          latest_event_id: "30",
          latest_match_id: "40",
          state_changed_at: "2026-07-21T11:01:00.000Z",
        },
        {
          provider_label_id: "11",
          provider: "shipstation",
          provider_label_reference: "label-11",
          provider_order_id: "order-21",
          provider_order_key: null,
          tracking_number: "9400",
          normalized_tracking_number: "9400",
          carrier: "stamps_com",
          canonical_status: "delivered",
          dispatch_evidence: "confirmed",
          dispatch_confirmed: true,
          status_description: "Delivered",
          event_occurred_at: "2026-07-21T12:00:00.000Z",
          estimated_delivery_at: null,
          actual_delivery_at: "2026-07-21T12:00:00.000Z",
          latest_event_id: "31",
          latest_match_id: "41",
          state_changed_at: "2026-07-21T12:01:00.000Z",
        },
      ],
    });
    const reader = createCarrierTrackingProjectionReader({ execute });

    const result = await reader.listChangedPackages({
      changedSince: null,
      observedThrough: new Date("2026-07-21T13:00:00.000Z"),
      after: null,
      limit: 1,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      hasMore: true,
      packages: [{ providerLabelId: "10", canonicalStatus: "in_transit" }],
      nextCursor: {
        providerLabelId: "10",
        stateChangedAt: new Date("2026-07-21T11:01:00.000Z"),
      },
    });
  });
});

describe("carrier tracking projection route", () => {
  it("requires the internal API key and returns serialized package state", async () => {
    const listChangedPackages = vi.fn().mockResolvedValue({
      packages: [packageProjection()],
      hasMore: false,
      nextCursor: {
        providerLabelId: "10",
        stateChangedAt: new Date("2026-07-21T11:01:00.000Z"),
      },
    });
    const app = express();
    registerCarrierTrackingProjectionRoutes(app, {
      reader: { listChangedPackages },
      now: () => new Date("2026-07-21T12:00:00.000Z"),
    });
    const baseUrl = await listen(app);

    const unauthorized = await fetch(`${baseUrl}${CARRIER_TRACKING_PROJECTION_PATH}`);
    expect(unauthorized.status).toBe(401);
    expect(listChangedPackages).not.toHaveBeenCalled();

    const response = await fetch(
      `${baseUrl}${CARRIER_TRACKING_PROJECTION_PATH}?changedSince=2026-07-20T00:00:00.000Z&limit=25`,
      { headers: { Authorization: "Bearer internal-test-key" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      packages: [{
        providerLabelId: "10",
        canonicalStatus: "in_transit",
        eventOccurredAt: "2026-07-21T11:00:00.000Z",
      }],
      page: {
        observedThrough: "2026-07-21T12:00:00.000Z",
        hasMore: false,
      },
    });
    expect(listChangedPackages).toHaveBeenCalledWith({
      changedSince: new Date("2026-07-20T00:00:00.000Z"),
      observedThrough: new Date("2026-07-21T12:00:00.000Z"),
      after: null,
      limit: 25,
    });
  });

  it("rejects incomplete cursors before querying the database", async () => {
    const listChangedPackages = vi.fn();
    const app = express();
    registerCarrierTrackingProjectionRoutes(app, { reader: { listChangedPackages } });
    const baseUrl = await listen(app);

    const response = await fetch(
      `${baseUrl}${CARRIER_TRACKING_PROJECTION_PATH}?afterProviderLabelId=10`,
      { headers: { Authorization: "Bearer internal-test-key" } },
    );
    expect(response.status).toBe(400);
    expect(listChangedPackages).not.toHaveBeenCalled();
  });
});
