import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { publicationMembershipReceiptSchema } from "@shared/types/inventory-publication-membership";
import { PrecutoverExclusionError, precutoverExclusionCommandHash, precutoverExclusionReceiptSchema,
  type PrecutoverExclusionStore, type PrecutoverExclusionReceipt } from "../application/inventory-publication-precutover-exclusion.service";
import { applyPrecutoverExclusionSchema, precutoverExclusionFactsSchema, reviewPrecutoverExclusion,
  type ApplyPrecutoverExclusion, type ReviewPrecutoverExclusion } from "../domain/inventory-publication-precutover-exclusion";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { quantityPublicationScopeSchema } from "../domain/quantity-publication-admission";
import { inInventoryCutoverTransaction } from "./inventory-cutover-commit.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { quantityPublicationScopeLockKey } from "./quantity-publication-admission.repository";
import { PUBLICATION_TARGET_SCOPE_LOCK_SEED } from "./inventory-publication-target-stop.repository";

const receiptKey = (key: string, targetId: number) => `precutover-exclusion:${key}:${targetId}`;
const targetIds = (input: ReviewPrecutoverExclusion) => [...new Set(input.exclusions.map(row => row.publicationTargetId))].sort((a, b) => a - b);
const fail = (code: string, message: string): never => { throw new PrecutoverExclusionError(code, message); };

/** Uses the existing append-only membership authority, without modifying the
 * initial receipt, provider mapping, legacy feed, inventory or activation state. */
