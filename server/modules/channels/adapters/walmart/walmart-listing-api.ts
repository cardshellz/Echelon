import { createHash } from "node:crypto";
import { z } from "zod";
import type { WalmartClient, WalmartResponseMetadata } from "./walmart-client";
import { WalmartApiError } from "./walmart-client";
import {
  assertListingSetupZeroAdmission,
  type ListingSetupZeroIntent,
} from "../../../inventory-planning/application/listing-setup-zero-intent";
import { priceForWalmart } from "./walmart-listing-schema";

// Pinned from Walmart's recommended US specifications on 2026-09-27.
// https://developer.walmart.com/us-marketplace/docs/item-spec-versioning-and-diff-reporting
export const WALMART_LISTING_SPEC = {
  MP_ITEM: "5.0.20260803-17_50_56-api",
  MP_ITEM_MATCH: "5.0.20260607-22_38_54-api",
} as const;
export type WalmartListingFeedType = keyof typeof WALMART_LISTING_SPEC;
export const walmartListingFeedTypeSchema = z.enum([
  "MP_ITEM",
  "MP_ITEM_MATCH",
]);
const sellerSku = z.string().min(1).max(50);
const providerId = z.string().min(1).max(200);
const productTypeSchema = z.string().trim().min(1).max(200);
const identifierSchema = z
  .object({
    type: z.enum(["GTIN", "UPC", "EAN", "ISBN"]),
    value: z.string().min(1).max(14),
  })
  .strict();
export type WalmartListingIdentifier = z.infer<typeof identifierSchema>;
export type WalmartListingSchema = {
  version: string;
  schema: Record<string, unknown>;
  schemaHash: string;
};

const feedStatusSchema = z.object({
  errors: z.array(z.unknown()).max(0).nullish(),
  feedId: providerId,
  feedStatus: z.enum(["RECEIVED", "INPROGRESS", "PROCESSED", "ERROR"]),
  itemsReceived: z.number().int().nonnegative().max(10_000),
  itemDetails: z
    .object({
      itemIngestionStatus: z
        .array(
          z.object({
            sku: sellerSku,
            wpid: providerId.nullish(),
            ingestionStatus: z.enum([
              "SUCCESS",
              "INPROGRESS",
              "DATA_ERROR",
              "SYSTEM_ERROR",
              "TIMEOUT_ERROR",
            ]),
            pendingStatusDescription: z.string().max(10_000).optional(),
            ingestionErrors: z
              .object({
                ingestionError: z
                  .array(
                    z.object({
                      code: z.string().max(200),
                      field: z.string().max(500).nullish(),
                      description: z.string().max(10_000).optional(),
                    }),
                  )
                  .max(200),
              })
              .nullish(),
          }),
        )
        .max(50),
    })
    .nullish(),
});
export type WalmartFeedPage = z.infer<typeof feedStatusSchema>;
const itemObservationSchema = z.object({
  ItemResponse: z
    .array(
      z.object({
        sku: sellerSku,
        mart: z.literal("WALMART_US"),
        wpid: providerId.nullish(),
        productName: z.string().max(1_000).optional(),
        lifecycleStatus: z.string().min(1).max(100),
        publishedStatus: z.string().min(1).max(100),
        price: z
          .object({
            currency: z.literal("USD"),
            amount: z.union([z.number().finite(), z.string()]),
          })
          .nullish(),
      }),
    )
    .length(1),
});
export type WalmartListingObservation = z.infer<
  typeof itemObservationSchema
>["ItemResponse"][number];

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new WalmartApiError(
      "WALMART_LISTING_RESPONSE_INVALID",
      "Walmart returned an invalid listing response",
      false,
    );
  return parsed.data;
}

/** JSON keys are canonicalized for reproducible approval hashes, not used as code. */
export function listingJsonHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** Authenticated provider transport only. Publication authority belongs to the caller. */
export class WalmartListingApi {
  constructor(
    private readonly client: Pick<WalmartClient, "requestWithMetadata">,
  ) {}

