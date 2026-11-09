import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { pool } from "../../../db";
import type { SupplySnapshotDto } from "@shared/types/inventory-availability-planner";
import { channelDefinitionReceiptSchema } from "@shared/types/inventory-channel-definition";
import {
  channelRuleProgressSchema, channelRuleReceiptSchema, channelRuleReviewSchema, channelRuleScopeKeySchema,
  type ApplyChannelRule, type ChannelRuleReceipt, type ChannelRuleReview, type ChannelRuleSelection,
} from "@shared/types/inventory-channel-rule";
import { ChannelDefinitionError } from "../application/inventory-channel-definition.service";
import type { ChannelRuleStore } from "../application/inventory-channel-rule.service";
import { InventoryAvailabilityRuntimePublicationError } from "../application/inventory-availability-runtime-publication.service";
import { planInventoryChannelExposureProduct, type ActiveInventoryPublicationTargetSnapshot } from "../application/inventory-channel-exposure-runtime.service";
import { channelExposurePolicyScopeKey } from "../domain/inventory-channel-exposure";
import { classifyChannelRuleIssues } from "../domain/inventory-channel-rule-review";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { previewProductDefinitionPublicationInsideTransaction } from "./inventory-availability-runtime-publication.repository";
import { CHANNEL_POLICY_DRAFT_CHANGES_SQL } from "./inventory-channel-definition.repository";
import { loadActivePublicationTargets, loadChannelRuleReviewTargets, loadManagedSellableVariantIds } from "./inventory-channel-exposure-runtime.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import { enqueueReviewedDefinitionPublication } from "./inventory-product-definition.repository";

/**
 * Applies ONE saved product or SKU channel rule (owner decision 2026-11-07:
 * saving one SKU must not drag in the channel's other pending changes). Only that
 * draft is promoted; only its product is replanned and republished, on every
 * live destination. Problems the rule would create block; problems that already
 * exist are shown and never block, and broken destinations are isolated by the
 * publisher exactly as a stock change isolates them.
 *
 * Receipts share the append-only inventory.channel_definition_applications table
 * (and its retry-key space) with the whole-channel apply. The stored receipt has
 * the channel receipt shape; the stored review is this rule review, whose
 * top-level scopeKey identifies a rule apply.
 */
