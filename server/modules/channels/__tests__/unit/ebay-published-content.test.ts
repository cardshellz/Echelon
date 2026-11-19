import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { providerReadDiagnosticFromError } from "@shared/channel-provider-read";
import { createCatalogImageInspector } from "../../../catalog/catalog-image-inspection";
import { ProductAssetError } from "../../../catalog/product-asset-errors";
import { readEbayPublishedContent } from "../../adapters/ebay/ebay-published-content.reader";
import { ebayOriginalPhotoUrl } from "../../adapters/ebay/ebay-photo-requirements";

const source = "https://catalog.example.com/api/public/catalog-images/42/original.jpg";
const thumbnail = "https://i.ebayimg.com/00/s/NDAwWDQwMA==/z/photo-key/$_1.JPG";
const fullSize = "https://i.ebayimg.com/images/g/photo-key/s-l1600.jpg";
const bytes = readFileSync(new URL("../../../catalog/__tests__/fixtures/photos/original.png", import.meta.url));
const xml = (content = `<PictureURL>${thumbnail}</PictureURL><ExternalPictureURL>${source}</ExternalPictureURL>`) =>
  `<GetItemResponse><Ack>Success</Ack><Item><ItemID>298000000001</ItemID>
    <Variations><Variation><SKU>PACK&amp;50</SKU></Variation><Variation><SKU>CASE</SKU></Variation></Variations>
    <PictureDetails>${content}</PictureDetails><SellerProfiles>
    <SellerShippingProfile><ShippingProfileID>279960221019</ShippingProfileID></SellerShippingProfile>
    <SellerReturnProfile><ReturnProfileID>return-1</ReturnProfileID></SellerReturnProfile>
    <SellerPaymentProfile><PaymentProfileID>payment-1</PaymentProfileID></SellerPaymentProfile>
    </SellerProfiles></Item></GetItemResponse>`;
const read = vi.fn(async () => ({ data: bytes, mimeType: "image/png" }));
const input = (request: typeof fetch) => ({ listingId: "298000000001", accessToken: "test-token", environment: "production" as const,
  request, images: createCatalogImageInspector(read) });

describe("eBay published content adapter", () => {
  it("reads the native listing rather than Inventory offers and measures original EPS bytes", async () => {
    read.mockClear();
    const request = vi.fn(async () => new Response(xml()));
    const result = await readEbayPublishedContent(input(request));
    expect(result).toEqual({ listingId: "298000000001", skus: ["PACK&50", "CASE"],
      policies: { shipping: "279960221019", return: "return-1", payment: "payment-1" }, firstPhotoSource: source,
      photos: [{ url: fullSize, width: 640, height: 640, sourceAliases: [thumbnail,fullSize] }] });
    expect(read).toHaveBeenCalledExactlyOnceWith(fullSize);
    expect(request).toHaveBeenCalledWith("https://api.ebay.com/ws/api.dll", expect.objectContaining({ method: "POST",
      headers: expect.objectContaining({ "X-EBAY-API-CALL-NAME": "GetItem" }),
      body: expect.stringContaining("<OutputSelector>SellerProfiles</OutputSelector>") }));
  });
  it("does not pretend a 400-pixel stored original becomes larger by choosing s-l1600", async () => {
    const small = readFileSync(new URL("../../../catalog/__tests__/fixtures/photos/thumbnail.png", import.meta.url));
    const result = await readEbayPublishedContent({ ...input(vi.fn(async () => new Response(xml()))),
      images: createCatalogImageInspector(async () => ({ data: small, mimeType: "image/png" })) });
    expect(result.photos[0]).toMatchObject({ width: 400, height: 400 });
  });
  it("binds a standalone SKU and handles empty optional containers", async () => {
    const body = xml().replace(/<Variations>[\s\S]*?<\/Variations>/,"<SKU>STANDALONE</SKU><Variations/>")
      .replace(/<SellerProfiles>[\s\S]*?<\/SellerProfiles>/,"<SellerProfiles/>");
    expect(await readEbayPublishedContent(input(vi.fn(async () => new Response(body)))))
      .toMatchObject({ skus: ["STANDALONE"], policies: {} });
  });
  it.each(["<bad", xml().replace("298000000001","298000000002"), xml(""),
    '<!DOCTYPE x [<!ENTITY x "a">]>'+xml(), xml()+" ".repeat(256_000)])("rejects malformed, oversized, empty or wrong-listing evidence", async body => {
    const error = await readEbayPublishedContent(input(vi.fn(async () => new Response(body)))).catch(error=>error);
    expect(providerReadDiagnosticFromError(error)).toMatchObject({ resource: "published_listing", method: "POST", kind: "invalid_response" });
  });
  it.each([401,429,503])("preserves native HTTP %i without converting it into success", async status => {
    const error = await readEbayPublishedContent(input(vi.fn(async () => new Response("private provider body",{status})))).catch(error=>error);
    expect(providerReadDiagnosticFromError(error)).toMatchObject({ resource: "published_listing", method: "POST", httpStatus: status,
      kind: status===401?"refused":"unavailable" });
    expect(error.message).not.toContain("private provider body");
  });
  it.each([422,502])("retains an image inspection failure (%i) as a failed published photo read", async status => {
    const error = await readEbayPublishedContent({ ...input(vi.fn(async () => new Response(xml()))),
      images: { inspect: async()=> { throw new ProductAssetError("IMAGE_FAILED","private image details",status); } } }).catch(error=>error);
    expect(providerReadDiagnosticFromError(error)).toMatchObject({ resource: "published_photo", method: "GET",
      kind: status===422?"invalid_response":"unavailable" });
  });
  it("rejects a missing inspection result as a published photo read failure", async () => {
    const error = await readEbayPublishedContent({ ...input(vi.fn(async () => new Response(xml()))),
      images: { inspect: async () => new Map() } }).catch(error => error);
    expect(providerReadDiagnosticFromError(error)).toMatchObject({ resource: "published_photo", method: "GET", kind: "invalid_response" });
  });
  it("only selects another rendition of the exact eBay image key", () => {
    expect(ebayOriginalPhotoUrl(thumbnail)).toBe(fullSize);
    expect(ebayOriginalPhotoUrl("https://i.ebayimg.com/images/g/photo-key/s-l400.webp")).toBe(fullSize);
    expect(ebayOriginalPhotoUrl(source)).toBe(source);
    expect(ebayOriginalPhotoUrl("https://other.example.com/images/g/photo-key/s-l400.jpg"))
      .toBe("https://other.example.com/images/g/photo-key/s-l400.jpg");
  });
});
