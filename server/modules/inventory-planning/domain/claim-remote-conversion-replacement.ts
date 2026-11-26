/**
 * Remote-conversion replacement for a pick in the order's own warehouse.
 *
 * The planner may supply an order line by converting stock in another warehouse.
 * Example (prod, 2026-11-18): LEON order #65758 needed one SHLZ-SEMI-OVR-B200 box,
 * and its claim planned to break a SHLZ-SEMI-OVR-C2000 case held at RTE-19 FLOOR-01.
 * A LEON picker can never execute that operation. When the picker records the
 * finished box from a LEON bin instead (live, or as a missed-pick "Yes" after the
 * box already shipped), the remote conversion is no longer needed. Without this
 * rule the pick rebind found no finished supply to move and failed with
 * CLAIM_RECONCILIATION_SOURCE_SHORTFALL forever. The case stayed reserved at
 * RTE-19 and the shipment's inventory never posted.
 *
 * The scope is deliberately narrow:
 * - Only operations planned in a different warehouse than the pick qualify.
 *   Same-warehouse conversions stay under the inline/queued replenishment policy.
 * - Only untouched, top-level package conversions qualify: nothing executed or
 *   released, no child operation, no build handoff, no produced output, and no
 *   consumed or picked input.
 * - The caller applies this only when the line has no direct finished supply
 *   left at another location (see claim-pick-reconciliation.ts).
 */

/** States with no execution, release or handoff progress. */
const REPLACEABLE_OPERATION_STATES: ReadonlySet<string> = new Set(["pending", "ready"]);

/**
 * Package conversions only. component_build operations belong to assembly work
 * (warehouse.work_items) and are never released from a pick.
 */
const REPLACEABLE_OPERATION_TYPES: ReadonlySet<string> = new Set([
  "break_pack",
  "assemble_pack",
  "directed_conversion",
]);

export interface RemoteConversionInputResource {
  readonly claimedQty: bigint;
  readonly releasedQty: bigint;
  readonly consumedQty: bigint;
  readonly pickedQty: bigint;
}

export interface RemoteConversionCandidate {
  readonly operationKey: string;
  readonly parentOperationKey: string | null;
  readonly warehouseId: number;
  readonly operationType: string;
  readonly status: string;
  readonly destinationVariantId: number;
  readonly plannedExecutions: bigint;
  readonly executedExecutions: bigint;
  readonly releasedExecutions: bigint;
  /** Target units this operation commits to the claim line. Null on legacy rows. */
  readonly committedOutputQty: bigint | null;
  readonly hasChildOperation: boolean;
  readonly hasBuildHandoff: boolean;
  readonly hasProducedResource: boolean;
  readonly inputResources: readonly RemoteConversionInputResource[];
}

export interface RemoteConversionSelection {
  /** Operation keys to release, in deterministic (operation key) order. */
  readonly operationKeys: readonly string[];
  /** Target units the released operations had committed; reserve this many at the pick bin. */
  readonly replacedTargetQty: bigint;
}

/** True when the operation can be released without discarding any physical progress. */
export function isReplaceableRemoteConversion(
  candidate: RemoteConversionCandidate,
  pickWarehouseId: number,
  targetVariantId: number,
  allowSameWarehouse = false,
): boolean {
  if (!allowSameWarehouse && candidate.warehouseId === pickWarehouseId) return false;
  if (!REPLACEABLE_OPERATION_TYPES.has(candidate.operationType)) return false;
  if (!REPLACEABLE_OPERATION_STATES.has(candidate.status)) return false;
  if (candidate.parentOperationKey !== null) return false;
  if (candidate.destinationVariantId !== targetVariantId) return false;
  if (candidate.executedExecutions !== BigInt(0) || candidate.releasedExecutions !== BigInt(0)) return false;
  if (candidate.plannedExecutions <= BigInt(0)) return false;
  if (candidate.committedOutputQty === null || candidate.committedOutputQty <= BigInt(0)) return false;
  if (candidate.hasChildOperation || candidate.hasBuildHandoff || candidate.hasProducedResource) return false;
  if (candidate.inputResources.length === 0) return false;
  return candidate.inputResources.every((resource) =>
    resource.consumedQty === BigInt(0)
    && resource.pickedQty === BigInt(0)
    && resource.releasedQty === BigInt(0)
    && resource.claimedQty > BigInt(0));
}

/**
 * Chooses whole remote operations, in operation-key order, until their committed
 * output covers the pick. An operation cannot be released in part: one case
 * break yields its full output. The caller reserves `replacedTargetQty`
 * (which may exceed the pick) at the pick bin, so the line's supply stays
 * balanced and any extra stays reserved there for this line's next pick.
 * Returns null when the eligible operations cannot cover the pick. The caller
 * then keeps its existing shortfall behavior.
 */
export function selectRemoteConversionsToReplace(input: {
  candidates: readonly RemoteConversionCandidate[];
  pickWarehouseId: number;
  targetVariantId: number;
  requiredQty: bigint;
  allowSameWarehouse?: boolean;
}): RemoteConversionSelection | null {
  if (input.requiredQty <= BigInt(0)) return null;
  const eligible = input.candidates
    .filter((candidate) =>
      isReplaceableRemoteConversion(
        candidate,
        input.pickWarehouseId,
        input.targetVariantId,
        input.allowSameWarehouse === true,
      ))
    .sort((left, right) => left.operationKey.localeCompare(right.operationKey, "en"));
  const operationKeys: string[] = [];
  let replacedTargetQty = BigInt(0);
  for (const candidate of eligible) {
    if (replacedTargetQty >= input.requiredQty) break;
    operationKeys.push(candidate.operationKey);
    replacedTargetQty += candidate.committedOutputQty!;
  }
  if (replacedTargetQty < input.requiredQty) return null;
  return { operationKeys, replacedTargetQty };
}
