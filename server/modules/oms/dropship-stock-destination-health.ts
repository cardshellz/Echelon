import { sql, type SQL } from "drizzle-orm";
// Direct file import, as OMS already does for inventory-cutover-retired-work: the
// published barrel (quantity-publication.ts) loads the publication runtime and its pool.
import { dropshipStockDestinationSourceReadySql } from "../inventory-planning/infrastructure/dropship-stock-destination-source-ready.sql";

/**
 * DROPSHIP_STOCK_DESTINATION_MISSING (Fix PR 2a-2, plan F2 2.7, owner decision
 * Q1 default): a connected Dropship eBay store that should publish Card Shellz
 * stock but has no single live Card Shellz stock destination that is ready to
 * publish. Its managed live pushes are refused before any eBay write
 * (DROPSHIP_STOCK_DESTINATION_NOT_READY / _DUPLICATED, for an operator), its
 * one-time re-sends (owner Q4) wait, and its eBay quantities are not updating.
 * Nothing is created or turned on automatically (the design forbids guessing
 * supply warehouses or publisher), so a human must; critical, because only
 * critical issues reach the ops alert webhook (oms-ops-alert.service.ts).
 *
 * DROPSHIP_STOCK_DESTINATION_HELD (warning, review CF-3): the store's one live
 * destination is on hold. A hold is an operator's own deliberate pause (pushes
 * are refused DROPSHIP_STOCK_STORE_ON_HOLD, the vendor is told), so it is shown,
 * not paged.
 *
 * Read-only and schema-free, like the other cross-schema checks of
 * ops-health.service.ts. A store counts only while:
 * - inventory authority is canonical (under legacy no destination is needed);
 * - the store is a connected eBay store with a provider-verified account id;
 * - its active listing configuration is live + Card Shellz-managed quantity
 *   (the only mode that publishes stock);
 * - it has demand: a listing with an eBay identity, a push in the window (14 days,
 *   the ops-health convention), or a failure from before the automatic stock link
 *   that waits for its one-time re-send (owner Q4);
 * - and its destination status is not `live`.
 * The status is the stock link's own destination choice (review MC-1), the same as
 * inventory-planning's readDropshipEbayStockDestination (its readTargets source
 * readiness for a Dropship destination, which inventory-planning supplies as an SQL
 * fragment, dropshipStockDestinationSourceReadySql, because only it reads the
 * supply definitions; a PostgreSQL test pins the two together for every status):
 *   missing           no destination for the store's account;
 *   not_live          destinations, none live with Echelon publishing;
 *   duplicated        more than one live one;
 *   held              the one live destination is on hold (warning issue);
 *   source_not_ready  the one live destination has no sealed supply binding with
 *                     members, a binding node that is missing or not active, or an
 *                     inactive policy channel;
 *   live              ready: no issue.
 */
export const DROPSHIP_STOCK_DESTINATION_MISSING_CODE = "DROPSHIP_STOCK_DESTINATION_MISSING";
export const DROPSHIP_STOCK_DESTINATION_HELD_CODE = "DROPSHIP_STOCK_DESTINATION_HELD";

export const DROPSHIP_STOCK_DESTINATION_MISSING_MESSAGE =
  "A connected Dropship eBay store has listings but no single live Card Shellz stock destination that is ready to publish, so its eBay quantities are not updating. Set up, turn on or finish (sealed supply warehouse) its stock destination in Channel Inventory.";

export const DROPSHIP_STOCK_DESTINATION_HELD_MESSAGE =
  "A connected Dropship eBay store's Card Shellz stock destination is on hold, so its listings are refused and its eBay quantities are not updating. Review the hold in Channel Inventory.";

/** Destination statuses the critical issue counts: nothing publishes and only setup fixes it. */
export const DROPSHIP_STOCK_DESTINATION_MISSING_STATUSES: readonly string[] = Object.freeze(["missing", "not_live", "duplicated", "source_not_ready"]);
/** The status the warning issue counts. */
export const DROPSHIP_STOCK_DESTINATION_HELD_STATUSES: readonly string[] = Object.freeze(["held"]);

/** A failed push from before the automatic stock link existed, still waiting for its one-time re-send (owner Q4, review MC-3). */
const WAITING_RESEND_SQL = sql`EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items ji
          JOIN dropship.dropship_listing_push_jobs j ON j.id = ji.job_id
          WHERE j.store_connection_id = s.store_connection_id AND ji.status = 'failed'
            AND ji.error_code = 'PUBLICATION_LISTING_TARGET_UNMAPPED'
            AND NOT (COALESCE(ji.result, '{}'::jsonb) ? 'automaticRequeue')
            AND COALESCE(ji.result -> 'push' -> 'context' ->> 'recordedWithAutomaticStockLink', '') <> 'true')`;

