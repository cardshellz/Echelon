import { describe, expect, it } from "vitest";

import {
  PackageAllocationGroupError,
  planPackageAllocationGroup,
  type PackageAllocationGroupAction,
  type PackageAllocationGroupPackageInput,
  type PackageAllocationGroupPlannerInput,
} from "../../package-allocation-group.domain";
import type { DeclaredPackageLifecycleEvent } from "../../declared-package-lifecycle.domain";

const groupKey = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";
const labelObservedAt = "2026-08-21T14:00:00.000Z";
const labelProviderOccurredAt = "2026-08-21T13:59:50.000Z";
const voidObservedAt = "2026-08-21T14:05:01.000Z";
const voidProviderOccurredAt = "2026-08-21T14:05:00.000Z";
const carrierObservedAt = "2026-08-21T14:10:01.000Z";
const carrierProviderOccurredAt = "2026-08-21T14:10:00.000Z";

interface LifecycleOptions {
  readonly voided?: boolean;
  readonly carrierPossession?: boolean;
  readonly invalidVoidChronology?: boolean;
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
    providerOccurredAt: options.invalidVoidChronology
      ? "2026-08-21T14:06:00.000Z"
      : labelProviderOccurredAt,
    trackingNumber,
    contentsEvidence: {
      status: "authoritative",
      lines: [{ wmsShipmentItemId: 7001, quantity }],
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
    membership: { status: "proven", evidenceKey: `membership:${packageKey}` },
    lifecycle: { provider: "shipstation", providerPhysicalShipmentId, events },
  };
}

function transfer(overrides: Partial<PackageAllocationGroupAction> = {}): PackageAllocationGroupAction {
  return {
    kind: "transfer_awaiting_allocation",
    actionKey: "correction:A:1",
    fromPackageKey: "A",
    targets: [{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 2 }],
    authorization: {
      kind: "lead_approved",
      actor: "lead:51",
      reason: "Approved correction after the original label was voided",
    },
    ...overrides,
  } as PackageAllocationGroupAction;
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
      wmsShipmentItemId: 7001,
      sourceQuantity: 2,
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
    effectIntentEvidence: result.state.effectIntentEvidence,
    sourceEvidence: result.state.sourceEvidence,
  };
}

function allocationShapes(result: ReturnType<typeof planPackageAllocationGroup>) {
  return result.state.allocations.map((entry) => ({
    allocationKind: entry.allocationKind,
    targetKind: entry.targetKind,
    packageKey: entry.packageKey,
    quantity: entry.quantity,
  }));
}

