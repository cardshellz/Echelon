import { MAX_RECEIVING_CUSTODY_QUANTITY } from "@shared/procurement/receiving-quarantine";

export class ReceivingQuarantineError extends Error {
  readonly details: Readonly<Record<string, unknown>>;
  constructor(public readonly code: string, message: string, public readonly statusCode = 409,
    public readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "ReceivingQuarantineError";
    this.details = { ...context, code };
  }
}

export interface ReceivingCustodyBalance {
  readonly observedQty: number;
  readonly awaitingReceiptQty: number;
  readonly receivedQty: number;
  readonly returnedQty: number;
  readonly version: number;
}

export function custodyQuantities(balance: ReceivingCustodyBalance): {
  unallocatedQty: number; physicalHeldQty: number;
} {
  for (const field of ["observedQty", "awaitingReceiptQty", "receivedQty", "returnedQty", "version"] as const) {
    const value = balance[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RECEIVING_CUSTODY_QUANTITY) {
      throw new ReceivingQuarantineError("RECEIVING_CUSTODY_EVIDENCE_INVALID", "Quarantine quantity evidence is invalid.", 409, { field });
    }
  }
  const physicalHeldQty = balance.observedQty - balance.receivedQty - balance.returnedQty;
  const unallocatedQty = physicalHeldQty - balance.awaitingReceiptQty;
  if (balance.observedQty === 0 || unallocatedQty < 0) {
    throw new ReceivingQuarantineError("RECEIVING_CUSTODY_EVIDENCE_INVALID", "Quarantine dispositions exceed the recorded custody.");
  }
  return { unallocatedQty, physicalHeldQty };
}

export function assertCustodyResolution(balance: ReceivingCustodyBalance, expectedVersion: number, quantity: number): void {
  const { unallocatedQty } = custodyQuantities(balance);
  if (expectedVersion !== balance.version) {
    throw new ReceivingQuarantineError("RECEIVING_CUSTODY_STALE", "Quarantine changed. Refresh and review its current quantities before resolving it.");
  }
  if (balance.version === MAX_RECEIVING_CUSTODY_QUANTITY) {
    throw new ReceivingQuarantineError("RECEIVING_CUSTODY_VERSION_EXHAUSTED", "Quarantine version limit reached. Contact an administrator.");
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > unallocatedQty) {
    throw new ReceivingQuarantineError("RECEIVING_CUSTODY_QUANTITY_UNAVAILABLE", "Resolve only the quantity still available in quarantine. Cancel a pending acceptance before returning those goods.", 409, { unallocatedQty });
  }
}

export function assertReviewedCustodyConversion(input: {
  observedProductId: number | null; observedUnitsPerVariant: number | null; observationQty: number;
  targetProductId: number; targetUnitsPerVariant: number; acceptedVariantQty: number;
}): void {
  if (input.observedProductId !== null && input.observedProductId !== input.targetProductId) {
    throw new ReceivingQuarantineError("RECEIVING_CUSTODY_PRODUCT_MISMATCH", "The selected product does not match the goods recorded in quarantine.");
  }
  for (const value of [input.observationQty, input.targetProductId, input.targetUnitsPerVariant, input.acceptedVariantQty,
    ...(input.observedProductId === null ? [] : [input.observedProductId]),
    ...(input.observedUnitsPerVariant === null ? [] : [input.observedUnitsPerVariant])]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_RECEIVING_CUSTODY_QUANTITY) {
      throw new ReceivingQuarantineError("RECEIVING_CUSTODY_UNITS_INVALID", "Custody and accepted units must be positive whole numbers within the supported range.", 400);
    }
  }
  const acceptedBase = BigInt(input.targetUnitsPerVariant) * BigInt(input.acceptedVariantQty);
  if (acceptedBase <= BigInt(0) || acceptedBase > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ReceivingQuarantineError("RECEIVING_CUSTODY_UNIT_OVERFLOW", "The accepted quantity exceeds the supported piece count.", 400);
  }
  if (input.observedUnitsPerVariant !== null
    && BigInt(input.observedUnitsPerVariant) * BigInt(input.observationQty) !== acceptedBase) {
    throw new ReceivingQuarantineError("RECEIVING_CUSTODY_UNIT_MISMATCH", "The reviewed receive units must preserve the exact piece count recorded in quarantine.");
  }
}
