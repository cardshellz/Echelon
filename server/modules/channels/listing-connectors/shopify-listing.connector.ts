import type {
  ChannelListingPayload,
  ListingPushResult,
} from "../channel-adapter.interface";

export interface ShopifyListingCredentials {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
}

export interface ShopifyProductSetResult {
  status: "created" | "updated";
  externalListingId: string;
  externalOfferId: string | null;
  rawResult: Record<string, unknown>;
}

interface ShopifyMarketplaceListingConnectorOptions {
  fetchImpl?: typeof fetch;
  delay?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

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

export class ShopifyListingConnectorHttpError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ShopifyListingConnectorHttpError";
    this.retryable = status === 429 || status >= 500;
  }
}

export class ShopifyListingConnectorGraphqlError extends Error {
  constructor(readonly errors: NonNullable<ShopifyGraphqlResponse["errors"]>) {
    super("Shopify listing push failed with GraphQL errors.");
    this.name = "ShopifyListingConnectorGraphqlError";
  }
}

export class ShopifyListingConnectorUserError extends Error {
  constructor(readonly userErrors: NonNullable<NonNullable<ShopifyGraphqlResponse["data"]>["productSet"]>["userErrors"]) {
    super("Shopify rejected the listing push.");
    this.name = "ShopifyListingConnectorUserError";
  }
}

export class ShopifyListingConnectorInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyListingConnectorInvalidResponseError";
  }
}

export class ShopifyMarketplaceListingConnector {
  private readonly fetchImpl: typeof fetch;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(options: ShopifyMarketplaceListingConnectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 3;
  }

  async pushChannelListing(input: {
    credentials: ShopifyListingCredentials;
    listing: ChannelListingPayload;
  }): Promise<ListingPushResult> {
    const payload = buildRestProductPayload(input.listing);
    const hasExternalIds = input.listing.variants.some((v) => v.externalVariantId);

    if (hasExternalIds) {
      const existingVariant = input.listing.variants.find((v) => v.externalVariantId);
      if (!existingVariant?.externalVariantId) {
        return { productId: input.listing.productId, status: "error", error: "No external variant ID for update" };
      }

      const variantData = await this.shopifyRequest(
        input.credentials,
        "GET",
        `/variants/${existingVariant.externalVariantId}.json`,
      );
      const shopifyProductId = String(variantData?.variant?.product_id);

      if (!shopifyProductId) {
        return { productId: input.listing.productId, status: "error", error: "Could not resolve Shopify product ID" };
      }

      const updatePayload = { ...payload, id: Number(shopifyProductId) };
      delete (updatePayload as any).images;

      const response = await this.shopifyRequest(
        input.credentials,
        "PUT",
        `/products/${shopifyProductId}.json`,
        { product: updatePayload },
      );

      return {
        productId: input.listing.productId,
        status: "updated",
        externalProductId: shopifyProductId,
        externalVariantIds: mapShopifyVariantIds(input.listing, response?.product?.variants),
      };
    }

    const response = await this.shopifyRequest(
      input.credentials,
      "POST",
      "/products.json",
      { product: payload },
    );

    const shopifyProduct = response?.product;
    if (!shopifyProduct) {
      return { productId: input.listing.productId, status: "error", error: "No product in Shopify response" };
    }

    return {
      productId: input.listing.productId,
      status: "created",
      externalProductId: String(shopifyProduct.id),
      externalVariantIds: mapShopifyVariantIds(input.listing, shopifyProduct.variants),
    };
  }

  async pushProductSet(input: {
    credentials: ShopifyListingCredentials;
    productSet: Record<string, unknown>;
    existingExternalListingId: string | null;
    sku: string | null;
  }): Promise<ShopifyProductSetResult> {
    const identifier = input.existingExternalListingId
      ? { id: toShopifyProductGid(input.existingExternalListingId) }
      : undefined;

    const response = await this.callGraphql(input.credentials, {
      query: PRODUCT_SET_MUTATION,
      variables: {
        synchronous: true,
        productSet: input.productSet,
        identifier,
      },
    });
    const productSet = response.data?.productSet;
    const userErrors = productSet?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new ShopifyListingConnectorUserError(userErrors);
    }
    const productId = productSet?.product?.id;
    if (!productId) {
      throw new ShopifyListingConnectorInvalidResponseError("Shopify listing push did not return a product id.");
    }

