/**
 * Re-link stale Shopify variant / inventory-item ids (Wave 1, sync-error tail).
 *
 * WHY: when a variant is deleted and recreated in Shopify (relist, product
 * rebuild), Shopify mints NEW product/variant/inventory_item ids. Our stored
 * mappings keep the old ids, and every inventory push then 404s forever:
 *   "Shopify API POST /inventory_levels/set.json failed (404)"
 * (prod examples: ARM-ENV-SGL-C700, EG-SLV-STD-C10000, ARM-ENV-GRD-C60).
 *
 * The inventory push resolves the id as
 *   channel_feeds.channel_inventory_item_id  →  fallback
 *   product_variants.shopify_inventory_item_id
 * (echelon-sync-orchestrator.service.ts), so BOTH must be healed, plus the
 * channel_listings external ids used by the listing connector.
 *
 * WHAT IT DOES, per Shopify channel with a connection:
 *   1. Pages the live catalog (GET /admin/api/{v}/products.json, Link-header
 *      pagination) and builds SKU → {productId, variantId, inventoryItemId}.
 *   2. Loads local mappings (product_variants ⋈ channel_feeds ⋈
 *      channel_listings) and diffs them against live.
 *   3. Reports per-SKU: RELINK (drift, healable), OK, MISSING_IN_SHOPIFY
 *      (sku no longer live — needs relist or local archive), PLACEHOLDER
 *      (SHOPIFY-<old-variant-id> skus imported without a real SKU — cannot
 *      match by SKU, manual fix), AMBIGUOUS (sku appears on >1 live variant).
 *   4. --apply: single transaction per channel; updates channel_feeds
 *      (product/variant/inventory-item ids, last_synced_qty=NULL to force the
 *      next sweep to push through the drift-lock), channel_listings external
 *      ids, and — ONLY for the provider-default channel (channels.is_default,
 *      the store product_variants mirrors) — the product_variants shopify_*
 *      columns.
 *
 * SAFETY: DRY-RUN by default; UPDATE-only (never creates or deletes rows);
 * idempotent — a re-run after apply reports zero RELINK rows. Values like
 * 'undefined'/'null'/'' (legacy backfill garbage) are treated as absent.
 *
 *   npx tsx scripts/relink-shopify-variant-ids.ts                 # dry-run, all shopify channels
 *   npx tsx scripts/relink-shopify-variant-ids.ts --channel=36    # scope to one channel
 *   npx tsx scripts/relink-shopify-variant-ids.ts --sku=ARM-ENV-SGL-C700,EG-SLV-STD-C10000
 *   npx tsx scripts/relink-shopify-variant-ids.ts --archive-missing            # + plan retirement of
 *                                                  # mappings whose product is GONE from the live store
 *                                                  # (discontinued SKUs, over-broad CA backfill rows);
 *                                                  # see planArchive() for the two safety gates
 *   npx tsx scripts/relink-shopify-variant-ids.ts --apply         # WRITE (combine with flags above)
 *
 * Connection: EXTERNAL_DATABASE_URL (per CLAUDE.md), falling back to DATABASE_URL.
 * Verify after apply: re-run without --apply (expect zero RELINK rows), then
 * watch the next sync sweep — the 404 group should clear.
 */

import pg from "pg";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

const DEFAULT_API_VERSION = "2024-01"; // matches shopify.adapter.ts
const PAGE_LIMIT = 250;
const PAGE_DELAY_MS = 350; // REST bucket is ~2 req/s
const MAX_429_RETRIES = 5;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliOptions {
  apply: boolean;
  channelId: number | null;
  skus: string[] | null;
  /** Also retire mappings whose product is GONE from the live store (see planArchive). */
  archiveMissing: boolean;
}

