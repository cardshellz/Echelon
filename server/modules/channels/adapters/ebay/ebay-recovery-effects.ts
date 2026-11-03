import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { RetainedPublicationEffectEvidence, ReconciliationContentVerification } from "../../../inventory-planning/domain/publication-recovery-evidence";
import { syncIdentityHash, type EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import { buildEbayQuantityUpdateRequest } from "./ebay-quantity-update";

/** eBay's bulk endpoint also accepts prices. A request is stock-only only when
 * its retained hash proves the complete, single-offer quantity-only body. */
export function proveEbayStockOnlyEffects(input: {
  effects: readonly RetainedPublicationEffectEvidence[];
  identity: EbayListingSyncIdentity;
  checkedAt: Date;
}): ReconciliationContentVerification | null {
  if (!input.effects.length || input.effects.length > 250) return null;
  const proof: NonNullable<ReconciliationContentVerification["proof"]> = [];
  for (const effect of input.effects) {
    if (effect.ownerKind !== "outbox" || effect.requestCount !== 1 || effect.method !== "POST"
      || effect.path !== "/sell/inventory/v1/bulk_update_price_quantity"
      || !effect.requestHash || !/^[a-f0-9]{64}$/.test(effect.requestHash)
      || !effect.desiredQuantity || !/^(0|[1-9][0-9]*)$/.test(effect.desiredQuantity)
      || !effect.inventoryItemId || effect.productVariantId === null
      || effect.connectionId !== input.identity.connectionId || effect.accountId !== input.identity.accountId) return null;
    const quantity = Number(effect.desiredQuantity);
    if (!Number.isSafeInteger(quantity)) return null;
    const member = input.identity.variants.find(variant => variant.variantId === effect.productVariantId);
    if (!member?.offerId || member.sku !== effect.inventoryItemId) return null;
    const body = buildEbayQuantityUpdateRequest([{ sku: effect.inventoryItemId, offerId: member.offerId, quantity }]);
    if (createHash("sha256").update(canonicalJson(body)).digest("hex") !== effect.requestHash) return null;
    proof.push({ attemptId: effect.attemptId, productVariantId: effect.productVariantId, inventoryItemId: effect.inventoryItemId,
      providerResourceId: member.offerId, desiredQuantity: effect.desiredQuantity, requestHash: effect.requestHash });
  }
  return { kind: "stock_only", checkedAt: input.checkedAt,
    evidenceHash: createHash("sha256").update(canonicalJson(proof)).digest("hex"),
    identityHash: syncIdentityHash(input.identity), proof };
}
