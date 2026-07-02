import { DropshipError } from "../domain/errors";
import type {
  DropshipMarketplaceListingPushProvider,
  DropshipMarketplaceListingPushRequest,
  DropshipMarketplaceListingPushResult,
} from "../application/dropship-marketplace-listing-push-provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import {
  ShopifyListingConnectorGraphqlError,
  ShopifyListingConnectorHttpError,
  ShopifyListingConnectorInvalidResponseError,
  ShopifyListingConnectorUserError,
  ShopifyMarketplaceListingConnector,
} from "../../channels/listing-connectors/shopify-listing.connector";

type FetchLike = typeof fetch;
interface Clock {
  now(): Date;
}

const DEFAULT_SHOPIFY_GRAPHQL_API_VERSION = "2026-04";

export class ShopifyDropshipListingPushProvider implements DropshipMarketplaceListingPushProvider {
  private readonly listingConnector: ShopifyMarketplaceListingConnector;

  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {
    this.listingConnector = new ShopifyMarketplaceListingConnector({
      fetchImpl: this.fetchImpl,
    });
  }

  async pushListing(input: DropshipMarketplaceListingPushRequest): Promise<DropshipMarketplaceListingPushResult> {
    const credential = await this.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "shopify",
    });
    assertShopifyCredential(credential);

    const apiVersion = resolveShopifyApiVersion(credential);
    try {
      return await this.listingConnector.pushProductSet({
        credentials: {
          shopDomain: credential.shopDomain!,
          accessToken: credential.accessToken,
          apiVersion,
        },
        productSet: buildShopifyProductSetInput(input),
        existingExternalListingId: input.existingExternalListingId,
        sku: input.listingIntent.sku,
      });
    } catch (error) {
      if (error instanceof ShopifyListingConnectorHttpError) {
        if (isPermanentAuthFailureStatus(error.status)) {
          await this.credentials.recordAuthFailure?.({
            vendorId: credential.vendorId,
            storeConnectionId: credential.storeConnectionId,
            platform: "shopify",
            status: "needs_reauth",
            failureCode: "DROPSHIP_SHOPIFY_LISTING_PUSH_HTTP_ERROR",
            message: `Shopify listing push failed with HTTP ${error.status}.`,
            retryable: false,
            statusCode: error.status,
            now: this.clock.now(),
          });
        }
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_LISTING_PUSH_HTTP_ERROR",
          `Shopify listing push failed with HTTP ${error.status}.`,
          {
            retryable: error.retryable,
            status: error.status,
            body: error.body,
          },
        );
      }

      if (error instanceof ShopifyListingConnectorGraphqlError) {
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_LISTING_PUSH_GRAPHQL_ERROR",
          "Shopify listing push failed with GraphQL errors.",
          {
            retryable: false,
            errors: error.errors,
          },
        );
      }

      if (error instanceof ShopifyListingConnectorUserError) {
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_LISTING_PUSH_REJECTED",
          "Shopify rejected the listing push.",
          {
            retryable: false,
            userErrors: error.userErrors,
          },
        );
      }

      if (error instanceof ShopifyListingConnectorInvalidResponseError) {
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_LISTING_PUSH_MISSING_PRODUCT",
          error.message,
          { retryable: true },
        );
      }

      throw error;
    }
  }
}

function assertShopifyCredential(credential: DropshipMarketplaceStoreCredentials): void {
  if (credential.platform !== "shopify") {
    throw new DropshipError("DROPSHIP_SHOPIFY_CREDENTIAL_PLATFORM_MISMATCH", "Shopify credential platform mismatch.", {
      platform: credential.platform,
      retryable: false,
    });
  }
  if (!credential.shopDomain?.trim()) {
    throw new DropshipError("DROPSHIP_SHOPIFY_SHOP_DOMAIN_REQUIRED", "Shopify shop domain is required.", {
      retryable: false,
    });
  }
}

function resolveShopifyApiVersion(credential: DropshipMarketplaceStoreCredentials): string {
  const configured = stringFromConfig(credential.config, "apiVersion")
    ?? process.env.DROPSHIP_SHOPIFY_GRAPHQL_API_VERSION
    ?? process.env.SHOPIFY_API_VERSION
    ?? DEFAULT_SHOPIFY_GRAPHQL_API_VERSION;
  if (!/^\d{4}-\d{2}$/.test(configured)) {
    throw new DropshipError("DROPSHIP_SHOPIFY_API_VERSION_INVALID", "Shopify API version is invalid.", {
      apiVersion: configured,
      retryable: false,
    });
  }
  return configured;
}

function isPermanentAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function buildShopifyProductSetInput(input: DropshipMarketplaceListingPushRequest): Record<string, unknown> {
  const intent = input.listingIntent;
  const optionValue = intent.sku?.trim() || intent.title;
  const productSet: Record<string, unknown> = {
    title: intent.title,
    descriptionHtml: intent.description ?? "",
    status: intent.listingMode === "live" ? "ACTIVE" : "DRAFT",
    productOptions: [
      {
        name: "Title",
        position: 1,
        values: [{ name: optionValue }],
      },
    ],
    variants: [
      {
        optionValues: [
          {
            optionName: "Title",
            name: optionValue,
          },
        ],
        price: centsToDecimalString(intent.priceCents),
        sku: intent.sku ?? undefined,
      },
    ],
    metafields: [
      {
        namespace: "cardshellz_dropship",
        key: "listing_id",
        type: "single_line_text_field",
        value: String(input.listingId),
      },
      {
        namespace: "cardshellz_dropship",
        key: "idempotency_key",
        type: "single_line_text_field",
        value: input.idempotencyKey,
      },
    ],
  };
  if (intent.category?.trim()) {
    productSet.productType = intent.category.trim();
  }
  if (intent.imageUrls.length > 0) {
    productSet.files = intent.imageUrls.slice(0, 20).map((url, index) => ({
      originalSource: url,
      alt: `${intent.title} image ${index + 1}`,
      filename: filenameFromUrl(url, `dropship-${input.productVariantId}-${index + 1}.jpg`),
      contentType: "IMAGE",
    }));
  }
  return productSet;
}

function centsToDecimalString(cents: number): string {
  const normalized = Math.trunc(cents);
  const sign = normalized < 0 ? "-" : "";
  const absolute = Math.abs(normalized);
  const whole = Math.floor(absolute / 100);
  const fractional = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${fractional}`;
}

function stringFromConfig(config: Record<string, unknown>, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function filenameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const filename = parsed.pathname.split("/").filter(Boolean).pop();
    return filename?.trim() || fallback;
  } catch {
    return fallback;
  }
}
