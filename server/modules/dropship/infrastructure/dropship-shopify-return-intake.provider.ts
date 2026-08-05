import { DropshipError } from "../domain/errors";
import type {
  DropshipReturnIntakeFetchResult,
  DropshipReturnIntakeProvider,
  DropshipReturnIntakeStoreConnection,
} from "../application/dropship-return-intake-provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import {
  buildShopifyReturnIntakeDraft,
  shouldRecordShopifyReturn,
  type ShopifyReturnNode,
} from "./dropship-shopify-return-intake.mapper";

/**
 * Shopify return-intake provider (design spec D2a): polls the Admin GraphQL
 * API `returns` query on one connected store and maps each return to a
 * normalized draft. Read-only — all persistence lives in the poll service /
 * intake service.
 *
 * Label cost: present when the vendor bought the return label via Shopify
 * Shipping (reverseFulfillmentOrders.label.cost); null otherwise. The return
 * EVENT is always captured regardless (D2a).
 */

type FetchLike = typeof fetch;

interface Clock {
  now(): Date;
}

interface ShopifyGraphqlResponse<TData> {
  data?: TData;
  errors?: Array<{
    message?: string;
    extensions?: Record<string, unknown>;
  }>;
}

interface ShopifyReturnsQueryData {
  returns?: {
    nodes?: ShopifyReturnNode[];
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    } | null;
  } | null;
}

const DEFAULT_SHOPIFY_GRAPHQL_API_VERSION = "2026-01";
const SHOPIFY_MAX_ATTEMPTS = 3;
const SHOPIFY_PAGE_SIZE = 50;

