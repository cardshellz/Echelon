import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  CUSTOMER_RETURN_INSPECTION_LIMITS as limits, CustomerReturnLocalInspectionError,
  customerReturnInspectionShopSchema, customerReturnLocalOrderSchema, customerReturnLocalLineSchema,
  customerReturnLocalWmsItemSchema, customerReturnLocalRootClaimSchema, customerReturnLocalLegacyClaimSchema,
  customerReturnLocalUnallocatedReturnSchema, customerReturnLocalInventoryReturnSchema,
  customerReturnLocalBindingSchema, customerReturnLocalPackageItemSchema, customerReturnLocalPackageLabelSchema,
  customerReturnLocalCarrierEventSchema, customerReturnLocalInspectionSnapshotSchema,
  type CustomerReturnInspectionShop, type CustomerReturnLocalInspectionReader,
  type CustomerReturnLocalInspectionSnapshot,
} from "../application/customer-return-local-inspection.ports";
import { buildCustomerReturnOrderNumberAliases, CustomerReturnOrderReferenceError } from "../domain/customer-return-order-reference";
import { inspectionQueries as queries } from "./customer-return-local-inspection.queries";
import { deriveLocalInspectionIssues } from "./customer-return-local-inspection.issues";

const positiveId = z.number().int().positive().safe();
const inputSchema = z.object({ channelId: positiveId, connectionId: positiveId, orderReference: z.string() }).strict();
const approvedDomainsSchema = z.array(z.string().trim().toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/)).max(limits.shops)
  .refine(domains => new Set(domains).size === domains.length);