function storesByDestinationStatus(window: SQL, statuses: readonly string[]): SQL {
  return sql`
    WITH canonical AS (
      SELECT 1 FROM inventory.availability_runtime_authority
      WHERE singleton_key = true AND authority = 'canonical'
    ),
    managed_stores AS (
      SELECT sc.id AS store_connection_id, sc.vendor_id, BTRIM(sc.external_account_id) AS account_id
      FROM dropship.dropship_store_connections sc
      JOIN dropship.dropship_store_listing_configs lc
        ON lc.store_connection_id = sc.id AND lc.platform = sc.platform
      WHERE EXISTS (SELECT 1 FROM canonical)
        AND sc.platform = 'ebay' AND sc.status = 'connected'
        AND sc.external_account_identity_scheme = 'provider_user_id'
        AND NULLIF(BTRIM(sc.external_account_id), '') IS NOT NULL
        AND lc.is_active = true AND lc.listing_mode = 'live' AND lc.inventory_mode = 'managed_quantity_sync'
    ),
    store_targets AS (
      SELECT s.store_connection_id, t.state, t.publication_authority, t.held_at,
        ${dropshipStockDestinationSourceReadySql()} AS source_ready
      FROM managed_stores s
      JOIN inventory.inventory_publication_targets t
        ON t.destination_kind = 'dropship_store_connection' AND t.dropship_store_connection_id = s.store_connection_id
       AND t.provider_scope_type = 'account' AND t.external_scope_id = s.account_id
    ),
    store_demand AS (
      SELECT s.store_connection_id, s.vendor_id,
        (SELECT COUNT(*)::int FROM dropship.dropship_vendor_listings vl
          WHERE vl.store_connection_id = s.store_connection_id AND vl.platform = 'ebay'
            AND (NULLIF(BTRIM(vl.external_offer_id), '') IS NOT NULL
              OR NULLIF(BTRIM(vl.external_listing_id), '') IS NOT NULL)) AS listing_count,
        EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items ji
          JOIN dropship.dropship_listing_push_jobs j ON j.id = ji.job_id
          WHERE j.store_connection_id = s.store_connection_id AND ji.created_at > ${window}) AS recent_push,
        ${WAITING_RESEND_SQL} AS waiting_resend,
        (SELECT COUNT(*)::int FROM store_targets st WHERE st.store_connection_id = s.store_connection_id) AS destination_count,
        (SELECT COUNT(*)::int FROM store_targets st WHERE st.store_connection_id = s.store_connection_id
          AND st.state = 'live' AND st.publication_authority = 'echelon') AS live_destination_count,
        (SELECT bool_and(st.held_at IS NOT NULL) FROM store_targets st WHERE st.store_connection_id = s.store_connection_id
          AND st.state = 'live' AND st.publication_authority = 'echelon') AS live_destination_held,
        (SELECT bool_and(st.source_ready) FROM store_targets st WHERE st.store_connection_id = s.store_connection_id
          AND st.state = 'live' AND st.publication_authority = 'echelon') AS live_destination_source_ready
      FROM managed_stores s
    ),
    store_status AS (
      SELECT store_connection_id, vendor_id, listing_count, recent_push, waiting_resend, live_destination_count,
        CASE
          WHEN live_destination_count > 1 THEN 'duplicated'
          WHEN live_destination_count = 1 AND live_destination_held THEN 'held'
          WHEN live_destination_count = 1 AND NOT live_destination_source_ready THEN 'source_not_ready'
          WHEN live_destination_count = 1 THEN 'live'
          WHEN destination_count = 0 THEN 'missing'
          ELSE 'not_live'
        END AS destination_status
      FROM store_demand
      WHERE listing_count > 0 OR recent_push OR waiting_resend
    )
    SELECT store_connection_id, vendor_id, listing_count, recent_push, waiting_resend, live_destination_count, destination_status
    FROM store_status
    WHERE destination_status IN (${sql.join(statuses.map(status => sql`${status}`), sql`, `)})
  `;
}

function countSql(window: SQL, statuses: readonly string[]): SQL {
  return sql`SELECT COUNT(*)::int AS count FROM (${storesByDestinationStatus(window, statuses)}) destination_issue`;
}

function sampleSql(window: SQL, statuses: readonly string[], limit: number): SQL {
  return sql`SELECT store_connection_id, vendor_id, listing_count, recent_push, waiting_resend, live_destination_count, destination_status
    FROM (${storesByDestinationStatus(window, statuses)}) destination_issue
    ORDER BY store_connection_id ASC
    LIMIT ${limit}`;
}

export function dropshipStockDestinationMissingCountSql(window: SQL): SQL {
  return countSql(window, DROPSHIP_STOCK_DESTINATION_MISSING_STATUSES);
}

export function dropshipStockDestinationMissingSampleSql(window: SQL, limit: number): SQL {
  return sampleSql(window, DROPSHIP_STOCK_DESTINATION_MISSING_STATUSES, limit);
}

export function dropshipStockDestinationHeldCountSql(window: SQL): SQL {
  return countSql(window, DROPSHIP_STOCK_DESTINATION_HELD_STATUSES);
}

export function dropshipStockDestinationHeldSampleSql(window: SQL, limit: number): SQL {
  return sampleSql(window, DROPSHIP_STOCK_DESTINATION_HELD_STATUSES, limit);
}

