import { z } from "zod";
import {
  listingAccountSchema,
  listingDraftItemSchema,
  type ListingAccount,
  type ListingIssue,
  type ListingTaxonomy,
} from "@shared/types/channel-listing-publication";
import type {
  ListingPublicationInput,
  ListingPublicationProvider,
  PreparedListingItem,
  ListingSubmissionObservation,
} from "../../../marketplace-listings/application/listing-publication-provider.port";
import { ListingSubmissionError } from "../../../marketplace-listings/application/listing-publication-provider.port";
import { WalmartChannelService } from "./walmart-channel.service";
import { WalmartApiError } from "./walmart-client";
import {
  WALMART_LISTING_SPEC,
  WalmartListingApi,
  listingJsonHash,
  walmartListingFeedTypeSchema,
  type WalmartListingFeedType,
  type WalmartListingSchema,
} from "./walmart-listing-api";
import {
  CANONICAL_VISIBLE_FIELDS,
  PROTECTED_ORDERABLE_FIELDS,
  compileListingSchema,
  editorSchema,
  jsonObject,
  listingSubmissionSchema,
  priceForWalmart,
  priceFromWalmart,
  sameProductIdentifier,
  schemaIssues,
  validProductIdentifier,
} from "./walmart-listing-schema";
import {
  assertListingSetupZeroAdmission,
  type ListingSetupZeroIntent,
} from "../../../inventory-planning/application/listing-setup-zero-intent";

type SchemaCacheEntry = WalmartListingSchema & {
  validate: ReturnType<typeof compileListingSchema>;
};
const skuSchema = z.string().min(1).max(50);
const issue = (
  code: string,
  message: string,
  field: string | null = null,
): ListingIssue => ({ code, message, field });
function listingErrorDescription(value: string | undefined): string {
  // These are structured item-validation descriptions, not arbitrary HTTP error
  // bodies. Bound display text and redact authentication-shaped fragments.
  return (
    value
      ?.replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[redacted]")
      .replace(
        /(client[_ -]?secret|access[_ -]?token|authorization)\s*[:=]\s*[^\s,;]+/gi,
        "$1: [redacted]",
      )
      .slice(0, 2_000)
      .trim() ||
    "Walmart rejected this item; correct the indicated field and review again"
  );
}

function feedHeader(feedType: WalmartListingFeedType): Record<string, unknown> {
  return {
    businessUnit: "WALMART_US",
    locale: "en",
    version: WALMART_LISTING_SPEC[feedType],
  };
}

/** Walmart translation only: durable jobs, consent and stock admission remain owned by the application. */
export class WalmartListingProvider implements ListingPublicationProvider {
  private readonly schemas = new Map<string, SchemaCacheEntry>();
  constructor(private readonly channels: WalmartChannelService) {}

  async account(channelId: number): Promise<ListingAccount> {
    z.number().int().positive().parse(channelId);
    const row = await this.channels.connection(channelId);
    return listingAccountSchema.parse({
      channelId,
      connectionId: row.connection_id,
      provider: "walmart",
      market: "us",
      environment: row.environment,
      accountId: row.partner_id,
      scopeId: row.ship_node_id,
      revision: row.revision,
    });
  }

  async taxonomy(account: ListingAccount): Promise<ListingTaxonomy> {
    return (await this.api(account)).taxonomy();
  }

  async requirements(
    account: ListingAccount,
    productType: string,
    method: "create" | "match",
  ) {
    z.enum(["create", "match"]).parse(method);
    const feedType = method === "match" ? "MP_ITEM_MATCH" : "MP_ITEM";
    const schema = await this.schema(account, feedType, productType);
    return {
      productType,
      method,
      version: schema.version,
      schemaHash: schema.schemaHash,
      schema: editorSchema(schema.schema, feedType, productType),
    };
  }