const SHOPIFY_RETURNS_QUERY = `
query DropshipReturnIntake($first: Int!, $after: String, $query: String!) {
  returns(first: $first, after: $after, query: $query) {
    nodes {
      id
      name
      status
      createdAt
      order {
        id
        legacyResourceId
        name
      }
      returnLineItems(first: 100) {
        nodes {
          id
          quantity
          returnReason
          returnReasonNote
          fulfillmentLineItem {
            lineItem {
              id
              sku
            }
          }
        }
      }
      reverseFulfillmentOrders(first: 10) {
        nodes {
          id
          status
          label {
            cost {
              amount
              currencyCode
            }
            trackingNumber
            trackingUrl
          }
          deliverable {
            tracking {
              number
              carrierName
              url
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

export class ShopifyDropshipReturnIntakeProvider implements DropshipReturnIntakeProvider {
  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  async fetchReturns(input: {
    connection: DropshipReturnIntakeStoreConnection;
    since: Date;
    until: Date;
  }): Promise<DropshipReturnIntakeFetchResult> {
    const credential = await this.credentials.loadForStoreConnection({
      vendorId: input.connection.vendorId,
      storeConnectionId: input.connection.storeConnectionId,
      platform: "shopify",
    });
    assertShopifyCredential(credential);
    const apiVersion = resolveShopifyApiVersion(credential.config);

    const returnNodes = await this.fetchAllReturns({
      credential,
      apiVersion,
      since: input.since,
      until: input.until,
    });

    const result: DropshipReturnIntakeFetchResult = { drafts: [], ignored: 0 };
    for (const returnNode of returnNodes) {
      const decision = shouldRecordShopifyReturn({ returnNode });
      if (!decision.record) {
        result.ignored += 1;
        continue;
      }
      result.drafts.push(buildShopifyReturnIntakeDraft({ returnNode }));
    }
    return result;
  }

  private async fetchAllReturns(input: {
    credential: DropshipMarketplaceStoreCredentials;
    apiVersion: string;
    since: Date;
    until: Date;
  }): Promise<ShopifyReturnNode[]> {
    const nodes: ShopifyReturnNode[] = [];
    let after: string | null = null;
    // Shopify search query syntax: created_at:>=... AND created_at:<=...
    const query = `created_at:>=${input.since.toISOString()} AND created_at:<=${input.until.toISOString()}`;
    while (true) {
      const response: ShopifyGraphqlResponse<ShopifyReturnsQueryData> = await this.callGraphql<ShopifyReturnsQueryData>(input.credential, input.apiVersion, {
        query: SHOPIFY_RETURNS_QUERY,
        variables: {
          first: SHOPIFY_PAGE_SIZE,
          after,
          query,
        },
      });
      const page: ShopifyReturnsQueryData["returns"] = response.data?.returns;
      const pageNodes = Array.isArray(page?.nodes) ? page.nodes : [];
      nodes.push(...pageNodes);
      if (!page?.pageInfo?.hasNextPage || pageNodes.length === 0) {
        break;
      }
      after = page.pageInfo.endCursor ?? null;
      if (!after) break;
    }
    return nodes;
  }

  private async callGraphql<TData>(
    credential: DropshipMarketplaceStoreCredentials,
    apiVersion: string,
    payload: {
      query: string;
      variables: Record<string, unknown>;
    },
  ): Promise<ShopifyGraphqlResponse<TData>> {
    for (let attempt = 1; attempt <= SHOPIFY_MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(
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
      } catch (error) {
        if (attempt < SHOPIFY_MAX_ATTEMPTS) {
          await delay(resolveRetryDelayMs(null, attempt));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_RETURN_INTAKE_NETWORK_ERROR",
          "Shopify return intake failed before receiving an HTTP response.",
          {
            retryable: true,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }

      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (isPermanentAuthFailureStatus(response.status)) {
          await this.credentials.recordAuthFailure?.({
            vendorId: credential.vendorId,
            storeConnectionId: credential.storeConnectionId,
            platform: "shopify",
            status: "needs_reauth",
            failureCode: "DROPSHIP_SHOPIFY_RETURN_INTAKE_HTTP_ERROR",
            message: `Shopify return intake failed with HTTP ${response.status}.`,
            retryable: false,
            statusCode: response.status,
            now: this.clock.now(),
          });
        }
        if (retryable && attempt < SHOPIFY_MAX_ATTEMPTS) {
          await delay(resolveRetryDelayMs(response, attempt));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_RETURN_INTAKE_HTTP_ERROR",
          `Shopify return intake failed with HTTP ${response.status}.`,
          {
            retryable,
            status: response.status,
            body: text.slice(0, 1000),
          },
        );
      }

      const parsed = parseShopifyGraphqlResponse<TData>(text);
      if (parsed.errors?.length) {
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_RETURN_INTAKE_GRAPHQL_ERROR",
          "Shopify return intake failed with GraphQL errors.",
          { retryable: false, errors: parsed.errors },
        );
      }
      return parsed;
    }

    throw new DropshipError(
      "DROPSHIP_SHOPIFY_RETURN_INTAKE_RETRY_EXHAUSTED",
      "Shopify return intake retry attempts were exhausted.",
      { retryable: true },
    );
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

function isPermanentAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function resolveShopifyApiVersion(config: Record<string, unknown>): string {
  const fromConfig = config.apiVersion;
  const configured = (typeof fromConfig === "string" && fromConfig.trim() ? fromConfig.trim() : null)
    ?? process.env.DROPSHIP_SHOPIFY_GRAPHQL_API_VERSION
    ?? process.env.SHOPIFY_API_VERSION
    ?? DEFAULT_SHOPIFY_GRAPHQL_API_VERSION;
  if (!/^\d{4}-\d{2}$/.test(configured)) {
    throw new DropshipError("DROPSHIP_SHOPIFY_API_VERSION_INVALID", "Shopify API version is invalid.", {
      configured,
      retryable: false,
    });
  }
  return configured;
}

function parseShopifyGraphqlResponse<TData>(text: string): ShopifyGraphqlResponse<TData> {
  try {
    return JSON.parse(text) as ShopifyGraphqlResponse<TData>;
  } catch {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_RETURN_INTAKE_INVALID_RESPONSE",
      "Shopify return intake returned invalid JSON.",
      { body: text.slice(0, 1000), retryable: true },
    );
  }
}

function resolveRetryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
