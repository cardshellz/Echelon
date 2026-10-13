import type { PoolClient } from "pg";
import type { VerifiedStockListing } from "../application/verified-listing-stock.service";
import type { QuantityPublicationScope } from "../domain/quantity-publication-admission";
import { QuantityPublicationAdmissionError } from "../domain/quantity-publication-admission";
import { InventoryPublicationMembershipError } from "../application/inventory-publication-membership.service";

const completedAttempt = `EXISTS(SELECT 1 FROM inventory.quantity_publication_attempts a
  LEFT JOIN inventory.quantity_publication_attempt_resolutions r ON r.attempt_id=a.id
  WHERE a.listing_setup_operation_id=s.operation_id AND (a.state='succeeded' OR r.terminal_outcome='completed'))`;

/** Called while the exact provider scope lock is held. An old acknowledgement
 * cannot authorize stock on a replacement listing before its saved handoff. */
export async function assertRecreatedListingStockReady(
  client: PoolClient,
  scopes: readonly QuantityPublicationScope[],
): Promise<void> {
  const walmart = scopes.filter(
    (scope) =>
      scope.providerKey === "walmart" &&
      scope.destinationKind === "channel_connection",
  );
  if (!walmart.length) return;
  const pending = await client.query(
    `SELECT s.operation_id,s.external_inventory_item_id
    FROM inventory.publication_listing_setup_scopes s
    JOIN inventory.inventory_publication_targets t ON t.id=s.publication_target_id
    JOIN jsonb_to_recordset($1::jsonb) AS incoming("connectionId" integer,"externalScopeId" text,"externalInventoryItemId" text)
      ON t.channel_connection_id=incoming."connectionId" AND t.external_scope_id=incoming."externalScopeId"
      AND s.external_inventory_item_id=incoming."externalInventoryItemId"
    WHERE s.recreation_evidence IS NOT NULL AND ${completedAttempt}
      AND NOT EXISTS(SELECT 1 FROM inventory.publication_listing_recreation_stock_receipts r
        JOIN inventory.publication_listing_setup_scopes finished ON finished.id=r.setup_scope_id
        WHERE finished.publication_target_id=s.publication_target_id AND finished.product_variant_id=s.product_variant_id
          AND finished.id>=s.id)
    LIMIT 1`,
    [JSON.stringify(walmart)],
  );
  if (pending.rowCount)
    throw new QuantityPublicationAdmissionError(
      "PUBLICATION_RECREATION_WAITING_FOR_ITEM",
      "Walmart is still publishing the recreated item. Its saved listing job will reconnect current stock automatically; do not submit another listing.",
    );
}

export interface RecreationStockScope {
  id: string;
  completed: boolean;
  publicationState: "queued" | "verified";
}

/** Configuration fence and target row lock serialize replay with another worker.
 * No new stock command is inferred from a changed WPID: Walmart can reuse it. */