  async prepare(
    account: ListingAccount,
    input: ListingPublicationInput,
  ): Promise<PreparedListingItem> {
    const draft = listingDraftItemSchema.parse(input.draft);
    const api = await this.api(account);
    const feedType: WalmartListingFeedType =
      draft.method === "match" ? "MP_ITEM_MATCH" : "MP_ITEM";
    const issues: ListingIssue[] = [];
    const sku = input.catalog.sku;
    const result: PreparedListingItem = {
      variantId: draft.variantId,
      sku,
      feedType,
      schemaVersion: WALMART_LISTING_SPEC[feedType],
      schemaHash: "",
      payload: {},
      issues,
    };
    if (
      draft.variantId !== input.catalog.variantId ||
      !input.catalog.eligible ||
      input.catalog.alreadyLinked
    ) {
      issues.push(
        issue(
          "WALMART_VARIANT_INELIGIBLE",
          "Select an eligible variant that is not already linked",
        ),
      );
    }
    if (!skuSchema.safeParse(sku).success)
      issues.push(
        issue(
          "WALMART_SKU_INVALID",
          "Walmart requires a seller SKU between 1 and 50 characters",
          "sku",
        ),
      );
    const identifier = draft.identifier ?? input.catalog.identifier;
    if (!identifier || !validProductIdentifier(identifier))
      issues.push(
        issue(
          "WALMART_IDENTIFIER_INVALID",
          "Provide a valid UPC, GTIN, EAN or ISBN for this exact selling unit",
          "identifier",
        ),
      );
    if (draft.method === "create" && !draft.productType)
      issues.push(
        issue(
          "WALMART_PRODUCT_TYPE_REQUIRED",
          "Choose the Walmart product type",
          "productType",
        ),
      );
    const attributes = draft.attributes;
    if (
      Object.keys(attributes).some(
        (key) => key !== "Orderable" && key !== "Visible",
      )
    )
      issues.push(
        issue(
          "WALMART_ATTRIBUTES_INVALID",
          "Use the shipping and product attribute sections",
          "attributes",
        ),
      );
    const orderable = this.attributeSection(
      attributes.Orderable,
      "Orderable",
      issues,
    );
    const visible = this.attributeSection(
      attributes.Visible,
      "Visible",
      issues,
    );
    for (const key of Object.keys(orderable)) {
      if (
        PROTECTED_ORDERABLE_FIELDS.has(key) ||
        (feedType === "MP_ITEM_MATCH" && CANONICAL_VISIBLE_FIELDS.has(key))
      ) {
        issues.push(
          issue(
            "WALMART_PROTECTED_ATTRIBUTE",
            "Identity, pricing and inventory are managed by Echelon",
            `attributes/Orderable/${key}`,
          ),
        );
      }
    }
    for (const key of Object.keys(visible)) {
      if (CANONICAL_VISIBLE_FIELDS.has(key))
        issues.push(
          issue(
            "WALMART_PROTECTED_ATTRIBUTE",
            "Edit this field in the listing content section",
            `attributes/Visible/${key}`,
          ),
        );
    }
    if (feedType === "MP_ITEM_MATCH" && Object.keys(visible).length)
      issues.push(
        issue(
          "WALMART_MATCH_CONTENT_UNSUPPORTED",
          "An existing catalog offer cannot replace product content",
          "attributes/Visible",
        ),
      );
    let price: number;
    try {
      price = priceForWalmart(input.priceCents);
    } catch {
      issues.push(
        issue(
          "WALMART_PRICE_INVALID",
          "Provide a positive price in whole cents",
          "priceCents",
        ),
      );
      return result;
    }
    if (issues.length || !identifier) return result;

    // Never use a create action to adopt/overwrite an already-existing seller SKU.
    try {
      await api.observe(sku);
      issues.push(
        issue(
          "WALMART_SKU_ALREADY_EXISTS",
          "This seller SKU already exists on Walmart; link the existing listing instead",
          "sku",
        ),
      );
      return result;
    } catch (error) {
      if (!(error instanceof WalmartApiError) || error.status !== 404)
        throw error;
    }
    if (feedType === "MP_ITEM_MATCH") {
      const matched = await api.match(identifier);
      if (!matched || matched.feedType !== "MP_ITEM_MATCH") {
        issues.push(
          issue(
            "WALMART_CATALOG_MATCH_REQUIRED",
            "No existing Walmart product was confirmed for this identifier; use new item setup",
            "identifier",
          ),
        );
        return result;
      }
      const parsed = z
        .object({
          MPItem: z
            .array(
              z.object({
                Item: z.object({
                  productIdentifiers: z.object({
                    productIdType: z.enum(["GTIN", "UPC", "EAN", "ISBN"]),
                    productId: z.string(),
                  }),
                }),
              }),
            )
            .length(1),
        })
        .safeParse(matched.payload);
      if (
        !parsed.success ||
        !sameProductIdentifier(identifier, {
          type: parsed.data.MPItem[0].Item.productIdentifiers.productIdType,
          value: parsed.data.MPItem[0].Item.productIdentifiers.productId,
        })
      ) {
        issues.push(
          issue(
            "WALMART_CATALOG_IDENTIFIER_MISMATCH",
            "The Walmart catalog match has a different selling-unit identifier",
            "identifier",
          ),
        );
        return result;
      }
    }
    const schema = await this.schema(account, feedType, draft.productType);
    result.schemaHash = schema.schemaHash;
    const title = draft.title ?? input.catalog.title;
    const description = draft.description ?? input.catalog.description;
    const brand = draft.brand ?? input.catalog.brand;
    const images = draft.images ?? input.catalog.images;
    const imageUrls = z
      .array(
        z
          .string()
          .url()
          .refine((value) => new URL(value).protocol === "https:"),
      )
      .max(20)
      .safeParse(images);
    if (!imageUrls.success)
      issues.push(
        issue(
          "WALMART_IMAGES_INVALID",
          "Use public HTTPS image URLs",
          "images",
        ),
      );
    const offer = {
      ...orderable,
      ...(feedType === "MP_ITEM" ? { specProductType: draft.productType } : {}),
      sku,
      productIdentifiers: {
        productIdType: identifier.type,
        productId: identifier.value,
      },
      price,
      // Submission of even this conservative zero requires the quantity owner's admission.
      inventory: [{ quantity: 0, fulfillmentCenterID: account.scopeId }],
    };
    result.payload =
      feedType === "MP_ITEM_MATCH"
        ? {
            Item: {
              ...offer,
              productName: title,
              ...(images.length ? { mainImageUrl: images[0] } : {}),
            },
          }
        : {
            Orderable: offer,
            Visible: {
              [draft.productType]: {
                ...visible,
                productName: title,
                ...(description !== null
                  ? { shortDescription: description }
                  : {}),
                ...(brand !== null ? { brand } : {}),
                ...(images.length ? { mainImageUrl: images[0] } : {}),
                ...(images.length > 1
                  ? { productSecondaryImageURL: images.slice(1) }
                  : {}),
              },
            },
          };
    if (
      !schema.validate({
        MPItemFeedHeader: feedHeader(feedType),
        MPItem: [result.payload],
      })
    )
      issues.push(...schemaIssues(schema.validate.errors));
    return result;
  }

