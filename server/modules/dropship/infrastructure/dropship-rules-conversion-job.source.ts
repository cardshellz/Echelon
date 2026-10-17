import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  WRITABLE_ENTITLEMENT_STATUS,
  WRITABLE_STORE_STATUSES,
  WRITABLE_VENDOR_STATUSES,
} from "../application/dropship-listing-setting-write-support";
import {
  RULES_CONVERSION_FAILED_EVENT,
  rulesConversionHeadRevisionsSchema,
  type RulesConversionJobSource,
  type RulesConversionJobStore,
  type RulesConversionJobStores,
} from "../application/dropship-rules-conversion-job-service";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { mapListingSettingDatabaseError } from "./dropship-listing-setting-writes.repository";

/**
 * The rules conversion job's one read (PR 11e2, plan 13.2), on the pool,
 * outside any transaction and lock: it only decides which stores to check,
 * and every store it names is checked again by the dry run's load and, when
 * clean, under the store lock by the conversion itself (plan 7.B.3), so
 * nothing read here needs to hold until then. It writes nothing.
 *
 * The stores: on eBay, whose current pricing profile has a group, current
 * description profile has a group, or current eBay category rules document
 * has a rule (the older-rules state, D16, read from the three heads), and
 * with no conversion row by either actor (D20: never one a vendor moved,
 * never twice). Each is in exactly one of:
 * - not eligible: a store that is not connected, needing a sign-in or a token
 *   refresh, or whose vendor is not active or onboarding or has no active
 *   .ops entitlement (the write gate's own two allow-lists and its
 *   entitlement rule, which the conversion's system gate re-checks: the job
 *   never makes a write the vendor himself could not make);
 * - dead-lettered: eligible, but a failure audit row of the store (any of
 *   them, not only the latest) names its current three head revision ids and
 *   this planner version (D20). Any matching row is the latest failure's
 *   inputs because heads only move forward (each profile's coherence
 *   trigger) and the planner version is never lowered; setting it back would
 *   let an older row match again;
 * - eligible: the rest, checked this tick.
 * A stored profile that is not the shape its contract says (a `groups` or
 * `rules` that is not an array) counts as holding rules, so the check reads
 * it and fails it once, loudly, instead of the store being skipped in
 * silence. Ordered by vendor, then store.
 */
const STORES_SQL = `WITH candidates AS (
    SELECT sc.vendor_id, sc.id AS store_connection_id,
      (sc.status = ANY($1::text[]) AND v.status = ANY($2::text[]) AND v.entitlement_status = $5::text) AS eligible,
      pp.revision_id AS pricing_revision_id, cp.revision_id AS content_revision_id, ep.revision_id AS ebay_rules_revision_id
    FROM dropship.dropship_store_connections sc
    JOIN dropship.dropship_vendors v ON v.id = sc.vendor_id
    LEFT JOIN dropship.dropship_pricing_profiles pp ON pp.store_connection_id = sc.id AND pp.vendor_id = sc.vendor_id
    LEFT JOIN dropship.dropship_pricing_profile_revisions pr ON pr.id = pp.revision_id
      AND pr.vendor_id = pp.vendor_id AND pr.store_connection_id = pp.store_connection_id
    LEFT JOIN dropship.dropship_content_profiles cp ON cp.store_connection_id = sc.id AND cp.vendor_id = sc.vendor_id
    LEFT JOIN dropship.dropship_content_profile_revisions cr ON cr.id = cp.revision_id
      AND cr.vendor_id = cp.vendor_id AND cr.store_connection_id = cp.store_connection_id
    LEFT JOIN dropship.dropship_ebay_category_rule_profiles ep ON ep.store_connection_id = sc.id AND ep.vendor_id = sc.vendor_id
    LEFT JOIN dropship.dropship_ebay_category_rule_revisions er ON er.id = ep.revision_id
      AND er.vendor_id = ep.vendor_id AND er.store_connection_id = ep.store_connection_id
    WHERE sc.platform = 'ebay'
      AND (CASE WHEN pr.id IS NULL THEN false
             WHEN jsonb_typeof(pr.profile->'groups') = 'array' THEN jsonb_array_length(pr.profile->'groups') > 0 ELSE true END
        OR CASE WHEN cr.id IS NULL THEN false
             WHEN jsonb_typeof(cr.profile->'groups') = 'array' THEN jsonb_array_length(cr.profile->'groups') > 0 ELSE true END
        OR CASE WHEN er.id IS NULL THEN false
             WHEN jsonb_typeof(er.profile->'rules') = 'array' THEN jsonb_array_length(er.profile->'rules') > 0 ELSE true END)
      AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_rule_conversions c WHERE c.store_connection_id = sc.id)
  )
  SELECT c.vendor_id, c.store_connection_id, c.eligible, c.pricing_revision_id, c.content_revision_id, c.ebay_rules_revision_id,
    EXISTS (SELECT 1 FROM dropship.dropship_audit_events a
      WHERE a.entity_type = 'dropship_store_connection' AND a.entity_id = c.store_connection_id::text AND a.event_type = $3::text
        AND a.payload->'plannerVersion' = to_jsonb($4::int)
        AND a.payload->'revisions' = jsonb_build_object('pricing', c.pricing_revision_id, 'content', c.content_revision_id,
          'ebayRules', c.ebay_rules_revision_id)) AS dead_lettered
  FROM candidates c
  ORDER BY c.vendor_id, c.store_connection_id`;

