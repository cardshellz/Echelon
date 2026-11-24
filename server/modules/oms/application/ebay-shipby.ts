type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseShipByDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function collectShipByDate(candidates: Date[], value: unknown): void {
  const date = parseShipByDate(value);
  if (date) candidates.push(date);
}

/**
 * eBay can provide the promised ship-by date at different levels depending on
 * API shape/version. Use the earliest valid date as the order-level deadline:
 * missing any line-level promise is still an SLA miss for the order.
 */
export function extractEbayShipByDate(payload: unknown): Date | null {
  const root = asRecord(payload);
  if (!root) return null;

  const candidates: Date[] = [];

  for (const instruction of asArray(root.fulfillmentStartInstructions)) {
    const instructionRecord = asRecord(instruction);
    if (!instructionRecord) continue;

    collectShipByDate(candidates, instructionRecord.shipByDate);

    const shippingStep = asRecord(instructionRecord.shippingStep);
    if (shippingStep) {
      collectShipByDate(candidates, shippingStep.shipByDate);
    }
  }

  for (const lineItem of asArray(root.lineItems)) {
    const lineItemRecord = asRecord(lineItem);
    const fulfillmentInstructions = asRecord(lineItemRecord?.lineItemFulfillmentInstructions);
    if (!fulfillmentInstructions) continue;

    collectShipByDate(candidates, fulfillmentInstructions.shipByDate);
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, candidate) =>
    candidate.getTime() < earliest.getTime() ? candidate : earliest,
  );
}