export async function readRecreationStockScope(
  client: PoolClient,
  targetId: number,
  input: VerifiedStockListing,
): Promise<RecreationStockScope | null> {
  if (!input.setupOperationId) return null;
  const rows = await client.query<{
    id: string;
    submitted: boolean;
    external_product_id: string | null;
    state: string | null;
    last_error_class: string | null;
  }>(
    `
    SELECT s.id::text,${completedAttempt} AS submitted,r.external_product_id,o.state,o.last_error_class
    FROM inventory.publication_listing_setup_scopes s
    LEFT JOIN inventory.publication_listing_recreation_stock_receipts r ON r.setup_scope_id=s.id
    LEFT JOIN LATERAL (SELECT o.state,o.last_error_class FROM inventory.inventory_publication_outbox o
       JOIN inventory.inventory_publication_targets t ON t.id=o.publication_target_id AND t.revision=o.publication_target_revision_snapshot
       WHERE o.publication_target_id=s.publication_target_id AND o.product_variant_id=s.product_variant_id
         AND o.id>=r.outbox_id AND o.external_inventory_item_id_snapshot=s.external_inventory_item_id
       ORDER BY o.desired_revision DESC LIMIT 1) o ON true
    WHERE s.operation_id=$1 AND s.publication_target_id=$2 AND s.product_variant_id=$3
      AND s.external_inventory_item_id=$4 AND s.recreation_evidence IS NOT NULL`,
    [input.setupOperationId, targetId, input.productVariantId, input.sku],
  );
  const scope = rows.rows[0];
  if (rows.rowCount !== 1 || !scope.submitted)
    throw new InventoryPublicationMembershipError(
      "STOCK_RECREATION_RECEIPT_MISSING",
      "The recreated item has no completed zero-stock submission for this exact SKU. Check its saved listing request before reconnecting stock.",
    );
  if (
    scope.external_product_id &&
    scope.external_product_id !== input.externalProductId
  )
    throw new InventoryPublicationMembershipError(
      "STOCK_RECREATION_IDENTITY_CHANGED",
      "Walmart returned a different product identity after stock was connected. Review the listing mapping.",
    );
  const newer = await client.query(
    `SELECT 1 FROM inventory.publication_listing_setup_scopes s
    WHERE s.publication_target_id=$1 AND s.product_variant_id=$2 AND s.id>$3
      AND EXISTS(SELECT 1 FROM inventory.quantity_publication_attempts a
        WHERE a.listing_setup_operation_id=s.operation_id AND a.state NOT IN ('not_sent','rejected')) LIMIT 1`,
    [targetId, input.productVariantId, scope.id],
  );
  if (newer.rowCount)
    throw new InventoryPublicationMembershipError(
      "STOCK_RECREATION_SUPERSEDED",
      "A newer recreation owns this SKU. Continue its saved listing request.",
    );
  if (
    scope.external_product_id &&
    scope.last_error_class === "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED"
  )
    throw new InventoryPublicationMembershipError(
      "STOCK_RECREATION_OUTCOME_UNCERTAIN",
      "The item is published, but a prior Walmart stock request has no final response on record. An inventory administrator must review that request in Stalled publication recovery. After its recorded outcome is resolved, the saved stock update retries automatically. Do not recreate the listing again.",
    );
  if (
    scope.external_product_id &&
    ["dead_letter", "cancelled"].includes(scope.state ?? "")
  )
    throw new InventoryPublicationMembershipError(
      "STOCK_RECREATION_DELIVERY_STOPPED",
      `The recreated item is published, but its stock update ${scope.state === "cancelled" ? "was cancelled" : "failed"} (${scope.last_error_class ?? "no failure code"}). Open this product's Stock preview in Channel Inventory to inspect the failed update and correct the reported connection or stock setup. Do not recreate the listing again.`,
    );
  return {
    id: scope.id,
    completed: scope.external_product_id !== null,
    publicationState: scope.state === "verified" ? "verified" : "queued",
  };
}

export async function recordRecreationStockReceipt(
  client: PoolClient,
  scopeId: string,
  targetId: number,
  input: VerifiedStockListing,
  actor: string,
  now: Date,
): Promise<void> {
  const saved = await client.query(
    `INSERT INTO inventory.publication_listing_recreation_stock_receipts
    (setup_scope_id,external_product_id,outbox_id,observed_at,created_at,actor)
    SELECT $1,$2,o.id,$3,$4,$5 FROM inventory.inventory_publication_outbox o
    WHERE o.publication_target_id=$6 AND o.product_variant_id=$7 AND o.state='queued'
    ORDER BY o.desired_revision DESC LIMIT 1 RETURNING outbox_id`,
    [
      scopeId,
      input.externalProductId,
      input.observedAt,
      now,
      actor,
      targetId,
      input.productVariantId,
    ],
  );
  if (saved.rowCount !== 1)
    throw new InventoryPublicationMembershipError(
      "STOCK_RECREATION_QUEUE_MISSING",
      "Current stock was not queued. The saved recreation will retry the complete handoff.",
    );
  await client.query(
    `INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES($1,'AUDIT',$2,'inventory_availability.listing_recreation.stock_queued',$3,$4::jsonb,$5::jsonb)`,
    [
      now,
      actor,
      `inventory.publication_listing_setup_scope:${scopeId}`,
      JSON.stringify({ outboxId: saved.rows[0].outbox_id }),
      JSON.stringify({
        setupOperationId: input.setupOperationId,
        observation: input,
      }),
    ],
  );
}
