import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";
import { ChannelProviderReadError, providerHttpReadFailureKind, type ChannelProviderReadDiagnostic } from "@shared/channel-provider-read";

const MAX_NATIVE_RESPONSE_BYTES = 256_000;
const packageTypes = { Letter: "LETTER", LargeEnvelope: "LARGE_ENVELOPE",
  PackageThickEnvelope: "PACKAGE_THICK_ENVELOPE", USPSLargePack: "USPS_LARGE_PACK" } as const;
const text = z.string().min(1).max(100).refine(value => value.trim().length > 0);
const offerSchema = z.object({ sku: text, marketplaceId: text, format: z.literal("FIXED_PRICE"),
  offerId: text, status: z.enum(["PUBLISHED", "UNPUBLISHED"]), listingId: text.optional(),
  listing: z.object({ listingId: text }).passthrough().optional() }).passthrough();
const shippingPackageSchema = z.object({ ShippingPackage: text.optional() }).passthrough();
// OutputSelector can leave an empty parent element in a successful GetItem
// response. That XML shape means the optional classification was not returned.
const optionalShippingPackageSchema = z.preprocess(value => value === "" ? undefined : value, shippingPackageSchema.optional());
const nativeResponseSchema = z.object({ GetItemResponse: z.object({
  Ack: z.enum(["Success", "Warning", "Failure", "PartialFailure"]),
  Errors: z.union([z.object({ ErrorClassification: z.string().optional(), SeverityCode: z.string().optional() }).passthrough(),
    z.array(z.object({ ErrorClassification: z.string().optional(), SeverityCode: z.string().optional() }).passthrough())]).optional(),
  Item: z.object({ ItemID: text, SKU: text.optional(), Variations: z.object({
    Variation: z.union([z.object({ SKU: text }).passthrough(), z.array(z.object({ SKU: text }).passthrough())]),
  }).passthrough().optional(), ShippingPackageDetails: optionalShippingPackageSchema,
  ShippingDetails: z.preprocess(value => value === "" ? undefined : value,
    z.object({ CalculatedShippingRate: optionalShippingPackageSchema }).passthrough().optional()),
  }).passthrough().optional(),
}).passthrough() }).passthrough();

export interface EbayNativePackageSnapshot {
  listingId: string | null;
  packageType: string | null;
}
export type EbayNativePackageReader = (sku: string, marketplaceId: string, observedOffers?: readonly unknown[]) => Promise<EbayNativePackageSnapshot>;
const invalid = (kind: ChannelProviderReadDiagnostic["kind"] = "invalid_response", httpStatus?: number) =>
  new EbayListingSyncError(httpStatus === 401 ? "EBAY_AUTH_REQUIRED" : "EBAY_PACKAGE_READ_INVALID",
    "Echelon could not verify eBay's package configuration. Retry Sync to check its current values.",
    { cause: new ChannelProviderReadError({ provider: "ebay", resource: "listing_package", method: "POST", kind,
      ...(httpStatus === undefined ? {} : { httpStatus }) }) });

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let result = "", size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_NATIVE_RESPONSE_BYTES) throw invalid();
      result += decoder.decode(part.value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Inventory GET can omit a package type which the published listing retains.
 * Read only that classification; listing measurements never become SKU facts. */
export async function readEbayNativePackage(input: {
  sku: string; marketplaceId: string; offers: unknown; accessToken: string;
  environment: "production" | "sandbox"; request?: typeof fetch;
}): Promise<EbayNativePackageSnapshot> {
  const sku = text.parse(input.sku);
  if (input.marketplaceId !== "EBAY_US") throw invalid();
  const parsed = z.array(offerSchema).max(10).safeParse(input.offers);
  if (!parsed.success || parsed.data.some(offer => offer.sku !== sku || offer.marketplaceId !== input.marketplaceId)
    || parsed.data.length > 1) throw invalid();
  const offer = parsed.data[0];
  if (!offer || offer.status === "UNPUBLISHED") return { listingId: null, packageType: null };
  const listingId = offer.listingId ?? offer.listing?.listingId;
  if (!listingId || !/^\d{1,30}$/.test(listingId)
    || (offer.listingId && offer.listing?.listingId && offer.listingId !== offer.listing.listingId)) throw invalid();
  const host = input.environment === "production" ? "api.ebay.com" : "api.sandbox.ebay.com";
  let response: Response;
  try { response = await (input.request ?? fetch)(`https://${host}/ws/api.dll`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "text/xml", "X-EBAY-API-CALL-NAME": "GetItem", "X-EBAY-API-COMPATIBILITY-LEVEL": "1477",
      "X-EBAY-API-SITEID": "0", "X-EBAY-API-IAF-TOKEN": input.accessToken },
    body: `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${listingId}</ItemID>`
      // GetItem omits native shipping values for leaf-only OutputSelectors.
      // Request their containers, then return only the validated classification.
      + ["ItemID", "SKU", "Variations", "ShippingPackageDetails", "ShippingDetails"]
        .map(field => `<OutputSelector>${field}</OutputSelector>`).join("") + "</GetItemRequest>",
  }); } catch (cause) { throw new EbayListingSyncError("EBAY_PACKAGE_READ_UNAVAILABLE", "eBay's package configuration could not be read. The saved Sync will retry.",
    { cause: new ChannelProviderReadError({ provider: "ebay", resource: "listing_package", method: "POST", kind: "unavailable" }, { cause }) }); }
  if (!response.ok) {
    // Release the unread error body without replacing the provider's HTTP
    // refusal with a secondary stream-cleanup error.
    try { await response.body?.cancel(); }
    finally { throw invalid(providerHttpReadFailureKind(response.status), response.status); }
  }
  let raw: string;
  try { raw = await boundedText(response); }
  catch (cause) { if (cause instanceof EbayListingSyncError) throw cause;
    throw new EbayListingSyncError("EBAY_PACKAGE_READ_UNAVAILABLE", "eBay's package response did not finish. The saved Sync will retry.",
      { cause: new ChannelProviderReadError({ provider: "ebay", resource: "listing_package", method: "POST", kind: "unavailable" }, { cause }) }); }
  if (/<!DOCTYPE|<!ENTITY/i.test(raw) || XMLValidator.validate(raw) !== true) throw invalid();
  const parsedXml = nativeResponseSchema.safeParse(new XMLParser({ parseTagValue: false, ignoreAttributes: true,
    removeNSPrefix: true, processEntities: false }).parse(raw));
  if (!parsedXml.success) throw invalid();
  const result = parsedXml.data.GetItemResponse, item = result.Item;
  const errors = result.Errors ? (Array.isArray(result.Errors) ? result.Errors : [result.Errors]) : [];
  if (!["Success", "Warning"].includes(result.Ack) || errors.some(error => error.SeverityCode === "Error"))
    throw invalid(errors.some(error => error.ErrorClassification === "SystemError") ? "unavailable" : "refused", response.status);
  const variations = item?.Variations?.Variation;
  const members = variations ? (Array.isArray(variations) ? variations : [variations]) : [];
  if (item?.ItemID !== listingId || (members.length ? !members.some(member => member.SKU === sku) : item.SKU !== sku)) throw invalid();
  const direct = item.ShippingPackageDetails?.ShippingPackage, calculated = item.ShippingDetails?.CalculatedShippingRate?.ShippingPackage;
  if (direct && calculated && direct !== calculated) throw invalid();
  const native = direct ?? calculated;
  if (native === undefined) return { listingId, packageType: null };
  if (!Object.hasOwn(packageTypes, native)) throw invalid();
  return { listingId, packageType: packageTypes[native as keyof typeof packageTypes] };
}
