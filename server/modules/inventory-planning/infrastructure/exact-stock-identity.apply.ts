import type { PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PublicationMappingPreparationReceipt } from "@shared/types/inventory-publication-mapping-preparation";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../domain/stock-link-errors";
import { PostgresInventoryChannelExposureAdminStore } from "./inventory-channel-exposure-admin.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import { applyMappingPreparation, reviewMappingPreparation, type MappingPreparationTarget } from "./publication-mapping-preparation.repository";
import { retireStockLinkMappingsInsideTransaction, type StockLinkRetiredMapping, type StockLinkRetireMember } from "./stock-link-retire";

export type MappingPreparationReview = Awaited<ReturnType<typeof reviewMappingPreparation>>["review"];

/** A pending draft as the locked capture read it: promote_draft seals it; replace_draft overwrites it in place,
 * guarded by its definition hash (the draft writer's stale check). */
export interface ExactStockIdentityDraft {
  mappingId: number;
  definitionHash: string;
}

/** One reviewed member and what its capture decided. The item and store SKU are the exact provider identity the
 * draft writer saves; nothing here derives one from another (eBay's item id is its SKU, Shopify's is the decimal
 * InventoryItem id). */
export type ExactStockIdentityMember =
  | { productVariantId: number; mappingAction: "none" }
  | { productVariantId: number; mappingAction: "create"; externalInventoryItemId: string; externalSku: string | null;
      /** The head revision the capture read; "0" when the size has no head yet. */
      expectedHeadRevision: string }
  | { productVariantId: number; mappingAction: "promote_draft"; draft: ExactStockIdentityDraft }
  | { productVariantId: number; mappingAction: "replace_draft"; externalInventoryItemId: string; externalSku: string | null;
      expectedHeadRevision: string; draft: ExactStockIdentityDraft };

export interface ExactStockIdentityApplyInput {
  target: MappingPreparationTarget;
  members: readonly ExactStockIdentityMember[];
  productId: number;
  allowRetainedZero: boolean;
  /** Emit publication only for the reviewed members (single-variant listings, one size at a time). */
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
 * The one financial write sequence for an exact stock identity, generalised from the exact eBay SKU core (channels
 * PR2, PLAN-CH2 v4.1 §4.1, P-5): create, promote or replace exact mapping drafts, seal them, confirm the promoted
 * state, then let the canonical mapping-preparation owner replan and enqueue quantities with its receipt and audit
 * row. The caller owns the transaction, the inventory cutover fence, its command lock and its own receipt; no
 * provider I/O happens here. For eBay members (create / promote_draft / none) the statements, keys and order are
 * exactly the ones applyExactEbaySkuMappingsInsideTransaction ran before it became a wrapper over this function.
 */
export async function applyExactStockIdentityInsideTransaction(client: PoolClient, scopeKeys: string[],
  input: ExactStockIdentityApplyInput): Promise<PublicationMappingPreparationReceipt> {
  const { target } = input;
  const definitions = new PostgresInventoryChannelExposureAdminStore();
  const selectors = [];
  for (const member of input.members) {
    if (member.mappingAction === "create" || member.mappingAction === "replace_draft") {
      const draft = member.mappingAction === "replace_draft" ? member.draft : null;
      const saved = await definitions.saveVariantMappingDraftInsideTransaction(drizzle(client), {
        publicationTargetId: target.id, productVariantId: member.productVariantId,
        externalInventoryItemId: member.externalInventoryItemId, externalSku: member.externalSku,
        expectedHeadRevision: member.expectedHeadRevision,
        expectedDraftMappingId: draft?.mappingId ?? null, expectedDraftDefinitionHash: draft?.definitionHash ?? null,
        changeReason: input.changeReason,
        idempotencyKey: `${input.idempotencyPrefix}:${input.commandKey}:${member.productVariantId}`,
        requestHash: input.requestHash, actorId: input.actor, occurredAt: input.now,
      }, { allowRetainedZero: input.allowRetainedZero });
      selectors.push({ kind: "variant_mapping" as const, key: `${target.id}:${member.productVariantId}`,
        definitionId: saved.definitionId, definitionHash: saved.definitionHash });
    } else if (member.mappingAction === "promote_draft") selectors.push({ kind: "variant_mapping" as const,
      key: `${target.id}:${member.productVariantId}`, definitionId: member.draft.mappingId, definitionHash: member.draft.definitionHash });
  }
  if (selectors.length) await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
    contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [], publicationTargetIds: [target.id], selections: selectors,
  }, { actor: input.actor, reason: input.changeReason, occurredAt: input.now });
  await input.afterPromotion(client);
  const command = { publicationTargetId: target.id, expectedTargetRevision: target.revision, productId: input.productId,
    productVariantIds: input.members.map(row => row.productVariantId), allowRetainedZero: input.allowRetainedZero,
    ...(input.verifiedListingScopeHash ? { verifiedListingScopeHash: input.verifiedListingScopeHash } : {}) };
  const reviewed = (await reviewMappingPreparation(client, command, true)).review;
  input.assertReviewReady?.(reviewed);
  return applyMappingPreparation(client, scopeKeys, { ...command, exactVariantScope: input.exactVariantScope,
    expectedReviewHash: reviewed.reviewHash, idempotencyKey: `${input.idempotencyPrefix}:${input.commandKey}` },
  input.actor, input.requestHash, input.now,
  input.members.filter(row => row.mappingAction !== "none").map(row => row.productVariantId));
}

