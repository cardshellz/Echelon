import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { DropshipVendorStatus } from "../../../../shared/schema/dropship.schema";
import type {
  DropshipListingTierRepository,
  DropshipListingTierVendorRecord,
  DropshipVendorListingTierHoldRecord,
} from "../application/dropship-listing-tier-service";
import { DropshipError } from "../domain/errors";
import {
  DROPSHIP_LISTING_TIERS,
  listingTierForVariantUomType,
  parseCatalogVariantUomType,
  type DropshipListingTier,
} from "../domain/listing-tiers";

/**
 * Persistence for the listing tier decision: one row per vendor in
 * `dropship.dropship_vendor_listing_tier_holds`, an audit row per change of
 * held tiers in the same transaction, and the reads the reconciler needs.
 * Nothing here talks to a marketplace or to inventory planning's tables.
 */

const VENDOR_STATUSES: ReadonlySet<string> = new Set(["onboarding", "active", "paused", "lapsed", "suspended", "closed"]);
const REVIEWABLE_VENDOR_STATUSES = ["active", "paused"];
const ACTOR_ID = "dropship-listing-tiers";

interface VendorRow {
  vendor_id: number;
  status: string;
  held_tiers: string[] | null;
  revision: number | null;
  applied: boolean | null;
  detail: string | null;
  evaluated_at: Date | null;
  applied_at: Date | null;
}

interface HoldRow {
  vendor_id: number;
  held_tiers: string[];
  revision: number;
  applied: boolean;
  detail: string | null;
  evaluated_at: Date;
  applied_at: Date | null;
}

interface ListingVariantRow {
  product_variant_id: number;
  uom_type: string;
}

