import { sql, type SQL } from "drizzle-orm";

/**
 * Store stock updates the canonical outbox refused for good (Channels PR1,
 * PLAN-CH-v3 section 6, Ops Health CHANNEL_STOCK_UPDATE_DEAD_LETTER).
 *
 * The outbox dead-letters a row on a non-retryable answer (for example Shopify's
 * 404/422 stock write, CH/adapters/shopify-inventory-write.error.ts) or at its attempt
 * cap (inventory-publication-outbox.repository.ts recordFailure). That store item then
 * keeps its last quantity.
 *
 * A dead letter counts until the store ACCEPTS a newer revision of the same
 * (destination, size): `acknowledged_at` is set when the provider accepts a write and
 * kept through verified and drifted (recordVerified), the same "store accepted" test
 * inventory-channel-publication-status.repository.ts uses. A newer revision that is
 * only queued does not clear it. After a refused Shopify write the request-admission
 * attempt stays "uncertain", so every newer revision of that item is refused with
 * PUBLICATION_PRIOR_OUTCOME_UNRESOLVED before any HTTP call
 * (quantity-publication-admission.repository.ts) and is retried, not delivered. The
 * issue clears when a person's fix reaches the store: an attested retry, a relink to a
 * new item, or any later update the store accepts.
 *
 * Only live channel-connection destinations under canonical authority. Dropship
 * destinations are excluded: their offer-identity dead letters have their own issue
 * (oms/dropship-stock-destination-health.ts). The target's destination kind is enough:
 * an outbox row's kind snapshot must equal its target's, and both are immutable
 * (migrations/220_inventory_publication_outbox_destination_owners.sql,
 * 0721_inventory_publication_direct_enable.sql).
 *
 * Read-only SQL fragments for one query each. OMS operations health embeds them
 * instead of reading the outbox itself. Dependency-free on purpose (drizzle `sql`
 * only), like dropship-stock-destination-source-ready.sql.ts: a read-only caller must
 * not load the publication runtime or its pool. The dead-letter state is reached
 * through the outbox dispatch index (state, available_at, id); the newer-revision test
 * uses the (target, variant, revision) unique key.
 *
 * N9 (channels PR2, PLAN-CH2 v4.1 §8, SAF-12): a refused item the stock-link engine has since retired is not an
 * open refusal any more. When the size's head has no active link and a version retired by the engine names the
 * dead letter's item, the size waits for a new store item (Ops Health STOCK_LINK_UNLINKED, info) instead of
 * alerting here. Only the engine retires, so no pair of PR1 is affected; a retire by anyone else, or a later link,
 * leaves the dead letter counted until a newer update reaches the store. `'system:stock-link'` is the engine's
 * actor (IP/domain/stock-link.ts STOCK_LINK_ACTOR), written as a literal so this file stays dependency-free and the
 * rendered SQL keeps its parameter list; a unit test pins the two equal.
 */
function unresolvedChannelStockDeadLetters(): SQL {
  return sql`
    SELECT o.id, o.publication_target_id, o.product_variant_id, o.last_error_class, o.updated_at,
      t.channel_id, t.channel_connection_id, t.external_scope_id
    FROM inventory.inventory_publication_outbox o
    JOIN inventory.inventory_publication_targets t ON t.id = o.publication_target_id
    WHERE o.state = 'dead_letter'
      AND t.destination_kind = 'channel_connection' AND t.state = 'live'
      AND EXISTS (SELECT 1 FROM inventory.availability_runtime_authority a
        WHERE a.singleton_key = true AND a.authority = 'canonical')
      AND NOT EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox accepted
        WHERE accepted.publication_target_id = o.publication_target_id
          AND accepted.product_variant_id = o.product_variant_id
          AND accepted.desired_revision > o.desired_revision
          AND accepted.acknowledged_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM inventory.publication_variant_mapping_heads h
        JOIN inventory.publication_variant_mapping_versions retired
          ON retired.publication_target_id = h.publication_target_id
         AND retired.product_variant_id = h.product_variant_id
        WHERE h.publication_target_id = o.publication_target_id
          AND h.product_variant_id = o.product_variant_id
          AND h.active_mapping_id IS NULL
          AND retired.lifecycle_status = 'retired'
          AND retired.retired_by = 'system:stock-link'
          AND btrim(retired.external_inventory_item_id) = btrim(o.external_inventory_item_id_snapshot))
  `;
}

/** Number of destinations (stores or store locations) with at least one refused
 * stock update. One line per store, so a burst of item refusals on one store is one
 * count, and a newly affected store changes the alert signature. */
export function channelStockUpdateDeadLetterDestinationCountSql(): SQL {
  return sql`SELECT COUNT(DISTINCT refused.publication_target_id)::int AS count
    FROM (${unresolvedChannelStockDeadLetters()}) refused`;
}

/** One row per destination: how many sizes are refused (a size refused more than once
 * counts once), every error code, up to 10 size ids, and up to 10 outbox ids (newest
 * first), which are the correlation ids of the outbox's dead-letter log lines. */
export function channelStockUpdateDeadLetterDestinationSampleSql(limit: number): SQL {
  return sql`SELECT refused.publication_target_id, refused.channel_id, c.name AS channel_name,
      lower(c.provider) AS provider_key, refused.channel_connection_id, refused.external_scope_id,
      COUNT(DISTINCT refused.product_variant_id)::int AS refused_sizes,
      ARRAY_AGG(DISTINCT refused.last_error_class ORDER BY refused.last_error_class) AS error_codes,
      (ARRAY_AGG(DISTINCT refused.product_variant_id ORDER BY refused.product_variant_id))[1:10] AS product_variant_ids,
      (ARRAY_AGG(refused.id::text ORDER BY refused.updated_at DESC, refused.id DESC))[1:10] AS outbox_ids,
      MAX(refused.updated_at) AS last_refused_at
    FROM (${unresolvedChannelStockDeadLetters()}) refused
    LEFT JOIN channels.channels c ON c.id = refused.channel_id
    GROUP BY refused.publication_target_id, refused.channel_id, c.name, c.provider,
      refused.channel_connection_id, refused.external_scope_id
    ORDER BY last_refused_at DESC, refused.publication_target_id ASC
    LIMIT ${limit}`;
}