  async submit(
    account: ListingAccount,
    input: {
      operationId: string;
      correlationId: string;
      items: PreparedListingItem[];
      zeroStockAdmission: Readonly<ListingSetupZeroIntent>;
      beforeSubmit(): Promise<void>;
    },
  ): Promise<{ submissionId: string }> {
    let writeEntered = false;
    try {
      z.string().uuid().parse(input.operationId);
      z.string().uuid().parse(input.correlationId);
      z.array(z.unknown()).min(1).max(100).parse(input.items);
      assertListingSetupZeroAdmission(input.zeroStockAdmission);
      const admission = input.zeroStockAdmission;
      if (
        admission.operationId !== input.operationId ||
        admission.channelId !== account.channelId ||
        admission.channelConnectionId !== account.connectionId ||
        admission.partnerId !== account.accountId ||
        admission.environment !== account.environment ||
        admission.shipNodeId !== account.scopeId ||
        admission.items.length !== input.items.length ||
        input.items.some(
          (item) =>
            !admission.items.some(
              (member) =>
                member.productVariantId === item.variantId &&
                member.sku === item.sku &&
                member.quantity === 0,
            ),
        )
      ) {
        throw new WalmartApiError(
          "WALMART_LISTING_ADMISSION_MISMATCH",
          "The initial stock approval differs from the listing batch",
          false,
        );
      }
      const api = await this.api(account, true);
      const feedType = walmartListingFeedTypeSchema.parse(
        input.items[0].feedType,
      );
      const seen = new Set<string>();
      for (const item of input.items) {
        await input.beforeSubmit();
        if (
          item.feedType !== feedType ||
          item.schemaVersion !== WALMART_LISTING_SPEC[feedType] ||
          item.issues.length ||
          seen.has(item.sku)
        ) {
          throw new WalmartApiError(
            "WALMART_LISTING_BATCH_INVALID",
            "Listing batch contains duplicate, invalid or incompatible items",
            false,
          );
        }
        seen.add(item.sku);
        const offer = jsonObject(
          item.payload[feedType === "MP_ITEM" ? "Orderable" : "Item"],
        );
        const inventory = z
          .array(
            z
              .object({
                quantity: z.literal(0),
                fulfillmentCenterID: z.literal(account.scopeId),
              })
              .strict(),
          )
          .length(1)
          .safeParse(offer.inventory);
        if (offer.sku !== item.sku || !inventory.success)
          throw new WalmartApiError(
            "WALMART_LISTING_STOCK_INVALID",
            "Listing setup must use zero stock at the approved fulfillment center",
            false,
          );
        const productType =
          feedType === "MP_ITEM"
            ? Object.keys(jsonObject(item.payload.Visible))[0]
            : "";
        const schema = await this.schema(account, feedType, productType);
        if (
          schema.schemaHash !== item.schemaHash ||
          !schema.validate({
            MPItemFeedHeader: feedHeader(feedType),
            MPItem: [item.payload],
          })
        ) {
          throw new WalmartApiError(
            "WALMART_LISTING_REVIEW_STALE",
            "Listing requirements changed or the approved payload is no longer valid; review again",
            false,
          );
        }
        try {
          await api.observe(item.sku);
          throw new WalmartApiError(
            "WALMART_SKU_ALREADY_EXISTS",
            "A seller SKU was created after review; reconcile it before submitting",
            false,
          );
        } catch (error) {
          if (!(error instanceof WalmartApiError) || error.status !== 404)
            throw error;
        }
      }
      this.validateVariantGroups(input.items, feedType);
      await input.beforeSubmit();
      writeEntered = true;
      const receipt = await api.submitFeed(
        feedType,
        {
          MPItemFeedHeader: feedHeader(feedType),
          MPItem: input.items.map((item) => item.payload),
        },
        input.correlationId,
        admission,
      );
      return { submissionId: receipt.feedId };
    } catch (error) {
      const effect = !writeEntered
        ? "not_sent"
        : error instanceof WalmartApiError &&
            error.requestMetadata?.quantityOutcome === "rejected"
          ? "rejected"
          : "uncertain";
      const code =
        error instanceof WalmartApiError
          ? error.code
          : error instanceof Error &&
              "code" in error &&
              typeof error.code === "string"
            ? error.code
            : "WALMART_LISTING_SUBMISSION_FAILED";
      const message =
        error instanceof WalmartApiError
          ? error.message
          : "The listing submission could not complete. Review its recorded outcome before trying again.";
      throw new ListingSubmissionError(code, message, effect);
    }
  }

