import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  CUSTOMER_RETURN_INSPECTION_LIMITS as limits, MAX_CATALOG_RETURN_UNIT_WEIGHT_GRAMS, CustomerReturnLocalInspectionError,
  customerReturnInspectionShopSchema, customerReturnLocalOrderSchema, customerReturnLocalLineSchema,
  customerReturnLocalWmsItemSchema, customerReturnLocalRootClaimSchema, customerReturnLocalLegacyClaimSchema,
  customerReturnLocalUnallocatedReturnSchema, customerReturnLocalInventoryReturnSchema,
  customerReturnLocalBindingSchema, customerReturnLocalPackageItemSchema, customerReturnLocalPackageLabelSchema,
  customerReturnLocalCarrierEventSchema, customerReturnLocalInspectionSnapshotSchema,
  customerReturnLocalInspectionInputSchema,
  type CustomerReturnInspectionShop, type CustomerReturnLocalInspectionReader,
  type CustomerReturnLocalInspectionSnapshot,
} from "../application/customer-return-local-inspection.ports";
import { buildCustomerReturnOrderNumberAliases, CustomerReturnOrderReferenceError } from "../domain/customer-return-order-reference";
import { inspectionQueries as queries } from "./customer-return-local-inspection.queries";
import { CUSTOMER_RETURN_INSPECTION_SNAPSHOT_QUERY } from "./customer-return-local-inspection.snapshot-query";
import { deriveLocalInspectionIssues } from "./customer-return-local-inspection.issues";

const positiveId = z.number().int().positive().safe();
const approvedDomainsSchema = z.array(z.string().trim().toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/)).max(limits.shops)
  .refine(domains => new Set(domains).size === domains.length);
const configuredShopSchema = customerReturnInspectionShopSchema.extend({
  type: z.string(), provider: z.string(), status: z.string(),
  connectionCount: positiveId, hasCredentials: z.boolean(), isDropship: z.boolean(),
}).strict();
const localOrderRowSchema = customerReturnLocalOrderSchema.extend({ isDropship: z.boolean() }).strict();
const snapshotCollectionsSchema = z.object({
  lines: z.array(z.unknown()), wmsItems: z.array(z.unknown()), rootClaims: z.array(z.unknown()),
  legacyClaims: z.array(z.unknown()), unallocatedReturns: z.array(z.unknown()), inventoryReturnEvidence: z.array(z.unknown()),
  fulfillmentBindings: z.array(z.unknown()), packageItems: z.array(z.unknown()), packageLabels: z.array(z.unknown()),
  carrierEvents: z.array(z.unknown()),
}).strict();
const timestampSchema = z.string().datetime({ offset: true });
// Bounded local reads cannot wait indefinitely behind a migration or a saturated DB.
const STATEMENT_TIMEOUT_MS = 5_000;

export interface CustomerReturnLocalInspectionOptions {
  approvedShopDomains: readonly string[];
  clock: () => Date;
  reportFailure?: (event: { operation: "shops" | "read"; code: string }) => void;
}

/** No application DB singleton, provider client, writer or environment dependency.
 * This snapshot is inspection evidence, never an entitlement reservation. */
export class PostgresCustomerReturnLocalInspectionReader implements CustomerReturnLocalInspectionReader {
  private readonly domains: readonly string[];

  constructor(private readonly database: Pick<Pool, "connect">, private readonly options: CustomerReturnLocalInspectionOptions) {
    const parsed = approvedDomainsSchema.safeParse(options.approvedShopDomains);
    if (!parsed.success) throw failure("RETURN_INSPECTION_CONFIGURATION_INVALID", "Configure distinct canonical Shopify shop domains for private return testing.");
    this.domains = Object.freeze([...parsed.data]);
  }

  async listShops(): Promise<readonly CustomerReturnInspectionShop[]> {
    return this.boundary("shops", async () => this.domains.length === 0 ? [] : this.snapshot(client => this.loadShops(client)));
  }

