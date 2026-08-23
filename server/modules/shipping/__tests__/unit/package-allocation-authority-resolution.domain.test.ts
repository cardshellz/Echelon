import { describe, expect, it } from "vitest";

import type { DeclaredPackageLifecycleEvent } from "../../declared-package-lifecycle.domain";
import {
  PackageAllocationAuthorityResolutionError,
  packageAllocationPackageKey,
  resolvePackageAllocationAuthority,
  type PackageAllocationAuthorityResolutionInput,
} from "../../package-allocation-authority-resolution.domain";
import type {
  PackageAllocationGroupAction,
  PackageAllocationGroupPlannerResultV1,
} from "../../package-allocation-group.domain";

const groupKey = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";
const sourceId = 7001;

interface ObservedPackageOptions {
  readonly observedAt: string;
  readonly quantity?: number;
  readonly contentsStatus?: "authoritative" | "empty" | "omitted";
  readonly voided?: boolean;
  readonly reverseEvents?: boolean;
}

function observedPackage(
  providerPhysicalShipmentId: string,
  options: ObservedPackageOptions,
) {
  const contentsEvidence = options.contentsStatus === "empty"
    ? { status: "empty" as const }
    : options.contentsStatus === "omitted"
      ? { status: "omitted" as const }
      : {
          status: "authoritative" as const,
          lines: [{ wmsShipmentItemId: sourceId, quantity: options.quantity ?? 2 }],
        };
  const events: DeclaredPackageLifecycleEvent[] = [{
    kind: "outbound_label_observed",
    eventKey: `shipstation:${providerPhysicalShipmentId}:observed`,
    observedAt: options.observedAt,
    providerOccurredAt: options.observedAt,
    trackingNumber: `1Z${providerPhysicalShipmentId.padStart(16, "0")}`,
    contentsEvidence,
  }];
  if (options.voided) {
    events.push({
      kind: "outbound_label_voided",
      eventKey: `shipstation:${providerPhysicalShipmentId}:voided`,
      observedAt: "2026-08-21T14:05:01.000Z",
      providerOccurredAt: "2026-08-21T14:05:00.000Z",
    });
  }
  if (options.reverseEvents) events.reverse();
  return {
    evidenceKey: `shipping-provider-label:${providerPhysicalShipmentId}`,
    lifecycle: {
      provider: "shipstation",
      providerPhysicalShipmentId,
      events,
    },
  } as const;
}

