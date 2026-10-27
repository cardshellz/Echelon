import { describe, expect, it, vi } from "vitest";
import {
  createPackageHistoryShipStationRequester,
  createPackageHistorySource,
} from "../../package-history.source";
import { PackageHistoryError } from "../../package-history.domain";
import type { ShipStationApiRequester } from "../../../oms/shipstation-api-request";
function fixtureRequester(
  read: (method: string, path: string) => Promise<unknown>,
): ShipStationApiRequester {
  return async <T>(method: string, path: string): Promise<T> =>
    (await read(method, path)) as T;
}

const now = new Date("2026-09-23T12:00:00Z");
const shipment = (shipmentId: number) => ({
  shipmentId,
  orderId: 99,
  orderNumber: "12",
  orderKey: "1001-2001",
  trackingNumber: "TRACK",
  isReturnLabel: false,
  voided: false,
  voidDate: null,
  shipmentItems: [{ lineItemKey: "501", sku: "PRODUCT", quantity: 1 }],
  dimensions: { units: "inches", length: 10, width: 8, height: 4 },
});
describe("package history provider boundary", () => {
  it("reuses retained verified measurements only when a provider response omits them", async () => {
    const dimensions = { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 },
      observation = { version: 1, status: "verified", dimensions };
    const query = vi.fn(async () => ({
      rows: [
        {
          labelStatus: "active",
          labelDirection: "outbound",
          trackingNumber: "TRACK",
          recorded: true,
          measurement: {
            observation,
            observedAt: now.toISOString(),
            eventHash: "a".repeat(64),
          },
          evidence: observation,
        },
      ],
    }));
    const source = createPackageHistorySource({
      pool: { query },
      shopify: { read: vi.fn() },
      now: () => now,
      shipstation: fixtureRequester(async () => ({
        page: 1,
        pages: 1,
        total: 1,
        shipments: [{ ...shipment(601), dimensions: null }],
      })),
    });
    expect((await source.shipments("TRACK"))[0].recordedDimensions).toEqual(
      dimensions,
    );
    expect(query).toHaveBeenCalledOnce();
    const invalid = createPackageHistorySource({
      pool: { query },
      shopify: { read: vi.fn() },
      now: () => now,
      shipstation: fixtureRequester(async () => ({
        page: 1,
        pages: 1,
        total: 1,
        shipments: [
          {
            ...shipment(601),
            dimensions: { units: "inches", length: 0, width: 8, height: 4 },
          },
        ],
      })),
    });
    expect(
      (await invalid.shipments("TRACK"))[0].recordedDimensions,
    ).toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
  });
  it("exposes only same-origin GET shipments reads", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    const request = createPackageHistoryShipStationRequester({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      request: fetcher as typeof fetch,
    });
    for (const [method, path] of [
      ["POST", "/shipments"],
      ["GET", "https://other.invalid/shipments"],
      ["GET", "/orders/createorder"],
      ["DELETE", "/shipments"],
    ])
      await expect(request(method, path)).rejects.toMatchObject({
        code: "PACKAGE_HISTORY_REQUEST_INVALID",
      });
    expect(fetcher).not.toHaveBeenCalled();
    await request("GET", "/shipments?trackingNumber=TRACK");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 429, 500])(
    "classifies HTTP %s without reading its error body",
    async (status) => {
      const response = new Response("private body must not be read", {
        status,
      });
      const read = vi.spyOn(response, "text");
      const request = createPackageHistoryShipStationRequester({
        apiKey: "fixture-key",
        apiSecret: "fixture-secret",
        request: vi.fn(async () => response) as typeof fetch,
      });
      await expect(request("GET", "/shipments")).rejects.toMatchObject({
        classification:
          status === 429 || status >= 500 ? "transient" : "review",
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("reads every complete page and excludes voided artifacts from original packages", async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      const page = Number(
        new URL(path, "https://ssapi.shipstation.com").searchParams.get("page"),
      );
      return {
        page,
        pages: 2,
        total: 101,
        shipments:
          page === 1
            ? Array.from({ length: 100 }, (_, index) => ({
                ...shipment(index + 1),
                voided: true,
              }))
            : [shipment(601)],
      };
    });
    const source = createPackageHistorySource({
      pool: { query: vi.fn() },
      shopify: { read: vi.fn() },
      shipstation: fixtureRequester(request),
      now: () => now,
    });
    const observed = await source.shipments("TRACK");
    expect(request).toHaveBeenCalledTimes(2);
    expect(observed.map((item) => item.shipment.shipmentId)).toEqual([601]);
    expect(observed[0].observationHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not turn an incomplete collection or second-page failure into a complete package", async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      const page = Number(
        new URL(path, "https://ssapi.shipstation.com").searchParams.get("page"),
      );
      if (page === 2)
        throw new PackageHistoryError(
          "PACKAGE_HISTORY_PROVIDER_UNAVAILABLE",
          "transient",
        );
      return {
        page,
        pages: 2,
        total: 101,
        shipments: Array.from({ length: 100 }, (_, index) => ({
          ...shipment(index + 1),
          voided: true,
        })),
      };
    });
    const source = createPackageHistorySource({
      pool: { query: vi.fn() },
      shopify: { read: vi.fn() },
      shipstation: fixtureRequester(request),
      now: () => now,
    });
    await expect(source.shipments("TRACK")).rejects.toMatchObject({
      classification: "transient",
    });
  });
  it("refuses a different tracking number and unsafe credentials", async () => {
    const source = createPackageHistorySource({
      pool: { query: vi.fn() },
      shopify: { read: vi.fn() },
      now: () => now,
      shipstation: fixtureRequester(
        vi.fn(async () => ({
          page: 1,
          pages: 1,
          total: 1,
          shipments: [{ ...shipment(601), trackingNumber: "OTHER" }],
        })),
      ),
    });
    await expect(source.shipments("TRACK")).rejects.toThrow(
      "PACKAGE_HISTORY_TRACKING_MISMATCH",
    );
    expect(() =>
      createPackageHistoryShipStationRequester({
        apiKey: "unsafe:key",
        apiSecret: "fixture",
      }),
    ).toThrow();
  });
});
