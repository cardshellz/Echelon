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

type FetchLike = typeof fetch;

interface ShopifyGraphqlResponse {
  data?: {
    productSet?: {
      product?: {
        id?: string;
        variants?: {
          nodes?: Array<{
            id?: string;
            sku?: string | null;
            title?: string | null;
          }>;
        };
      } | null;
      userErrors?: Array<{
        code?: string;
        field?: string[] | null;
        message?: string;
      }>;
    };
  };
  errors?: Array<{
    message?: string;
    extensions?: Record<string, unknown>;
  }>;
}

const DEFAULT_SHOPIFY_GRAPHQL_API_VERSION = "2026-04";

export class ShopifyDropshipListingPushProvider implements DropshipMarketplaceListingPushProvider {
  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async pushListing(input: DropshipMarketplaceListingPushRequest): Promise<DropshipMarketplaceListingPushResult> {
    const credential = await this.credentials.loadForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: "shopify",
    });
    assertShopifyCredential(credential);

    const apiVersion = resolveShopifyApiVersion(credential);
    const productSetInput = buildShopifyProductSetInput(input);
    const identifier = input.existingExternalListingId
      ? { id: toShopifyProductGid(input.existingExternalListingId) }
      : undefined;
    const response = await this.callGraphql(credential, apiVersion, {
      query: PRODUCT_SET_MUTATION,
      variables: {
        synchronous: true,
        productSet: productSetInput,
        identifier,
      },
    });
    const productSet = response.data?.productSet;
    const userErrors = productSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_LISTING_PUSH_REJECTED",
        "Shopify rejected the listing push.",
        {
          retryable: false,
          userErrors,
        },
      );
    }
    const productId = productSet?.product?.id;
    if (!productId) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_LISTING_PUSH_MISSING_PRODUCT",
        "Shopify listing push did not return a product id.",
        { retryable: true },
      );
    }

    const variantId = productSet.product?.variants?.nodes?.find((variant) => {
      return input.listingIntent.sku ? variant.sku === input.listingIntent.sku : true;
    })?.id ?? productSet.product?.variants?.nodes?.[0]?.id ?? null;

    return {
      status: input.existingExternalListingId ? "updated" : "created",
      externalListingId: productId,
      externalOfferId: variantId,
      rawResult: {
        provider: "shopify",
        apiVersion,
        productId,
        variantId,
      },
    };
  }

  private async callGraphql(
    credential: DropshipMarketplaceStoreCredentials,
    apiVersion: string,
    payload: {
      query: string;
      variables: Record<string, unknown>;
    },
  ): Promise<ShopifyGraphqlResponse> {
    const response = await this.fetchImpl(
      `https://${credential.shopDomain}/admin/api/${apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": credential.accessToken,
        },
        body: JSON.stringify(payload),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_LISTING_PUSH_HTTP_ERROR",
        `Shopify listing push failed with HTTP ${response.status}.`,
        {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          body: text.slice(0, 1000),
        },
      );
    }

    const parsed = parseShopifyGraphqlResponse(text);
    if (parsed.errors?.length) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_LISTING_PUSH_GRAPHQL_ERROR",
        "Shopify listing push failed with GraphQL errors.",
        {
          retryable: false,
          errors: parsed.errors,
        },
      );
    }
    return parsed;
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

function toShopifyProductGid(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("gid://shopify/Product/")
    ? trimmed
    : `gid://shopify/Product/${trimmed}`;
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

function parseShopifyGraphqlResponse(text: string): ShopifyGraphqlResponse {
  if (!text) return {};
  try {
    return JSON.parse(text) as ShopifyGraphqlResponse;
  } catch {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_LISTING_PUSH_INVALID_RESPONSE",
      "Shopify listing push returned invalid JSON.",
      { retryable: true },
    );
  }
}

const PRODUCT_SET_MUTATION = `
mutation DropshipProductSet($productSet: ProductSetInput!, $synchronous: Boolean!, $identifier: ProductSetIdentifiers) {
  productSet(synchronous: $synchronous, input: $productSet, identifier: $identifier) {
    product {
      id
      variants(first: 10) {
        nodes {
          id
          sku
          title
        }
      }
    }
    userErrors {
      code
      field
      message
    }
  }
}
`;