  async taxonomy(): Promise<string[]> {
    const query = new URLSearchParams({
      feedType: "MP_ITEM",
      version: WALMART_LISTING_SPEC.MP_ITEM,
    });
    const response = await this.client.requestWithMetadata(
      "GET",
      `/v3/items/taxonomy?${query}`,
    );
    const categorySchema = z.object({
      productTypeGroup: z
        .array(
          z.object({
            productType: z
              .array(z.object({ productTypeName: productTypeSchema }))
              .max(10_000),
          }),
        )
        .max(10_000),
    });
    // Walmart's reference schema models one category; its official example is an array.
    const result = parse(
      z.object({
        itemTaxonomy: z.union([
          z.array(categorySchema).max(10_000),
          categorySchema.transform((value) => [value]),
        ]),
      }),
      response.data,
    );
    return [
      ...new Set(
        result.itemTaxonomy.flatMap((category) =>
          category.productTypeGroup.flatMap((group) =>
            group.productType.map((item) => item.productTypeName),
          ),
        ),
      ),
    ].sort();
  }

  async requirements(
    feedType: WalmartListingFeedType,
    productType: string,
  ): Promise<WalmartListingSchema> {
    walmartListingFeedTypeSchema.parse(feedType);
    const version = WALMART_LISTING_SPEC[feedType];
    const response = await this.client.requestWithMetadata(
      "POST",
      "/v3/items/spec",
      {
        feedType,
        version,
        ...(feedType === "MP_ITEM"
          ? { productTypes: [productTypeSchema.parse(productType)] }
          : {}),
      },
    );
    const parsed = parse(
      z.object({
        schema: z.record(z.unknown()),
        errors: z.array(z.unknown()).optional(),
      }),
      response.data,
    );
    // A partial schema cannot certify the selected item, even when a schema is present.
    if (response.metadata.status === 207 || parsed.errors?.length) {
      throw new WalmartApiError(
        "WALMART_PARTIAL_SPEC",
        "Walmart could not return all requested listing requirements",
        false,
        response.metadata.status,
        response.metadata,
      );
    }
    const header = parse(
      z.object({
        properties: z.object({
          MPItemFeedHeader: z.object({
            properties: z.object({
              version: z.object({ enum: z.array(z.string()) }),
            }),
          }),
        }),
      }),
      parsed.schema,
    );
    if (
      !header.properties.MPItemFeedHeader.properties.version.enum.includes(
        version,
      )
    ) {
      throw new WalmartApiError(
        "WALMART_SPEC_VERSION_MISMATCH",
        "Walmart returned a different listing specification version",
        false,
      );
    }
    return {
      version,
      schema: parsed.schema,
      schemaHash: listingJsonHash(parsed.schema),
    };
  }

  async match(identifier: WalmartListingIdentifier): Promise<{
    feedType: WalmartListingFeedType;
    version: string;
    payload: Record<string, unknown>;
  } | null> {
    const valid = identifierSchema.parse(identifier);
    const query = new URLSearchParams({
      responseFormat: "SPEC",
      [valid.type.toLowerCase()]: valid.value,
    });
    const response = await this.client.requestWithMetadata(
      "GET",
      `/v3/items/walmart/search?${query}`,
    );
    const parsed = parse(
      z.object({
        items: z
          .array(
            z.object({
              feedType: walmartListingFeedTypeSchema,
              version: z.string(),
              itemSpecPayload: z.record(z.unknown()),
            }),
          )
          .max(1)
          .optional(),
      }),
      response.data,
    );
    const match = parsed.items?.[0];
    if (!match) return null;
    if (match.version !== WALMART_LISTING_SPEC[match.feedType]) {
      throw new WalmartApiError(
        "WALMART_SPEC_VERSION_MISMATCH",
        "Walmart catalog matching uses a different specification version; refresh listing requirements",
        false,
      );
    }
    return {
      feedType: match.feedType,
      version: match.version,
      payload: match.itemSpecPayload,
    };
  }

