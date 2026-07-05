/**
 * Shopify Weight Backfill Service
 *
 * One-shot (repeatable, idempotent) job that fills catalog.product_variants.weight_grams
 * from Shopify. Direction is Shopify → Echelon only (READ from Shopify, WRITE to catalog).
 *
 * Why: weight_grams is NULL across the catalog, but Shopify already holds weights for
 * most synced variants (inventoryItem.measurement.weight). Backfilling unlocks
 * weight-based shipping quotes without physically re-weighing anything.
 *
 * Safety rules:
 *   - NEVER overwrites a non-null weight_grams — manual measurements always win.
 *     The UPDATE itself is guarded with `WHERE weight_grams IS NULL`, so even a
 *     concurrent manual entry between enumeration and write cannot be clobbered.
 *   - dryRun defaults to TRUE; a dry run performs zero writes.
 *   - Never throws — every failure is collected into report.errors.
 *
 * Shopify id mapping: catalog.product_variants.shopify_variant_id (numeric Shopify
 * variant id as a string, written by catalog-backfill.service.ts). We convert it to
 * a GraphQL GID (gid://shopify/ProductVariant/<id>) and batch-fetch via nodes(ids:).
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { channelConnections, channels, productVariants } from "@shared/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

/** Shopify weight units returned by inventoryItem.measurement.weight.unit */
export type ShopifyWeightUnit = "GRAMS" | "KILOGRAMS" | "OUNCES" | "POUNDS";

export interface ShopifyWeightMeasurement {
  unit: string;
  value: number;
}

export interface WeightBackfillCandidate {
  /** Echelon variant id (catalog.product_variants.id) */
  id: number;
  sku: string | null;
  /** catalog.product_variants.shopify_variant_id — numeric Shopify variant id string, or null if unmapped */
  shopifyVariantId: string | null;
}

export interface ShopifyWeightFetchResult {
  /** shopifyVariantId (numeric string) → weight measurement */
  weights: Map<string, ShopifyWeightMeasurement>;
  /** Batch-level fetch errors (a failed batch never aborts the run) */
  errors: string[];
}

/** Injectable dependencies — tests supply fakes; production uses createShopifyWeightBackfillDeps. */
export interface ShopifyWeightBackfillDeps {
  /** Enumerate variants with weight_grams IS NULL (mapped AND unmapped), ordered by id. */
  listCandidateVariants: (limit?: number) => Promise<WeightBackfillCandidate[]>;
  /** Fetch weight measurements from Shopify for the given shopify_variant_ids. */
  fetchShopifyWeights: (shopifyVariantIds: string[]) => Promise<ShopifyWeightFetchResult>;
  /**
   * Set weight_grams for a variant ONLY if it is still NULL.
   * Returns true if a row was updated, false if the guard rejected it (already set).
   */
  updateVariantWeightIfNull: (variantId: number, grams: number) => Promise<boolean>;
}

export interface ShopifyWeightBackfillOptions {
  /** Default TRUE — a dry run computes the full report but performs zero writes. */
  dryRun?: boolean;
  /** Cap the number of candidate variants processed (useful for a pilot batch). */
  limit?: number;
  /**
   * Shopify channel to pull credentials from (channel_connections.channel_id).
   * When omitted, the first connected Shopify channel is used.
   * Only consulted by the default deps — injected deps carry their own credentials.
   */
  channelId?: number;
}

export interface ShopifyWeightBackfillReport {
  dryRun: boolean;
  /** Variants with weight_grams IS NULL that were enumerated (after limit) */
  candidates: number;
  /** Variants for which Shopify returned a usable weight measurement */
  fetched: number;
  /** Rows written (or, in dry run, rows that WOULD be written) */
  updated: number;
  /** Candidates with no shopify_variant_id mapping — cannot fetch */
  skippedNoMapping: number;
  /** Mapped variants where Shopify had no weight (missing, zero, or unknown unit) */
  skippedNoWeight: number;
  /** Update guard hit: weight_grams was set by someone else between enumeration and write */
  skippedAlreadySet: number;
  errors: string[];
  /** First 10 updated (or would-be-updated) variants for eyeballing */
  sample: Array<{ sku: string | null; grams: number }>;
}

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

