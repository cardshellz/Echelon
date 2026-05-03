import { DropshipError } from "../domain/errors";
import { normalizeShopifyShopDomain } from "../domain/store-connection";
import type { DropshipStoreConnectionPostConnectProvider } from "../application/dropship-store-connection-service";

type FetchLike = typeof fetch;

type ShopifyWebhookTopic = "ORDERS_CREATE" | "ORDERS_PAID";

interface ShopifyWebhookSubscriptionConfig {
  apiVersion: string;
  publicBaseUrl: string | null;
}

interface ShopifyWebhookSubscriptionDefinition {
  topic: ShopifyWebhookTopic;
  path: string;
}

interface ShopifyGraphqlResponse<TData> {
  data?: TData;
  errors?: Array<{
    message?: string;
    extensions?: Record<string, unknown>;
  }>;
}

interface ShopifyWebhookSubscriptionsData {
  webhookSubscriptions?: {
    nodes?: Array<{
      id?: string;
      topic?: string;
      uri?: string | null;
    }>;
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    } | null;
  } | null;
}

interface ShopifyWebhookSubscriptionCreateData {
  webhookSubscriptionCreate?: {
    webhookSubscription?: {
      id?: string;
      topic?: string;
      uri?: string | null;
    } | null;
    userErrors?: ShopifyUserError[];
  } | null;
}

interface ShopifyUserError {
  field?: string[] | null;
  message?: string;
}

const DEFAULT_SHOPIFY_GRAPHQL_API_VERSION = "2026-04";
const SHOPIFY_MAX_ATTEMPTS = 3;
const SHOPIFY_WEBHOOK_SUBSCRIPTION_PAGE_SIZE = 100;
const SHOPIFY_WEBHOOK_SUBSCRIPTION_MAX_PAGES = 10;

const SHOPIFY_DROPSHIP_WEBHOOK_SUBSCRIPTIONS = [
  {
    topic: "ORDERS_CREATE",
    path: "/api/dropship/webhooks/shopify/orders/create",
  },
  {
    topic: "ORDERS_PAID",
    path: "/api/dropship/webhooks/shopify/orders/paid",
  },
] as const satisfies readonly ShopifyWebhookSubscriptionDefinition[];

export class ShopifyDropshipWebhookSubscriptionProvider implements DropshipStoreConnectionPostConnectProvider {
  private readonly config: ShopifyWebhookSubscriptionConfig;
  private readonly fetchImpl: FetchLike;