  async read(raw: Parameters<CustomerReturnLocalInspectionReader["read"]>[0]): Promise<CustomerReturnLocalInspectionSnapshot | null> {
    return this.boundary("read", async () => {
      const parsed = customerReturnLocalInspectionInputSchema.safeParse(raw);
      if (!parsed.success) throw failure("RETURN_INSPECTION_INPUT_INVALID", "Select a configured shop and enter an exact order reference.");
      const input = parsed.data;
      const lookup = "canonicalOrder" in input
        ? { query: queries.canonicalOrder, values: [input.channelId, input.canonicalOrder.omsOrderId,
          input.canonicalOrder.externalOrderId, input.canonicalOrder.externalCustomerId] }
        : { query: queries.order, values: [input.channelId, buildCustomerReturnOrderNumberAliases(input.orderReference)] };
      if (this.domains.length === 0) throw failure("RETURN_INSPECTION_CONFIGURATION_REQUIRED", "Private live-order testing requires an approved Shopify shop.");
      return this.snapshot(async client => {
        const shops = await this.loadShops(client);
        const shop = shops.find(candidate => candidate.channelId === input.channelId && candidate.connectionId === input.connectionId);
        if (!shop) throw failure("RETURN_INSPECTION_SHOP_UNAVAILABLE", "The selected shop is not configured for private return testing.");
        const orders = await readRows(client, localOrderRowSchema, lookup.query, lookup.values, 2,
          ["omsOrderId", "channelId"], ["purchasedAt", "cancelledAt"]);
        if (orders.length > 1) throw failure("RETURN_INSPECTION_ORDER_AMBIGUOUS", "The order reference matches more than one order in this shop.");
        if (orders.length === 0) return null;
        const { isDropship, ...order } = orders[0];
        if (order.channelId !== shop.channelId || ("canonicalOrder" in input
          && (order.omsOrderId !== input.canonicalOrder.omsOrderId || order.externalOrderId !== input.canonicalOrder.externalOrderId
            || order.externalCustomerId !== input.canonicalOrder.externalCustomerId))) {
          throw failure("RETURN_INSPECTION_DATA_INVALID", "The canonical order ownership could not be verified.");
        }
        if (isDropship) throw failure("RETURN_INSPECTION_ORDER_SCOPE_UNSUPPORTED", "This order is outside the retail returns scope.");
        const snapshot = await this.loadOrderEvidence(client, shop, order);
        const instant = this.options.clock();
        if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error("Invalid inspection clock");
        return customerReturnLocalInspectionSnapshotSchema.parse({ ...snapshot, observedAt: instant.toISOString(),
          issues: deriveLocalInspectionIssues(snapshot) });
      });
    });
  }

  private async loadShops(client: PoolClient): Promise<CustomerReturnInspectionShop[]> {
    const rows = await readRows(client, configuredShopSchema, queries.shops, [this.domains, limits.shops + 1], limits.shops,
      ["channelId", "connectionId", "connectionCount"]);
    if (rows.length !== this.domains.length || new Set(rows.map(row => row.shopDomain)).size !== rows.length
      || new Set(rows.map(row => row.channelId)).size !== rows.length
      || rows.some(row => !this.domains.includes(row.shopDomain) || row.connectionCount !== 1
        || row.type !== "internal" || row.provider !== "shopify" || row.status !== "active"
        || row.isDropship || !row.hasCredentials)) {
      throw failure("RETURN_INSPECTION_CONFIGURATION_UNRESOLVED", "Each approved shop must resolve to one active retail Shopify channel and one configured connection.");
    }
    return rows.map(row => customerReturnInspectionShopSchema.parse({ channelId: row.channelId,
      connectionId: row.connectionId, shopDomain: row.shopDomain, displayName: row.displayName }));
  }

  private async loadOrderEvidence(client: PoolClient, shop: CustomerReturnInspectionShop,
    order: z.infer<typeof customerReturnLocalOrderSchema>): Promise<Omit<CustomerReturnLocalInspectionSnapshot, "observedAt" | "issues">> {
    const orderId = order.omsOrderId;
    const result = await client.query(CUSTOMER_RETURN_INSPECTION_SNAPSHOT_QUERY, [orderId, String(orderId), shop.channelId,
      orderIdAliases(order.externalOrderId), limits.lines + 1, limits.wmsItems + 1, limits.claims + 1,
      limits.bindings + 1, limits.packageItems + 1, limits.labels + 1, limits.events + 1]);
    if (!Array.isArray(result?.rows) || result.rows.length !== 1) throw new z.ZodError([]);
    const raw = snapshotCollectionsSchema.parse(result.rows[0]);
    const lines = parseRows(customerReturnLocalLineSchema, raw.lines, limits.lines,
      ["omsOrderLineId", "quantity"], [], ["unitWeightGrams"]);
    const wmsItems = parseRows(customerReturnLocalWmsItemSchema, raw.wmsItems, limits.wmsItems,
      ["wmsOrderId", "wmsOrderItemId", "omsOrderLineId", "channelId", "quantity", "fulfilledQuantity"]);
    const rootClaims = parseRows(customerReturnLocalRootClaimSchema, raw.rootClaims, limits.claims,
      ["claimId", "authorizationId", "authorizationLineId", "channelId", "omsOrderId", "omsOrderLineId", "wmsOrderItemId", "quantity"]);
    const legacyClaims = parseRows(customerReturnLocalLegacyClaimSchema, raw.legacyClaims, limits.claims,
      ["returnId", "returnItemId", "wmsOrderId", "wmsOrderItemId", "omsOrderLineId", "expectedQuantity", "receivedQuantity"]);
    const unallocatedReturns = parseRows(customerReturnLocalUnallocatedReturnSchema, raw.unallocatedReturns, limits.claims,
      ["returnId", "wmsOrderId"]);
    const inventoryReturnEvidence = parseRows(customerReturnLocalInventoryReturnSchema, raw.inventoryReturnEvidence, limits.claims,
      ["transactionId", "wmsOrderId", "wmsOrderItemId", "quantityDelta"], ["occurredAt"]);
    const fulfillmentBindings = parseRows(customerReturnLocalBindingSchema, raw.fulfillmentBindings, limits.bindings,
      ["bindingId", "parentId", "sourceChannelId", "omsOrderLineId", "wmsOrderItemId", "physicalShipmentId", "physicalShipmentItemId", "quantity"]);
    const packageItems = parseRows(customerReturnLocalPackageItemSchema, raw.packageItems, limits.packageItems,
      ["physicalShipmentItemId", "physicalShipmentId", "wmsOrderItemId", "omsOrderLineId", "legacyShipmentItemId", "legacyShipmentId",
        "replacementForOrderItemId", "correctionForPhysicalShipmentItemId", "originalQuantity", "effectiveQuantity"]);
    const packageLabels = parseRows(customerReturnLocalPackageLabelSchema, raw.packageLabels, limits.labels,
      ["linkId", "labelId", "physicalShipmentId"], ["voidedAt"]);
    const carrierEvents = parseRows(customerReturnLocalCarrierEventSchema, raw.carrierEvents, limits.events,
      ["eventId", "matchId", "labelId"], ["occurredAt", "actualDeliveryAt", "receivedAt"]);
    return { shop, order, lines, wmsItems, rootClaims, legacyClaims, unallocatedReturns, inventoryReturnEvidence,
      fulfillmentBindings, packageItems, packageLabels, carrierEvents };
  }

