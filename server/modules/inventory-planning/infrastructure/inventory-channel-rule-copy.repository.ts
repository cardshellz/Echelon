import type { PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { channelDefinitionReceiptSchema } from "@shared/types/inventory-channel-definition";
import type { ChannelExposurePolicyScope, ChannelExposurePolicyValue } from "@shared/types/inventory-channel-exposure";
import { channelRuleCopyResultSchema, type ChannelRuleCopyResult, type CopyChannelRules } from "@shared/types/inventory-channel-rule";
import { ChannelDefinitionError } from "../application/inventory-channel-definition.service";
import { planInventoryChannelExposureProduct } from "../application/inventory-channel-exposure-runtime.service";
import { classifyChannelRuleIssues } from "../domain/inventory-channel-rule-review";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { CHANNEL_POLICY_DRAFT_CHANGES_SQL } from "./inventory-channel-definition.repository";
import type { PostgresInventoryChannelExposureAdminStore } from "./inventory-channel-exposure-admin.repository";
import { loadActivePublicationTargets, loadChannelRuleCopyReviewTargets, loadManagedSellableVariantIds } from "./inventory-channel-exposure-runtime.repository";
import { previewIsolated } from "./inventory-channel-rule-preview";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import { enqueueReviewedDefinitionPublication } from "./inventory-product-definition.repository";

/**
 * Copies one channel's stock rules (its default and every product/SKU
 * exception) to a channel that has none, and applies them, as ONE transaction
 * (owner decision 2026-11-07: adding a channel offers "Copy stock rules from";
 * saves take effect, with no saved-but-not-applied state).
 *
 * What is copied is the numbers only: Stock %, Buffer, Max, Hide when below,
 * whether the channel may sell the item, and how it shares stock. A rule's
 * warehouse choice is supply for the source channel's destinations and is not
 * copied. Rules on a retired product or SKU are skipped and reported.
 *
 * The target must have no stock rule of any kind, so a copy never overwrites a
 * decision. Its other pending setup (warehouses, listing links) is not reviewed
 * and not applied here.
 */

/** A copy is one transaction; past this it would hold the cutover fence too long. Nothing is copied partially. */
const MAX_COPIED_RULES = 5_000;
/** Same ceiling as the whole-channel review: every affected product is replanned inside the transaction. */
const MAX_AFFECTED_PRODUCTS = 1_000;
/** Version rows written by a copy; distinct from keys the draft endpoint and the single-rule set are given. */
const RULE_COPY_DRAFT_KEY_PREFIX = "rule-copy:";
const DEFAULT_FIELDS = ["allocation_semantics", "eligible", "share_bps", "holdback_sellable_units", "max_publish_mode", "min_publish_sellable_units"] as const;

type DraftWriter = Pick<PostgresInventoryChannelExposureAdminStore, "savePolicyDraftInsideTransaction">;

type SourceRuleRow = {
  scope_type: "channel" | "product" | "variant"; product_id: number | null; product_variant_id: number | null;
  allocation_semantics: "exposure" | "partitioned" | null; eligible: boolean | null; share_bps: number | null;
  holdback_sellable_units: string | null; max_publish_mode: "unlimited" | "units" | null;
  max_publish_sellable_units: string | null; min_publish_sellable_units: string | null;
  inherit_all: boolean; label: string; usable: boolean;
};

/** Only what a replayed result needs, so stored copies stay readable if the review grows. */
const storedCopyReviewSchema = z.object({
  kind: z.literal("channel_rule_copy"),
  sourceChannelId: z.number().int().positive(), sourceChannelName: z.string(),
  channelId: z.number().int().positive(), channelName: z.string(),
  copiedExceptions: z.number().int().nonnegative(),
  skippedRules: z.array(z.string()), changedQuantities: z.number().int().nonnegative(),
  skippedDestinations: z.array(z.string()), warnings: z.array(z.string()),
}).passthrough();

export async function copyChannelRulesInsideTransaction(client: PoolClient, drafts: DraftWriter,
  command: CopyChannelRules, actor: string, requestHash: string, now: Date): Promise<ChannelRuleCopyResult> {
  // One retry-key space with the channel and single-rule applies: a key has one owner on any endpoint.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`channel_definition:${command.idempotencyKey}`]);
  const replay = (await client.query<{ request_hash: string; review: unknown; receipt: unknown }>(
    "SELECT request_hash,review,receipt FROM inventory.channel_definition_applications WHERE idempotency_key=$1", [command.idempotencyKey],
  )).rows[0];
  if (replay) {
    if (replay.request_hash !== requestHash) {
      throw new ChannelDefinitionError("CHANNEL_RULE_COMMAND_CONFLICT", "This retry key belongs to another command or user.");
    }
    return copyResult({ ...channelDefinitionReceiptSchema.parse(replay.receipt), alreadyApplied: true }, storedCopyReviewSchema.parse(replay.review));
  }
  // Fence first, as both applies do: no rule can be applied anywhere until this transaction ends.
  await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
  const authority = (await client.query<{ authority: string; revision: string; activation_run_id: string | null }>(
    "SELECT authority,revision::text,activation_run_id::text FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE",
  )).rows[0];
  if (!authority || authority.authority !== "canonical" || !authority.activation_run_id) {
    throw new ChannelDefinitionError("CHANNEL_RULE_CANONICAL_REQUIRED", "Stock rules can be copied after inventory cutover.");
  }
  const names = new Map((await client.query<{ id: number; name: string }>(
    "SELECT id,name FROM channels.channels WHERE id=ANY($1::integer[])", [[command.sourceChannelId, command.targetChannelId]],
  )).rows.map(row => [row.id, row.name]));
  const sourceName = names.get(command.sourceChannelId);
  const targetName = names.get(command.targetChannelId);
  if (sourceName === undefined || targetName === undefined) throw new ChannelDefinitionError("CHANNEL_RULE_NOT_FOUND", "Channel not found.", 404);

  // Two copies into one channel wait here; the second then finds rules and is refused.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`channel_rule_copy:${command.targetChannelId}`]);
  const existing = (await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM inventory.channel_exposure_policy_heads WHERE channel_id=$1", [command.targetChannelId],
  )).rows[0];
  if (existing.count !== "0") {
    throw new ChannelDefinitionError("CHANNEL_RULE_COPY_TARGET_HAS_RULES",
      `${targetName} already has stock rules, so nothing was copied. Change them in Channel Inventory.`);
  }

  // Rules in effect only. A change saved on the source but never applied is not a rule yet.
  const source = (await client.query<SourceRuleRow>(
    `SELECT p.scope_type,p.product_id,p.product_variant_id,p.allocation_semantics,p.eligible,p.share_bps,
        p.holdback_sellable_units::text,p.max_publish_mode,p.max_publish_sellable_units::text,p.min_publish_sellable_units::text,
        p.inherit_all,COALESCE(v.sku,product.name,'Channel default') AS label,
        (p.scope_type='channel' OR (COALESCE(product.is_active,false) AND (p.scope_type='product' OR (
          COALESCE(v.is_active,false) AND v.sales_eligibility='sellable' AND v.requires_shipping
          AND COALESCE(v.track_inventory,true))))) AS usable
      FROM inventory.channel_exposure_policy_heads h
      JOIN inventory.channel_exposure_policy_versions p ON p.id=h.active_policy_id AND p.lifecycle_status='sealed'
      LEFT JOIN catalog.products product ON product.id=p.product_id
      LEFT JOIN catalog.product_variants v ON v.id=p.product_variant_id AND v.product_id=p.product_id
      WHERE h.channel_id=$1 ORDER BY (p.scope_type='channel') DESC,h.scope_key LIMIT ${MAX_COPIED_RULES + 1}
      FOR SHARE OF h`, [command.sourceChannelId],
  )).rows;
  const sourceDefault = source.find(row => row.scope_type === "channel");
  if (!sourceDefault || DEFAULT_FIELDS.some(field => sourceDefault[field] == null)) {
    throw new ChannelDefinitionError("CHANNEL_RULE_COPY_SOURCE_EMPTY", `${sourceName} has no stock rules in effect to copy.`);
  }
  if (source.length > MAX_COPIED_RULES) {
    throw new ChannelDefinitionError("CHANNEL_RULE_COPY_TOO_LARGE",
      `${sourceName} has more than ${MAX_COPIED_RULES.toLocaleString("en-US")} stock rules. Nothing was copied.`, 422);
  }

  const skippedRules: string[] = [];
  const copies: Array<{ scope: ChannelExposurePolicyScope; value: ChannelExposurePolicyValue }> = [];
  for (const row of source) {
    // "Use the default again" on the source is the absence of a rule: there is nothing to copy.
    if (row.inherit_all) continue;
    if (!row.usable) { skippedRules.push(`${row.label}: no longer sold, so its rule was not copied.`); continue; }
    const value: ChannelExposurePolicyValue = {
      allocationSemantics: row.allocation_semantics, eligible: row.eligible, shareBps: row.share_bps,
      holdbackSellableUnits: row.holdback_sellable_units,
      maxPublish: row.max_publish_mode === "units" ? { mode: "units", units: row.max_publish_sellable_units! }
        : row.max_publish_mode === "unlimited" ? { mode: "unlimited" } : null,
      minPublishSellableUnits: row.min_publish_sellable_units,
    };
    // A source rule that only chose warehouses has no numbers to carry over.
    if (Object.values(value).every(field => field == null)) {
      skippedRules.push(`${row.label}: its rule only chooses warehouses, which are set per channel.`);
      continue;
    }
    copies.push({ scope: targetScope(row, command.targetChannelId), value });
  }

  const changeReason = command.changeReason ?? `Copied from ${sourceName}.`;
  const database = drizzle(client);
  for (const [index, copy] of copies.entries()) {
    // Statements only on the bound handle; this transaction's BEGIN/COMMIT belong to the caller.
    const saved = await drafts.savePolicyDraftInsideTransaction(database, {
      scope: copy.scope, value: copy.value, expectedHeadRevision: "0", expectedDraftPolicyId: null, expectedDraftDefinitionHash: null,
      changeReason, idempotencyKey: `${RULE_COPY_DRAFT_KEY_PREFIX}${command.idempotencyKey}:${index}`,
      requestHash, actorId: actor, occurredAt: now,
    });
    // Each version's receipt is written in this transaction, so none can exist without the receipt checked above.
    if (saved.alreadyApplied) {
      throw new ChannelDefinitionError("CHANNEL_RULE_COPY_RECEIPT_INCONSISTENT", "This command's records are incomplete. Nothing was changed.", 500);
    }
  }

  const changes = (await client.query<{ key: string; revision: string; id: number; definition_hash: string; label: string;
    before: Record<string, unknown> | null; after: Record<string, unknown> }>(
    `${CHANNEL_POLICY_DRAFT_CHANGES_SQL} WHERE h.channel_id=$1 ORDER BY h.scope_key`, [command.targetChannelId],
  )).rows;
  // The target had no rules and its lock is held, so the saved versions are exactly the ones written above.
  if (changes.length !== copies.length) {
    throw new ChannelDefinitionError("CHANNEL_RULE_COPY_CHANGED", `${targetName}'s stock rules changed while copying. Nothing was copied.`);
  }
  const selections = changes.map(change => ({ kind: "channel_policy" as const, key: change.key,
    definitionId: change.id, definitionHash: change.definition_hash }));

  // The new default reaches every product already listed on the target; exceptions add their own products.
  const affectedProductIds = (await client.query<{ product_id: number }>(
    `SELECT DISTINCT v.product_id FROM catalog.product_variants v
     WHERE v.is_active=true AND v.requires_shipping=true AND COALESCE(v.track_inventory,true)=true
       AND v.sales_eligibility='sellable' AND (
        EXISTS (SELECT 1 FROM inventory.publication_variant_mapping_heads h
          JOIN inventory.inventory_publication_targets t ON t.id=h.publication_target_id
          WHERE h.product_variant_id=v.id AND t.channel_id=$1)
        OR EXISTS (SELECT 1 FROM inventory.channel_exposure_policy_heads h
          JOIN inventory.channel_exposure_policy_versions p ON p.id=h.draft_policy_id
          WHERE h.channel_id=$1 AND p.product_id=v.product_id))
     ORDER BY v.product_id LIMIT ${MAX_AFFECTED_PRODUCTS + 1}`, [command.targetChannelId],
  )).rows.map(row => row.product_id);
  if (affectedProductIds.length > MAX_AFFECTED_PRODUCTS) {
    throw new ChannelDefinitionError("CHANNEL_RULE_COPY_TOO_LARGE",
      `This copy would recalculate more than ${MAX_AFFECTED_PRODUCTS.toLocaleString("en-US")} products. Nothing was copied.`, 422);
  }

  const blockers: string[] = [];
  const warnings: string[] = [];
  const skippedDestinations: string[] = [];
  const quantities: Array<{ productId: number; targetId: number; channelName: string; variantId: number; sku: string | null;
    current: string | null; proposed: string }> = [];
  const publishProductIds: number[] = [];
  for (const productId of affectedProductIds) {
    const variants = await loadManagedSellableVariantIds(client, productId);
    const snapshot = await captureActiveSupplySnapshotInsideTransaction(client, productId);
    const currentTargets = await loadActivePublicationTargets(client, productId, variants);
    const proposedTargets = await loadChannelRuleCopyReviewTargets(client, productId, variants, command.targetChannelId);
    const context = { authority: "canonical" as const, authorityRevision: authority.revision,
      activationRunId: authority.activation_run_id, supplySnapshot: snapshot, managedSellableVariantIds: variants };
    const before = planInventoryChannelExposureProduct({ ...context, publicationTargets: currentTargets }, productId);
    const after = planInventoryChannelExposureProduct({ ...context, publicationTargets: proposedTargets }, productId);
    // Only problems the copy creates refuse it; problems a product already has are shown and never block.
    const issues = classifyChannelRuleIssues(before.targets, after.targets);
    blockers.push(...issues.introduced);
    warnings.push(...issues.existing, ...issues.notices);
    const current = await previewIsolated(client, productId, snapshot, currentTargets);
    const proposed = await previewIsolated(client, productId, snapshot, proposedTargets);
    if ("errorCode" in proposed) {
      if ("errorCode" in current && current.errorCode === proposed.errorCode) {
        // Already unpublishable for the same reason: its rules are still copied, and nothing is queued for it here.
        warnings.push(`Product ${productId}: stock cannot be published under the current rules (${current.errorCode}).`);
      } else {
        blockers.push(`Product ${productId}: stock cannot be published with the copied rules (${proposed.errorCode}).`);
      }
      continue;
    }
    publishProductIds.push(productId);
    for (const target of proposed.publication.blockedTargets ?? []) {
      const scope = target.isolation === "rows" ? ` for ${target.productVariantIds.length} unlinked SKU(s)` : "";
      skippedDestinations.push(`${target.channelName}: stock is not updating${scope} (${target.errorCode}: ${target.blockerCodes.join(", ")}).`);
    }
    const currentRows = "publication" in current ? current.publication.rows : [];
    for (const row of proposed.publication.rows) {
      quantities.push({ productId, targetId: row.publicationTargetId, channelName: row.channelName, variantId: row.productVariantId,
        sku: row.sku, proposed: row.desiredQuantity,
        current: currentRows.find(item => item.publicationTargetId === row.publicationTargetId
          && item.productVariantId === row.productVariantId)?.desiredQuantity ?? null });
    }
  }
  const uniqueBlockers = [...new Set(blockers)];
  if (uniqueBlockers.length > 0) {
    throw new ChannelDefinitionError("CHANNEL_RULE_COPY_BLOCKED",
      "These rules would create a problem, so nothing was copied.", 409, uniqueBlockers);
  }

  const content = {
    kind: "channel_rule_copy" as const, sourceChannelId: command.sourceChannelId, sourceChannelName: sourceName,
    channelId: command.targetChannelId, channelName: targetName,
    authorityRevision: authority.revision, activationRunId: authority.activation_run_id,
    changes: changes.map((change, index) => ({ selection: selections[index], headRevision: change.revision, label: change.label,
      before: change.before, after: change.after })),
    affectedProductIds, quantities,
    copiedExceptions: copies.length - 1, skippedRules,
    changedQuantities: quantities.filter(row => row.current !== row.proposed).length,
    skippedDestinations: [...new Set(skippedDestinations)], warnings: [...new Set(warnings)],
  };
  const review = { ...content, reviewHash: inventoryCutoverEvidenceHash({ content }) };

  const changedDefinitions = await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
    contractVersion: "inventory_cutover_selection_manifest_v1", productIds: affectedProductIds, publicationTargetIds: [], selections,
  }, { actor, occurredAt: now, reason: `Copied stock rules from ${sourceName} to ${targetName}.` });
  const publicationIds = await enqueueReviewedDefinitionPublication(client, {
    affectedProductIds: publishProductIds, activationRunId: authority.activation_run_id, channels: quantities,
  }, { triggeredBy: "channel_rule_copy", acceptProjectionWarnings: true });
  const receipt = channelDefinitionReceiptSchema.parse({ channelId: command.targetChannelId, appliedAt: now.toISOString(),
    appliedBy: actor, reviewHash: review.reviewHash, publicationIds, changedDefinitions, alreadyApplied: false });
  await client.query(`INSERT INTO inventory.channel_definition_applications
    (channel_id,idempotency_key,request_hash,actor,occurred_at,review,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
  [command.targetChannelId, command.idempotencyKey, requestHash, actor, now.toISOString(), JSON.stringify(review), JSON.stringify(receipt)]);
  return copyResult(receipt, review);
}

function targetScope(row: SourceRuleRow, channelId: number): ChannelExposurePolicyScope {
  if (row.scope_type === "channel") return { scopeType: "channel", channelId };
  if (row.scope_type === "product") return { scopeType: "product", channelId, productId: row.product_id! };
  return { scopeType: "variant", channelId, productId: row.product_id!, productVariantId: row.product_variant_id! };
}

function copyResult(receipt: unknown, review: z.infer<typeof storedCopyReviewSchema>): ChannelRuleCopyResult {
  return channelRuleCopyResultSchema.parse({
    receipt, sourceChannelId: review.sourceChannelId, sourceChannelName: review.sourceChannelName,
    targetChannelName: review.channelName, copiedExceptions: review.copiedExceptions, skippedRules: review.skippedRules,
    changedQuantities: review.changedQuantities, skippedDestinations: review.skippedDestinations, warnings: review.warnings,
  });
}
