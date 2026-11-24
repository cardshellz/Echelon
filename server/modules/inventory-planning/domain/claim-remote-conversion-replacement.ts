/**
 * Remote-conversion replacement: a pick of finished units makes a planned
 * conversion unnecessary.
 *
 * The planner may supply an order line by converting stock instead of reserving
 * finished units, for example by breaking a case. When the picker then takes
 * finished units from a bin, that planned conversion is no longer needed. Without
 * this rule the pick rebind found no finished supply to move and failed with
 * CLAIM_RECONCILIATION_SOURCE_SHORTFALL forever, so the case stayed reserved and
 * the shipment's inventory never posted.
 *
 * "Remote" means remote from the scanned bin. Two prod shapes:
 * - Another warehouse (2026-11-18): LEON order #65758 needed one
 *   SHLZ-SEMI-OVR-B200 box. Its claim planned to break a SHLZ-SEMI-OVR-C2000 case
 *   held at RTE-19 FLOOR-01, which a LEON picker can never do.
 * - The order's own warehouse with no output bin: LEON order #65282 needed two
 *   SHLZ-TOP-75PT-BLU-P25 packs. Its claim planned to break a
 *   SHLZ-TOP-75PT-BLU-C800 case at LEON FLOOR with no output bin. A pick runs a
 *   case break only into the scanned bin, so this one could never run at pick.
 *   The order line records the finished packs as taken from A-03.
 *
 * The scope is deliberately narrow:
 * - A conversion in the pick warehouse whose output bin is the scanned bin is
 *   never replaced. The pick's own case-break policy governs it: the conversion
 *   either runs inline or requires queued replenishment
 *   (materializePickPackageConversions runs before any rebind).
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

/** Where the replaced conversion was planned, relative to the pick. Recorded in the audit event. */
export type RemoteConversionScope = "other_warehouse" | "same_warehouse";

/** The bin the picker took finished units from. */
export interface RemoteConversionPick {
  readonly warehouseId: number;
  readonly warehouseLocationId: number;
}

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
  /** Bin the conversion's output would land in. Null when the plan named none. */
  readonly outputLocationId: number | null;
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

export function remoteConversionScope(
  candidate: Pick<RemoteConversionCandidate, "warehouseId">,
  pick: RemoteConversionPick,
): RemoteConversionScope {
  return candidate.warehouseId === pick.warehouseId ? "same_warehouse" : "other_warehouse";
}

/** True when the operation can be released without discarding any physical progress. */
export function isReplaceableRemoteConversion(
  candidate: RemoteConversionCandidate,
  pick: RemoteConversionPick,
  targetVariantId: number,
): boolean {
  if (candidate.warehouseId === pick.warehouseId && candidate.outputLocationId === pick.warehouseLocationId) {
    return false;
  }
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
  pick: RemoteConversionPick;
  targetVariantId: number;
  requiredQty: bigint;
}): RemoteConversionSelection | null {
  if (input.requiredQty <= BigInt(0)) return null;
  const eligible = input.candidates
    .filter((candidate) => isReplaceableRemoteConversion(candidate, input.pick, input.targetVariantId))
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
