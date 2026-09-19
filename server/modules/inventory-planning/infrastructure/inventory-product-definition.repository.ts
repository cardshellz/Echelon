import type { Pool, PoolClient } from "pg";
import type { SupplySnapshotDto } from "@shared/types/inventory-availability-planner";
import { pool } from "../../../db";
import { isCustomerSellableVariant } from "@shared/catalog/variant-sales-eligibility";
import { productDefinitionProgressSchema, productDefinitionReceiptSchema, productDefinitionReviewSchema,
  type ApplyProductDefinition, type ProductDefinitionSelection, type ProductDefinitionReview,
} from "@shared/types/inventory-product-definition";
import { ProductDefinitionError, type ProductDefinitionStore } from "../application/inventory-product-definition.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { projectCanonicalAtp } from "../domain/inventory-availability-planner";
import { captureActiveSupplySnapshotInsideTransaction, captureProductDraftReviewSnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { createTransactionScopedInventoryPublicationService, previewProductDefinitionPublicationInsideTransaction } from "./inventory-availability-runtime-publication.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";

/** Reuses the DB admission fence, not the migration command. No authority switch,
 * claim reconstruction, physical movement, or provider call occurs here. */
export class PostgresProductDefinitionStore implements ProductDefinitionStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}
  review(selection: ProductDefinitionSelection) {
    return this.transaction(false, client => captureReview(client, selection));
  }
  apply(command: ApplyProductDefinition, actor: string, requestHash: string, now: Date) {
    return this.transaction(true, async client => {
      // Same-command retries serialize before the global authority/admission fence.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`product_definition:${command.idempotencyKey}`]);
      const replay = (await client.query<{ request_hash: string; receipt: unknown }>(
        "SELECT request_hash, receipt FROM inventory.product_definition_applications WHERE idempotency_key=$1", [command.idempotencyKey],
      )).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash) throw new ProductDefinitionError("DEFINITION_COMMAND_CONFLICT", "This retry key belongs to a different command or user.");
        return { ...productDefinitionReceiptSchema.parse(replay.receipt), alreadyApplied: true };
      }
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
      const selection: ProductDefinitionSelection = { productId: command.productId, draftModelId: command.draftModelId,
        expectedHeadRevision: command.expectedHeadRevision, expectedDefinitionHash: command.expectedDefinitionHash };
      const review = await captureReview(client, selection);
      if (review.reviewHash !== command.expectedReviewHash) throw new ProductDefinitionError("DEFINITION_REVIEW_STALE", "Inventory or configuration changed. Review the current draft again before applying.");
      if (!review.ready) throw new ProductDefinitionError("DEFINITION_REVIEW_BLOCKED", "Resolve the review blockers before applying.");
      await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
        contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [command.productId], publicationTargetIds: [],
        selections: [{ kind: "model", key: String(command.productId), definitionId: command.draftModelId, definitionHash: command.expectedDefinitionHash }],
      }, { actor, occurredAt: now, reason: "Applied reviewed product conversion and build rules." });
      const publicationIds = await enqueueReviewedDefinitionPublication(client, review);
      const receipt = productDefinitionReceiptSchema.parse({ productId: command.productId, modelId: command.draftModelId,
        appliedAt: now.toISOString(), appliedBy: actor, reviewHash: review.reviewHash, publicationIds, alreadyApplied: false });
      await client.query(`INSERT INTO inventory.product_definition_applications
        (product_id, model_id, idempotency_key, request_hash, actor, occurred_at, review, receipt)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [command.productId, command.draftModelId, command.idempotencyKey, requestHash, actor, now.toISOString(), JSON.stringify(review), JSON.stringify(receipt)]);
      return receipt;
    });
  }
  progress(productId: number) {
    return this.transaction(false, async client => {
      const row = (await client.query<{ receipt: unknown }>(
        "SELECT receipt FROM inventory.product_definition_applications WHERE product_id=$1 ORDER BY id DESC LIMIT 1", [productId],
      )).rows[0];
      if (!row) return null;
      const receipt = productDefinitionReceiptSchema.parse(row.receipt);
      const publications = (await client.query(
        `SELECT id::text, publication_target_id AS "targetId", product_variant_id AS "variantId", state,
         desired_quantity::text AS "desiredQuantity", last_error_class AS "errorCode"
         FROM inventory.inventory_publication_outbox WHERE id=ANY($1::bigint[]) ORDER BY id`, [receipt.publicationIds],
      )).rows;
      if (publications.length !== receipt.publicationIds.length) throw new ProductDefinitionError("DEFINITION_OUTBOX_MISSING", "Publication status is incomplete.", 500);
      return productDefinitionProgressSchema.parse({ receipt, publications });
    });
  }
  private async transaction<T>(applying: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connectionPool.connect();
    let discard = false;
    try {
      await client.query(applying ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='60s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { discard = true; throw new AggregateError([error, rollbackError], "Definition command rollback failed"); }
      throw error;
    } finally { client.release(discard); }
  }
}

async function captureReview(client: PoolClient, selection: ProductDefinitionSelection): Promise<ProductDefinitionReview> {
  const authority = (await client.query<{ authority: string; revision: string; activation_run_id: string | null }>(
    "SELECT authority, revision::text, activation_run_id::text FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE",
  )).rows[0];
  if (!authority || authority.authority !== "canonical" || !authority.activation_run_id) {
    throw new ProductDefinitionError("DEFINITION_CANONICAL_REQUIRED", "Routine Apply is available after inventory migration. Saving drafts does not activate migration.");
  }
  const head = (await client.query<{ revision: string; draft_model_id: number; definition_hash: string; lifecycle_status: string; validation_state: string; active_model_id: number | null; active_definition_hash: string | null }>(
    `SELECT head.revision::text, head.draft_model_id, model.definition_hash, model.lifecycle_status, model.validation_state,
       head.active_model_id, active.definition_hash AS active_definition_hash
     FROM inventory.transformation_model_heads head JOIN inventory.transformation_model_versions model
     ON model.id=head.draft_model_id AND model.product_id=head.product_id
     LEFT JOIN inventory.transformation_model_versions active ON active.id=head.active_model_id AND active.product_id=head.product_id
     WHERE head.product_id=$1`, [selection.productId],
  )).rows[0];
  if (!head || head.revision !== selection.expectedHeadRevision || head.draft_model_id !== selection.draftModelId
    || head.definition_hash !== selection.expectedDefinitionHash || head.lifecycle_status !== "draft") {
    throw new ProductDefinitionError("DEFINITION_DRAFT_CHANGED", "The saved draft changed. Reload it before reviewing.");
  }
  // Reverse the sealed recipe dependency graph. A component's new conversion
  // rules affect every dependent output, not only this product's channel rows.
  const affectedProductIds = (await client.query<{ product_id: number }>(
    `WITH RECURSIVE affected(product_id) AS (
       SELECT $1::integer UNION SELECT heads.product_id FROM affected a
       JOIN inventory.transformation_recipe_component_snapshots components ON components.component_product_id=a.product_id
       JOIN inventory.transformation_model_heads heads ON heads.active_model_id=components.model_id
     ) SELECT product_id FROM affected ORDER BY product_id LIMIT 1001`, [selection.productId],
  )).rows.map(row => row.product_id);
  if (affectedProductIds.length > 1000) throw new ProductDefinitionError("DEFINITION_REVIEW_TOO_LARGE", "The affected build graph exceeds the review limit. No partial apply is allowed.", 422);
  const blockers: string[] = head.validation_state === "valid" ? [] : ["The saved model has validation errors."];
  const impact = await captureDefinitionImpact(client, affectedProductIds,
    productId => captureProductDraftReviewSnapshotInsideTransaction(client, productId, selection.productId));
  blockers.push(...impact.blockers);
  const content = { selection, ready: blockers.length === 0, authorityRevision: authority.revision,
    previousModel: head.active_model_id === null ? null : { id: head.active_model_id, definitionHash: head.active_definition_hash },
    activationRunId: authority.activation_run_id, affectedProductIds, blockers: [...new Set(blockers)], atp: impact.atp, channels: impact.channels };
  return productDefinitionReviewSchema.parse({ ...content, reviewHash: inventoryCutoverEvidenceHash({ content, fingerprints: impact.fingerprints }) });
}

/** Shared routine-definition impact evaluation. It never writes or recomputes
 * ATP outside the canonical planner; caller selects the single proposed draft. */
export async function captureDefinitionImpact(client: PoolClient, affectedProductIds: number[], proposedSnapshot: (productId: number) => Promise<SupplySnapshotDto>) {
  const blockers: string[] = [];
  const atp: ProductDefinitionReview["atp"] = [];
  const channels: ProductDefinitionReview["channels"] = [];
  const fingerprints: string[] = [];
  for (const productId of affectedProductIds) {
    const current = await captureActiveSupplySnapshotInsideTransaction(client, productId);
    const proposed = await proposedSnapshot(productId);
    fingerprints.push(current.snapshotFingerprint, proposed.snapshotFingerprint);
    for (const variant of proposed.variants.filter(v => v.productId === productId && v.isActive && isCustomerSellableVariant(v))) {
      for (const warehouse of proposed.warehouses.filter(w => w.isActive)) {
        const request = { targetVariantId: variant.id, scope: { kind: "warehouse" as const, warehouseId: warehouse.id } };
        const before = projectCanonicalAtp(current, request);
        const after = projectCanonicalAtp(proposed, request);
        blockers.push(...after.blockers.map(item => `${variant.sku ?? variant.id} / ${warehouse.code}: ${item.message}`));
        atp.push({ productId, variantId: variant.id, sku: variant.sku, warehouseId: warehouse.id,
          warehouseName: warehouse.code, current: before.atpUnits, proposed: after.atpUnits });
      }
    }
    const before = await previewProductDefinitionPublicationInsideTransaction(client, productId, current);
    const after = await previewProductDefinitionPublicationInsideTransaction(client, productId, proposed);
    // Includes destination identity, policies' effects and target revisions, not
    // merely totals. Changed publication scope must invalidate a previous review.
    fingerprints.push(inventoryCutoverEvidenceHash({ before: before.rows, after: after.rows }));
    for (const row of after.rows) {
      blockers.push(...row.blockerCodes.map(code => `${row.channelName} / ${row.sku ?? row.productVariantId}: ${code}`));
      channels.push({ productId, targetId: row.publicationTargetId, channelName: row.channelName,
        variantId: row.productVariantId, sku: row.sku,
        current: before.rows.find(item => item.publicationTargetId === row.publicationTargetId && item.productVariantId === row.productVariantId)?.desiredQuantity ?? null,
        proposed: row.desiredQuantity });
    }
  }
  return { blockers: [...new Set(blockers)], atp, channels, fingerprints };
}

export async function enqueueReviewedDefinitionPublication(client: PoolClient,
  review: Pick<ProductDefinitionReview, "affectedProductIds" | "channels" | "activationRunId">,
): Promise<string[]> {
  const publisher = createTransactionScopedInventoryPublicationService(client);
  const publicationIds: string[] = [];
  for (const productId of review.affectedProductIds) {
    const result = await publisher.publishProduct({ productId, dryRun: false, triggeredBy: "routine_definition_apply" },
      async () => { throw new ProductDefinitionError("DEFINITION_LEGACY_FORBIDDEN", "Canonical publication is required."); });
    if (result.authority !== "canonical") throw new ProductDefinitionError("DEFINITION_LEGACY_FORBIDDEN", "Canonical publication is required.");
    for (const row of result.publication.rows) {
      const expected = review.channels.find(item => item.productId === productId && item.targetId === row.publicationTargetId && item.variantId === row.productVariantId);
      if (!expected || expected.proposed !== row.desiredQuantity || row.blockerCodes.length) {
        throw new ProductDefinitionError("DEFINITION_PUBLICATION_CHANGED", "Publication differs from the reviewed quantities. Nothing was applied.");
      }
      const outbox = (await client.query<{ id: string }>(
        `SELECT id::text FROM inventory.inventory_publication_outbox
         WHERE publication_target_id=$1 AND product_variant_id=$2 AND publication_phase='full'
         AND desired_quantity=$3 AND activation_run_id=$4 ORDER BY desired_revision DESC LIMIT 1`,
        [row.publicationTargetId, row.productVariantId, row.desiredQuantity, review.activationRunId],
      )).rows[0];
      if (!outbox) throw new ProductDefinitionError("DEFINITION_OUTBOX_MISSING", "Publication receipt was not persisted.", 500);
      publicationIds.push(outbox.id);
    }
    if (result.publication.rows.length !== review.channels.filter(row => row.productId === productId).length) {
      throw new ProductDefinitionError("DEFINITION_PUBLICATION_CHANGED", "The publication target set changed. Nothing was applied.");
    }
  }
  return publicationIds;
}
