import { z } from "zod";
import type {
  ListingAccount,
  ListingIssue,
} from "@shared/types/channel-listing-publication";
import {
  hasListingUpdateChanges,
  listingUpdateObservationSchema,
  reviewListingUpdateSchema,
  type ListingUpdateObservation,
  type ReviewListingUpdate,
} from "@shared/types/channel-listing-update";
import type {
  ListingUpdateIntent,
  ListingUpdateProvider,
} from "../../../marketplace-listings/application/listing-update-ports";
import { ListingSubmissionError } from "../../../marketplace-listings/application/listing-publication-provider.port";
import { assertUpdateSource } from "../../../marketplace-listings/domain/listing-update";
import {
  ListingPublicationError,
  listingHash,
} from "../../../marketplace-listings/domain/listing-publication";
import type { WalmartChannelService } from "./walmart-channel.service";
import {
  WalmartListingProvider,
  listingErrorDescription,
} from "./walmart-listing.provider";
import { WalmartApiError } from "./walmart-client";
import { WALMART_LISTING_SPEC } from "./walmart-listing-api";
import {
  CANONICAL_VISIBLE_FIELDS,
  MAINTENANCE_PROTECTED_ORDERABLE_FIELDS,
  compileListingSchema,
  editorSchema,
  listingSubmissionSchema,
  priceForWalmart,
  priceFromWalmart,
  schemaIssues,
  validProductIdentifier,
} from "./walmart-listing-schema";

const FEED = "MP_MAINTENANCE";
const PROTECTED = MAINTENANCE_PROTECTED_ORDERABLE_FIELDS;

