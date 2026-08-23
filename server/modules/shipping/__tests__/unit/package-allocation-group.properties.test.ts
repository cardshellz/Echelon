import { describe, expect, it } from "vitest";
import {
  planPackageAllocationGroup,
  type PackageAllocationEntryV1,
  type PackageAllocationGroupAction,
  type PackageAllocationGroupPackageInput,
  type PackageAllocationGroupPlannerInput,
  type PackageAllocationGroupPlannerResultV1,
  type PackageAllocationGroupSourceLine,
} from "../../package-allocation-group.domain";
import type { DeclaredPackageLifecycleEvent } from "../../declared-package-lifecycle.domain";

const groupKey = "5618eb26-f51f-4d8c-a59e-b1f6de9e72d4";
const sourceId = 7_301;
const labelObservedAt = "2026-08-23T14:00:00.000Z";
const labelProviderOccurredAt = "2026-08-23T13:59:50.000Z";
const voidObservedAt = "2026-08-23T14:05:01.000Z";
const voidProviderOccurredAt = "2026-08-23T14:05:00.000Z";
const carrierObservedAt = "2026-08-23T14:10:01.000Z";
const carrierProviderOccurredAt = "2026-08-23T14:10:00.000Z";

type TransferAction = Extract<
  PackageAllocationGroupAction,
  { readonly kind: "transfer_awaiting_allocation" }
>;
type CancellationAction = Extract<
  PackageAllocationGroupAction,
  { readonly kind: "cancel_awaiting_allocation" }
>;

interface PackageOptions {
  readonly voided?: boolean;
  readonly carrierPossession?: boolean;
  readonly membership?: "proven" | "unproven";
  readonly reverseEvents?: boolean;
}

interface AllocationShape {
  readonly allocationKind: PackageAllocationEntryV1["allocationKind"];
  readonly targetKind: PackageAllocationEntryV1["targetKind"];
  readonly packageKey: string | null;
  readonly quantity: number;
}

interface ModelCase {
  readonly sourceQuantity: number;
  readonly toB: number;
  readonly toC: number;
  readonly cancelled: number;
  readonly uncovered: number;
  readonly latePossession: boolean;
}

