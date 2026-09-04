export type ReplenishmentExecutionMethod = "case_break" | "direct_transfer";

export type ReplenishmentExecutionPlan = {
  method: ReplenishmentExecutionMethod;
  sourceVariantId: number;
  pickVariantId: number;
  qtySourceUnits: number;
  qtyPickUnits: number;
  movedBaseUnits: number;
};

export class ReplenishmentExecutionDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ReplenishmentExecutionDomainError";
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ReplenishmentExecutionDomainError(
      "INVALID_REPLENISHMENT_EXECUTION_INPUT",
      `${field} must be a positive safe integer.`,
      { field, value },
    );
  }
  return Number(value);
}

function safeProduct(value: unknown, field: string): number {
  return positiveInteger(value, field);
}

function safeMultiply(left: number, right: number, field: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ReplenishmentExecutionDomainError(
      "REPLENISHMENT_QUANTITY_OVERFLOW",
      `${field} exceeds the supported safe-integer range.`,
      { field, left, right },
    );
  }
  return result;
}

/**
 * Freezes the physical movement implied by a persisted replenishment task.
 * `qtyTargetUnits` is the task's base-unit audit quantity, not the number of
 * destination SKU units produced by a case break.
 */
export function planReplenishmentExecution(input: {
  replenMethod: string;
  sourceVariantId: number;
  sourceProductId: number | null;
  sourceUnitsPerVariant: number;
  pickVariantId: number;
  pickProductId: number | null;
  pickUnitsPerVariant: number;
  qtySourceUnits: number;
  qtyTargetUnits: number;
}): ReplenishmentExecutionPlan {
  const sourceVariantId = positiveInteger(input.sourceVariantId, "sourceVariantId");
  const pickVariantId = positiveInteger(input.pickVariantId, "pickVariantId");
  const sourceUnitsPerVariant = positiveInteger(input.sourceUnitsPerVariant, "sourceUnitsPerVariant");
  const pickUnitsPerVariant = positiveInteger(input.pickUnitsPerVariant, "pickUnitsPerVariant");
  const qtySourceUnits = positiveInteger(input.qtySourceUnits, "qtySourceUnits");
  const qtyTargetUnits = positiveInteger(input.qtyTargetUnits, "qtyTargetUnits");
  const movedBaseUnits = safeMultiply(qtySourceUnits, sourceUnitsPerVariant, "movedBaseUnits");

  if (qtyTargetUnits !== movedBaseUnits) {
    throw new ReplenishmentExecutionDomainError(
      "REPLENISHMENT_TASK_QUANTITY_MISMATCH",
      "The replenishment task's target quantity does not equal its source quantity in base units.",
      { qtySourceUnits, sourceUnitsPerVariant, qtyTargetUnits, movedBaseUnits },
    );
  }

  if (input.replenMethod !== "case_break") {
    if (sourceVariantId !== pickVariantId) {
      throw new ReplenishmentExecutionDomainError(
        "REPLENISHMENT_TRANSFER_VARIANT_MISMATCH",
        "A non-conversion replenishment must move the same variant into the pick location.",
        { replenMethod: input.replenMethod, sourceVariantId, pickVariantId },
      );
    }
    return {
      method: "direct_transfer",
      sourceVariantId,
      pickVariantId,
      qtySourceUnits,
      qtyPickUnits: qtySourceUnits,
      movedBaseUnits,
    };
  }

  const sourceProductId = safeProduct(input.sourceProductId, "sourceProductId");
  const pickProductId = safeProduct(input.pickProductId, "pickProductId");
  if (sourceProductId !== pickProductId) {
    throw new ReplenishmentExecutionDomainError(
      "REPLENISHMENT_CASE_BREAK_PRODUCT_MISMATCH",
      "Case-break replenishment must convert variants of the same product.",
      { sourceProductId, pickProductId, sourceVariantId, pickVariantId },
    );
  }
  if (sourceVariantId === pickVariantId
    || sourceUnitsPerVariant <= pickUnitsPerVariant
    || sourceUnitsPerVariant % pickUnitsPerVariant !== 0) {
    throw new ReplenishmentExecutionDomainError(
      "INVALID_REPLENISHMENT_CASE_BREAK",
      "Case-break replenishment requires a larger source variant that divides exactly into the pick variant.",
      { sourceVariantId, pickVariantId, sourceUnitsPerVariant, pickUnitsPerVariant },
    );
  }

  const qtyPickUnits = movedBaseUnits / pickUnitsPerVariant;
  if (!Number.isSafeInteger(qtyPickUnits) || qtyPickUnits <= 0) {
    throw new ReplenishmentExecutionDomainError(
      "INVALID_REPLENISHMENT_CASE_BREAK_OUTPUT",
      "Case-break replenishment did not produce an exact positive pick-unit quantity.",
      { movedBaseUnits, pickUnitsPerVariant },
    );
  }

  return {
    method: "case_break",
    sourceVariantId,
    pickVariantId,
    qtySourceUnits,
    qtyPickUnits,
    movedBaseUnits,
  };
}
