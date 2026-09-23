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
  unallocatedRefund: boolean;
  reconciledRefundQuantity: number;
}

/** Reconcile source claims by purchased/fulfillment identity, never SKU or tracking. */
export function readCustomerReturnLiveClaims(
  local: CustomerReturnLocalInspectionSnapshot, provider: CustomerReturnShopifySnapshot,
): Map<string, CustomerReturnLiveLineClaims> {
  // The local reader explicitly identifies unquantified history. A zero would
  // misrepresent it, so do not publish an availability projection in that case.
  if (local.issues.some(issue => issue.omsOrderLineId === null)) returnEvidenceUnresolved();
  const result = new Map<string, CustomerReturnLiveLineClaims>(provider.lines.map(line => [line.id, {
    claims: [] as Claim[], returningQuantity: 0, unresolved: false, unallocatedRefund: false, reconciledRefundQuantity: 0,
  }]));
  const unresolved = (lineId: string): void => {
    const target = result.get(lineId);
    if (!target) returnEvidenceUnresolved();
    target.unresolved = true;
    target.claims = [];
    target.returningQuantity = null;
    target.reconciledRefundQuantity = 0;
  };
  for (const issue of local.issues) {
    const line = local.lines.find(candidate => candidate.omsOrderLineId === issue.omsOrderLineId);
    if (!line?.externalLineItemId) returnEvidenceUnresolved();
    unresolved(gid("LineItem", line.externalLineItemId));
  }
  const activeReturns = provider.returns.filter(ret => !["CANCELED", "DECLINED"].includes(ret.status));
  const allocations = new Map(provider.fulfillments.flatMap(fulfillment => fulfillment.lines.map(line => [
    line.id, { fulfillmentId: fulfillment.id, lineItemId: line.lineItemId, quantity: line.quantity },
  ] as const)));
  const append = (lineId: string, claim: Claim, isReturn: boolean): void => {
    const target = result.get(lineId);
    if (!target) returnEvidenceUnresolved();
    if (target.unresolved) return;
    target.claims.push(claim);
    if (isReturn) target.returningQuantity = (target.returningQuantity ?? 0) + claim.quantity;
  };
  for (const ret of activeReturns) {
    for (const line of ret.lines) {
      if (line.quantity === 0) continue;
      const allocation = allocations.get(line.fulfillmentLineItemId);
      if (!allocation || allocation.lineItemId !== line.lineItemId) returnEvidenceUnresolved();
      append(line.lineItemId, { claimId: line.id, allocationId: line.fulfillmentLineItemId, quantity: line.quantity }, true);
    }
  }
  for (const claim of local.rootClaims) {
    const lineId = gid("LineItem", claim.externalLineItemId);
    const allocationId = gid("FulfillmentLineItem", claim.fulfillmentLineItemId);
    const allocation = allocations.get(allocationId);
    if (!allocation || allocation.lineItemId !== lineId || allocation.fulfillmentId !== gid("Fulfillment", claim.fulfillmentId)
      || claim.omsOrderId !== local.order.omsOrderId || claim.channelId !== local.shop.channelId
      || !local.lines.some(line => line.omsOrderLineId === claim.omsOrderLineId
        && line.externalLineItemId !== null && gid("LineItem", line.externalLineItemId) === lineId)) returnEvidenceUnresolved();
    // There is no root-to-native-return correlation key yet. Identical quantities
    // are not proof that two records describe either the same or different units.
    if (activeReturns.some(ret => ret.lines.some(line => line.fulfillmentLineItemId === allocationId && line.quantity > 0))) {
      unresolved(lineId); continue;
    }
    append(lineId, { claimId: `local-root:${claim.claimId}`, allocationId, quantity: claim.quantity }, true);
  }
  for (const claim of local.legacyClaims) {
    const quantity = Math.max(claim.expectedQuantity, claim.receivedQuantity);
    if (quantity === 0) continue;
    if (!claim.externalLineItemId || claim.omsOrderLineId === null) returnEvidenceUnresolved();
    const lineId = gid("LineItem", claim.externalLineItemId);
    const existing = result.get(lineId);
    // Legacy children may mirror a root, provider return or refund. No additive
    // count is safe without a durable correlation; retain that as an exception.
    if (!existing || existing.claims.length > 0 || provider.refunds.some(refund => refund.lines.some(line => line.lineItemId === lineId && line.quantity > 0))) {
      unresolved(lineId); continue;
    }
    append(lineId, { claimId: `legacy-return-item:${claim.returnItemId}`, allocationId: null, quantity }, true);
  }
  for (const refund of provider.refunds) {
    const linkedReturn = activeReturns.find(ret => ret.id === refund.returnId);
    for (const [index, line] of refund.lines.entries()) {
      if (line.quantity === 0 || result.get(line.lineItemId)?.unresolved) continue;
      if (linkedReturn) {
        const returned = linkedReturn.lines.filter(item => item.lineItemId === line.lineItemId)
          .reduce((total, item) => total + item.quantity, 0);
        const refunded = provider.refunds.filter(item => item.returnId === linkedReturn.id)
          .flatMap(item => item.lines).filter(item => item.lineItemId === line.lineItemId)
          .reduce((total, item) => total + item.quantity, 0);
        const reported = linkedReturn.lines.filter(item => item.lineItemId === line.lineItemId)
          .reduce((total, item) => total + item.refundedQuantity, 0);
        if (refunded > returned || refunded !== reported) { unresolved(line.lineItemId); continue; }
        result.get(line.lineItemId)!.reconciledRefundQuantity += line.quantity;
        continue; // These units are already fully encumbered by their exact native return.
      }
      const target = result.get(line.lineItemId);
      if (!target) returnEvidenceUnresolved();
      if (target.returningQuantity !== 0) { unresolved(line.lineItemId); continue; }
      target.unallocatedRefund = true;
      target.reconciledRefundQuantity += line.quantity;
      append(line.lineItemId, { claimId: `refund:${refund.id}:${index}`, allocationId: null, quantity: line.quantity }, false);
    }
  }
  for (const line of provider.lines) {
    const target = result.get(line.id)!;
    if (target.unresolved) continue;
    const total = target.claims.reduce((sum, claim) => sum + claim.quantity, 0);
    if (!Number.isSafeInteger(total) || total > line.quantity || !Number.isSafeInteger(target.returningQuantity)) {
      unresolved(line.id); continue;
    }
    for (const allocationId of new Set(target.claims.map(claim => claim.allocationId))) {
      if (allocationId === null) continue;
      const claimed = target.claims.filter(claim => claim.allocationId === allocationId).reduce((sum, claim) => sum + claim.quantity, 0);
      if (!Number.isSafeInteger(claimed) || claimed > (allocations.get(allocationId)?.quantity ?? 0)) unresolved(line.id);
    }
  }
  return result;
}