    const variantId = productSet.product?.variants?.nodes?.find((variant) => {
      return input.sku ? variant.sku === input.sku : true;
    })?.id ?? productSet.product?.variants?.nodes?.[0]?.id ?? null;

    return {
      status: input.existingExternalListingId ? "updated" : "created",
      externalListingId: productId,
      externalOfferId: variantId,
      rawResult: {
        provider: "shopify",
        apiVersion: input.credentials.apiVersion,
        productId,
        variantId,
      },
    };
  }

  private async shopifyRequest(
    credentials: ShopifyListingCredentials,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const baseUrl = `https://${credentials.shopDomain}/admin/api/${credentials.apiVersion}`;
    const url = path.startsWith("/") ? `${baseUrl}${path}` : `${baseUrl}/${path}`;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          "X-Shopify-Access-Token": credentials.accessToken,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Retry-After") || "2", 10);
        await this.delay(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        if (attempt < this.maxRetries && response.status >= 500) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          await this.delay(backoff);
          continue;
        }
        throw new ShopifyListingConnectorHttpError(
          `Shopify API ${method} ${path} failed (${response.status}).`,
          response.status,
          errorBody,
        );
      }

      return response.json();
    }

    throw new ShopifyListingConnectorHttpError(
      `Shopify API ${method} ${path} failed after ${this.maxRetries} retries.`,
      503,
      "",
    );
  }

  private async callGraphql(
    credentials: ShopifyListingCredentials,
    payload: {
      query: string;
      variables: Record<string, unknown>;
    },
  ): Promise<ShopifyGraphqlResponse> {
    const response = await this.fetchImpl(
      `https://${credentials.shopDomain}/admin/api/${credentials.apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": credentials.accessToken,
        },
        body: JSON.stringify(payload),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new ShopifyListingConnectorHttpError(
        `Shopify listing push failed with HTTP ${response.status}.`,
        response.status,
        text.slice(0, 1000),
      );
    }

    const parsed = parseShopifyGraphqlResponse(text);
    if (parsed.errors?.length) {
      throw new ShopifyListingConnectorGraphqlError(parsed.errors);
    }
    return parsed;
  }
}

function buildRestProductPayload(listing: ChannelListingPayload): Record<string, unknown> {
  const variants = listing.variants
    .filter((v) => v.isListed)
    .map((v) => {
      const variant: Record<string, unknown> = {
        sku: v.sku,
        title: v.name,
        barcode: v.barcode || v.gtin,
      };
      if (v.priceCents != null) {
        variant.price = centsToDecimalString(v.priceCents);
      }
      if (v.compareAtPriceCents != null) {
        variant.compare_at_price = centsToDecimalString(v.compareAtPriceCents);
      }
      if (v.weightGrams != null) {
        variant.weight = v.weightGrams;
        variant.weight_unit = "g";
      }
      if (v.externalVariantId) {
        variant.id = Number(v.externalVariantId);
      }
      return variant;
    });

  const images = listing.images.map((img) => {
    const image: Record<string, unknown> = {
      src: img.url,
      position: img.position + 1,
    };
    if (img.altText) image.alt = img.altText;
    return image;
  });

  return {
    title: listing.title,
    body_html: listing.description || "",
    product_type: listing.category || "",
    tags: listing.tags?.join(", ") || "",
    variants,
    images,
  };
}

function mapShopifyVariantIds(
  listing: ChannelListingPayload,
  shopifyVariants: Array<{ id?: number | string; sku?: string | null }> | undefined,
): Record<number, string> {
  const variantIdMap: Record<number, string> = {};
  for (const variant of listing.variants) {
    const shopifyVariant = shopifyVariants?.find((candidate) => candidate.sku === variant.sku);
    if (shopifyVariant?.id != null) {
      variantIdMap[variant.variantId] = String(shopifyVariant.id);
    }
  }
  return variantIdMap;
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

function parseShopifyGraphqlResponse(text: string): ShopifyGraphqlResponse {
  if (!text) return {};
  try {
    return JSON.parse(text) as ShopifyGraphqlResponse;
  } catch {
    throw new ShopifyListingConnectorInvalidResponseError("Shopify listing push returned invalid JSON.");
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
