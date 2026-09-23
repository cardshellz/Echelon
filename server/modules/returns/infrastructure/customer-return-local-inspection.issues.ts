import type { CustomerReturnLocalInspectionIssue, CustomerReturnLocalInspectionSnapshot } from "../application/customer-return-local-inspection.ports";

type Source = Omit<CustomerReturnLocalInspectionSnapshot, "observedAt" | "issues">;

/** Missing optional projections are not a denial of authenticated Shopify
 * delivery. Only contradictory local identities or retained claims create issues. */
export function deriveLocalInspectionIssues(source: Source): CustomerReturnLocalInspectionIssue[] {
  const issues = new Map<string, CustomerReturnLocalInspectionIssue>();
  const lines = new Map(source.lines.map(line => [line.omsOrderLineId, line]));
  const items = new Map(source.wmsItems.map(item => [item.wmsOrderItemId, item]));
  function add(code: CustomerReturnLocalInspectionIssue["code"], lineId: number | null): void {
    const omsOrderLineId = lineId !== null && lines.has(lineId) ? lineId : null;
    issues.set(`${code}:${omsOrderLineId}`, { code, omsOrderLineId });
  }
  const externalIds = new Map<string, number>();
  for (const line of source.lines) {
    if (line.externalLineItemId === null) { add("purchased_line_identity_missing", line.omsOrderLineId); continue; }
    const key = purchasedLineIdentity(line.externalLineItemId);
    const existing = externalIds.get(key);
    if (existing !== undefined) {
      add("purchased_line_identity_conflict", existing);
      add("purchased_line_identity_conflict", line.omsOrderLineId);
    }
    externalIds.set(key, line.omsOrderLineId);
  }
  for (const item of source.wmsItems) {
    const line = item.omsOrderLineId === null ? undefined : lines.get(item.omsOrderLineId);
    if (!line || (item.channelId !== null && item.channelId !== source.shop.channelId)
      || (item.omsOrderReference !== null && item.omsOrderReference !== String(source.order.omsOrderId))
      || (item.omsOrderReference === null && item.legacyOrderReference !== null
        && item.legacyOrderReference !== String(source.order.omsOrderId))
      || (item.externalOrderId !== null && orderIdentity(item.externalOrderId) !== orderIdentity(source.order.externalOrderId))
      || (item.externalLineItemId !== null && line.externalLineItemId !== null
        && purchasedLineIdentity(item.externalLineItemId) !== purchasedLineIdentity(line.externalLineItemId))) {
      add("wms_identity_conflict", item.omsOrderLineId);
    }
  }
  const claimedByLine = new Map<number, number>();
  const claimedByItem = new Map<number, number>();
  for (const claim of source.rootClaims) {
    const line = lines.get(claim.omsOrderLineId);
    const item = items.get(claim.wmsOrderItemId);
    if (!line || !item || claim.channelId !== source.shop.channelId || claim.omsOrderId !== source.order.omsOrderId
      || item.omsOrderLineId !== claim.omsOrderLineId || line.externalLineItemId === null
      || purchasedLineIdentity(claim.externalLineItemId) !== purchasedLineIdentity(line.externalLineItemId)) {
      add("local_claim_identity_conflict", claim.omsOrderLineId);
    }
    claimedByLine.set(claim.omsOrderLineId, (claimedByLine.get(claim.omsOrderLineId) ?? 0) + claim.quantity);
    claimedByItem.set(claim.wmsOrderItemId, (claimedByItem.get(claim.wmsOrderItemId) ?? 0) + claim.quantity);
  }
  for (const claim of source.legacyClaims) {
    const item = claim.wmsOrderItemId === null ? undefined : items.get(claim.wmsOrderItemId);
    const lineId = claim.omsOrderLineId ?? item?.omsOrderLineId ?? null;
    const line = lineId === null ? undefined : lines.get(lineId);
    if (!item || !line || item.wmsOrderId !== claim.wmsOrderId || item.omsOrderLineId !== lineId
      || (claim.externalLineItemId !== null && line.externalLineItemId !== null
        && purchasedLineIdentity(claim.externalLineItemId) !== purchasedLineIdentity(line.externalLineItemId))) {
      add("local_claim_identity_conflict", lineId);
      // A contradictory explicit OMS line must not mask the item's actual line.
      if (item?.omsOrderLineId !== lineId) add("local_claim_identity_conflict", item?.omsOrderLineId ?? null);
    }
    if (claim.receivedQuantity > claim.expectedQuantity) add("local_claim_quantity_conflict", lineId);
    if (claim.expectedQuantity > 0 || claim.receivedQuantity > 0) add("legacy_claim_allocation_unknown", lineId);
    // There is no root-to-child claim link yet. Do not invent deduplication or a
    // numeric aggregate by adding these possibly mirrored legacy quantities.
  }
  for (const [lineId, quantity] of claimedByLine) {
    if (!Number.isSafeInteger(quantity) || quantity > (lines.get(lineId)?.quantity ?? 0)) add("local_claim_quantity_conflict", lineId);
  }
  if (source.unallocatedReturns.length > 0) add("unallocated_return_evidence", null);
  for (const evidence of source.inventoryReturnEvidence) {
    const item = evidence.wmsOrderItemId === null ? undefined : items.get(evidence.wmsOrderItemId);
    add("inventory_return_correlation_unknown", item?.omsOrderLineId ?? null);
    if (item && evidence.wmsOrderId !== null && item.wmsOrderId !== evidence.wmsOrderId) {
      add("local_claim_identity_conflict", null);
    }
  }
  for (const [itemId, quantity] of claimedByItem) {
    const item = items.get(itemId);
    if (!Number.isSafeInteger(quantity) || quantity > (item?.fulfilledQuantity ?? 0)) add("local_claim_quantity_conflict", item?.omsOrderLineId ?? null);
  }
  return [...issues.values()];
}

function purchasedLineIdentity(value: string): string { return /^gid:\/\/shopify\/LineItem\/(\d+)$/.exec(value)?.[1] ?? value; }
function orderIdentity(value: string): string { return /^gid:\/\/shopify\/Order\/(\d+)$/.exec(value)?.[1] ?? value; }