export class PostgresChannelRuleStore implements ChannelRuleStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}

  review(selection: ChannelRuleSelection) {
    return this.transaction(false, client => captureRuleReview(client, selection));
  }

  async apply(command: ApplyChannelRule, actor: string, requestHash: string, now: Date): Promise<ChannelRuleReceipt> {
    const { receipt, before } = await this.transaction(true, async client => {
      // The whole-channel apply uses this namespace too: one retry key has one owner on either endpoint.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`channel_definition:${command.idempotencyKey}`]);
      const replay = (await client.query<{ request_hash: string; review: unknown; receipt: unknown }>(
        "SELECT request_hash,review,receipt FROM inventory.channel_definition_applications WHERE idempotency_key=$1", [command.idempotencyKey],
      )).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash) {
          throw new ChannelDefinitionError("CHANNEL_RULE_COMMAND_CONFLICT", "This retry key belongs to another command or user.");
        }
        const stored = storedRuleReviewSchema.parse(replay.review);
        return { receipt: { ...ruleReceipt(replay.receipt, stored), alreadyApplied: true }, before: stored.change.before?.id ?? null };
      }
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
      // Recaptured under the fence: no inventory or configuration writer can commit until this transaction ends.
      const review = await captureRuleReview(client, { scope: command.scope, draftPolicyId: command.draftPolicyId,
        expectedHeadRevision: command.expectedHeadRevision, expectedDefinitionHash: command.expectedDefinitionHash });
      if (review.reviewHash !== command.expectedReviewHash) {
        throw new ChannelDefinitionError("CHANNEL_RULE_REVIEW_STALE", "This rule, its listings or its destinations changed. Check the change again before applying.");
      }
      if (!review.ready) throw new ChannelDefinitionError("CHANNEL_RULE_REVIEW_BLOCKED", "Fix the problems this rule would create before applying it.");
      const changedDefinitions = await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
        contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [review.productId], publicationTargetIds: [],
        selections: [review.change.selection],
      }, { actor, occurredAt: now, reason: `Applied one channel stock rule (${review.scopeKey}).` });
      const publicationIds = await enqueueReviewedDefinitionPublication(client, {
        affectedProductIds: [review.productId], activationRunId: review.activationRunId,
        channels: review.quantities.map(row => ({ productId: review.productId, ...row })),
      }, { triggeredBy: "channel_rule_apply", acceptProjectionWarnings: true });
      const stored = channelDefinitionReceiptSchema.parse({ channelId: review.channelId, appliedAt: now.toISOString(), appliedBy: actor,
        reviewHash: review.reviewHash, publicationIds, changedDefinitions, alreadyApplied: false });
      await client.query(`INSERT INTO inventory.channel_definition_applications
        (channel_id,idempotency_key,request_hash,actor,occurred_at,review,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [review.channelId, command.idempotencyKey, requestHash, actor, now.toISOString(), JSON.stringify(review), JSON.stringify(stored)]);
      return { receipt: ruleReceipt(stored, review), before: numericId(review.change.before?.id) };
    });
    // After COMMIT only. The durable audit trail is the receipt row, the sealed
    // version (sealed_by/sealed_at) and the head revision; this line is for search.
    console.info(JSON.stringify({ level: "info", event: "channel_rule_applied", action: "channel_rule_apply",
      outcome: receipt.alreadyApplied ? "replayed" : "applied", error_code: null, actor,
      channel_id: receipt.channelId, scope_key: receipt.scopeKey, product_id: receipt.productId,
      before: { active_policy_id: before }, after: { active_policy_id: receipt.policyId },
      publication_ids: receipt.publicationIds, applied_at: receipt.appliedAt }));
    return receipt;
  }

  progress(scopeKey: string) {
    return this.transaction(false, async client => {
      const channelId = Number(channelRuleScopeKeySchema.parse(scopeKey).split(":")[1]);
      const latest = (await client.query<{ review: unknown; receipt: unknown }>(
        `SELECT review,receipt FROM inventory.channel_definition_applications
         WHERE channel_id=$1 AND review->>'scopeKey'=$2 ORDER BY id DESC LIMIT 1`, [channelId, scopeKey],
      )).rows[0];
      if (!latest) return null;
      const receipt = ruleReceipt(latest.receipt, storedRuleReviewSchema.parse(latest.review));
      const publications = (await client.query(`SELECT id::text, publication_target_id AS "targetId",product_variant_id AS "variantId",
        state, desired_quantity::text AS "desiredQuantity",last_error_class AS "errorCode"
        FROM inventory.inventory_publication_outbox WHERE id=ANY($1::bigint[]) ORDER BY id`, [receipt.publicationIds])).rows;
      if (publications.length !== receipt.publicationIds.length) {
        throw new ChannelDefinitionError("CHANNEL_RULE_OUTBOX_MISSING", "Delivery records are incomplete.", 500);
      }
      return channelRuleProgressSchema.parse({ receipt, publications });
    });
  }

  private async transaction<T>(applying: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connectionPool.connect();
    let discard = false;
    try {
      // Apply needs READ COMMITTED to own the cutover fence; reads use one snapshot.
      await client.query(applying ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='60s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollback) { discard = true; throw new AggregateError([error, rollback], "Channel rule rollback failed"); }
      throw error;
    } finally { client.release(discard); }
  }
}

/** Only the fields a receipt needs, so older stored reviews stay readable. */
const storedRuleReviewSchema = z.object({
  scopeKey: channelRuleScopeKeySchema,
  productId: z.number().int().positive(),
  change: z.object({
    selection: z.object({ definitionId: z.number().int().positive() }).passthrough(),
    before: z.object({ id: z.number().int().positive() }).passthrough().nullable(),
  }).passthrough(),
}).passthrough();

function ruleReceipt(stored: unknown, review: { scopeKey: string; productId: number; change: { selection: { definitionId: number } } }): ChannelRuleReceipt {
  return channelRuleReceiptSchema.parse({ ...channelDefinitionReceiptSchema.parse(stored),
    scopeKey: review.scopeKey, productId: review.productId, policyId: review.change.selection.definitionId });
}

function numericId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

type DraftRow = {
  key: string; revision: string; id: number; definition_hash: string; label: string;
  before: Record<string, unknown> | null; after: Record<string, unknown>;
};

async function captureRuleReview(client: PoolClient, selection: ChannelRuleSelection): Promise<ChannelRuleReview> {
  const authority = (await client.query<{ authority: string; revision: string; activation_run_id: string | null }>(
    "SELECT authority,revision::text,activation_run_id::text FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE",
  )).rows[0];
  if (!authority || authority.authority !== "canonical" || !authority.activation_run_id) {
    throw new ChannelDefinitionError("CHANNEL_RULE_CANONICAL_REQUIRED", "Rules can be applied after inventory cutover. Saving a draft does not activate migration.");
  }
  const { scope } = selection;
  const scopeKey = channelExposurePolicyScopeKey(scope);
  const channel = (await client.query<{ name: string }>("SELECT name FROM channels.channels WHERE id=$1", [scope.channelId])).rows[0];
  if (!channel) throw new ChannelDefinitionError("CHANNEL_RULE_NOT_FOUND", "Channel not found.", 404);
  const draft = (await client.query<DraftRow>(`${CHANNEL_POLICY_DRAFT_CHANGES_SQL} WHERE h.scope_key=$1`, [scopeKey])).rows[0];
  if (!draft || draft.id !== selection.draftPolicyId || draft.revision !== selection.expectedHeadRevision
    || draft.definition_hash !== selection.expectedDefinitionHash) {
    throw new ChannelDefinitionError("CHANNEL_RULE_DRAFT_CHANGED", "This rule's saved change is different now. Reload it before applying.");
  }
  // The scope key names the channel and SKU but not the product, so confirm the
  // saved version belongs to the product the operator is looking at.
  if (draft.after.channel_id !== scope.channelId || draft.after.scope_type !== scope.scopeType
    || draft.after.product_id !== scope.productId
    || (draft.after.product_variant_id ?? null) !== (scope.scopeType === "variant" ? scope.productVariantId : null)) {
    throw new ChannelDefinitionError("CHANNEL_RULE_SCOPE_MISMATCH", "This saved rule belongs to a different product or SKU.");
  }
  const productId = scope.productId;
  const variants = await loadManagedSellableVariantIds(client, productId);
  const snapshot = await captureActiveSupplySnapshotInsideTransaction(client, productId);
  const currentTargets = await loadActivePublicationTargets(client, productId, variants);
  const proposedTargets = await loadChannelRuleReviewTargets(client, productId, variants, scopeKey);
  const context = { authority: "canonical" as const, authorityRevision: authority.revision,
    activationRunId: authority.activation_run_id, supplySnapshot: snapshot, managedSellableVariantIds: variants };
  const before = planInventoryChannelExposureProduct({ ...context, publicationTargets: currentTargets }, productId);
  const after = planInventoryChannelExposureProduct({ ...context, publicationTargets: proposedTargets }, productId);
  const issues = classifyChannelRuleIssues(before.targets, after.targets);
  const blockers = [...issues.introduced];
  const warnings = [...issues.existing, ...issues.notices];
  const current = await previewIsolated(client, productId, snapshot, currentTargets);
  const proposed = await previewIsolated(client, productId, snapshot, proposedTargets);
  if ("errorCode" in proposed) {
    blockers.push(`${channel.name} / product ${productId}: stock cannot be published with this rule (${proposed.errorCode}). Nothing was applied.`);
  } else if ("errorCode" in current) {
    warnings.push(`${channel.name} / product ${productId}: stock cannot be published under the current rules (${current.errorCode}).`);
  }
  const skippedDestinations = "publication" in proposed
    ? [...new Set((proposed.publication.blockedTargets ?? []).map(target => {
      const scope = target.isolation === "rows" ? ` for ${target.productVariantIds.length} unlinked SKU(s)` : "";
      return `${target.channelName}: stock is not updating${scope} (${target.errorCode}: ${target.blockerCodes.join(", ")}). Fix that listing; this rule still applies.`;
    }))]
    : [];
  const currentRows = "publication" in current ? current.publication.rows : [];
  const quantities = "publication" in proposed ? proposed.publication.rows.map(row => ({
    targetId: row.publicationTargetId, channelName: row.channelName, variantId: row.productVariantId, sku: row.sku,
    current: currentRows.find(item => item.publicationTargetId === row.publicationTargetId
      && item.productVariantId === row.productVariantId)?.desiredQuantity ?? null,
    proposed: row.desiredQuantity,
  })) : [];
  const uniqueBlockers = [...new Set(blockers)];
  const content = {
    selection, scopeKey, channelId: scope.channelId, channelName: channel.name, productId,
    authorityRevision: authority.revision, activationRunId: authority.activation_run_id,
    change: { selection: { kind: "channel_policy" as const, key: scopeKey, definitionId: draft.id, definitionHash: draft.definition_hash },
      headRevision: draft.revision, label: draft.label, before: draft.before, after: draft.after },
    blockers: uniqueBlockers, warnings: [...new Set(warnings)], skippedDestinations, ready: uniqueBlockers.length === 0,
  };
  // The hash pins configuration, not stock: the draft, every destination's rules,
  // warehouses, listing links, holds and listing selection, which rows publish,
  // and every problem shown. Stock moves with every order; Apply republishes what
  // the planner calculates inside its own fenced transaction, as the stock-change
  // worker does for every movement, so an order between Review and Apply never
  // makes this review stale. Quantities shown are a preview, not a promise.
  const reviewHash = inventoryCutoverEvidenceHash({ content, rows: quantities.map(row => [row.targetId, row.variantId]),
    currentTargets, proposedTargets });
  return channelRuleReviewSchema.parse({ ...content, quantities, reviewHash });
}

type IsolatedPreview =
  | { publication: Awaited<ReturnType<typeof previewProductDefinitionPublicationInsideTransaction>> }
  | { errorCode: string };

/** Dry run with the publisher's own isolation. Isolation already skips unsafe
 * destinations; what still throws (for example two destinations claiming one
 * provider scope) stops the whole product and is reported, not hidden. */
async function previewIsolated(client: PoolClient, productId: number, snapshot: SupplySnapshotDto,
  targets: readonly ActiveInventoryPublicationTargetSnapshot[]): Promise<IsolatedPreview> {
  try {
    return { publication: await previewProductDefinitionPublicationInsideTransaction(client, productId, snapshot, targets, "isolate") };
  } catch (error) {
    if (error instanceof InventoryAvailabilityRuntimePublicationError) return { errorCode: error.code };
    throw error;
  }
}