  async status(
    account: ListingAccount,
    submissionId: string,
  ): Promise<ListingSubmissionObservation> {
    const api = await this.api(account);
    const first = await api.feedStatus(submissionId);
    const items = [...(first.itemDetails?.itemIngestionStatus ?? [])];
    for (let offset = 50; offset < first.itemsReceived; offset += 50) {
      const page = await api.feedStatus(submissionId, offset);
      if (page.itemsReceived !== first.itemsReceived)
        throw new WalmartApiError(
          "WALMART_FEED_CHANGED",
          "Walmart feed totals changed during reconciliation",
          true,
        );
      items.push(...(page.itemDetails?.itemIngestionStatus ?? []));
    }
    if (new Set(items.map((item) => item.sku)).size !== items.length)
      throw new WalmartApiError(
        "WALMART_FEED_DUPLICATE_SKU",
        "Walmart returned duplicate item outcomes",
        false,
      );
    return {
      state:
        first.feedStatus === "ERROR"
          ? "error"
          : first.feedStatus === "PROCESSED"
            ? "processed"
            : "processing",
      items: items.map((item) => ({
        sku: item.sku,
        externalProductId: item.wpid ?? null,
        state:
          item.pendingStatusDescription || item.ingestionStatus === "INPROGRESS"
            ? "processing"
            : item.ingestionStatus === "SUCCESS"
              ? "accepted"
              : "needs_attention",
        retryable:
          ["PROCESSED", "ERROR"].includes(first.feedStatus) &&
          !item.pendingStatusDescription &&
          ["DATA_ERROR", "SYSTEM_ERROR", "TIMEOUT_ERROR"].includes(
            item.ingestionStatus,
          ),
        issues: (item.ingestionErrors?.ingestionError ?? [])
          .map((error) =>
            issue(
              /^[A-Z0-9_.-]+$/i.test(error.code)
                ? error.code
                : "WALMART_ITEM_ERROR",
              listingErrorDescription(error.description),
              error.field && /^[\w.[\]/ -]+$/.test(error.field)
                ? error.field
                : null,
            ),
          )
          .concat(
            item.pendingStatusDescription
              ? [
                  issue(
                    "WALMART_REVIEW_PENDING",
                    "Walmart is reviewing this item; edits and resubmission remain unavailable until review completes",
                  ),
                ]
              : [],
          ),
      })),
    };
  }