export class PgDropshipListingTierRepository implements DropshipListingTierRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listVendorsForReview(input: { limit: number }): Promise<DropshipListingTierVendorRecord[]> {
    const result = await this.dbPool.query<VendorRow>(
      `SELECT v.id AS vendor_id, v.status,
              h.held_tiers, h.revision, h.applied, h.detail, h.evaluated_at, h.applied_at
       FROM dropship.dropship_vendors v
       LEFT JOIN dropship.dropship_vendor_listing_tier_holds h ON h.vendor_id = v.id
       WHERE v.status = ANY($1::text[])
       ORDER BY v.id ASC
       LIMIT $2`,
      [REVIEWABLE_VENDOR_STATUSES, input.limit],
    );
    return result.rows.map(mapVendorRow);
  }

  async listStoreConnectionIds(vendorId: number): Promise<number[]> {
    const result = await this.dbPool.query<{ id: number }>(
      `SELECT id
       FROM dropship.dropship_store_connections
       WHERE vendor_id = $1
         AND status <> 'disconnected'
       ORDER BY id ASC`,
      [vendorId],
    );
    return result.rows.map((row) => row.id);
  }

  async listListingVariantIdsByTier(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<Record<DropshipListingTier, number[]>> {
    const result = await this.dbPool.query<ListingVariantRow>(
      `SELECT DISTINCT listing.product_variant_id, variant.uom_type
       FROM dropship.dropship_vendor_listings listing
       JOIN catalog.product_variants variant ON variant.id = listing.product_variant_id
       WHERE listing.vendor_id = $1
         AND listing.store_connection_id = $2
       ORDER BY listing.product_variant_id ASC`,
      [input.vendorId, input.storeConnectionId],
    );
    const byTier: Record<DropshipListingTier, number[]> = { pack: [], case: [] };
    for (const row of result.rows) {
      const tier = listingTierForVariantUomType(parseCatalogVariantUomType(row.uom_type, { productVariantId: row.product_variant_id }));
      byTier[tier].push(row.product_variant_id);
    }
    return byTier;
  }

  async recordHeldTiers(input: {
    vendorId: number;
    heldTiers: readonly DropshipListingTier[];
    detail: string | null;
    now: Date;
  }): Promise<{ changed: boolean; record: DropshipVendorListingTierHoldRecord }> {
    const heldTiers = normalizeTiers(input.heldTiers);
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<HoldRow>(
        `SELECT vendor_id, held_tiers, revision, applied, detail, evaluated_at, applied_at
         FROM dropship.dropship_vendor_listing_tier_holds
         WHERE vendor_id = $1
         FOR UPDATE`,
        [input.vendorId],
      );
      const before = existing.rows[0] ? mapHoldRow(existing.rows[0]) : null;
      if (before && sameTiers(before.heldTiers, heldTiers)) {
        const refreshed = await client.query<HoldRow>(
          `UPDATE dropship.dropship_vendor_listing_tier_holds
           SET evaluated_at = $2, updated_at = $2
           WHERE vendor_id = $1
           RETURNING vendor_id, held_tiers, revision, applied, detail, evaluated_at, applied_at`,
          [input.vendorId, input.now],
        );
        await client.query("COMMIT");
        return { changed: false, record: mapHoldRow(requireRow(refreshed.rows[0], input.vendorId)) };
      }
      const written = await client.query<HoldRow>(
        `INSERT INTO dropship.dropship_vendor_listing_tier_holds
           (vendor_id, held_tiers, revision, applied, detail, evaluated_at, applied_at, created_at, updated_at)
         VALUES ($1, $2::text[], 1, false, $3, $4, NULL, $4, $4)
         ON CONFLICT (vendor_id) DO UPDATE
           SET held_tiers = EXCLUDED.held_tiers,
               revision = dropship_vendor_listing_tier_holds.revision + 1,
               applied = false,
               detail = EXCLUDED.detail,
               evaluated_at = EXCLUDED.evaluated_at,
               applied_at = NULL,
               updated_at = EXCLUDED.updated_at
         RETURNING vendor_id, held_tiers, revision, applied, detail, evaluated_at, applied_at`,
        [input.vendorId, heldTiers, input.detail, input.now],
      );
      const record = mapHoldRow(requireRow(written.rows[0], input.vendorId));
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
           (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, 'dropship_vendor_listing_tier_hold', $2, 'listing_tier_hold_changed', 'system', $3, 'info', $4::jsonb, $5)`,
        [
          input.vendorId,
          String(input.vendorId),
          ACTOR_ID,
          JSON.stringify({
            before: before ? { heldTiers: before.heldTiers, revision: before.revision } : null,
            after: { heldTiers: record.heldTiers, revision: record.revision },
            detail: input.detail,
          }),
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { changed: true, record };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapListingTierError(error);
    } finally {
      client.release();
    }
  }

  async recordApplied(input: {
    vendorId: number;
    revision: number;
    applied: boolean;
    detail: string | null;
    now: Date;
  }): Promise<boolean> {
    try {
      const result = await this.dbPool.query(
        `UPDATE dropship.dropship_vendor_listing_tier_holds
         SET applied = $3,
             applied_at = CASE WHEN $3 THEN $4::timestamptz ELSE NULL END,
             detail = $5,
             updated_at = $4
         WHERE vendor_id = $1
           AND revision = $2`,
        [input.vendorId, input.revision, input.applied, input.now, input.detail],
      );
      return result.rowCount === 1;
    } catch (error) {
      throw mapListingTierError(error);
    }
  }
}

function mapVendorRow(row: VendorRow): DropshipListingTierVendorRecord {
  if (!VENDOR_STATUSES.has(row.status)) {
    throw new DropshipError("DROPSHIP_LISTING_TIER_INVALID_STORED_VALUE", "Dropship vendor status is not recognised.", {
      vendorId: row.vendor_id, status: row.status,
    });
  }
  return {
    vendorId: row.vendor_id,
    status: row.status as DropshipVendorStatus,
    tierHold: row.revision === null || row.held_tiers === null || row.applied === null || row.evaluated_at === null
      ? null
      : mapHoldRow({
          vendor_id: row.vendor_id,
          held_tiers: row.held_tiers,
          revision: row.revision,
          applied: row.applied,
          detail: row.detail,
          evaluated_at: row.evaluated_at,
          applied_at: row.applied_at,
        }),
  };
}

function mapHoldRow(row: HoldRow): DropshipVendorListingTierHoldRecord {
  return {
    vendorId: row.vendor_id,
    heldTiers: normalizeTiers(row.held_tiers.map((tier) => parseTier(tier, row.vendor_id))),
    revision: nonNegativeInteger(row.revision, row.vendor_id),
    applied: row.applied,
    detail: row.detail,
    evaluatedAt: row.evaluated_at,
    appliedAt: row.applied_at,
  };
}

function parseTier(value: string, vendorId: number): DropshipListingTier {
  if ((DROPSHIP_LISTING_TIERS as readonly string[]).includes(value)) return value as DropshipListingTier;
  throw new DropshipError("DROPSHIP_LISTING_TIER_INVALID_STORED_VALUE", "A stored held tier is not a listing tier.", { vendorId, tier: value });
}

/** Tier order, no duplicates: what the row stores and the notices compare. */
function normalizeTiers(tiers: readonly DropshipListingTier[]): DropshipListingTier[] {
  const present = new Set(tiers);
  return DROPSHIP_LISTING_TIERS.filter((tier) => present.has(tier));
}

function sameTiers(left: readonly DropshipListingTier[], right: readonly DropshipListingTier[]): boolean {
  return left.length === right.length && left.every((tier, index) => tier === right[index]);
}

function nonNegativeInteger(value: unknown, vendorId: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DropshipError("DROPSHIP_LISTING_TIER_INVALID_STORED_VALUE", "A stored listing tier revision is not a non-negative integer.", { vendorId, value });
  }
  return parsed;
}

function requireRow(row: HoldRow | undefined, vendorId: number): HoldRow {
  if (!row) {
    throw new DropshipError("DROPSHIP_LISTING_TIER_WRITE_INCOMPLETE", "The listing tier hold write returned no row.", { vendorId });
  }
  return row;
}

function mapListingTierError(error: unknown): unknown {
  if (error instanceof DropshipError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : null;
  if (code === "42P01") {
    return new DropshipError(
      "DROPSHIP_LISTING_TIER_TABLE_MISSING",
      "The listing tier hold table has not been migrated yet.",
      { classification: "transient" },
    );
  }
  if (code === "23503") {
    return new DropshipError("DROPSHIP_LISTING_TIER_VENDOR_NOT_FOUND", "The vendor does not exist.", { classification: "permanent" });
  }
  return error;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
