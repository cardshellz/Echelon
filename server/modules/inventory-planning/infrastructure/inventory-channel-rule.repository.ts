import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { pool } from "../../../db";
import { channelDefinitionReceiptSchema } from "@shared/types/inventory-channel-definition";
import {
  channelRuleProgressSchema, channelRuleReceiptSchema, channelRuleReviewSchema, channelRuleScopeKeySchema, channelRuleSetResultSchema,
  type ApplyChannelRule, type ChannelRuleCopyResult, type ChannelRuleReceipt, type ChannelRuleReview, type ChannelRuleSelection,
  type ChannelRuleSetResult, type CopyChannelRules, type SetChannelRule,
} from "@shared/types/inventory-channel-rule";
import { ChannelDefinitionError } from "../application/inventory-channel-definition.service";
import type { ChannelRuleStore } from "../application/inventory-channel-rule.service";
import { planInventoryChannelExposureProduct } from "../application/inventory-channel-exposure-runtime.service";
import { channelExposurePolicyScopeKey } from "../domain/inventory-channel-exposure";
import { classifyChannelRuleIssues } from "../domain/inventory-channel-rule-review";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { CHANNEL_POLICY_DRAFT_CHANGES_SQL } from "./inventory-channel-definition.repository";
import { PostgresInventoryChannelExposureAdminStore } from "./inventory-channel-exposure-admin.repository";
import { copyChannelRulesInsideTransaction } from "./inventory-channel-rule-copy.repository";
import { previewIsolated } from "./inventory-channel-rule-preview";
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
/** The version row's idempotency key for a version written by `set`; distinct from keys the draft endpoint is given. */
const RULE_SET_DRAFT_KEY_PREFIX = "rule-set:";

