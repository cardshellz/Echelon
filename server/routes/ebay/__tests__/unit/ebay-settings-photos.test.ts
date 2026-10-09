import type { Express, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  reads: [] as Record<string, unknown>[][],
  resolvePhotos: vi.fn(),
  quantityRead: vi.fn(),
  client: {
    getInventoryItem: vi.fn(), getInventoryItemGroup: vi.fn(),
    createOrReplaceInventoryItem: vi.fn(), createOffer: vi.fn(), publishOffer: vi.fn(),
  },
}));
vi.mock("../../../middleware", () => ({ requireAuth: vi.fn(), requirePermission: vi.fn() }));
vi.mock("../../../../db", () => ({ db: { select: vi.fn(() => {
  const rows = fixture.reads.shift();
  if (!rows) throw new Error("Unexpected database read");
  const query = Promise.resolve(rows) as Promise<Record<string, unknown>[]> & Record<string, unknown>;
  query.from = () => query; query.where = () => query; query.limit = () => query;
  return query;
}) } }));
vi.mock("../../../../modules/channels/adapters/ebay/ebay-auth.service", () => ({
  createEbayAuthConfig: vi.fn(() => ({})), EbayAuthService: class {},
}));
vi.mock("../../../../modules/channels/adapters/ebay/ebay-api.client", () => ({
  createEbayApiClient: vi.fn(() => fixture.client),
}));
vi.mock("../../ebay-utils", () => ({
  atpService: { getAtpPerVariant: fixture.quantityRead },
  ebayListingPhotoResolver: { resolve: fixture.resolvePhotos },
}));
import { registerEbaySettingsRoutes } from "../../../ebay-settings.routes";

type Handler = (request: Request, response: Response) => Promise<void>;
const product = { id: 13, sku: "GROUP", name: "Card supplies", category: "Protectors" };
const variant = { id: 101, sku: "PACK", name: "Pack", priceCents: 1299, weightGrams: 100 };
const uploadedUrl = `https://catalog.example.com/api/catalog/images/9214/${"a".repeat(64)}.jpg`;
const photoPlan = { byVariantId: new Map([[101, [uploadedUrl]]]), groupImageUrls: [uploadedUrl] };

function route(method: "get" | "post", path: string): Handler {
  const handlers = new Map<string, Handler>();
  const register = (verb: string) => (url: string, ...callbacks: unknown[]) => {
    handlers.set(`${verb} ${url}`, callbacks.at(-1) as Handler);
  };
  registerEbaySettingsRoutes({ get: register("get"), post: register("post"), put: register("put") } as unknown as Express);
  const handler = handlers.get(`${method} ${path}`);
  if (!handler) throw new Error(`Route not registered: ${path}`);
  return handler;
}

async function invoke(method: "get" | "post", path: string, body: unknown = {}) {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await route(method, path)({ body } as Request, response as unknown as Response);
  return response;
}

describe("eBay settings photo consumers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.reads = [];
    fixture.resolvePhotos.mockResolvedValue(photoPlan);
    fixture.quantityRead.mockResolvedValue([{ productVariantId: 101, atpUnits: 4 }]);
    fixture.client.createOffer.mockResolvedValue("offer-101");
    fixture.client.publishOffer.mockResolvedValue({ listingId: "listing-101" });
  });

  function testListingReads() {
    fixture.reads = [[{ metadata: { merchantLocationKey: "hq", fulfillmentPolicyId: "f", returnPolicyId: "r", paymentPolicyId: "p" } }],
      [product], [variant]];
  }

  it("previews the resolver's gallery for every exact SKU, including uploaded files", async () => {
    fixture.reads = [[product], [variant, { ...variant, id: 102, sku: "CASE" }]];
    const response = await invoke("get", "/api/ebay/listings/preview");
    expect(fixture.resolvePhotos).toHaveBeenCalledWith({ productId: 13, channelId: 67,
      variants: [{ variantId: 101, sku: "PACK" }, { variantId: 102, sku: "CASE" }] });
    expect(response.json).toHaveBeenCalledWith({ previews: [expect.objectContaining({ images: [uploadedUrl] })] });
    expect(fixture.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(fixture.reads).toEqual([]);
  });

  it("publishes a test listing with the resolved SKU gallery and existing quantity reader", async () => {
    testListingReads();
    const response = await invoke("post", "/api/ebay/listings/test", { productId: 13 });
    expect(fixture.resolvePhotos).toHaveBeenCalledWith(expect.objectContaining({ productId: 13, channelId: 67,
      variants: [{ variantId: 101, sku: "PACK" }] }));
    expect(fixture.client.createOrReplaceInventoryItem).toHaveBeenCalledWith("PACK", expect.objectContaining({
      product: expect.objectContaining({ imageUrls: [uploadedUrl] }),
    }));
    expect(fixture.client.createOffer).toHaveBeenCalledWith(expect.objectContaining({ availableQuantity: 4 }));
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, listingId: "listing-101" }));
    expect(fixture.reads).toEqual([]);
  });

  it("stops before any eBay write when photo resolution fails, and allows a fresh retry", async () => {
    testListingReads();
    fixture.resolvePhotos.mockRejectedValueOnce(new Error("Replace uploaded catalog image 9214"));
    const failed = await invoke("post", "/api/ebay/listings/test", { productId: 13 });
    expect(failed.status).toHaveBeenCalledWith(500);
    expect(failed.json).toHaveBeenCalledWith({ error: "Replace uploaded catalog image 9214" });
    expect(fixture.client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(fixture.client.createOffer).not.toHaveBeenCalled();
    expect(fixture.client.publishOffer).not.toHaveBeenCalled();
    testListingReads();
    await invoke("post", "/api/ebay/listings/test", { productId: 13 });
    expect(fixture.client.createOffer).toHaveBeenCalledTimes(1);
  });

  it("retains photos through the same exact-SKU provider reader only when the resolver requests it", async () => {
    testListingReads();
    fixture.client.getInventoryItemGroup.mockResolvedValue({ imageUrls: [uploadedUrl] });
    fixture.client.getInventoryItem.mockResolvedValue({ sku: "PACK", product: { imageUrls: [uploadedUrl] } });
    fixture.resolvePhotos.mockImplementationOnce((input) => input.readExistingPhotos());
    await invoke("post", "/api/ebay/listings/test", { productId: 13 });
    expect(fixture.client.getInventoryItemGroup).toHaveBeenCalledWith("GROUP");
    expect(fixture.client.getInventoryItem).toHaveBeenCalledWith("PACK");
    expect(fixture.client.createOrReplaceInventoryItem).toHaveBeenCalledWith("PACK", expect.objectContaining({
      product: expect.objectContaining({ imageUrls: [uploadedUrl] }),
    }));
  });

  it("rejects a test variant without a SKU before photo resolution or provider writes", async () => {
    testListingReads();
    fixture.reads[2] = [{ ...variant, sku: null }];
    const response = await invoke("post", "/api/ebay/listings/test", { productId: 13 });
    expect(response.status).toHaveBeenCalledWith(400);
    expect(fixture.resolvePhotos).not.toHaveBeenCalled();
    expect(fixture.client.createOffer).not.toHaveBeenCalled();
  });
});