  constructor(
    config: ShopifyWebhookSubscriptionConfig,
    fetchImpl: FetchLike = fetch,
  ) {
    this.config = {
      ...config,
      apiVersion: assertShopifyApiVersion(config.apiVersion),
    };
    this.fetchImpl = fetchImpl;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ShopifyDropshipWebhookSubscriptionProvider {
    return new ShopifyDropshipWebhookSubscriptionProvider({
      apiVersion: resolveShopifyApiVersion(env),
      publicBaseUrl: resolveShopifyWebhookBaseUrl(env),
    });
  }

  async afterStoreConnected(
    input: Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0],
  ): Promise<void> {
    if (input.platform !== "shopify") {
      return;
    }
    if (!input.accessToken.trim()) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_WEBHOOK_ACCESS_TOKEN_REQUIRED",
        "Shopify webhook subscription setup requires an access token.",
        { storeConnectionId: input.storeConnectionId, retryable: false },
      );
    }
    const shopDomain = normalizeShopifyShopDomain(input.shopDomain ?? "");
    const publicBaseUrl = assertPublicWebhookBaseUrl(this.config.publicBaseUrl);
    const expectedSubscriptions = SHOPIFY_DROPSHIP_WEBHOOK_SUBSCRIPTIONS.map((subscription) => ({
      topic: subscription.topic,
      uri: buildWebhookUri(publicBaseUrl, subscription.path),
    }));
    const existingSubscriptions = await this.listExistingSubscriptions({
      shopDomain,
      accessToken: input.accessToken,
      topics: expectedSubscriptions.map((subscription) => subscription.topic),
    });

    for (const subscription of expectedSubscriptions) {
      if (hasExistingSubscription(existingSubscriptions, subscription)) {
        continue;
      }
      await this.createSubscription({
        shopDomain,
        accessToken: input.accessToken,
        topic: subscription.topic,
        uri: subscription.uri,
      });
    }
  }

  private async listExistingSubscriptions(input: {
    shopDomain: string;
    accessToken: string;
    topics: ShopifyWebhookTopic[];
  }): Promise<Array<{ id: string; topic: string; uri: string }>> {
    const subscriptions: Array<{ id: string; topic: string; uri: string }> = [];
    let after: string | null = null;

    for (let page = 1; page <= SHOPIFY_WEBHOOK_SUBSCRIPTION_MAX_PAGES; page++) {
      const response: ShopifyGraphqlResponse<ShopifyWebhookSubscriptionsData> = await this.callGraphql<ShopifyWebhookSubscriptionsData>({
        shopDomain: input.shopDomain,
        accessToken: input.accessToken,
        payload: {
          query: WEBHOOK_SUBSCRIPTIONS_QUERY,
          variables: {
            first: SHOPIFY_WEBHOOK_SUBSCRIPTION_PAGE_SIZE,
            after,
            topics: input.topics,
          },
        },
      });
      const connection: ShopifyWebhookSubscriptionsData["webhookSubscriptions"] = response.data?.webhookSubscriptions;
      for (const node of connection?.nodes ?? []) {
        if (node.id && node.topic && node.uri) {
          subscriptions.push({
            id: node.id,
            topic: node.topic,
            uri: node.uri,
          });
        }
      }

      if (!connection?.pageInfo?.hasNextPage) {
        return subscriptions;
      }
      after = connection.pageInfo.endCursor ?? null;
      if (!after) {
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_PAGINATION_INVALID",
          "Shopify webhook subscription pagination did not return the next cursor.",
          { shopDomain: input.shopDomain, retryable: true },
        );
      }
    }

    throw new DropshipError(
      "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_PAGE_LIMIT_EXCEEDED",
      "Shopify webhook subscription setup exceeded the pagination guard.",
      { shopDomain: input.shopDomain, retryable: true },
    );
  }

  private async createSubscription(input: {
    shopDomain: string;
    accessToken: string;
    topic: ShopifyWebhookTopic;
    uri: string;
  }): Promise<void> {
    const response = await this.callGraphql<ShopifyWebhookSubscriptionCreateData>({
      shopDomain: input.shopDomain,
      accessToken: input.accessToken,
      payload: {
        query: WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
        variables: {
          topic: input.topic,
          webhookSubscription: {
            uri: input.uri,
          },
        },
      },
    });
    const result = response.data?.webhookSubscriptionCreate;
    const userErrors = result?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_REJECTED",
        "Shopify rejected the webhook subscription.",
        { topic: input.topic, uri: input.uri, userErrors, retryable: false },
      );
    }
    if (!result?.webhookSubscription?.id) {
      throw new DropshipError(
        "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_MISSING_ID",
        "Shopify webhook subscription setup did not return a subscription id.",
        { topic: input.topic, uri: input.uri, retryable: true },
      );
    }
  }

  private async callGraphql<TData>(input: {
    shopDomain: string;
    accessToken: string;
    payload: {
      query: string;
      variables: Record<string, unknown>;
    };
  }): Promise<ShopifyGraphqlResponse<TData>> {
    for (let attempt = 1; attempt <= SHOPIFY_MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(`https://${input.shopDomain}/admin/api/${this.config.apiVersion}/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": input.accessToken,
          },
          body: JSON.stringify(input.payload),
        });
      } catch (error) {
        if (attempt < SHOPIFY_MAX_ATTEMPTS) {
          await delay(resolveRetryDelayMs(null, attempt));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_NETWORK_ERROR",
          "Shopify webhook subscription setup failed before receiving an HTTP response.",
          { retryable: true, cause: formatUnknownError(error) },
        );
      }

      const text = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < SHOPIFY_MAX_ATTEMPTS) {
          await delay(resolveRetryDelayMs(response, attempt));
          continue;
        }
        throw new DropshipError(
          "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_HTTP_ERROR",
          `Shopify webhook subscription setup failed with HTTP ${response.status}.`,
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
          "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_GRAPHQL_ERROR",
          "Shopify webhook subscription setup failed with GraphQL errors.",
          { retryable: false, errors: parsed.errors },
        );
      }
      return parsed;
    }

    throw new DropshipError(
      "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_RETRY_EXHAUSTED",
      "Shopify webhook subscription setup retry attempts were exhausted.",
      { retryable: true },
    );
  }
}

export function resolveShopifyWebhookBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return [
    env.DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL,
    env.DROPSHIP_PUBLIC_BASE_URL,
    env.DROPSHIP_API_BASE_URL,
    env.APP_BASE_URL,
    env.PUBLIC_APP_URL,
  ].map((value) => value?.trim()).find((value): value is string => Boolean(value)) ?? null;
}

export function assertPublicWebhookBaseUrl(value: string | null): string {
  if (!value) {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL_REQUIRED",
      "Shopify webhook subscription setup requires a public HTTPS base URL.",
      {
        env: [
          "DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL",
          "DROPSHIP_PUBLIC_BASE_URL",
          "DROPSHIP_API_BASE_URL",
          "APP_BASE_URL",
          "PUBLIC_APP_URL",
        ],
        retryable: false,
      },
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL_INVALID",
      "Shopify webhook subscription base URL must be a valid HTTPS URL.",
      { value, retryable: false },
    );
  }
  if (url.protocol !== "https:") {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL_INVALID",
      "Shopify webhook subscription base URL must use HTTPS.",
      { value, retryable: false },
    );
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function resolveShopifyApiVersion(env: NodeJS.ProcessEnv): string {
  const configured = env.DROPSHIP_SHOPIFY_GRAPHQL_API_VERSION
    ?? env.SHOPIFY_API_VERSION
    ?? DEFAULT_SHOPIFY_GRAPHQL_API_VERSION;
  return assertShopifyApiVersion(configured);
}

function assertShopifyApiVersion(value: string): string {
  const configured = value.trim();
  if (!/^\d{4}-\d{2}$/.test(configured)) {
    throw new DropshipError("DROPSHIP_SHOPIFY_API_VERSION_INVALID", "Shopify API version is invalid.", {
      apiVersion: configured,
      retryable: false,
    });
  }
  return configured;
}

function buildWebhookUri(publicBaseUrl: string, path: string): string {
  return new URL(path, publicBaseUrl).toString();
}

function hasExistingSubscription(
  existingSubscriptions: Array<{ topic: string; uri: string }>,
  expectedSubscription: { topic: ShopifyWebhookTopic; uri: string },
): boolean {
  const expectedUri = normalizeWebhookUri(expectedSubscription.uri);
  return existingSubscriptions.some((subscription) => (
    subscription.topic === expectedSubscription.topic
      && normalizeWebhookUri(subscription.uri) === expectedUri
  ));
}

function normalizeWebhookUri(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function parseShopifyGraphqlResponse<TData>(text: string): ShopifyGraphqlResponse<TData> {
  if (!text) return {};
  try {
    return JSON.parse(text) as ShopifyGraphqlResponse<TData>;
  } catch {
    throw new DropshipError(
      "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_INVALID_RESPONSE",
      "Shopify webhook subscription setup returned invalid JSON.",
      { retryable: true },
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

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const WEBHOOK_SUBSCRIPTIONS_QUERY = `
query DropshipShopifyWebhookSubscriptions(
  $first: Int!
  $after: String
  $topics: [WebhookSubscriptionTopic!]
) {
  webhookSubscriptions(first: $first, after: $after, topics: $topics) {
    nodes {
      id
      topic
      uri
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `
mutation DropshipShopifyWebhookSubscriptionCreate(
  $topic: WebhookSubscriptionTopic!
  $webhookSubscription: WebhookSubscriptionInput!
) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription {
      id
      topic
      uri
    }
    userErrors {
      field
      message
    }
  }
}
`;
