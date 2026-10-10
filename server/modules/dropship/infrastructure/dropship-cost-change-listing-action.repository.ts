import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { LISTING_PRICING_MODES } from "../../../../shared/dropship/listing-price";
import { pricingProfileStateSchema, type PricingProfileState } from "../../../../shared/dropship/pricing-rules";
import {
  costChangeHoldReleaseDetails,
  costChangeHoldReleaseReasons,
  costChangeListingActionValues,
  costChangeListingPriceSourceValues,
  type CostChangeHoldReleaseDetail,
  type CostChangeHoldReleaseReason,
  type CostChangeListingAction,
  type CostChangeListingPriceSource,
} from "../domain/cost-change-listing-action";
import { DropshipError } from "../domain/errors";
import type {
  ActiveCostChangeListingHold,
  DropshipCostChangeListingActionView,
  VendorCostChangeListingActionView,
  CostActionCandidate,
  CostActionListing,
  CostActionSavedPrice,
  CostActionVendorFacts,
  CostChangeEntryActionRecord,
  CostChangeListingActionRecord,
  DropshipCostChangeListingActionRepository,
  EffectiveCostIncrease,
  NewCostChangeListingHold,
} from "../application/dropship-cost-change-listing-action-service";
import type { DropshipPricingPolicyRecord } from "../application/dropship-listing-preview-service";
import { mapCostScheduleError } from "./dropship-cost-schedule.repository";

/**
 * PG repository for cost change listing actions (migration 0713). Reads are
 * pooled; the record of a vendor's decisions is one transaction so the entry
 * rows that mark increases done commit with the listing rows and holds that
 * explain them, or not at all.
 */

export interface CostActionCatalogReader {
  listCatalogCandidates(productVariantIds: readonly number[]): Promise<Array<{
    productVariantId: number; productId: number; category: string | null; productLineIds: readonly number[]; defaultRetailPriceCents: number | null;
  }>>;
  /** The active Card Shellz price limits, as the listing preview reads them. */
  listPricingPolicies(): Promise<DropshipPricingPolicyRecord[]>;
}

interface IncreaseRow {
  id: string | number;
  vendor_id: number;
  product_variant_id: number;
  from_cents: string | number | null;
  unit_cost_cents: string | number;
  effective_at: Date;
  policy_id: number | null;
  in_force_entry_id: string | number;
}

interface ListingRow {
  id: number;
  store_connection_id: number;
  product_variant_id: number;
  status: string;
  vendor_retail_price_cents: string | number | null;
  platform: string;
  variant_sku: string | null;
  variant_name: string;
  product_name: string;
}

interface SavedPriceRow {
  store_connection_id: number;
  product_variant_id: number;
  override_price_cents: number | null;
  pricing_mode: string | null;
}

interface ProfileRow {
  store_connection_id: number;
  revision_id: number;
  profile: unknown;
  created_at: Date;
}

interface HoldRow {
  id: string | number;
  vendor_id: number;
  store_connection_id: number;
  product_variant_id: number;
  listing_id: number;
  entry_id: string | number;
  listing_price_cents: string | number;
  unit_cost_cents: string | number;
  held_at: Date;
}

interface CostInForceRow {
  product_variant_id: number;
  unit_cost_cents: string | number;
}

interface ActionViewRow {
  id: string | number;
  entry_id: string | number;
  listing_id: number;
  store_connection_id: number;
  platform: string;
  product_variant_id: number;
  variant_sku: string | null;
  variant_name: string;
  product_name: string;
  action: string;
  detail: string | null;
  listing_price_cents: string | number | null;
  unit_cost_cents: string | number;
  push_job_id: number | null;
  decided_at: Date;
  hold_released_at: Date | null;
  hold_release_reason: string | null;
  vendor_id: number;
  business_name: string | null;
  listing_status: string;
  price_source: string;
  policy_id: number | null;
}

const ACTION_VIEW_SELECT = `SELECT a.id, a.entry_id, a.listing_id, a.store_connection_id, l.platform, a.product_variant_id,
                pv.sku AS variant_sku, pv.name AS variant_name, p.name AS product_name, a.action, a.detail, a.listing_price_cents,
                a.unit_cost_cents, a.push_job_id, a.decided_at, h.released_at AS hold_released_at, h.release_reason AS hold_release_reason,
                a.vendor_id, v.business_name, a.listing_status, a.price_source, a.policy_id
         FROM dropship.dropship_cost_change_listing_actions a
         JOIN dropship.dropship_vendor_listings l ON l.id = a.listing_id
         JOIN dropship.dropship_vendors v ON v.id = a.vendor_id
         JOIN catalog.product_variants pv ON pv.id = a.product_variant_id
         JOIN catalog.products p ON p.id = pv.product_id
         LEFT JOIN dropship.dropship_cost_change_listing_holds h ON h.id = a.hold_id`;

