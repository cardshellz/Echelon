import {
  readStockClearingScopeBindings,
  stockClearingAttemptMembersSql,
  stockClearingCatchupMembersSql,
} from "./stock-clearing-scope.reader";
import { QUANTITY_PUBLICATION_LOCK_NAMESPACE } from "./quantity-publication-admission.repository";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { z } from "zod";

const inputSchema = z
  .object({
    destinationKind: z.enum([
      "channel_connection",
      "dropship_store_connection",
    ]),
    connectionId: z.number().int().positive(),
    accountId: z.string().min(1),
    providerKey: z.enum(["ebay", "shopify", "walmart"]),
    productId: z.number().int().positive(),
    productVariantIds: z.array(z.number().int().positive()).max(250),
  })
  .strict();
export interface StockClearingEvidence {
  productVariantId: number;
  state: "settled" | "pending" | "attention";
  code: string;
  message: string;
  references: string[];
}

/** Read-only completion evidence, not an ATP calculation or a clearing command.
 * Caller owns a transaction and the quantity publication fence. Acknowledgement,
 * catch-up settlement and superseded observations cannot stand in for current proof.
 * Content-only changes do not invalidate a verified zero. Exact target/mapping
 * identity and later quantity work, not delivery age, determine whether it is current. */
export async function readStockClearingEvidence(
  client: StockSelectionQueryClient,
  raw: z.infer<typeof inputSchema>,
): Promise<StockClearingEvidence[]> {
  const input = inputSchema.parse(raw);
  await client.query(
    `SELECT id FROM inventory.inventory_publication_targets WHERE destination_kind=$1
    AND COALESCE(channel_connection_id,dropship_store_connection_id)=$2 FOR SHARE`,
    [input.destinationKind, input.connectionId],
  );
  await client.query(
    `SELECT h.publication_target_id FROM inventory.publication_variant_mapping_heads h
    JOIN inventory.inventory_publication_targets t ON t.id=h.publication_target_id
    WHERE t.destination_kind=$1 AND COALESCE(t.channel_connection_id,t.dropship_store_connection_id)=$2
      AND h.product_variant_id=ANY($3::int[]) FOR SHARE OF h`,
    [input.destinationKind, input.connectionId, input.productVariantIds],
  );
  const bindings = await readStockClearingScopeBindings(client, input);
  const bindingJson = JSON.stringify(bindings);
  const work = (
    await client.query<{
      product_variant_id: number;
      kind: string;
      id: string;
    }>(
      `WITH bindings AS (SELECT * FROM jsonb_to_recordset($5::jsonb) AS b("productVariantId" int,"scopeKey" text)),
       attempt_source AS MATERIALIZED (SELECT id,state,completed_at,scope,scope_key,affected_scope_keys,affected_scopes
         FROM inventory.quantity_publication_attempts WHERE state IN ('running','uncertain')),
       attempts AS MATERIALIZED (${stockClearingAttemptMembersSql}),
       catchup AS (${stockClearingCatchupMembersSql})
       SELECT product_variant_id,'request' kind,id::text FROM attempts WHERE state IN ('running','uncertain')
       UNION ALL SELECT product_variant_id,'catchup',id::text FROM catchup
       UNION ALL SELECT product_variant_id,'outbox',id::text FROM inventory.inventory_publication_outbox
       WHERE destination_kind_snapshot=$1 AND COALESCE(channel_connection_id_snapshot,dropship_store_connection_id_snapshot)::text=$2
         AND product_variant_id=ANY($3::integer[]) AND state NOT IN ('verified','cancelled','superseded')`,
      [
        input.destinationKind,
        String(input.connectionId),
        input.productVariantIds,
        input.productId,
        bindingJson,
      ],
    )
  ).rows;
  const proofs = (
    await client.query<{
      product_variant_id: number;
      target_id: number;
      readback_id: string | null;
    }>(
      `WITH bindings AS (SELECT * FROM jsonb_to_recordset($6::jsonb) AS b("productVariantId" int,"scopeKey" text)),
       attempt_source AS MATERIALIZED (SELECT id,state,completed_at,scope,scope_key,affected_scope_keys,affected_scopes
         FROM inventory.quantity_publication_attempts WHERE completed_at IS NOT NULL),
       attempts AS MATERIALIZED (${stockClearingAttemptMembersSql})
       SELECT v.id product_variant_id,t.id target_id,proof.id::text readback_id
     FROM unnest($3::integer[]) v(id)
     JOIN inventory.inventory_publication_targets t ON t.destination_kind=$1
       AND COALESCE(t.channel_connection_id,t.dropship_store_connection_id)::text=$2
       AND (EXISTS(SELECT 1 FROM inventory.publication_variant_mapping_heads owned WHERE owned.publication_target_id=t.id AND owned.product_variant_id=v.id)
         OR EXISTS(SELECT 1 FROM inventory.inventory_publication_outbox retained WHERE retained.publication_target_id=t.id AND retained.product_variant_id=v.id))
     LEFT JOIN inventory.publication_variant_mapping_heads h ON h.publication_target_id=t.id AND h.product_variant_id=v.id
     LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id=h.active_mapping_id AND m.publication_target_id=t.id
       AND m.product_variant_id=v.id AND m.lifecycle_status='sealed'
     LEFT JOIN LATERAL (
       SELECT r.id FROM inventory.inventory_publication_readbacks r
       JOIN inventory.inventory_publication_outbox o ON o.id=r.outbox_id
       WHERE r.publication_target_id=t.id AND r.product_variant_id=v.id
         AND r.destination_kind_snapshot=t.destination_kind
         AND r.channel_connection_id_snapshot IS NOT DISTINCT FROM t.channel_connection_id
         AND r.dropship_store_connection_id_snapshot IS NOT DISTINCT FROM t.dropship_store_connection_id
         AND r.publication_target_revision_snapshot=t.revision AND r.provider_scope_type_snapshot=t.provider_scope_type
         AND r.external_scope_id_snapshot=t.external_scope_id AND r.external_inventory_item_id_snapshot=m.external_inventory_item_id
         AND (t.provider_scope_type='location' OR (t.provider_scope_type='account' AND t.external_scope_id=$5))
         AND o.state='verified' AND o.desired_quantity=0 AND r.observed_quantity=0 AND r.quantity_consistent IS DISTINCT FROM false AND r.matches_desired=true
         AND o.publication_target_id=t.id AND o.product_variant_id=v.id
         AND o.external_inventory_item_id_snapshot=m.external_inventory_item_id
         AND NOT EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox later
           WHERE later.publication_target_id=t.id AND later.product_variant_id=v.id AND later.desired_revision>o.desired_revision
             AND later.state NOT IN ('cancelled','superseded'))
         AND NOT EXISTS (SELECT 1 FROM attempts a
           WHERE a.product_variant_id=v.id AND a.completed_at>r.observed_at)
       ORDER BY r.observed_at DESC,r.id DESC LIMIT 1
     ) proof ON true`,
      [
        input.destinationKind,
        String(input.connectionId),
        input.productVariantIds,
        input.productId,
        input.accountId,
        bindingJson,
      ],
    )
  ).rows;
  return input.productVariantIds.map((productVariantId) => {
    const pending = work.filter(
      (row) => row.product_variant_id === productVariantId,
    );
    if (pending.length)
      return {
        productVariantId,
        state: "pending",
        code: "LISTING_STOCK_WORK_OUTSTANDING",
        message:
          "Stock clearing has unfinished or unconfirmed channel work. Its existing owner must complete or reconcile it.",
        references: [
          ...new Set(pending.map((row) => row.kind + ":" + row.id)),
        ].slice(0, 100),
      };
    const targets = proofs.filter(
      (row) => row.product_variant_id === productVariantId,
    );
    if (targets.length && targets.every((row) => row.readback_id !== null))
      return {
        productVariantId,
        state: "settled",
        code: "LISTING_STOCK_CLEARING_VERIFIED",
        message:
          "Zero stock was verified for every exact retained destination; no later channel work remains.",
        references: targets
          .map((row) => "readback:" + row.readback_id)
          .slice(0, 100),
      };
    return {
      productVariantId,
      state: "attention",
      code: "LISTING_STOCK_CLEARING_UNPROVEN",
      message:
        "Stock clearing is not verified for every exact destination. Open stock status to check its mapping, outstanding work and provider confirmation.",
      references: [],
    };
  });
}

/** Non-waiting exclusive fence: never read completion through an in-flight
 * publication, or deadlock against a catalog selection change. No rows change. */
export async function fenceStockClearingEvidence(
  client: StockSelectionQueryClient,
): Promise<void> {
  const result = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1,0) acquired",
    [QUANTITY_PUBLICATION_LOCK_NAMESPACE],
  );
  if (!result.rows[0]?.acquired) {
    const error = new Error(
      "Channel publication or selection is changing; retry the lifecycle observation.",
    );
    Object.assign(error, { code: "LISTING_LIFECYCLE_EVIDENCE_BUSY" });
    throw error;
  }
}
