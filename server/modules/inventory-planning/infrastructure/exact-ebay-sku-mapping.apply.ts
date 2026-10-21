import type { PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PublicationMappingPreparationReceipt } from "@shared/types/inventory-publication-mapping-preparation";
import type { EbayPublicationMappingRow } from "../domain/ebay-publication-readiness";
import { PostgresInventoryChannelExposureAdminStore } from "./inventory-channel-exposure-admin.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import { applyMappingPreparation, reviewMappingPreparation, type MappingPreparationTarget } from "./publication-mapping-preparation.repository";

export type MappingPreparationReview = Awaited<ReturnType<typeof reviewMappingPreparation>>["review"];

export interface ExactEbaySkuMappingApplyInput {
  target: MappingPreparationTarget;
  /** The reviewed members and the action the capture decided for each. */
  variants: ReadonlyArray<{ productVariantId: number; sku: string; mappingAction: "none" | "promote_draft" | "create" }>;
  /** Mapping rows read by the same locked capture (one per member). */
  rows: readonly EbayPublicationMappingRow[];
  productId: number;
  allowRetainedZero: boolean;
  /** Emit publication only for the reviewed members (single-variant listings). */
  exactVariantScope: boolean;
  verifiedListingScopeHash?: string;
  /** Namespaces every draft and preparation idempotency key. */
  idempotencyPrefix: string;
  commandKey: string;
  requestHash: string;
  actor: string;
  now: Date;
  changeReason: string;
  /** Runs after the drafts are sealed and before the canonical quantity review;
   * it must throw (rolling everything back) if the promoted state is not usable. */
  afterPromotion: (client: PoolClient) => Promise<void>;
  /** Optional typed refusal when the post-promotion review is not ready.
   * Without it, applyMappingPreparation refuses with STOCK_MAPPING_NOT_READY. */
  assertReviewReady?: (review: MappingPreparationReview) => void;
}

/**
 * The one financial write sequence for an exact eBay SKU stock link, shared by
 * the channel readiness writer and the Dropship store readiness writer:
 * create/promote exact SKU mapping drafts, seal them, confirm the promoted
 * state, then let the canonical mapping-preparation owner replan and enqueue
 * quantities with its receipt and audit row. The caller owns the transaction,
 * the inventory cutover fence, its command lock and its own receipt; no
 * provider I/O happens here. Extracted unchanged from
 * withEbayPublicationReadinessApplied (channel behavior is pinned by its suites).
 */
export async function applyExactEbaySkuMappingsInsideTransaction(client: PoolClient, scopeKeys: string[],
  input: ExactEbaySkuMappingApplyInput): Promise<PublicationMappingPreparationReceipt> {
  const { target } = input;
  const definitions = new PostgresInventoryChannelExposureAdminStore();
  const selectors = [];
  for (const variant of input.variants) {
    const row = input.rows.find(candidate => candidate.id === variant.productVariantId)!;
    if (variant.mappingAction === "create") {
      const saved = await definitions.saveVariantMappingDraftInsideTransaction(drizzle(client), {
        publicationTargetId: target.id, productVariantId: variant.productVariantId,
        externalInventoryItemId: variant.sku, externalSku: variant.sku,
        expectedHeadRevision: row.head_revision ?? "0", expectedDraftMappingId: null, expectedDraftDefinitionHash: null,
        changeReason: input.changeReason,
        idempotencyKey: `${input.idempotencyPrefix}:${input.commandKey}:${variant.productVariantId}`,
        requestHash: input.requestHash, actorId: input.actor, occurredAt: input.now,
      }, { allowRetainedZero: input.allowRetainedZero });
      selectors.push({ kind: "variant_mapping" as const, key: `${target.id}:${variant.productVariantId}`,
        definitionId: saved.definitionId, definitionHash: saved.definitionHash });
    } else if (variant.mappingAction === "promote_draft") selectors.push({ kind: "variant_mapping" as const,
      key: `${target.id}:${variant.productVariantId}`, definitionId: row.mapping_id!, definitionHash: row.mapping_hash! });
  }
  if (selectors.length) await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
    contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [], publicationTargetIds: [target.id], selections: selectors,
  }, { actor: input.actor, reason: input.changeReason, occurredAt: input.now });
  await input.afterPromotion(client);
  const command = { publicationTargetId: target.id, expectedTargetRevision: target.revision, productId: input.productId,
    productVariantIds: input.variants.map(row => row.productVariantId), allowRetainedZero: input.allowRetainedZero,
    ...(input.verifiedListingScopeHash ? { verifiedListingScopeHash: input.verifiedListingScopeHash } : {}) };
  const reviewed = (await reviewMappingPreparation(client, command, true)).review;
  input.assertReviewReady?.(reviewed);
  return applyMappingPreparation(client, scopeKeys, { ...command, exactVariantScope: input.exactVariantScope,
    expectedReviewHash: reviewed.reviewHash, idempotencyKey: `${input.idempotencyPrefix}:${input.commandKey}` },
  input.actor, input.requestHash, input.now,
  input.variants.filter(row => row.mappingAction !== "none").map(row => row.productVariantId));
}