export interface StockIdentityChangeInput {
  publicationTargetId: number;
  actor: string;
  /** The injected clock; the link's own `now` must be the same instant. */
  now: Date;
  /** §4.3 step 7: sealed links this command retires (the decision's replacesMappingId per member). */
  retire: readonly StockLinkRetireMember[];
  retireReason: string;
  /** §4.3 step 8: the exact-identity apply for the linking members; null for a retire-only command. */
  link: ExactStockIdentityApplyInput | null;
}

export interface StockIdentityChangeResult {
  retired: StockLinkRetiredMapping[];
  preparation: PublicationMappingPreparationReceipt | null;
}

/**
 * Steps 7 and 8 of one stock-link command (PLAN-CH2 v4.1 §4.3), in that order, in the caller's transaction:
 * retire first, so a store item that moves between two sizes of one product (a swap) or back to the same size is
 * free when the draft writer checks it (its identity conflict check reads COALESCE(draft, active) of every other
 * head), and so a relinked size's new version takes the retired one as predecessor (§4.4). A linking member that
 * was retired in the same command was decided on the head revision before the retire; the retire moved it by one,
 * so its draft expects the retire's revision. Retire-only commands enqueue nothing: there is no item to send to.
 */
export async function applyStockIdentityChangeInsideTransaction(client: PoolClient, scopeKeys: string[],
  input: StockIdentityChangeInput): Promise<StockIdentityChangeResult> {
  if (input.retire.length === 0 && input.link === null)
    throw stateInvalid("A stock-link command must retire or link at least one size.", {});
  if (input.link && (input.link.target.id !== input.publicationTargetId || input.link.actor !== input.actor
    || input.link.now.getTime() !== input.now.getTime()))
    throw stateInvalid("A stock-link command's retire and link must name one destination, actor and time.",
      { publicationTargetId: input.publicationTargetId, linkTargetId: input.link.target.id });
  const decidedRevision = new Map(input.retire.map(row => [row.productVariantId, row.expectedHeadRevision]));
  for (const member of input.link?.members ?? []) {
    const decided = decidedRevision.get(member.productVariantId);
    if (decided === undefined) continue;
    // A retire-only size is not reviewed for publication (it has no item to send to), so it never appears here.
    if (member.mappingAction === "none")
      throw stateInvalid("A retired size in the link step must be relinked.", { productVariantId: member.productVariantId });
    if (member.mappingAction !== "promote_draft" && member.expectedHeadRevision !== decided)
      throw stateInvalid("A relinked size was decided on two different head revisions.", { productVariantId: member.productVariantId });
  }
  const retired = input.retire.length === 0 ? [] : await retireStockLinkMappingsInsideTransaction(client, {
    publicationTargetId: input.publicationTargetId, members: input.retire, actor: input.actor,
    reason: input.retireReason, now: input.now,
  });
  if (!input.link) return { retired, preparation: null };
  const retiredByVariant = new Map(retired.map(row => [row.productVariantId, row]));
  // The sealer re-reads the head and guards on the revision it read, so a promoted draft expects nothing; a new or
  // replaced draft expects the revision the retire left.
  const members = input.link.members.map(member => {
    const after = retiredByVariant.get(member.productVariantId);
    return after && (member.mappingAction === "create" || member.mappingAction === "replace_draft")
      ? { ...member, expectedHeadRevision: after.headRevision } : member;
  });
  const preparation = await applyExactStockIdentityInsideTransaction(client, scopeKeys, { ...input.link, members });
  return { retired, preparation };
}

function stateInvalid(message: string, context: Record<string, unknown>): StockLinkError {
  return new StockLinkError(STOCK_LINK_ERROR_CODES.stateInvalid, message, context);
}
