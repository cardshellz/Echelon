import { sql, type SQL } from "drizzle-orm";

/**
 * eBay sync-back's operations health (plan v4 §10, §6.3, R7, R14): read-only
 * SQL fragments, one count and one sample query per issue, that OMS
 * operations health embeds instead of reading dropship's tables itself
 * (published through server/modules/dropship/marketplace-sync-health.ts).
 * Dependency-free on purpose (drizzle `sql` only): a read-only caller must not
 * load the sync runtime or its pool. Samples carry ids, codes and counts only.
 * Every issue clears when the condition it counts is gone: some by
 * themselves, the review states only when a person resolves them.
 */
export interface DropshipMarketplaceSyncHealthCheck {
  code: string;
  severity: "critical" | "warning";
  message: string;
  countSql: SQL;
  sampleSql: SQL;
}

const SAMPLE_LIMIT = 10;
/**
 * The listing issue codes that mean Card Shellz cannot prove the eBay listing
 * is its own (§4.2), and the sweep's own dead letter. Kept equal to the
 * domain's MARKETPLACE_IDENTITY_ISSUE_CODES plus sync_requires_review by a
 * unit test, so this file stays free of the domain's runtime imports.
 */
export const NEEDS_REVIEW_ISSUE_CODES: readonly string[] = Object.freeze(["sku_changed", "offer_missing", "variation_listing_unsupported",
  "observation_unreadable", "sync_requires_review"]);
/** The sweep's restore push jobs carry this key prefix (marketplaceQuantityRestoreJobKey). */
const RESTORE_JOB_KEY_PATTERN = "ebay-sync:quantity:%";
/** The reason an intake stopped retrying carries (order-processing-retry.ts ORDER_PROCESSING_RETRIES_EXHAUSTED_CODE, then ": ..."). */
const RETRIES_EXHAUSTED_REASON_PATTERN = "DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED:%";
/** An eBay cancel dead-lettered for review on a taken-in order (marketplace-order-cancel.ts MARKETPLACE_CANCEL_STATUSES.unprocessable). */
const UNPROCESSABLE_CANCEL_STATUS = "marketplace_cancel_unprocessable";
/** A dead letter of an order Card Shellz never took in, within the last 7 days (dropship-ebay-marketplace-order-effects.repository.ts). */
const CANCEL_DEAD_LETTER_WITHOUT_INTAKE = sql`e.event_type = 'order_marketplace_cancel_unprocessable' AND e.created_at > NOW() - INTERVAL '7 days'
  AND NOT EXISTS (SELECT 1 FROM dropship.dropship_order_intake oi
    WHERE oi.store_connection_id = e.store_connection_id AND oi.external_order_id = e.payload->>'externalOrderId')`;
/** The correction rate warns above max(25, 10% of the listings read in 24 hours) (§10). */
const CORRECTION_RATE_FLOOR = 25;
const CORRECTION_RATE_DIVISOR = 10;

/** Listings the sweep reads (its selection, without the push-item condition). */
const SWEPT = sql`l.platform = 'ebay' AND l.external_offer_id IS NOT NULL AND btrim(l.external_offer_id) <> ''
  AND ((l.status = ANY(ARRAY['active','drift_detected','queued','failed','blocked']::text[]) AND l.external_listing_id IS NOT NULL
      AND btrim(l.external_listing_id) <> '' AND l.external_listing_id IS DISTINCT FROM l.external_offer_id)
    OR (l.status = 'ended' AND l.marketplace_ended_at IS NOT NULL))`;

