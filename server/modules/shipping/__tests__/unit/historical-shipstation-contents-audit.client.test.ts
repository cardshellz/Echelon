import { describe, expect, it, vi } from "vitest";

import {
  createHistoricalShipStationContentsClient,
  HistoricalShipStationContentsClientError,
} from "../../historical-shipstation-contents-audit.client";
import type { HistoricalShipStationExpectedContentsEvidence } from "../../historical-shipstation-contents-recovery.domain";

const expectedContents: HistoricalShipStationExpectedContentsEvidence = {
  kind: "available",
  source: "physical_shipment",
  lines: [
    { wmsShipmentItemId: 7_001, sku: "SKU-A", quantity: 2 },
    { wmsShipmentItemId: 7_002, sku: "SKU-B", quantity: 1 },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch) {
  return createHistoricalShipStationContentsClient({
    apiKey: "test-key",
    apiSecret: "test-secret",
    minimumRequestIntervalMs: 0,
    maxRetries: 0,
    fetchImpl,
  });
}

describe("historical ShipStation contents audit client", () => {
  it("requests shipment items and returns only a normalized aggregate summary", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      shipments: [{
        shipmentId: 44_001,
        trackingNumber: "SECRET-TRACKING",
        shipmentItems: [
          { lineItemKey: "wms-item-7002", quantity: 1, sku: "SECRET-SKU" },
          { lineItemKey: "wms-item-7001", quantity: 2, name: "SECRET-NAME" },
        ],
      }],
    }));
    const result = await client(fetchImpl as typeof fetch).loadShipmentContents(
      44_001,
      expectedContents,
    );

    expect(result).toMatchObject({
      kind: "found",
      evidence: {
        status: "authoritative",
        recoveryStatus: "provider_line_keys_authoritative",
        providerItemCount: 2,
        recognizedProviderItemCount: 2,
        canonicalLineCount: 2,
        malformedItemCount: 0,
        unrecognizedItemCount: 0,
        duplicateLineItemCount: 0,
        recoveryEvidence: {
          contractVersion: 1,
          evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          attestedLineCount: 2,
        },
      },
    });
    const [request, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(request));
    expect(url.origin).toBe("https://ssapi.shipstation.com");
    expect(url.pathname).toBe("/shipments");
    expect(url.searchParams.get("shipmentId")).toBe("44001");
    expect(url.searchParams.get("includeShipmentItems")).toBe("true");
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from("test-key:test-secret").toString("base64")}`,
        Accept: "application/json",
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("classifies exact SKU and quantity recovery and retains only review-safe provider lines", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      shipments: [{
        shipmentId: 44_001,
        shipmentItems: [
          { lineItemKey: null, sku: "SKU-B", quantity: 1, name: "SECRET-NAME-B" },
          { lineItemKey: null, sku: "SKU-A", quantity: 2, name: "SECRET-NAME-A" },
        ],
      }],
    }));

    const result = await client(fetchImpl as typeof fetch).loadShipmentContents(
      44_001,
      expectedContents,
    );

    expect(result).toMatchObject({
      kind: "found",
      evidence: {
        status: "unrecognized",
        recoveryStatus: "exact_unique_wms_match",
        providerItemCount: 2,
        recoveryEvidence: {
          contractVersion: 1,
          evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          attestedLineCount: 2,
        },
      },
      providerObservation: {
        evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        lines: [
          { sku: "SKU-B", quantity: 1 },
          { sku: "SKU-A", quantity: 2 },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("keeps provider/WMS contradictions in review with bounded provider line evidence", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      shipments: [{
        shipmentId: 44_001,
        shipmentItems: [{ lineItemKey: null, sku: "CONFLICTING-SKU", quantity: 5 }],
      }],
    }));

    const result = await client(fetchImpl as typeof fetch).loadShipmentContents(
      44_001,
      expectedContents,
    );

    expect(result).toMatchObject({
      kind: "found",
      evidence: {
        status: "unrecognized",
        recoveryStatus: "provider_wms_conflict",
        recoveryEvidence: null,
      },
      providerObservation: {
        evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        lines: [{ sku: "CONFLICTING-SKU", quantity: 5 }],
      },
    });
  });

  it.each([
    [undefined, "omitted"],
    [[], "empty"],
    [[{ lineItemKey: "external-1", quantity: 1 }], "unrecognized"],
    [[null], "malformed"],
    [[
      { lineItemKey: "wms-item-7001", quantity: 1 },
      { lineItemKey: "external-1", quantity: 1 },
    ], "mixed"],
  ])("classifies bounded provider contents without retaining them (%s)", async (items, status) => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      shipments: [{ shipmentId: 44_001, shipmentItems: items }],
    }));

    await expect(
      client(fetchImpl as typeof fetch).loadShipmentContents(44_001, expectedContents),
    ).resolves.toMatchObject({
      kind: "found",
      evidence: { status, recoveryEvidence: null },
    });
  });

  it("returns not_found only when the requested shipment identity is absent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      shipments: [{ shipmentId: 44_002, shipmentItems: [] }],
    }));
    await expect(
      client(fetchImpl as typeof fetch).loadShipmentContents(44_001, expectedContents),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("rejects duplicate response identity and does not expose the provider body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      shipments: [
        { shipmentId: 44_001, shipmentItems: [], marker: "SECRET-MARKER" },
        { shipmentId: 44_001, shipmentItems: [] },
      ],
    }));
    const promise = client(fetchImpl as typeof fetch).loadShipmentContents(
      44_001,
      expectedContents,
    );

    await expect(promise).rejects.toMatchObject({ code: "INVALID_RESPONSE", context: {} });
    await promise.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain("SECRET-MARKER");
    });
  });

  it("classifies unsuccessful responses without retaining their body", async () => {
    const fetchImpl = vi.fn(async () => new Response("SECRET-PROVIDER-BODY", { status: 401 }));
    const promise = client(fetchImpl as typeof fetch).loadShipmentContents(
      44_001,
      expectedContents,
    );

    await expect(promise).rejects.toMatchObject({
      code: "HTTP",
      context: { status: 401 },
    });
    await promise.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain("SECRET-PROVIDER-BODY");
    });
  });

  it("requires exact credentials before making any request", () => {
    expect(() => createHistoricalShipStationContentsClient({
      apiKey: " test-key ",
      apiSecret: "test-secret",
    })).toThrow(HistoricalShipStationContentsClientError);
  });
});
