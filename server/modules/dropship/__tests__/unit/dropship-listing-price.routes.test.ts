import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listingPriceTargetSchema, saveListingPriceInputSchema } from "../../../../../shared/dropship/listing-price";
import { DropshipError } from "../../domain/errors";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
import { registerDropshipListingPriceRoutes } from "../../interfaces/http/dropship-listing-price.routes";

const setting = { storeConnectionId: 22, productVariantId: 101, revisionId: null, overridePriceCents: null,
  effectivePriceCents: 899, defaultPriceCents: 899, source: "catalog_default" as const, updatedAt: null };
const input = { priceCents: 1299, expectedRevisionId: null, idempotencyKey: "price-route-key" };
describe("listing price HTTP boundary", () => {
  let server: http.Server;
  let url: string;
  const getForMember = vi.fn(async (_member: string, target: unknown) => { listingPriceTargetSchema.parse(target); return setting; });
  const saveForMember = vi.fn(async (_member: string, target: unknown, body: unknown) => {
    listingPriceTargetSchema.parse(target); saveListingPriceInputSchema.parse(body);
    return { price: setting, idempotentReplay: false };
  });
  beforeEach(async () => {
    getForMember.mockClear(); saveForMember.mockClear();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { const memberId = req.header("X-Test-Member");
      req.session = { ...(memberId ? { dropship: { memberId } } : {}) } as Request["session"]; next(); });
    registerDropshipListingPriceRoutes(app, { getForMember, saveForMember });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores/22/variants/101/price`;
  });
  afterEach(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  function request(method = "PUT", member: string | null = "member-1", body: unknown = input, path = url) {
    return fetch(path, { method, headers: { "Content-Type": "application/json", ...(member ? { "X-Test-Member": member } : {}) },
      ...(method === "PUT" ? { body: JSON.stringify(body) } : {}) });
  }
  it.each(["GET", "PUT"])("requires member auth for %s", async (method) => {
    expect((await request(method, null)).status).toBe(401);
    expect(getForMember).not.toHaveBeenCalled(); expect(saveForMember).not.toHaveBeenCalled();
  });
  it("loads and saves with no MFA, wallet, or publication route", async () => {
    const loaded = await request("GET"); expect(loaded.status).toBe(200);
    expect(loaded.headers.get("Cache-Control")).toBe("no-store");
    expect(await loaded.json()).toEqual({ price: setting });
    const saved = await request(); expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ price: setting, idempotentReplay: false });
    expect(saveForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, productVariantId: 101 }, input);
  });
  it.each([{ ...input, vendorId: 9 }, { ...input, priceCents: 0 }, { ...input, expectedRevisionId: undefined }])("rejects invalid body %j", async (body) => {
    expect((await request("PUT", "member-1", body)).status).toBe(400);
  });
  it.each(["22oops", "2e1", "0", "2147483648"])("rejects malformed store id %s", async (id) => {
    expect((await request("GET", "member-1", input, url.replace("stores/22/", `stores/${id}/`))).status).toBe(400);
  });
  it.each([["DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", 409], ["DROPSHIP_IDEMPOTENCY_CONFLICT", 409],
    ["DROPSHIP_STORE_CONNECTION_REQUIRED", 404], ["DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", 404],
    ["DROPSHIP_LISTING_STORE_BLOCKED", 403], ["DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", 403]])("maps %s to %s", async (code, status) => {
    saveForMember.mockRejectedValueOnce(new DropshipError(String(code), "Controlled error."));
    expect((await request()).status).toBe(status);
  });
  it("does not leak internal failures", async () => {
    saveForMember.mockRejectedValueOnce(new Error("secret connection string"));
    const result = await request(); expect(result.status).toBe(500);
    expect(JSON.stringify(await result.json())).not.toContain("secret");
  });
  it("rejects malformed service output as server error rather than input error", async () => {
    getForMember.mockResolvedValueOnce({ ...setting, effectivePriceCents: -1 });
    expect((await request("GET")).status).toBe(500);
  });
});
