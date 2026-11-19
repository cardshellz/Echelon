import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { InventoryAvailabilityTransactionQueryClient as Client } from "../application/inventory-availability-transaction-query.port";
import type { QuantityPublicationCatchup, QuantityPublicationCatchupRetryClass } from "../application/quantity-publication-admission.port";
import { QuantityPublicationAdmissionError, quantityPublicationScopeSchema, type QuantityPublicationScope } from "../domain/quantity-publication-admission";
import { QUANTITY_CATCHUP_PARK_RECHECK_SECONDS, QUANTITY_CATCHUP_TRANSIENT_BACKOFF } from "../domain/quantity-publication-catchup-parking";

/**
 * Catch-up parking (Channels PR5, PLAN-CH-v3 section 6 "Catch-up" and "Wake matching"). Inventory planning owns
 * inventory.quantity_publication_catchup; these statements are its failure, park, settle and wake writes. None opens
 * a transaction: PostgresQuantityPublicationAdmission and the definition sealer own theirs.
 */

/**
 * SQL text that puts a provider item id in the one form links are compared in (V3-1): for Shopify a decimal id stays,
 * exactly `gid://shopify/InventoryItem/<decimal>` becomes that decimal, anything else is NULL and equals nothing
 * (domain/stock-link.ts normalizeShopifyItemId). Other providers compare exactly. Both arguments are SQL expressions
 * written by this module (column references or parameter slots), never caller text.
 */
export function normalizedProviderItemSql(itemSql: string, isShopifySql: string): string {
  return `(CASE WHEN ${isShopifySql} THEN (CASE WHEN ${itemSql} ~ '^[1-9][0-9]{0,19}$' THEN ${itemSql}
    ELSE substring(${itemSql} FROM '^gid://shopify/InventoryItem/([1-9][0-9]{0,19})$') END) ELSE ${itemSql} END)`;
}

const SETTLEMENT_ACTOR = "system:quantity-publication-catchup";
const sha256 = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Persists one failed pass by its class; returns the attempt count reached, or null when the claim is stale. */
export async function recordCatchupFailure(client: Client, input: {
  catchupId: string; revision: string; scopeKey: string; errorCode: string; message: string;
  retryClass: QuantityPublicationCatchupRetryClass; now: Date; pausedDelaySeconds: number;
}): Promise<number | null> {
  const { baseSeconds, maxSeconds, maxExponent } = QUANTITY_CATCHUP_TRANSIENT_BACKOFF;
  const rows = (await client.query<{ attempt_count: number }>(`UPDATE inventory.quantity_publication_catchup SET
      -- GREATEST: a failure never pulls a later schedule earlier. A permanent row keeps its time; listDue skips it.
      next_attempt_at=CASE $7::text
        WHEN 'paused' THEN GREATEST(next_attempt_at,$3::timestamptz+make_interval(secs => $8::int))
        WHEN 'transient' THEN GREATEST(next_attempt_at,$3::timestamptz+make_interval(secs =>
          LEAST($9::int*power(2,LEAST(attempt_count,$11::int)),$10::int)))
        ELSE next_attempt_at END,
      attempt_count=attempt_count+CASE WHEN $7::text='transient' THEN 1 ELSE 0 END,
      failure_class=$7::text,
      requires_review_at=CASE WHEN $7::text='permanent' THEN $3::timestamptz END,
      parked_at=NULL,parked_code=NULL,
      last_error_code=$4,last_error_message=$5,updated_at=$3::timestamptz
    WHERE id=$1 AND revision=$2 AND completed_revision<revision AND scope_key=$6
    RETURNING attempt_count`,
  [input.catchupId, input.revision, input.now.toISOString(), input.errorCode.slice(0, 200), input.message.slice(0, 2000),
    input.scopeKey, input.retryClass, input.pausedDelaySeconds, baseSeconds, maxSeconds, maxExponent])).rows;
  return rows.length === 1 ? Number(rows[0].attempt_count) : null;
}

