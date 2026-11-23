import { describe, expect, it } from "vitest";
import {
  isReplaceableRemoteConversion,
  selectRemoteConversionsToReplace,
  type RemoteConversionCandidate,
} from "../../domain/claim-remote-conversion-replacement";

const PICK_WAREHOUSE = 1;
const REMOTE_WAREHOUSE = 2;
const TARGET_VARIANT = 173;

// Shape of prod order #65758: one B200 box planned as a C2000 case break at RTE-19.
const candidate = (overrides: Partial<RemoteConversionCandidate> = {}): RemoteConversionCandidate => ({
  operationKey: "order-item:328460:warehouse:2:path:418:operation:1",
  parentOperationKey: null,
  warehouseId: REMOTE_WAREHOUSE,
  operationType: "break_pack",
  status: "pending",
  destinationVariantId: TARGET_VARIANT,
  plannedExecutions: BigInt(1),
  executedExecutions: BigInt(0),
  releasedExecutions: BigInt(0),
  committedOutputQty: BigInt(1),
  hasChildOperation: false,
  hasBuildHandoff: false,
  hasProducedResource: false,
  inputResources: [{ claimedQty: BigInt(1), releasedQty: BigInt(0), consumedQty: BigInt(0), pickedQty: BigInt(0) }],
  ...overrides,
});

const select = (candidates: RemoteConversionCandidate[], requiredQty: bigint) =>
  selectRemoteConversionsToReplace({ candidates, pickWarehouseId: PICK_WAREHOUSE, targetVariantId: TARGET_VARIANT, requiredQty });

describe("remote-conversion replacement eligibility", () => {
  it("accepts an untouched top-level package conversion planned in another warehouse", () => {
    expect(isReplaceableRemoteConversion(candidate(), PICK_WAREHOUSE, TARGET_VARIANT)).toBe(true);
    expect(isReplaceableRemoteConversion(candidate({ status: "ready" }), PICK_WAREHOUSE, TARGET_VARIANT)).toBe(true);
    for (const operationType of ["assemble_pack", "directed_conversion"]) {
      expect(isReplaceableRemoteConversion(candidate({ operationType }), PICK_WAREHOUSE, TARGET_VARIANT)).toBe(true);
    }
  });

  it.each<[string, Partial<RemoteConversionCandidate>]>([
    ["same-warehouse work stays under replenishment policy", { warehouseId: PICK_WAREHOUSE }],
    ["assembly builds belong to warehouse work", { operationType: "component_build" }],
    ["executing work is owned elsewhere", { status: "executing" }],
    ["completed work already produced stock", { status: "completed" }],
    ["released work is already gone", { status: "released" }],
    ["failed work needs review", { status: "failed" }],
    ["nested operations are not unwound", { parentOperationKey: "order-item:1:parent" }],
    ["an operation for another variant", { destinationVariantId: 999 }],
    ["partly executed", { executedExecutions: BigInt(1), plannedExecutions: BigInt(2) }],
    ["partly released", { releasedExecutions: BigInt(1), plannedExecutions: BigInt(2) }],
    ["legacy rows without committed output", { committedOutputQty: null }],
    ["has a child prerequisite", { hasChildOperation: true }],
    ["has a build handoff", { hasBuildHandoff: true }],
    ["already produced output", { hasProducedResource: true }],
    ["has no claimed input", { inputResources: [] }],
    ["an input was consumed", { inputResources: [{ claimedQty: BigInt(1), releasedQty: BigInt(0), consumedQty: BigInt(1), pickedQty: BigInt(0) }] }],
    ["an input was picked", { inputResources: [{ claimedQty: BigInt(1), releasedQty: BigInt(0), consumedQty: BigInt(0), pickedQty: BigInt(1) }] }],
    ["an input was partly released", { inputResources: [{ claimedQty: BigInt(2), releasedQty: BigInt(1), consumedQty: BigInt(0), pickedQty: BigInt(0) }] }],
  ])("rejects %s", (_label, override) => {
    expect(isReplaceableRemoteConversion(candidate(override), PICK_WAREHOUSE, TARGET_VARIANT)).toBe(false);
  });
});

describe("remote-conversion replacement selection", () => {
  it("replaces the case break behind a one-box missed pick (#65758)", () => {
    expect(select([candidate()], BigInt(1))).toEqual({
      operationKeys: ["order-item:328460:warehouse:2:path:418:operation:1"],
      replacedTargetQty: BigInt(1),
    });
  });

  it("releases a whole operation even when its committed output exceeds the pick", () => {
    // One case commits four boxes to the line; picking two still releases the case,
    // and all four boxes are reserved at the pick bin for this line.
    expect(select([candidate({ committedOutputQty: BigInt(4) })], BigInt(2)))
      .toEqual({ operationKeys: [candidate().operationKey], replacedTargetQty: BigInt(4) });
  });

  it("takes operations in key order and stops once the pick is covered", () => {
    const candidates = [
      candidate({ operationKey: "op-c", committedOutputQty: BigInt(2) }),
      candidate({ operationKey: "op-a", committedOutputQty: BigInt(1) }),
      candidate({ operationKey: "op-b", committedOutputQty: BigInt(1) }),
    ];
    expect(select(candidates, BigInt(2))).toEqual({ operationKeys: ["op-a", "op-b"], replacedTargetQty: BigInt(2) });
  });

  it("ignores ineligible operations and returns null when eligible ones cannot cover the pick", () => {
    const candidates = [
      candidate({ operationKey: "remote", committedOutputQty: BigInt(1) }),
      candidate({ operationKey: "local", warehouseId: PICK_WAREHOUSE, committedOutputQty: BigInt(5) }),
    ];
    expect(select(candidates, BigInt(2))).toBeNull();
    expect(select(candidates, BigInt(1))).toEqual({ operationKeys: ["remote"], replacedTargetQty: BigInt(1) });
  });

  it("returns null for an empty or non-positive request", () => {
    expect(select([], BigInt(1))).toBeNull();
    expect(select([candidate()], BigInt(0))).toBeNull();
  });
});
