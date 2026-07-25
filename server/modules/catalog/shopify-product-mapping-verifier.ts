import { normalizeShopifyId } from "./shopify-product-mapping.domain";
import type {
  ShopifyRemoteProductSnapshot,
} from "./shopify-product-mapping-reconciliation.domain";
import {
  normalizeShopifyAdminDomain,
} from "./shopify-product-mapping-reconciliation.domain";

const GRAPHQL_BATCH_SIZE = 100;
const GRAPHQL_MAX_ATTEMPTS = 3;
const GRAPHQL_RETRY_BASE_DELAY_MS = 1_000;
const SHOPIFY_REQUEST_TIMEOUT_MS = 10_000;

const MAPPING_NODES_QUERY = /* GraphQL */ `
  query ProductMappingNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id
        title
        status
        shippingGroup: metafield(
          namespace: "cardshellz"
          key: "shipping_group"
        ) {
          value
        }
      }
      ... on ProductVariant {
        id
        product {
          id
        }
      }
    }
  }
`;

export interface ShopifyMappingCredentials {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
}

interface ShopifyGraphqlNode {
  __typename?: string;
  id?: string;
  title?: string | null;
  status?: string | null;
  shippingGroup?: {
    value?: string | null;
  } | null;
  product?: {
    id?: string;
  } | null;
}

interface ShopifyGraphqlPayload {
  data?: {
    nodes?: Array<ShopifyGraphqlNode | null>;
  };
  errors?: Array<{
    message?: string;
    extensions?: {
      code?: string;
    };
  }>;
}

export class ShopifyMappingVerificationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShopifyMappingVerificationError";
  }
}

export interface ShopifyProductMappingVerifier {
  lookupProducts(
    credentials: ShopifyMappingCredentials,
    productIds: string[],
  ): Promise<Map<string, ShopifyRemoteProductSnapshot>>;
  verifyProductAndVariants(
    credentials: ShopifyMappingCredentials,
    productId: string,
    variantIds: string[],
  ): Promise<{
    remoteProductExists: boolean;
    liveVariantIds: string[];
  }>;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function normalizeRemoteShippingGroup(value: string | null | undefined):
  string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "null") return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed === null) return null;
  } catch {
    // Plain-text metafield values are already canonical strings.
  }
  return trimmed;
}

function productGid(productId: string): string {
  return `gid://shopify/Product/${productId}`;
}

