import type { CustomerReturnEligibilityInput } from "../domain/customer-return-eligibility";
import type { CustomerReturnLocalInspectionSnapshot } from "./customer-return-local-inspection.ports";
import type { CustomerReturnShopifySnapshot } from "./customer-return-shopify-snapshot.ports";
import { returnEvidenceUnresolved } from "./customer-return-live-error";
import { customerReturnProviderGid as gid } from "./customer-return-live-identity";

type Claim = CustomerReturnEligibilityInput["order"]["lines"][number]["claims"][number];
export interface CustomerReturnLiveLineClaims {
  claims: Claim[];
  returningQuantity: number | null;
  unresolved: boolean;
}

/** Physical purchase claims only. Refunds and missing outbound projections do
 * not consume units. Portal children were already removed by the local reader. */
export function readPurchasedCustomerReturnClaims(
  local: CustomerReturnLocalInspectionSnapshot, provider: CustomerReturnShopifySnapshot,
): Map<string, CustomerReturnLiveLineClaims> {
  const result = new Map<string, CustomerReturnLiveLineClaims>(provider.lines.map(line => [line.id, {
    claims: [], returningQuantity: 0, unresolved: false,
  }]));
  const append = (lineId: string, claimId: string, quantity: number): void => {
    const target = result.get(lineId);
    if (!target) returnEvidenceUnresolved();
    target.claims.push({ claimId, allocationId: null, quantity });
    target.returningQuantity = (target.returningQuantity ?? 0) + quantity;
  };
  for (const returned of provider.returns) {
    if (["CANCELED", "DECLINED"].includes(returned.status)) continue;
    for (const line of returned.lines) if (line.quantity > 0) append(line.lineItemId, `shopify-return:${line.id}`, line.quantity);
  }
  for (const claim of local.rootClaims) {
    const lineId = gid("LineItem", claim.externalLineItemId);
    if (claim.channelId !== local.shop.channelId || claim.omsOrderId !== local.order.omsOrderId
      || !local.lines.some(line => line.omsOrderLineId === claim.omsOrderLineId
        && line.externalLineItemId !== null && gid("LineItem", line.externalLineItemId) === lineId)) returnEvidenceUnresolved();
    append(lineId, `local-root:${claim.claimId}`, claim.quantity);
  }
  // Count exact historical physical claims by purchased line, regardless of the
  // original package/fulfillment. Never join duplicate SKU lines to each other.
  for (const claim of local.legacyClaims) {
    const item = local.wmsItems.find(item => item.wmsOrderItemId === claim.wmsOrderItemId);
    const localLine = local.lines.find(line => line.omsOrderLineId === (claim.omsOrderLineId ?? item?.omsOrderLineId));
    const nativeId = claim.externalLineItemId ?? localLine?.externalLineItemId;
    const quantity = Math.max(claim.expectedQuantity, claim.receivedQuantity);
    if (nativeId && localLine?.externalLineItemId
      && gid("LineItem", nativeId) === gid("LineItem", localLine.externalLineItemId) && quantity > 0) append(gid("LineItem", nativeId), `legacy-return-item:${claim.returnItemId}`, quantity);
  }
  // Direct legacy physical returns can exist only in the Inventory journal.
  // Proven portal mirrors are excluded by the reader, so they are not counted twice.
  for (const evidence of local.inventoryReturnEvidence) {
    const item = local.wmsItems.find(item => item.wmsOrderItemId === evidence.wmsOrderItemId
      && item.wmsOrderId === evidence.wmsOrderId);
    const line = local.lines.find(line => line.omsOrderLineId === item?.omsOrderLineId);
    if (!item || !line?.externalLineItemId || evidence.quantityDelta <= 0
      || (item.externalLineItemId !== null && gid("LineItem", item.externalLineItemId) !== gid("LineItem", line.externalLineItemId))) continue;
    append(gid("LineItem", line.externalLineItemId), `inventory-return:${evidence.transactionId}`, evidence.quantityDelta);
  }
  for (const line of provider.lines) {
    const target = result.get(line.id)!;
    const quantity = target.returningQuantity!;
    if (!Number.isSafeInteger(quantity) || quantity > line.quantity) {
      target.unresolved = true; target.returningQuantity = null; target.claims = [];
    }
  }
  return result;
}