/**
 * DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED (critical, review CF-5): a Dropship eBay
 * listing whose newest Card Shellz stock revision was refused for good by the
 * outbox adapter's offer identity guard (dropship-ebay-inventory-publication.adapter
 * assertRecordedOffer): eBay shows one PUBLISHED offer for the SKU, but it is not
 * the offer the vendor listing recorded (DROPSHIP_EBAY_OFFER_IDENTITY_CHANGED), or
 * no completed push recorded one at all (DROPSHIP_EBAY_OFFER_IDENTITY_UNPROVEN; for
 * example a push that published and then failed before its result was saved). No
 * quantity was sent, so that published offer keeps its last quantity while stock
 * moves: an oversell risk a human must look at. Queueing the listing again records
 * the offer (or refuses a foreign one); the next stock revision then publishes.
 * Read-only; the newest revision per destination and variant decides, so a later
 * verified revision clears it.
 *
 * Also counted (review AV1-1): a revision the outbox gave up on (its attempt cap)
 * while it waited for a running push, with a PUBLISHED offer the listing had not
 * recorded (DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT), once no push of that
 * store variant is queued or processing any more. While one still runs it is not
 * counted: that push records the offer and its own admitted quantity write makes a
 * newer revision (a dead letter is never reused), which clears the issue. If it ends
 * without writing (refused before its first write, failed), the offer keeps its
 * last quantity, exactly as for the two permanent refusals. The adapter's other wait
 * (DROPSHIP_EBAY_LISTING_PUSH_IN_FLIGHT: no PUBLISHED offer found yet) is not
 * counted here, because no single published offer was found to be frozen.
 */
export const DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED_CODE = "DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED";

export const DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED_MESSAGE =
  "A Dropship eBay listing has a published eBay offer that is not the one Card Shellz recorded for it, so its Card Shellz stock updates are refused and its eBay quantity is not updating. Check the listing on eBay, then queue it again.";

/** The outbox adapter's permanent offer identity refusals (no quantity was sent). */
export const DROPSHIP_EBAY_OFFER_IDENTITY_DEAD_LETTER_CLASSES: readonly string[] = Object.freeze([
  "DROPSHIP_EBAY_OFFER_IDENTITY_CHANGED", "DROPSHIP_EBAY_OFFER_IDENTITY_UNPROVEN",
]);

/** The adapter's wait for a running push while a PUBLISHED offer it has not recorded is on sale (review AV1-1). */
export const DROPSHIP_EBAY_PUBLISHED_OFFER_WAIT_DEAD_LETTER_CLASS = "DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT";

/** A queued or processing push of the store variant: the same predicate as the adapter's identity reader (pushInFlight). */
const PUSH_IN_FLIGHT_SQL = sql`EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items ji
          JOIN dropship.dropship_listing_push_jobs j ON j.id = ji.job_id
          WHERE j.store_connection_id = t.dropship_store_connection_id AND ji.product_variant_id = newest.product_variant_id
            AND j.job_type = 'push' AND ji.action = 'push'
            AND j.status IN ('queued', 'processing') AND ji.status IN ('queued', 'processing'))`;

function offersWithIdentityDeadLetter(): SQL {
  return sql`
    SELECT newest.publication_target_id, t.dropship_store_connection_id AS store_connection_id, newest.product_variant_id,
      newest.external_inventory_item_id_snapshot AS sku, newest.last_error_class, newest.desired_quantity::text AS desired_quantity,
      newest.updated_at
    FROM (
      SELECT DISTINCT ON (o.publication_target_id, o.product_variant_id) o.publication_target_id, o.product_variant_id,
        o.external_inventory_item_id_snapshot, o.state, o.last_error_class, o.desired_quantity, o.updated_at
      FROM inventory.inventory_publication_outbox o
      ORDER BY o.publication_target_id, o.product_variant_id, o.desired_revision DESC
    ) newest
    JOIN inventory.inventory_publication_targets t ON t.id = newest.publication_target_id
    JOIN dropship.dropship_store_connections sc ON sc.id = t.dropship_store_connection_id
    WHERE t.destination_kind = 'dropship_store_connection' AND sc.platform = 'ebay'
      AND newest.state = 'dead_letter'
      AND (newest.last_error_class IN (${sql.join(DROPSHIP_EBAY_OFFER_IDENTITY_DEAD_LETTER_CLASSES.map(code => sql`${code}`), sql`, `)})
        OR (newest.last_error_class = ${DROPSHIP_EBAY_PUBLISHED_OFFER_WAIT_DEAD_LETTER_CLASS} AND NOT ${PUSH_IN_FLIGHT_SQL}))
  `;
}

export function dropshipEbayStockOfferUnverifiedCountSql(): SQL {
  return sql`SELECT COUNT(*)::int AS count FROM (${offersWithIdentityDeadLetter()}) unverified_offer`;
}

export function dropshipEbayStockOfferUnverifiedSampleSql(limit: number): SQL {
  return sql`SELECT publication_target_id, store_connection_id, product_variant_id, sku, last_error_class, desired_quantity, updated_at
    FROM (${offersWithIdentityDeadLetter()}) unverified_offer
    ORDER BY updated_at DESC, publication_target_id ASC, product_variant_id ASC
    LIMIT ${limit}`;
}
