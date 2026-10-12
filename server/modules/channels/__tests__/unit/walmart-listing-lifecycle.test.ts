import { describe, expect, it, vi } from "vitest";
import { holdInventoryPublicationTargetVariantsRequestSchema } from "@shared/types/inventory-channel-exposure";
import { WalmartClient, WalmartApiError } from "../../adapters/walmart/walmart-client";
import { WalmartListingApi } from "../../adapters/walmart/walmart-listing-api";
import { WalmartChannelService, walmartListingAccount } from "../../adapters/walmart/walmart-channel.service";
import { WalmartListingLifecycleProvider } from "../../adapters/walmart/walmart-listing-lifecycle.provider";
import { ListingPublicationError } from "../../../marketplace-listings/domain/listing-publication";

const correlationId = "00000000-0000-4000-8000-000000000001";
const credentials = { clientId: "test", clientSecret: "test", market: "us" as const, environment: "sandbox" as const };
const metadata = { correlationId, status: 200, retryAfterMs: null, remainingTokens: null, nextReplenishmentAt: null };

describe("Walmart retirement transport", () => {
  it("encodes the exact seller SKU and uses the documented DELETE with an authenticated, correlated request", async () => {
    const sku = "SKU /!'()*?#&";
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ access_token: "test-token", expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "test-token", expires_in: 3600 }));
    fetchMock.mockResolvedValueOnce(Response.json({ sku, message: "Submitted for retirement", errors: null }));
    const api = new WalmartListingApi(new WalmartClient(credentials, { fetch: fetchMock }));
    await api.retire(sku, correlationId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://sandbox.walmartapis.com/v3/items/SKU%20%2F%21%27%28%29%2A%3F%23%26");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "DELETE", body: undefined, redirect: "error",
      headers: { "WM_SEC.ACCESS_TOKEN": "test-token", "WM_QOS.CORRELATION_ID": correlationId } });
  });
  it.each([
    { sku: "OTHER", message: "Accepted" },
    { sku: "SKU", message: "Accepted", errors: [{ code: "FAILED" }] },
    { sku: "SKU", message: "Accepted", error: [{ code: "FAILED" }] },
    { sku: "SKU" },
  ])("does not accept a malformed, rejected or mismatched receipt: %j", async data => {
    const requestWithMetadata = vi.fn().mockResolvedValue({ data, metadata });
    await expect(new WalmartListingApi({ requestWithMetadata }).retire("SKU", correlationId)).rejects.toBeInstanceOf(WalmartApiError);
  });
  it("validates the SKU and correlation before transport", async () => {
    const requestWithMetadata = vi.fn();
    const api = new WalmartListingApi({ requestWithMetadata });
    await expect(api.retire("", correlationId)).rejects.toThrow();
    await expect(api.retire("..", correlationId)).rejects.toThrow();
    await expect(api.retire(".", correlationId)).rejects.toThrow();
    await expect(api.retire("X".repeat(51), correlationId)).rejects.toThrow();
    await expect(api.retire("SKU", "not-a-uuid")).rejects.toThrow();
    expect(requestWithMetadata).not.toHaveBeenCalled();
  });
  it("does not blindly replay an ambiguous retirement transport failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ access_token: "test-token", expires_in: 3600 }))
      .mockRejectedValueOnce(new Error("connection lost"));
    const api = new WalmartListingApi(new WalmartClient(credentials, { fetch: fetchMock }));
    await expect(api.retire("SKU", correlationId)).rejects.toBeInstanceOf(WalmartApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function setup() {
  const row = { channel_id: 104, connection_id: 67, partner_id: "seller", ship_node_id: "node", revision: 1, environment: "production" };
  const api = { observe: vi.fn(async () => ({ sku: "SKU", productName: "Card sleeves", lifecycleStatus: "ACTIVE", publishedStatus: "SYSTEM_PROBLEM" })),
    retire: vi.fn(async () => {}) };
  const channels = { connection: vi.fn(async () => row), requireRuntime: vi.fn(), listingApi: vi.fn(() => api),
    repository: { withLock: vi.fn(async (_id: number, work: () => Promise<void>) => work()),
      mappings: vi.fn(async () => [{ product_variant_id: 3, channel_sku: "SKU" }, { product_variant_id: 4, channel_sku: "OTHER" }]) } };
  const stock = { holdVariants: vi.fn() };
  const provider = new WalmartListingLifecycleProvider(channels as unknown as WalmartChannelService, stock);
  return { api, channels, stock, provider, row, account: walmartListingAccount(row as never) };
}
describe("Walmart retirement adapter", () => {
  it.each([
    ["ACTIVE", "PUBLISHED", false], ["ACTIVE", "SYSTEM_PROBLEM", false], ["ACTIVE", "UNPUBLISHED", false],
    ["RETIRED", "PUBLISHED", false], ["RETIRED", "UNPUBLISHED", true],
  ])("requires explicit retirement, not just missing stock or a listing error: %s/%s", async (lifecycleStatus, publishedStatus, retired) => {
    const f = setup();
    f.api.observe.mockResolvedValue({ sku: "SKU", productName: "Card sleeves", lifecycleStatus, publishedStatus });
    expect(await f.provider.observe(f.account, "SKU")).toEqual({ sku: "SKU", title: "Card sleeves", retired });
  });
  it("does not misreport a missing item as a completed retirement", async () => {
    const f = setup();
    f.api.observe.mockRejectedValue(new WalmartApiError("ITEM_NOT_FOUND", "Missing", false, 404));
    await expect(f.provider.observe(f.account, "SKU")).rejects.toMatchObject({ status: 404 });
  });
  it("uses the inventory owner's idempotent SKU hold for only the selected mapping", async () => {
    const f = setup();
    await f.provider.holdStock(f.account, "SKU", correlationId, "operator");
    expect(f.stock.holdVariants).toHaveBeenCalledExactlyOnceWith({
      destination: { destinationKind: "channel_connection", connectionId: 67 },
      productVariantIds: [3], reason: "Listing unpublished from Echelon", idempotencyKey: `listing-stop:${correlationId}:3`,
    }, "operator");
    expect(holdInventoryPublicationTargetVariantsRequestSchema.safeParse(f.stock.holdVariants.mock.calls[0][0]).success).toBe(true);
  });
  it("can retire an unlinked account listing without changing unrelated inventory", async () => {
    const f = setup();
    await f.provider.holdStock(f.account, "UNLINKED", correlationId, "operator");
    expect(f.stock.holdVariants).not.toHaveBeenCalled();
    await f.provider.retire(f.account, "UNLINKED", correlationId);
    expect(f.channels.repository.withLock).toHaveBeenCalledOnce();
    expect(f.api.retire).toHaveBeenCalledExactlyOnceWith("UNLINKED", correlationId);
  });
  it.each([{ partner_id: "different" }, { ship_node_id: "different" }, { revision: 2 }])("refuses a changed connection before retirement: %j", async change => {
    const f = setup();
    f.channels.connection.mockResolvedValue({ ...f.row, ...change });
    await expect(f.provider.retire(f.account, "SKU", correlationId)).rejects.toMatchObject({ code: "WALMART_ACCOUNT_CHANGED" });
    expect(f.api.retire).not.toHaveBeenCalled();
  });
  it("honors the Walmart runtime switch", async () => {
    const f = setup();
    f.channels.requireRuntime.mockImplementation(() => { throw new WalmartApiError("WALMART_LIVE_DISABLED", "Disabled", false); });
    await expect(f.provider.retire(f.account, "SKU", correlationId)).rejects.toMatchObject({ code: "WALMART_LIVE_DISABLED" });
    expect(f.api.retire).not.toHaveBeenCalled();
  });
  it("fails closed if composition omits the guard and preserves retry classification", async () => {
    const f = setup(), work = vi.fn(async () => {});
    const policy = { liveEnabled: true, productionServer: false };
    await expect(new WalmartChannelService({} as never, null, policy).withListingWrites(f.account, ["SKU"], work))
      .rejects.toMatchObject({ code: "WALMART_LISTING_CONTROL_UNAVAILABLE", retryable: true });
    const guard = { withAllowed: vi.fn() };
    const channels = new WalmartChannelService({} as never, null, { ...policy, listingWrites: guard });
    guard.withAllowed.mockRejectedValue(new ListingPublicationError("LISTING_PUBLICATION_STOPPED", "Stopped"));
    await expect(channels.withListingWrites(f.account, ["SKU"], work)).rejects.toMatchObject({ code: "LISTING_PUBLICATION_STOPPED", retryable: false });
    guard.withAllowed.mockRejectedValue(new ListingPublicationError("LISTING_LIFECYCLE_BUSY", "Busy", 503));
    await expect(channels.withListingWrites(f.account, ["SKU"], work)).rejects.toMatchObject({ code: "LISTING_LIFECYCLE_BUSY", retryable: true });
    expect(work).not.toHaveBeenCalled();
  });
});
