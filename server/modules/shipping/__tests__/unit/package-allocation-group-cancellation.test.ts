import { describe, expect, it } from "vitest";

import {
  PackageAllocationGroupError,
  packageAllocationGroupPlannerInputSchema,
  planPackageAllocationGroup,
  type PackageAllocationGroupAction,
  type PackageAllocationGroupPackageInput,
  type PackageAllocationGroupPlannerInput,
} from "../../package-allocation-group.domain";
import type { DeclaredPackageLifecycleEvent } from "../../declared-package-lifecycle.domain";

const groupKey = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";
const wmsShipmentItemId = 7001;
const labelObservedAt = "2026-08-21T14:00:00.000Z";
const labelProviderOccurredAt = "2026-08-21T13:59:50.000Z";
const voidObservedAt = "2026-08-21T14:05:01.000Z";
const voidProviderOccurredAt = "2026-08-21T14:05:00.000Z";
const carrierObservedAt = "2026-08-21T14:10:01.000Z";
const carrierProviderOccurredAt = "2026-08-21T14:10:00.000Z";

type CancellationAction = Extract<
  PackageAllocationGroupAction,
  { readonly kind: "cancel_awaiting_allocation" }
>;
type TransferAction = Extract<
  PackageAllocationGroupAction,
  { readonly kind: "transfer_awaiting_allocation" }
>;