interface SequenceResult {
  readonly final: PackageAllocationGroupPlannerResultV1;
  readonly replay: PackageAllocationGroupPlannerResultV1;
  readonly beforeCancellation: PackageAllocationGroupPlannerResultV1;
  readonly afterCancellation: PackageAllocationGroupPlannerResultV1;
  readonly actionKeys: readonly string[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

function packageInput(
  packageKey: string,
  providerPhysicalShipmentId: string,
  allocationRole: PackageAllocationGroupPackageInput["allocationRole"],
  lines: readonly { readonly wmsShipmentItemId: number; readonly quantity: number }[],
  options: PackageOptions = {},
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
      lines: [...lines],
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
    membership: options.membership === "unproven"
      ? { status: "unproven", evidenceKey: null }
      : { status: "proven", evidenceKey: `membership:${packageKey}` },
    lifecycle: {
      provider: "shipstation",
      providerPhysicalShipmentId,
      events: options.reverseEvents ? events.reverse() : events,
    },
  };
}

function previousPlanFrom(
  result: PackageAllocationGroupPlannerResultV1,
): NonNullable<PackageAllocationGroupPlannerInput["previousPlan"]> {
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

function plannerInput(input: {
  readonly sourceLines: readonly PackageAllocationGroupSourceLine[];
  readonly packages: readonly PackageAllocationGroupPackageInput[];
  readonly actions?: readonly PackageAllocationGroupAction[];
  readonly previousPlan?: PackageAllocationGroupPlannerInput["previousPlan"];
}): PackageAllocationGroupPlannerInput {
  const previousPlan = input.previousPlan ?? null;
  return {
    contractVersion: 1,
    authorityMode: "shadow_only",
    groupKey,
    expectedGroupVersion: previousPlan?.groupVersion ?? 0,
    previousPlan,
    sourceLines: input.sourceLines,
    packages: input.packages,
    actions: input.actions ?? [],
  };
}

function transferAction(model: ModelCase, reverse: boolean): TransferAction | null {
  const targets: TransferAction["targets"] = [
    ...(model.toB > 0 ? [{ packageKey: "B", wmsShipmentItemId: sourceId, quantity: model.toB }] : []),
    ...(model.toC > 0 ? [{ packageKey: "C", wmsShipmentItemId: sourceId, quantity: model.toC }] : []),
  ];
  if (targets.length === 0) return null;
  return {
    kind: "transfer_awaiting_allocation",
    actionKey: `model:transfer:q${model.sourceQuantity}:b${model.toB}:c${model.toC}`,
    fromPackageKey: "A",
    targets: reverse ? [...targets].reverse() : targets,
    authorization: {
      kind: "lead_approved",
      actor: "shipping-model-lead",
      reason: "Deterministic bounded allocation model transfer",
    },
  };
}

function cancellationAction(model: ModelCase): CancellationAction | null {
  if (model.cancelled === 0) return null;
  return {
    kind: "cancel_awaiting_allocation",
    actionKey: `model:cancel:q${model.sourceQuantity}:x${model.cancelled}`,
    fromPackageKey: "A",
    wmsShipmentItemId: sourceId,
    quantity: model.cancelled,
    authorization: {
      kind: "lead_approved",
      actor: "shipping-model-lead",
      reason: "Deterministic bounded exact cancellation",
    },
  };
}

function modelPackages(
  model: ModelCase,
  reverse: boolean,
  carrierPossession: boolean,
): readonly PackageAllocationGroupPackageInput[] {
  const packages: PackageAllocationGroupPackageInput[] = [
    packageInput("A", "47301", "primary", [{
      wmsShipmentItemId: sourceId,
      quantity: model.sourceQuantity,
    }], {
      voided: true,
      carrierPossession,
      reverseEvents: reverse,
    }),
  ];
  if (model.toB > 0) {
    packages.push(packageInput("B", "47302", "replacement_candidate", [{
      wmsShipmentItemId: sourceId,
      quantity: model.toB,
    }], { reverseEvents: reverse }));
  }
  if (model.toC > 0) {
    packages.push(packageInput("C", "47303", "replacement_candidate", [{
      wmsShipmentItemId: sourceId,
      quantity: model.toC,
    }], { reverseEvents: reverse }));
  }
  return reverse ? packages.reverse() : packages;
}

function runSequence(model: ModelCase, reverse: boolean): SequenceResult {
  const sourceLines: readonly PackageAllocationGroupSourceLine[] = [{
    wmsShipmentItemId: sourceId,
    sourceQuantity: model.sourceQuantity,
    physicalConsumptionAuthorityQuantity:
      model.sourceQuantity + model.toB + model.toC,
    authorityVersion: 1,
  }];
  const transfer = transferAction(model, reverse);
  const cancellation = cancellationAction(model);
  const initialActions = transfer === null ? [] : [transfer];
  const beforeCancellation = planPackageAllocationGroup(plannerInput({
    sourceLines,
    packages: modelPackages(model, reverse, false),
    actions: initialActions,
  }));

  const allActions = cancellation === null
    ? initialActions
    : reverse
      ? [cancellation, ...initialActions]
      : [...initialActions, cancellation];
  const afterCancellation = cancellation === null
    ? beforeCancellation
    : planPackageAllocationGroup(plannerInput({
      sourceLines,
      packages: modelPackages(model, reverse, false),
      actions: allActions,
      previousPlan: previousPlanFrom(beforeCancellation),
    }));
  const final = model.latePossession
    ? planPackageAllocationGroup(plannerInput({
      sourceLines,
      packages: modelPackages(model, reverse, true),
      actions: allActions,
      previousPlan: previousPlanFrom(afterCancellation),
    }))
    : afterCancellation;
  const replay = planPackageAllocationGroup(plannerInput({
    sourceLines,
    packages: modelPackages(model, reverse, model.latePossession),
    actions: allActions,
    previousPlan: previousPlanFrom(final),
  }));

  return {
    final,
    replay,
    beforeCancellation,
    afterCancellation,
    actionKeys: [transfer?.actionKey, cancellation?.actionKey]
      .filter((key): key is string => key !== undefined)
      .sort(compareText),
  };
}

function allocationShapes(
  result: PackageAllocationGroupPlannerResultV1,
): readonly AllocationShape[] {
  return result.state.allocations
    .map((entry) => ({
      allocationKind: entry.allocationKind,
      targetKind: entry.targetKind,
      packageKey: entry.packageKey,
      quantity: entry.quantity,
    }))
    .sort((left, right) => (
      compareText(left.allocationKind, right.allocationKind)
      || compareText(left.targetKind, right.targetKind)
      || compareText(left.packageKey ?? "", right.packageKey ?? "")
      || left.quantity - right.quantity
    ));
}

function expectedShapes(model: ModelCase): readonly AllocationShape[] {
  const transferred = model.toB + model.toC;
  const expected: AllocationShape[] = [];
  if (model.latePossession && transferred > 0) {
    expected.push({
      allocationKind: "additional_physical_consumption",
      targetKind: "package",
      packageKey: "A",
      quantity: transferred,
    });
  }
  if (model.latePossession && model.cancelled + model.uncovered > 0) {
    expected.push({
      allocationKind: "primary_transfer",
      targetKind: "package",
      packageKey: "A",
      quantity: model.cancelled + model.uncovered,
    });
  }
  if (model.toB > 0) {
    expected.push({
      allocationKind: "primary_transfer",
      targetKind: "package",
      packageKey: "B",
      quantity: model.toB,
    });
  }
  if (model.toC > 0) {
    expected.push({
      allocationKind: "primary_transfer",
      targetKind: "package",
      packageKey: "C",
      quantity: model.toC,
    });
  }
  if (!model.latePossession && model.cancelled > 0) {
    expected.push({
      allocationKind: "primary_transfer",
      targetKind: "held_for_unpack",
      packageKey: null,
      quantity: model.cancelled,
    });
  }
  if (!model.latePossession && model.uncovered > 0) {
    expected.push({
      allocationKind: "primary_transfer",
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: model.uncovered,
    });
  }
  return expected.sort((left, right) => (
    compareText(left.allocationKind, right.allocationKind)
    || compareText(left.targetKind, right.targetKind)
    || compareText(left.packageKey ?? "", right.packageKey ?? "")
    || left.quantity - right.quantity
  ));
}

function modelCases(): readonly (readonly [string, ModelCase])[] {
  const cases: Array<readonly [string, ModelCase]> = [];
  for (let sourceQuantity = 1; sourceQuantity <= 4; sourceQuantity += 1) {
    for (let toB = 0; toB <= sourceQuantity; toB += 1) {
      for (let toC = 0; toC <= sourceQuantity - toB; toC += 1) {
        const remaining = sourceQuantity - toB - toC;
        for (let cancelled = 0; cancelled <= remaining; cancelled += 1) {
          const uncovered = remaining - cancelled;
          for (const latePossession of [false, true]) {
            const model = Object.freeze({
              sourceQuantity,
              toB,
              toC,
              cancelled,
              uncovered,
              latePossession,
            });
            const id = [
              `q${sourceQuantity}`,
              `b${toB}`,
              `c${toC}`,
              `x${cancelled}`,
              `u${uncovered}`,
              `late${latePossession ? 1 : 0}`,
            ].join("-");
            cases.push(Object.freeze([id, model] as const));
          }
        }
      }
    }
  }
  return Object.freeze(cases);
}

function overCancellationCases(): readonly (readonly [string, ModelCase])[] {
  const cases: Array<readonly [string, ModelCase]> = [];
  for (let sourceQuantity = 1; sourceQuantity <= 4; sourceQuantity += 1) {
    for (let toB = 0; toB <= sourceQuantity; toB += 1) {
      for (let toC = 0; toC <= sourceQuantity - toB; toC += 1) {
        const uncovered = sourceQuantity - toB - toC;
        const model = Object.freeze({
          sourceQuantity,
          toB,
          toC,
          cancelled: 0,
          uncovered,
          latePossession: false,
        });
        cases.push(Object.freeze([
          `q${sourceQuantity}-b${toB}-c${toC}-over${uncovered + 1}`,
          model,
        ] as const));
      }
    }
  }
  return Object.freeze(cases);
}

const MODEL_CASES = modelCases();
const OVER_CANCELLATION_CASES = overCancellationCases();

describe("package allocation bounded model properties", () => {
  it("enumerates the complete bounded partition model", () => {
    expect(MODEL_CASES).toHaveLength(138);
    expect(unique(MODEL_CASES.map(([id]) => id))).toBe(true);
  });

  it.each(MODEL_CASES)("conserves and replays %s", (_id, model) => {
    const forward = runSequence(model, false);
    const reverse = runSequence(model, true);
    const transferred = model.toB + model.toC;

    expect(allocationShapes(forward.final)).toEqual(expectedShapes(model));
    const primaryQuantity = forward.final.state.allocations
      .filter((entry) => entry.allocationKind === "primary_transfer")
      .reduce((sum, entry) => sum + entry.quantity, 0);
    const additionalQuantity = forward.final.state.allocations
      .filter((entry) => entry.allocationKind === "additional_physical_consumption")
      .reduce((sum, entry) => sum + entry.quantity, 0);
    expect(primaryQuantity).toBe(model.sourceQuantity);
    expect(additionalQuantity).toBe(model.latePossession ? transferred : 0);
    expect(forward.final.state.allocations.every((entry) => (
      Number.isSafeInteger(entry.quantity) && entry.quantity > 0
    ))).toBe(true);
    expect(unique(forward.final.state.allocations.map((entry) => entry.entryKey))).toBe(true);
    expect(forward.final.state.appliedActionKeys).toEqual(forward.actionKeys);
    expect(forward.final.outcome).toBe(
      model.latePossession && model.cancelled > 0 ? "review" : "proposed",
    );
    expect(forward.final.state.reviews).toEqual(
      model.latePossession && model.cancelled > 0
        ? [{
          code: "cancellation_superseded_by_carrier_possession",
          packageKeys: ["A"],
          wmsShipmentItemIds: [sourceId],
          actionKeys: [`model:cancel:q${model.sourceQuantity}:x${model.cancelled}`],
        }]
        : [],
    );

    if (model.cancelled > 0) {
      expect(forward.afterCancellation.state.desiredEffectIntents).toEqual(
        forward.beforeCancellation.state.desiredEffectIntents,
      );
      expect(forward.afterCancellation.effectIntentsToAppend).toEqual([]);
    }
    expect(forward.final.state.desiredEffectIntents.every(
      (intent) => intent.executable === false,
    )).toBe(true);
    expect(unique(forward.final.state.desiredEffectIntents.map((intent) => intent.intentKey))).toBe(true);
    expect(forward.final.state.desiredEffectIntents.filter(
      (intent) => intent.effectType === "commercial_fulfillment",
    ).map((intent) => ({
      packageKey: intent.packageKey,
      quantity: intent.quantity,
    }))).toEqual([{ packageKey: null, quantity: model.sourceQuantity }]);
    expect(forward.final.state.desiredEffectIntents.filter(
      (intent) => intent.effectType === "inventory_consumption",
    ).map((intent) => ({
      packageKey: intent.packageKey,
      quantity: intent.quantity,
    }))).toEqual([
      ...(model.latePossession && transferred > 0
        ? [{ packageKey: "A", quantity: transferred }]
        : []),
      {
        packageKey: null,
        quantity: model.sourceQuantity,
      },
    ]);
    if (model.latePossession) {
      expect(forward.final.effectIntentsToAppend.map((intent) => ({
        effectType: intent.effectType,
        packageKey: intent.packageKey,
        quantity: intent.quantity,
      }))).toEqual([
        { effectType: "carrier_tracking", packageKey: "A", quantity: null },
        ...(transferred > 0
          ? [{
            effectType: "inventory_consumption" as const,
            packageKey: "A",
            quantity: transferred,
          }]
          : []),
      ]);
    }
    for (const intent of forward.final.state.desiredEffectIntents) {
      expect(forward.final.state.effectIntentEvidence).toContainEqual({
        intentKey: intent.intentKey,
        payloadHash: intent.payloadHash,
      });
    }

    expect(reverse.final.state).toEqual(forward.final.state);
    expect(reverse.final.stateHash).toBe(forward.final.stateHash);
    expect(reverse.final.evidenceHash).toBe(forward.final.evidenceHash);
    expect(reverse.final.proposedGroupVersion).toBe(forward.final.proposedGroupVersion);

    for (const replay of [forward.replay, reverse.replay]) {
      expect(replay.outcome).toBe("unchanged");
      expect(replay.proposedGroupVersion).toBe(forward.final.proposedGroupVersion);
      expect(replay.stateHash).toBe(forward.final.stateHash);
      expect(replay.evidenceHash).toBe(forward.final.evidenceHash);
      expect(replay.state).toEqual(forward.final.state);
      expect(replay.ledgerEntriesToAppend).toEqual([]);
      expect(replay.effectIntentsToAppend).toEqual([]);
    }
  });

  it.each([2, 3, 4])(
    "withholds inventory without sufficient physical authority for quantity %i",
    (sourceQuantity) => {
      const activePackage = packageInput("A", "47301", "primary", [{
        wmsShipmentItemId: sourceId,
        quantity: sourceQuantity,
      }]);
      for (const authority of [null, sourceQuantity - 1, sourceQuantity, sourceQuantity + 1]) {
        const result = planPackageAllocationGroup(plannerInput({
          sourceLines: [{
            wmsShipmentItemId: sourceId,
            sourceQuantity,
            physicalConsumptionAuthorityQuantity: authority,
            authorityVersion: 1,
          }],
          packages: [activePackage],
        }));
        const inventoryIntents = result.state.desiredEffectIntents.filter(
          (intent) => intent.effectType === "inventory_consumption",
        );
        const commercialIntents = result.state.desiredEffectIntents.filter(
          (intent) => intent.effectType === "commercial_fulfillment",
        );

        expect(inventoryIntents).toHaveLength(
          authority !== null && authority >= sourceQuantity ? 1 : 0,
        );
        expect(commercialIntents).toMatchObject([{ quantity: sourceQuantity }]);
        expect(result.state.desiredEffectIntents.every(
          (intent) => intent.executable === false,
        )).toBe(true);
      }
    },
  );

  it.each([1, 2, 3, 4])(
    "blocks simultaneous transfer and cancellation claims for quantity %i in either order",
    (sourceQuantity) => {
      const model: ModelCase = {
        sourceQuantity,
        toB: sourceQuantity,
        toC: 0,
        cancelled: sourceQuantity,
        uncovered: 0,
        latePossession: false,
      };
      const transfer = transferAction(model, false)!;
      const cancellation = cancellationAction(model)!;
      const packages = modelPackages(model, false, false);
      const sourceLines: readonly PackageAllocationGroupSourceLine[] = [{
        wmsShipmentItemId: sourceId,
        sourceQuantity,
        physicalConsumptionAuthorityQuantity: sourceQuantity * 2,
        authorityVersion: 1,
      }];
      const forward = planPackageAllocationGroup(plannerInput({
        sourceLines,
        packages,
        actions: [transfer, cancellation],
      }));
      const reverse = planPackageAllocationGroup(plannerInput({
        sourceLines,
        packages: [...packages].reverse(),
        actions: [cancellation, transfer],
      }));

      expect(forward.state.appliedActionKeys).toEqual([]);
      expect(allocationShapes(forward)).toEqual([{
        allocationKind: "primary_transfer",
        targetKind: "awaiting_relabel",
        packageKey: null,
        quantity: sourceQuantity,
      }]);
      expect(forward.state.reviews).toContainEqual({
        code: "competing_allocation_actions",
        packageKeys: ["A", "B"],
        wmsShipmentItemIds: [sourceId],
        actionKeys: [cancellation.actionKey, transfer.actionKey].sort(compareText),
      });
      expect(reverse.state).toEqual(forward.state);
      expect(reverse.stateHash).toBe(forward.stateHash);
      expect(reverse.evidenceHash).toBe(forward.evidenceHash);
    },
  );

  it.each(OVER_CANCELLATION_CASES)(
    "rejects over-cancellation without changing prior allocation for %s",
    (_id, model) => {
      const sourceLines: readonly PackageAllocationGroupSourceLine[] = [{
        wmsShipmentItemId: sourceId,
        sourceQuantity: model.sourceQuantity,
        physicalConsumptionAuthorityQuantity:
          model.sourceQuantity + model.toB + model.toC,
        authorityVersion: 1,
      }];
      const forwardTransfer = transferAction(model, false);
      const reverseTransfer = transferAction(model, true);
      const beforeForward = planPackageAllocationGroup(plannerInput({
        sourceLines,
        packages: modelPackages(model, false, false),
        actions: forwardTransfer === null ? [] : [forwardTransfer],
      }));
      const beforeReverse = planPackageAllocationGroup(plannerInput({
        sourceLines,
        packages: modelPackages(model, true, false),
        actions: reverseTransfer === null ? [] : [reverseTransfer],
      }));
      const cancellation: CancellationAction = {
        kind: "cancel_awaiting_allocation",
        actionKey: `model:over-cancel:${_id}`,
        fromPackageKey: "A",
        wmsShipmentItemId: sourceId,
        quantity: model.uncovered + 1,
        authorization: {
          kind: "lead_approved",
          actor: "shipping-model-lead",
          reason: "Deterministic bounded over-cancellation model",
        },
      };
      const forwardActions = [
        ...(forwardTransfer === null ? [] : [forwardTransfer]),
        cancellation,
      ];
      const reverseActions = [
        cancellation,
        ...(reverseTransfer === null ? [] : [reverseTransfer]),
      ];
      const afterForward = planPackageAllocationGroup(plannerInput({
        sourceLines,
        packages: modelPackages(model, false, false),
        actions: forwardActions,
        previousPlan: previousPlanFrom(beforeForward),
      }));
      const afterReverse = planPackageAllocationGroup(plannerInput({
        sourceLines,
        packages: modelPackages(model, true, false),
        actions: reverseActions,
        previousPlan: previousPlanFrom(beforeReverse),
      }));

      expect(allocationShapes(afterForward)).toEqual(allocationShapes(beforeForward));
      expect(afterForward.state.appliedActionKeys).toEqual(beforeForward.state.appliedActionKeys);
      expect(afterForward.state.reviews).toContainEqual({
        code: "cancellation_exceeds_awaiting_relabel",
        packageKeys: ["A"],
        wmsShipmentItemIds: [sourceId],
        actionKeys: [cancellation.actionKey],
      });
      expect(afterForward.state.desiredEffectIntents).toEqual(
        beforeForward.state.desiredEffectIntents,
      );
      expect(afterForward.effectIntentsToAppend).toEqual([]);
      expect(afterReverse.state).toEqual(afterForward.state);
      expect(afterReverse.stateHash).toBe(afterForward.stateHash);
      expect(afterReverse.evidenceHash).toBe(afterForward.evidenceHash);
    },
  );

  it("is invariant to source, package, lifecycle-event, and transfer-target order", () => {
    const secondSourceId = sourceId + 1;
    const sourceLines: readonly PackageAllocationGroupSourceLine[] = [
      {
        wmsShipmentItemId: sourceId,
        sourceQuantity: 2,
        physicalConsumptionAuthorityQuantity: 2,
        authorityVersion: 1,
      },
      {
        wmsShipmentItemId: secondSourceId,
        sourceQuantity: 3,
        physicalConsumptionAuthorityQuantity: 3,
        authorityVersion: 1,
      },
    ];
    const lines = [
      { wmsShipmentItemId: sourceId, quantity: 2 },
      { wmsShipmentItemId: secondSourceId, quantity: 3 },
    ];
    const forwardPackages = [
      packageInput("A", "47301", "primary", lines, { voided: true }),
      packageInput("B", "47302", "replacement_candidate", lines),
    ];
    const forwardAction: TransferAction = {
      kind: "transfer_awaiting_allocation",
      actionKey: "model:two-source-transfer",
      fromPackageKey: "A",
      targets: [
        { packageKey: "B", wmsShipmentItemId: sourceId, quantity: 2 },
        { packageKey: "B", wmsShipmentItemId: secondSourceId, quantity: 3 },
      ],
      authorization: {
        kind: "lead_approved",
        actor: "shipping-model-lead",
        reason: "Two-source order-invariance model",
      },
    };
    const reversePackages = [
      packageInput("B", "47302", "replacement_candidate", lines, { reverseEvents: true }),
      packageInput("A", "47301", "primary", lines, {
        voided: true,
        reverseEvents: true,
      }),
    ];
    const reverseAction: TransferAction = {
      ...forwardAction,
      targets: [...forwardAction.targets].reverse(),
    };

    const forward = planPackageAllocationGroup(plannerInput({
      sourceLines,
      packages: forwardPackages,
      actions: [forwardAction],
    }));
    const reverse = planPackageAllocationGroup(plannerInput({
      sourceLines: [...sourceLines].reverse(),
      packages: reversePackages,
      actions: [reverseAction],
    }));

    expect(reverse.state).toEqual(forward.state);
    expect(reverse.stateHash).toBe(forward.stateHash);
    expect(reverse.evidenceHash).toBe(forward.evidenceHash);
    for (const sourceLine of sourceLines) {
      expect(forward.state.allocations
        .filter((entry) => (
          entry.wmsShipmentItemId === sourceLine.wmsShipmentItemId
          && entry.allocationKind === "primary_transfer"
        ))
        .reduce((sum, entry) => sum + entry.quantity, 0)).toBe(sourceLine.sourceQuantity);
    }
  });

  it("models four parseable packages with one unit lacking package-membership proof", () => {
    // The audit did not retain the actual roles or line distribution. Membership is
    // package-level today, so a one-unit unproven package is the smallest fail-closed
    // planner representation; this is not evidence of a per-unit membership model.
    const packages = [
      packageInput("A", "47301", "primary", [{ wmsShipmentItemId: sourceId, quantity: 1 }]),
      packageInput("B", "47302", "primary", [{ wmsShipmentItemId: sourceId, quantity: 1 }]),
      packageInput("C", "47303", "primary", [{ wmsShipmentItemId: sourceId, quantity: 1 }]),
      packageInput("D", "47304", "primary", [{ wmsShipmentItemId: sourceId, quantity: 1 }], {
        membership: "unproven",
      }),
    ];
    const result = planPackageAllocationGroup(plannerInput({
      sourceLines: [{
        wmsShipmentItemId: sourceId,
        sourceQuantity: 4,
        physicalConsumptionAuthorityQuantity: 4,
        authorityVersion: 1,
      }],
      packages,
    }));

    expect(result.outcome).toBe("review");
    expect(result.state.reviews).toEqual([{
      code: "package_membership_unproven",
      packageKeys: ["D"],
      wmsShipmentItemIds: [],
      actionKeys: [],
    }]);
    expect(allocationShapes(result)).toEqual([
      {
        allocationKind: "primary_transfer",
        targetKind: "awaiting_relabel",
        packageKey: null,
        quantity: 1,
      },
      ...["A", "B", "C"].map((packageKey) => ({
        allocationKind: "primary_transfer" as const,
        targetKind: "package" as const,
        packageKey,
        quantity: 1,
      })),
    ]);
    expect(result.state.allocations.reduce(
      (total, entry) => total + entry.quantity,
      0,
    )).toBe(4);
    expect(result.state.allocations.some((entry) => entry.packageKey === "D")).toBe(false);
    expect(result.state.desiredEffectIntents.some((intent) => intent.packageKey === "D")).toBe(false);
    expect(result.state.desiredEffectIntents).toContainEqual(expect.objectContaining({
      effectType: "commercial_fulfillment",
      wmsShipmentItemId: sourceId,
      quantity: 3,
      executable: false,
    }));
    expect(result.state.desiredEffectIntents).toContainEqual(expect.objectContaining({
      effectType: "inventory_consumption",
      subjectKey: `primary:${sourceId}`,
      quantity: 3,
      executable: false,
    }));
    expect(result.state.desiredEffectIntents.every(
      (intent) => intent.executable === false,
    )).toBe(true);
  });
});