export class PostgresPrecutoverExclusionStore implements PrecutoverExclusionStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  async review(input: ReviewPrecutoverExclusion, now: Date) {
    return inInventoryCutoverTransaction(this.pool, "read_only_review", client => captureReview(client, input, now));
  }
  async apply(raw: ApplyPrecutoverExclusion, actor: string, requestHash: string, now: Date): Promise<PrecutoverExclusionReceipt> {
    const input = applyPrecutoverExclusionSchema.parse(raw);
    z.string().trim().min(1).max(100).parse(actor);
    z.date().parse(now);
    if (requestHash !== precutoverExclusionCommandHash(input, actor))
      fail("PRECUTOVER_EXCLUSION_COMMAND_INVALID", "Invalid semantic command identity.");
    return inInventoryCutoverTransaction(this.pool, "admitted_commit", async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`precutover-exclusion:${input.idempotencyKey}`]);
      const prior = (await client.query<{ request_hash: string; receipt: unknown }>(
        "SELECT request_hash,receipt FROM inventory.publication_membership_applications WHERE left(idempotency_key,length($1))=$1 ORDER BY publication_target_id",
        [`precutover-exclusion:${input.idempotencyKey}:`])).rows;
      if (prior.length) {
        if (prior.length !== targetIds(input).length || prior.some(row => row.request_hash !== requestHash))
          fail("PRECUTOVER_EXCLUSION_REPLAY_CONFLICT", "The command identity belongs to another or incomplete request.");
        return precutoverExclusionReceiptSchema.parse({ targets: prior.map(row => ({
          ...publicationMembershipReceiptSchema.parse(row.receipt), alreadyApplied: true })),
        runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false });
      }
      // Same authority/admission order as initial preparation. NOWAIT predicate
      // locks reject concurrent writers instead of waiting in their reverse order.
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "legacy", expectedConfigurationRunId: null });
      await client.query(`LOCK TABLE inventory.inventory_publication_targets,
        inventory.publication_membership_heads,inventory.publication_membership_versions,
        inventory.publication_variant_mapping_heads,inventory.publication_variant_mapping_versions,
        inventory.inventory_publication_outbox,inventory.quantity_publication_gate,
        channels.channels,channels.channel_connections IN SHARE MODE NOWAIT`);
      const review = await captureReview(client, input, now);
      if (!review.ready) throw new PrecutoverExclusionError("PRECUTOVER_EXCLUSION_BLOCKED", "Pre-cutover exclusion is not safe.", { blockers: review.blockers });
      if (review.reviewHash !== input.expectedReviewHash)
        fail("PRECUTOVER_EXCLUSION_REVIEW_STALE", "Publication membership or mapping changed after review.");
      const scopes = input.exclusions.map(row => quantityPublicationScopeLockKey(quantityPublicationScopeSchema.parse({
        destinationKind: "channel_connection", connectionId: row.channelConnectionId, providerKey: row.evidence.provider,
        providerScopeType: row.providerScopeType, externalScopeId: row.externalScopeId,
        externalInventoryItemId: row.externalInventoryItemId, productId: null, productVariantId: null,
      })));
      for (const scope of [...new Set(scopes)].sort()) {
        const lock = (await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_xact_lock(hashtextextended($1,$2)) AS acquired", [scope, PUBLICATION_TARGET_SCOPE_LOCK_SEED])).rows[0];
        if (!lock?.acquired) fail("PRECUTOVER_EXCLUSION_PROVIDER_BUSY", "An inventory request is still in flight for this listing.");
      }
      const receipts: PrecutoverExclusionReceipt["targets"] = [];
      for (const targetId of targetIds(input)) {
        const target = review.facts.targets.find(row => row.id === targetId)!;
        const members = review.facts.members.filter(row => row.publicationTargetId === targetId);
        for (const member of members) {
          const definitionHash = inventoryCutoverEvidenceHash({ publicationTargetId: targetId,
            productVariantId: member.productVariantId, included: false });
          const inserted = await client.query<{ id: string }>(`INSERT INTO inventory.publication_membership_versions
            (publication_target_id,product_variant_id,version,included,definition_hash,review_hash,created_by,created_at)
            VALUES($1,$2,$3,false,$4,$5,$6,$7) RETURNING id::text`,
          [targetId, member.productVariantId, (BigInt(member.version) + BigInt(1)).toString(), definitionHash, review.reviewHash, actor, now]);
          if (inserted.rowCount !== 1) fail("PRECUTOVER_EXCLUSION_WRITE_INCOMPLETE", "Membership version was not appended.");
          const head = await client.query(`UPDATE inventory.publication_membership_heads SET active_version_id=$1
            WHERE publication_target_id=$2 AND product_variant_id=$3 AND active_version_id=$4`,
          [inserted.rows[0]!.id, targetId, member.productVariantId, member.versionId]);
          if (head.rowCount !== 1) fail("PRECUTOVER_EXCLUSION_WRITE_INCOMPLETE", "Membership head was not advanced.");
        }
        const updated = await client.query<{ revision: string }>(`UPDATE inventory.inventory_publication_targets
          SET revision=revision+1 WHERE id=$1 AND revision=$2 AND state='preview' AND membership_mode='explicit'
          AND publication_authority='echelon' RETURNING revision::text`, [targetId, target.revision]);
        if (updated.rowCount !== 1) fail("PRECUTOVER_EXCLUSION_WRITE_INCOMPLETE", "Target revision was not advanced.");
        const receipt = publicationMembershipReceiptSchema.parse({ publicationTargetId: targetId,
          revision: updated.rows[0]!.revision, reviewHash: review.reviewHash,
          changedProductVariantIds: members.map(row => row.productVariantId), publicationRows: 0,
          appliedAt: now.toISOString(), appliedBy: actor, alreadyApplied: false });
        const application = await client.query(`INSERT INTO inventory.publication_membership_applications
          (publication_target_id,idempotency_key,request_hash,actor,occurred_at,review,receipt)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [targetId, receiptKey(input.idempotencyKey, targetId), requestHash, actor, now,
          JSON.stringify({ operation: "precutover_nonlive_listing_exclusion", input, ...review }), JSON.stringify(receipt)]);
        const audit = await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
          VALUES($1,'AUDIT',$2,'inventory_availability.publication_scope.pre_cutover_excluded',$3,$4::jsonb,$5::jsonb)`,
        [now, actor, `inventory.inventory_publication_target:${targetId}`,
          JSON.stringify({ before: { revision: target.revision, members }, after: { revision: receipt.revision,
            members: members.map(row => ({ productVariantId: row.productVariantId, included: false })) } }),
          JSON.stringify({ reason: input.reason, requestHash, reviewHash: review.reviewHash,
            idempotencyKey: input.idempotencyKey, receipt, providerWriteAttempted: false, runtimeAuthorityChanged: false })]);
        if (application.rowCount !== 1 || audit.rowCount !== 1)
          fail("PRECUTOVER_EXCLUSION_WRITE_INCOMPLETE", "The immutable receipt or audit was not recorded.");
        receipts.push(receipt);
      }
      return precutoverExclusionReceiptSchema.parse({ targets: receipts,
        runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false });
    });
  }
}

