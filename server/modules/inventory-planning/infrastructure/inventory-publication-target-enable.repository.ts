import type { Pool, PoolClient } from "pg";
import { inventoryPublicationTargetEnableResultSchema, type InventoryPublicationTargetEnableResult } from "@shared/types/inventory-publication-target-enable";
import type { InventoryCutoverDefinitionSelection } from "@shared/types/inventory-cutover-commit";
import { pool } from "../../../db";
import type { InventoryPublicationTargetEnableCommand, InventoryPublicationTargetEnableStore } from "../application/inventory-publication-target-enable.service";
import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { InventoryAvailabilityRuntimePublicationError } from "../application/inventory-availability-runtime-publication.service";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";

import { loadPublicationTargetScopes, PUBLICATION_TARGET_SCOPE_LOCK_SEED, type PublicationTargetScopeSource } from "./inventory-publication-target-stop.repository";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";

// Dedicated command namespace; do not reuse definition-head advisory locks.
const IDEMPOTENCY_LOCK_NAMESPACE = 918450;
const MAX_ENABLE_PRODUCTS = 1000;
const INITIAL_SETUP_ACTION = "Applied initial saved setup when enabling stock updates.";
type Target = PublicationTargetScopeSource & { id: number; channel_id: number; state: string; revision: string; publication_authority: string;
  membership_mode: "explicit" | "whole_product"; channel_status: string };
type Definition = { id: number; definition_hash: string; lifecycle_status: string };

/** Enables permission and queues fresh quantities atomically. Historical pause/readback
 * records are not prerequisites: the current canonical planner validates publication.
 * No provider request is made here. The worker still enforces global pause and holds. */
