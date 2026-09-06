import http from "http";
import type { AddressInfo } from "net";
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listingShippingEstimateInputSchema, type ListingShippingEstimateResult } from "../../../../../shared/dropship/listing-shipping-estimate";
import { DropshipError } from "../../domain/errors";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
import { registerDropshipListingShippingEstimateRoutes, LISTING_SHIPPING_ESTIMATE_REQUESTS_PER_MINUTE } from "../../interfaces/http/dropship-listing-shipping-estimate.routes";

const input = { storeConnectionId: 22, productVariantId: 101, quantity: 1, destination: { country: "US", postalCode: "17046" } };
const unavailable: ListingShippingEstimateResult = { status: "unavailable", storeConnectionId: 22, productVariantId: 101, quantity: 1, destination: { country: "US", region: null, postalCode: "17046" }, estimatedAt: "2026-09-06T12:00:00.000Z", warnings: [], code: "DROPSHIP_SHIPPING_RATE_REQUIRED", message: "Rate not configured." };

describe("listing shipping estimate endpoint", () => {
  let server: http.Server;
  let url: string;
  const estimateForMember = vi.fn(async (_member: string, body: unknown): Promise<ListingShippingEstimateResult> => {
    listingShippingEstimateInputSchema.parse(body);
    return unavailable;
  });
  beforeEach(async () => {
    estimateForMember.mockClear();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const memberId = req.header("X-Test-Member");
      req.session = { ...(memberId ? { dropship: { memberId } } : {}) } as Request["session"];
      next();
    });
    registerDropshipListingShippingEstimateRoutes(app, { estimateForMember });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/shipping-estimate`;
  });
  afterEach(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  async function request(memberId: string | null = "member-1", body: unknown = input) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(memberId ? { "X-Test-Member": memberId } : {}) }, body: JSON.stringify(body) });
  }

  it("requires real dropship session auth before calling the service", async () => {
    const response = await request(null);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "DROPSHIP_AUTH_REQUIRED" } });
    expect(estimateForMember).not.toHaveBeenCalled();
  });
  it("returns explicit unavailable without idempotency, launch or wallet actions", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ estimate: unavailable });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(estimateForMember).toHaveBeenCalledWith("member-1", input);
  });
  it("rejects unknown warehouse authority inputs", async () => {
    const response = await request("member-1", { ...input, warehouseId: 999 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "DROPSHIP_LISTING_SHIPPING_INVALID_INPUT" } });
  });
  it.each([
    ["DROPSHIP_SHIPPING_INVALID_DESTINATION", 400],
    ["DROPSHIP_STORE_CONNECTION_REQUIRED", 404], ["DROPSHIP_LISTING_VENDOR_BLOCKED", 403],
    ["DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", 403], ["DROPSHIP_LISTING_STORE_BLOCKED", 403],
    ["DROPSHIP_LISTING_SHIPPING_VARIANT_NOT_SELECTED", 403], ["DROPSHIP_SHARED_SHIPPING_QUOTE_FAILED", 503],
  ])("maps %s to %i", async (code, status) => {
    estimateForMember.mockRejectedValueOnce(new DropshipError(code, "Controlled failure."));
    expect((await request()).status).toBe(status);
  });
  it("bounds estimate requests per member while allowing a different member", async () => {
    for (let i = 0; i < LISTING_SHIPPING_ESTIMATE_REQUESTS_PER_MINUTE; i++) expect((await request()).status).toBe(200);
    const response = await request();
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "DROPSHIP_LISTING_SHIPPING_RATE_LIMITED" } });
    expect((await request("member-2")).status).toBe(200);
  });
});