function variantGid(variantId: string): string {
  return `gid://shopify/ProductVariant/${variantId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number): number {
  return GRAPHQL_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
}

function responseErrorBody(value: string): string {
  return value.slice(0, 500);
}

export function createShopifyProductMappingVerifier(input: {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
} = {}): ShopifyProductMappingVerifier {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? delay;

  async function requestNodes(
    credentials: ShopifyMappingCredentials,
    ids: string[],
  ): Promise<Array<ShopifyGraphqlNode | null>> {
    const domain = normalizeShopifyAdminDomain(credentials.shopDomain);
    if (!domain) {
      throw new ShopifyMappingVerificationError(
        "SHOPIFY_MAPPING_SHOP_DOMAIN_INVALID",
        "Shopify mapping verification requires a valid myshopify.com domain",
        500,
      );
    }
    const url = `https://${domain}/admin/api/${credentials.apiVersion}/graphql.json`;

    for (let attempt = 1; attempt <= GRAPHQL_MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": credentials.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: MAPPING_NODES_QUERY,
            variables: { ids },
          }),
          signal: AbortSignal.timeout(SHOPIFY_REQUEST_TIMEOUT_MS),
        });
      } catch (error: unknown) {
        if (attempt < GRAPHQL_MAX_ATTEMPTS) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw new ShopifyMappingVerificationError(
          "SHOPIFY_MAPPING_LOOKUP_FAILED",
          "Shopify mapping verification could not reach Shopify",
          502,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }

      if (response.status === 429) {
        if (attempt < GRAPHQL_MAX_ATTEMPTS) {
          const retryAfterSeconds = Math.min(
            30,
            Math.max(1, Number(response.headers.get("Retry-After") ?? 2) || 2),
          );
          await sleep(retryAfterSeconds * 1_000);
          continue;
        }
        throw new ShopifyMappingVerificationError(
          "SHOPIFY_MAPPING_LOOKUP_RATE_LIMITED",
          "Shopify mapping verification remained rate limited",
          503,
        );
      }

      const responseText = await response.text();
      if (!response.ok) {
        if (response.status >= 500 && attempt < GRAPHQL_MAX_ATTEMPTS) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw new ShopifyMappingVerificationError(
          "SHOPIFY_MAPPING_LOOKUP_FAILED",
          `Shopify mapping verification failed with HTTP ${response.status}`,
          502,
          {
            responseStatus: response.status,
            responseBody: responseErrorBody(responseText),
          },
        );
      }

      let payload: ShopifyGraphqlPayload;
      try {
        payload = JSON.parse(responseText) as ShopifyGraphqlPayload;
      } catch (error: unknown) {
        throw new ShopifyMappingVerificationError(
          "SHOPIFY_MAPPING_RESPONSE_INVALID",
          "Shopify returned invalid JSON during mapping verification",
          502,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }

      if (payload.errors?.length) {
        const throttled = payload.errors.some(
          (error) => error.extensions?.code === "THROTTLED",
        );
        if (throttled && attempt < GRAPHQL_MAX_ATTEMPTS) {
          await sleep(retryDelayMs(attempt));
          continue;
        }
        throw new ShopifyMappingVerificationError(
          throttled
            ? "SHOPIFY_MAPPING_LOOKUP_RATE_LIMITED"
            : "SHOPIFY_MAPPING_GRAPHQL_ERROR",
          "Shopify returned GraphQL errors during mapping verification",
          throttled ? 503 : 502,
          {
            errors: payload.errors.map((error) =>
              error.message ?? "Unknown Shopify GraphQL error"),
          },
        );
      }

      const nodes = payload.data?.nodes;
      if (!Array.isArray(nodes) || nodes.length !== ids.length) {
        throw new ShopifyMappingVerificationError(
          "SHOPIFY_MAPPING_RESPONSE_INVALID",
          "Shopify returned an incomplete mapping-verification response",
          502,
          { requestedNodeCount: ids.length, returnedNodeCount: nodes?.length },
        );
      }
      return nodes;
    }

    throw new ShopifyMappingVerificationError(
      "SHOPIFY_MAPPING_LOOKUP_FAILED",
      "Shopify mapping verification exhausted all attempts",
      502,
    );
  }

  async function lookupProducts(
    credentials: ShopifyMappingCredentials,
    productIds: string[],
  ): Promise<Map<string, ShopifyRemoteProductSnapshot>> {
    const uniqueProductIds = [...new Set(productIds)].sort((left, right) =>
      left.localeCompare(right, "en", { numeric: true }));
    const result = new Map<string, ShopifyRemoteProductSnapshot>();

    for (let index = 0; index < uniqueProductIds.length; index += GRAPHQL_BATCH_SIZE) {
      const batch = uniqueProductIds.slice(index, index + GRAPHQL_BATCH_SIZE);
      const nodes = await requestNodes(
        credentials,
        batch.map(productGid),
      );

      nodes.forEach((node, nodeIndex) => {
        const requestedProductId = batch[nodeIndex];
        if (node === null) {
          result.set(requestedProductId, {
            productId: requestedProductId,
            exists: false,
            title: null,
            status: null,
            shippingGroupCode: null,
          });
          return;
        }

        const returnedProductId = normalizeShopifyId(node.id);
        if (
          node.__typename !== "Product"
          || returnedProductId !== requestedProductId
        ) {
          throw new ShopifyMappingVerificationError(
            "SHOPIFY_MAPPING_RESPONSE_INVALID",
            "Shopify returned an unexpected node for a product mapping",
            502,
            {
              requestedProductId,
              returnedType: node.__typename ?? null,
              returnedProductId,
            },
          );
        }

        result.set(requestedProductId, {
          productId: requestedProductId,
          exists: true,
          title: node.title?.trim() || null,
          status: node.status?.trim() || null,
          shippingGroupCode: normalizeRemoteShippingGroup(
            node.shippingGroup?.value,
          ),
        });
      });
    }

    return result;
  }

  async function verifyProductAndVariants(
    credentials: ShopifyMappingCredentials,
    productId: string,
    variantIds: string[],
  ): Promise<{
    remoteProductExists: boolean;
    liveVariantIds: string[];
  }> {
    const uniqueVariantIds = [...new Set(variantIds)].sort((left, right) =>
      left.localeCompare(right, "en", { numeric: true }));
    const requestedNodes = [
      { kind: "product" as const, id: productId, gid: productGid(productId) },
      ...uniqueVariantIds.map((variantId) => ({
        kind: "variant" as const,
        id: variantId,
        gid: variantGid(variantId),
      })),
    ];
    let remoteProductExists = false;
    const liveVariantIds: string[] = [];

    for (let index = 0; index < requestedNodes.length; index += GRAPHQL_BATCH_SIZE) {
      const batch = requestedNodes.slice(index, index + GRAPHQL_BATCH_SIZE);
      const nodes = await requestNodes(
        credentials,
        batch.map((requested) => requested.gid),
      );

      nodes.forEach((node, nodeIndex) => {
        const requested = batch[nodeIndex];
        if (node === null) return;
        const returnedId = normalizeShopifyId(node.id);
        const expectedType = requested.kind === "product"
          ? "Product"
          : "ProductVariant";
        if (node.__typename !== expectedType || returnedId !== requested.id) {
          throw new ShopifyMappingVerificationError(
            "SHOPIFY_MAPPING_RESPONSE_INVALID",
            "Shopify returned an unexpected node while verifying retirement",
            502,
            {
              requestedKind: requested.kind,
              requestedId: requested.id,
              returnedType: node.__typename ?? null,
              returnedId,
            },
          );
        }
        if (requested.kind === "product") {
          remoteProductExists = true;
        } else {
          liveVariantIds.push(requested.id);
        }
      });
    }

    return { remoteProductExists, liveVariantIds };
  }

  return { lookupProducts, verifyProductAndVariants };
}