function listingIssue(where: SQL): { countSql: SQL; sampleSql: SQL } {
  return {
    countSql: sql`SELECT COUNT(*)::int AS count FROM dropship.dropship_vendor_listings l WHERE ${SWEPT} AND ${where}`,
    sampleSql: sql`SELECT l.id AS listing_id, l.vendor_id, l.store_connection_id, l.product_variant_id, l.external_listing_id,
        l.external_offer_id, l.marketplace_issue_codes, l.marketplace_sync_attempted_at, l.observed_marketplace_quantity_at,
        l.drift_detected_at
      FROM dropship.dropship_vendor_listings l WHERE ${SWEPT} AND ${where}
      ORDER BY l.drift_detected_at ASC NULLS LAST, l.id ASC LIMIT ${SAMPLE_LIMIT}`,
  };
}

const INCOMPATIBLE_POLICY_IN_USE = sql`c.compatible = false AND EXISTS (SELECT 1 FROM dropship.dropship_vendor_listings l
  WHERE l.store_connection_id = c.store_connection_id AND l.observed_fulfillment_policy_id = c.fulfillment_policy_id
    AND l.status <> 'ended' AND ${SWEPT})`;

export const DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS: readonly DropshipMarketplaceSyncHealthCheck[] = Object.freeze([
  {
    code: "DROPSHIP_MARKETPLACE_LISTING_NEEDS_REVIEW",
    severity: "critical",
    // PROPOSED (sync-back): staff words (operations health).
    message: "Card Shellz can't confirm some Dropship eBay listings are its own (custom label changed, listing gone, multi-variation, unreadable, or a sync failure), so it stopped updating them. Review them.",
    ...listingIssue(sql`l.marketplace_issue_codes && ARRAY['sku_changed','offer_missing','variation_listing_unsupported','observation_unreadable','sync_requires_review']::text[]`),
  },
  {
    code: "DROPSHIP_LISTING_POLICY_INCOMPATIBLE",
    severity: "warning",
    // PROPOSED (sync-back): staff words (operations health).
    message: "A Dropship eBay store's live shipping policy promises what Card Shellz can't fulfill. The vendor was told; orders that need it will fail at acceptance.",
    countSql: sql`SELECT COUNT(*)::int AS count FROM dropship.dropship_ebay_fulfillment_policy_checks c WHERE ${INCOMPATIBLE_POLICY_IN_USE}`,
    sampleSql: sql`SELECT c.store_connection_id, c.fulfillment_policy_id, c.issue_codes, c.checked_at
      FROM dropship.dropship_ebay_fulfillment_policy_checks c WHERE ${INCOMPATIBLE_POLICY_IN_USE}
      ORDER BY c.checked_at ASC, c.store_connection_id ASC LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: "DROPSHIP_LISTING_ENDED_OUT_OF_STOCK",
    severity: "warning",
    // drift_detected_at is the first sighting of the listing's open issues: at least 24 hours of some issue, the stock-out end among them.
    // PROPOSED (sync-back): staff words (operations health).
    message: "Dropship eBay listings eBay ended for lack of stock have not come back for over 24 hours. Check that Card Shellz has stock and that the restore push ran.",
    ...listingIssue(sql`'ended_out_of_stock' = ANY(l.marketplace_issue_codes) AND l.drift_detected_at < NOW() - INTERVAL '24 hours'`),
  },
  {
    code: "DROPSHIP_MARKETPLACE_SYNC_QUANTITY_PENDING",
    severity: "warning",
    // PROPOSED (sync-back): staff words (operations health).
    message: "A lower eBay quantity on some Dropship listings has waited over 2 hours for a decision, usually because the store's order poll is behind.",
    ...listingIssue(sql`l.observed_marketplace_quantity_at < NOW() - INTERVAL '2 hours'`),
  },
  {
    code: "DROPSHIP_LISTING_QUANTITY_RESTORE_BLOCKED",
    severity: "warning",
    // PROPOSED (sync-back): staff words (operations health).
    message: "Some Dropship eBay listings show stock while Card Shellz has none to publish, and a push cannot send 0. Check Card Shellz's stock for them, or ask the vendor to set them to 0 or end them on eBay.",
    ...listingIssue(sql`'quantity_restore_blocked' = ANY(l.marketplace_issue_codes)`),
  },
  {
    code: "DROPSHIP_MARKETPLACE_SYNC_NOTICE_DEAD_LETTER",
    severity: "critical",
    // PROPOSED (sync-back): staff words (operations health).
    message: "Some eBay sync-back notices to vendors were refused by the notification service for good and will not be sent. Review them.",
    countSql: sql`SELECT COUNT(*)::int AS count FROM dropship.dropship_marketplace_sync_notices n WHERE n.dead_lettered_at IS NOT NULL`,
    sampleSql: sql`SELECT n.id, n.vendor_id, n.store_connection_id, n.kind, n.batch_key, n.failure_code, n.dead_lettered_at
      FROM dropship.dropship_marketplace_sync_notices n WHERE n.dead_lettered_at IS NOT NULL
      ORDER BY n.dead_lettered_at DESC, n.id DESC LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: "DROPSHIP_MARKETPLACE_SYNC_CORRECTION_RATE",
    severity: "warning",
    // PROPOSED (sync-back): staff words (operations health).
    message: "eBay sync-back put Card Shellz quantities back, or flagged listings it can't confirm, unusually often in the last 24 hours. Check for a vendor tool or an eBay change overwriting listings.",
    countSql: sql`WITH corrections AS (
        SELECT (SELECT COUNT(*) FROM dropship.dropship_listing_push_job_items i
            JOIN dropship.dropship_listing_push_jobs j ON j.id = i.job_id
            WHERE j.idempotency_key LIKE ${RESTORE_JOB_KEY_PATTERN} AND j.created_at > NOW() - INTERVAL '24 hours')
          + (SELECT COUNT(*) FROM dropship.dropship_vendor_listings l WHERE ${SWEPT}
            AND l.marketplace_issue_codes && ARRAY['sku_changed','offer_missing','variation_listing_unsupported','observation_unreadable']::text[]
            AND l.drift_detected_at > NOW() - INTERVAL '24 hours') AS n),
      reads AS (
        SELECT COUNT(*)::int AS n FROM dropship.dropship_vendor_listings l
        WHERE ${SWEPT} AND l.marketplace_sync_attempted_at > NOW() - INTERVAL '24 hours')
      SELECT CASE WHEN corrections.n > GREATEST(${CORRECTION_RATE_FLOOR}, reads.n / ${CORRECTION_RATE_DIVISOR}) THEN corrections.n ELSE 0 END::int AS count
      FROM corrections, reads`,
    sampleSql: sql`SELECT j.store_connection_id, COUNT(i.id)::int AS restored_listings
      FROM dropship.dropship_listing_push_jobs j JOIN dropship.dropship_listing_push_job_items i ON i.job_id = j.id
      WHERE j.idempotency_key LIKE ${RESTORE_JOB_KEY_PATTERN} AND j.created_at > NOW() - INTERVAL '24 hours'
      GROUP BY j.store_connection_id ORDER BY restored_listings DESC, j.store_connection_id ASC LIMIT ${SAMPLE_LIMIT}`,
  },
  // Order fixes (plan v4 §7): every issue below clears when a person resolves its rows (one dead letter without an
  // intake row ages out after 7 days; nothing else holds its state).
  {
    code: "DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED",
    severity: "critical",
    // PROPOSED (sync-back): staff words (operations health).
    message: "Some Dropship orders failed every automatic retry (about 15 hours) and stopped. Check stock or the error on each, then Retry it.",
    countSql: sql`SELECT COUNT(*)::int AS count FROM dropship.dropship_order_intake oi
      WHERE oi.status = 'failed' AND oi.rejection_reason LIKE ${RETRIES_EXHAUSTED_REASON_PATTERN}`,
    sampleSql: sql`SELECT oi.id AS intake_id, oi.vendor_id, oi.store_connection_id, oi.external_order_id, oi.processing_attempt_count,
        oi.updated_at
      FROM dropship.dropship_order_intake oi WHERE oi.status = 'failed' AND oi.rejection_reason LIKE ${RETRIES_EXHAUSTED_REASON_PATTERN}
      ORDER BY oi.updated_at ASC, oi.id ASC LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: "DROPSHIP_ORDER_MARKETPLACE_CANCEL_REVIEW",
    severity: "critical",
    // PROPOSED (sync-back): staff words (operations health).
    message: "eBay cancelled some accepted Dropship orders and Card Shellz could not finish them: it could not prove the order stopped (a label was bought, it shipped, or the shipping engine could not confirm the cancel), the stop kept failing, or the refund could not be posted. Check each order's audit trail and decide it; no refund was made.",
    countSql: sql`SELECT COUNT(*)::int AS count FROM dropship.dropship_order_intake oi
      WHERE oi.status = 'accepted' AND oi.cancellation_status IN ('marketplace_cancel_review', 'marketplace_cancel_after_shipment')`,
    sampleSql: sql`SELECT oi.id AS intake_id, oi.vendor_id, oi.store_connection_id, oi.external_order_id, oi.oms_order_id, oi.cancellation_status,
        oi.marketplace_cancelled_at
      FROM dropship.dropship_order_intake oi
      WHERE oi.status = 'accepted' AND oi.cancellation_status IN ('marketplace_cancel_review', 'marketplace_cancel_after_shipment')
      ORDER BY oi.marketplace_cancelled_at ASC, oi.id ASC LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE",
    severity: "critical",
    // PROPOSED (sync-back): staff words (operations health).
    message: "Some eBay cancellations of Dropship orders could not be applied. Check each order's status by hand, then clear its cancellation status.",
    // Taken-in orders by their review state (no time window: it clears only when a person clears it, review ARCH-3);
    // an order Card Shellz never took in has no row to hold state, so its dead letter counts for 7 days.
    countSql: sql`SELECT ((SELECT COUNT(*) FROM dropship.dropship_order_intake oi WHERE oi.cancellation_status = ${UNPROCESSABLE_CANCEL_STATUS})
      + (SELECT COUNT(*) FROM dropship.dropship_audit_events e WHERE ${CANCEL_DEAD_LETTER_WITHOUT_INTAKE}))::int AS count`,
    sampleSql: sql`SELECT oi.vendor_id, oi.store_connection_id, oi.id AS intake_id, oi.external_order_id, oi.updated_at AS since
      FROM dropship.dropship_order_intake oi WHERE oi.cancellation_status = ${UNPROCESSABLE_CANCEL_STATUS}
      UNION ALL
      SELECT e.vendor_id, e.store_connection_id, NULL::integer, e.payload->>'externalOrderId', e.created_at
      FROM dropship.dropship_audit_events e WHERE ${CANCEL_DEAD_LETTER_WITHOUT_INTAKE}
      ORDER BY since ASC LIMIT ${SAMPLE_LIMIT}`,
  },
  {
    code: "DROPSHIP_ORDER_UNMATCHED_LISTING",
    severity: "warning",
    // PROPOSED (sync-back): staff words (operations health).
    message: "Some eBay orders sold a Card Shellz custom label on an item number Card Shellz doesn't know. They are parked, not shipped; the vendor was asked.",
    countSql: sql`SELECT COUNT(*)::int AS count FROM (SELECT DISTINCT u.store_connection_id, u.external_listing_id
      FROM dropship.dropship_unmatched_marketplace_orders u WHERE u.status = 'open') open_items`,
    sampleSql: sql`SELECT u.store_connection_id, u.external_listing_id, COUNT(*)::int AS open_lines, MIN(u.first_seen_at) AS first_seen_at
      FROM dropship.dropship_unmatched_marketplace_orders u WHERE u.status = 'open'
      GROUP BY u.store_connection_id, u.external_listing_id ORDER BY first_seen_at ASC, u.store_connection_id ASC LIMIT ${SAMPLE_LIMIT}`,
  },
]);
