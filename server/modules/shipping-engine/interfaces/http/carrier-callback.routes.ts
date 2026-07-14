/**
 * Shopify CarrierService rate callback — interface layer.
 *
 * POST /api/shipping/rates-callback/:token
 *
 * SHADOW-SAFE BY CONSTRUCTION:
 *   - 404s unless SHIPPING_CALLBACK_TOKEN is set AND the path token matches
 *     (constant-time compare) — with no env var the endpoint does not exist.
 *   - Quotes only map through ACTIVE shipping.service_levels via their
 *     service_level_methods — until levels are activated in admin the
 *     response is always { rates: [] }, so registering the route (or even
 *     pointing Shopify at it) sells nothing by accident.
 *
 * HARD RULES (checkout is latency- and failure-sensitive):
 *   - No external calls — Echelon catalog weights + local rate tables only.
 *   - Responds within ~RESPONSE_DEADLINE_MS; a slow quote returns { rates: [] }
 *     while the pipeline finishes in the background for the snapshot.
 *   - NEVER throws / never 5xxs a valid token: any failure degrades to
 *     200 { rates: [] } + console.error + best-effort snapshot.
 *   - Every request lands in shipping.quote_snapshots (source 'checkout') —
 *     that is the calibration dataset.
 *
 * NOT registered by default — server/routes.ts wires it (before auth
 * middleware; it is an unauthenticated webhook-style endpoint like the
 * subscription webhooks). Design: docs/SHIPPING-ENGINE-DESIGN.md.
 */

import { createHash, timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  shippingQuoteSnapshots,
  shippingServiceLevelMethods,
  shippingServiceLevels,
  shippingTransitMatrix,
  warehouses,
} from "@shared/schema";
import { db } from "../../../../db";
import { deliveryWindow, type DeliveryWindow } from "../../domain/eta";
import { rateComboKey } from "../../domain/rate-selection";
import type { RateQuoteLine, RateQuoteResult } from "../../application/rate-quote.service";
import { quoteShipment } from "../../application/shipment-quote.service";
import { localRateTableShippingRateProvider } from "../../application/shipping-rate-provider";
import { resolveShipmentLineWeights } from "../../application/shipment-weight.service";
import { weightOnlyParcelProvider } from "../../application/weight-only-parcel.provider";
import { loadCatalogWeightsBySku } from "../../infrastructure/catalog-weight.repository";

/** Respond by this deadline even if the quote pipeline is still running. */
const RESPONSE_DEADLINE_MS = 2000;

/**
 * Origin warehouse for checkout quotes. Shopify sends an origin ADDRESS,
 * not our warehouse id; until multi-origin routing exists every checkout
 * quote prices from the primary warehouse (env-overridable).
 */