/** Live, Echelon-managed targets of the scope's exact destination (alias `t`), as $1..$4. */
const SCOPE_TARGETS = `SELECT t.id FROM inventory.inventory_publication_targets t
  WHERE t.state='live' AND t.publication_authority='echelon' AND t.destination_kind=$1
    AND COALESCE(t.channel_connection_id,t.dropship_store_connection_id)=$2::integer
    AND t.provider_scope_type=$3 AND t.external_scope_id=$4`;

function scopeTargetParams(scope: QuantityPublicationScope): unknown[] {
  return [scope.destinationKind, scope.connectionId, scope.providerScopeType, scope.externalScopeId];
}

interface PersistedCatchup {
  revision: string; completed_revision: string; attempt_boundary_id: string; scope_key: string; scope: unknown; before_state: string;
}

/**
 * The caller holds the shared publication gate and the exact item lock until commit, inside a READ COMMITTED
 * transaction it owns. Returns "linked" (the item has an exact active link: not a missing-link wait), "settled",
 * "parked" or "superseded"; the caller commits only "settled" and "parked". 55P03 (authority row held by a link or
 * activation) propagates: the caller treats it as busy.
 */
export async function parkCatchupInsideTransaction(client: Client, claim: QuantityPublicationCatchup, scopeKey: string,
  input: { errorCode: string; message: string; occurredAt: string }): Promise<"linked" | "settled" | "parked" | "superseded"> {
  // A link writer holds this row FOR UPDATE under the cutover fence until it commits (and wakes parked rows then).
  // NOWAIT keeps the authority-before-publication order of archive settlement (archived-quantity-catchup-settlement.ts).
  const authority = (await client.query<{ authority: string; activation_run_id: string | null; suppressed: boolean }>(
    `SELECT auth.authority,auth.activation_run_id::text,gate.activation_run_id IS NOT NULL AS suppressed
     FROM inventory.availability_runtime_authority auth CROSS JOIN inventory.quantity_publication_gate gate
     WHERE auth.singleton_key=true AND gate.singleton=true FOR SHARE OF auth,gate NOWAIT`)).rows[0];
  const current = (await client.query<PersistedCatchup>(`SELECT revision::text,completed_revision::text,
    attempt_boundary_id::text,scope_key,scope,to_jsonb(catchup)::text AS before_state
    FROM inventory.quantity_publication_catchup catchup WHERE id=$1 FOR UPDATE`, [claim.catchupId])).rows[0];
  if (!current || current.revision !== claim.revision || current.attempt_boundary_id !== claim.attemptBoundaryId
    || BigInt(current.completed_revision) >= BigInt(claim.revision)) return "superseded";
  const scope = quantityPublicationScopeSchema.parse(current.scope);
  if (current.scope_key !== scopeKey || canonicalJson(scope) !== canonicalJson(claim.scope)) {
    throw new QuantityPublicationAdmissionError("PUBLICATION_CATCHUP_SCOPE_MISMATCH",
      "The catch-up claim no longer matches its saved provider and Catalog identity.");
  }

  // Link evidence is read only under canonical authority with an open gate and an active run, as archive settlement
  // does: otherwise no canonical link can be proven current, and the safe default is to keep waiting.
  const canonical = authority?.authority === "canonical" && !authority.suppressed
    && (await client.query(`SELECT 1 FROM inventory.availability_activation_runs WHERE id=$1 AND state='active' FOR SHARE`,
      [authority.activation_run_id])).rows.length === 1;
  if (canonical) {
    const exact = (await client.query(`SELECT 1 FROM inventory.publication_variant_mapping_heads h
      JOIN inventory.publication_variant_mapping_versions m ON m.id=h.active_mapping_id AND m.lifecycle_status='sealed'
      WHERE h.publication_target_id IN (${SCOPE_TARGETS}) AND m.external_inventory_item_id=$5 LIMIT 1`,
    [...scopeTargetParams(scope), scope.externalInventoryItemId])).rows.length > 0;
    // The refusal had another cause (two links, a stale size hint, a withheld plan): waiting for a link would never
    // end, so it retries with the counted backoff instead.
    if (exact) return "linked";
    const unresolved = (await client.query<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM inventory.quantity_publication_attempts
      WHERE affected_scope_keys @> ARRAY[$1] AND state IN ('running','uncertain')) AS present`, [scopeKey])).rows[0]?.present === true;
    if (!unresolved && await settleRetiredIdentity(client, claim, scope, scopeKey, current, input.occurredAt)) return "settled";
  }

  const parked = await client.query(`UPDATE inventory.quantity_publication_catchup SET
      failure_class='parked',parked_at=COALESCE(parked_at,$3::timestamptz),parked_code=$4,requires_review_at=NULL,
      next_attempt_at=GREATEST(next_attempt_at,$3::timestamptz+make_interval(secs => $6::int)),
      last_error_code=$4,last_error_message=$5,updated_at=$3::timestamptz
    WHERE id=$1 AND revision=$2 AND completed_revision<revision`,
  [claim.catchupId, claim.revision, input.occurredAt, input.errorCode.slice(0, 200), input.message.slice(0, 2000),
    QUANTITY_CATCHUP_PARK_RECHECK_SECONDS]);
  return parked.rowCount === 1 ? "parked" : "superseded";
}

/**
 * V3-13: the row's item is a retired identity of exactly one size of its destination (or that size's live link in its
 * other Shopify id form), and that size is now linked to another item. The new link's own outbox row carries the
 * quantity, so the obligation for the old identity ends with one immutable identity_retired receipt. Zero or two
 * candidate sizes settle nothing (keep waiting).
 */
async function settleRetiredIdentity(client: Client, claim: QuantityPublicationCatchup, scope: QuantityPublicationScope,
  scopeKey: string, current: PersistedCatchup, occurredAt: string): Promise<boolean> {
  const normalized = (item: string) => normalizedProviderItemSql(item, "$7::boolean");
  const candidates = (await client.query<{ publication_target_id: number; product_variant_id: number;
    matched_mapping_ids: number[]; active_mapping_id: number; active_item: string }>(`WITH matched AS (
      SELECT m.publication_target_id,m.product_variant_id,array_agg(m.id ORDER BY m.id) AS matched_mapping_ids
      FROM inventory.publication_variant_mapping_versions m
      WHERE m.publication_target_id IN (${SCOPE_TARGETS}) AND m.lifecycle_status IN ('sealed','retired')
        AND ${normalized("m.external_inventory_item_id")}=${normalized("$5::text")}
        AND ($6::integer IS NULL OR m.product_variant_id=$6::integer)
      GROUP BY m.publication_target_id,m.product_variant_id)
    SELECT matched.publication_target_id,matched.product_variant_id,matched.matched_mapping_ids,
      a.id AS active_mapping_id,a.external_inventory_item_id AS active_item
    FROM matched
    JOIN inventory.publication_variant_mapping_heads h
      ON h.publication_target_id=matched.publication_target_id AND h.product_variant_id=matched.product_variant_id
    JOIN inventory.publication_variant_mapping_versions a ON a.id=h.active_mapping_id AND a.lifecycle_status='sealed'
    WHERE a.external_inventory_item_id<>$5::text
    ORDER BY matched.publication_target_id,matched.product_variant_id LIMIT 2 FOR SHARE OF h,a`,
  [...scopeTargetParams(scope), scope.externalInventoryItemId, scope.productVariantId, scope.providerKey === "shopify"])).rows;
  if (candidates.length !== 1) return false;
  const candidate = candidates[0];
  const evidence = { basis: "identity_retired", publicationTargetId: candidate.publication_target_id,
    productVariantId: candidate.product_variant_id, activeMappingId: candidate.active_mapping_id,
    activeExternalInventoryItemId: candidate.active_item, matchedMappingIds: candidate.matched_mapping_ids,
    externalInventoryItemId: scope.externalInventoryItemId };
  const changed = (await client.query<{ after_state: string }>(`UPDATE inventory.quantity_publication_catchup catchup
    SET completed_revision=$2,last_error_code=NULL,last_error_message=NULL,updated_at=$6::timestamptz,
      failure_class=NULL,parked_at=NULL,parked_code=NULL
    WHERE id=$1 AND revision=$2 AND attempt_boundary_id=$3 AND scope_key=$4 AND scope=$5::jsonb AND completed_revision<revision
    RETURNING to_jsonb(catchup)::text AS after_state`,
  [claim.catchupId, claim.revision, claim.attemptBoundaryId, scopeKey, JSON.stringify(scope), occurredAt])).rows[0];
  if (!changed) return false;
  // before/after stay PostgreSQL JSON text so bigint revisions never round through JS numbers (as archive settlement).
  await client.query(`INSERT INTO inventory.quantity_publication_catchup_settlements
    (catchup_id,revision,attempt_boundary_id,scope_key,scope,basis,actor,selection_fingerprint,
     evidence,before_state,after_state,occurred_at)
    VALUES($1,$2,$3,$4,$5::jsonb,'identity_retired',$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
  [claim.catchupId, claim.revision, claim.attemptBoundaryId, scopeKey, JSON.stringify(scope), SETTLEMENT_ACTOR,
    sha256(evidence), JSON.stringify(evidence), current.before_state, changed.after_state, occurredAt]);
  return true;
}

/**
 * The wake (PLAN-CH-v3 3.4 step 11), run by the definition sealer in the same transaction as every newly sealed
 * variant mapping, whichever writer linked it (stock-link engine, Walmart, eBay readiness, a person's activation).
 * Pending catch-up rows of the mapping's destination whose item (in normalized form) is the new item or any retired
 * item of the same size become due now. The caller holds the cutover fence (the authority row FOR UPDATE), so a
 * concurrent park either committed before (and is woken here) or re-checks after this commit.
 *
 * SKIP LOCKED: a row locked right now belongs to a producer (which makes it due anyway), a completion, or a failure
 * write, and must not make a link wait. Rows already due are left alone. Only the 237 columns are touched.
 * Returns the woken catch-up ids.
 */
export async function wakeQuantityCatchupsForMappingsInsideTransaction(client: Client, mappingIds: readonly number[],
  now: Date): Promise<string[]> {
  if (mappingIds.length === 0) return [];
  if (mappingIds.some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error("A catch-up wake needs positive mapping ids.");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("A catch-up wake needs a valid clock time.");
  const shopify = "c.scope->>'providerKey'='shopify'";
  return (await client.query<{ id: string }>(`WITH items AS (
      SELECT t.destination_kind,COALESCE(t.channel_connection_id,t.dropship_store_connection_id)::text AS connection_id,
        t.provider_scope_type,t.external_scope_id,v.external_inventory_item_id AS item
      FROM inventory.publication_variant_mapping_versions linked
      JOIN inventory.inventory_publication_targets t ON t.id=linked.publication_target_id
      JOIN inventory.publication_variant_mapping_versions v ON v.publication_target_id=linked.publication_target_id
        AND v.product_variant_id=linked.product_variant_id AND (v.id=linked.id OR v.lifecycle_status='retired')
      WHERE linked.id=ANY($1::integer[])
    ), due AS (
      SELECT c.id FROM inventory.quantity_publication_catchup c
      WHERE c.completed_revision<c.revision AND c.next_attempt_at>$2::timestamptz
        AND EXISTS (SELECT 1 FROM items i WHERE c.scope->>'destinationKind'=i.destination_kind
          AND c.scope->>'connectionId'=i.connection_id AND c.scope->>'providerScopeType'=i.provider_scope_type
          AND c.scope->>'externalScopeId'=i.external_scope_id
          AND ${normalizedProviderItemSql("(c.scope->>'externalInventoryItemId')", shopify)}=${normalizedProviderItemSql("i.item", shopify)})
      ORDER BY c.id FOR UPDATE OF c SKIP LOCKED
    )
    UPDATE inventory.quantity_publication_catchup catchup SET next_attempt_at=$2::timestamptz,updated_at=$2::timestamptz
    WHERE catchup.id IN (SELECT id FROM due) RETURNING catchup.id::text`,
  [[...mappingIds], now.toISOString()])).rows.map(row => row.id);
}
