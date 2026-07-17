/**
 * Shopify CarrierService rate callback — interface layer.
 *
 * POST /api/shipping/rates-callback/:token
 *
 * SHADOW-SAFE BY CONSTRUCTION:
 *   - 404s unless SHIPPING_CALLBACK_TOKEN is set AND the path token matches
 *     (constant-time compare) — with no env var the endpoint does not exist.
 *   - Quotes require an ACTIVE shipping.service_level and matching ACTIVE
 *     local rate table. Provider-method routing is a later capability and is
 *     not consulted by checkout quoting in the initial rollout.
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
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  shippingQuoteSnapshots,
  warehouses,
} from "@shared/schema";
import { db } from "../../../../db";
import { deliveryWindow, type DeliveryWindow } from "../../domain/eta";
import type { RateQuoteLine, RateQuoteResult } from "../../application/rate-quote.service";
import { quoteShipment } from "../../application/shipment-quote.service";
import { localRateTableShippingRateProvider } from "../../application/shipping-rate-provider";
import { resolveShipmentLineWeights } from "../../application/shipment-weight.service";
import { weightOnlyParcelProvider } from "../../application/weight-only-parcel.provider";
import { normalizeUsPostalRegion } from "../../domain/us-geography";
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
      province: z.string().nullish(),
      province_code: z.string().nullish(),
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
  destRegion: string | null;
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
      destRegion: normalizeUsPostalRegion(
        rate.destination.province_code ?? rate.destination.province,
      ),
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

/**
 * Map Card Shellz-owned service-level quotes directly to Shopify rates.
 * Delivery estimates are keyed by service-level id. Missing promises omit
 * dates without blocking an otherwise valid rate.
 */
export function mapQuotesToShopifyRates(
  quotes: RateQuoteLine[],
  deliveryEstimates?: ReadonlyMap<number, DeliveryWindow>,
): ShopifyRate[] {
  return quotes.map((quote) => {
      const estimate = deliveryEstimates?.get(quote.serviceLevelId);
      return {
        service_name: quote.displayName,
        service_code: quote.serviceLevelCode,
        total_price: String(quote.totalCents),
        currency: quote.currency,
        ...(quote.description ? { description: quote.description } : {}),
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
        region: request.destRegion,
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

    // Delivery dates are best-effort decoration from the internal service
    // promise. Carrier-method enforcement remains a fulfillment concern.
    let deliveryEstimates: Map<number, DeliveryWindow> = new Map();
    try {
      deliveryEstimates = await loadDeliveryEstimates(originWarehouseId, rates.quotes, new Date());
    } catch (error) {
      console.error("[CarrierCallback] promise lookup failed; rates returned without delivery dates:", error);
      warnings.push(`promise lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const shopifyRates = mapQuotesToShopifyRates(rates.quotes, deliveryEstimates);
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
 * Build delivery windows from each service level's promise and the origin
 * warehouse cutoff. Carrier transit enforcement belongs to fulfillment.
 */
async function loadDeliveryEstimates(
  originWarehouseId: number,
  quotes: readonly RateQuoteLine[],
  now: Date,
): Promise<Map<number, DeliveryWindow>> {
  const estimates = new Map<number, DeliveryWindow>();
  const [warehouse] = await db
    .select({
      cutoffLocal: warehouses.orderCutoffLocal,
      timezone: warehouses.timezone,
    })
    .from(warehouses)
    .where(eq(warehouses.id, originWarehouseId))
    .limit(1);
  if (!warehouse) return estimates;

  for (const quote of quotes) {
    if (
      quote.promiseMinBusinessDays === null
      || quote.promiseMaxBusinessDays === null
    ) {
      continue;
    }
    estimates.set(quote.serviceLevelId, deliveryWindow({
      now,
      cutoffLocal: warehouse.cutoffLocal,
      timezone: warehouse.timezone,
      minBusinessDays: quote.promiseMinBusinessDays,
      maxBusinessDays: quote.promiseMaxBusinessDays,
    }));
  }
  return estimates;
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