export function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = { apply: false, channelId: null, skus: null, archiveMissing: false };
  for (const arg of argv) {
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--archive-missing") opts.archiveMissing = true;
    else if (arg.startsWith("--channel=")) {
      opts.channelId = Number(arg.split("=")[1]) || null;
    } else if (arg.startsWith("--sku=")) {
      const skus = arg
        .slice("--sku=".length)
        .split(",")
        .map((s) => normalizeSku(s))
        .filter((s): s is string => s !== null);
      opts.skus = skus.length > 0 ? skus : null;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function normalizeSku(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const sku = raw.trim().toUpperCase();
  return sku.length > 0 ? sku : null;
}

/**
 * Legacy backfills stored String(undefined) → the literal 'undefined'
 * (catalog-backfill.service.ts stringifies unconditionally). Treat that,
 * 'null', and '' as absent so they always count as drift.
 */
export function isAbsentExternalValue(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const v = value.trim().toLowerCase();
  return v === "" || v === "undefined" || v === "null";
}

/** Import-time placeholder for Shopify variants that had no SKU — encodes the OLD variant id. */
export function isPlaceholderSku(sku: string): boolean {
  return sku.toUpperCase().startsWith("SHOPIFY-");
}

export interface LiveVariantIds {
  productId: string;
  variantId: string;
  inventoryItemId: string | null;
}

export interface LiveSkuMap {
  bySku: Map<string, LiveVariantIds>;
  /** SKUs present on more than one live variant — ambiguous, never auto-relinked. */
  duplicateSkus: Set<string>;
  /**
   * EVERY live variant id, including SKU-less and duplicate-SKU variants.
   * Archive safety-check: a mapping whose stored id is in here points at a
   * LIVE product (it just can't be matched by SKU) and must never be retired.
   */
  liveVariantIds: Set<string>;
  variantsWithoutSku: number;
}

/** Build SKU → live ids from paginated /products.json payloads. */
export function buildLiveSkuMap(
  products: Array<{ id: number | string; variants?: Array<Record<string, unknown>> }>,
): LiveSkuMap {
  const bySku = new Map<string, LiveVariantIds>();
  const duplicateSkus = new Set<string>();
  const liveVariantIds = new Set<string>();
  let variantsWithoutSku = 0;

  for (const product of products) {
    for (const variant of product.variants ?? []) {
      if (variant.id !== null && variant.id !== undefined) {
        liveVariantIds.add(String(variant.id));
      }
      const sku = normalizeSku(variant.sku);
      if (!sku) {
        variantsWithoutSku++;
        continue;
      }
      if (bySku.has(sku)) {
        duplicateSkus.add(sku);
        continue;
      }
      // Guard the String(undefined) → 'undefined' failure mode at the source.
      const rawInvItem = variant.inventory_item_id;
      bySku.set(sku, {
        productId: String(product.id),
        variantId: String(variant.id),
        inventoryItemId:
          rawInvItem === null || rawInvItem === undefined ? null : String(rawInvItem),
      });
    }
  }
  return { bySku, duplicateSkus, liveVariantIds, variantsWithoutSku };
}

export interface LocalMappingRow {
  variantId: number;
  sku: string;
  shopifyVariantId: string | null;
  shopifyInventoryItemId: string | null;
  feedId: number | null;
  feedChannelProductId: string | null;
  feedChannelVariantId: string | null;
  feedChannelInventoryItemId: string | null;
  listingId: number | null;
  listingExternalProductId: string | null;
  listingExternalVariantId: string | null;
}

export interface FieldChange {
  target: "channel_feeds" | "channel_listings" | "product_variants";
  field: string;
  oldValue: string | null;
  newValue: string;
}

export type RelinkStatus =
  | "ok"
  | "relink"
  | "missing_in_shopify"
  | "placeholder_unlinkable"
  | "ambiguous_sku";

export interface RelinkPlanRow {
  row: LocalMappingRow;
  status: RelinkStatus;
  live: LiveVariantIds | null;
  changes: FieldChange[];
}

function diffField(
  changes: FieldChange[],
  target: FieldChange["target"],
  field: string,
  oldValue: string | null,
  newValue: string | null,
): void {
  if (newValue === null) return; // never overwrite with an unknown live value
  const effectiveOld = isAbsentExternalValue(oldValue) ? null : oldValue;
  if (effectiveOld === newValue) return;
  changes.push({ target, field, oldValue, newValue });
}

/**
 * Decide, per local mapping row, whether/what to heal against the live map.
 * product_variants columns are only touched when `isAuthorityChannel` — they
 * mirror the provider-default store, not every store.
 */
export function planChannelRelink(
  rows: LocalMappingRow[],
  live: LiveSkuMap,
  isAuthorityChannel: boolean,
): RelinkPlanRow[] {
  return rows.map((row) => {
    const sku = normalizeSku(row.sku);
    if (!sku) {
      return { row, status: "missing_in_shopify", live: null, changes: [] };
    }
    if (live.duplicateSkus.has(sku)) {
      return { row, status: "ambiguous_sku", live: null, changes: [] };
    }
    const liveIds = live.bySku.get(sku) ?? null;
    if (!liveIds) {
      return {
        row,
        status: isPlaceholderSku(sku) ? "placeholder_unlinkable" : "missing_in_shopify",
        live: null,
        changes: [],
      };
    }

    const changes: FieldChange[] = [];
    if (row.feedId !== null) {
      diffField(changes, "channel_feeds", "channel_product_id", row.feedChannelProductId, liveIds.productId);
      diffField(changes, "channel_feeds", "channel_variant_id", row.feedChannelVariantId, liveIds.variantId);
      diffField(changes, "channel_feeds", "channel_inventory_item_id", row.feedChannelInventoryItemId, liveIds.inventoryItemId);
    }
    if (row.listingId !== null) {
      diffField(changes, "channel_listings", "external_product_id", row.listingExternalProductId, liveIds.productId);
      diffField(changes, "channel_listings", "external_variant_id", row.listingExternalVariantId, liveIds.variantId);
    }
    if (isAuthorityChannel) {
      diffField(changes, "product_variants", "shopify_variant_id", row.shopifyVariantId, liveIds.variantId);
      diffField(changes, "product_variants", "shopify_inventory_item_id", row.shopifyInventoryItemId, liveIds.inventoryItemId);
    }

    return {
      row,
      status: changes.length > 0 ? "relink" : "ok",
      live: liveIds,
      changes,
    };
  });
}

/**
 * --archive-missing: pick the plan rows whose product is truly GONE from the
 * live store, i.e. safe to retire. Two gates, both required:
 *
 *   1. status is missing_in_shopify or placeholder_unlinkable (never
 *      ambiguous — an ambiguous SKU is live, just duplicated);
 *   2. NO stored id (feed variant id, listing variant id, pv variant id)
 *      matches ANY live variant id — this is what protects live-but-SKU-less
 *      products (they fail the SKU match but their stored ids are live).
 *
 * "Archiving" clears the dead inventory-item ids so the sweep skips the row
 * ("No inventoryItemId") instead of 404ing forever, and flags the feed
 * is_active=0. Ids that 404 are unusable by definition, so clearing them
 * loses nothing; a future relist re-populates via the normal catalog flow.
 */
export function planArchive(plan: RelinkPlanRow[], live: LiveSkuMap): RelinkPlanRow[] {
  return plan.filter((p) => {
    if (p.status !== "missing_in_shopify" && p.status !== "placeholder_unlinkable") {
      return false;
    }
    const storedIds = [
      p.row.feedChannelVariantId,
      p.row.listingExternalVariantId,
      p.row.shopifyVariantId,
    ].filter((id): id is string => !isAbsentExternalValue(id));
    return storedIds.every((id) => !live.liveVariantIds.has(id));
  });
}

// ---------------------------------------------------------------------------
// Shopify fetch (paginated)
// ---------------------------------------------------------------------------

interface ShopifyCreds {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
}

function parseNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function fetchAllShopifyProducts(creds: ShopifyCreds): Promise<any[]> {
  const products: any[] = [];
  let url: string | null =
    `https://${creds.shopDomain}/admin/api/${creds.apiVersion}/products.json?limit=${PAGE_LIMIT}`;

  while (url) {
    let response: Response | null = null;
    for (let attempt = 1; attempt <= MAX_429_RETRIES; attempt++) {
      response = await fetch(url, {
        headers: { "X-Shopify-Access-Token": creds.accessToken },
      });
      if (response.status !== 429) break;
      const retryAfter = Number(response.headers.get("Retry-After") || "2");
      console.warn(`  rate limited, retrying in ${retryAfter}s (attempt ${attempt}/${MAX_429_RETRIES})`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
    }
    if (!response || !response.ok) {
      throw new Error(
        `Shopify GET products.json failed (${response?.status}): ${await response?.text()}`,
      );
    }
    const body = await response.json();
    products.push(...(body.products ?? []));
    url = parseNextPageUrl(response.headers.get("Link") ?? response.headers.get("link"));
    if (url) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }
  return products;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Set EXTERNAL_DATABASE_URL (or DATABASE_URL).");
    process.exit(1);
  }
  // rejectUnauthorized:false is the repo-wide script convention (P4.5 tracks proper CA verification)
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  console.log(`relink-shopify-variant-ids — ${opts.apply ? "APPLY" : "DRY-RUN (no writes)"}`);

  const channelsRes = await pool.query(
    `SELECT c.id, c.name, c.is_default,
            cc.shop_domain, cc.access_token, cc.api_version
     FROM channels.channels c
     JOIN channels.channel_connections cc ON cc.channel_id = c.id
     WHERE c.provider = 'shopify'
       AND cc.shop_domain IS NOT NULL AND cc.access_token IS NOT NULL
       ${opts.channelId ? "AND c.id = $1" : ""}
     ORDER BY c.id`,
    opts.channelId ? [opts.channelId] : [],
  );
  if (channelsRes.rows.length === 0) {
    console.error("No Shopify channels with connections matched.");
    process.exit(1);
  }

  let totalRelinked = 0;
  let totalArchived = 0;
  let totalUnhealable = 0;

  for (const ch of channelsRes.rows) {
    const isAuthority = Number(ch.is_default) === 1;
    console.log(
      `\n=== Channel ${ch.id} (${ch.name}) ${isAuthority ? "[provider default — product_variants mirror]" : ""} ===`,
    );

    console.log(`  fetching live catalog from ${ch.shop_domain} ...`);
    const products = await fetchAllShopifyProducts({
      shopDomain: ch.shop_domain,
      accessToken: ch.access_token,
      apiVersion: ch.api_version || DEFAULT_API_VERSION,
    });
    const live = buildLiveSkuMap(products);
    console.log(
      `  live: ${products.length} products, ${live.bySku.size} unique SKUs` +
        (live.duplicateSkus.size ? `, ${live.duplicateSkus.size} DUPLICATE SKUs (ambiguous)` : "") +
        (live.variantsWithoutSku ? `, ${live.variantsWithoutSku} variants without SKU` : ""),
    );

    const skuFilter = opts.skus ? `AND UPPER(pv.sku) = ANY($2)` : "";
    const localRes = await pool.query(
      `SELECT pv.id                          AS variant_id,
              pv.sku                         AS sku,
              pv.shopify_variant_id          AS shopify_variant_id,
              pv.shopify_inventory_item_id   AS shopify_inventory_item_id,
              cf.id                          AS feed_id,
              cf.channel_product_id          AS feed_channel_product_id,
              cf.channel_variant_id          AS feed_channel_variant_id,
              cf.channel_inventory_item_id   AS feed_channel_inventory_item_id,
              cl.id                          AS listing_id,
              cl.external_product_id         AS listing_external_product_id,
              cl.external_variant_id         AS listing_external_variant_id
       FROM catalog.product_variants pv
       LEFT JOIN channels.channel_feeds cf
         ON cf.product_variant_id = pv.id AND cf.channel_id = $1
       LEFT JOIN channels.channel_listings cl
         ON cl.product_variant_id = pv.id AND cl.channel_id = $1
       WHERE pv.sku IS NOT NULL
         AND (cf.id IS NOT NULL OR cl.id IS NOT NULL
              OR (${isAuthority} AND (pv.shopify_variant_id IS NOT NULL
                                      OR pv.shopify_inventory_item_id IS NOT NULL)))
         ${skuFilter}`,
      opts.skus ? [ch.id, opts.skus] : [ch.id],
    );

    const rows: LocalMappingRow[] = localRes.rows.map((r: any) => ({
      variantId: r.variant_id,
      sku: r.sku,
      shopifyVariantId: r.shopify_variant_id,
      shopifyInventoryItemId: r.shopify_inventory_item_id,
      feedId: r.feed_id,
      feedChannelProductId: r.feed_channel_product_id,
      feedChannelVariantId: r.feed_channel_variant_id,
      feedChannelInventoryItemId: r.feed_channel_inventory_item_id,
      listingId: r.listing_id,
      listingExternalProductId: r.listing_external_product_id,
      listingExternalVariantId: r.listing_external_variant_id,
    }));

    const plan = planChannelRelink(rows, live, isAuthority);
    const byStatus = (s: RelinkStatus) => plan.filter((p) => p.status === s);

    for (const p of byStatus("relink")) {
      console.log(`  RELINK ${p.row.sku} (variant ${p.row.variantId}):`);
      for (const c of p.changes) {
        console.log(`    ${c.target}.${c.field}: ${c.oldValue ?? "∅"} -> ${c.newValue}`);
      }
    }
    for (const p of byStatus("ambiguous_sku")) {
      console.log(`  AMBIGUOUS ${p.row.sku} — SKU on multiple live Shopify variants; fix in Shopify first`);
    }
    for (const p of byStatus("placeholder_unlinkable")) {
      console.log(`  PLACEHOLDER ${p.row.sku} (variant ${p.row.variantId}) — no real SKU; needs manual re-link or archive`);
    }
    for (const p of byStatus("missing_in_shopify")) {
      console.log(`  MISSING ${p.row.sku} (variant ${p.row.variantId}) — SKU not in live catalog; relist or archive locally`);
    }

    const relinkRows = byStatus("relink");
    const archiveRows = opts.archiveMissing ? planArchive(plan, live) : [];
    if (opts.archiveMissing) {
      for (const p of archiveRows) {
        console.log(
          `  ARCHIVE ${p.row.sku} (variant ${p.row.variantId}) — gone from live store; ` +
            `clearing dead inventory-item id${p.row.feedId !== null ? " + feed is_active=0" : ""}`,
        );
      }
      const blocked =
        byStatus("missing_in_shopify").length +
        byStatus("placeholder_unlinkable").length -
        archiveRows.length;
      if (blocked > 0) {
        console.log(
          `  (${blocked} missing/placeholder rows NOT archived — a stored id still matches a live variant)`,
        );
      }
    }
    totalUnhealable +=
      byStatus("ambiguous_sku").length +
      byStatus("placeholder_unlinkable").length +
      byStatus("missing_in_shopify").length -
      archiveRows.length;

    console.log(
      `  summary: ${byStatus("ok").length} ok, ${relinkRows.length} relink, ` +
        `${byStatus("missing_in_shopify").length} missing, ` +
        `${byStatus("placeholder_unlinkable").length} placeholder, ` +
        `${byStatus("ambiguous_sku").length} ambiguous` +
        (opts.archiveMissing ? `, ${archiveRows.length} to archive` : ""),
    );

    if (!opts.apply || (relinkRows.length === 0 && archiveRows.length === 0)) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const p of relinkRows) {
        const feedChanges = p.changes.filter((c) => c.target === "channel_feeds");
        const listingChanges = p.changes.filter((c) => c.target === "channel_listings");
        const variantChanges = p.changes.filter((c) => c.target === "product_variants");

        if (feedChanges.length > 0 && p.row.feedId !== null) {
          // last_synced_qty=NULL forces the next sweep past the unchanged-qty
          // drift-lock, so Shopify gets a fresh push on the new ids. A healed
          // mapping also leaves quarantine (migration 118) — it can push again.
          await client.query(
            `UPDATE channels.channel_feeds
             SET channel_product_id = $1, channel_variant_id = $2,
                 channel_inventory_item_id = $3, last_synced_qty = NULL,
                 consecutive_push_failures = 0, quarantined_at = NULL,
                 quarantine_reason = NULL, updated_at = NOW()
             WHERE id = $4`,
            [p.live!.productId, p.live!.variantId, p.live!.inventoryItemId, p.row.feedId],
          );
        }
        if (listingChanges.length > 0 && p.row.listingId !== null) {
          await client.query(
            `UPDATE channels.channel_listings
             SET external_product_id = $1, external_variant_id = $2, updated_at = NOW()
             WHERE id = $3`,
            [p.live!.productId, p.live!.variantId, p.row.listingId],
          );
        }
        if (variantChanges.length > 0) {
          await client.query(
            `UPDATE catalog.product_variants
             SET shopify_variant_id = $1, shopify_inventory_item_id = $2, updated_at = NOW()
             WHERE id = $3`,
            [p.live!.variantId, p.live!.inventoryItemId, p.row.variantId],
          );
        }
      }
      for (const p of archiveRows) {
        if (p.row.feedId !== null) {
          // Retired deliberately — not "quarantined"; clear those fields too.
          await client.query(
            `UPDATE channels.channel_feeds
             SET channel_inventory_item_id = NULL, is_active = 0,
                 consecutive_push_failures = 0, quarantined_at = NULL,
                 quarantine_reason = NULL, updated_at = NOW()
             WHERE id = $1`,
            [p.row.feedId],
          );
        }
        // The pv mirror columns only belong to the provider-default store;
        // only clear an id that is provably dead (guaranteed by planArchive).
        if (isAuthority && !isAbsentExternalValue(p.row.shopifyInventoryItemId)) {
          await client.query(
            `UPDATE catalog.product_variants
             SET shopify_inventory_item_id = NULL, updated_at = NOW()
             WHERE id = $1`,
            [p.row.variantId],
          );
        }
      }
      await client.query("COMMIT");
      totalRelinked += relinkRows.length;
      totalArchived += archiveRows.length;
      console.log(
        `  APPLIED ${relinkRows.length} re-links` +
          (opts.archiveMissing ? ` + ${archiveRows.length} archives` : "") +
          ` for channel ${ch.id}`,
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(
    `\ndone. ${
      opts.apply
        ? `${totalRelinked} variants re-linked, ${totalArchived} archived`
        : "dry-run only"
    }; ${totalUnhealable} rows need manual attention (missing/placeholder/ambiguous).`,
  );
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