const MAX_INT4_ID = 2_147_483_647;

interface StoreRow {
  vendor_id: unknown;
  store_connection_id: unknown;
  eligible: unknown;
  pricing_revision_id: unknown;
  content_revision_id: unknown;
  ebay_rules_revision_id: unknown;
  dead_lettered: unknown;
}

export class PgDropshipRulesConversionJobSource implements RulesConversionJobSource {
  constructor(private readonly dbPool: Pick<Pool, "query"> = defaultPool) {}

  async listStores(input: { plannerVersion: number }): Promise<RulesConversionJobStores> {
    if (!Number.isSafeInteger(input.plannerVersion) || input.plannerVersion <= 0) {
      throw listingSettingsInvariantFailed("The rules conversion job's store list was asked outside its contract.", { invalid: ["plannerVersion"] });
    }
    let rows: StoreRow[];
    try {
      rows = (await this.dbPool.query<StoreRow>(STORES_SQL, [[...WRITABLE_STORE_STATUSES], [...WRITABLE_VENDOR_STATUSES],
        RULES_CONVERSION_FAILED_EVENT, input.plannerVersion, WRITABLE_ENTITLEMENT_STATUS])).rows;
    } catch (error) {
      throw mapListingSettingDatabaseError(error);
    }
    return splitStores(rows);
  }
}

/** Every row checked: int4 ids, each store once, booleans, head ids; a breach is a broken contract (fatal for the tick). */
function splitStores(rows: readonly StoreRow[]): RulesConversionJobStores {
  const seen = new Set<number>();
  const stores: RulesConversionJobStores = { eligible: [], notEligibleStoreIds: [], deadLetteredStoreIds: [] };
  for (const row of rows) {
    const { vendor_id: vendorId, store_connection_id: storeConnectionId, eligible, dead_lettered: deadLettered } = row;
    const revisions = rulesConversionHeadRevisionsSchema.safeParse({
      pricing: row.pricing_revision_id, content: row.content_revision_id, ebayRules: row.ebay_rules_revision_id,
    });
    if (!isInt4Id(vendorId) || !isInt4Id(storeConnectionId) || seen.has(storeConnectionId) || typeof eligible !== "boolean"
      || typeof deadLettered !== "boolean" || !revisions.success) {
      throw listingSettingsInvariantFailed("A store the rules conversion job listed failed its contract.", {
        storeConnectionId: String(storeConnectionId),
      });
    }
    seen.add(storeConnectionId);
    // Not eligible first: the job would not try such a store whatever it failed on before.
    if (!eligible) stores.notEligibleStoreIds.push(storeConnectionId);
    else if (deadLettered) stores.deadLetteredStoreIds.push(storeConnectionId);
    else stores.eligible.push({ vendorId, storeConnectionId, revisions: revisions.data } satisfies RulesConversionJobStore);
  }
  return stores;
}

function isInt4Id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}
