import { describe, expect, it, vi } from "vitest";

import {
  createHistoricalShipStationContentsClient,
  HistoricalShipStationContentsClientError,
} from "../../historical-shipstation-contents-audit.client";

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
    const result = await client(fetchImpl as typeof fetch).loadShipmentContents(44_001);

    expect(result).toEqual({
      kind: "found",
      evidence: {
        status: "authoritative",
        providerItemCount: 2,
        recognizedProviderItemCount: 2,
        canonicalLineCount: 2,
        malformedItemCount: 0,
        unrecognizedItemCount: 0,
        duplicateLineItemCount: 0,
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
      client(fetchImpl as typeof fetch).loadShipmentContents(44_001),
    ).resolves.toMatchObject({ kind: "found", evidence: { status } });
  });

  it("returns not_found only when the requested shipment identity is absent", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      shipments: [{ shipmentId: 44_002, shipmentItems: [] }],
    }));
    await expect(
      client(fetchImpl as typeof fetch).loadShipmentContents(44_001),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("rejects duplicate response identity and does not expose the provider body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      shipments: [
        { shipmentId: 44_001, shipmentItems: [], marker: "SECRET-MARKER" },
        { shipmentId: 44_001, shipmentItems: [] },
      ],
    }));
    const promise = client(fetchImpl as typeof fetch).loadShipmentContents(44_001);

    await expect(promise).rejects.toMatchObject({ code: "INVALID_RESPONSE", context: {} });
    await promise.catch((error: unknown) => {
      expect(JSON.stringify(error)).not.toContain("SECRET-MARKER");
    });
  });

  it("classifies unsuccessful responses without retaining their body", async () => {
    const fetchImpl = vi.fn(async () => new Response("SECRET-PROVIDER-BODY", { status: 401 }));
    const promise = client(fetchImpl as typeof fetch).loadShipmentContents(44_001);

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
