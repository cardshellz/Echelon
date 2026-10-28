import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  STOCK_LINK_DECIMAL_ID_PATTERN, STOCK_LINK_LOOKUP_ITEMS_MAX, STOCK_LINK_LOOKUP_SKUS_MAX, STOCK_LINK_OBSERVE_ITEMS_MAX,
  STOCK_LINK_SKU_MAX_LENGTH, stockLinkDestinationSchema, stockLinkItemObservationSchema, stockLinkSkuLookupSchema,
  type StockLinkDestination, type StockLinkItemObservation, type StockLinkSkuLookup, type StockLinkStoreItem,
} from "@shared/types/stock-link";
import type { StockLinkAdapter, StockLinkProviderCallOptions } from "../../inventory-planning/application/stock-link.ports";
import { normalizeStockLinkSku } from "../../inventory-planning/domain/stock-link";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../../inventory-planning/domain/stock-link-errors";
import { ChannelIdentityError } from "../channel-identity.domain";
import type { ChannelIdentityService } from "../channel-identity.service";
import { PROVIDER_RETRY_AFTER_MAX_SECONDS, boundedProviderRetryAfterSeconds } from "../provider-request-limits";
import {
  isShopifyAdminGraphQLConnectionValid, requestShopifyAdminGraphQL, type ShopifyAdminGraphQLConnection,
  type ShopifyAdminGraphQLFailure, type ShopifyAdminGraphQLOperation, type ShopifyAdminGraphQLResponseMeta,
} from "./shopify-admin-graphql.core";

/**
 * The stock-link engine's Shopify adapter (channels PR2, PLAN-CH2 v4.1 §6.1): two read-only, batch provider reads of
 * one Card Shellz Shopify store, with that store's own login, for the engine in inventory planning
 * (IP/application/stock-link.ports.ts StockLinkAdapter):
 * - findItemsBySku: every store item whose SKU equals one of up to 50 Card Shellz SKUs, complete or not at all;
 * - observeItems: up to 100 saved items read by id (never through the search index); a deleted item is `null`.
 * It decides nothing: archived and draft copies are returned with their raw product status (only the engine decides
 * what is on sale, C10), and every refusal is thrown as a classified, destination-scoped error (SAF-9), never naming
 * one item. No retry inside: the engine's tick decides what happens next.
 */

/** Pinned, never the connection's own saved version (precedent shopify-order-edit.provider.ts ORDER_EDIT_SHOPIFY_API_VERSION). */
export const SHOPIFY_STOCK_LINK_API_VERSION = "2026-10";
/** One request's bound; the tick's own signal (its 30 s / 45 s budget) can stop it sooner. */
export const SHOPIFY_STOCK_LINK_REQUEST_TIMEOUT_MS = 15_000;
/** productVariants(first: 100) (§6.1, SAF-14): the shared per-store cost budget with fulfillment write-back. */
export const SHOPIFY_STOCK_LINK_PAGE_SIZE = 100;
/** At most 4 pages (400 items) per lookup, else STOCK_LINK_LOOKUP_INCOMPLETE: a partial result is never returned. */
export const SHOPIFY_STOCK_LINK_LOOKUP_PAGES_MAX = STOCK_LINK_LOOKUP_ITEMS_MAX / SHOPIFY_STOCK_LINK_PAGE_SIZE;
/**
 * Stop reading a store once its GraphQL cost bucket is below half full, so fulfillment write-back (same token, same
 * bucket: per app per store is a HYPOTHESIS, §6.1) keeps the other half. Not money: a ratio of Shopify's cost points.
 */
export const STOCK_LINK_COST_FLOOR_RATIO = 0.5;