export class PostgresChannelRuleStore implements ChannelRuleStore {
  /** `drafts`: the rule version writer `set` runs inside its own transaction. Built on first use, so review, apply
   * and progress never construct it. */
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool,
    private drafts: Pick<PostgresInventoryChannelExposureAdminStore, "savePolicyDraftInsideTransaction"> | null = null) {}

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
      const receipt = await promoteReviewedRule(client, review, { idempotencyKey: command.idempotencyKey, requestHash, actor, now });
      return { receipt, before: numericId(review.change.before?.id) };
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

  /**
   * Save + review + apply of ONE rule as a single transaction, so a refused or
   * failed set leaves no rows at all (rule versions are append-only: a version
   * that committed could never be deleted again).
   *
   * How the two writers share one transaction: this method's pinned client owns
   * BEGIN/COMMIT/ROLLBACK. The draft writer is the existing drizzle code, so it
   * is handed a drizzle handle bound to that same client and used for statements
   * only. `.transaction()` is never called on that handle: on a bare client it
   * would issue its own BEGIN/COMMIT and commit this transaction early. This is
   * the arrangement saveVariantMappingDraftInsideTransaction already uses
   * (exact-stock-identity.apply.ts).
   *
   * Lock order: retry key, cutover fence, then the rule's own locks (taken by
   * the draft writer). Both applies take the fence before any head row, so
   * taking it after the head lock here could deadlock against them.
   */
  async set(command: SetChannelRule, actor: string, requestHash: string, now: Date): Promise<ChannelRuleSetResult> {
    const { result, before } = await this.transaction(true, async client => {
      // One retry-key space with both applies: a key has one owner on any of the three endpoints.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`channel_definition:${command.idempotencyKey}`]);
      const replay = (await client.query<{ request_hash: string; review: unknown; receipt: unknown }>(
        "SELECT request_hash,review,receipt FROM inventory.channel_definition_applications WHERE idempotency_key=$1", [command.idempotencyKey],
      )).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash) {
          throw new ChannelDefinitionError("CHANNEL_RULE_COMMAND_CONFLICT", "This retry key belongs to another command or user.");
        }
        const stored = storedRuleSetReviewSchema.parse(replay.review);
        return { result: ruleSetResult({ ...ruleReceipt(replay.receipt, stored), alreadyApplied: true }, stored),
          before: stored.change.before?.id ?? null };
      }
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
      this.drafts ??= new PostgresInventoryChannelExposureAdminStore();
      const saved = await this.drafts.savePolicyDraftInsideTransaction(drizzle(client), {
        scope: command.scope, value: command.value, expectedHeadRevision: command.expectedHeadRevision,
        expectedDraftPolicyId: command.expectedDraftPolicyId, expectedDraftDefinitionHash: command.expectedDraftDefinitionHash,
        changeReason: command.changeReason, idempotencyKey: `${RULE_SET_DRAFT_KEY_PREFIX}${command.idempotencyKey}`,
        requestHash, actorId: actor, occurredAt: now,
      });
      // The draft receipt is written in this transaction, so it cannot exist without the receipt checked above.
      if (saved.alreadyApplied) {
        throw new ChannelDefinitionError("CHANNEL_RULE_SET_RECEIPT_INCONSISTENT", "This command's records are incomplete. Nothing was changed.", 500);
      }
      // Captured under the fence against the version just written: nothing can move between this review and the apply.
      const review = await captureRuleReview(client, { scope: command.scope, draftPolicyId: saved.definitionId,
        expectedHeadRevision: saved.headRevision, expectedDefinitionHash: saved.definitionHash });
      if (!review.ready) {
        throw new ChannelDefinitionError("CHANNEL_RULE_REVIEW_BLOCKED",
          "This rule would create a problem, so it was not saved. Nothing changed.", 409, review.blockers);
      }
      const receipt = await promoteReviewedRule(client, review, { idempotencyKey: command.idempotencyKey, requestHash, actor, now });
      return { result: ruleSetResult(receipt, review), before: numericId(review.change.before?.id) };
    });
    // After COMMIT only; see apply. The saved version's own audit event is in the same transaction.
    const { receipt } = result;
    console.info(JSON.stringify({ level: "info", event: "channel_rule_set", action: "channel_rule_set",
      outcome: receipt.alreadyApplied ? "replayed" : "applied", error_code: null, actor,
      channel_id: receipt.channelId, scope_key: receipt.scopeKey, product_id: receipt.productId,
      before: { active_policy_id: before }, after: { active_policy_id: receipt.policyId },
      publication_ids: receipt.publicationIds, applied_at: receipt.appliedAt }));
    return result;
  }

  /** Copies a channel's stock rules to a channel that has none and applies them, in one transaction
   * (inventory-channel-rule-copy.repository.ts). A refused or failed copy leaves no rows. */
  async copy(command: CopyChannelRules, actor: string, requestHash: string, now: Date): Promise<ChannelRuleCopyResult> {
    const result = await this.transaction(true, client => {
      this.drafts ??= new PostgresInventoryChannelExposureAdminStore();
      return copyChannelRulesInsideTransaction(client, this.drafts, command, actor, requestHash, now);
    });
    // After COMMIT only; the receipt row and each sealed version are the durable trail.
    const { receipt } = result;
    console.info(JSON.stringify({ level: "info", event: "channel_rules_copied", action: "channel_rule_copy",
      outcome: receipt.alreadyApplied ? "replayed" : "applied", error_code: null, actor,
      channel_id: receipt.channelId, source_channel_id: result.sourceChannelId,
      before: { rules: 0 }, after: { rules: receipt.changedDefinitions },
      publication_ids: receipt.publicationIds, applied_at: receipt.appliedAt }));
    return result;
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

/** What a set returns needs the published rows too; they are read back from the stored review on a replay. */
const storedRuleSetReviewSchema = storedRuleReviewSchema.extend({
  quantities: channelRuleSetResultSchema.shape.quantities,
  skippedDestinations: channelRuleSetResultSchema.shape.skippedDestinations,
  warnings: channelRuleSetResultSchema.shape.warnings,
}).passthrough();

function ruleSetResult(receipt: ChannelRuleReceipt,
  review: Pick<ChannelRuleSetResult, "quantities" | "skippedDestinations" | "warnings">): ChannelRuleSetResult {
  return channelRuleSetResultSchema.parse({ receipt, quantities: review.quantities,
    skippedDestinations: review.skippedDestinations, warnings: review.warnings });
}

/** The write half shared by apply and set: seal the reviewed version, enqueue its product's stock, store the receipt. */
async function promoteReviewedRule(client: PoolClient, review: ChannelRuleReview,
  input: { idempotencyKey: string; requestHash: string; actor: string; now: Date }): Promise<ChannelRuleReceipt> {
  const { actor, now } = input;
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
  [review.channelId, input.idempotencyKey, input.requestHash, actor, now.toISOString(), JSON.stringify(review), JSON.stringify(stored)]);
  return ruleReceipt(stored, review);
}

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