async function captureReview(client: PoolClient, input: ReviewPrecutoverExclusion, now: Date) {
  const ids = targetIds(input);
  const authority = (await client.query(`SELECT authority,revision::text AS "authorityRevision",
    activation_run_id::text AS "configurationRunId",
    EXISTS(SELECT 1 FROM inventory.availability_activation_freezes WHERE released_at IS NULL) AS frozen,
    NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_gate WHERE singleton AND activation_run_id IS NULL) AS "publicationSuppressed"
    FROM inventory.availability_runtime_authority WHERE singleton_key=true`)).rows[0];
  const targets = (await client.query(`SELECT t.id,t.revision::text,t.state,t.membership_mode AS mode,
    t.publication_authority AS authority,t.destination_kind AS "destinationKind",t.channel_id AS "channelId",
    t.channel_connection_id AS "channelConnectionId",lower(c.provider) AS provider,
    t.provider_scope_type AS "providerScopeType",t.external_scope_id AS "externalScopeId",
    EXISTS(SELECT 1 FROM inventory.inventory_publication_outbox o WHERE o.publication_target_id=t.id
      AND o.state IN ('desired','queued','leased','retryable','drifted','acknowledged')) AS "pendingPublication",
    EXISTS(SELECT 1 FROM inventory.publication_initial_scope_receipts r WHERE r.publication_target_id=t.id) AS "initiallyPrepared"
    FROM inventory.inventory_publication_targets t JOIN channels.channels c ON c.id=t.channel_id
    JOIN channels.channel_connections connection ON connection.id=t.channel_connection_id AND connection.channel_id=t.channel_id
    WHERE t.id=ANY($1::integer[]) ORDER BY t.id`, [ids])).rows;
  const members = (await client.query(`SELECT h.publication_target_id AS "publicationTargetId",
    h.product_variant_id AS "productVariantId",v.sku,m.id::text AS "versionId",m.version::text,m.included,
    mapping.id::text AS "mappingId",mapping.definition_hash AS "mappingHash",
    mapping.external_inventory_item_id AS "externalInventoryItemId",mapping.external_sku AS "externalSku"
    FROM inventory.publication_membership_heads h JOIN inventory.publication_membership_versions m ON m.id=h.active_version_id
    JOIN catalog.product_variants v ON v.id=h.product_variant_id
    JOIN inventory.publication_variant_mapping_heads mh ON mh.publication_target_id=h.publication_target_id AND mh.product_variant_id=h.product_variant_id
    JOIN inventory.publication_variant_mapping_versions mapping ON mapping.id=COALESCE(mh.draft_mapping_id,mh.active_mapping_id)
    JOIN jsonb_to_recordset($1::jsonb) AS requested("publicationTargetId" integer,"productVariantId" integer)
      ON requested."publicationTargetId"=h.publication_target_id AND requested."productVariantId"=h.product_variant_id
    ORDER BY h.publication_target_id,h.product_variant_id`, [JSON.stringify(input.exclusions)])).rows;
  return reviewPrecutoverExclusion({ exclusions: input.exclusions, reason: input.reason },
    precutoverExclusionFactsSchema.parse({ ...authority, targets, members }), now);
}