/** Maintenance contains only explicit content changes; it never invokes inventory admission. */
export class WalmartListingUpdateProvider implements ListingUpdateProvider {
  private readonly listing: WalmartListingProvider;
  constructor(private readonly channels: WalmartChannelService) {
    this.listing = new WalmartListingProvider(channels);
  }
  account(channelId: number) {
    return this.listing.account(channelId);
  }
  async taxonomy(account: ListingAccount) {
    return (await this.api(account)).taxonomy();
  }
  private async api(
    account: ListingAccount,
    write = false,
    allowCredentialRotation = false,
  ) {
    const current = await this.account(account.channelId);
    // Polling a receipt may use rotated credentials for the same account and
    // connection. A write still requires the exact reviewed connection revision.
    assertUpdateSource(
      allowCredentialRotation
        ? { ...account, revision: current.revision }
        : account,
      current,
    );
    const connection = await this.channels.connection(
      account.channelId,
      account.connectionId,
    );
    // The second read must still match if credentials were rotated between reads.
    if (connection.revision !== current.revision)
      throw new ListingPublicationError(
        "LISTING_UPDATE_STALE",
        "The Walmart connection changed. Review again.",
      );
    if (write) this.channels.requireRuntime(connection);
    return this.channels.listingApi(connection);
  }
  async observe(
    account: ListingAccount,
    sku: string,
  ): Promise<ListingUpdateObservation> {
    const item = await (await this.api(account)).observe(sku);
    const identifier = item.gtin
      ? { type: "GTIN" as const, value: item.gtin }
      : item.upc
        ? { type: "UPC" as const, value: item.upc }
        : null;
    if (!item.wpid || !identifier || !validProductIdentifier(identifier)) {
      throw new ListingPublicationError(
        "LISTING_UPDATE_IDENTITY_UNAVAILABLE",
        "Walmart has not returned this item's product ID and valid barcode yet. Refresh its status before editing.",
      );
    }
    if (item.lifecycleStatus.toUpperCase() !== "ACTIVE") {
      throw new ListingPublicationError(
        "LISTING_UPDATE_ITEM_INACTIVE",
        "This Walmart listing is retired or inactive. Restore it in Seller Center before editing.",
      );
    }
    return listingUpdateObservationSchema.parse({
      sku: item.sku,
      externalProductId: item.wpid,
      identifier,
      title: item.productName ?? item.sku,
      productType: item.productType ?? "",
      priceCents: item.price ? priceFromWalmart(item.price.amount) : null,
      lifecycleStatus: item.lifecycleStatus,
      publishedStatus: item.publishedStatus,
    });
  }
  async requirements(account: ListingAccount, productType: string) {
    const schema = await (
      await this.api(account)
    ).requirements(FEED, productType);
    return editorSchema(schema.schema, FEED, productType);
  }
  async prepare(
    account: ListingAccount,
    source: ListingUpdateObservation,
    input: ReviewListingUpdate,
  ) {
    const command = reviewListingUpdateSchema.parse(input);
    if (command.sku !== source.sku)
      throw new ListingPublicationError(
        "LISTING_UPDATE_SKU_CHANGED",
        "The listing SKU changed. Reopen the listing.",
      );
    const schema = await (
      await this.api(account)
    ).requirements(FEED, command.productType);
    const validationSchema = listingSubmissionSchema(
      schema.schema,
      FEED,
      command.productType,
    );
    const issues: ListingIssue[] = [];
    const changes = command.changes;
    // Revalidate older saved reviews at send time as well as new reviews.
    if (!hasListingUpdateChanges(changes))
      issues.push({
        code: "LISTING_UPDATE_EMPTY",
        field: "changes",
        message: "Change at least one item field. A product-type selection alone does not update item content.",
      });
    const orderable = changes.attributes?.Orderable ?? {};
    const visible = changes.attributes?.Visible ?? {};
    for (const key of Object.keys(orderable))
      if (PROTECTED.has(key))
        issues.push({
          code: "LISTING_UPDATE_PROTECTED_FIELD",
          field: `Orderable/${key}`,
          message: `Use the listing controls to change ${key}; identifiers, stock and country of origin cannot be changed here.`,
        });
    for (const key of Object.keys(visible))
      if (CANONICAL_VISIBLE_FIELDS.has(key))
        issues.push({
          code: "LISTING_UPDATE_PROTECTED_FIELD",
          field: `Visible/${key}`,
          message: `Use the content field to change ${key}.`,
        });
    const payload = {
      MPItemFeedHeader: {
        businessUnit: "WALMART_US",
        locale: "en",
        version: WALMART_LISTING_SPEC[FEED],
      },
      MPItem: [
        {
          Orderable: {
            ...orderable,
            sku: source.sku,
            productIdentifiers: {
              productIdType: source.identifier.type,
              productId: source.identifier.value,
            },
            ...(changes.priceCents === undefined
              ? {}
              : { price: priceForWalmart(changes.priceCents) }),
          },
          Visible: {
            // This selects the maintenance attribute schema. Feed acceptance
            // does not prove Walmart changed its assigned catalog product type.
            [command.productType]: {
              ...visible,
              ...(changes.title === undefined
                ? {}
                : { productName: changes.title }),
              ...(changes.description === undefined
                ? {}
                : { shortDescription: changes.description }),
              ...(changes.brand === undefined ? {} : { brand: changes.brand }),
              ...(changes.images === undefined
                ? {}
                : {
                    mainImageUrl: changes.images[0],
                    productSecondaryImageURL: changes.images.slice(1),
                  }),
            },
          },
        },
      ],
    };
    const validate = compileListingSchema(validationSchema);
    if (!validate(payload)) issues.push(...schemaIssues(validate.errors));
    return { payload, schemaHash: listingHash(validationSchema), issues };
  }
  async send(
    intent: ListingUpdateIntent,
    correlationId: string,
    beforeSend: () => Promise<void>,
  ): Promise<string> {
    let entered = false;
    try {
      z.string().uuid().parse(correlationId);
      const api = await this.api(intent.account, true);
      assertUpdateSource(
        intent.source,
        await this.observe(intent.account, intent.command.sku),
      );
      const prepared = await this.prepare(
        intent.account,
        intent.source,
        intent.command,
      );
      assertUpdateSource(intent.prepared, prepared);
      if (prepared.issues.length)
        throw new ListingPublicationError(
          "LISTING_UPDATE_INVALID",
          "Correct the listing fields before sending.",
        );
      await beforeSend();
      entered = true;
      return await api.submitMaintenance(prepared.payload, correlationId);
    } catch (error) {
      const rejected =
        error instanceof WalmartApiError &&
        [401, 403, 429].includes(error.status ?? 0);
      throw new ListingSubmissionError(
        error instanceof WalmartApiError ||
        error instanceof ListingPublicationError
          ? error.code
          : "LISTING_UPDATE_FAILED",
        error instanceof WalmartApiError ||
        error instanceof ListingPublicationError
          ? error.message
          : "The listing update could not complete.",
        !entered ? "not_sent" : rejected ? "rejected" : "uncertain",
      );
    }
  }
  async status(
    account: ListingAccount,
    submissionId: string,
    sku: string,
    externalProductId: string,
  ) {
    const result = await (
      await this.api(account, false, true)
    ).feedStatus(submissionId);
    if (
      result.itemsReceived > 1 ||
      (result.feedStatus === "PROCESSED" && result.itemsReceived !== 1) ||
      (result.itemDetails?.itemIngestionStatus.length ?? 0) > 1 ||
      result.itemDetails?.itemIngestionStatus.some((item) => item.sku !== sku)
    ) {
      throw new ListingPublicationError(
        "LISTING_UPDATE_RECEIPT_MISMATCH",
        "Walmart returned a different listing in this update feed.",
      );
    }
    const item = result.itemDetails?.itemIngestionStatus[0];
    if (item?.wpid && item.wpid !== externalProductId)
      throw new ListingPublicationError(
        "LISTING_UPDATE_PRODUCT_CHANGED",
        "Walmart returned a different product for this update. Check the listing in Seller Center.",
      );
    if (
      result.feedStatus === "ERROR" ||
      (item && !["INPROGRESS", "SUCCESS"].includes(item.ingestionStatus))
    ) {
      const message = item?.ingestionErrors?.ingestionError
        .map((error) =>
          listingErrorDescription(error.description ?? error.code),
        )
        .join("; ")
        .slice(0, 2_000);
      return {
        state: "needs_attention" as const,
        message:
          message ||
          "Walmart rejected this update. Correct the fields and review again.",
      };
    }
    return result.feedStatus === "PROCESSED" &&
      item?.ingestionStatus === "SUCCESS"
      ? {
          state: "accepted" as const,
          message:
            "Walmart processed this feed. Check the item on Walmart to verify its category and listing status.",
        }
      : {
          state: "processing" as const,
          message: "Walmart is processing these changes.",
        };
  }
}
