import type { ClaimPlanDto } from "@shared/types/inventory-availability-planner";

const MAX_INLINE_CLAIM_OPERATIONS = 1000;

export class ClaimPickPackageConversionError extends Error {
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ClaimPickPackageConversionError";
  }
}

/** Select only missing finished units, in prerequisite-first execution order.
 * Packaging operations still require transactional inline-policy approval before
 * execution. A component build always requires its separate work handoff.
 */
export function selectClaimPickPackageConversions(input: {
  operations: ClaimPlanDto["operations"];
  states: ReadonlyMap<string, string>;
  orderItemId: number;
  targetVariantId: number;
  warehouseId: number;
  locationId: number;
  readyQty: bigint;
  pickQty: bigint;
}): ClaimPlanDto["operations"] {
  if (input.readyQty >= input.pickQty) return [];
  const operations = input.operations.filter(operation => operation.lineKey === `order-item:${input.orderItemId}`);
  const keys = new Set(operations.map(operation => operation.operationKey));
  if (keys.size !== operations.length || operations.length > MAX_INLINE_CLAIM_OPERATIONS) {
    throw new ClaimPickPackageConversionError("CLAIM_PICK_OPERATION_GRAPH_INVALID", "The claim conversion graph is not unique and bounded.", {});
  }
  const selected: ClaimPlanDto["operations"] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (operation: ClaimPlanDto["operations"][number]): void => {
    if (visited.has(operation.operationKey) || input.states.get(operation.operationKey) === "completed") return;
    if (visiting.has(operation.operationKey)) {
      throw new ClaimPickPackageConversionError("CLAIM_PICK_OPERATION_GRAPH_INVALID", "The claim conversion graph contains a cycle.", { operationKey: operation.operationKey });
    }
    if (operation.operationType === "component_build" || operation.warehouseId !== input.warehouseId || operation.outputLocationId === null
      || !["pending", "ready"].includes(input.states.get(operation.operationKey) ?? "")) {
      throw new ClaimPickPackageConversionError("CLAIM_PICK_OPERATION_REQUIRES_WORK",
        "This pick requires warehouse work before its finished stock can be picked.", { operationKey: operation.operationKey });
    }
    visiting.add(operation.operationKey);
    for (const child of operations.filter(candidate => candidate.parentOperationKey === operation.operationKey)
      .sort((left, right) => left.operationKey.localeCompare(right.operationKey, "en"))) visit(child);
    visiting.delete(operation.operationKey);
    visited.add(operation.operationKey);
    selected.push(operation);
  };
  let ready = input.readyQty;
  const roots = operations.filter(operation => operation.parentOperationKey === null
    && operation.destinationVariantId === input.targetVariantId
    && operation.warehouseId === input.warehouseId && operation.outputLocationId === input.locationId
    && input.states.get(operation.operationKey) !== "completed")
    .sort((left, right) => left.operationKey.localeCompare(right.operationKey, "en"));
  for (const root of roots) {
    if (ready >= input.pickQty) break;
    visit(root);
    ready += BigInt(root.committedOutputQty);
  }
  return selected;
}

export interface ClaimPickPackagingPath {
  id: number;
  operationType: string;
  sourceVariantId: number;
  destinationVariantId: number;
  sourceProductId: number;
  destinationProductId: number;
  inputQty: number;
  outputQty: number;
  sourceUnitsPerVariant: number;
  destinationUnitsPerVariant: number;
  authorityState: string;
  validationState: string;
}

/** Directed conversions may carry recipe authority, including non-conserving
 * transformations. Inline picking permits only exact same-product repackaging,
 * proved from the immutable path referenced by the claim, never from the SKU
 * name or current catalog pack size. Other transformations remain explicit work.
 */
export function isClaimPickRepackaging(
  operation: ClaimPlanDto["operations"][number],
  path: ClaimPickPackagingPath | null,
): boolean {
  if (!path || operation.operationType === "component_build"
    || path.authorityState !== "allowed" || path.validationState !== "valid"
    || path.id !== operation.authorityId || path.operationType !== operation.operationType
    || path.destinationVariantId !== operation.destinationVariantId
    || path.sourceProductId !== path.destinationProductId
    || operation.inputs.length !== 1 || operation.sourceVariantIds.length !== 1
    || operation.inputs[0].sourceVariantId !== path.sourceVariantId
    || operation.sourceVariantIds[0] !== path.sourceVariantId) return false;
  const positiveIntegers = [path.id, path.sourceVariantId, path.destinationVariantId,
    path.sourceProductId, path.destinationProductId, path.inputQty, path.outputQty,
    path.sourceUnitsPerVariant, path.destinationUnitsPerVariant];
  if (positiveIntegers.some(value => !Number.isSafeInteger(value) || value <= 0)
    || path.sourceVariantId === path.destinationVariantId) return false;
  const executions = BigInt(operation.plannedExecutions);
  return executions > BigInt(0)
    && BigInt(path.inputQty) * executions === BigInt(operation.inputs[0].requiredQty)
    && BigInt(path.outputQty) * executions === BigInt(operation.outputQty)
    && BigInt(path.inputQty) * BigInt(path.sourceUnitsPerVariant)
      === BigInt(path.outputQty) * BigInt(path.destinationUnitsPerVariant);
}