export class PostgresInventoryPublicationTargetEnableStore implements InventoryPublicationTargetEnableStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}

  async enable(command: InventoryPublicationTargetEnableCommand): Promise<InventoryPublicationTargetEnableResult> {
    const client = await this.connectionPool.connect();
    let discard: Error | undefined;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [IDEMPOTENCY_LOCK_NAMESPACE, command.idempotencyKey]);
      const receiptKey = `inventory-publication-enable:${command.idempotencyKey}`;
      const receipt = (await client.query<{ request_hash: string; response_body: unknown }>(
        "SELECT request_hash,response_body FROM public.idempotency_keys WHERE key=$1", [receiptKey])).rows[0];
      if (receipt) {
        if (receipt.request_hash !== command.requestHash) throw failure("IDEMPOTENCY_CONFLICT", "This request key was already used for a different stock-update change.");
        const result = inventoryPublicationTargetEnableResultSchema.parse(receipt.response_body);
        await client.query("COMMIT");
        return { ...result, alreadyApplied: true };
      }
      // Take the admission fence before target/configuration locks. Exact scope
      // locks below separately exclude provider HTTP requests already in flight.
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
      const activeAuthority = (await client.query(
        `SELECT 1 FROM inventory.availability_runtime_authority authority
         JOIN inventory.availability_activation_runs run ON run.id=authority.activation_run_id
         WHERE authority.singleton_key=true AND authority.authority='canonical' AND run.mode='activation' AND run.state='active'`)).rowCount;
      if (activeAuthority !== 1) throw failure("SETUP_REQUIRED", "Complete Channel Inventory setup before starting automatic stock updates.");
      const target = (await client.query<Target>(
        `SELECT t.id,t.channel_id,t.state,t.revision::text,t.publication_authority,t.membership_mode,c.status AS channel_status,
           t.destination_kind,t.channel_connection_id,t.dropship_store_connection_id,t.provider_scope_type,t.external_scope_id,
           lower(CASE t.destination_kind WHEN 'channel_connection' THEN c.provider ELSE d.platform END) AS provider_key
         FROM inventory.inventory_publication_targets t JOIN channels.channels c ON c.id=t.channel_id
         LEFT JOIN dropship.dropship_store_connections d ON d.id=t.dropship_store_connection_id
         WHERE t.id=$1 FOR UPDATE OF t`, [command.publicationTargetId])).rows[0];
      if (!target) throw new InventoryAvailabilityMasterDataError(404, "INVENTORY_PUBLICATION_TARGET_NOT_FOUND", "This stock-update account no longer exists.");
      if (target.revision !== command.expectedRevision) throw failure("STALE", "This account changed. Reload its status and try again.");
      if (target.publication_authority !== "echelon") throw failure("EXTERNALLY_MANAGED", "Stock for this account is managed outside Echelon.");
      if (target.channel_status !== "active") throw failure("CHANNEL_INACTIVE", "Activate the channel connection before starting its stock updates.");
      if (target.state === "live") throw failure("ALREADY_ENABLED", "Stock updates are already on. Reload the account status.");

      if (target.provider_key === "walmart" && !(await client.query(
        "SELECT 1 FROM channels.walmart_connections w JOIN channels.channel_connections c ON c.id=w.connection_id AND c.channel_id=w.channel_id WHERE w.channel_id=$1 AND w.connection_id=$2 AND w.ship_node_id=$3 FOR SHARE OF w,c",
        [target.channel_id, target.channel_connection_id, target.external_scope_id])).rowCount) {
        throw failure("CONNECTION_CHANGED", "This Walmart account or fulfillment center no longer matches the connection. Update its destination setup before turning on stock updates.");
      }
      const scopes = await loadPublicationTargetScopes(client, target);
      for (const key of scopes.map(quantityPublicationScopeLockKey).sort()) {
        const locked = (await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1,$2)) AS acquired", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED])).rows[0]?.acquired;
        if (!locked) throw failure("BUSY", "A stock update for this account is still in progress. Retry in a moment.");
      }
      const selections = await initialSetup(client, target);
      const initialDefinitionsApplied = await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
        contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [], publicationTargetIds: [target.id], selections,
      }, { actor: command.actorId, reason: INITIAL_SETUP_ACTION, occurredAt: command.occurredAt });
      const products = await publicationProducts(client, target);
      const updated = await client.query<{ revision: string }>(
        `UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1,activated_by=$3,activated_at=$4
         WHERE id=$1 AND revision=$2::bigint AND state IN ('disabled','preview') RETURNING revision::text`,
        [target.id, command.expectedRevision, command.actorId, command.occurredAt]);
      if (updated.rowCount !== 1) throw failure("STALE", "This account changed. Reload its status and try again.");
      const publisher = createTransactionScopedInventoryPublicationService(client);
      let publicationRows = 0;
      for (const productId of products) {
        const published = await publisher.publishProduct({ productId, publicationTargetId: target.id, dryRun: false,
          triggeredBy: "stock_updates_enabled" }, async () => { throw failure("SETUP_REQUIRED", "Channel Inventory setup is required."); });
        if (published.authority !== "canonical" || published.publication.rows.length === 0
          || published.publication.rows.some(row => row.publicationTargetId !== target.id || row.blockerCodes.length > 0)
          || published.publication.enqueuedRows + published.publication.coalescedRows !== published.publication.rows.length) {
          throw failure("PUBLICATION_INCOMPLETE", "Stock could not be prepared for every included item. Check the stock preview before trying again.");
        }
        publicationRows += published.publication.rows.length;
      }
      const result = inventoryPublicationTargetEnableResultSchema.parse({ publicationTargetId: target.id,
        revision: updated.rows[0].revision, state: "live", publicationRows, initialDefinitionsApplied,
        alreadyApplied: false, runtimeAuthorityChanged: false, providerWriteAttempted: false });
      await client.query(
        `INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
         VALUES($1,'AUDIT',$2,'inventory_availability.publication_target.enabled',$3,$4::jsonb,$5::jsonb)`,
        [command.occurredAt, command.actorId, `inventory.inventory_publication_target:${target.id}`,
          JSON.stringify({ before: { state: target.state, revision: target.revision }, after: { state: "live", revision: result.revision } }),
          JSON.stringify({ idempotencyKey: command.idempotencyKey, requestHash: command.requestHash,
            initialDefinitions: selections, publicationRows, productIds: products })]);
      await client.query(
        "INSERT INTO public.idempotency_keys(key,request_hash,response_body,created_at,expires_at) VALUES($1,$2,$3::jsonb,$4,NULL)",
        [receiptKey, command.requestHash, JSON.stringify(result), command.occurredAt]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) {
        discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      if (error instanceof InventoryAvailabilityRuntimePublicationError) {
        throw failure("STOCK_NOT_READY", "Stock updates are still off. Check the account's stock preview for missing listing links or stock settings.", [error.code, error.message]);
      }
      if (error instanceof Error && "code" in error && error.code === "55000"
        && error.message === "CUTOVER_AUTHORITY_CHANGED") {
        throw failure("SETUP_REQUIRED", "Complete Channel Inventory setup before starting automatic stock updates.");
      }
      if (error instanceof Error && "code" in error && error.code === "55000"
        && error.message === "CUTOVER_CONFIGURATION_FREEZE_CHANGED") {
        throw failure("BUSY", "Inventory setup is being updated. Try turning on stock updates after that finishes.");
      }
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
        throw failure("BUSY", "An inventory update is in progress. Retry turning stock updates on in a moment.");
      }
      throw error;
    } finally { client.release(discard); }
  }
}