describe("planPackageAllocationGroup sequential safety", () => {
  it("emits only the new carrier intent after possession and never repeats item commands", () => {
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary"),
    ]));
    const after = planPackageAllocationGroup(plannerInput(
      [packageInput("A", "44001", 2, "primary", { carrierPossession: true })],
      [],
      {
        expectedGroupVersion: before.proposedGroupVersion,
        previousPlan: previousPlanFrom(before),
      },
    ));

    expect(after.outcome).toBe("proposed");
    expect(after.effectIntentsToAppend.map((intent) => intent.effectType)).toEqual([
      "carrier_tracking",
    ]);
    expect(after.effectIntentsToAppend.some((intent) => (
      intent.effectType === "commercial_fulfillment"
      || intent.effectType === "inventory_consumption"
    ))).toBe(false);
  });

  it("keeps an approved replacement transfer intact when the replacement receives its first carrier scan", () => {
    const action = transfer();
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [action]));
    const after = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate", { carrierPossession: true }),
    ], [action], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(after.outcome).toBe("proposed");
    expect(after.state.appliedActionKeys).toEqual([action.actionKey]);
    expect(after.state.allocations).toMatchObject([{
      targetKind: "package",
      packageKey: "B",
      quantity: 2,
    }]);
    expect(after.effectIntentsToAppend.map((intent) => intent.effectType)).toEqual([
      "carrier_tracking",
    ]);
  });

  it("retains an approved replacement allocation when carrier possession follows its void", () => {
    const action = transfer();
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [action]));
    const after = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate", {
        voided: true,
        carrierPossession: true,
      }),
    ], [action], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(after.state.appliedActionKeys).toEqual([action.actionKey]);
    expect(after.state.allocations).toMatchObject([{
      targetKind: "package",
      packageKey: "B",
      quantity: 2,
    }]);
    expect(after.state.packageSnapshots.find((pkg) => pkg.packageKey === "B")).toMatchObject({
      carrierStatus: "possession_confirmed",
      disposition: "return_to_sender_expected",
    });
  });

  it("retains normalized action authority and rejects missing or conflicting cross-plan replay", () => {
    const packages = [
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ];
    const action = transfer();
    const before = planPackageAllocationGroup(plannerInput(packages, [action]));
    expect(before.state.actionEvidence[0]?.action.authorization).toEqual(action.authorization);

    expect(() => planPackageAllocationGroup(plannerInput(packages, [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "INCOMPLETE_ACTION_HISTORY",
    }));

    expect(() => planPackageAllocationGroup(plannerInput(packages, [transfer({
      authorization: {
        kind: "lead_approved",
        actor: "lead:51",
        reason: "Different authorization evidence",
      },
    })], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "CONFLICTING_ACTION_REPLAY",
    }));
  });

  it("holds all new competing transfers instead of choosing a lexical winner", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
      packageInput("C", "44003", 2, "replacement_candidate"),
    ], [
      transfer({
        actionKey: "action:2",
        targets: [{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 2 }],
      }),
      transfer({
        actionKey: "action:1",
        targets: [{ packageKey: "C", wmsShipmentItemId: 7001, quantity: 2 }],
      }),
    ]));

    expect(result.outcome).toBe("review");
    expect(result.state.appliedActionKeys).toEqual([]);
    expect(result.state.allocations).toMatchObject([{
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 2,
    }]);
    expect(result.state.reviews).toContainEqual(expect.objectContaining({
      code: "competing_transfer_actions",
      actionKeys: ["action:1", "action:2"],
    }));
  });

  it("reconstructs prior transfers before evaluating a lexically earlier new action", () => {
    const priorAction = transfer({
      actionKey: "action:z-prior",
      targets: [{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 2 }],
    });
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [priorAction]));
    const newAction = transfer({
      actionKey: "action:a-new",
      targets: [{ packageKey: "C", wmsShipmentItemId: 7001, quantity: 1 }],
    });
    const after = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
      packageInput("C", "44003", 1, "replacement_candidate"),
    ], [priorAction, newAction], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(after.outcome).toBe("review");
    expect(after.state.appliedActionKeys).toEqual([priorAction.actionKey]);
    expect(after.state.allocations).toMatchObject([{
      targetKind: "package",
      packageKey: "B",
      quantity: 2,
    }]);
    expect(after.state.reviews).toContainEqual(expect.objectContaining({
      code: "transfer_exceeds_awaiting_relabel",
      actionKeys: [newAction.actionKey],
    }));
  });

  it("replays a prior full transfer when voided A gains possession without duplicating commercial fulfillment", () => {
    const action = transfer();
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [action]));

    const after = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true, carrierPossession: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [action], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(after.outcome).toBe("proposed");
    expect(after.state.appliedActionKeys).toEqual([action.actionKey]);
    expect(allocationShapes(after)).toEqual([
      {
        allocationKind: "additional_physical_consumption",
        targetKind: "package",
        packageKey: "A",
        quantity: 2,
      },
      {
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: "B",
        quantity: 2,
      },
    ]);
    expect(after.effectIntentsToAppend.map((intent) => ({
      effectType: intent.effectType,
      packageKey: intent.packageKey,
      quantity: intent.quantity,
    }))).toEqual([
      { effectType: "carrier_tracking", packageKey: "A", quantity: null },
      { effectType: "inventory_consumption", packageKey: "A", quantity: 2 },
    ]);
    expect(after.effectIntentsToAppend.some((intent) => (
      intent.effectType === "commercial_fulfillment"
    ))).toBe(false);
    expect(after.state.reviews).toEqual([]);
  });

  it("counts only the transferred overlap as additional consumption after partial-transfer late possession", () => {
    const action = transfer({
      targets: [{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 }],
    });
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 1, "replacement_candidate"),
    ], [action]));

    const after = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true, carrierPossession: true }),
      packageInput("B", "44002", 1, "replacement_candidate"),
    ], [action], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(allocationShapes(after)).toEqual([
      {
        allocationKind: "additional_physical_consumption",
        targetKind: "package",
        packageKey: "A",
        quantity: 1,
      },
      {
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: "A",
        quantity: 1,
      },
      {
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: "B",
        quantity: 1,
      },
    ]);
    expect(after.effectIntentsToAppend.filter((intent) => (
      intent.effectType === "inventory_consumption"
    ))).toMatchObject([{ packageKey: "A", quantity: 1 }]);
    expect(after.state.reviews).toEqual([]);
  });

  it("retains late-possession allocation evidence but withholds its inventory intent when authority is insufficient", () => {
    const action = transfer();
    const sourceLines = [{
      wmsShipmentItemId: 7001,
      sourceQuantity: 2,
      physicalConsumptionAuthorityQuantity: 2,
      authorityVersion: 1,
    }];
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [action], { sourceLines }));

    const after = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true, carrierPossession: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [action], {
      sourceLines,
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(after.outcome).toBe("review");
    expect(allocationShapes(after)).toEqual([
      {
        allocationKind: "additional_physical_consumption",
        targetKind: "package",
        packageKey: "A",
        quantity: 2,
      },
      {
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: "B",
        quantity: 2,
      },
    ]);
    expect(after.state.reviews).toContainEqual(expect.objectContaining({
      code: "physical_consumption_authority_exceeded",
      wmsShipmentItemIds: [7001],
    }));
    expect(after.effectIntentsToAppend.some((intent) => (
      intent.effectType === "inventory_consumption"
    ))).toBe(false);
  });

  it("reconstructs a prior B/C split and counts late possession only once for A", () => {
    const action = transfer({
      targets: [
        { packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 },
        { packageKey: "C", wmsShipmentItemId: 7001, quantity: 1 },
      ],
    });
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 1, "replacement_candidate"),
      packageInput("C", "44003", 1, "replacement_candidate"),
    ], [action]));

    const after = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true, carrierPossession: true }),
      packageInput("B", "44002", 1, "replacement_candidate"),
      packageInput("C", "44003", 1, "replacement_candidate"),
    ], [action], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(allocationShapes(after)).toEqual([
      {
        allocationKind: "additional_physical_consumption",
        targetKind: "package",
        packageKey: "A",
        quantity: 2,
      },
      {
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: "B",
        quantity: 1,
      },
      {
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: "C",
        quantity: 1,
      },
    ]);
    expect(after.effectIntentsToAppend.filter((intent) => (
      intent.effectType === "inventory_consumption"
    ))).toMatchObject([{ packageKey: "A", quantity: 2 }]);
    expect(after.state.reviews).toEqual([]);
  });

  it("makes late possession idempotent and does not repeat A consumption when B is later scanned", () => {
    const action = transfer();
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [action]));
    const latePossessionPackages = [
      packageInput("A", "44001", 2, "primary", { voided: true, carrierPossession: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ];
    const latePossession = planPackageAllocationGroup(plannerInput(latePossessionPackages, [action], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    const replay = planPackageAllocationGroup(plannerInput(latePossessionPackages, [action], {
      expectedGroupVersion: latePossession.proposedGroupVersion,
      previousPlan: previousPlanFrom(latePossession),
    }));
    expect(replay.outcome).toBe("unchanged");
    expect(replay.proposedGroupVersion).toBe(latePossession.proposedGroupVersion);
    expect(replay.stateHash).toBe(latePossession.stateHash);
    expect(replay.ledgerEntriesToAppend).toEqual([]);
    expect(replay.effectIntentsToAppend).toEqual([]);

    const replacementPossession = planPackageAllocationGroup(plannerInput([
      latePossessionPackages[0]!,
      packageInput("B", "44002", 2, "replacement_candidate", { carrierPossession: true }),
    ], [action], {
      expectedGroupVersion: latePossession.proposedGroupVersion,
      previousPlan: previousPlanFrom(latePossession),
    }));
    expect(allocationShapes(replacementPossession)).toEqual(allocationShapes(latePossession));
    expect(replacementPossession.effectIntentsToAppend.map((intent) => ({
      effectType: intent.effectType,
      packageKey: intent.packageKey,
      quantity: intent.quantity,
    }))).toEqual([
      { effectType: "carrier_tracking", packageKey: "B", quantity: null },
    ]);
  });

  it("treats a changed membership proof as evidence-only and canonicalizes group UUIDs", () => {
    const beforePackage = packageInput("A", "44001", 2, "primary");
    const before = planPackageAllocationGroup(plannerInput([beforePackage], [], {
      groupKey: groupKey.toUpperCase(),
    }));
    const after = planPackageAllocationGroup(plannerInput([{
      ...beforePackage,
      membership: { status: "proven", evidenceKey: "membership:A:refreshed" },
    }], [], {
      groupKey: groupKey.toUpperCase(),
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(before.groupKey).toBe(groupKey);
    expect(after.outcome).toBe("unchanged");
    expect(after.stateHash).toBe(before.stateHash);
    expect(after.evidenceHash).not.toBe(before.evidenceHash);
  });

  it("rejects missing and rebound physical-package history across plan versions", () => {
    const packageA = packageInput("A", "44001", 2, "primary");
    const packageB = packageInput("B", "44002", 2, "additional_dispatch");
    const before = planPackageAllocationGroup(plannerInput([packageA, packageB]));

    expect(() => planPackageAllocationGroup(plannerInput([packageA], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "INCOMPLETE_PACKAGE_HISTORY",
    }));

    expect(() => planPackageAllocationGroup(plannerInput([
      packageInput("A", "44999", 2, "primary"),
      packageB,
    ], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "CONFLICTING_PACKAGE_HISTORY",
    }));
  });

  it("keeps generated database keys within bounds at the maximum package-key length", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("P".repeat(180), "44001", 2, "additional_dispatch"),
    ]));

    expect(result.state.allocations.every((entry) => (
      entry.entryKey.length <= 500 && entry.allocationKey.length <= 500
    ))).toBe(true);
    expect(result.state.desiredEffectIntents.every((intent) => intent.intentKey.length <= 500)).toBe(true);
  });

  it("preserves immutable source membership and requires versioned monotonic authority changes", () => {
    const pkg = packageInput("A", "44001", 2, "primary");
    const before = planPackageAllocationGroup(plannerInput([pkg]));
    const previousPlan = previousPlanFrom(before);

    expect(() => planPackageAllocationGroup(plannerInput([pkg], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan,
      sourceLines: [{
        wmsShipmentItemId: 7002,
        sourceQuantity: 2,
        physicalConsumptionAuthorityQuantity: 4,
        authorityVersion: 1,
      }],
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "INCOMPLETE_SOURCE_HISTORY",
    }));

    expect(() => planPackageAllocationGroup(plannerInput([pkg], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan,
      sourceLines: [
        {
          wmsShipmentItemId: 7001,
          sourceQuantity: 2,
          physicalConsumptionAuthorityQuantity: 4,
          authorityVersion: 1,
        },
        {
          wmsShipmentItemId: 7002,
          sourceQuantity: 1,
          physicalConsumptionAuthorityQuantity: 1,
          authorityVersion: 1,
        },
      ],
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "CONFLICTING_SOURCE_HISTORY",
    }));

    expect(() => planPackageAllocationGroup(plannerInput([pkg], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan,
      sourceLines: [{
        wmsShipmentItemId: 7001,
        sourceQuantity: 3,
        physicalConsumptionAuthorityQuantity: 4,
        authorityVersion: 1,
      }],
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "CONFLICTING_SOURCE_HISTORY",
    }));

    expect(() => planPackageAllocationGroup(plannerInput([pkg], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan,
      sourceLines: [{
        wmsShipmentItemId: 7001,
        sourceQuantity: 2,
        physicalConsumptionAuthorityQuantity: 6,
        authorityVersion: 1,
      }],
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "CONFLICTING_SOURCE_HISTORY",
    }));

    expect(() => planPackageAllocationGroup(plannerInput([pkg], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan,
      sourceLines: [{
        wmsShipmentItemId: 7001,
        sourceQuantity: 2,
        physicalConsumptionAuthorityQuantity: 2,
        authorityVersion: 2,
      }],
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "SOURCE_AUTHORITY_REGRESSION",
    }));

    const upgraded = planPackageAllocationGroup(plannerInput([pkg], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan,
      sourceLines: [{
        wmsShipmentItemId: 7001,
        sourceQuantity: 2,
        physicalConsumptionAuthorityQuantity: 6,
        authorityVersion: 2,
      }],
    }));
    expect(upgraded.outcome).toBe("proposed");
    expect(upgraded.effectIntentsToAppend).toEqual([]);
  });

  it("rejects duplicate transfer targets, oversized generated keys, and version overflow", () => {
    const packages = [
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ];
    expect(() => planPackageAllocationGroup(plannerInput(packages, [transfer({
      targets: [
        { packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 },
        { packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 },
      ],
    })]))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "DUPLICATE_IDENTITY",
    }));

    expect(() => planPackageAllocationGroup(plannerInput([
      packageInput("P".repeat(181), "44001", 2, "primary"),
    ]))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "INVALID_PACKAGE_GROUP",
    }));

    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary"),
    ]));
    expect(() => planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
    ], [], {
      expectedGroupVersion: 2_147_483_647,
      previousPlan: {
        ...previousPlanFrom(before),
        groupVersion: 2_147_483_647,
      },
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "GROUP_VERSION_EXHAUSTED",
    }));
  });

  it("retains reviewed package evidence without emitting commercial or inventory intents", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", {
        voided: true,
        invalidVoidChronology: true,
      }),
    ]));

    expect(result.outcome).toBe("review");
    expect(result.state.allocations).toHaveLength(1);
    expect(result.state.desiredEffectIntents.some((intent) => (
      intent.effectType === "commercial_fulfillment"
      || intent.effectType === "inventory_consumption"
    ))).toBe(false);
  });

  it("round-trips the maximum valid cumulative intent evidence shape above the old 5,000-row limit", () => {
    const sourceLines = Array.from({ length: 500 }, (_, index) => ({
      wmsShipmentItemId: index + 1,
      sourceQuantity: 1,
      physicalConsumptionAuthorityQuantity: 11,
      authorityVersion: 1,
    }));
    const packages: PackageAllocationGroupPackageInput[] = Array.from(
      { length: 11 },
      (_, packageIndex) => {
        const providerPhysicalShipmentId = String(45_000 + packageIndex);
        return {
          packageKey: `additional-${packageIndex}`,
          allocationRole: "additional_dispatch",
          membership: {
            status: "proven",
            evidenceKey: `membership:additional-${packageIndex}`,
          },
          lifecycle: {
            provider: "shipstation",
            providerPhysicalShipmentId,
            events: [{
              kind: "outbound_label_observed",
              eventKey: `shipstation:${providerPhysicalShipmentId}:observed`,
              observedAt: labelObservedAt,
              providerOccurredAt: labelProviderOccurredAt,
              trackingNumber: `1Z${providerPhysicalShipmentId.padStart(16, "0")}`,
              contentsEvidence: {
                status: "authoritative",
                lines: sourceLines.map((line) => ({
                  wmsShipmentItemId: line.wmsShipmentItemId,
                  quantity: 1,
                })),
              },
            }],
          },
        };
      },
    );
    const before = planPackageAllocationGroup(plannerInput(packages, [], { sourceLines }));
    const after = planPackageAllocationGroup(plannerInput(packages, [], {
      sourceLines,
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(before.state.effectIntentEvidence.length).toBeGreaterThan(5_000);
    expect(after.outcome).toBe("unchanged");
    expect(after.effectIntentsToAppend).toEqual([]);
  });

  it("rejects removal of prior carrier-possession evidence", () => {
    const withCarrier = packageInput("A", "44001", 2, "primary", { carrierPossession: true });
    const before = planPackageAllocationGroup(plannerInput([withCarrier]));

    expect(() => planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary"),
    ], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "INCOMPLETE_PACKAGE_LIFECYCLE_HISTORY",
      context: expect.objectContaining({
        packageKey: "A",
        eventKey: "carrier:44001:accepted",
      }),
    }));
  });

  it("blocks a transfer before allocation when prior carrier evidence is omitted", () => {
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", {
        voided: true,
        carrierPossession: true,
      }),
    ]));

    expect(() => planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [transfer()], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "INCOMPLETE_PACKAGE_LIFECYCLE_HISTORY",
      context: expect.objectContaining({
        packageKey: "A",
        eventKey: "carrier:44001:accepted",
      }),
    }));
  });

  it("rejects a prior lifecycle event key replayed with different evidence", () => {
    const withCarrier = packageInput("A", "44001", 2, "primary", { carrierPossession: true });
    const before = planPackageAllocationGroup(plannerInput([withCarrier]));
    const conflicting: PackageAllocationGroupPackageInput = {
      ...withCarrier,
      lifecycle: {
        ...withCarrier.lifecycle,
        events: withCarrier.lifecycle.events.map((event) => (
          event.kind === "carrier_possession_confirmed"
            ? { ...event, carrierTrackingEventId: event.carrierTrackingEventId + 1 }
            : event
        )),
      },
    };

    expect(() => planPackageAllocationGroup(plannerInput([conflicting], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "CONFLICTING_PACKAGE_LIFECYCLE_REPLAY",
      context: expect.objectContaining({
        packageKey: "A",
        eventKey: "carrier:44001:accepted",
      }),
    }));
  });

  it("accepts a complete lifecycle history in a different input order", () => {
    const original = packageInput("A", "44001", 2, "primary", {
      voided: true,
      carrierPossession: true,
    });
    const before = planPackageAllocationGroup(plannerInput([original]));
    const reordered: PackageAllocationGroupPackageInput = {
      ...original,
      lifecycle: {
        ...original.lifecycle,
        events: [...original.lifecycle.events].reverse(),
      },
    };
    const after = planPackageAllocationGroup(plannerInput([reordered], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: previousPlanFrom(before),
    }));

    expect(after.outcome).toBe("unchanged");
    expect(after.stateHash).toBe(before.stateHash);
    expect(after.evidenceHash).toBe(before.evidenceHash);
  });

  it("rejects duplicate prior lifecycle event evidence keys", () => {
    const pkg = packageInput("A", "44001", 2, "primary", { carrierPossession: true });
    const before = planPackageAllocationGroup(plannerInput([pkg]));
    const previousPlan = previousPlanFrom(before);
    const previousPackage = previousPlan.packageEvidence[0];
    const firstEvent = previousPackage.lifecycleEventEvidence[0];

    expect(() => planPackageAllocationGroup(plannerInput([pkg], [], {
      expectedGroupVersion: before.proposedGroupVersion,
      previousPlan: {
        ...previousPlan,
        packageEvidence: [{
          ...previousPackage,
          lifecycleEventEvidence: [
            ...previousPackage.lifecycleEventEvidence,
            firstEvent,
          ],
        }],
      },
    }))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "INVALID_PACKAGE_GROUP",
      context: expect.objectContaining({
        packageKey: "A",
        eventKey: firstEvent.eventKey,
      }),
    }));
  });

  it("deep-freezes nested lifecycle event evidence", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { carrierPossession: true }),
    ]));
    const packageEvidence = result.state.packageEvidence[0];

    expect(Object.isFrozen(result.state.packageEvidence)).toBe(true);
    expect(Object.isFrozen(packageEvidence)).toBe(true);
    expect(Object.isFrozen(packageEvidence.lifecycleEventEvidence)).toBe(true);
    expect(packageEvidence.lifecycleEventEvidence.every(Object.isFrozen)).toBe(true);
  });
});