export class PgDropshipCostChangeListingActionRepository implements DropshipCostChangeListingActionRepository {
  constructor(
    private readonly dbPool: Pool = defaultPool,
    private readonly catalog: CostActionCatalogReader,
  ) {}

  async listVendorListingActions(input: { vendorId: number; since: Date; limit: number }): Promise<VendorCostChangeListingActionView[]> {
    assertPositiveInteger(input.vendorId, "vendorId");
    assertPositiveInteger(input.limit, "limit");
    try {
      const result = await this.dbPool.query<ActionViewRow>(
        `${ACTION_VIEW_SELECT}
         WHERE a.vendor_id = $1 AND a.decided_at >= $2
         ORDER BY a.id DESC
         LIMIT $3`,
        [input.vendorId, input.since, input.limit],
      );
      return result.rows.map(mapVendorActionView);
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async listListingActions(input: { limit: number; beforeId: number | null }): Promise<DropshipCostChangeListingActionView[]> {
    assertPositiveInteger(input.limit, "limit");
    if (input.beforeId !== null) assertPositiveInteger(input.beforeId, "beforeId");
    try {
      const result = await this.dbPool.query<ActionViewRow>(
        `${ACTION_VIEW_SELECT}
         WHERE ($1::bigint IS NULL OR a.id < $1)
         ORDER BY a.id DESC
         LIMIT $2`,
        [input.beforeId, input.limit],
      );
      return result.rows.map(mapActionView);
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async listEffectiveIncreasesWithoutAction(input: { now: Date; limit: number }): Promise<EffectiveCostIncrease[]> {
    assertPositiveInteger(input.limit, "limit");
    try {
      const result = await this.dbPool.query<IncreaseRow>(
        `SELECT e.id, e.vendor_id, e.product_variant_id, e.from_cents, e.unit_cost_cents, e.effective_at, e.policy_id,
                (SELECT f.id FROM dropship.dropship_cost_schedule_entries f
                 WHERE f.vendor_id = e.vendor_id AND f.product_variant_id = e.product_variant_id
                   AND f.withdrawn_at IS NULL AND f.effective_at <= $1
                 ORDER BY f.effective_at DESC, f.id DESC LIMIT 1) AS in_force_entry_id
         FROM dropship.dropship_cost_schedule_entries e
         LEFT JOIN dropship.dropship_cost_change_entry_actions a ON a.entry_id = e.id
         WHERE e.kind = 'increase' AND e.withdrawn_at IS NULL AND e.effective_at <= $1 AND a.entry_id IS NULL
         ORDER BY e.vendor_id ASC, e.id ASC
         LIMIT $2`,
        [input.now, input.limit],
      );
      return result.rows.map((row) => ({
        entryId: toId(row.id, "entry id"),
        vendorId: row.vendor_id,
        productVariantId: row.product_variant_id,
        fromCents: toCents(row.from_cents ?? Number.NaN, "from_cents"),
        unitCostCents: toCents(row.unit_cost_cents, "unit_cost_cents"),
        effectiveAt: row.effective_at,
        policyId: row.policy_id,
        inForceEntryId: toId(row.in_force_entry_id, "in_force_entry_id"),
      }));
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async loadVendorFacts(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<CostActionVendorFacts> {
    assertPositiveInteger(input.vendorId, "vendorId");
    const productVariantIds = [...new Set(input.productVariantIds)];
    for (const id of productVariantIds) assertPositiveInteger(id, "productVariantId");
    if (productVariantIds.length === 0) return { listings: [], savedPrices: [], profiles: new Map(), candidates: new Map(), pricingPolicies: [] };
    try {
      const listings = await this.dbPool.query<ListingRow>(
        `SELECT l.id, l.store_connection_id, l.product_variant_id, l.status, l.vendor_retail_price_cents, l.platform,
                pv.sku AS variant_sku, pv.name AS variant_name, p.name AS product_name
         FROM dropship.dropship_vendor_listings l
         JOIN catalog.product_variants pv ON pv.id = l.product_variant_id
         JOIN catalog.products p ON p.id = pv.product_id
         WHERE l.vendor_id = $1 AND l.product_variant_id = ANY($2::int[])
         ORDER BY l.id ASC`,
        [input.vendorId, productVariantIds],
      );
      const storeConnectionIds = [...new Set(listings.rows.map((row) => row.store_connection_id))];
      const [savedPrices, profiles, candidates, pricingPolicies] = await Promise.all([
        this.dbPool.query<SavedPriceRow>(
          `SELECT store_connection_id, product_variant_id, override_price_cents, pricing_mode
           FROM dropship.dropship_listing_price_settings
           WHERE vendor_id = $1 AND product_variant_id = ANY($2::int[])`,
          [input.vendorId, productVariantIds],
        ),
        storeConnectionIds.length === 0
          ? Promise.resolve({ rows: [] as ProfileRow[] })
          : this.dbPool.query<ProfileRow>(
            `SELECT p.store_connection_id, r.id AS revision_id, r.profile, r.created_at
             FROM dropship.dropship_pricing_profiles p
             JOIN dropship.dropship_pricing_profile_revisions r
               ON r.id = p.revision_id AND r.vendor_id = p.vendor_id AND r.store_connection_id = p.store_connection_id
             WHERE p.vendor_id = $1 AND p.store_connection_id = ANY($2::int[])`,
            [input.vendorId, storeConnectionIds],
          ),
        this.catalog.listCatalogCandidates(productVariantIds),
        this.catalog.listPricingPolicies(),
      ]);
      return {
        listings: listings.rows.map(mapListingRow),
        savedPrices: savedPrices.rows.map(mapSavedPriceRow),
        profiles: new Map(profiles.rows.map((row) => [row.store_connection_id, mapProfileRow(row)])),
        candidates: new Map(candidates.map((candidate): [number, CostActionCandidate] => [candidate.productVariantId, {
          productVariantId: candidate.productVariantId, productId: candidate.productId, category: candidate.category,
          productLineIds: candidate.productLineIds, defaultRetailPriceCents: candidate.defaultRetailPriceCents,
        }])),
        pricingPolicies,
      };
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async recordEntryActions(input: {
    vendorId: number;
    entries: readonly CostChangeEntryActionRecord[];
    listingActions: readonly CostChangeListingActionRecord[];
    holds: readonly NewCostChangeListingHold[];
  }): Promise<{ entriesRecorded: number; listingActionsRecorded: number; holdsRecorded: number }> {
    assertPositiveInteger(input.vendorId, "vendorId");
    if (input.entries.length === 0) return { entriesRecorded: 0, listingActionsRecorded: 0, holdsRecorded: 0 };
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const holds = await insertHolds(client, input.vendorId, input.holds);
      const listingActionsRecorded = await insertListingActions(client, input.vendorId, input.listingActions, holds.idsByListing);
      const entriesRecorded = await insertEntryActions(client, input.vendorId, input.entries);
      await client.query("COMMIT");
      return { entriesRecorded, listingActionsRecorded, holdsRecorded: holds.inserted };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw mapCostScheduleError(error);
    } finally {
      client.release();
    }
  }

  async listActiveHolds(input: { limit: number }): Promise<ActiveCostChangeListingHold[]> {
    assertPositiveInteger(input.limit, "limit");
    try {
      const result = await this.dbPool.query<HoldRow>(
        `SELECT id, vendor_id, store_connection_id, product_variant_id, listing_id, entry_id, listing_price_cents, unit_cost_cents, held_at
         FROM dropship.dropship_cost_change_listing_holds
         WHERE released_at IS NULL
         ORDER BY vendor_id ASC, id ASC
         LIMIT $1`,
        [input.limit],
      );
      return result.rows.map((row) => ({
        holdId: toId(row.id, "hold id"),
        vendorId: row.vendor_id,
        storeConnectionId: row.store_connection_id,
        productVariantId: row.product_variant_id,
        listingId: row.listing_id,
        entryId: toId(row.entry_id, "entry id"),
        listingPriceCents: toCents(row.listing_price_cents, "listing_price_cents"),
        unitCostCents: toCents(row.unit_cost_cents, "unit_cost_cents"),
        heldAt: row.held_at,
      }));
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async costInForce(input: { vendorId: number; productVariantIds: readonly number[]; now: Date }): Promise<Map<number, number>> {
    assertPositiveInteger(input.vendorId, "vendorId");
    const productVariantIds = [...new Set(input.productVariantIds)];
    if (productVariantIds.length === 0) return new Map();
    try {
      const result = await this.dbPool.query<CostInForceRow>(
        `SELECT DISTINCT ON (product_variant_id) product_variant_id, unit_cost_cents
         FROM dropship.dropship_cost_schedule_entries
         WHERE vendor_id = $1 AND product_variant_id = ANY($2::int[]) AND withdrawn_at IS NULL AND effective_at <= $3
         ORDER BY product_variant_id, effective_at DESC, id DESC`,
        [input.vendorId, productVariantIds, input.now],
      );
      return new Map(result.rows.map((row) => [row.product_variant_id, toCents(row.unit_cost_cents, "unit_cost_cents")]));
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async releaseHolds(input: {
    holdIds: readonly number[];
    reason: CostChangeHoldReleaseReason;
    detail: CostChangeHoldReleaseDetail;
    releasedAt: Date;
    releaseIdempotencyKey: string;
  }): Promise<number> {
    if (input.holdIds.length === 0) return 0;
    for (const id of input.holdIds) assertPositiveInteger(id, "holdId");
    if (!(costChangeHoldReleaseReasons as readonly string[]).includes(input.reason)) throw invalidInput("reason", input.reason);
    if (!(costChangeHoldReleaseDetails as readonly string[]).includes(input.detail)) throw invalidInput("detail", input.detail);
    try {
      const result = await this.dbPool.query(
        `UPDATE dropship.dropship_cost_change_listing_holds
         SET released_at = $2, release_reason = $3, release_detail = $4, release_idempotency_key = $5
         WHERE id = ANY($1::bigint[]) AND released_at IS NULL`,
        [[...input.holdIds], input.releasedAt, input.reason, input.detail, input.releaseIdempotencyKey],
      );
      return result.rowCount ?? 0;
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }
}

/**
 * Holds first, so the listing rows can name them. A listing that already has a
 * live hold (a replayed pass) keeps it and its id is looked up.
 */
async function insertHolds(
  client: Pick<PoolClient, "query">,
  vendorId: number,
  holds: readonly NewCostChangeListingHold[],
): Promise<{ inserted: number; idsByListing: Map<string, number> }> {
  const idsByListing = new Map<string, number>();
  if (holds.length === 0) return { inserted: 0, idsByListing };
  const inserted = await client.query<{ id: string | number; store_connection_id: number; product_variant_id: number }>(
    `INSERT INTO dropship.dropship_cost_change_listing_holds
       (vendor_id, store_connection_id, product_variant_id, listing_id, entry_id, listing_price_cents, unit_cost_cents,
        hold_idempotency_key, held_at, created_at)
     SELECT $1, h.store_connection_id, h.product_variant_id, h.listing_id, h.entry_id, h.listing_price_cents, h.unit_cost_cents,
            h.hold_idempotency_key, h.held_at, h.held_at
     FROM unnest($2::int[], $3::int[], $4::int[], $5::bigint[], $6::bigint[], $7::bigint[], $8::text[], $9::timestamptz[])
       AS h(store_connection_id, product_variant_id, listing_id, entry_id, listing_price_cents, unit_cost_cents, hold_idempotency_key, held_at)
     ON CONFLICT (store_connection_id, product_variant_id) WHERE released_at IS NULL DO NOTHING
     RETURNING id, store_connection_id, product_variant_id`,
    [
      vendorId,
      holds.map((hold) => hold.storeConnectionId),
      holds.map((hold) => hold.productVariantId),
      holds.map((hold) => hold.listingId),
      holds.map((hold) => hold.entryId),
      holds.map((hold) => hold.listingPriceCents),
      holds.map((hold) => hold.unitCostCents),
      holds.map((hold) => hold.holdIdempotencyKey),
      holds.map((hold) => hold.heldAt),
    ],
  );
  for (const row of inserted.rows) idsByListing.set(holdKey(row.store_connection_id, row.product_variant_id), toId(row.id, "hold id"));
  const missing = holds.filter((hold) => !idsByListing.has(holdKey(hold.storeConnectionId, hold.productVariantId)));
  if (missing.length > 0) {
    const existing = await client.query<{ id: string | number; store_connection_id: number; product_variant_id: number }>(
      `SELECT id, store_connection_id, product_variant_id
       FROM dropship.dropship_cost_change_listing_holds
       WHERE released_at IS NULL AND vendor_id = $1 AND store_connection_id = ANY($2::int[]) AND product_variant_id = ANY($3::int[])`,
      [vendorId, missing.map((hold) => hold.storeConnectionId), missing.map((hold) => hold.productVariantId)],
    );
    for (const row of existing.rows) idsByListing.set(holdKey(row.store_connection_id, row.product_variant_id), toId(row.id, "hold id"));
  }
  return { inserted: inserted.rowCount ?? 0, idsByListing };
}

async function insertListingActions(
  client: Pick<PoolClient, "query">,
  vendorId: number,
  actions: readonly CostChangeListingActionRecord[],
  holdIds: ReadonlyMap<string, number>,
): Promise<number> {
  if (actions.length === 0) return 0;
  const resolvedHoldIds = actions.map((action) => {
    if (!action.holdKey) return null;
    const id = holdIds.get(holdKey(action.holdKey.storeConnectionId, action.holdKey.productVariantId));
    if (id === undefined) {
      throw new DropshipError("DROPSHIP_COST_CHANGE_HOLD_UNRESOLVED", "A paused listing's hold row could not be found for its action.",
        { classification: "fatal", vendorId, ...action.holdKey });
    }
    return id;
  });
  for (const action of actions) {
    if (!(costChangeListingActionValues as readonly string[]).includes(action.action)) throw invalidInput("action", action.action);
    if (!(costChangeListingPriceSourceValues as readonly string[]).includes(action.priceSource)) throw invalidInput("priceSource", action.priceSource);
  }
  const result = await client.query(
    `INSERT INTO dropship.dropship_cost_change_listing_actions
       (entry_id, vendor_id, store_connection_id, product_variant_id, listing_id, listing_status, price_source, listing_price_cents,
        unit_cost_cents, action, detail, push_job_id, hold_id, policy_id, decided_at, created_at)
     SELECT a.entry_id, $1, a.store_connection_id, a.product_variant_id, a.listing_id, a.listing_status, a.price_source, a.listing_price_cents,
            a.unit_cost_cents, a.action, a.detail, a.push_job_id, a.hold_id, a.policy_id, a.decided_at, a.decided_at
     FROM unnest($2::bigint[], $3::int[], $4::int[], $5::int[], $6::text[], $7::text[], $8::bigint[], $9::bigint[], $10::text[], $11::text[],
                 $12::int[], $13::bigint[], $14::int[], $15::timestamptz[])
       AS a(entry_id, store_connection_id, product_variant_id, listing_id, listing_status, price_source, listing_price_cents, unit_cost_cents,
            action, detail, push_job_id, hold_id, policy_id, decided_at)
     ON CONFLICT (entry_id, listing_id) DO NOTHING`,
    [
      vendorId,
      actions.map((action) => action.entryId),
      actions.map((action) => action.storeConnectionId),
      actions.map((action) => action.productVariantId),
      actions.map((action) => action.listingId),
      actions.map((action) => action.listingStatus),
      actions.map((action) => action.priceSource),
      actions.map((action) => action.listingPriceCents),
      actions.map((action) => action.unitCostCents),
      actions.map((action) => action.action),
      actions.map((action) => action.detail),
      actions.map((action) => action.pushJobId),
      resolvedHoldIds,
      actions.map((action) => action.policyId),
      actions.map((action) => action.decidedAt),
    ],
  );
  return result.rowCount ?? 0;
}

async function insertEntryActions(
  client: Pick<PoolClient, "query">,
  vendorId: number,
  entries: readonly CostChangeEntryActionRecord[],
): Promise<number> {
  const result = await client.query(
    `INSERT INTO dropship.dropship_cost_change_entry_actions
       (entry_id, vendor_id, product_variant_id, listing_count, action_counts, superseded_by_entry_id, policy_id, decided_at, created_at)
     SELECT e.entry_id, $1, e.product_variant_id, e.listing_count, e.action_counts::jsonb, e.superseded_by_entry_id, e.policy_id, e.decided_at, e.decided_at
     FROM unnest($2::bigint[], $3::int[], $4::int[], $5::text[], $6::bigint[], $7::int[], $8::timestamptz[])
       AS e(entry_id, product_variant_id, listing_count, action_counts, superseded_by_entry_id, policy_id, decided_at)
     ON CONFLICT (entry_id) DO NOTHING`,
    [
      vendorId,
      entries.map((entry) => entry.entryId),
      entries.map((entry) => entry.productVariantId),
      entries.map((entry) => entry.listingCount),
      entries.map((entry) => JSON.stringify(entry.actionCounts)),
      entries.map((entry) => entry.supersededByEntryId),
      entries.map((entry) => entry.policyId),
      entries.map((entry) => entry.decidedAt),
    ],
  );
  return result.rowCount ?? 0;
}

function mapVendorActionView(row: ActionViewRow): VendorCostChangeListingActionView {
  if (!(costChangeListingActionValues as readonly string[]).includes(row.action)) throw invalidStoredValue("action", row.action);
  if (row.hold_release_reason !== null && !(costChangeHoldReleaseReasons as readonly string[]).includes(row.hold_release_reason)) {
    throw invalidStoredValue("release_reason", row.hold_release_reason);
  }
  return {
    actionId: toId(row.id, "action id"),
    entryId: toId(row.entry_id, "entry id"),
    listingId: row.listing_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    productVariantId: row.product_variant_id,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    productName: row.product_name,
    action: row.action as CostChangeListingAction,
    detail: row.detail,
    listingPriceCents: row.listing_price_cents === null ? null : toCents(row.listing_price_cents, "listing_price_cents"),
    unitCostCents: toCents(row.unit_cost_cents, "unit_cost_cents"),
    pushJobId: row.push_job_id,
    decidedAt: row.decided_at,
    holdReleasedAt: row.hold_released_at,
    holdReleaseReason: row.hold_release_reason as CostChangeHoldReleaseReason | null,
  };
}

function mapActionView(row: ActionViewRow): DropshipCostChangeListingActionView {
  if (!(costChangeListingPriceSourceValues as readonly string[]).includes(row.price_source)) throw invalidStoredValue("price_source", row.price_source);
  return {
    ...mapVendorActionView(row),
    vendorId: row.vendor_id,
    vendorBusinessName: row.business_name,
    listingStatus: row.listing_status,
    priceSource: row.price_source as CostChangeListingPriceSource,
    policyId: row.policy_id,
  };
}

function holdKey(storeConnectionId: number, productVariantId: number): string {
  return `${storeConnectionId}:${productVariantId}`;
}

function mapListingRow(row: ListingRow): CostActionListing {
  return {
    listingId: row.id,
    storeConnectionId: row.store_connection_id,
    productVariantId: row.product_variant_id,
    status: row.status,
    vendorRetailPriceCents: row.vendor_retail_price_cents === null ? null : toCents(row.vendor_retail_price_cents, "vendor_retail_price_cents"),
    platform: row.platform,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    productName: row.product_name,
  };
}

function mapSavedPriceRow(row: SavedPriceRow): CostActionSavedPrice {
  if (row.pricing_mode !== null && !(LISTING_PRICING_MODES as readonly string[]).includes(row.pricing_mode)) {
    throw invalidStoredValue("pricing_mode", row.pricing_mode);
  }
  return {
    storeConnectionId: row.store_connection_id,
    productVariantId: row.product_variant_id,
    overridePriceCents: row.override_price_cents,
    pricingMode: row.pricing_mode as CostActionSavedPrice["pricingMode"],
  };
}

function mapProfileRow(row: ProfileRow): PricingProfileState {
  const parsed = pricingProfileStateSchema.safeParse({ revisionId: row.revision_id, profile: row.profile, updatedAt: row.created_at.toISOString() });
  if (!parsed.success) throw invalidStoredValue("profile", `revision ${row.revision_id}`);
  return parsed.data;
}

/** bigint columns arrive as strings; anything that is not a whole number of cents is refused, never coerced. */
function toCents(value: string | number, column: string): number {
  const cents = typeof value === "number" ? value : /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(cents) || cents < 0) throw invalidStoredValue(column, value);
  return cents;
}

function toId(value: string | number, name: string): number {
  const id = toCents(value, name);
  if (id <= 0) throw invalidStoredValue(name, value);
  return id;
}

function invalidStoredValue(column: string, value: unknown): DropshipError {
  return new DropshipError("DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE", "A stored cost change listing action value failed its contract.",
    { classification: "fatal", column, value: String(value) });
}

function invalidInput(name: string, value: unknown): DropshipError {
  return new DropshipError("DROPSHIP_COST_SCHEDULE_INVALID_INPUT", `${name} is outside its contract.`, { classification: "permanent", [name]: String(value) });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DropshipError("DROPSHIP_COST_SCHEDULE_INVALID_INPUT", `${name} must be a positive integer.`,
      { classification: "permanent", [name]: value });
  }
}