/** Only bootstrap missing active definitions. Existing active settings and all
 * pending replacements/mappings remain untouched when restarting an account. */
async function initialSetup(client: PoolClient, target: Target): Promise<InventoryCutoverDefinitionSelection[]> {
  const selections: InventoryCutoverDefinitionSelection[] = [];
  const binding = (await client.query<Definition & { active_binding_id: number | null }>(
    `SELECT b.id,b.definition_hash,b.lifecycle_status,h.active_binding_id FROM inventory.publication_source_binding_heads h
     JOIN inventory.publication_source_binding_versions b ON b.id=COALESCE(h.active_binding_id,h.draft_binding_id)
     WHERE h.publication_target_id=$1 FOR UPDATE OF h,b`, [target.id])).rows[0];
  if (!binding) throw failure("WAREHOUSES_REQUIRED", "Choose and save the warehouses for this account before turning stock updates on.");
  const sources = (await client.query<{ lifecycle_status: string }>(
    `SELECT n.lifecycle_status FROM inventory.publication_source_binding_members m
     JOIN warehouse.fulfillment_nodes n ON n.id=m.fulfillment_node_id WHERE m.binding_id=$1`, [binding.id])).rows;
  if (!sources.length || sources.some(source => source.lifecycle_status !== "active")) {
    throw failure("WAREHOUSES_REQUIRED", "Choose an active warehouse in Warehouses and save it before turning stock updates on.");
  }
  const policy = (await client.query<Definition & { active_policy_id: number | null; scope_key: string; complete: boolean }>(
    `SELECT p.id,p.definition_hash,p.lifecycle_status,h.active_policy_id,h.scope_key,
       (p.allocation_semantics IS NOT NULL AND p.eligible IS NOT NULL AND p.share_bps IS NOT NULL
        AND p.holdback_sellable_units IS NOT NULL AND p.max_publish_mode IS NOT NULL AND p.min_publish_sellable_units IS NOT NULL
        AND (p.max_publish_mode<>'units' OR p.max_publish_sellable_units IS NOT NULL)) AS complete
     FROM inventory.channel_exposure_policy_heads h JOIN inventory.channel_exposure_policy_versions p
       ON p.id=COALESCE(h.active_policy_id,h.draft_policy_id)
     WHERE h.channel_id=$1 AND p.scope_type='channel' FOR UPDATE OF h,p`, [target.channel_id])).rows[0];
  if (!policy?.complete) throw failure("STOCK_RULES_REQUIRED", "Save a complete channel default in Stock rules before turning stock updates on.");
  for (const [definition, activeId, kind, key] of [
    [binding, binding.active_binding_id, "source_binding", String(target.id)],
    [policy, policy.active_policy_id, "channel_policy", policy.scope_key],
  ] as const) {
    if (definition.lifecycle_status !== (activeId == null ? "draft" : "sealed")) {
      throw failure("SETUP_CHANGED", "The saved stock setup changed. Reload and check the account settings.");
    }
    if (activeId == null) selections.push({ kind, key, definitionId: definition.id, definitionHash: definition.definition_hash });
  }
  // A first channel default is shared. Never change another already-live account
  // implicitly; that exceptional recovery belongs to the channel review workflow.
  if (policy.active_policy_id == null && (await client.query(
    "SELECT 1 FROM inventory.inventory_publication_targets WHERE channel_id=$1 AND id<>$2 AND state='live' AND publication_authority='echelon' LIMIT 1",
    [target.channel_id, target.id])).rowCount) {
    throw failure("STOCK_RULES_REQUIRED", "Apply the saved channel default in Stock rules before turning on this account; another account is already using this channel.");
  }
  return selections;
}

