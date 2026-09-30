import type { ClaimPlanDto } from "@shared/types/inventory-availability-planner";

const MAX_INLINE_CLAIM_OPERATIONS = 1000;

export class ClaimPickCaseBreakError extends Error {
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ClaimPickCaseBreakError";
  }
}

/** Select only the missing finished units, in prerequisite-first execution order.
 * An ATP promise is not permission to auto-assemble a build or move another
 * warehouse's stock. Existing finished stock is used before opening another case.
 */
export function selectClaimPickCaseBreaks(input: {
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
    throw new ClaimPickCaseBreakError("CLAIM_PICK_OPERATION_GRAPH_INVALID", "The claim conversion graph is not unique and bounded.", {});
  }
  const selected: ClaimPlanDto["operations"] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (operation: ClaimPlanDto["operations"][number]): void => {
    if (visited.has(operation.operationKey) || input.states.get(operation.operationKey) === "completed") return;
    if (visiting.has(operation.operationKey)) {
      throw new ClaimPickCaseBreakError("CLAIM_PICK_OPERATION_GRAPH_INVALID", "The claim conversion graph contains a cycle.", { operationKey: operation.operationKey });
    }
    if (operation.operationType !== "break_pack" || operation.warehouseId !== input.warehouseId || operation.outputLocationId === null
      || !["pending", "ready"].includes(input.states.get(operation.operationKey) ?? "")) {
      throw new ClaimPickCaseBreakError("CLAIM_PICK_OPERATION_REQUIRES_WORK",
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
    && operation.operationType === "break_pack" && operation.destinationVariantId === input.targetVariantId
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