interface LifecycleOptions {
  readonly voided?: boolean;
  readonly carrierPossession?: boolean;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function packageInput(
  packageKey: string,
  providerPhysicalShipmentId: string,
  quantity: number,
  allocationRole: PackageAllocationGroupPackageInput["allocationRole"],
  options: LifecycleOptions = {},
): PackageAllocationGroupPackageInput {
  const trackingNumber = `1Z${providerPhysicalShipmentId.padStart(16, "0")}`;
  const events: DeclaredPackageLifecycleEvent[] = [{
    kind: "outbound_label_observed",
    eventKey: `shipstation:${providerPhysicalShipmentId}:observed`,
    observedAt: labelObservedAt,
    providerOccurredAt: labelProviderOccurredAt,
    trackingNumber,
    contentsEvidence: {
      status: "authoritative",
      lines: [{ wmsShipmentItemId, quantity }],
    },
  }];
  if (options.voided) {
    events.push({
      kind: "outbound_label_voided",
      eventKey: `shipstation:${providerPhysicalShipmentId}:voided`,
      observedAt: voidObservedAt,
      providerOccurredAt: voidProviderOccurredAt,
    });
  }
  if (options.carrierPossession) {
    events.push({
      kind: "carrier_possession_confirmed",
      eventKey: `carrier:${providerPhysicalShipmentId}:accepted`,
      observedAt: carrierObservedAt,
      providerOccurredAt: carrierProviderOccurredAt,
      carrierTrackingEventId: Number(providerPhysicalShipmentId) + 90_000,
    });
  }
  return {
    packageKey,
    allocationRole,
    membership: {
      status: "proven",
      evidenceKey: `membership:${packageKey}`,
    },
    lifecycle: {
      provider: "shipstation",
      providerPhysicalShipmentId,
      events,
    },
  };
}

function cancellation(
  overrides: Partial<CancellationAction> = {},
): CancellationAction {
  return {
    kind: "cancel_awaiting_allocation",
    actionKey: "cancellation:A:7001:1",
    fromPackageKey: "A",
    wmsShipmentItemId,
    quantity: 4,
    authorization: {
      kind: "lead_approved",
      actor: "shipping-lead:51",
      reason: "Customer-approved exact fulfillment-line cancellation",
    },
    ...overrides,
  } as CancellationAction;
}

function transfer(
  overrides: Partial<TransferAction> = {},
): TransferAction {
  return {
    kind: "transfer_awaiting_allocation",
    actionKey: "transfer:A:B:7001:1",
    fromPackageKey: "A",
    targets: [{
      packageKey: "B",
      wmsShipmentItemId,
      quantity: 4,
    }],
    authorization: {
      kind: "lead_approved",
      actor: "shipping-lead:51",
      reason: "Approved exact replacement transfer",
    },
    ...overrides,
  } as TransferAction;
}

function plannerInput(
  packages: readonly PackageAllocationGroupPackageInput[],
  actions: readonly PackageAllocationGroupAction[] = [],
  overrides: Partial<PackageAllocationGroupPlannerInput> = {},
): PackageAllocationGroupPlannerInput {
  return {
    contractVersion: 1,
    authorityMode: "shadow_only",
    groupKey,
    expectedGroupVersion: 0,
    previousPlan: null,
    sourceLines: [{
      wmsShipmentItemId,
      sourceQuantity: 4,
      physicalConsumptionAuthorityQuantity: 4,
      authorityVersion: 1,
    }],
    packages,
    actions,
    ...overrides,
  };
}

function previousPlanFrom(result: ReturnType<typeof planPackageAllocationGroup>) {
  return {
    groupKey: result.groupKey,
    groupVersion: result.proposedGroupVersion,
    stateHash: result.stateHash,
    actionEvidence: result.state.actionEvidence,
    appliedActionKeys: result.state.appliedActionKeys,
    packageEvidence: result.state.packageEvidence,
    sourceEvidence: result.state.sourceEvidence,
    effectIntentEvidence: result.state.effectIntentEvidence,
  };
}

function allocationShapes(result: ReturnType<typeof planPackageAllocationGroup>) {
  return result.state.allocations
    .map((entry) => ({
      targetKind: entry.targetKind,
      packageKey: entry.packageKey,
      quantity: entry.quantity,
    }))
    .sort((left, right) => (
      compareText(left.targetKind, right.targetKind)
      || compareText(String(left.packageKey), String(right.packageKey))
      || left.quantity - right.quantity
    ));
}

describe("package allocation exact cancellation", () => {
  it("moves a full exact awaiting-relabel allocation to held-for-unpack without new effects", () => {
    const packages = [
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ];
    const baseline = planPackageAllocationGroup(plannerInput(packages));
    const action = cancellation();
    const result = planPackageAllocationGroup(plannerInput(packages, [action], {
      expectedGroupVersion: baseline.proposedGroupVersion,
      previousPlan: previousPlanFrom(baseline),
    }));

    expect(result.outcome).toBe("proposed");
    expect(allocationShapes(result)).toEqual([{
      targetKind: "held_for_unpack",
      packageKey: null,
      quantity: 4,
    }]);
    expect(result.state.appliedActionKeys).toEqual([action.actionKey]);
    expect(result.state.reviews).toEqual([]);
    expect(result.state.desiredEffectIntents).toEqual(
      baseline.state.desiredEffectIntents,
    );
    expect(result.effectIntentsToAppend).toEqual([]);
    expect(result.state.actionEvidence).toMatchObject([{
      actionKey: action.actionKey,
      action: {
        kind: "cancel_awaiting_allocation",
        wmsShipmentItemId,
        quantity: 4,
        authorization: action.authorization,
      },
    }]);
  });

  it("moves only a partial exact quantity and conserves the remaining awaiting allocation", () => {
    const action = cancellation({ quantity: 2 });
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ], [action]));

    expect(allocationShapes(result)).toEqual([
      {
        targetKind: "awaiting_relabel",
        packageKey: null,
        quantity: 2,
      },
      {
        targetKind: "held_for_unpack",
        packageKey: null,
        quantity: 2,
      },
    ]);
    expect(result.state.appliedActionKeys).toEqual([action.actionKey]);
    expect(result.state.reviews).toEqual([]);
    expect(result.state.allocations.reduce(
      (total, entry) => total + entry.quantity,
      0,
    )).toBe(4);
  });

  it("replays the exact cancellation idempotently and retains its audit evidence", () => {
    const packages = [
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ];
    const action = cancellation();
    const before = planPackageAllocationGroup(plannerInput(packages, [action]));
    const after = planPackageAllocationGroup(plannerInput(packages, [action], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(after.outcome).toBe("unchanged");
    expect(after.proposedGroupVersion).toBe(before.proposedGroupVersion);
    expect(after.stateHash).toBe(before.stateHash);
    expect(after.ledgerEntriesToAppend).toEqual([]);
    expect(after.effectIntentsToAppend).toEqual([]);
    expect(after.state.appliedActionKeys).toEqual([action.actionKey]);
    expect(after.state.actionEvidence).toEqual(before.state.actionEvidence);
  });

  it.each([
    ["quantity", cancellation({ quantity: 2 })],
    ["actor", cancellation({
      authorization: {
        kind: "lead_approved",
        actor: "shipping-lead:52",
        reason: "Customer-approved exact fulfillment-line cancellation",
      },
    })],
    ["reason", cancellation({
      authorization: {
        kind: "lead_approved",
        actor: "shipping-lead:51",
        reason: "Different approval evidence",
      },
    })],
  ])("rejects conflicting %s evidence under the same action key", (_field, conflictingAction) => {
    const packages = [
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ];
    const before = planPackageAllocationGroup(plannerInput(packages, [cancellation()]));

    expect(() => planPackageAllocationGroup(plannerInput(
      packages,
      [conflictingAction],
      {
        expectedGroupVersion: before.proposedGroupVersion,
        previousPlan: previousPlanFrom(before),
      },
    ))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "CONFLICTING_ACTION_REPLAY",
    }));
  });

  it("fails every new competing cancellation claim instead of choosing a lexical winner", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ], [
      cancellation({ actionKey: "cancellation:z" }),
      cancellation({ actionKey: "cancellation:a", quantity: 2 }),
    ]));

    expect(result.outcome).toBe("review");
    expect(result.state.appliedActionKeys).toEqual([]);
    expect(allocationShapes(result)).toEqual([{
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 4,
    }]);
    expect(result.state.reviews).toContainEqual({
      code: "competing_allocation_actions",
      packageKeys: ["A"],
      wmsShipmentItemIds: [wmsShipmentItemId],
      actionKeys: ["cancellation:a", "cancellation:z"],
    });
  });

  it("fails both new transfer and cancellation claims deterministically regardless of input order", () => {
    const packages = [
      packageInput("A", "44001", 4, "primary", { voided: true }),
      packageInput("B", "44002", 4, "replacement_candidate"),
    ];
    const cancelAction = cancellation({ actionKey: "action:z-cancel" });
    const transferAction = transfer({ actionKey: "action:a-transfer" });
    const first = planPackageAllocationGroup(plannerInput(
      packages,
      [cancelAction, transferAction],
    ));
    const second = planPackageAllocationGroup(plannerInput(
      [...packages].reverse(),
      [transferAction, cancelAction],
    ));

    expect(first.stateHash).toBe(second.stateHash);
    expect(first.state).toEqual(second.state);
    expect(first.state.appliedActionKeys).toEqual([]);
    expect(allocationShapes(first)).toEqual([{
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 4,
    }]);
    expect(first.state.reviews).toContainEqual({
      code: "competing_allocation_actions",
      packageKeys: ["A", "B"],
      wmsShipmentItemIds: [wmsShipmentItemId],
      actionKeys: ["action:a-transfer", "action:z-cancel"],
    });
  });

  it("reviews an active-label cancellation without mutating its package allocation", () => {
    const action = cancellation();
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 4, "primary"),
    ], [action]));

    expect(allocationShapes(result)).toEqual([{
      targetKind: "package",
      packageKey: "A",
      quantity: 4,
    }]);
    expect(result.state.appliedActionKeys).toEqual([]);
    expect(result.state.reviews).toContainEqual({
      code: "invalid_cancellation_source",
      packageKeys: ["A"],
      wmsShipmentItemIds: [wmsShipmentItemId],
      actionKeys: [action.actionKey],
    });
  });

  it("reviews a cancellation against the wrong source package without mutation", () => {
    const action = cancellation({ fromPackageKey: "B" });
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 4, "primary", { voided: true }),
      packageInput("B", "44002", 4, "replacement_candidate"),
    ], [action]));

    expect(allocationShapes(result)).toEqual([{
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 4,
    }]);
    expect(result.state.appliedActionKeys).toEqual([]);
    expect(result.state.reviews).toContainEqual({
      code: "invalid_cancellation_source",
      packageKeys: ["B"],
      wmsShipmentItemIds: [wmsShipmentItemId],
      actionKeys: [action.actionKey],
    });
  });

  it("reviews wrong-line and overage cancellations atomically without mutation", () => {
    const packages = [
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ];
    const wrongLine = cancellation({
      actionKey: "cancellation:wrong-line",
      wmsShipmentItemId: 7002,
    });
    const wrongLineResult = planPackageAllocationGroup(plannerInput(packages, [wrongLine]));
    expect(allocationShapes(wrongLineResult)).toEqual([{
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 4,
    }]);
    expect(wrongLineResult.state.reviews).toContainEqual({
      code: "invalid_cancellation_source",
      packageKeys: ["A"],
      wmsShipmentItemIds: [7002],
      actionKeys: [wrongLine.actionKey],
    });

    const overage = cancellation({ actionKey: "cancellation:overage", quantity: 5 });
    const overageResult = planPackageAllocationGroup(plannerInput(packages, [overage]));
    expect(allocationShapes(overageResult)).toEqual([{
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 4,
    }]);
    expect(overageResult.state.appliedActionKeys).toEqual([]);
    expect(overageResult.state.reviews).toContainEqual({
      code: "cancellation_exceeds_awaiting_relabel",
      packageKeys: ["A"],
      wmsShipmentItemIds: [wmsShipmentItemId],
      actionKeys: [overage.actionKey],
    });
  });

  it("reviews a new post-lock cancellation and preserves the carrier package", () => {
    const action = cancellation();
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 4, "primary", {
        voided: true,
        carrierPossession: true,
      }),
    ], [action]));

    expect(allocationShapes(result)).toEqual([{
      targetKind: "package",
      packageKey: "A",
      quantity: 4,
    }]);
    expect(result.state.appliedActionKeys).toEqual([]);
    expect(result.state.reviews).toContainEqual({
      code: "cancellation_after_carrier_lock",
      packageKeys: ["A"],
      wmsShipmentItemIds: [wmsShipmentItemId],
      actionKeys: [action.actionKey],
    });
  });

  it("preserves carrier possession and applied audit when possession supersedes a prior cancellation", () => {
    const action = cancellation();
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ], [action]));
    const after = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 4, "primary", {
        voided: true,
        carrierPossession: true,
      }),
    ], [action], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(allocationShapes(after)).toEqual([{
      targetKind: "package",
      packageKey: "A",
      quantity: 4,
    }]);
    expect(after.state.appliedActionKeys).toEqual([action.actionKey]);
    expect(after.state.actionEvidence).toEqual(before.state.actionEvidence);
    expect(after.state.reviews).toContainEqual({
      code: "cancellation_superseded_by_carrier_possession",
      packageKeys: ["A"],
      wmsShipmentItemIds: [wmsShipmentItemId],
      actionKeys: [action.actionKey],
    });
    expect(after.state.allocations.some(
      (entry) => entry.targetKind === "held_for_unpack",
    )).toBe(false);
    expect(after.effectIntentsToAppend.map((intent) => intent.effectType)).toEqual([
      "carrier_tracking",
    ]);
  });

  it("reconstructs a prior cancellation before rejecting a new transfer of the held quantity", () => {
    const cancelAction = cancellation({ actionKey: "action:z-prior-cancel" });
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ], [cancelAction]));
    const transferAction = transfer({ actionKey: "action:a-new-transfer" });
    const after = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 4, "primary", { voided: true }),
      packageInput("B", "44002", 4, "replacement_candidate"),
    ], [transferAction, cancelAction], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(allocationShapes(after)).toEqual([{
      targetKind: "held_for_unpack",
      packageKey: null,
      quantity: 4,
    }]);
    expect(after.state.appliedActionKeys).toEqual([cancelAction.actionKey]);
    expect(after.state.reviews).toContainEqual(expect.objectContaining({
      code: "transfer_exceeds_awaiting_relabel",
      actionKeys: [transferAction.actionKey],
    }));
  });

  it("reconstructs a prior transfer before rejecting a new cancellation of transferred quantity", () => {
    const packages = [
      packageInput("A", "44001", 4, "primary", { voided: true }),
      packageInput("B", "44002", 4, "replacement_candidate"),
    ];
    const transferAction = transfer({ actionKey: "action:z-prior-transfer" });
    const before = planPackageAllocationGroup(plannerInput(packages, [transferAction]));
    const cancelAction = cancellation({ actionKey: "action:a-new-cancel" });
    const after = planPackageAllocationGroup(plannerInput(
      packages,
      [cancelAction, transferAction],
      {
        expectedGroupVersion: before.proposedGroupVersion,
        previousPlan: previousPlanFrom(before),
      },
    ));

    expect(allocationShapes(after)).toEqual([{
      targetKind: "package",
      packageKey: "B",
      quantity: 4,
    }]);
    expect(after.state.appliedActionKeys).toEqual([transferAction.actionKey]);
    expect(after.state.reviews).toContainEqual({
      code: "cancellation_exceeds_awaiting_relabel",
      packageKeys: ["A"],
      wmsShipmentItemIds: [wmsShipmentItemId],
      actionKeys: [cancelAction.actionKey],
    });
  });

  it("cancels only the residual awaiting quantity after a prior partial transfer", () => {
    const packages = [
      packageInput("A", "44001", 4, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ];
    const transferAction = transfer({
      actionKey: "action:a-prior-transfer",
      targets: [{ packageKey: "B", wmsShipmentItemId, quantity: 2 }],
    });
    const before = planPackageAllocationGroup(plannerInput(packages, [transferAction]));
    const cancelAction = cancellation({
      actionKey: "action:z-new-cancel",
      quantity: 2,
    });
    const after = planPackageAllocationGroup(plannerInput(
      packages,
      [cancelAction, transferAction],
      {
        expectedGroupVersion: before.proposedGroupVersion,
        previousPlan: previousPlanFrom(before),
      },
    ));

    expect(allocationShapes(after)).toEqual([
      {
        targetKind: "held_for_unpack",
        packageKey: null,
        quantity: 2,
      },
      {
        targetKind: "package",
        packageKey: "B",
        quantity: 2,
      },
    ]);
    expect(after.state.appliedActionKeys).toEqual([
      transferAction.actionKey,
      cancelAction.actionKey,
    ]);
    expect(after.state.reviews).toEqual([]);
    expect(after.state.desiredEffectIntents).toEqual(before.state.desiredEffectIntents);
    expect(after.effectIntentsToAppend).toEqual([]);
  });

  it("does not mutate caller input and deeply freezes cancellation output evidence", () => {
    const input = plannerInput([
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ], [cancellation({ quantity: 2 })]);
    const inputSnapshot = JSON.parse(JSON.stringify(input)) as PackageAllocationGroupPlannerInput;
    const result = planPackageAllocationGroup(input);

    expect(input).toEqual(inputSnapshot);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.state.allocations)).toBe(true);
    expect(result.state.allocations.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(result.state.actionEvidence)).toBe(true);
    expect(result.state.actionEvidence.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(result.state.actionEvidence[0]?.action)).toBe(true);
    expect(Object.isFrozen(result.state.appliedActionKeys)).toBe(true);
    expect(Object.isFrozen(result.state.reviews)).toBe(true);
  });

  it("enforces cancellation authority, identifier, and PostgreSQL-integer bounds", () => {
    const base = plannerInput([
      packageInput("A", "44001", 4, "primary", { voided: true }),
    ]);
    const defaultAuthorization = cancellation().authorization;
    const validAtBounds = cancellation({
      actionKey: "a".repeat(300),
      fromPackageKey: "p".repeat(180),
      authorization: {
        kind: "lead_approved",
        actor: "l".repeat(200),
        reason: "r".repeat(500),
      },
      wmsShipmentItemId: 2_147_483_647,
      quantity: 2_147_483_647,
    });
    expect(packageAllocationGroupPlannerInputSchema.safeParse({
      ...base,
      actions: [validAtBounds],
    }).success).toBe(true);

    const invalidActions: readonly unknown[] = [
      { ...cancellation(), actionKey: "a".repeat(301) },
      { ...cancellation(), fromPackageKey: "p".repeat(181) },
      {
        ...cancellation(),
        authorization: { ...defaultAuthorization, actor: "l".repeat(201) },
      },
      {
        ...cancellation(),
        authorization: { ...defaultAuthorization, reason: "r".repeat(501) },
      },
      {
        ...cancellation(),
        authorization: {
          kind: "authenticated_provider_correction",
          evidenceKey: "provider-correction:unproven-for-cancellation",
        },
      },
      { ...cancellation(), wmsShipmentItemId: 2_147_483_648 },
      { ...cancellation(), quantity: 0 },
    ];
    for (const action of invalidActions) {
      expect(packageAllocationGroupPlannerInputSchema.safeParse({
        ...base,
        actions: [action],
      }).success).toBe(false);
    }
  });
});