/** Exact conversion factors (grams per unit) — NIST definitions. */
const GRAMS_PER_KILOGRAM = 1000;
const GRAMS_PER_OUNCE = 28.349523125;
const GRAMS_PER_POUND = 453.59237;

const SAMPLE_SIZE = 10;

/**
 * Convert a Shopify weight measurement to integer grams (rounded).
 * Returns null for unknown units or non-finite values. Zero/negative values
 * convert normally — the caller decides whether they are usable (they are not:
 * Shopify reports 0 for "no weight entered", which is useless for shipping).
 */
export function toGrams(unit: string, value: number): number | null {
  if (!Number.isFinite(value)) return null;
  switch (unit) {
    case "GRAMS":
      return Math.round(value);
    case "KILOGRAMS":
      return Math.round(value * GRAMS_PER_KILOGRAM);
    case "OUNCES":
      return Math.round(value * GRAMS_PER_OUNCE);
    case "POUNDS":
      return Math.round(value * GRAMS_PER_POUND);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the Shopify → Echelon weight backfill.
 *
 * Never throws — all failures land in report.errors. In dry-run mode the
 * updater is never called; `updated` counts the rows that WOULD be written.
 */
export async function runShopifyWeightBackfill(
  options: ShopifyWeightBackfillOptions = {},
  deps?: ShopifyWeightBackfillDeps,
): Promise<ShopifyWeightBackfillReport> {
  const dryRun = options.dryRun ?? true;

  const report: ShopifyWeightBackfillReport = {
    dryRun,
    candidates: 0,
    fetched: 0,
    updated: 0,
    skippedNoMapping: 0,
    skippedNoWeight: 0,
    skippedAlreadySet: 0,
    errors: [],
    sample: [],
  };

  try {
    // Lazy default-deps construction so importing this module (e.g. in unit
    // tests) never touches the DB singleton.
    const resolvedDeps = deps ?? (await createDefaultDeps(options.channelId));

    const candidates = await resolvedDeps.listCandidateVariants(options.limit);
    report.candidates = candidates.length;

    const mapped = candidates.filter((c) => c.shopifyVariantId != null && c.shopifyVariantId !== "");
    report.skippedNoMapping = candidates.length - mapped.length;

    if (mapped.length === 0) {
      console.log(`[ShopifyWeightBackfill] ${dryRun ? "DRY RUN" : "LIVE"}: no mapped candidates — nothing to fetch`);
      return report;
    }

    const fetchResult = await resolvedDeps.fetchShopifyWeights(mapped.map((c) => c.shopifyVariantId!));
    report.errors.push(...fetchResult.errors);

    for (const candidate of mapped) {
      const measurement = fetchResult.weights.get(candidate.shopifyVariantId!);
      if (!measurement) {
        report.skippedNoWeight++;
        continue;
      }

      const grams = toGrams(measurement.unit, measurement.value);
      if (grams == null || grams <= 0) {
        // Unknown unit, non-finite value, or Shopify's "no weight entered" zero.
        report.skippedNoWeight++;
        continue;
      }

      report.fetched++;

      if (dryRun) {
        report.updated++;
        if (report.sample.length < SAMPLE_SIZE) {
          report.sample.push({ sku: candidate.sku, grams });
        }
        continue;
      }

      try {
        const didUpdate = await resolvedDeps.updateVariantWeightIfNull(candidate.id, grams);
        if (didUpdate) {
          report.updated++;
          if (report.sample.length < SAMPLE_SIZE) {
            report.sample.push({ sku: candidate.sku, grams });
          }
        } else {
          report.skippedAlreadySet++;
        }
      } catch (err: any) {
        report.errors.push(
          `Update failed for variant ${candidate.id} (${candidate.sku ?? "no sku"}): ${err?.message ?? String(err)}`,
        );
      }
    }

    console.log(
      `[ShopifyWeightBackfill] ${dryRun ? "DRY RUN" : "LIVE"} complete: ` +
        `${report.candidates} candidates, ${report.fetched} fetched, ${report.updated} ${dryRun ? "would update" : "updated"}, ` +
        `${report.skippedNoMapping} no mapping, ${report.skippedNoWeight} no weight, ` +
        `${report.skippedAlreadySet} already set, ${report.errors.length} errors`,
    );
  } catch (err: any) {
    report.errors.push(`Weight backfill failed: ${err?.message ?? String(err)}`);
    console.error(`[ShopifyWeightBackfill] Fatal error:`, err);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Default (production) deps — DB-backed enumeration/update + Shopify GraphQL fetch
// ---------------------------------------------------------------------------

interface ShopifyGraphqlCredentials {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
}

/**
 * inventoryItem.measurement.weight requires Admin API >= 2024-03 (the REST
 * variant.weight fields were deprecated in its favor). Connections default to
 * 2024-01, so floor the version for this call. YYYY-MM strings compare
 * lexicographically, so plain string comparison is safe.
 */
const MIN_GRAPHQL_API_VERSION = "2024-07";

/** nodes(ids:) accepts up to 250 ids; 100 keeps query cost comfortably under the throttle. */
const GRAPHQL_BATCH_SIZE = 100;
const GRAPHQL_MAX_RETRIES = 3;
const GRAPHQL_RETRY_BASE_DELAY_MS = 1000;
const INTER_BATCH_DELAY_MS = 250;

const VARIANT_WEIGHTS_QUERY = /* GraphQL */ `
  query VariantWeights($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryItem {
          measurement {
            weight {
              unit
              value
            }
          }
        }
      }
    }
  }
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function variantGid(numericId: string): string {
  return `gid://shopify/ProductVariant/${numericId}`;
}

function numericIdFromGid(gid: string): string {
  const idx = gid.lastIndexOf("/");
  return idx >= 0 ? gid.slice(idx + 1) : gid;
}

/**
 * Build production deps against a Drizzle db handle. Exported so the route
 * layer can construct them with its own db import (keeps this module free of
 * the storage singleton for testability).
 */
export function createShopifyWeightBackfillDeps(
  db: DrizzleDb,
  channelId?: number,
): ShopifyWeightBackfillDeps {
  return {
    async listCandidateVariants(limit?: number): Promise<WeightBackfillCandidate[]> {
      let query = db
        .select({
          id: productVariants.id,
          sku: productVariants.sku,
          shopifyVariantId: productVariants.shopifyVariantId,
        })
        .from(productVariants)
        .where(isNull(productVariants.weightGrams))
        .orderBy(asc(productVariants.id));

      if (limit != null && limit > 0) {
        query = query.limit(limit);
      }

      return await query;
    },

    async fetchShopifyWeights(shopifyVariantIds: string[]): Promise<ShopifyWeightFetchResult> {
      const weights = new Map<string, ShopifyWeightMeasurement>();
      const errors: string[] = [];

      let creds: ShopifyGraphqlCredentials;
      try {
        creds = await resolveShopifyCredentials(db, channelId);
      } catch (err: any) {
        return { weights, errors: [err?.message ?? String(err)] };
      }

      for (let i = 0; i < shopifyVariantIds.length; i += GRAPHQL_BATCH_SIZE) {
        const batch = shopifyVariantIds.slice(i, i + GRAPHQL_BATCH_SIZE);
        try {
          const data = await shopifyGraphql(creds, VARIANT_WEIGHTS_QUERY, {
            ids: batch.map(variantGid),
          });

          for (const node of data?.nodes ?? []) {
            // nodes() returns null for ids that don't resolve (deleted variants).
            if (!node?.id) continue;
            const weight = node.inventoryItem?.measurement?.weight;
            if (weight && typeof weight.value === "number" && typeof weight.unit === "string") {
              weights.set(numericIdFromGid(node.id), { unit: weight.unit, value: weight.value });
            }
          }
        } catch (err: any) {
          errors.push(
            `Shopify weight fetch failed for batch starting at index ${i}: ${err?.message ?? String(err)}`,
          );
          // Continue with remaining batches — a failed batch only loses its own variants.
        }

        if (i + GRAPHQL_BATCH_SIZE < shopifyVariantIds.length) {
          await delay(INTER_BATCH_DELAY_MS);
        }
      }

      return { weights, errors };
    },

    async updateVariantWeightIfNull(variantId: number, grams: number): Promise<boolean> {
      // The IS NULL guard is IN the WHERE clause — a concurrent manual weight
      // entry can never be overwritten, even mid-run.
      const rows = await db
        .update(productVariants)
        .set({ weightGrams: grams, updatedAt: new Date() })
        .where(and(eq(productVariants.id, variantId), isNull(productVariants.weightGrams)))
        .returning({ id: productVariants.id });

      return rows.length > 0;
    },
  };
}

async function createDefaultDeps(channelId?: number): Promise<ShopifyWeightBackfillDeps> {
  // Dynamic import so unit tests importing this module never touch the DB singleton.
  const { db } = await import("../../storage/base");
  return createShopifyWeightBackfillDeps(db as DrizzleDb, channelId);
}

/**
 * Resolve Shopify credentials from channel_connections. When channelId is
 * omitted, uses the first connected Shopify channel (same credential source
 * as catalog-backfill.service.ts / shopify.adapter.ts).
 */
async function resolveShopifyCredentials(
  db: DrizzleDb,
  channelId?: number,
): Promise<ShopifyGraphqlCredentials> {
  const baseQuery = db
    .select({
      channelId: channelConnections.channelId,
      shopDomain: channelConnections.shopDomain,
      accessToken: channelConnections.accessToken,
      apiVersion: channelConnections.apiVersion,
    })
    .from(channelConnections)
    .innerJoin(channels, eq(channels.id, channelConnections.channelId));

  const rows: Array<{
    channelId: number;
    shopDomain: string | null;
    accessToken: string | null;
    apiVersion: string | null;
  }> = await (channelId != null
    ? baseQuery.where(and(eq(channels.provider, "shopify"), eq(channelConnections.channelId, channelId)))
    : baseQuery.where(eq(channels.provider, "shopify"))
  ).limit(1);

  const conn = rows[0];
  if (!conn?.shopDomain || !conn?.accessToken) {
    throw new Error(
      channelId != null
        ? `No Shopify credentials configured for channel ${channelId}`
        : "No connected Shopify channel found (channel_connections has no shopify row with credentials)",
    );
  }

  const connVersion = conn.apiVersion || MIN_GRAPHQL_API_VERSION;
  const apiVersion = connVersion >= MIN_GRAPHQL_API_VERSION ? connVersion : MIN_GRAPHQL_API_VERSION;

  return { shopDomain: conn.shopDomain, accessToken: conn.accessToken, apiVersion };
}

/**
 * Minimal Shopify GraphQL Admin API client with the same retry/backoff posture
 * as shopify.adapter.ts (429 Retry-After, 5xx exponential backoff) plus
 * GraphQL-level THROTTLED handling.
 */
async function shopifyGraphql(
  creds: ShopifyGraphqlCredentials,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  const url = `https://${creds.shopDomain}/admin/api/${creds.apiVersion}/graphql.json`;

  for (let attempt = 1; attempt <= GRAPHQL_MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": creds.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "2", 10);
      console.warn(`[ShopifyWeightBackfill] Rate limited, retrying in ${retryAfter}s (attempt ${attempt})`);
      await delay(retryAfter * 1000);
      continue;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      if (attempt < GRAPHQL_MAX_RETRIES && response.status >= 500) {
        const backoff = GRAPHQL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[ShopifyWeightBackfill] Server error ${response.status}, retrying in ${backoff}ms`);
        await delay(backoff);
        continue;
      }
      throw new Error(`Shopify GraphQL request failed (${response.status}): ${errorBody.substring(0, 300)}`);
    }

    const payload = await response.json();

    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      const throttled = payload.errors.some((e: any) => e?.extensions?.code === "THROTTLED");
      if (throttled && attempt < GRAPHQL_MAX_RETRIES) {
        const backoff = GRAPHQL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[ShopifyWeightBackfill] GraphQL throttled, retrying in ${backoff}ms`);
        await delay(backoff);
        continue;
      }
      const messages = payload.errors.map((e: any) => e?.message ?? "unknown").join("; ");
      throw new Error(`Shopify GraphQL errors: ${messages}`);
    }

    return payload?.data;
  }

  throw new Error(`Shopify GraphQL request failed after ${GRAPHQL_MAX_RETRIES} retries`);
}