  async observe(account: ListingAccount, sku: string) {
    const item = await (await this.api(account)).observe(sku);
    return {
      item: {
        sku: item.sku,
        title: item.productName ?? item.sku,
        externalProductId: item.wpid ?? null,
        externalVariantId: item.sku,
        externalInventoryItemId: item.sku,
        lifecycleStatus: item.lifecycleStatus,
        publishedStatus: item.publishedStatus,
      },
      priceCents: item.price ? priceFromWalmart(item.price.amount) : null,
    };
  }

  private async api(
    account: ListingAccount,
    write = false,
  ): Promise<WalmartListingApi> {
    const expected = listingAccountSchema.parse(account);
    const row = await this.channels.connection(
      account.channelId,
      account.connectionId,
    );
    if (
      expected.provider !== "walmart" ||
      expected.market !== "us" ||
      row.partner_id !== expected.accountId ||
      row.ship_node_id !== expected.scopeId ||
      row.revision !== expected.revision ||
      row.environment !== expected.environment
    ) {
      throw new WalmartApiError(
        "WALMART_LISTING_ACCOUNT_CHANGED",
        "The Walmart account changed; review the listing batch again",
        false,
      );
    }
    if (write) this.channels.requireRuntime(row);
    return this.channels.listingApi(row);
  }

  private async schema(
    account: ListingAccount,
    feedType: WalmartListingFeedType,
    productType: string,
  ): Promise<SchemaCacheEntry> {
    const api = await this.api(account);
    const key = JSON.stringify([
      account.connectionId,
      account.revision,
      feedType,
      productType,
    ]);
    const cached = this.schemas.get(key);
    if (cached) return cached;
    const schema = await api.requirements(feedType, productType);
    const submissionSchema = listingSubmissionSchema(schema.schema, feedType, productType);
    const entry = {
      ...schema,
      // Reviews bind both Walmart's requirements and the explicit selector
      // contract. Older reviews must be rebuilt before they can be submitted.
      schemaHash: listingJsonHash(submissionSchema),
      validate: compileListingSchema(submissionSchema),
    };
    if (this.schemas.size >= 32)
      this.schemas.delete(this.schemas.keys().next().value!);
    this.schemas.set(key, entry);
    return entry;
  }

  private attributeSection(
    value: unknown,
    section: string,
    issues: ListingIssue[],
  ): Record<string, unknown> {
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      issues.push(
        issue(
          "WALMART_ATTRIBUTES_INVALID",
          `${section} must contain named attributes`,
          `attributes/${section}`,
        ),
      );
      return {};
    }
    return value as Record<string, unknown>;
  }

  private validateVariantGroups(
    items: PreparedListingItem[],
    feedType: WalmartListingFeedType,
  ): void {
    if (feedType !== "MP_ITEM") return;
    const groups = new Map<
      string,
      { names: string; combinations: Set<string>; primaryCount: number }
    >();
    for (const item of items) {
      const visible = jsonObject(
        Object.values(jsonObject(item.payload.Visible))[0],
      );
      if (visible.variantGroupId === undefined) continue;
      const attributes = z
        .array(z.string().min(1))
        .min(1)
        .max(3)
        .parse(visible.variantAttributeNames);
      const names = [...attributes].sort();
      const key = JSON.stringify(names);
      const groupId = z.string().min(1).parse(visible.variantGroupId);
      const group = groups.get(groupId) ?? {
        names: key,
        combinations: new Set<string>(),
        primaryCount: 0,
      };
      const values = JSON.stringify(names.map((name) => visible[name]));
      if (
        group.names !== key ||
        names.some((name) => visible[name] === undefined) ||
        group.combinations.has(values)
      ) {
        throw new WalmartApiError(
          "WALMART_VARIANT_GROUP_INVALID",
          "Variant group attributes must be complete, consistent and unique",
          false,
        );
      }
      group.combinations.add(values);
      if (visible.isPrimaryVariant === "Yes") group.primaryCount++;
      groups.set(groupId, group);
    }
    if ([...groups.values()].some((group) => group.primaryCount !== 1)) {
      throw new WalmartApiError(
        "WALMART_VARIANT_GROUP_INVALID",
        "Each submitted variant group requires exactly one primary variant",
        false,
      );
    }
  }
}