function previousPlanFrom(result: PackageAllocationGroupPlannerResultV1) {
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

function command(
  packages: PackageAllocationAuthorityResolutionInput["packages"],
  actions: readonly PackageAllocationGroupAction[] = [],
  overrides: Partial<PackageAllocationAuthorityResolutionInput> = {},
): PackageAllocationAuthorityResolutionInput {
  return {
    contractVersion: 1,
    authorityMode: "shadow_only",
    groupKey,
    expectedGroupVersion: 0,
    previousPlan: null,
    sourceLines: [{ wmsShipmentItemId: sourceId, sourceQuantity: 2 }],
    packages,
    actions,
    ...overrides,
  };
}

function allocationShapes(result: PackageAllocationGroupPlannerResultV1) {
  return result.state.allocations.map((entry) => ({
    allocationKind: entry.allocationKind,
    targetKind: entry.targetKind,
    packageKey: entry.packageKey,
    quantity: entry.quantity,
  }));
}

function transferAction(
  fromPackageKey: string,
  toPackageKey: string,
): PackageAllocationGroupAction {
  return {
    kind: "transfer_awaiting_allocation",
    actionKey: "provider-reship:44001:44002",
    fromPackageKey,
    targets: [{
      packageKey: toPackageKey,
      wmsShipmentItemId: sourceId,
      quantity: 2,
    }],
    authorization: {
      kind: "authenticated_provider_correction",
      evidenceKey: "shipstation-action:reship:44001:44002",
    },
  };
}

describe("resolvePackageAllocationAuthority", () => {
  it("treats active A+B with exact contents as two physical consumptions without double fulfillment", () => {
    const packageA = observedPackage("44001", {
      observedAt: "2026-08-21T14:00:00.000Z",
    });
    const packageB = observedPackage("44002", {
      observedAt: "2026-08-21T14:01:00.000Z",
    });

    const result = resolvePackageAllocationAuthority(command([packageB, packageA]));

    expect(result.authority).toBe("shadow_only");
    expect(result.outcome).toBe("review");
    expect(result.reviews).toEqual([]);
    expect(result.plannerInput?.packages.map((pkg) => ({
      packageKey: pkg.packageKey,
      allocationRole: pkg.allocationRole,
      membershipStatus: pkg.membership.status,
    }))).toEqual([
      {
        packageKey: packageAllocationPackageKey("shipstation", "44002"),
        allocationRole: "additional_dispatch",
        membershipStatus: "proven",
      },
      {
        packageKey: packageAllocationPackageKey("shipstation", "44001"),
        allocationRole: "primary",
        membershipStatus: "proven",
      },
    ].sort((left, right) => left.packageKey < right.packageKey ? -1 : 1));
    expect(result.plannerInput?.sourceLines).toEqual([{
      wmsShipmentItemId: sourceId,
      sourceQuantity: 2,
      physicalConsumptionAuthorityQuantity: 4,
      authorityVersion: 1,
    }]);
    expect(allocationShapes(result.plannerResult!)).toEqual([
      {
        allocationKind: "additional_physical_consumption",
        targetKind: "package",
        packageKey: packageAllocationPackageKey("shipstation", "44002"),
        quantity: 2,
      },
      {
        allocationKind: "primary_transfer",
        targetKind: "package",
        packageKey: packageAllocationPackageKey("shipstation", "44001"),
        quantity: 2,
      },
    ]);
    const commercial = result.plannerResult!.state.desiredEffectIntents.filter(
      (intent) => intent.effectType === "commercial_fulfillment",
    );
    const inventory = result.plannerResult!.state.desiredEffectIntents.filter(
      (intent) => intent.effectType === "inventory_consumption",
    );
    expect(commercial.map((intent) => intent.quantity)).toEqual([2]);
    expect(inventory.map((intent) => intent.quantity).sort()).toEqual([2, 2]);
    expect(result.plannerResult!.state.reviews.map((review) => review.code)).toEqual([
      "unclassified_additional_dispatch",
    ]);
    expect(result.plannerResult!.state.desiredEffectIntents.every(
      (intent) => intent.executable === false,
    )).toBe(true);
  });

  it("transfers a voided A allocation to exact B under authenticated correction without second consumption", () => {
    const packageA = observedPackage("44001", {
      observedAt: "2026-08-21T14:00:00.000Z",
      voided: true,
    });
    const packageB = observedPackage("44002", {
      observedAt: "2026-08-21T14:06:00.000Z",
    });
    const packageAKey = packageAllocationPackageKey("shipstation", "44001");
    const packageBKey = packageAllocationPackageKey("shipstation", "44002");
    const action = transferAction(packageAKey, packageBKey);

    const result = resolvePackageAllocationAuthority(command([packageA, packageB], [action]));

    expect(result).toMatchObject({ authority: "shadow_only", outcome: "proposed", reviews: [] });
    expect(result.plannerInput?.packages.map((pkg) => [
      pkg.packageKey,
      pkg.allocationRole,
    ])).toEqual([
      [packageBKey, "replacement_candidate"],
      [packageAKey, "primary"],
    ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
    expect(result.plannerInput?.sourceLines[0]).toMatchObject({
      physicalConsumptionAuthorityQuantity: 2,
      authorityVersion: 1,
    });
    expect(allocationShapes(result.plannerResult!)).toEqual([{
      allocationKind: "primary_transfer",
      targetKind: "package",
      packageKey: packageBKey,
      quantity: 2,
    }]);
    expect(result.plannerResult!.state.appliedActionKeys).toEqual([action.actionKey]);
    expect(result.plannerResult!.state.reviews).toEqual([]);
    expect(result.plannerResult!.state.desiredEffectIntents.filter(
      (intent) => intent.effectType === "commercial_fulfillment",
    ).map((intent) => intent.quantity)).toEqual([2]);
    expect(result.plannerResult!.state.desiredEffectIntents.filter(
      (intent) => intent.effectType === "inventory_consumption",
    ).map((intent) => intent.quantity)).toEqual([2]);
  });

  it("requires an audited action before treating exact B as a replacement for voided A", () => {
    const packageA = observedPackage("44001", {
      observedAt: "2026-08-21T14:00:00.000Z",
      voided: true,
    });
    const packageB = observedPackage("44002", {
      observedAt: "2026-08-21T14:06:00.000Z",
    });
    const result = resolvePackageAllocationAuthority(command([packageA, packageB]));

    expect(result.outcome).toBe("review");
    expect(result.reviews).toEqual([{
      code: "replacement_action_required",
      packageKeys: [
        packageAllocationPackageKey("shipstation", "44001"),
        packageAllocationPackageKey("shipstation", "44002"),
      ].sort(),
    }]);
    expect(result.plannerInput?.sourceLines[0].physicalConsumptionAuthorityQuantity).toBe(2);
    expect(allocationShapes(result.plannerResult!)).toEqual([{
      allocationKind: "primary_transfer",
      targetKind: "awaiting_relabel",
      packageKey: null,
      quantity: 2,
    }]);
    expect(result.plannerResult!.state.appliedActionKeys).toEqual([]);
    expect(result.plannerResult!.state.desiredEffectIntents.filter(
      (intent) => intent.effectType === "inventory_consumption",
    ).map((intent) => intent.quantity)).toEqual([2]);
  });

  it.each(["empty", "omitted"] as const)(
    "retains an extra package with %s contents for review and emits no item effect for it",
    (contentsStatus) => {
      const packageA = observedPackage("44001", {
        observedAt: "2026-08-21T14:00:00.000Z",
      });
      const packageB = observedPackage("44002", {
        observedAt: "2026-08-21T14:01:00.000Z",
        contentsStatus,
      });
      const packageBKey = packageAllocationPackageKey("shipstation", "44002");

      const result = resolvePackageAllocationAuthority(command([packageA, packageB]));

      expect(result.authority).toBe("shadow_only");
      expect(result.outcome).toBe("review");
      expect(result.plannerInput).not.toBeNull();
      expect(result.plannerResult).not.toBeNull();
      expect(result.reviews).toEqual([{
        code: "package_contents_unavailable",
        packageKeys: [packageBKey],
      }]);
      expect(result.plannerInput?.packages.find(
        (pkg) => pkg.packageKey === packageBKey,
      )).toMatchObject({
        allocationRole: "additional_dispatch",
        membership: { status: "unproven", evidenceKey: null },
      });
      expect(result.plannerInput?.sourceLines[0].physicalConsumptionAuthorityQuantity).toBe(2);
      expect(result.plannerResult!.state.packageSnapshots.some(
        (snapshot) => snapshot.packageKey === packageBKey,
      )).toBe(true);
      expect(result.plannerResult!.state.allocations.some(
        (entry) => entry.packageKey === packageBKey,
      )).toBe(false);
      expect(result.plannerResult!.state.desiredEffectIntents.some(
        (intent) => intent.packageKey === packageBKey && intent.wmsShipmentItemId !== null,
      )).toBe(false);
      expect(result.plannerResult!.state.reviews.map((review) => review.code)).toEqual([
        "package_membership_unproven",
      ]);
      expect(result.plannerResult!.state.desiredEffectIntents.every(
        (intent) => intent.executable === false,
      )).toBe(true);
    },
  );

  it("fails closed when two packages share the earliest observed label time", () => {
    const packageA = observedPackage("44001", {
      observedAt: "2026-08-21T14:00:00.000Z",
    });
    const packageB = observedPackage("44002", {
      observedAt: "2026-08-21T14:00:00.000Z",
    });

    expect(() => resolvePackageAllocationAuthority(command([packageA, packageB])))
      .toThrowError(expect.objectContaining<Partial<PackageAllocationAuthorityResolutionError>>({
        code: "AMBIGUOUS_PRIMARY_PACKAGE",
      }));
  });

  it("is deterministic across package, lifecycle-event, and action order", () => {
    const packageA = observedPackage("44001", {
      observedAt: "2026-08-21T14:00:00.000Z",
      voided: true,
    });
    const packageAReversed = observedPackage("44001", {
      observedAt: "2026-08-21T14:00:00.000Z",
      voided: true,
      reverseEvents: true,
    });
    const packageB = observedPackage("44002", {
      observedAt: "2026-08-21T14:06:00.000Z",
    });
    const action = transferAction(
      packageAllocationPackageKey("shipstation", "44001"),
      packageAllocationPackageKey("shipstation", "44002"),
    );

    const forward = resolvePackageAllocationAuthority(command([packageA, packageB], [action]));
    const reversed = resolvePackageAllocationAuthority(command(
      [packageB, packageAReversed],
      [...[action]].reverse(),
    ));

    expect(reversed.scopeHash).toBe(forward.scopeHash);
    expect(reversed.plannerResult?.stateHash).toBe(forward.plannerResult?.stateHash);
    expect(reversed.plannerResult?.evidenceHash).toBe(forward.plannerResult?.evidenceHash);
    expect(reversed.plannerResult?.state).toEqual(forward.plannerResult?.state);
  });

  it("exact-replays the resolved group without version or authority drift", () => {
    const packages = [
      observedPackage("44001", { observedAt: "2026-08-21T14:00:00.000Z" }),
      observedPackage("44002", { observedAt: "2026-08-21T14:01:00.000Z" }),
    ] as const;
    const initial = resolvePackageAllocationAuthority(command(packages));
    const replay = resolvePackageAllocationAuthority(command(packages, [], {
      expectedGroupVersion: initial.plannerResult!.proposedGroupVersion,
      previousPlan: previousPlanFrom(initial.plannerResult!),
    }));

    expect(replay.plannerResult).toMatchObject({
      outcome: "unchanged",
      proposedGroupVersion: initial.plannerResult!.proposedGroupVersion,
      stateHash: initial.plannerResult!.stateHash,
    });
    expect(replay.plannerInput?.sourceLines).toEqual(initial.plannerInput?.sourceLines);
    expect(replay.plannerInput?.packages.map((pkg) => pkg.allocationRole)).toEqual(
      initial.plannerInput?.packages.map((pkg) => pkg.allocationRole),
    );
    expect(replay.plannerResult?.ledgerEntriesToAppend).toEqual([]);
    expect(replay.plannerResult?.effectIntentsToAppend).toEqual([]);
  });

  it("does not mutate input and deeply freezes the resolved contract", () => {
    const input = command([
      observedPackage("44001", { observedAt: "2026-08-21T14:00:00.000Z" }),
      observedPackage("44002", { observedAt: "2026-08-21T14:01:00.000Z" }),
    ]);
    const before = structuredClone(input);
    const result = resolvePackageAllocationAuthority(input);

    expect(input).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reviews)).toBe(true);
    expect(Object.isFrozen(result.plannerInput)).toBe(true);
    expect(Object.isFrozen(result.plannerInput?.packages)).toBe(true);
    expect(Object.isFrozen(result.plannerResult)).toBe(true);
    expect(Object.isFrozen(result.plannerResult?.state.allocations)).toBe(true);
  });

  it("rejects duplicate evidence keys with a classified error", () => {
    const packageA = observedPackage("44001", {
      observedAt: "2026-08-21T14:00:00.000Z",
    });
    const packageB = {
      ...observedPackage("44002", { observedAt: "2026-08-21T14:01:00.000Z" }),
      evidenceKey: packageA.evidenceKey,
    };

    expect(() => resolvePackageAllocationAuthority(command([packageA, packageB])))
      .toThrowError(expect.objectContaining<Partial<PackageAllocationAuthorityResolutionError>>({
        code: "DUPLICATE_EVIDENCE_KEY",
        context: { evidenceKey: packageA.evidenceKey },
      }));
  });
});
