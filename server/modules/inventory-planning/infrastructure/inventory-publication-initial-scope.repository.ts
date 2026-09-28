import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { pool as defaultPool } from "../../../db";
import {
  prepareInitialPublicationScopeSchema, initialPublicationScopeReceiptSchema,
  type ReviewInitialPublicationScope, type PrepareInitialPublicationScope, type InitialPublicationScopeReceipt, type InitialPublicationScopeReview,
} from "@shared/types/inventory-publication-initial-scope";
import { InitialPublicationScopeError, initialScopeCommandHash, type InitialPublicationScopeStore } from "../application/inventory-publication-initial-scope.service";
import { reviewInitialPublicationScope } from "../domain/inventory-publication-initial-scope";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { calculatePublicationVariantMappingDefinitionHash } from "../domain/inventory-channel-exposure";
import { inInventoryCutoverTransaction } from "./inventory-cutover-commit.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { INITIAL_SCOPE_SOURCE_TABLES, readInitialPublicationScopeFacts } from "./inventory-publication-initial-scope.reader";

export class PostgresInitialPublicationScopeStore implements InitialPublicationScopeStore {
  constructor(private readonly pool: Pick<Pool, "connect"> = defaultPool) {}
  async review(input: ReviewInitialPublicationScope) {
    return inInventoryCutoverTransaction(this.pool, "read_only_review", async client =>
      reviewInitialPublicationScope(input, await readInitialPublicationScopeFacts(client, input.publicationTargetId)));
  }
  async prepare(raw: PrepareInitialPublicationScope, actor: string, requestHash: string, now: Date): Promise<InitialPublicationScopeReceipt> {
    const input = prepareInitialPublicationScopeSchema.parse(raw);
    z.string().trim().min(1).max(100).parse(actor);
    z.date().parse(now);
    if (requestHash !== initialScopeCommandHash(input, actor)) throw new InitialPublicationScopeError("INITIAL_SCOPE_COMMAND_INVALID", "Invalid semantic command identity.", 400);
    return inInventoryCutoverTransaction(this.pool, "admitted_commit", async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`inventory:initial-scope:${input.idempotencyKey}`]);
      const replay = await loadReplay(client, input.idempotencyKey, requestHash);
      if (replay) return replay;
      // Authority/admission first. No graph, target, or source row locks precede it.
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "legacy", expectedConfigurationRunId: null });
      await client.query(`LOCK TABLE ${INITIAL_SCOPE_SOURCE_TABLES.join(",")} IN SHARE MODE NOWAIT`);
      const facts = await readInitialPublicationScopeFacts(client, input.publicationTargetId, true);
      const review = reviewInitialPublicationScope(input, facts);
      if (!review.ready) throw new InitialPublicationScopeError("INITIAL_SCOPE_REVIEW_BLOCKED", "Resolve the current scope review blockers before preparation.");
      if (review.reviewHash !== input.expectedReviewHash) throw new InitialPublicationScopeError("INITIAL_SCOPE_REVIEW_STALE", "Listing membership, catalog policy or mapping changed; review again.");
      const receipt = initialPublicationScopeReceiptSchema.parse({
        publicationTargetId: input.publicationTargetId, previousRevision: review.targetRevision,
        revision: (BigInt(review.targetRevision) + BigInt(1)).toString(), reviewHash: review.reviewHash,
        includedVariantIds: review.includedVariantIds, preparedBy: actor, preparedAt: now.toISOString(), alreadyApplied: false,
        excludedVariants: review.excludedVariants ?? [],
        importedVariantIds: (review.mappingImports ?? []).map(row => row.productVariantId),
        runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false,
      });
      await client.query(`INSERT INTO inventory.publication_initial_scope_receipts
        (publication_target_id,previous_revision,authority_revision,idempotency_key,request_hash,review_hash,actor,occurred_at,included_variant_ids,evidence,receipt,excluded_variant_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::integer[],$10::jsonb,$11::jsonb,$12::integer[])`,
      [input.publicationTargetId, review.targetRevision, review.authorityRevision, input.idempotencyKey, requestHash, review.reviewHash,
        actor, now, review.includedVariantIds, JSON.stringify({ facts, review }), JSON.stringify(receipt),
        (review.excludedVariants ?? []).map(row => row.productVariantId)]);
      await importExistingListingMappings(client, input.publicationTargetId, review, actor, requestHash, now);
      const updated = await client.query(`UPDATE inventory.inventory_publication_targets SET membership_mode='explicit',revision=revision+1
        WHERE id=$1 AND revision=$2 AND state='preview' AND membership_mode='whole_product' AND publication_authority='echelon'`,
      [input.publicationTargetId, review.targetRevision]);
      if (updated.rowCount !== 1) throw new InitialPublicationScopeError("INITIAL_SCOPE_TARGET_CHANGED", "The destination changed during preparation.");
      const decisions = [...review.includedVariantIds.map(productVariantId => ({ productVariantId, included: true })),
        ...(review.excludedVariants ?? []).map(row => ({ productVariantId: row.productVariantId, included: false }))]
        .sort((a, b) => a.productVariantId - b.productVariantId);
      for (const { productVariantId: variantId, included } of decisions) {
        const definitionHash = inventoryCutoverEvidenceHash({ publicationTargetId: input.publicationTargetId, productVariantId: variantId, included });
        await client.query(`WITH version AS (INSERT INTO inventory.publication_membership_versions
          (publication_target_id,product_variant_id,version,included,definition_hash,review_hash,created_by,created_at)
          VALUES($1,$2,1,$7,$3,$4,$5,$6) RETURNING id)
          INSERT INTO inventory.publication_membership_heads(publication_target_id,product_variant_id,active_version_id)
          SELECT $1,$2,id FROM version`, [input.publicationTargetId, variantId, definitionHash, review.reviewHash, actor, now, included]);
      }
      await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
        VALUES($1,'AUDIT',$2,'inventory_availability.publication_scope.initialized',$3,$4::jsonb,$5::jsonb)`,
      [now, actor, `inventory.inventory_publication_target:${input.publicationTargetId}`,
        JSON.stringify({ before: { mode: "whole_product", revision: review.targetRevision },
          after: { mode: "explicit", revision: receipt.revision, includedVariantIds: receipt.includedVariantIds,
            excludedVariants: receipt.excludedVariants, mappingImports: review.mappingImports ?? [] } }),
        JSON.stringify({ idempotencyKey: input.idempotencyKey, requestHash, reviewHash: review.reviewHash, receipt })]);
      return receipt;
    });
  }
}

/** A retry snapshot of existing channel identities, not a second manual setup.
 * The caller holds the authority fence and every source predicate through commit.
 * Existing heads are never overwritten; conflicting or changed sources require
 * a fresh review. All inserts share the scope receipt's atomic transaction. */
async function importExistingListingMappings(client: PoolClient, targetId: number, review: InitialPublicationScopeReview,
  actor: string, requestHash: string, now: Date): Promise<void> {
  for (const mapping of review.mappingImports ?? []) {
    const definitionHash = calculatePublicationVariantMappingDefinitionHash({ publicationTargetId: targetId,
      productVariantId: mapping.productVariantId, externalInventoryItemId: mapping.externalInventoryItemId, externalSku: mapping.externalSku });
    const reason = "Imported the existing channel listing identity during reviewed cutover preparation.";
    const inserted = await client.query(`INSERT INTO inventory.publication_variant_mapping_versions
      (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,definition_hash,
       change_reason,idempotency_key,request_hash,created_by,created_at,updated_at)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
    [targetId, mapping.productVariantId, mapping.externalInventoryItemId, mapping.externalSku, definitionHash,
      reason, `initial-scope-map:${requestHash}:${mapping.productVariantId}`, requestHash, actor, now]);
    if (inserted.rowCount !== 1) throw new InitialPublicationScopeError("INITIAL_SCOPE_MAPPING_IMPORT_FAILED", "The existing listing identity was not snapshotted.");
    const head = await client.query(`INSERT INTO inventory.publication_variant_mapping_heads
      (publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason,updated_at)
      VALUES($1,$2,$3,1,$4,$5,$6)`, [targetId, mapping.productVariantId, inserted.rows[0].id, actor, reason, now]);
    if (head.rowCount !== 1) throw new InitialPublicationScopeError("INITIAL_SCOPE_MAPPING_IMPORT_FAILED", "The imported identity has no matching draft head.");
  }
}

async function loadReplay(client: PoolClient, key: string, requestHash: string): Promise<InitialPublicationScopeReceipt | null> {
  const row = (await client.query("SELECT request_hash,receipt FROM inventory.publication_initial_scope_receipts WHERE idempotency_key=$1", [key])).rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new InitialPublicationScopeError("INITIAL_SCOPE_COMMAND_CONFLICT", "This command key was used for a different request or actor.");
  return { ...initialPublicationScopeReceiptSchema.parse(row.receipt), alreadyApplied: true };
}