const configuredShopSchema = customerReturnInspectionShopSchema.extend({
  type: z.string(), provider: z.string(), status: z.string(),
  connectionCount: positiveId, hasCredentials: z.boolean(), isDropship: z.boolean(),
}).strict();
const localOrderRowSchema = customerReturnLocalOrderSchema.extend({ isDropship: z.boolean() }).strict();
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
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) throw failure("RETURN_INSPECTION_INPUT_INVALID", "Select a configured shop and enter an exact order reference.");
      const input = parsed.data;
      const aliases = buildCustomerReturnOrderNumberAliases(input.orderReference);
      if (this.domains.length === 0) throw failure("RETURN_INSPECTION_CONFIGURATION_REQUIRED", "Private live-order testing requires an approved Shopify shop.");
      return this.snapshot(async client => {
        const shops = await this.loadShops(client);
        const shop = shops.find(candidate => candidate.channelId === input.channelId && candidate.connectionId === input.connectionId);
        if (!shop) throw failure("RETURN_INSPECTION_SHOP_UNAVAILABLE", "The selected shop is not configured for private return testing.");
        const orders = await readRows(client, localOrderRowSchema, queries.order, [shop.channelId, aliases], 2,
          ["omsOrderId", "channelId"], ["purchasedAt", "cancelledAt"]);
        if (orders.length > 1) throw failure("RETURN_INSPECTION_ORDER_AMBIGUOUS", "The order reference matches more than one order in this shop.");
        if (orders.length === 0) return null;
        const { isDropship, ...order } = orders[0];
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
    const lines = await readRows(client, customerReturnLocalLineSchema, queries.lines, [orderId, limits.lines + 1], limits.lines,
      ["omsOrderLineId", "quantity"]);
    const wmsItems = await readRows(client, customerReturnLocalWmsItemSchema, queries.wmsItems,
      [orderId, String(orderId), limits.wmsItems + 1], limits.wmsItems,
      ["wmsOrderId", "wmsOrderItemId", "omsOrderLineId", "channelId", "quantity", "fulfilledQuantity"]);
    const itemIds = wmsItems.map(item => item.wmsOrderItemId);
    const rootClaims = await readRows(client, customerReturnLocalRootClaimSchema, queries.rootClaims,
      [orderId, itemIds, limits.claims + 1], limits.claims,
      ["claimId", "authorizationId", "authorizationLineId", "channelId", "omsOrderId", "omsOrderLineId", "wmsOrderItemId", "quantity"]);
    const legacyClaims = await readRows(client, customerReturnLocalLegacyClaimSchema, queries.legacyClaims,
      [orderId, String(orderId), itemIds, unique(wmsItems.map(item => item.wmsOrderId)), limits.claims + 1], limits.claims,
      ["returnId", "returnItemId", "wmsOrderId", "wmsOrderItemId", "omsOrderLineId", "expectedQuantity", "receivedQuantity"]);
    const unallocatedReturns = await readRows(client, customerReturnLocalUnallocatedReturnSchema, queries.unallocatedReturns,
      [String(orderId), unique(wmsItems.map(item => item.wmsOrderId)), limits.claims + 1], limits.claims,
      ["returnId", "wmsOrderId"]);
    const inventoryReturnEvidence = await readRows(client, customerReturnLocalInventoryReturnSchema, queries.inventoryReturns,
      [unique(wmsItems.map(item => item.wmsOrderId)), itemIds, String(orderId), limits.claims + 1], limits.claims,
      ["transactionId", "wmsOrderId", "wmsOrderItemId", "quantityDelta"], ["occurredAt"]);
    const fulfillmentBindings = await readRows(client, customerReturnLocalBindingSchema, queries.bindings,
      [orderId, shop.channelId, orderIdAliases(order.externalOrderId), limits.bindings + 1], limits.bindings,
      ["bindingId", "parentId", "sourceChannelId", "omsOrderLineId", "wmsOrderItemId", "physicalShipmentId", "physicalShipmentItemId", "quantity"]);
    const packageItems = await readRows(client, customerReturnLocalPackageItemSchema, queries.packageItems,
      [itemIds, lines.map(line => line.omsOrderLineId), uniquePresent(fulfillmentBindings.map(binding => binding.physicalShipmentItemId)),
        uniquePresent(fulfillmentBindings.map(binding => binding.physicalShipmentId)), limits.packageItems + 1], limits.packageItems,
      ["physicalShipmentItemId", "physicalShipmentId", "wmsOrderItemId", "omsOrderLineId", "legacyShipmentItemId", "legacyShipmentId",
        "replacementForOrderItemId", "correctionForPhysicalShipmentItemId", "originalQuantity", "effectiveQuantity"]);
    const packageLabels = await readRows(client, customerReturnLocalPackageLabelSchema, queries.labels,
      [unique(packageItems.map(item => item.physicalShipmentId)), limits.labels + 1], limits.labels,
      ["linkId", "labelId", "physicalShipmentId"], ["voidedAt"]);
    const carrierEvents = await readRows(client, customerReturnLocalCarrierEventSchema, queries.events,
      [unique(packageLabels.map(label => label.labelId)), limits.events + 1], limits.events,
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
  values: unknown[], maximum: number, integerKeys: readonly string[] = [], timestampKeys: readonly string[] = []): Promise<z.output<T>[]> {
  const result = await client.query(text, values);
  if (!result || !Array.isArray(result.rows)) throw new z.ZodError([]);
  if (result.rows.length > maximum) throw failure("RETURN_INSPECTION_EVIDENCE_LIMIT", "This order has more evidence than private inspection can safely review.");
  return result.rows.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new z.ZodError([]);
    const row = { ...raw };
    for (const key of integerKeys) {
      const value = row[key];
      if (typeof value === "string" && /^-?\d+$/.test(value)) row[key] = Number(value);
    }
    for (const key of timestampKeys) {
      const value = row[key];
      if (value instanceof Date && Number.isFinite(value.getTime())) row[key] = value.toISOString();
    }
    return schema.parse(row);
  });
}

function unique(values: readonly number[]): number[] { return [...new Set(values)]; }
function uniquePresent(values: readonly (number | null)[]): number[] { return unique(values.filter((value): value is number => value !== null)); }
function orderIdAliases(value: string): string[] {
  const digits = /^gid:\/\/shopify\/Order\/(\d+)$/.exec(value)?.[1] ?? (/^\d+$/.test(value) ? value : null);
  return digits === null ? [value] : [...new Set([digits, `gid://shopify/Order/${digits}`])];
}
function failure(code: string, message: string): CustomerReturnLocalInspectionError { return new CustomerReturnLocalInspectionError(code, message); }
