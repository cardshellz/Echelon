/**
 * Shadow-mode quote runner — application layer.
 *
 * Replays recent real wms.orders through the full quote pipeline
 * (packing inputs → cartonize → quoteParcels) WITHOUT touching checkout,
 * persisting one shipping.quote_snapshots row per order (source 'shadow')
 * and returning a data-readiness report: with variant dims mostly missing
 * and rate tables empty today, expect ~everything fallback/empty — the
 * report proves the pipeline runs end-to-end and quantifies exactly what
 * data capture unlocks. Design: docs/SHIPPING-ENGINE-DESIGN.md.
 *
 * Contract: never throws for data problems on a single order — each order
 * degrades to warnings and the run continues. All loaders are injectable
 * (DB defaults) so the aggregation logic is unit-testable without a DB.
 */

import { createHash } from "crypto";
import { and, desc, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { orderItems, orders, shippingQuoteSnapshots } from "@shared/schema";
import { db } from "../../../db";
import {
  cartonize,
  CARTONIZE_ENGINE,
  isCartonizeCandidateVerified,
  type CartonizeBox,
  type CartonizeCandidate,
  type CartonizeItem,
} from "../../cartonization/domain/cartonize";
import { buildCartonizeItems } from "../../cartonization/domain/build-items";
export { buildCartonizeItems } from "../../cartonization/domain/build-items";
import {
  quoteParcels,
  RATE_QUOTE_ENGINE,
  type RateQuoteResult,
} from "./rate-quote.service";
import {
  loadActiveBoxes,
  loadPackingInputs,
  resolveVariantIdsBySku,
} from "../../cartonization/infrastructure/packing-input.repository";

/** Origin used when an order has no warehouse assigned (primary warehouse). */
const DEFAULT_ORIGIN_WAREHOUSE_ID = 1;

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 50;
const TOP_WARNINGS_COUNT = 5;

export interface ShadowOrder {
  id: number;
  orderNumber: string;
  warehouseId: number | null;
  shippingPostalCode: string;
  /** Shipping the customer actually paid — wms.orders.shipping_cents. */
  shippingCents: number | null;
}

export interface ShadowOrderItem {
  sku: string;
  quantity: number;
}

export interface ShadowRunOptions {
  days?: number;
  limit?: number;
}

export interface ShadowReport {
  ordersRun: number;
  packingComplete: number;
  packingFallback: number;
  ratesFound: number;
  ratesEmpty: number;
  topWarnings: Array<{ warning: string; count: number }>;
}

/** Per-order outcome fed to the pure aggregator (exported for tests). */
export interface ShadowOrderOutcome {
  packingComplete: boolean;
  ratesFound: boolean;
  warnings: string[];
}

export interface ShadowDeps {
  loadOrders: (days: number, limit: number, now: Date) => Promise<ShadowOrder[]>;
  loadOrderItems: (orderIds: number[]) => Promise<Map<number, ShadowOrderItem[]>>;
  resolveVariantIdsBySku: typeof resolveVariantIdsBySku;
  loadPackingInputs: typeof loadPackingInputs;
  loadActiveBoxes: typeof loadActiveBoxes;
  quoteParcels: typeof quoteParcels;
  persistSnapshot: (row: typeof shippingQuoteSnapshots.$inferInsert) => Promise<void>;
  now: () => Date;
}

export async function runShadow(
  options: ShadowRunOptions = {},
  overrides: Partial<ShadowDeps> = {},
): Promise<ShadowReport> {
  const deps: ShadowDeps = {
    loadOrders: loadRecentUsOrders,
    loadOrderItems: loadShippableOrderItems,
    resolveVariantIdsBySku,
    loadPackingInputs,
    loadActiveBoxes,
    quoteParcels,
    persistSnapshot: async (row) => {
      await db.insert(shippingQuoteSnapshots).values(row);
    },
    now: () => new Date(),
    ...overrides,
  };

  const days = clampInt(options.days, 1, 365, DEFAULT_DAYS);
  const limit = clampInt(options.limit, 1, 500, DEFAULT_LIMIT);
  const now = deps.now();

  const shadowOrders = await deps.loadOrders(days, limit, now);
  if (shadowOrders.length === 0) {
    return aggregateShadowReport([]);
  }

  const itemsByOrder = await deps.loadOrderItems(shadowOrders.map((o) => o.id));

  // Resolve every SKU in the batch once, then load packing inputs once.
  const allSkus = [...itemsByOrder.values()].flat().map((line) => line.sku);
  const variantIdBySku = await deps.resolveVariantIdsBySku(allSkus);
  const packingInputs = await deps.loadPackingInputs([...variantIdBySku.values()]);

  // Box suites vary by warehouse; cache per origin so N orders ≠ N queries.
  const boxCache = new Map<number, CartonizeBox[]>();
  const boxesForWarehouse = async (warehouseId: number): Promise<CartonizeBox[]> => {
    const cached = boxCache.get(warehouseId);
    if (cached) return cached;
    const boxes = await deps.loadActiveBoxes(warehouseId);
    boxCache.set(warehouseId, boxes);
    return boxes;
  };

  const outcomes: ShadowOrderOutcome[] = [];
  for (const order of shadowOrders) {
    try {
      outcomes.push(await runShadowForOrder(order, itemsByOrder.get(order.id) ?? [], {
        variantIdBySku,
        packingInputs,
        boxesForWarehouse,
        quote: deps.quoteParcels,
        persistSnapshot: deps.persistSnapshot,
        quotedAt: now,
      }));
    } catch (error) {
      // One bad order must not sink the run — count it as fully degraded.
      console.error(`[ShadowQuote] order ${order.orderNumber} (${order.id}) failed:`, error);
      outcomes.push({
        packingComplete: false,
        ratesFound: false,
        warnings: [`shadow run failed: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }

  return aggregateShadowReport(outcomes);
}

// ---------------------------------------------------------------------------
// Per-order pipeline
// ---------------------------------------------------------------------------

interface OrderRunContext {
  variantIdBySku: Map<string, number>;
  packingInputs: Map<number, CartonizeItem>;
  boxesForWarehouse: (warehouseId: number) => Promise<CartonizeBox[]>;
  quote: typeof quoteParcels;
  persistSnapshot: ShadowDeps["persistSnapshot"];
  quotedAt: Date;
}

async function runShadowForOrder(
  order: ShadowOrder,
  lines: ShadowOrderItem[],
  ctx: OrderRunContext,
): Promise<ShadowOrderOutcome> {
  const { items, warnings: itemWarnings } = buildCartonizeItems(
    lines, ctx.variantIdBySku, ctx.packingInputs,
  );

  const originWarehouseId = order.warehouseId ?? DEFAULT_ORIGIN_WAREHOUSE_ID;
  const boxes = await ctx.boxesForWarehouse(originWarehouseId);

  const packing = cartonize(items, boxes);
  // candidates[0] is the primary strategy (fewest-parcels, or fallback).
  const candidate = packing.candidates[0];

  const rates: RateQuoteResult = await ctx.quote({
    originWarehouseId,
    destCountry: "US",
    destPostal: order.shippingPostalCode,
    parcels: candidate.parcels.map((p) => ({ billableWeightGrams: p.billableWeightGrams })),
  });

  const packingComplete = isPackingComplete(candidate);
  const ratesFound = rates.quotes.length > 0;
  const warnings = [...itemWarnings, ...candidate.warnings, ...rates.warnings];

  const requestPayload = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    items: lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      productVariantId: ctx.variantIdBySku.get(line.sku) ?? null,
    })),
  };

  try {
    await ctx.persistSnapshot({
      source: "shadow",
      destinationCountry: "US",
      destinationPostalCode: order.shippingPostalCode,
      resolvedZone: rates.zone,
      requestHash: createHash("sha256").update(JSON.stringify(requestPayload)).digest("hex"),
      requestPayload,
      packing: {
        engine: packing.engine,
        strategy: candidate.strategy,
        parcels: candidate.parcels,
        warnings: candidate.warnings,
      },
      rates: {
        engine: RATE_QUOTE_ENGINE,
        zone: rates.zone,
        quotes: rates.quotes,
        warnings: rates.warnings,
      },
      metadata: {
        engine: CARTONIZE_ENGINE,
        quotedAt: ctx.quotedAt.toISOString(),
        originWarehouseId,
        paidShippingCents: order.shippingCents,
        packingComplete,
        ratesFound,
      },
    });
  } catch (error) {
    // Snapshot is the observability payload, not the run — degrade loudly.
    console.error(`[ShadowQuote] snapshot persist failed for order ${order.id}:`, error);
    warnings.push("quote snapshot persist failed");
  }

  return { packingComplete, ratesFound, warnings };
}

/** A packing is complete only when every physical placement is verified. */
export function isPackingComplete(candidate: CartonizeCandidate): boolean {
  return isCartonizeCandidateVerified(candidate);
}

// ---------------------------------------------------------------------------
// Report aggregation (pure, exported for tests)
// ---------------------------------------------------------------------------

export function aggregateShadowReport(outcomes: ShadowOrderOutcome[]): ShadowReport {
  const counts = new Map<string, number>();
  let packingComplete = 0;
  let ratesFound = 0;

  for (const outcome of outcomes) {
    if (outcome.packingComplete) packingComplete++;
    if (outcome.ratesFound) ratesFound++;
    for (const warning of outcome.warnings) {
      const normalized = normalizeWarning(warning);
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  const topWarnings = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_WARNINGS_COUNT)
    .map(([warning, count]) => ({ warning, count }));

  return {
    ordersRun: outcomes.length,
    packingComplete,
    packingFallback: outcomes.length - packingComplete,
    ratesFound,
    ratesEmpty: outcomes.length - ratesFound,
    topWarnings,
  };
}

/**
 * Collapse per-order variability (SKUs, ids, weights, zones) so the same
 * class of problem counts as ONE warning: any whitespace-delimited token
 * containing a digit becomes '#'. Exported for tests.
 */
export function normalizeWarning(warning: string): string {
  return warning.replace(/\S*\d\S*/g, "#").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Default DB loaders
// ---------------------------------------------------------------------------

async function loadRecentUsOrders(
  days: number,
  limit: number,
  now: Date,
): Promise<ShadowOrder[]> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      warehouseId: orders.warehouseId,
      shippingPostalCode: orders.shippingPostalCode,
      shippingCents: orders.shippingCents,
    })
    .from(orders)
    .where(and(
      gte(orders.createdAt, since),
      isNotNull(orders.shippingPostalCode),
      sql`upper(trim(${orders.shippingCountry})) in ('US', 'USA', 'UNITED STATES')`,
    ))
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  return rows
    .filter((row) => row.shippingPostalCode != null && row.shippingPostalCode.trim() !== "")
    .map((row) => ({ ...row, shippingPostalCode: (row.shippingPostalCode as string).trim() }));
}

async function loadShippableOrderItems(
  orderIds: number[],
): Promise<Map<number, ShadowOrderItem[]>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({
      orderId: orderItems.orderId,
      sku: orderItems.sku,
      quantity: orderItems.quantity,
      requiresShipping: orderItems.requiresShipping,
    })
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds));

  const byOrder = new Map<number, ShadowOrderItem[]>();
  for (const row of rows) {
    // Digital/membership lines (requires_shipping = 0) never pack.
    if (row.requiresShipping !== 1 || row.quantity <= 0) continue;
    const list = byOrder.get(row.orderId) ?? [];
    list.push({ sku: row.sku, quantity: row.quantity });
    byOrder.set(row.orderId, list);
  }
  return byOrder;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