const VARIANTS_BY_SKU_QUERY = `query StockLinkVariantsBySku($query: String!, $after: String) {
  productVariants(first: ${SHOPIFY_STOCK_LINK_PAGE_SIZE}, query: $query, after: $after) {
    nodes { sku inventoryItem { id } product { id status } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const INVENTORY_ITEMS_QUERY = `query StockLinkInventoryItems($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on InventoryItem { id sku variant { product { id status } } }
  }
}`;

/** GraphQL error codes a retry may pass; THROTTLED is its own outcome (the destination stops for the tick). */
const TRANSIENT_GRAPHQL_CODES: ReadonlySet<string> = new Set(["INTERNAL_SERVER_ERROR", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE"]);
const THROTTLED_GRAPHQL_CODE = "THROTTLED";
/** A provider code is copied into an error's context only when it looks like one (never provider prose). */
const LOGGABLE_PROVIDER_CODE = /^[A-Z0-9_]{1,64}$/;

const C = STOCK_LINK_ERROR_CODES;

/**
 * A Shopify read refusal (§6.1 ShopifyStockLinkProviderError {code, errorClass, scope, retryAfterMs}). It is a
 * StockLinkError, so its class is derived from the engine's own table for its code (domain/stock-link-errors.ts) and
 * cannot be mislabelled here. Every one is destination-scoped: each read is a batch read (SAF-9).
 */
export class ShopifyStockLinkProviderError extends StockLinkError {
  readonly scope = "destination" as const;
  constructor(code: string, message: string, context: Readonly<Record<string, unknown>>,
    options?: ErrorOptions & { retryAfterMs?: number | null }) {
    super(code, message, context, options);
    this.name = "ShopifyStockLinkProviderError";
  }
}

/** The connection columns the fingerprint covers (channels.channel_connections, as shopifyConnection reads them). */
export interface ShopifyStockLinkFingerprintConnection {
  readonly id: number;
  readonly shopDomain: string | null;
  readonly accessToken: string | null;
  readonly shopifyLocationId: string | null;
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The evidence fingerprint of a destination's login (§6.1): sha256 of canonical JSON {connectionId, shopDomain,
 * sha256(accessToken), shopifyLocationId}. The one function the adapter (what a read was made with) and the source
 * (what is stored now, under lock) both use, so any change of store, token or location between a read and its command
 * refuses the command (STOCK_LINK_CONNECTION_CHANGED). The token itself never leaves this function. The API version
 * is not covered: the adapter pins its own.
 */
export function shopifyStockLinkFingerprint(connection: ShopifyStockLinkFingerprintConnection): string {
  return sha256Hex(canonicalJson({
    connectionId: connection.id,
    shopDomain: connection.shopDomain,
    accessTokenSha256: connection.accessToken === null ? null : sha256Hex(connection.accessToken),
    shopifyLocationId: connection.shopifyLocationId,
  }));
}

/** Shopify search syntax for an exact SKU match of each value: quoted, with backslashes and quotes escaped. */
export function shopifyStockLinkSkuQuery(skus: readonly string[]): string {
  return skus.map(sku => `sku:"${sku.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`).join(" OR ");
}

/**
 * A Shopify GraphQL id of the given type as the decimal REST id the stock writer addresses (shopifyRestId,
 * CH/adapters/shopify.adapter.ts: a positive safe integer); null for anything else.
 */
export function parseShopifyGid(type: "InventoryItem" | "Product", value: string): string | null {
  const match = new RegExp(`^gid://shopify/${type}/([1-9]\\d{0,19})$`).exec(value);
  return match && Number.isSafeInteger(Number(match[1])) ? match[1]! : null;
}