function callbackOriginWarehouseId(): number {
  const raw = Number(process.env.SHIPPING_CALLBACK_ORIGIN_WAREHOUSE_ID);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

// ---------------------------------------------------------------------------
// Pure parts (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Constant-time token gate. False when the expected token is unset/blank —
 * the endpoint must not exist without explicit configuration. Hashing both
 * sides first makes the comparison length-independent.
 */
export function isCallbackTokenAuthorized(
  expectedToken: string | undefined,
  providedToken: string,
): boolean {
  if (!expectedToken || expectedToken.trim() === "") return false;
  const expected = createHash("sha256").update(expectedToken).digest();
  const provided = createHash("sha256").update(providedToken).digest();
  return timingSafeEqual(expected, provided);
}

/** Shopify CarrierService rate request (the subset the engine consumes). */
const shopifyRateRequestSchema = z.object({
  rate: z.object({
    origin: z.object({
      postal_code: z.string().nullish(),
      country: z.string().nullish(),
    }).passthrough().nullish(),
    destination: z.object({
      postal_code: z.string().min(1),
      country: z.string().min(1),
    }).passthrough(),
    items: z.array(z.object({
      sku: z.string().nullish(),
      quantity: z.number().int().positive(),
      grams: z.number().nullish(),
      price: z.number().nullish(),
    }).passthrough()).min(1),
  }).passthrough(),
});

export interface ParsedRateRequest {
  destPostal: string;
  destCountry: string;
  items: Array<{ sku: string | null; quantity: number; grams: number | null }>;
}

export type ParseRateRequestResult =
  | { ok: true; request: ParsedRateRequest }
  | { ok: false; error: string };

/**
 * Parse Shopify's rate request body. SKU resolves canonical Echelon weight;
 * Shopify grams are a transition fallback. SKU remains optional and no line is
 * silently skipped from weight resolution.
 */
export function parseShopifyRateRequest(body: unknown): ParseRateRequestResult {
  const parsed = shopifyRateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: `invalid CarrierService payload: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  const rate = parsed.data.rate;
  const items = rate.items.map((item) => ({
    sku: typeof item.sku === "string" && item.sku.trim() !== ""
      ? item.sku.trim()
      : null,
    quantity: item.quantity,
    grams: typeof item.grams === "number" && item.grams > 0 ? item.grams : null,
  }));
  return {
    ok: true,
    request: {
      destPostal: rate.destination.postal_code.trim(),
      destCountry: rate.destination.country.trim().toUpperCase(),
      items,
    },
  };
}

export interface ShopifyRate {
  service_name: string;
  service_code: string;
  /** Total in cents, stringified — Shopify's CarrierService contract. */
  total_price: string;
  currency: string;
  description?: string;
  /** ISO "yyyy-mm-dd"; present only when a transit estimate exists. */
  min_delivery_date?: string;
  max_delivery_date?: string;
}

export interface ActiveServiceLevelMethod {
  levelCode: string;
  displayName: string;
  description: string | null;
  sortOrder: number;
  carrier: string;
  serviceCode: string;
}

/**
 * Map engine quotes to sellable Shopify rates through ACTIVE service levels.
 * A quote whose (carrier, serviceCode) is not attached to an active level is
 * excluded — no active levels means an empty response, by design. When
 * multiple carrier quotes satisfy one level, the cheapest fulfills it.
 *
 * `deliveryEstimates` (keyed by rateComboKey of the FULFILLING quote's
 * carrier/serviceCode) attaches min/max_delivery_date when a transit estimate
 * exists; an absent entry means the rate goes out without dates — never
 * blocked, never guessed.
 */
export function mapQuotesToShopifyRates(
  quotes: RateQuoteLine[],
  activeMethods: ActiveServiceLevelMethod[],
  deliveryEstimates?: ReadonlyMap<string, DeliveryWindow>,
): ShopifyRate[] {
  const quoteByCombo = new Map<string, RateQuoteLine>();
  for (const quote of quotes) {
    const key = rateComboKey(quote.carrier, quote.serviceCode);
    const incumbent = quoteByCombo.get(key);
    if (!incumbent || quote.totalCents < incumbent.totalCents) quoteByCombo.set(key, quote);
  }

  const bestByLevel = new Map<string, { method: ActiveServiceLevelMethod; quote: RateQuoteLine }>();
  for (const method of activeMethods) {
    const quote = quoteByCombo.get(rateComboKey(method.carrier, method.serviceCode));
    if (!quote) continue;
    const incumbent = bestByLevel.get(method.levelCode);
    if (!incumbent || quote.totalCents < incumbent.quote.totalCents) {
      bestByLevel.set(method.levelCode, { method, quote });
    }
  }

  return [...bestByLevel.values()]
    .sort((a, b) =>
      a.method.sortOrder - b.method.sortOrder
      || a.method.levelCode.localeCompare(b.method.levelCode))
    .map(({ method, quote }) => {
      const estimate = deliveryEstimates?.get(rateComboKey(quote.carrier, quote.serviceCode));
      return {
        service_name: method.displayName,
        service_code: method.levelCode,
        total_price: String(quote.totalCents),
        currency: quote.currency,
        ...(method.description ? { description: method.description } : {}),
        ...(estimate ? { min_delivery_date: estimate.minDate, max_delivery_date: estimate.maxDate } : {}),
      };
    });
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function registerCarrierCallbackRoutes(app: Express): void {
  app.post("/api/shipping/rates-callback/:token", async (req: Request, res: Response) => {
    if (!isCallbackTokenAuthorized(process.env.SHIPPING_CALLBACK_TOKEN, req.params.token)) {
      return res.status(404).json({ error: { code: "NOT_FOUND" } });
    }

    // Respond by the deadline no matter what; the pipeline keeps running
    // in the background so the snapshot still lands.
    let responded = false;
    const respond = (rates: ShopifyRate[]): void => {
      if (responded) return;
      responded = true;
      res.status(200).json({ rates });
    };
    const deadline = setTimeout(() => {
      console.error("[CarrierCallback] deadline exceeded; returned empty rates");
      respond([]);
    }, RESPONSE_DEADLINE_MS);

    try {
      const rates = await computeCheckoutRates(req.body);
      respond(rates);
    } catch (error) {
      // computeCheckoutRates is defensive; this is the belt-and-suspenders.
      console.error("[CarrierCallback] unexpected failure:", error);
      respond([]);
    } finally {
      clearTimeout(deadline);
    }
    return undefined;
  });
}

/**
 * Full checkout quote pipeline. Never throws: every failure degrades to []
 * with a console.error, and every request gets a best-effort snapshot
 * (source 'checkout') regardless of outcome.
 */
async function computeCheckoutRates(body: unknown): Promise<ShopifyRate[]> {
  const parsed = parseShopifyRateRequest(body);
  if (!parsed.ok) {
    console.error(`[CarrierCallback] ${parsed.error}`);
    await persistCheckoutSnapshot({
      body, request: null, parcelPlan: null, rates: null,
      shopifyRates: [], warnings: [parsed.error],
    });
    return [];
  }
  const request = parsed.request;
  const warnings: string[] = [];

  try {
    const originWarehouseId = callbackOriginWarehouseId();
    let catalogWeightBySku = new Map<string, number | null>();
    try {
      catalogWeightBySku = await loadCatalogWeightsBySku(
        request.items.flatMap((line) => line.sku ? [line.sku] : []),
      );
    } catch (error) {
      console.error("[CarrierCallback] catalog weight lookup failed; using channel weights:", error);
      warnings.push("Echelon catalog weight lookup failed; used channel weights");
    }
    const weightedLines = resolveShipmentLineWeights(
      request.items.map((line) => ({
        sku: line.sku,
        quantity: line.quantity,
        channelWeightGrams: line.grams,
      })),
      catalogWeightBySku,
    );
    const shipmentQuote = await quoteShipment({
      channel: "shopify",
      originWarehouseId,
      destination: {
        country: request.destCountry,
        postalCode: request.destPostal,
      },
      lines: weightedLines,
    }, {
      parcelProvider: weightOnlyParcelProvider,
      rateProvider: localRateTableShippingRateProvider,
    });
    if (!shipmentQuote.ok) {
      warnings.push(...shipmentQuote.errors);
      await persistCheckoutSnapshot({
        body, request, parcelPlan: null, rates: null,
        shopifyRates: [], warnings,
      });
      return [];
    }
    const { parcelPlan, rates } = shipmentQuote;

    // Delivery dates are best-effort decoration: a transit lookup failure (or
    // simply no matching transit rows) must never block or degrade the rates.
    let deliveryEstimates: Map<string, DeliveryWindow> = new Map();
    try {
      deliveryEstimates = await loadDeliveryEstimates(originWarehouseId, rates.zone, new Date());
    } catch (error) {
      console.error("[CarrierCallback] transit lookup failed; rates returned without delivery dates:", error);
      warnings.push(`transit lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const activeMethods = await loadActiveServiceLevelMethods();
    const shopifyRates = mapQuotesToShopifyRates(rates.quotes, activeMethods, deliveryEstimates);
    warnings.push(...parcelPlan.warnings, ...rates.warnings);

    await persistCheckoutSnapshot({
      body, request,
      parcelPlan,
      rates,
      shopifyRates, warnings,
    });
    return shopifyRates;
  } catch (error) {
    console.error("[CarrierCallback] quote pipeline failed:", error);
    warnings.push(`quote pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
    await persistCheckoutSnapshot({
      body, request, parcelPlan: null, rates: null, shopifyRates: [], warnings,
    });
    return [];
  }
}

/**
 * Delivery windows per (carrier, serviceCode) combo for the resolved zone —
 * ONE query loads every transit row for (origin warehouse, zone) joined with
 * the warehouse's cutoff/timezone, then the pure ETA math runs per row.
 * No zone (unresolved destination) → empty map → rates go out without dates.
 */
async function loadDeliveryEstimates(
  originWarehouseId: number,
  zone: string | null,
  now: Date,
): Promise<Map<string, DeliveryWindow>> {
  const estimates = new Map<string, DeliveryWindow>();
  if (zone === null) return estimates;

  const rows = await db
    .select({
      carrier: shippingTransitMatrix.carrier,
      serviceCode: shippingTransitMatrix.serviceCode,
      minBusinessDays: shippingTransitMatrix.minBusinessDays,
      maxBusinessDays: shippingTransitMatrix.maxBusinessDays,
      cutoffLocal: warehouses.orderCutoffLocal,
      timezone: warehouses.timezone,
    })
    .from(shippingTransitMatrix)
    .innerJoin(warehouses, eq(warehouses.id, shippingTransitMatrix.originWarehouseId))
    .where(and(
      eq(shippingTransitMatrix.originWarehouseId, originWarehouseId),
      eq(shippingTransitMatrix.destinationZone, zone),
    ));

  for (const row of rows) {
    estimates.set(rateComboKey(row.carrier, row.serviceCode), deliveryWindow({
      now,
      cutoffLocal: row.cutoffLocal,
      timezone: row.timezone,
      minBusinessDays: row.minBusinessDays,
      maxBusinessDays: row.maxBusinessDays,
    }));
  }
  return estimates;
}

/** Active-level methods, joined for the quote→rate mapping. */
async function loadActiveServiceLevelMethods(): Promise<ActiveServiceLevelMethod[]> {
  const rows = await db
    .select({
      levelCode: shippingServiceLevels.code,
      displayName: shippingServiceLevels.displayName,
      description: shippingServiceLevels.description,
      sortOrder: shippingServiceLevels.sortOrder,
      carrier: shippingServiceLevelMethods.carrier,
      serviceCode: shippingServiceLevelMethods.serviceCode,
    })
    .from(shippingServiceLevelMethods)
    .innerJoin(shippingServiceLevels, eq(shippingServiceLevels.id, shippingServiceLevelMethods.serviceLevelId))
    .where(and(
      eq(shippingServiceLevels.isActive, true),
      eq(shippingServiceLevelMethods.isActive, true),
    ));
  return rows;
}

/** Best-effort snapshot — a persistence failure must never affect checkout. */
async function persistCheckoutSnapshot(input: {
  body: unknown;
  request: ParsedRateRequest | null;
  parcelPlan: unknown | null;
  rates: RateQuoteResult | null;
  shopifyRates: ShopifyRate[];
  warnings: string[];
}): Promise<void> {
  try {
    const requestPayload = input.request
      ? { destPostal: input.request.destPostal, destCountry: input.request.destCountry, items: input.request.items }
      : { unparsedBody: safeJsonable(input.body) };
    await db.insert(shippingQuoteSnapshots).values({
      source: "checkout",
      destinationCountry: normalizeSnapshotCountry(input.request?.destCountry),
      destinationPostalCode: input.request?.destPostal ?? null,
      resolvedZone: input.rates?.zone ?? null,
      requestHash: createHash("sha256").update(JSON.stringify(requestPayload)).digest("hex"),
      requestPayload,
      packing: input.parcelPlan,
      rates: input.rates
        ? {
            rateBook: input.rates.rateBook,
            zone: input.rates.zone,
            quotes: input.rates.quotes,
            warnings: input.rates.warnings,
          }
        : null,
      metadata: {
        shopifyRates: input.shopifyRates,
        ratesReturned: input.shopifyRates.length,
        warnings: input.warnings,
      },
    });
  } catch (error) {
    console.error("[CarrierCallback] snapshot persist failed:", error);
  }
}

/** destination_country is varchar(2); anything unusable snapshots as US default. */
function normalizeSnapshotCountry(country: string | undefined): string {
  return country && /^[A-Z]{2}$/.test(country) ? country : "US";
}

/** Body already passed express.json, but guard against exotic values. */
function safeJsonable(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}
