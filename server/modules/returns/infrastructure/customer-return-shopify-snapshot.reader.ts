import { z } from "zod";
import type { ShopifyIdentityConnection } from "../../channels/adapters/shopify-identity.reader";
import {
  CUSTOMER_RETURN_SHOPIFY_API_VERSION, CUSTOMER_RETURN_SHOPIFY_COLLECTION_LIMIT,
  CustomerReturnShopifySnapshotError, customerReturnShopifyDomainSchema, customerReturnShopifyGidSchema,
  customerReturnShopifySnapshotInputSchema, customerReturnShopifySnapshotSchema, customerReturnShopifyOrderSchema,
  customerReturnShopifyPurchasedLineSchema, customerReturnShopifyFulfillmentSchema,
  customerReturnShopifyFulfillmentEventSchema,
  customerReturnShopifyNativeReturnSchema, customerReturnShopifyNativeReturnLineSchema,
  customerReturnShopifyRefundSchema, customerReturnShopifyRefundLineSchema,
  customerReturnShopifyReturnableFulfillmentSchema, customerReturnShopifyReturnableLineSchema,
  type CustomerReturnShopifySnapshot, type CustomerReturnShopifySnapshotInput,
  type CustomerReturnShopifySnapshotReader, type CustomerReturnShopifySnapshotErrorCode,
} from "../application/customer-return-shopify-snapshot.ports";
import { SHOPIFY_RETURN_SNAPSHOT_QUERIES as queries } from "./customer-return-shopify-snapshot.queries";

const REQUEST_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 90_000;
const MAX_REQUESTS = 1_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const LIMIT = CUSTOMER_RETURN_SHOPIFY_COLLECTION_LIMIT;
const recordSchema = z.record(z.unknown());
const quantity = z.number().int().nonnegative().safe();
const identity = (resource: string) => z.object({ id: customerReturnShopifyGidSchema(resource) }).strict();
const connectionSchema = z.object({
  id: z.number().int().positive().safe(), channelId: z.number().int().positive().safe(),
  shopDomain: customerReturnShopifyDomainSchema, accessToken: z.string().trim().min(1).max(4096),
  apiVersion: z.string().regex(/^\d{4}-(01|04|07|10)$/), shopifyLocationId: z.string().nullable(),
}).strict();
const accountSchema = z.object({
  shop: identity("Shop").extend({ myshopifyDomain: customerReturnShopifyDomainSchema }).strict(),
  currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string().min(1).max(100) }).strict()).max(1000) }).strict(),
}).strict();
const fulfillmentHeaderSchema = customerReturnShopifyFulfillmentSchema.omit({ lines: true, events: true, tracking: true })
  .extend({ trackingInfo: customerReturnShopifyFulfillmentSchema.shape.tracking }).strict();
const refundHeaderSchema = customerReturnShopifyRefundSchema.omit({ lines: true, returnId: true })
  .extend({ return: identity("Return").nullable() }).strict();
const returnHeaderSchema = customerReturnShopifyNativeReturnSchema.omit({ lines: true })
  .extend({ order: identity("Order") }).strict();
const returnableHeaderSchema = customerReturnShopifyReturnableFulfillmentSchema.omit({ lines: true, fulfillmentId: true })
  .extend({ fulfillment: identity("Fulfillment").extend({ order: identity("Order") }).strict() }).strict();
const orderHeaderSchema = customerReturnShopifyOrderSchema.omit({ destinationCountryCode: true }).extend({
  shippingAddress: z.object({ countryCodeV2: z.string().regex(/^[A-Z]{2}$/).nullable() }).strict().nullable(),
  fulfillmentsCount: z.object({ count: quantity, precision: z.literal("EXACT") }).strict(),
  fulfillments: z.array(fulfillmentHeaderSchema).max(LIMIT), refunds: z.array(refundHeaderSchema).max(LIMIT),
}).strict();
const fulfillmentLineSchema = z.object({ id: customerReturnShopifyGidSchema("FulfillmentLineItem"), quantity,
  lineItem: identity("LineItem") }).strict().transform(({ lineItem, ...line }) => ({ ...line, lineItemId: lineItem.id }));
