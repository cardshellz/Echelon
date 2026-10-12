import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  inventoryEbayPublicationReadinessInputSchema, inventoryEbayPublicationReadinessApplySchema,
  inventoryEbayPublicationReadinessReceiptSchema,
  type InventoryEbayPublicationReadinessInput, type InventoryEbayPublicationReadinessApply,
  type InventoryEbayPublicationReadinessReceipt,
} from "@shared/types/ebay-publication-readiness";
import { InventoryPublicationMembershipError } from "../application/inventory-publication-membership.service";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { PublicationMappingPreparationStore, applyMappingPreparation, reviewMappingPreparation } from "./publication-mapping-preparation.repository";
import { PostgresInventoryChannelExposureAdminStore } from "./inventory-channel-exposure-admin.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import { captureEbayPublicationReadiness, readinessDigest } from "./ebay-publication-readiness.read";

type ConnectionPool = Pick<Pool, "connect">;
const fail = (code: string, message: string): never => { throw new InventoryPublicationMembershipError(code, message); };
const normalize = (raw: unknown): InventoryEbayPublicationReadinessInput => {
  const source = inventoryEbayPublicationReadinessInputSchema.parse(raw);
  return { ...source, variants: [...source.variants].sort((a, b) => a.productVariantId - b.productVariantId) };
};

export async function reviewEbayPublicationReadiness(pool: ConnectionPool, input: InventoryEbayPublicationReadinessInput) {
  const source = normalize(input);
  return new PublicationMappingPreparationStore(pool).transaction(false,
    async client => (await captureEbayPublicationReadiness(client, source, false)).review);
}

/** Preflight is read-only and must run before the first provider mutation.
 * Admission still rechecks canonical quantities immediately around each write. */
export async function assertEbayPublicationReady(pool: ConnectionPool, input: InventoryEbayPublicationReadinessInput): Promise<void> {
  const review = await reviewEbayPublicationReadiness(pool, input);
  if (!review.currentlyReady) fail(review.blockers[0]?.code ?? "EBAY_PUBLICATION_STOCK_REVIEW_REQUIRED",
    review.blockers.map(row => row.message).join(" ") || "Exact stock mappings have not finished automatic preparation. Retry this saved listing request.");
}

/** Normal publication already has durable listing intent and verified provider
 * identities. Prepare its exact mappings automatically; selection, holds, ATP,
 * source/model/policy and provider admission remain with their existing owners. */
export async function ensureEbayPublicationReady(pool: ConnectionPool, input: InventoryEbayPublicationReadinessInput,
  context: { commandKey: string; actor: string; now: Date }): Promise<void> {
  const source = normalize(input), contextHash = readinessDigest(source);
  const previous = await findEbayPublicationReadinessReceipt(pool, { channelId: source.channelId, productId: source.productId,
    commandKey: context.commandKey, actor: context.actor, contextHash });
  if (!previous) {
    const review = await reviewEbayPublicationReadiness(pool, source);
    if (!review.ready) fail(review.blockers[0]?.code ?? "STOCK_MAPPING_NOT_READY", review.blockers.map(row => row.message).join(" "));
    try {
      await withEbayPublicationReadinessApplied(pool, { source, commandKey: context.commandKey, contextHash,
        expectedReviewHash: review.reviewHash }, context.actor, context.now, async () => undefined);
    } catch (error) {
      // Another delivery may finish this exact saved job between our initial
      // receipt read and the fresh stock preview. Its committed source+actor
      // receipt wins even though the internal before/after review hash changed.
      if (!(error instanceof InventoryPublicationMembershipError)
        || !["EBAY_PUBLICATION_STOCK_COMMAND_CONFLICT", "EBAY_PUBLICATION_STOCK_REVIEW_STALE"].includes(error.code)
        || !await findEbayPublicationReadinessReceipt(pool, { channelId: source.channelId, productId: source.productId,
          commandKey: context.commandKey, actor: context.actor, contextHash })) throw error;
    }
  }
  await assertEbayPublicationReady(pool, source);
}

