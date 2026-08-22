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
  readonly reprinted?: boolean;
}

function lifecycle(
  providerPhysicalShipmentId: string,
  quantity: number,
  options: LifecycleOptions = {},
) {
  const trackingNumber = `1Z${providerPhysicalShipmentId.padStart(16, "0")}`;
  const events: DeclaredPackageLifecycleEvent[] = [{
    kind: "outbound_label_observed",
    eventKey: `shipstation:${providerPhysicalShipmentId}:observed`,
    observedAt: labelObservedAt,
    providerOccurredAt: labelProviderOccurredAt,
    trackingNumber,
    contentsEvidence: {
      status: "authoritative",
      lines: [{ wmsShipmentItemId: 7001, quantity }],
    },
  }];
  if (options.reprinted) {
    events.push({
      kind: "outbound_label_reprinted",
      eventKey: `shipstation:${providerPhysicalShipmentId}:reprint:1`,
      observedAt: "2026-08-21T14:02:00.000Z",
      providerOccurredAt: null,
      trackingNumber,
    });
  }
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
    provider: "shipstation",
    providerPhysicalShipmentId,
    events,
  } as const;
}

function packageInput(
  packageKey: string,
  providerPhysicalShipmentId: string,
  quantity: number,
  allocationRole: PackageAllocationGroupPackageInput["allocationRole"],
  options: LifecycleOptions = {},
): PackageAllocationGroupPackageInput {
  return {
    packageKey,
    allocationRole,
    membership: {
      status: "proven",
      evidenceKey: `membership:${packageKey}`,
    },
    lifecycle: lifecycle(providerPhysicalShipmentId, quantity, options),
  };
}

function transfer(
  targets: PackageAllocationGroupAction["targets"],
  overrides: Partial<PackageAllocationGroupAction> = {},
): PackageAllocationGroupAction {
  return {
    kind: "transfer_awaiting_allocation",
    actionKey: "correction:A:1",
    fromPackageKey: "A",
    targets,
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
      physicalConsumptionAuthorityQuantity: 2,
      authorityVersion: 1,
    }],
    packages,
    actions,
    ...overrides,
  };
}

function allocationsFor(result: ReturnType<typeof planPackageAllocationGroup>) {
  return result.state.allocations.map((entry) => ({
    allocationKey: entry.allocationKey,
    allocationKind: entry.allocationKind,
    targetKind: entry.targetKind,
    packageKey: entry.packageKey,
    quantity: entry.quantity,
  }));
}

function previousPlanFrom(result: ReturnType<typeof planPackageAllocationGroup>) {
  return {
    groupKey: result.groupKey,
    groupVersion: result.proposedGroupVersion,
    stateHash: result.stateHash,
    actionEvidence: result.state.actionEvidence,
    packageEvidence: result.state.packageEvidence,
    effectIntentEvidence: result.state.effectIntentEvidence,
    appliedActionKeys: result.state.appliedActionKeys,
    sourceEvidence: result.state.sourceEvidence,
  };
}