const nativeReturnLineSchema = z.object({
  __typename: z.literal("ReturnLineItem"), id: customerReturnShopifyGidSchema("ReturnLineItem"),
  quantity, processedQuantity: quantity, refundedQuantity: quantity,
  fulfillmentLineItem: identity("FulfillmentLineItem").extend({ lineItem: identity("LineItem") }).strict(),
}).strict().transform(({ __typename: _type, fulfillmentLineItem, ...line }) => ({
  ...line, fulfillmentLineItemId: fulfillmentLineItem.id, lineItemId: fulfillmentLineItem.lineItem.id,
})).pipe(customerReturnShopifyNativeReturnLineSchema);
const refundLineSchema = customerReturnShopifyRefundLineSchema.omit({ lineItemId: true })
  .extend({ lineItem: identity("LineItem") }).strict().transform(({ lineItem, ...line }) => ({ ...line, lineItemId: lineItem.id }));
const returnableLineSchema = z.object({ quantity,
  fulfillmentLineItem: identity("FulfillmentLineItem").extend({ lineItem: identity("LineItem") }).strict(),
}).strict().transform(({ quantity: count, fulfillmentLineItem }) => ({ quantity: count,
  fulfillmentLineItemId: fulfillmentLineItem.id, lineItemId: fulfillmentLineItem.lineItem.id,
})).pipe(customerReturnShopifyReturnableLineSchema);