  async submitFeed(
    feedType: WalmartListingFeedType,
    payload: Record<string, unknown>,
    correlationId: string,
    admission: Readonly<ListingSetupZeroIntent>,
  ): Promise<{ feedId: string; metadata: WalmartResponseMetadata }> {
    walmartListingFeedTypeSchema.parse(feedType);
    z.string().uuid().parse(correlationId);
    assertListingSetupZeroAdmission(admission);
    const batch = z
      .object({ MPItem: z.array(z.record(z.unknown())).min(1).max(100) })
      .parse(payload);
    if (batch.MPItem.length !== admission.items.length)
      throw new WalmartApiError(
        "WALMART_LISTING_ADMISSION_MISMATCH",
        "Initial stock approval differs from the feed",
        false,
      );
    const seen = new Set<string>();
    for (const item of batch.MPItem) {
      const offer = z
        .object({
          sku: sellerSku,
          inventory: z
            .array(
              z
                .object({
                  quantity: z.literal(0),
                  fulfillmentCenterID: z.literal(admission.shipNodeId),
                })
                .strict(),
            )
            .length(1),
        })
        .parse(item[feedType === "MP_ITEM" ? "Orderable" : "Item"]);
      if (
        seen.has(offer.sku) ||
        !admission.items.some((member) => member.sku === offer.sku)
      ) {
        throw new WalmartApiError(
          "WALMART_LISTING_ADMISSION_MISMATCH",
          "Initial stock approval differs from the feed SKU membership",
          false,
        );
      }
      seen.add(offer.sku);
    }
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 10 * 1024 * 1024) {
      throw new WalmartApiError(
        "WALMART_LISTING_FEED_TOO_LARGE",
        "The listing batch exceeds the feed size limit",
        false,
      );
    }
    // A timeout/5xx may occur after ingestion. Never replay this POST here.
    const response = await this.client.requestWithMetadata(
      "POST",
      `/v3/feeds?feedType=${feedType}`,
      payload,
      { correlationId },
    );
    const receipt = parse(
      z.object({
        feedId: providerId,
        error: z.array(z.unknown()).max(0).nullish(),
        errors: z.array(z.unknown()).max(0).nullish(),
      }),
      response.data,
    );
    return { feedId: receipt.feedId, metadata: response.metadata };
  }

  async feedStatus(feedId: string, offset = 0): Promise<WalmartFeedPage> {
    providerId.parse(feedId);
    z.number().int().min(0).max(10_000).parse(offset);
    // The API reference limits detail pages to 50 even though a guide says 1000.
    const query = new URLSearchParams({
      includeDetails: "true",
      offset: String(offset),
      limit: "50",
    });
    const response = await this.client.requestWithMetadata(
      "GET",
      `/v3/feeds/${encodeURIComponent(feedId)}?${query}`,
    );
    const page = parse(feedStatusSchema, response.data);
    if (page.feedId !== feedId)
      throw new WalmartApiError(
        "WALMART_FEED_MISMATCH",
        "Walmart returned a different feed",
        false,
      );
    return page;
  }

  async observe(sku: string): Promise<WalmartListingObservation> {
    sellerSku.parse(sku);
    const response = await this.client.requestWithMetadata(
      "GET",
      `/v3/items/${encodeURIComponent(sku)}?productIdType=SKU`,
    );
    const item = parse(itemObservationSchema, response.data).ItemResponse[0];
    if (item.sku !== sku)
      throw new WalmartApiError(
        "WALMART_SKU_MISMATCH",
        "Walmart returned a different seller SKU",
        false,
      );
    return item;
  }

  /** A price acknowledgement is not observed storefront state. The durable price
   * owner must reconcile observe() before marking the desired revision applied.
   * https://developer.walmart.com/us-marketplace/reference/updateprice */
  async updatePrice(
    sku: string,
    priceCents: number,
    correlationId: string,
  ): Promise<WalmartResponseMetadata> {
    sellerSku.parse(sku);
    z.string().uuid().parse(correlationId);
    const response = await this.client.requestWithMetadata(
      "PUT",
      "/v3/price",
      {
        sku,
        pricing: [
          {
            currentPriceType: "BASE",
            currentPrice: {
              currency: "USD",
              amount: priceForWalmart(priceCents),
            },
          },
        ],
      },
      { correlationId },
    );
    const receipt = z.object({
      sku: sellerSku,
      mart: z.literal("WALMART_US"),
      errors: z.array(z.unknown()).max(0).nullish(),
    });
    // The official schema is unwrapped; its documented JSON example is wrapped.
    const result = parse(
      z.union([
        z
          .object({ ItemPriceResponse: receipt })
          .transform((value) => value.ItemPriceResponse),
        receipt,
      ]),
      response.data,
    );
    if (result.sku !== sku)
      throw new WalmartApiError(
        "WALMART_SKU_MISMATCH",
        "Walmart acknowledged a different pricing SKU",
        false,
      );
    return response.metadata;
  }
}
