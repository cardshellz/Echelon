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
 *   - No external calls — cartonizer + rate tables only (DB reads).
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
} from "@shared/schema";
import { db } from "../../../../db";
import { cartonize, type CartonizeItem } from "../../domain/cartonize";
import { rateComboKey } from "../../domain/rate-selection";
import {
  quoteParcels,
  type RateQuoteLine,
  type RateQuoteResult,
} from "../../application/rate-quote.service";
import {
  loadActiveBoxes,
  loadPackingInputs,
  resolveVariantIdsBySku,
} from "../../application/packing-input.repository";

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
  items: Array<{ sku: string; quantity: number; grams: number | null }>;
  /** Lines dropped because they carried no SKU — surfaces as a warning. */
  skippedNoSkuCount: number;
}

export type ParseRateRequestResult =
  | { ok: true; request: ParsedRateRequest }
  | { ok: false; error: string };

/**
 * Parse Shopify's rate request body. Items without a SKU cannot be resolved
 * against the catalog: they are skipped (with the whole request rejected when
 * NO item carries a SKU — an unpriceable cart must not get a partial quote).
 */
export function parseShopifyRateRequest(body: unknown): ParseRateRequestResult {
  const parsed = shopifyRateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: `invalid CarrierService payload: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  }
  const rate = parsed.data.rate;
  const items = rate.items
    .filter((item) => typeof item.sku === "string" && item.sku.trim() !== "")
    .map((item) => ({
      sku: (item.sku as string).trim(),
      quantity: item.quantity,
      grams: typeof item.grams === "number" && item.grams > 0 ? item.grams : null,
    }));
  if (items.length === 0) {
    return { ok: false, error: "no items with a SKU in rate request" };
  }
  return {
    ok: true,
    request: {
      destPostal: rate.destination.postal_code.trim(),
      destCountry: rate.destination.country.trim().toUpperCase(),
      items,
      skippedNoSkuCount: rate.items.length - items.length,
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
 */
export function mapQuotesToShopifyRates(
  quotes: RateQuoteLine[],
  activeMethods: ActiveServiceLevelMethod[],
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
    .map(({ method, quote }) => ({
      service_name: method.displayName,
      service_code: method.levelCode,
      total_price: String(quote.totalCents),
      currency: quote.currency,
      ...(method.description ? { description: method.description } : {}),
    }));
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
      body, request: null, packing: null, rates: null,
      shopifyRates: [], warnings: [parsed.error],
    });
    return [];
  }
  const request = parsed.request;
  const warnings: string[] = [];
  if (request.skippedNoSkuCount > 0) {
    warnings.push(`${request.skippedNoSkuCount} line(s) without a SKU skipped; quote may under-pack`);
  }

  try {
    const variantIdBySku = await resolveVariantIdsBySku(request.items.map((i) => i.sku));
    const packingInputs = await loadPackingInputs([...variantIdBySku.values()]);

    let syntheticId = -1;
    const items: CartonizeItem[] = request.items.map((line) => {
      const variantId = variantIdBySku.get(line.sku);
      const input = variantId !== undefined ? packingInputs.get(variantId) : undefined;
      if (input) return { ...input, quantity: line.quantity };
      warnings.push(`sku ${line.sku} not found in catalog; used stub item`);
      return {
        productVariantId: syntheticId--,
        sku: line.sku,
        quantity: line.quantity,
        // Shopify's per-unit grams keeps the fallback parcel honest.
        weightGrams: line.grams,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        shippingGroupCode: null,
        shipsInOwnContainer: false,
        riderEligible: false,
        riderVoidCm3: null,
        riderVoidMaxWeightGrams: null,
        riderVoidMaxItems: null,
      };
    });

    const originWarehouseId = callbackOriginWarehouseId();
    const boxes = await loadActiveBoxes(originWarehouseId);
    const packing = cartonize(items, boxes);
    const candidate = packing.candidates[0];

    const rates = await quoteParcels({
      originWarehouseId,
      destCountry: request.destCountry,
      destPostal: request.destPostal,
      parcels: candidate.parcels.map((p) => ({ billableWeightGrams: p.billableWeightGrams })),
    });

    const activeMethods = await loadActiveServiceLevelMethods();
    const shopifyRates = mapQuotesToShopifyRates(rates.quotes, activeMethods);
    warnings.push(...candidate.warnings, ...rates.warnings);

    await persistCheckoutSnapshot({
      body, request,
      packing: { engine: packing.engine, strategy: candidate.strategy, parcels: candidate.parcels, warnings: candidate.warnings },
      rates,
      shopifyRates, warnings,
    });
    return shopifyRates;
  } catch (error) {
    console.error("[CarrierCallback] quote pipeline failed:", error);
    warnings.push(`quote pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
    await persistCheckoutSnapshot({
      body, request, packing: null, rates: null, shopifyRates: [], warnings,
    });
    return [];
  }
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
  packing: unknown | null;
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
      packing: input.packing,
      rates: input.rates
        ? { zone: input.rates.zone, quotes: input.rates.quotes, warnings: input.rates.warnings }
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