export interface ShopifyCustomerReturnSnapshotReaderDependencies {
  resolveConnection: (channelId: number) => Promise<ShopifyIdentityConnection>;
  request: typeof fetch;
  now: () => Date;
}
type Query = typeof queries[keyof typeof queries];
type RequestQuery = (query: Query, variables?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Observation = Omit<CustomerReturnShopifySnapshot, "shop" | "apiVersion" | "observedAt">;

/** A bounded provider read. It cannot authorize a return or establish WMS/customer ownership. */
export class ShopifyCustomerReturnSnapshotReader implements CustomerReturnShopifySnapshotReader {
  constructor(private readonly dependencies: ShopifyCustomerReturnSnapshotReaderDependencies) {}

  async read(raw: CustomerReturnShopifySnapshotInput): Promise<CustomerReturnShopifySnapshot> {
    const input = parse(customerReturnShopifySnapshotInputSchema, raw, "RETURN_SHOPIFY_INPUT_INVALID");
    const before = await this.connection(input);
    const orderId = input.externalOrderId.startsWith("gid://") ? input.externalOrderId : `gid://shopify/Order/${input.externalOrderId}`;
    const request = this.requester(before);
    const account = await this.account(request, before.shopDomain);
    const first = await this.observe(request, orderId);
    // Shopify exposes no transactional snapshot and Return has no updatedAt.
    // Compare two COMPLETE observations, including child identities/quantities, not just parent totals.
    const second = await this.observe(request, orderId);
    if (canonical(first) !== canonical(second)) fail("RETURN_SHOPIFY_SNAPSHOT_CHANGED", "transient");
    const finalAccount = await this.account(request, before.shopDomain);
    if (canonical(account) !== canonical(finalAccount)) fail("RETURN_SHOPIFY_CONNECTION_CHANGED", "transient");
    const after = await this.connection(input);
    if (canonical(before) !== canonical(after)) fail("RETURN_SHOPIFY_CONNECTION_CHANGED", "transient");
    let now: Date;
    try { now = this.dependencies.now(); } catch { fail("RETURN_SHOPIFY_CLOCK_INVALID"); }
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("RETURN_SHOPIFY_CLOCK_INVALID");
    const result = parse(customerReturnShopifySnapshotSchema, {
      ...second, shop: { ...input.shop, shopId: account.shop.id,
        scopes: { readOrders: true, readAllOrders: true, readReturns: true } },
      apiVersion: CUSTOMER_RETURN_SHOPIFY_API_VERSION, observedAt: now.toISOString(),
    });
    validateQuantities(result);
    return result;
  }

  private async connection(input: CustomerReturnShopifySnapshotInput): Promise<z.infer<typeof connectionSchema>> {
    let raw: unknown;
    try { raw = await this.dependencies.resolveConnection(input.shop.channelId); }
    catch { fail("RETURN_SHOPIFY_CONNECTION_UNAVAILABLE", "transient"); }
    const connection = parse(connectionSchema, raw, "RETURN_SHOPIFY_CONNECTION_UNAVAILABLE");
    if (connection.id !== input.shop.connectionId || connection.channelId !== input.shop.channelId
      || connection.shopDomain !== input.shop.shopDomain) fail("RETURN_SHOPIFY_CONNECTION_CHANGED");
    return connection;
  }

  private requester(connection: z.infer<typeof connectionSchema>): RequestQuery {
    const url = `https://${connection.shopDomain}/admin/api/${CUSTOMER_RETURN_SHOPIFY_API_VERSION}/graphql.json`;
    const operationSignal = AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS);
    let requests = 0;
    return async (query, variables) => {
      try {
        if (++requests > MAX_REQUESTS) fail("RETURN_SHOPIFY_SNAPSHOT_LIMIT");
        if (operationSignal.aborted) fail("RETURN_SHOPIFY_TRANSPORT_FAILED", "transient");
        const signal = AbortSignal.any([operationSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
        let response: Response;
        try {
          response = await abortable(this.dependencies.request(url, {
            method: "POST", redirect: "error", cache: "no-store",
            signal,
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": connection.accessToken },
            body: JSON.stringify({ query, variables }),
          }), signal);
        } catch { fail("RETURN_SHOPIFY_TRANSPORT_FAILED", "transient"); }
        if (!response.ok) fail("RETURN_SHOPIFY_HTTP_REJECTED", response.status === 408 || response.status === 429 || response.status >= 500 ? "transient" : "permanent");
        if (response.headers.get("X-Shopify-API-Version") !== CUSTOMER_RETURN_SHOPIFY_API_VERSION) fail("RETURN_SHOPIFY_VERSION_MISMATCH");
        const envelope = parse(recordSchema, await readJson(response, signal));
        if (envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0)) {
          const retryable = Array.isArray(envelope.errors) && envelope.errors.length > 0 && envelope.errors.every(error => {
            const parsed = z.object({ extensions: z.object({ code: z.string() }) }).safeParse(error);
            return parsed.success && ["THROTTLED", "INTERNAL_SERVER_ERROR", "INTERNAL_ERROR", "SERVICE_UNAVAILABLE"].includes(parsed.data.extensions.code);
          });
          fail("RETURN_SHOPIFY_GRAPHQL_REJECTED", retryable ? "transient" : "permanent");
        }
        return parse(recordSchema, envelope.data);
      } catch (error) {
        if (error instanceof CustomerReturnShopifySnapshotError) throw error;
        fail("RETURN_SHOPIFY_RESPONSE_INVALID", "transient");
      }
    };
  }

  private async account(request: RequestQuery, domain: string) {
    const account = parse(accountSchema, await request(queries.account));
    if (account.shop.myshopifyDomain !== domain) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
    const scopes = account.currentAppInstallation.accessScopes.map(scope => scope.handle);
    if (new Set(scopes).size !== scopes.length) fail("RETURN_SHOPIFY_RESPONSE_INVALID");
    if (!["read_orders", "read_all_orders", "read_returns"].every(scope => scopes.includes(scope))) fail("RETURN_SHOPIFY_SCOPE_MISSING");
    return { shop: account.shop, scopes: scopes.filter(scope => ["read_orders", "read_all_orders", "read_returns"].includes(scope)).sort() };
  }

  private async observe(request: RequestQuery, orderId: string): Promise<Observation> {
    const envelope = parse(z.object({ order: orderHeaderSchema.nullable() }).strict(), await request(queries.order, { id: orderId }));
    if (!envelope.order) fail("RETURN_SHOPIFY_ORDER_UNAVAILABLE");
    const header = envelope.order;
    if (header.id !== orderId) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
    unique(header.fulfillments.map(item => item.id)); unique(header.refunds.map(item => item.id));
    if (header.fulfillmentsCount.count !== header.fulfillments.length) fail("RETURN_SHOPIFY_PAGINATION_INVALID");
    const orderScope = { id: orderId, updatedAt: header.updatedAt };
    const lines = await paginate(request, queries.lines, orderId, customerReturnShopifyPurchasedLineSchema,
      node => node.id, data => parentConnection(data, "order", "lineItems", orderScope));
    const fulfillments: CustomerReturnShopifySnapshot["fulfillments"] = [];
    for (const fulfillment of header.fulfillments) {
      const scope = { id: fulfillment.id, updatedAt: fulfillment.updatedAt, order: { id: orderId } };
      const items = await paginate(request, queries.fulfillmentLines, fulfillment.id, fulfillmentLineSchema, node => node.id,
        data => parentConnection(data, "fulfillment", "fulfillmentLineItems", scope));
      const events = await paginate(request, queries.events, fulfillment.id, customerReturnShopifyFulfillmentEventSchema, node => node.id,
        data => parentConnection(data, "fulfillment", "events", scope));
      const { trackingInfo, ...fields } = fulfillment;
      fulfillments.push(parse(customerReturnShopifyFulfillmentSchema, { ...fields, tracking: trackingInfo, lines: items, events }));
    }
    const nativeHeaders = await paginate(request, queries.returns, orderId, returnHeaderSchema, node => node.id,
      data => parentConnection(data, "order", "returns", orderScope));
    const returns: CustomerReturnShopifySnapshot["returns"] = [];
    for (const native of nativeHeaders) {
      if (native.order.id !== orderId) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
      const items = await paginate(request, queries.returnLines, native.id, nativeReturnLineSchema, node => node.id,
        data => parentConnection(data, "return", "returnLineItems", native));
      const { order: _order, ...fields } = native;
      returns.push({ ...fields, lines: items });
    }
    const refunds: CustomerReturnShopifySnapshot["refunds"] = [];
    for (const refund of header.refunds) {
      const items = await paginate(request, queries.refundLines, refund.id, refundLineSchema,
        // A nullable provider ID cannot support deduplication. The purchased-line identity must be unique within this refund.
        node => node.id ?? `line:${node.lineItemId}`,
        data => parentConnection(data, "refund", "refundLineItems", { ...refund, order: { id: orderId } }));
      refunds.push({ id: refund.id, updatedAt: refund.updatedAt, returnId: refund.return?.id ?? null, lines: items });
    }
    const returnableHeaders = await paginate(request, queries.returnables, orderId, returnableHeaderSchema, node => node.id,
      data => parse(z.object({ returnableFulfillments: z.unknown() }).strict(), data).returnableFulfillments);
    const returnableFulfillments: CustomerReturnShopifySnapshot["returnableFulfillments"] = [];
    for (const returnable of returnableHeaders) {
      if (returnable.fulfillment.order.id !== orderId) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
      const items = await paginate(request, queries.returnableLines, returnable.id, returnableLineSchema, node => node.fulfillmentLineItemId,
        data => parentConnection(data, "returnableFulfillment", "returnableFulfillmentLineItems", returnable));
      returnableFulfillments.push({ id: returnable.id, fulfillmentId: returnable.fulfillment.id, lines: items });
    }
    const { fulfillments: _fulfillments, refunds: _refunds, fulfillmentsCount: _count, shippingAddress, ...order } = header;
    return { order: { ...order, destinationCountryCode: shippingAddress?.countryCodeV2 ?? null }, lines, fulfillments, returns, refunds, returnableFulfillments };
  }
}

async function paginate<T>(request: RequestQuery, query: Query, id: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  key: (node: T) => string, extract: (data: Record<string, unknown>) => unknown): Promise<T[]> {
  const pageSchema = z.object({ nodes: z.array(schema).max(100),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).max(4096).nullable() }).strict() }).strict();
  const output: T[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let after: string | null = null;
  // At least one new node per nonfinal page gives a finite bound even when the provider returns tiny pages.
  for (let page = 0; page <= LIMIT; page++) {
    const result: { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } =
      parse(pageSchema, extract(await request(query, { id, after })), "RETURN_SHOPIFY_PAGINATION_INVALID");
    for (const node of result.nodes) {
      const nodeKey = key(node);
      if (ids.has(nodeKey)) fail("RETURN_SHOPIFY_PAGINATION_INVALID");
      ids.add(nodeKey); output.push(node);
    }
    if (output.length > LIMIT) fail("RETURN_SHOPIFY_SNAPSHOT_LIMIT");
    if (result.nodes.length > 0 && result.pageInfo.endCursor === null) fail("RETURN_SHOPIFY_PAGINATION_INVALID");
    if (result.pageInfo.endCursor !== null && cursors.has(result.pageInfo.endCursor)) fail("RETURN_SHOPIFY_PAGINATION_INVALID");
    if (!result.pageInfo.hasNextPage) return output;
    if (result.nodes.length === 0 || result.pageInfo.endCursor === null || output.length === LIMIT) fail("RETURN_SHOPIFY_PAGINATION_INVALID");
    after = result.pageInfo.endCursor; cursors.add(after);
  }
  fail("RETURN_SHOPIFY_SNAPSHOT_LIMIT");
}