const receiptQuerySchema = z.object({ channelId: z.number().int().positive(), productId: z.number().int().positive(),
  commandKey: z.string().uuid(), actor: z.string().trim().min(1).max(100).optional(),
  expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), contextHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
type ReceiptQuery = z.infer<typeof receiptQuerySchema>;
export class EbayPublicationStockRejectedError extends InventoryPublicationMembershipError {
  readonly definitiveRejected = true;
}
async function findReceipt(client: PoolClient, input: ReceiptQuery): Promise<InventoryEbayPublicationReadinessReceipt | null> {
  const row = (await client.query<{ receipt: unknown }>("SELECT receipt FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1::uuid", [input.commandKey])).rows[0];
  if (!row) {
    const rejected = (await client.query<{ channel_id: number; product_id: number; actor: string; context_hash: string; code: string; message: string }>(
      "SELECT channel_id,product_id,actor,context_hash,code,message FROM inventory.ebay_publication_readiness_rejections WHERE command_key=$1::uuid", [input.commandKey])).rows[0];
    if (!rejected) return null;
    if (rejected.channel_id !== input.channelId || rejected.product_id !== input.productId
      || (input.actor !== undefined && rejected.actor !== input.actor)
      || (input.contextHash !== undefined && rejected.context_hash !== input.contextHash)) {
      fail("EBAY_PUBLICATION_STOCK_COMMAND_CONFLICT", "This command reference belongs to another stock publication review or actor.");
    }
    throw new EbayPublicationStockRejectedError(rejected.code, rejected.message);
  }
  const receipt = inventoryEbayPublicationReadinessReceiptSchema.parse(row.receipt);
  if (receipt.channelId !== input.channelId || receipt.productId !== input.productId
    || (input.actor !== undefined && receipt.appliedBy !== input.actor)
    || (input.expectedReviewHash !== undefined && receipt.reviewHash !== input.expectedReviewHash)
    || (input.contextHash !== undefined && receipt.contextHash !== input.contextHash)) {
    fail("EBAY_PUBLICATION_STOCK_COMMAND_CONFLICT", "This command reference belongs to another stock publication review or actor.");
  }
  return { ...receipt, alreadyApplied: true };
}
export async function findEbayPublicationReadinessReceipt(pool: ConnectionPool, raw: ReceiptQuery) {
  const input = receiptQuerySchema.parse(raw);
  return new PublicationMappingPreparationStore(pool).transaction(false, client => findReceipt(client, input));
}

const rejectionSchema = z.object({ channelId: z.number().int().positive(), productId: z.number().int().positive(), commandKey: z.string().uuid(),
  actor: z.string().trim().min(1).max(100), contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  code: z.enum(["EBAY_PUBLICATION_STOCK_REVIEW_STALE", "EBAY_PUBLICATION_STOCK_REVIEW_BLOCKED", "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED"]),
  message: z.string().trim().min(1).max(1000) }).strict();
/** A definite refusal competes with Apply under the same command lock. Once
 * recorded, a late in-flight Apply cannot commit behind a discarded UUID. */
export async function rejectEbayPublicationReadinessCommand(pool: ConnectionPool, raw: z.infer<typeof rejectionSchema>, nowInput: Date) {
  const input = rejectionSchema.parse(raw), now = z.date().parse(nowInput);
  const result = await new PublicationMappingPreparationStore(pool).transaction("configuration", async client => {
    await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ebay-stock:${input.commandKey}`]);
    const receipt = await findReceipt(client, { channelId: input.channelId, productId: input.productId, commandKey: input.commandKey,
      actor: input.actor, contextHash: input.contextHash });
    if (receipt) return receipt;
    await client.query(`INSERT INTO inventory.ebay_publication_readiness_rejections(command_key,channel_id,product_id,actor,context_hash,code,message,occurred_at)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8)`, [input.commandKey, input.channelId, input.productId, input.actor, input.contextHash, input.code, input.message, now]);
    return null;
  });
  if (result) return result;
  throw new EbayPublicationStockRejectedError(input.code, input.message);
}

/** Inventory fence first, then target/configuration locks, then provider scope
 * session locks. followUp must only perform transactional local work; when it
 * needs the listing workflow lock it must TRY it and roll back if busy. The
 * inventory changes, immutable receipt, and saved publication job commit once. */
export async function withEbayPublicationReadinessApplied<T>(pool: ConnectionPool,
  raw: InventoryEbayPublicationReadinessApply, actorInput: string, nowInput: Date,
  followUp: (client: PoolClient, receipt: InventoryEbayPublicationReadinessReceipt) => Promise<T>,
  beforeCapture?: (client: PoolClient) => Promise<void>): Promise<{ receipt: InventoryEbayPublicationReadinessReceipt; result: T }> {
  const parsed = inventoryEbayPublicationReadinessApplySchema.parse(raw);
  const input = { ...parsed, source: normalize(parsed.source) };
  const actor = z.string().trim().min(1).max(100).parse(actorInput), now = z.date().parse(nowInput);
  const requestHash = readinessDigest({ input, actor });
  const preparation = new PublicationMappingPreparationStore(pool);
  return preparation.transaction("configuration", async (client, scopeKeys) => {
    await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ebay-stock:${input.commandKey}`]);
    const previous = await findReceipt(client, { channelId: input.source.channelId, productId: input.source.productId,
      commandKey: input.commandKey, actor, expectedReviewHash: input.expectedReviewHash, contextHash: input.contextHash });
    if (previous) {
      const row = (await client.query<{ request_hash: string }>("SELECT request_hash FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1::uuid", [input.commandKey])).rows[0];
      if (row?.request_hash !== requestHash) fail("EBAY_PUBLICATION_STOCK_COMMAND_CONFLICT", "This command reference belongs to another stock publication source.");
      return { receipt: previous, result: await followUp(client, previous) };
    }
    // Canonical publication registration takes account locks before catalog
    // locks. The composed channel owner reserves that prefix here, after the
    // inventory fence and before capture takes OAuth/catalog/listing row locks.
    await beforeCapture?.(client);
    const evidence = await captureEbayPublicationReadiness(client, input.source, true);
    if (evidence.review.reviewHash !== input.expectedReviewHash) fail("EBAY_PUBLICATION_STOCK_REVIEW_STALE", "Stock, mappings, or publication settings changed. Review the current plan again.");
    if (!evidence.review.ready || !evidence.target) fail("EBAY_PUBLICATION_STOCK_REVIEW_BLOCKED", evidence.review.blockers.map(row => row.message).join(" "));
    const target = evidence.target!;
    const definitions = new PostgresInventoryChannelExposureAdminStore();
    const selectors = [];
    for (const variant of evidence.review.variants) {
      const row = evidence.rows.find(candidate => candidate.id === variant.productVariantId)!;
      if (variant.mappingAction === "create") {
        const saved = await definitions.saveVariantMappingDraftInsideTransaction(drizzle(client), {
          publicationTargetId: target.id, productVariantId: variant.productVariantId,
          externalInventoryItemId: variant.sku, externalSku: variant.sku,
          expectedHeadRevision: row.head_revision ?? "0", expectedDraftMappingId: null, expectedDraftDefinitionHash: null,
          changeReason: "Reviewed exact eBay SKU stock enrollment before publication.",
          idempotencyKey: `ebay-stock:${input.commandKey}:${variant.productVariantId}`,
          requestHash, actorId: actor, occurredAt: now,
        });
        selectors.push({ kind: "variant_mapping" as const, key: `${target.id}:${variant.productVariantId}`,
          definitionId: saved.definitionId, definitionHash: saved.definitionHash });
      } else if (variant.mappingAction === "promote_draft") selectors.push({ kind: "variant_mapping" as const,
        key: `${target.id}:${variant.productVariantId}`, definitionId: row.mapping_id!, definitionHash: row.mapping_hash! });
    }
    if (selectors.length) await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
      contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [], publicationTargetIds: [target.id], selections: selectors,
    }, { actor, reason: "Reviewed exact eBay SKU stock enrollment before publication.", occurredAt: now });
    const promoted = await captureEbayPublicationReadiness(client, input.source, true);
    if (!promoted.review.ready) fail("EBAY_PUBLICATION_STOCK_REVIEW_BLOCKED", promoted.review.blockers.map(row => row.message).join(" "));
    const command = { publicationTargetId: target.id, expectedTargetRevision: target.revision, productId: input.source.productId,
      productVariantIds: input.source.variants.map(row => row.productVariantId) };
    const reviewed = (await reviewMappingPreparation(client, command, true)).review;
    const applied = await applyMappingPreparation(client, scopeKeys, { ...command, expectedReviewHash: reviewed.reviewHash,
      idempotencyKey: `ebay-stock:${input.commandKey}` }, actor, requestHash, now,
      evidence.review.variants.filter(row => row.mappingAction !== "none").map(row => row.productVariantId));
    const receipt = inventoryEbayPublicationReadinessReceiptSchema.parse({ channelId: input.source.channelId,
      productId: input.source.productId, commandKey: input.commandKey, reviewHash: input.expectedReviewHash,
      contextHash: input.contextHash, appliedAt: now.toISOString(), appliedBy: actor, mappingPreparation: applied, alreadyApplied: false });
    await client.query(`INSERT INTO inventory.ebay_publication_readiness_applications(command_key,channel_id,product_id,request_hash,actor,occurred_at,source,review,receipt)
      VALUES($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)`, [input.commandKey, input.source.channelId, input.source.productId,
      requestHash, actor, now, JSON.stringify(input.source), JSON.stringify(evidence.review), JSON.stringify(receipt)]);
    await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
      VALUES($1,'AUDIT',$2,'inventory_availability.ebay_publication_stock.enrolled',$3,$4::jsonb,$5::jsonb)`,
    [now, actor, `inventory.inventory_publication_target:${target.id}`, JSON.stringify({ before: evidence.review, after: receipt }),
      JSON.stringify({ commandKey: input.commandKey, requestHash })]);
    return { receipt, result: await followUp(client, receipt) };
  });
}