  private async snapshot<T>(read: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    let completed = false;
    let discard = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(STATEMENT_TIMEOUT_MS)]);
      const result = await read(client);
      await client.query("COMMIT");
      completed = true;
      return result;
    } finally {
      if (!completed) {
        try { await client.query("ROLLBACK"); } catch { discard = true; }
      }
      client.release(discard);
    }
  }

  private async boundary<T>(operation: "shops" | "read", run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (cause) {
      const error = cause instanceof CustomerReturnLocalInspectionError ? cause
        : cause instanceof CustomerReturnOrderReferenceError ? failure("RETURN_INSPECTION_INPUT_INVALID", "Enter a valid order reference.")
          : cause instanceof z.ZodError ? failure("RETURN_INSPECTION_DATA_INVALID", "Local return evidence could not be validated.")
            : failure("RETURN_INSPECTION_UNAVAILABLE", "Local order evidence is temporarily unavailable.");
      const event = { operation, code: error.code };
      try {
        if (this.options.reportFailure) this.options.reportFailure(event);
        else console.error(JSON.stringify(event));
      } catch { console.error(JSON.stringify({ operation, code: "RETURN_INSPECTION_REPORTING_FAILED" })); }
      throw error;
    }
  }
}

async function readRows<T extends z.ZodTypeAny>(client: PoolClient, schema: T, text: string,
  values: unknown[], maximum: number, integerKeys: readonly string[] = [], timestampKeys: readonly string[] = [],
  nullableWeightKeys: readonly string[] = []): Promise<z.output<T>[]> {
  const result = await client.query(text, values);
  if (!result || !Array.isArray(result.rows)) throw new z.ZodError([]);
  return parseRows(schema, result.rows, maximum, integerKeys, timestampKeys, nullableWeightKeys);
}

function parseRows<T extends z.ZodTypeAny>(schema: T, rows: readonly unknown[], maximum: number,
  integerKeys: readonly string[] = [], timestampKeys: readonly string[] = [],
  nullableWeightKeys: readonly string[] = []): z.output<T>[] {
  if (rows.length > maximum) throw failure("RETURN_INSPECTION_EVIDENCE_LIMIT", "This order has more evidence than private inspection can safely review.");
  return rows.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new z.ZodError([]);
    const row: Record<string, unknown> = { ...raw };
    for (const key of integerKeys) {
      const value = row[key];
      if (typeof value === "string" && /^-?\d+$/.test(value)) row[key] = Number(value);
    }
    for (const key of timestampKeys) {
      const value = row[key];
      if (value instanceof Date && Number.isFinite(value.getTime())) row[key] = value.toISOString();
      else if (timestampSchema.safeParse(value).success) row[key] = new Date(value as string).toISOString();
    }
    for (const key of nullableWeightKeys) {
      // Catalog numeric(10,2) values are product-only grams. Missing, zero,
      // non-finite or malformed facts remain unknown; never invent a minimum.
      const value = row[key];
      const numeric = typeof value === "string" && /^\d+(?:\.\d{1,2})?$/.test(value) ? Number(value) : value;
      row[key] = typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0
        && numeric <= MAX_CATALOG_RETURN_UNIT_WEIGHT_GRAMS ? numeric : null;
    }
    return schema.parse(row);
  });
}

function orderIdAliases(value: string): string[] {
  const digits = /^gid:\/\/shopify\/Order\/(\d+)$/.exec(value)?.[1] ?? (/^\d+$/.test(value) ? value : null);
  return digits === null ? [value] : [...new Set([digits, `gid://shopify/Order/${digits}`])];
}
function failure(code: string, message: string): CustomerReturnLocalInspectionError { return new CustomerReturnLocalInspectionError(code, message); }
