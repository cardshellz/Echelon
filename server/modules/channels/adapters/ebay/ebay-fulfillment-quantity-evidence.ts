/** Provider-only evidence for legacy eBay fulfillments which omit quantities. */
export interface EbayWholeOrderFulfillmentSnapshot {
  readonly fulfillmentId: string;
  readonly trackingNumber: string;
  readonly shippedDate: string;
  readonly lines: readonly Readonly<{ lineItemId: string; quantity?: number }>[];
}

export interface EbayProvenFulfillmentLine {
  readonly lineItemId: string;
  readonly quantity: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function positiveQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** An omitted field is not null/zero/invalid data and is never a default of one. */
export function readSingleOmittedQuantityFulfillment(
  response: unknown,
  trackingNumber: string,
  expectedFulfillmentId?: string | null,
): EbayWholeOrderFulfillmentSnapshot | null {
  const body = record(response);
  if (!body || !Array.isArray(body.fulfillments) || body.fulfillments.length !== 1
    || (body.total !== undefined && body.total !== 1)
    || (body.next !== undefined && body.next !== null && body.next !== "")) return null;
  const candidate = record(body.fulfillments[0]);
  if (!candidate || typeof candidate.fulfillmentId !== "string" || !candidate.fulfillmentId.trim()
    || typeof candidate.shipmentTrackingNumber !== "string" || candidate.shipmentTrackingNumber.trim() !== trackingNumber
    || (expectedFulfillmentId != null && candidate.fulfillmentId.trim() !== expectedFulfillmentId)
    || typeof candidate.shippedDate !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(candidate.shippedDate)
    || !Number.isFinite(Date.parse(candidate.shippedDate))
    || !Array.isArray(candidate.lineItems) || candidate.lineItems.length === 0) return null;
  const lines: Array<Readonly<{ lineItemId: string; quantity?: number }>> = [];
  const seen = new Set<string>();
  let omitted = false;
  for (const value of candidate.lineItems) {
    const line = record(value);
    if (!line || typeof line.lineItemId !== "string" || !line.lineItemId.trim()) return null;
    const lineItemId = line.lineItemId.trim();
    if (seen.has(lineItemId)) return null;
    seen.add(lineItemId);
    if (Object.prototype.hasOwnProperty.call(line, "quantity")) {
      if (!positiveQuantity(line.quantity)) return null;
      lines.push(Object.freeze({ lineItemId, quantity: line.quantity }));
    } else {
      omitted = true;
      lines.push(Object.freeze({ lineItemId }));
    }
  }
  if (!omitted) return null;
  return Object.freeze({
    fulfillmentId: candidate.fulfillmentId.trim(), trackingNumber,
    shippedDate: candidate.shippedDate,
    lines: Object.freeze(lines.sort((a, b) => a.lineItemId.localeCompare(b.lineItemId))),
  });
}

/**
 * eBay documents that FULFILLED covers every order line and that the collection
 * returns all fulfillments. A sole complete fulfillment containing exactly all
 * those lines can therefore use the provider order's quantities. This is not a
 * default for omitted fields and cannot establish a partial/split allocation.
 * https://developer.ebay.com/api-docs/sell/static/orders/managing-fulfillments.html
 */
export function proveWholeOrderFulfillmentQuantities(input: {
  readonly order: unknown;
  readonly orderId: string;
  readonly fulfillment: EbayWholeOrderFulfillmentSnapshot;
  readonly expectedFulfillmentHref: string;
}): readonly EbayProvenFulfillmentLine[] | null {
  const order = record(input.order);
  const cancellation = record(order?.cancelStatus);
  if (!order || order.orderId !== input.orderId || order.orderFulfillmentStatus !== "FULFILLED"
    || !cancellation || cancellation.cancelState !== "NONE_REQUESTED"
    || !Array.isArray(cancellation.cancelRequests) || cancellation.cancelRequests.length !== 0
    || !Array.isArray(order.fulfillmentHrefs) || order.fulfillmentHrefs.length !== 1
    || order.fulfillmentHrefs[0] !== input.expectedFulfillmentHref
    || !Array.isArray(order.lineItems) || order.lineItems.length !== input.fulfillment.lines.length) return null;
  const quantities = new Map<string, number>();
  for (const value of order.lineItems) {
    const line = record(value);
    if (!line || typeof line.lineItemId !== "string" || !line.lineItemId.trim()
      || line.lineItemFulfillmentStatus !== "FULFILLED" || !positiveQuantity(line.quantity)) return null;
    const id = line.lineItemId.trim();
    if (quantities.has(id)) return null;
    quantities.set(id, line.quantity);
  }
  const result: EbayProvenFulfillmentLine[] = [];
  for (const line of input.fulfillment.lines) {
    const quantity = quantities.get(line.lineItemId);
    if (quantity === undefined || (line.quantity !== undefined && line.quantity !== quantity)) return null;
    result.push(Object.freeze({ lineItemId: line.lineItemId, quantity }));
  }
  return Object.freeze(result);
}

export function sameWholeOrderFulfillmentSnapshot(
  first: EbayWholeOrderFulfillmentSnapshot,
  second: EbayWholeOrderFulfillmentSnapshot,
): boolean {
  return first.fulfillmentId === second.fulfillmentId
    && first.trackingNumber === second.trackingNumber
    && first.shippedDate === second.shippedDate
    && JSON.stringify(first.lines) === JSON.stringify(second.lines);
}