function parentConnection(data: Record<string, unknown>, root: string, field: string, expected: Record<string, unknown>): unknown {
  if (Object.keys(data).length !== 1 || !(root in data)) fail("RETURN_SHOPIFY_RESPONSE_INVALID");
  const parent = parse(recordSchema, data[root]);
  if (!(field in parent)) fail("RETURN_SHOPIFY_PAGINATION_INVALID");
  const { [field]: connection, ...actual } = parent;
  if (canonical(actual) !== canonical(expected)) fail("RETURN_SHOPIFY_SNAPSHOT_CHANGED", "transient");
  return connection;
}

function validateQuantities(snapshot: CustomerReturnShopifySnapshot): void {
  const purchased = new Map(snapshot.lines.map(line => [line.id, line]));
  const allocations = new Map<string, { fulfillmentId: string; lineItemId: string; quantity: number }>();
  const activeTotals = new Map<string, number>();
  unique(snapshot.fulfillments.flatMap(fulfillment => fulfillment.events.map(event => event.id)));
  for (const fulfillment of snapshot.fulfillments) {
    if (sum(fulfillment.lines.map(line => line.quantity)) !== fulfillment.totalQuantity) fail("RETURN_SHOPIFY_RESPONSE_INVALID");
    for (const line of fulfillment.lines) {
      const purchase = purchased.get(line.lineItemId);
      if (!purchase || allocations.has(line.id) || line.quantity > purchase.quantity) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
      allocations.set(line.id, { ...line, fulfillmentId: fulfillment.id });
      if (fulfillment.status === "SUCCESS") activeTotals.set(line.lineItemId, sum([activeTotals.get(line.lineItemId) ?? 0, line.quantity]));
    }
  }
  for (const [id, total] of activeTotals) if (total > purchased.get(id)!.quantity) fail("RETURN_SHOPIFY_RESPONSE_INVALID");
  const nativeIds = new Set(snapshot.returns.map(native => native.id));
  const returnLineIds: string[] = [], claimTotals = new Map<string, number>();
  for (const native of snapshot.returns) {
    if (sum(native.lines.map(line => line.quantity)) !== native.totalQuantity) fail("RETURN_SHOPIFY_RESPONSE_INVALID");
    for (const line of native.lines) {
      returnLineIds.push(line.id);
      const allocation = allocations.get(line.fulfillmentLineItemId);
      if (!allocation || allocation.lineItemId !== line.lineItemId || line.quantity > allocation.quantity) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
      if (!["CANCELED", "DECLINED"].includes(native.status)) {
        claimTotals.set(line.fulfillmentLineItemId, sum([claimTotals.get(line.fulfillmentLineItemId) ?? 0, line.quantity]));
      }
    }
  }
  unique(returnLineIds);
  for (const [id, total] of claimTotals) if (total > allocations.get(id)!.quantity) fail("RETURN_SHOPIFY_RESPONSE_INVALID");
  const refundLineIds: string[] = [];
  for (const refund of snapshot.refunds) {
    if (refund.returnId !== null && !nativeIds.has(refund.returnId)) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
    const lineTotals = new Map<string, number>();
    const ambiguousLines = new Set(refund.lines.filter(line => line.id === null).map(line => line.lineItemId));
    for (const lineId of ambiguousLines) {
      if (refund.lines.filter(line => line.lineItemId === lineId).length !== 1) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
    }
    for (const line of refund.lines) {
      if (line.id !== null) refundLineIds.push(line.id);
      const purchase = purchased.get(line.lineItemId);
      if (!purchase || line.quantity > purchase.quantity) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
      lineTotals.set(line.lineItemId, sum([lineTotals.get(line.lineItemId) ?? 0, line.quantity]));
    }
    for (const [id, total] of lineTotals) if (total > purchased.get(id)!.quantity) fail("RETURN_SHOPIFY_RESPONSE_INVALID");
  }
  unique(refundLineIds);
  unique(snapshot.returnableFulfillments.map(item => item.fulfillmentId));
  for (const returnable of snapshot.returnableFulfillments) {
    if (!snapshot.fulfillments.some(fulfillment => fulfillment.id === returnable.fulfillmentId)) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
    for (const line of returnable.lines) {
      const allocation = allocations.get(line.fulfillmentLineItemId);
      if (!allocation || allocation.fulfillmentId !== returnable.fulfillmentId || allocation.lineItemId !== line.lineItemId
        || line.quantity > allocation.quantity) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
    }
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) fail("RETURN_SHOPIFY_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        // Cancellation is best effort cleanup; a broken transport must not hold the failure response open.
        void reader.cancel().catch(() => undefined);
        fail("RETURN_SHOPIFY_SNAPSHOT_LIMIT");
      }
      chunks.push(next.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)) as unknown;
  } catch (error) {
    if (error instanceof CustomerReturnShopifySnapshotError) throw error;
    fail("RETURN_SHOPIFY_RESPONSE_INVALID", "transient");
  } finally {
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CustomerReturnShopifySnapshotError("RETURN_SHOPIFY_TRANSPORT_FAILED", "transient"));
    // Observe the operation's rejection even if the signal was already aborted.
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown,
  code: CustomerReturnShopifySnapshotErrorCode = "RETURN_SHOPIFY_RESPONSE_INVALID"): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(code);
  return result.data;
}
function fail(code: CustomerReturnShopifySnapshotErrorCode, failureClass: "permanent" | "transient" = "permanent"): never {
  throw new CustomerReturnShopifySnapshotError(code, failureClass);
}
function unique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) fail("RETURN_SHOPIFY_IDENTITY_MISMATCH");
}
function sum(quantities: readonly number[]): number {
  const total = quantities.reduce((sum, quantity) => sum + quantity, 0);
  if (!Number.isSafeInteger(total)) fail("RETURN_SHOPIFY_RESPONSE_INVALID");
  return total;
}
/** Order-independent comparison detects changed content without treating page order as a revision. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