const productStatus = z.string().regex(/^[A-Z][A-Z_]*$/).max(40);
const productSchema = z.object({ id: z.string(), status: productStatus }).strict();
const variantsPageSchema = z.object({
  productVariants: z.object({
    nodes: z.array(z.object({
      sku: z.string().nullable(),
      inventoryItem: z.object({ id: z.string() }).strict(),
      product: productSchema,
    }).strict()).max(SHOPIFY_STOCK_LINK_PAGE_SIZE),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }).strict(),
  }).strict(),
}).strict();
const inventoryNodesSchema = z.object({ nodes: z.array(z.unknown()) }).strict();
const inventoryNodeSchema = z.object({
  id: z.string(),
  sku: z.string().nullable(),
  variant: z.object({ product: productSchema }).strict(),
}).strict();
const throttleSchema = z.object({
  cost: z.object({
    throttleStatus: z.object({
      maximumAvailable: z.number().finite().positive(),
      currentlyAvailable: z.number().finite().nonnegative(),
      restoreRate: z.number().finite().nonnegative(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const requestedSkusSchema = z.array(z.string().min(1).max(STOCK_LINK_SKU_MAX_LENGTH)
  .refine(sku => sku === sku.trim(), "A looked-up SKU is trimmed."))
  .min(1).max(STOCK_LINK_LOOKUP_SKUS_MAX)
  .refine(skus => new Set(skus).size === skus.length, "Each looked-up SKU appears once.");
const requestedItemIdsSchema = z.array(z.string().regex(STOCK_LINK_DECIMAL_ID_PATTERN))
  .min(1).max(STOCK_LINK_OBSERVE_ITEMS_MAX)
  .refine(ids => new Set(ids).size === ids.length, "Each observed item appears once.");

/** Who and what an error is about: ids only, never a credential or provider text (a type, so it is an error context). */
type CallScope = {
  readonly publicationTargetId: number;
  readonly channelId: number;
  readonly channelConnectionId: number;
  readonly operation: "findItemsBySku" | "observeItems";
};

export interface ShopifyStockLinkAdapterDependencies {
  /** Resolves the destination's own connection (CH/channel-identity.service.ts), read fresh for every call. */
  readonly connections: Pick<ChannelIdentityService, "shopifyConnection">;
  /** The time a read's evidence is stamped with (injected, CLAUDE.md §3). */
  readonly clock: () => Date;
  readonly request?: typeof fetch;
}

export class ShopifyStockLinkAdapter implements StockLinkAdapter {
  readonly destinationKind = "channel_connection" as const;
  readonly providerKey = "shopify";
  private readonly request: typeof fetch;

  constructor(private readonly dependencies: ShopifyStockLinkAdapterDependencies) {
    this.request = dependencies.request ?? fetch;
  }

  async findItemsBySku(destination: StockLinkDestination, skus: readonly string[],
    options: StockLinkProviderCallOptions): Promise<StockLinkSkuLookup> {
    const scope = this.scope(destination, "findItemsBySku");
    const requested = this.input(requestedSkusSchema, skus, scope);
    const { connection, fingerprint } = await this.connect(scope);
    // The oldest moment the answer can describe: the engine refuses evidence older than 5 minutes (§4.3 step 0).
    const observedAt = this.observedAt(scope);
    const keys = new Set(requested.map(sku => {
      const normalized = normalizeStockLinkSku(sku);
      return normalized.kind === "sku" ? normalized.key : "";
    }));
    const query = shopifyStockLinkSkuQuery(requested);
    const items = new Map<string, StockLinkStoreItem>();
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let page = 1; ; page += 1) {
      const parsed = variantsPageSchema.safeParse(await this.graphql(connection,
        { query: VARIANTS_BY_SKU_QUERY, variables: { query, after } }, options.signal, scope));
      if (!parsed.success) throw responseInvalid(scope, "The store's SKU search answered in an unexpected shape.");
      for (const node of parsed.data.productVariants.nodes) {
        const item: StockLinkStoreItem = { itemId: gid("InventoryItem", node.inventoryItem.id, scope), sku: node.sku,
          productId: gid("Product", node.product.id, scope), productStatus: node.product.status };
        // Shopify's search is not an exact match: keep only what equals an asked SKU by the engine's own rule
        // (trimmed, case-insensitive, at most 100 characters); the engine applies the same rule again.
        const sku = normalizeStockLinkSku(node.sku);
        if (sku.kind !== "sku" || !sku.storable || !keys.has(sku.key)) continue;
        const seen = items.get(item.itemId);
        if (seen && canonicalJson(seen) !== canonicalJson(item)) {
          throw responseInvalid(scope, "The store's SKU search answered one item twice, differently.");
        }
        items.set(item.itemId, item);
      }
      const { hasNextPage, endCursor } = parsed.data.productVariants.pageInfo;
      if (!hasNextPage) break;
      if (page >= SHOPIFY_STOCK_LINK_LOOKUP_PAGES_MAX) {
        throw new ShopifyStockLinkProviderError(C.lookupIncomplete,
          "The store's SKU search has more results than one lookup may read; nothing from it is used.",
          { ...scope, pages: page });
      }
      if (!endCursor || cursors.has(endCursor)) throw responseInvalid(scope, "The store's SKU search gave no usable next page.");
      cursors.add(endCursor);
      after = endCursor;
    }
    return this.output(stockLinkSkuLookupSchema, { observedAt, readFingerprint: fingerprint, skus: [...requested],
      items: [...items.values()].sort((left, right) => compareDecimalIds(left.itemId, right.itemId)) }, scope);
  }

  async observeItems(destination: StockLinkDestination, itemIds: readonly string[],
    options: StockLinkProviderCallOptions): Promise<StockLinkItemObservation> {
    const scope = this.scope(destination, "observeItems");
    const ids = this.input(requestedItemIdsSchema, itemIds, scope);
    const { connection, fingerprint } = await this.connect(scope);
    const observedAt = this.observedAt(scope);
    const envelope = inventoryNodesSchema.safeParse(await this.graphql(connection, { query: INVENTORY_ITEMS_QUERY,
      variables: { ids: ids.map(id => `gid://shopify/InventoryItem/${id}`) } }, options.signal, scope));
    if (!envelope.success) throw responseInvalid(scope, "The store's item read answered in an unexpected shape.");
    if (envelope.data.nodes.length !== ids.length) {
      throw new ShopifyStockLinkProviderError(C.adapterContract, "The store answered a different number of items than were asked for.",
        { ...scope, asked: ids.length, answered: envelope.data.nodes.length });
    }
    const observations = ids.map((itemId, index) => {
      const raw = envelope.data.nodes[index];
      if (raw === null) return { itemId, item: null };
      const node = inventoryNodeSchema.safeParse(raw);
      if (!node.success) throw responseInvalid(scope, "The store's item read answered an item in an unexpected shape.");
      if (gid("InventoryItem", node.data.id, scope) !== itemId) {
        throw new ShopifyStockLinkProviderError(C.adapterContract, "The store answered another item than the one asked for.",
          { ...scope, position: index });
      }
      return { itemId, item: { itemId, sku: node.data.sku, productId: gid("Product", node.data.variant.product.id, scope),
        productStatus: node.data.variant.product.status } };
    });
    return this.output(stockLinkItemObservationSchema, { observedAt, readFingerprint: fingerprint, observations }, scope);
  }

  private scope(destination: StockLinkDestination, operation: CallScope["operation"]): CallScope {
    const parsed = stockLinkDestinationSchema.safeParse(destination);
    if (!parsed.success || parsed.data.destinationKind !== "channel_connection" || parsed.data.providerKey !== this.providerKey
      || parsed.data.channelConnectionId === null) {
      throw new ShopifyStockLinkProviderError(C.adapterContract, "The Shopify stock-link adapter was given another kind of destination.",
        { operation, publicationTargetId: parsed.success ? parsed.data.publicationTargetId : null });
    }
    return { publicationTargetId: parsed.data.publicationTargetId, channelId: parsed.data.channelId,
      channelConnectionId: parsed.data.channelConnectionId, operation };
  }

  /** An input the port's contract forbids is the engine's bug, not the store's: fatal, never retried. */
  private input<S extends z.ZodTypeAny>(schema: S, value: unknown, scope: CallScope): z.infer<S> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ShopifyStockLinkProviderError(C.adapterContract, "The Shopify stock-link adapter was asked for a read its contract does not allow.", scope);
    }
    return parsed.data;
  }

  /** The answer is checked against the shared contract once more before the engine sees it (CLAUDE.md §5). */
  private output<S extends z.ZodTypeAny>(schema: S, value: unknown, scope: CallScope): z.infer<S> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ShopifyStockLinkProviderError(C.adapterContract, "The Shopify stock-link adapter built an answer its contract does not allow.", scope);
    }
    return parsed.data;
  }

  private observedAt(scope: CallScope): string {
    const now = this.dependencies.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new ShopifyStockLinkProviderError(C.adapterContract, "The stock-link clock gave no valid time.", scope);
    }
    return now.toISOString();
  }

  /**
   * The destination's own login, resolved fresh for each call (never cached), and the fingerprint the read is made
   * with. A login that cannot be resolved or is incomplete pauses the destination like a refused one (it needs a person
   * to reconnect the store, and resumes by itself once it works). A database failure is rethrown for the engine.
   */
  private async connect(scope: CallScope): Promise<{ connection: ShopifyAdminGraphQLConnection; fingerprint: string }> {
    let connection: Awaited<ReturnType<ChannelIdentityService["shopifyConnection"]>>;
    try {
      connection = await this.dependencies.connections.shopifyConnection(scope.channelId, scope.channelConnectionId);
    } catch (error) {
      if (error instanceof ChannelIdentityError) {
        throw new ShopifyStockLinkProviderError(C.storeAuthRefused, "The store's saved login could not be found for this destination.",
          { ...scope, causeCode: error.code }, { cause: error });
      }
      throw error;
    }
    if (connection.id !== scope.channelConnectionId || connection.channelId !== scope.channelId) {
      throw new ShopifyStockLinkProviderError(C.adapterContract, "The store's login belongs to another destination.", scope);
    }
    if (!isShopifyAdminGraphQLConnectionValid(connection, SHOPIFY_STOCK_LINK_API_VERSION)) {
      throw new ShopifyStockLinkProviderError(C.storeAuthRefused, "The store's saved login is incomplete or malformed.", scope);
    }
    return { connection: { shopDomain: connection.shopDomain, accessToken: connection.accessToken },
      fingerprint: shopifyStockLinkFingerprint(connection) };
  }

  /** One GraphQL request; a successful answer must come from the pinned version and leave the cost bucket above the floor. */
  private async graphql(connection: ShopifyAdminGraphQLConnection, operation: ShopifyAdminGraphQLOperation, signal: AbortSignal,
    scope: CallScope): Promise<Record<string, unknown>> {
    if (signal.aborted) throw tickTimeUsed(scope);
    const seen: { meta: ShopifyAdminGraphQLResponseMeta | null } = { meta: null };
    const data = await requestShopifyAdminGraphQL(connection, operation, {
      apiVersion: SHOPIFY_STOCK_LINK_API_VERSION, timeoutMs: SHOPIFY_STOCK_LINK_REQUEST_TIMEOUT_MS, signal,
      onResponseMeta: meta => { seen.meta = meta; },
      errorFactory: failure => providerFailure(failure, seen.meta, signal, scope),
    }, this.request);
    const meta = seen.meta;
    if (meta?.apiVersion !== SHOPIFY_STOCK_LINK_API_VERSION) {
      // Shopify serves a newer version once the pinned one is retired; its fields may mean something else.
      throw new ShopifyStockLinkProviderError(C.providerRejected, "The store answered with another API version than the pinned one.",
        { ...scope, servedApiVersion: meta?.apiVersion && /^\d{4}-\d{2}$/.test(meta.apiVersion) ? meta.apiVersion : null });
    }
    const throttle = throttleStatus(meta.extensions, scope);
    if (throttle && throttle.currentlyAvailable < STOCK_LINK_COST_FLOOR_RATIO * throttle.maximumAvailable) {
      // A self-imposed stop like the call budget (busy, no attempt): this answer is not used, the next tick reads again.
      throw new ShopifyStockLinkProviderError(C.providerCostFloor, "The store's request budget is below half; reading stops for this tick.",
        { ...scope, currentlyAvailable: throttle.currentlyAvailable, maximumAvailable: throttle.maximumAvailable });
    }
    return data;
  }
}

export function createShopifyStockLinkAdapter(dependencies: ShopifyStockLinkAdapterDependencies): ShopifyStockLinkAdapter {
  return new ShopifyStockLinkAdapter(dependencies);
}

function gid(type: "InventoryItem" | "Product", value: string, scope: CallScope): string {
  const id = parseShopifyGid(type, value);
  if (id === null) {
    throw new ShopifyStockLinkProviderError(C.idInvalid, `The store answered a ${type} id in an unexpected form.`, { ...scope, type });
  }
  return id;
}

function responseInvalid(scope: CallScope, message: string): ShopifyStockLinkProviderError {
  return new ShopifyStockLinkProviderError(C.providerResponseInvalid, message, scope);
}

/** The tick's own budget ran out while a read was waiting: busy (no attempt), never a provider fault. */
function tickTimeUsed(scope: CallScope): ShopifyStockLinkProviderError {
  return new ShopifyStockLinkProviderError(C.callBudgetUsed, "The tick's time ran out before the store answered.", scope);
}

function retryAfterMs(meta: ShopifyAdminGraphQLResponseMeta | null): number | null {
  return meta?.retryAfter == null ? null : boundedProviderRetryAfterSeconds(meta.retryAfter, PROVIDER_RETRY_AFTER_MAX_SECONDS) * 1_000;
}

function throttleStatus(extensions: unknown, scope: CallScope) {
  if (extensions === null || extensions === undefined) return null;
  const parsed = throttleSchema.safeParse(extensions);
  if (!parsed.success) throw responseInvalid(scope, "The store's request budget was reported in an unexpected shape.");
  return parsed.data.cost?.throttleStatus ?? null;
}

/**
 * §6.1's mapping of a refused read: 401/403 pause (login refused); 402/423 pause (store unavailable);
 * 429 and GraphQL THROTTLED stop the destination for the tick (transient, Retry-After kept); 408/5xx, a transport
 * failure and Shopify's internal GraphQL errors are transient; an unreadable answer is transient; GraphQL
 * ACCESS_DENIED, schema/field errors, 404 and every other status are fatal for the destination (it halts with one
 * ERROR until Check again).
 */
function providerFailure(failure: ShopifyAdminGraphQLFailure, meta: ShopifyAdminGraphQLResponseMeta | null, signal: AbortSignal,
  scope: CallScope): ShopifyStockLinkProviderError {
  switch (failure.kind) {
    case "connection_invalid":
      return new ShopifyStockLinkProviderError(C.storeAuthRefused, "The store's saved login is incomplete or malformed.", scope);
    case "transport":
      return signal.aborted ? tickTimeUsed(scope)
        : new ShopifyStockLinkProviderError(C.providerUnavailable, "The store did not answer.", scope);
    case "response_invalid":
      return responseInvalid(scope, "The store's answer could not be read.");
    case "http": {
      const context = { ...scope, httpStatus: failure.status };
      if (failure.status === 401 || failure.status === 403)
        return new ShopifyStockLinkProviderError(C.storeAuthRefused, `The store refused the login (HTTP ${failure.status}).`, context);
      if (failure.status === 402 || failure.status === 423)
        return new ShopifyStockLinkProviderError(C.storeUnavailable, `The store is unavailable (HTTP ${failure.status}).`, context);
      if (failure.status === 429)
        return new ShopifyStockLinkProviderError(C.providerThrottled, "The store asked to slow down (HTTP 429).", context,
          { retryAfterMs: retryAfterMs(meta) });
      if (failure.status === 408 || failure.status >= 500)
        return new ShopifyStockLinkProviderError(C.providerUnavailable, `The store did not answer (HTTP ${failure.status}).`, context,
          { retryAfterMs: retryAfterMs(meta) });
      return new ShopifyStockLinkProviderError(C.providerRejected, `The store rejected the read (HTTP ${failure.status}).`, context);
    }
    case "graphql": {
      const codes = failure.codes;
      const context = { ...scope, graphqlCodes: codes === null ? null
        : codes.map(code => code !== null && LOGGABLE_PROVIDER_CODE.test(code) ? code : "OTHER") };
      const retryable = codes !== null && codes.length > 0
        && codes.every(code => code === THROTTLED_GRAPHQL_CODE || (code !== null && TRANSIENT_GRAPHQL_CODES.has(code)));
      if (retryable && codes.includes(THROTTLED_GRAPHQL_CODE))
        return new ShopifyStockLinkProviderError(C.providerThrottled, "The store's request budget is used up.", context,
          { retryAfterMs: retryAfterMs(meta) });
      if (retryable)
        return new ShopifyStockLinkProviderError(C.providerUnavailable, "The store reported an internal error.", context,
          { retryAfterMs: retryAfterMs(meta) });
      return new ShopifyStockLinkProviderError(C.providerRejected, "The store rejected the read.", context);
    }
  }
}

/** Decimal ids without leading zeros order by length, then text: numeric order without a Number round trip. */
function compareDecimalIds(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}
