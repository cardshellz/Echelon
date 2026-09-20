import type { Pool, PoolClient } from "pg";
import { pool } from "../../../db";
import { channelDefinitionReviewSchema, channelDefinitionReceiptSchema, channelDefinitionProgressSchema,
  type ApplyChannelDefinition, type ChannelDefinitionReview,
} from "@shared/types/inventory-channel-definition";
import { ChannelDefinitionError, type ChannelDefinitionStore } from "../application/inventory-channel-definition.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { loadActivePublicationTargets, loadChannelDefinitionReviewTargets, loadManagedSellableVariantIds } from "./inventory-channel-exposure-runtime.repository";
import { previewProductDefinitionPublicationInsideTransaction } from "./inventory-availability-runtime-publication.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import { enqueueReviewedDefinitionPublication } from "./inventory-product-definition.repository";
import { planInventoryChannelExposureProduct } from "../application/inventory-channel-exposure-runtime.service";
import { InventoryAvailabilityRuntimePublicationError } from "../application/inventory-availability-runtime-publication.service";

/** One atomic channel-level change. This is not first activation, target resume,
 * inventory posting or provider delivery. All writes use existing definition and
 * outbox owners under the established authority/admission exclusion fence. */
export class PostgresChannelDefinitionStore implements ChannelDefinitionStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}
  review(channelId: number) { return this.transaction(false, client => captureReview(client, channelId)); }
  apply(command: ApplyChannelDefinition, actor: string, requestHash: string, now: Date) {
    return this.transaction(true, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`channel_definition:${command.idempotencyKey}`]);
      const replay = (await client.query<{ request_hash: string; receipt: unknown }>(
        "SELECT request_hash,receipt FROM inventory.channel_definition_applications WHERE idempotency_key=$1", [command.idempotencyKey],
      )).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash) throw new ChannelDefinitionError("CHANNEL_DEFINITION_COMMAND_CONFLICT", "This retry key belongs to another command or user.");
        return { ...channelDefinitionReceiptSchema.parse(replay.receipt), alreadyApplied: true };
      }
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
      const review = await captureReview(client, command.channelId);
      if (review.reviewHash !== command.expectedReviewHash) throw new ChannelDefinitionError("CHANNEL_DEFINITION_REVIEW_STALE", "Inventory or saved settings changed. Review again before applying.");
      if (!review.ready) throw new ChannelDefinitionError("CHANNEL_DEFINITION_REVIEW_BLOCKED", "Resolve every review blocker before applying.");
      const changedDefinitions = await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
        contractVersion: "inventory_cutover_selection_manifest_v1", productIds: review.affectedProductIds,
        publicationTargetIds: review.destinations.map(target => target.id), selections: review.changes.map(change => change.selection),
      }, { actor, occurredAt: now, reason: "Applied reviewed channel inventory settings." });
      const publicationIds = await enqueueReviewedDefinitionPublication(client, {
        affectedProductIds: review.affectedProductIds, activationRunId: review.activationRunId,
        channels: review.quantities.map(row => ({ productId: row.productId, targetId: row.targetId,
          channelName: row.channelName, variantId: row.variantId, sku: row.sku, current: row.current, proposed: row.proposed })),
      });
      const receipt = channelDefinitionReceiptSchema.parse({ channelId: command.channelId, appliedAt: now.toISOString(),
        appliedBy: actor, reviewHash: review.reviewHash, publicationIds, changedDefinitions, alreadyApplied: false });
      await client.query(`INSERT INTO inventory.channel_definition_applications
        (channel_id,idempotency_key,request_hash,actor,occurred_at,review,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [command.channelId,command.idempotencyKey,requestHash,actor,now.toISOString(),JSON.stringify(review),JSON.stringify(receipt)]);
      return receipt;
    });
  }
  progress(channelId: number) {
    return this.transaction(false, async client => {
      const latest = (await client.query<{ receipt: unknown }>(
        "SELECT receipt FROM inventory.channel_definition_applications WHERE channel_id=$1 ORDER BY id DESC LIMIT 1", [channelId],
      )).rows[0];
      if (!latest) return null;
      const receipt = channelDefinitionReceiptSchema.parse(latest.receipt);
      const publications = (await client.query(`SELECT id::text, publication_target_id AS "targetId",product_variant_id AS "variantId",
        state, desired_quantity::text AS "desiredQuantity",last_error_class AS "errorCode"
        FROM inventory.inventory_publication_outbox WHERE id=ANY($1::bigint[]) ORDER BY id`, [receipt.publicationIds])).rows;
      if (publications.length !== receipt.publicationIds.length) throw new ChannelDefinitionError("CHANNEL_DEFINITION_OUTBOX_MISSING", "Delivery records are incomplete.", 500);
      return channelDefinitionProgressSchema.parse({ receipt, publications });
    });
  }
  private async transaction<T>(applying: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connectionPool.connect();
    let discard = false;
    try {
      await client.query(applying ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='60s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollback) { discard = true; throw new AggregateError([error, rollback], "Channel definition rollback failed"); }
      throw error;
    } finally { client.release(discard); }
  }
}

async function captureReview(client: PoolClient, channelId: number): Promise<ChannelDefinitionReview> {
  const authority = (await client.query<{ authority: string; revision: string; activation_run_id: string | null }>(
    "SELECT authority,revision::text,activation_run_id::text FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE",
  )).rows[0];
  if (!authority || authority.authority !== "canonical" || !authority.activation_run_id) {
    throw new ChannelDefinitionError("CHANNEL_DEFINITION_CANONICAL_REQUIRED", "Routine Apply is available after inventory cutover. Saving drafts does not activate migration.");
  }
  const channel = (await client.query<{ name: string }>("SELECT name FROM channels.channels WHERE id=$1", [channelId])).rows[0];
  if (!channel) throw new ChannelDefinitionError("CHANNEL_DEFINITION_NOT_FOUND", "Channel not found.", 404);
  const changes = await loadChanges(client, channelId);
  if (!changes.length) throw new ChannelDefinitionError("CHANNEL_DEFINITION_NO_DRAFTS", "There are no saved changes for this channel.");
  if (changes.length > 10000) throw new ChannelDefinitionError("CHANNEL_DEFINITION_SCOPE_TOO_LARGE", "Too many pending definitions for one review. Nothing was applied.", 422);
  const destinations = (await client.query<{ id: number; state: "disabled" | "preview" | "live"; authority: "echelon" | "external_provider" | "manual"; scope: string }>(
    `SELECT id,state,publication_authority AS authority,external_scope_id AS scope
      FROM inventory.inventory_publication_targets WHERE channel_id=$1 ORDER BY id`, [channelId],
  )).rows;
  // Channel defaults can affect every mapped product, not only the example SKU.
  // Draft-only mappings and item policies are included; retired/digital products
  // are excluded by the same sellability contract as the runtime publisher.
  const affectedProductIds = (await client.query<{ product_id: number }>(
    `SELECT DISTINCT v.product_id FROM catalog.product_variants v
     WHERE v.is_active=true AND v.requires_shipping=true AND COALESCE(v.track_inventory,true)=true
       AND v.sales_eligibility='sellable' AND (
        EXISTS (SELECT 1 FROM inventory.publication_variant_mapping_heads h
          JOIN inventory.inventory_publication_targets t ON t.id=h.publication_target_id
          WHERE h.product_variant_id=v.id AND t.channel_id=$1)
        OR EXISTS (SELECT 1 FROM inventory.channel_exposure_policy_heads h
          JOIN inventory.channel_exposure_policy_versions p ON p.id=COALESCE(h.draft_policy_id,h.active_policy_id)
          WHERE h.channel_id=$1 AND p.product_id=v.product_id))
     ORDER BY v.product_id LIMIT 1001`, [channelId],
  )).rows.map(row => row.product_id);
  if (affectedProductIds.length > 1000) throw new ChannelDefinitionError("CHANNEL_DEFINITION_SCOPE_TOO_LARGE", "The complete affected scope exceeds 1,000 products. No partial apply is allowed.", 422);
  const blockers: string[] = [];
  for (const change of changes) {
    // A stopped/unmanaged destination has no live quantity rows to validate.
    // Still show the channel-default sealing constraint before the operator
    // presses Apply, rather than returning an opaque database error afterward.
    if (change.selection.kind === "channel_policy" && change.after.scope_type === "channel"
      && ["allocation_semantics", "eligible", "share_bps", "holdback_sellable_units", "max_publish_mode", "min_publish_sellable_units"]
        .some(field => change.after[field] == null)) {
      blockers.push("Channel default: set every selling-rule field before applying.");
    }
    if (change.selection.kind === "variant_mapping" && change.before
      && (change.before.external_inventory_item_id !== change.after.external_inventory_item_id
        || change.before.external_sku !== change.after.external_sku)) {
      // Sending only to a new identity could leave positive stock on the old
      // listing. That needs an explicit identity-retirement workflow, not Save.
      blockers.push(`${change.label}: changing an established marketplace item requires retiring its previous identity first. Routine Apply cannot redirect it.`);
    }
  }
  const quantities: ChannelDefinitionReview["quantities"] = [];
  const evidence: unknown[] = [];
  for (const productId of affectedProductIds) {
    const snapshot = await captureActiveSupplySnapshotInsideTransaction(client, productId);
    const variants = await loadManagedSellableVariantIds(client, productId);
    const currentTargets = await loadActivePublicationTargets(client, productId, variants);
    const proposedTargets = await loadChannelDefinitionReviewTargets(client, productId, variants, channelId);
    const context = { authority: "canonical" as const, authorityRevision: authority.revision, activationRunId: authority.activation_run_id,
      supplySnapshot: snapshot, managedSellableVariantIds: variants };
    const before = planInventoryChannelExposureProduct({ ...context, publicationTargets: currentTargets }, productId);
    const after = planInventoryChannelExposureProduct({ ...context, publicationTargets: proposedTargets }, productId);
    evidence.push({ fingerprint: snapshot.snapshotFingerprint, currentTargets, proposedTargets, before: before.targets, after: after.targets });
    for (const target of after.targets) {
      blockers.push(...target.blockers.map(issue => `${target.channelName}: ${issue.message}`));
      for (const row of target.rows) {
        blockers.push(...row.blockers.map(issue => `${target.channelName} / ${row.sku ?? row.productVariantId}: ${issue.message}`));
        quantities.push({ productId, variantId: row.productVariantId, sku: row.sku, targetId: target.publicationTargetId,
          channelName: target.channelName, current: before.targets.find(item => item.publicationTargetId === target.publicationTargetId)
            ?.rows.find(item => item.productVariantId === row.productVariantId)?.publishedUnits ?? null,
          proposed: row.publishedUnits, warehouses: row.sourceWarehouseBreakdown.map(source => ({
            warehouseId: source.warehouseId, available: source.canonicalAtpUnits })),
        });
      }
    }
    if (after.targets.every(target => target.publishable)) {
      try { await previewProductDefinitionPublicationInsideTransaction(client, productId, snapshot, proposedTargets); }
      catch (error) {
        if (!(error instanceof InventoryAvailabilityRuntimePublicationError)) throw error;
        blockers.push(`${channel.name} / product ${productId}: ${error.code} — ${error.message}`);
      }
    }
  }
  const content = { channelId, channelName: channel.name, authorityRevision: authority.revision,
    activationRunId: authority.activation_run_id, changes, destinations, affectedProductIds,
    quantities, blockers: [...new Set(blockers)], ready: blockers.length === 0 };
  return channelDefinitionReviewSchema.parse({ ...content, reviewHash: inventoryCutoverEvidenceHash({ content, evidence }) });
}

async function loadChanges(client: PoolClient, channelId: number): Promise<ChannelDefinitionReview["changes"]> {
  // Fixed SQL identifiers are not supplied by the request. Full before/after
  // definitions are retained in the immutable receipt, including source members.
  const policies = (await client.query(`SELECT h.scope_key AS key,h.revision::text,p.id,p.definition_hash,
    COALESCE(v.sku,product.name,'Channel default') AS label,
    CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a)||jsonb_build_object(
      'holdback_sellable_units',a.holdback_sellable_units::text,'max_publish_sellable_units',a.max_publish_sellable_units::text,
      'min_publish_sellable_units',a.min_publish_sellable_units::text) END AS before,
    to_jsonb(p)||jsonb_build_object('holdback_sellable_units',p.holdback_sellable_units::text,
      'max_publish_sellable_units',p.max_publish_sellable_units::text,'min_publish_sellable_units',p.min_publish_sellable_units::text) AS after
    FROM inventory.channel_exposure_policy_heads h
    JOIN inventory.channel_exposure_policy_versions p ON p.id=h.draft_policy_id AND p.lifecycle_status='draft'
    LEFT JOIN inventory.channel_exposure_policy_versions a ON a.id=h.active_policy_id
    LEFT JOIN catalog.products product ON product.id=p.product_id
    LEFT JOIN catalog.product_variants v ON v.id=p.product_variant_id
    WHERE h.channel_id=$1 ORDER BY h.scope_key`, [channelId])).rows;
  const bindings = (await client.query(`SELECT h.publication_target_id::text AS key,h.revision::text,b.id,b.definition_hash,
    'Supply: '||t.external_scope_id AS label,
    CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a)||jsonb_build_object('nodes',
      (SELECT jsonb_agg(fulfillment_node_id ORDER BY priority) FROM inventory.publication_source_binding_members WHERE binding_id=a.id)) END AS before,
    to_jsonb(b)||jsonb_build_object('nodes',
      (SELECT jsonb_agg(fulfillment_node_id ORDER BY priority) FROM inventory.publication_source_binding_members WHERE binding_id=b.id)) AS after
    FROM inventory.publication_source_binding_heads h JOIN inventory.inventory_publication_targets t ON t.id=h.publication_target_id
    JOIN inventory.publication_source_binding_versions b ON b.id=h.draft_binding_id AND b.lifecycle_status='draft'
    LEFT JOIN inventory.publication_source_binding_versions a ON a.id=h.active_binding_id
    WHERE t.channel_id=$1 ORDER BY h.publication_target_id`, [channelId])).rows;
  const mappings = (await client.query(`SELECT h.publication_target_id::text||':'||h.product_variant_id::text AS key,h.revision::text,m.id,m.definition_hash,
    COALESCE(v.sku,v.name)||' on '||t.external_scope_id AS label,to_jsonb(a) AS before,to_jsonb(m) AS after
    FROM inventory.publication_variant_mapping_heads h JOIN inventory.inventory_publication_targets t ON t.id=h.publication_target_id
    JOIN inventory.publication_variant_mapping_versions m ON m.id=h.draft_mapping_id AND m.lifecycle_status='draft'
    LEFT JOIN inventory.publication_variant_mapping_versions a ON a.id=h.active_mapping_id
    JOIN catalog.product_variants v ON v.id=h.product_variant_id
    WHERE t.channel_id=$1 ORDER BY h.publication_target_id,h.product_variant_id`, [channelId])).rows;
  return ([{ kind: "channel_policy", rows: policies }, { kind: "source_binding", rows: bindings },
    { kind: "variant_mapping", rows: mappings }] as const).flatMap(({ kind, rows }) => rows.map(row => ({
      selection: { kind, key: row.key as string, definitionId: row.id as number, definitionHash: row.definition_hash as string },
      headRevision: row.revision as string, label: row.label as string,
      before: row.before as Record<string, unknown> | null, after: row.after as Record<string, unknown>,
    })));
}