async function publicationProducts(client: PoolClient, target: Target): Promise<number[]> {
  // Pausing does not retire identities. Refuse to silently abandon a previously
  // published identity; explicit exclusion already requires a verified zero.
  const orphan = (await client.query(
    `WITH history AS (
       SELECT publication_target_id,product_variant_id,external_inventory_item_id_snapshot FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1
       UNION SELECT publication_target_id,product_variant_id,external_inventory_item_id_snapshot FROM inventory.inventory_publication_readbacks WHERE publication_target_id=$1 AND external_inventory_item_id_snapshot IS NOT NULL
     ) SELECT 1 FROM history o
     LEFT JOIN inventory.publication_variant_mapping_heads h ON h.publication_target_id=o.publication_target_id AND h.product_variant_id=o.product_variant_id
     LEFT JOIN inventory.publication_variant_mapping_versions m ON m.id=h.active_mapping_id AND m.lifecycle_status='sealed'
     WHERE o.publication_target_id=$1 AND (m.id IS NULL OR m.external_inventory_item_id<>o.external_inventory_item_id_snapshot)
       AND NOT ($2='explicit' AND EXISTS (SELECT 1 FROM inventory.publication_membership_heads mh
         JOIN inventory.publication_membership_versions mv ON mv.id=mh.active_version_id
         WHERE mh.publication_target_id=$1 AND mh.product_variant_id=o.product_variant_id AND mv.included=false)) LIMIT 1`,
    [target.id, target.membership_mode])).rowCount;
  if (orphan) throw failure("LISTING_LINK_CHANGED", "A previously updated listing no longer matches its saved item link. Fix its listing link before restarting stock updates.");
  // Include invalid/inactive identities in the census. The canonical planner must
  // reject them, rather than making them disappear from an apparently successful enable.
  const rows = (await client.query<{ product_id: number; product_variant_id: number; managed: boolean }>(
    `SELECT v.product_id,v.id AS product_variant_id,
       (v.is_active AND v.requires_shipping AND COALESCE(v.track_inventory,true) AND v.sales_eligibility='sellable') AS managed
     FROM catalog.product_variants v WHERE
       ($2='explicit' AND EXISTS(SELECT 1 FROM inventory.publication_membership_heads h
         JOIN inventory.publication_membership_versions m ON m.id=h.active_version_id
         WHERE h.publication_target_id=$1 AND h.product_variant_id=v.id AND m.included=true))
       OR ($2='whole_product' AND EXISTS(SELECT 1 FROM inventory.publication_variant_mapping_heads h
         WHERE h.publication_target_id=$1 AND h.product_variant_id=v.id AND h.active_mapping_id IS NOT NULL))
     ORDER BY v.product_id,v.id`, [target.id, target.membership_mode])).rows;
  if (rows.some(row => !row.managed)) throw failure("ITEM_NOT_SELLABLE", "An included item is inactive or no longer tracks stock. Check its catalog and stock selection before enabling updates.");
  const products = [...new Set(rows.map(row => row.product_id))];
  if (products.length > MAX_ENABLE_PRODUCTS) throw failure("SCOPE_TOO_LARGE", "This account has too many products for one stock-update change. Contact support to activate it in a planned batch.");
  return products;
}

function failure(code: string, message: string, details: string[] = []): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(409, `INVENTORY_PUBLICATION_ENABLE_${code}`, message, details);
}