describe("planPackageAllocationGroup", () => {
  it("plans one conserved primary allocation and inert effect intents for an exact active label", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary"),
    ]));

    expect(result).toMatchObject({
      contractVersion: 1,
      authority: "shadow_only",
      outcome: "proposed",
      baseGroupVersion: 0,
      proposedGroupVersion: 1,
    });
    expect(allocationsFor(result)).toEqual([{
      allocationKey: `package-allocation:v1:${groupKey}:primary:7001`,
      allocationKind: "primary_transfer",
      targetKind: "package",
      packageKey: "A",
      quantity: 2,
    }]);
    expect(result.state.reviews).toEqual([]);
    expect(result.state.desiredEffectIntents.map((intent) => intent.effectType)).toEqual([
      "active_label_tracking",
      "commercial_fulfillment",
      "inventory_consumption",
      "notification_candidate",
    ]);
    expect(result.state.desiredEffectIntents.every((intent) => intent.executable === false)).toBe(true);
  });

  it("moves a pre-possession void to awaiting relabel without reversing commercial or inventory intent", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
    ]));

    expect(allocationsFor(result)).toEqual([{
      allocationKey: `package-allocation:v1:${groupKey}:primary:7001`,
      allocationKind: "primary_transfer",
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 2,
    }]);
    expect(result.state.desiredEffectIntents.map((intent) => intent.effectType)).toEqual([
      "commercial_fulfillment",
      "inventory_consumption",
      "notification_reconciliation",
      "pre_possession_void_removal",
    ]);
    expect(result.state.reviews).toEqual([]);
  });

  it("treats a same-label reprint as an evidence-only no-op", () => {
    const before = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary"),
    ]));
    const after = planPackageAllocationGroup(plannerInput(
      [packageInput("A", "44001", 2, "primary", { reprinted: true })],
      [],
      {
        expectedGroupVersion: before.proposedGroupVersion,
        previousPlan: previousPlanFrom(before),
      },
    ));

    expect(after.outcome).toBe("unchanged");
    expect(after.proposedGroupVersion).toBe(before.proposedGroupVersion);
    expect(after.stateHash).toBe(before.stateHash);
    expect(after.evidenceHash).not.toBe(before.evidenceHash);
    expect(after.ledgerEntriesToAppend).toEqual([]);
    expect(after.effectIntentsToAppend).toEqual([]);
  });

  it("transfers A to exact B under explicit audited correction authority without a second consumption", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [transfer([{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 2 }])]));

    expect(result.outcome).toBe("proposed");
    expect(allocationsFor(result)).toEqual([{
      allocationKey: `package-allocation:v1:${groupKey}:primary:7001`,
      allocationKind: "primary_transfer",
      targetKind: "package",
      packageKey: "B",
      quantity: 2,
    }]);
    expect(result.state.appliedActionKeys).toEqual(["correction:A:1"]);
    expect(result.state.reviews).toEqual([]);
    expect(result.state.desiredEffectIntents.filter((intent) => (
      intent.effectType === "commercial_fulfillment"
    ))).toHaveLength(1);
    expect(result.state.desiredEffectIntents.filter((intent) => (
      intent.effectType === "inventory_consumption"
    ))).toHaveLength(1);
  });

  it("atomically splits A across B/C and leaves an uncovered partial quantity awaiting relabel", () => {
    const full = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 1, "replacement_candidate"),
      packageInput("C", "44003", 1, "replacement_candidate"),
    ], [transfer([
      { packageKey: "C", wmsShipmentItemId: 7001, quantity: 1 },
      { packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 },
    ])]));

    expect(allocationsFor(full)).toEqual([
      {
        allocationKey: `package-allocation:v1:${groupKey}:primary:7001`,
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: "B",
        quantity: 1,
      },
      {
        allocationKey: `package-allocation:v1:${groupKey}:primary:7001`,
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: "C",
        quantity: 1,
      },
    ]);

    const partial = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 1, "replacement_candidate"),
    ], [transfer([{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 }])]));
    expect(allocationsFor(partial)).toEqual([
      {
        allocationKey: `package-allocation:v1:${groupKey}:primary:7001`,
        allocationKind: "primary_transfer",
        targetKind: "awaiting_relabel",
        packageKey: null,
        quantity: 1,
      },
      {
        allocationKey: `package-allocation:v1:${groupKey}:primary:7001`,
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: "B",
        quantity: 1,
      },
    ]);
    expect(partial.state.allocations.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(2);
  });

  it("fails closed when a transfer target does not exactly match its declared box contents", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [transfer([{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 }])]));

    expect(result.outcome).toBe("review");
    expect(result.state.appliedActionKeys).toEqual([]);
    expect(allocationsFor(result)).toEqual([{
      allocationKey: `package-allocation:v1:${groupKey}:primary:7001`,
      allocationKind: "primary_transfer",
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 2,
    }]);
    expect(result.state.reviews.map((item) => item.code)).toEqual([
      "replacement_order_unproven",
      "transfer_contents_mismatch",
    ]);
  });

  it("records active A+B as two physical consumptions and reviews the unclassified dispatch", () => {
    const result = planPackageAllocationGroup(plannerInput(
      [
        packageInput("A", "44001", 2, "primary"),
        packageInput("B", "44002", 2, "additional_dispatch"),
      ],
      [],
      {
        sourceLines: [{
          wmsShipmentItemId: 7001,
          sourceQuantity: 2,
          physicalConsumptionAuthorityQuantity: 4,
          authorityVersion: 1,
        }],
      },
    ));

    expect(result.outcome).toBe("review");
    expect(result.state.allocations).toHaveLength(2);
    expect(result.state.allocations.map((entry) => entry.allocationKind)).toEqual([
      "additional_physical_consumption",
      "primary_transfer",
    ]);
    expect(result.state.desiredEffectIntents.filter((intent) => (
      intent.effectType === "commercial_fulfillment"
    ))).toHaveLength(1);
    expect(result.state.desiredEffectIntents.filter((intent) => (
      intent.effectType === "inventory_consumption"
    ))).toHaveLength(2);
    expect(result.state.reviews.map((item) => item.code)).toEqual([
      "unclassified_additional_dispatch",
    ]);
  });

  it("retains declared physical evidence but emits no inventory intent when authority is missing", () => {
    const result = planPackageAllocationGroup(plannerInput(
      [packageInput("A", "44001", 2, "primary")],
      [],
      {
        sourceLines: [{
          wmsShipmentItemId: 7001,
          sourceQuantity: 2,
          physicalConsumptionAuthorityQuantity: null,
          authorityVersion: 1,
        }],
      },
    ));

    expect(result.state.allocations).toHaveLength(1);
    expect(result.state.desiredEffectIntents.some((intent) => (
      intent.effectType === "inventory_consumption"
    ))).toBe(false);
    expect(result.state.reviews.map((item) => item.code)).toContain(
      "physical_consumption_authority_missing",
    );
  });

  it("does not assign group tracking or item effects when package membership is unproven", () => {
    const pkg = packageInput("A", "44001", 2, "primary", { carrierPossession: true });
    const result = planPackageAllocationGroup(plannerInput([{
      ...pkg,
      membership: { status: "unproven", evidenceKey: null },
    }]));

    expect(result.outcome).toBe("review");
    expect(result.state.allocations).toMatchObject([{
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 2,
    }]);
    expect(result.state.desiredEffectIntents).toEqual([]);
    expect(result.state.reviews.map((item) => item.code)).toEqual([
      "package_membership_unproven",
    ]);
  });

  it("does not guess a transfer when late carrier possession changes a voided A into a real package", () => {
    const result = planPackageAllocationGroup(plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true, carrierPossession: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [transfer([{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 2 }])]));

    expect(result.outcome).toBe("review");
    expect(result.state.appliedActionKeys).toEqual([]);
    expect(result.state.allocations).toMatchObject([{
      allocationKind: "primary_transfer",
      targetKind: "package",
      packageKey: "A",
      quantity: 2,
    }]);
    expect(result.state.reviews.map((item) => item.code)).toEqual([
      "late_possession_requires_previous_ledger",
      "replacement_order_unproven",
    ]);
    expect(result.state.desiredEffectIntents.some((intent) => (
      intent.effectType === "carrier_tracking" && intent.packageKey === "A"
    ))).toBe(true);
  });

  it("is invariant to package, transfer-target, and lifecycle-event order", () => {
    const packageA = packageInput("A", "44001", 2, "primary", { voided: true });
    const packageB = packageInput("B", "44002", 1, "replacement_candidate");
    const packageC = packageInput("C", "44003", 1, "replacement_candidate");
    const forward = planPackageAllocationGroup(plannerInput([
      packageA,
      packageB,
      packageC,
    ], [transfer([
      { packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 },
      { packageKey: "C", wmsShipmentItemId: 7001, quantity: 1 },
    ])]));
    const reversed = planPackageAllocationGroup(plannerInput([
      packageC,
      packageB,
      { ...packageA, lifecycle: { ...packageA.lifecycle, events: [...packageA.lifecycle.events].reverse() } },
    ], [transfer([
      { packageKey: "C", wmsShipmentItemId: 7001, quantity: 1 },
      { packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 },
    ])]));

    expect(reversed.stateHash).toBe(forward.stateHash);
    expect(reversed.evidenceHash).toBe(forward.evidenceHash);
    expect(reversed.state).toEqual(forward.state);
  });

  it("deduplicates exact action replay and rejects conflicting action-key reuse", () => {
    const packages = [
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ];
    const exact = transfer([{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 2 }]);
    const replay = planPackageAllocationGroup(plannerInput(packages, [exact, exact]));
    expect(replay.state.appliedActionKeys).toEqual(["correction:A:1"]);

    const conflicting = transfer(
      [{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 1 }],
      { actionKey: exact.actionKey },
    );
    expect(() => planPackageAllocationGroup(plannerInput(packages, [exact, conflicting])))
      .toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
        code: "CONFLICTING_ACTION_REPLAY",
      }));
  });

  it("rejects stale versions and duplicate provider-package identity", () => {
    expect(() => planPackageAllocationGroup(plannerInput(
      [packageInput("A", "44001", 2, "primary")],
      [],
      { expectedGroupVersion: 1, previousPlan: null },
    ))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "STALE_GROUP_VERSION",
    }));

    const original = packageInput("A", "44001", 2, "primary");
    expect(() => planPackageAllocationGroup(plannerInput([
      original,
      { ...original, packageKey: "B", allocationRole: "additional_dispatch" },
    ]))).toThrowError(expect.objectContaining<Partial<PackageAllocationGroupError>>({
      code: "DUPLICATE_IDENTITY",
    }));
  });

  it("does not mutate caller input and deeply freezes the complete result graph", () => {
    const input = plannerInput([
      packageInput("A", "44001", 2, "primary", { voided: true }),
      packageInput("B", "44002", 2, "replacement_candidate"),
    ], [transfer([{ packageKey: "B", wmsShipmentItemId: 7001, quantity: 2 }])]);
    const before = structuredClone(input);
    const result = planPackageAllocationGroup(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.state.allocations)).toBe(true);
    expect(Object.isFrozen(result.state.allocations[0])).toBe(true);
    expect(Object.isFrozen(result.state.desiredEffectIntents)).toBe(true);
    expect(Object.isFrozen(result.state.desiredEffectIntents[0])).toBe(true);
    expect(Object.isFrozen(result.state.packageSnapshots[0])).toBe(true);
  });
});
