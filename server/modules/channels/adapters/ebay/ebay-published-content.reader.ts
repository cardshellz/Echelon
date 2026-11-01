import { z } from "zod";
import {
  createCatalogImageInspector,
  type CatalogImageInspector,
} from "../../../catalog/catalog-image-inspection";
import type { ChannelPublishedContent } from "../../../marketplace-listings/domain/channel-publication-content";
import { ebayOriginalPhotoUrl } from "./ebay-photo-requirements";
import {
  nativeListingReadFailure,
  readEbayNativeListing,
} from "./ebay-native-listing.transport";
import { ProductAssetError } from "../../../catalog/product-asset-errors";

const text = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0);
const scalarArray = <T extends z.ZodTypeAny>(value: T) =>
  z.union([value, z.array(value)]);
const optionalContainer = <T extends z.ZodTypeAny>(value: T) =>
  z.preprocess((input) => (input === "" ? undefined : input), value.optional());
const schema = z.object({
  GetItemResponse: z
    .object({
      Ack: z.enum(["Success", "Warning", "Failure", "PartialFailure"]),
      Errors: scalarArray(
        z
          .object({
            SeverityCode: z.string().optional(),
            ErrorClassification: z.string().optional(),
          })
          .passthrough(),
      ).optional(),
      Item: z
        .object({
          ItemID: text,
          SKU: text.optional(),
          Variations: optionalContainer(
            z
              .object({
                Variation: scalarArray(z.object({ SKU: text }).passthrough()),
              })
              .passthrough(),
          ),
          PictureDetails: z
            .object({
              PictureURL: scalarArray(z.string().url().max(4096)).refine(
                (value) => typeof value === "string" || value.length > 0,
              ),
              ExternalPictureURL: scalarArray(
                z.string().url().max(4096),
              ).optional(),
            })
            .passthrough(),
          SellerProfiles: optionalContainer(
            z
              .object({
                SellerShippingProfile: optionalContainer(
                  z.object({ ShippingProfileID: text }).passthrough(),
                ),
                SellerReturnProfile: optionalContainer(
                  z.object({ ReturnProfileID: text }).passthrough(),
                ),
                SellerPaymentProfile: optionalContainer(
                  z.object({ PaymentProfileID: text }).passthrough(),
                ),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
});
const array = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Normalize the customer-visible gallery and business policies, independently
 * of Inventory offer echoes. Listing measurements never enter Catalog here. */
export async function readEbayPublishedContent(input: {
  listingId: string;
  accessToken: string;
  environment: "production" | "sandbox";
  request?: typeof fetch;
  images?: CatalogImageInspector;
}): Promise<ChannelPublishedContent> {
  const transport = {
    ...input,
    resource: "published_listing",
    codePrefix: "EBAY_PUBLISHED_CONTENT" as const,
    fields: ["ItemID", "SKU", "Variations", "PictureDetails", "SellerProfiles"],
  };
  const response = await readEbayNativeListing(transport);
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) throw nativeListingReadFailure(transport);
  const result = parsed.data.GetItemResponse,
    item = result.Item;
  const errors = array(result.Errors);
  if (
    !["Success", "Warning"].includes(result.Ack) ||
    errors.some((error) => error.SeverityCode === "Error")
  )
    throw nativeListingReadFailure(
      transport,
      errors.some((error) => error.ErrorClassification === "SystemError")
        ? "unavailable"
        : "refused",
      response.httpStatus,
    );
  if (!item || item.ItemID !== input.listingId)
    throw nativeListingReadFailure(transport);
  const sourceUrls = array(item.PictureDetails.PictureURL);
  const urls = sourceUrls.map(ebayOriginalPhotoUrl);
  let inspected;
  try {
    inspected = await (input.images ?? createCatalogImageInspector()).inspect(
      urls,
    );
  } catch (cause) {
    throw nativeListingReadFailure(
      transport,
      cause instanceof ProductAssetError && cause.status < 500
        ? "invalid_response"
        : "unavailable",
      undefined,
      cause,
    );
  }
  const policies = item.SellerProfiles;
  return {
    listingId: item.ItemID,
    skus: item.Variations
      ? array(item.Variations.Variation).map((member) => member.SKU)
      : item.SKU
        ? [item.SKU]
        : [],
    policies: {
      ...(policies?.SellerShippingProfile
        ? { shipping: policies.SellerShippingProfile.ShippingProfileID }
        : {}),
      ...(policies?.SellerReturnProfile
        ? { return: policies.SellerReturnProfile.ReturnProfileID }
        : {}),
      ...(policies?.SellerPaymentProfile
        ? { payment: policies.SellerPaymentProfile.PaymentProfileID }
        : {}),
    },
    firstPhotoSource: ebayOriginalPhotoUrl(
      array(item.PictureDetails.ExternalPictureURL)[0] ?? urls[0],
    ),
    photos: urls.map((url, index) => {
      const image = inspected.get(url);
      if (!image) throw nativeListingReadFailure(transport);
      return {
        url,
        width: image.width,
        height: image.height,
        sourceAliases: [sourceUrls[index], url],
      };
    }),
  };
}
