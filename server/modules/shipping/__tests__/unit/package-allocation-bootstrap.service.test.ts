import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { describe, expect, it, vi } from "vitest";

import { SHIPSTATION_LABEL_OBSERVATION_SOURCE } from "../../carrier-tracking.domain";
import { packageAllocationPackageKey } from "../../package-allocation-authority-resolution.domain";
import {
  derivePackageAllocationBootstrapGroupKey,
  PackageAllocationBootstrapPersistenceError,
  PackageAllocationBootstrapPersistenceService,
} from "../../package-allocation-bootstrap.service";
import {
  PackageAllocationLedgerRepositoryError,
  type LockedPackageAllocationAuthorityEvidence,
  type PackageAllocationLedgerRepository,
  type PackageAllocationLedgerTransaction,
} from "../../package-allocation-ledger.repository";
import type { PackageAllocationSourceFacts } from "../../package-allocation-source-identity.domain";

const sourceId = 7_001;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceFacts(): PackageAllocationSourceFacts {
  return Object.freeze({
    sourceWmsShipmentItemId: sourceId,
    shipmentRequestItemId: "97001",
    sourceQuantity: 2,
    shipmentItemPurpose: "customer_fulfillment",
    orderItemId: 87_001,
    replacementForOrderItemId: null,
    correctionForShipmentItemId: null,
    productVariantId: 77_001,
    orderItemSku: "SKU-7001",
    replacementOrderItemSku: null,
    productVariantSku: "SKU-7001",
  });
}

function lockedPackage(contentsStatus: "authoritative" | "empty" = "authoritative"):
LockedPackageAllocationAuthorityEvidence {
  const providerPhysicalShipmentId = "44001";
  const trackingNumber = "1Z0000000000044001";
  const observedAt = "2026-09-01T15:00:00.000Z";
  const authoritative = contentsStatus === "authoritative";
  const payload = {
    payloadSchemaVersion: 2 as const,
    providerLabelId: providerPhysicalShipmentId,
    trackingNumber,
    observationSource: SHIPSTATION_LABEL_OBSERVATION_SOURCE,
    sourceObservationHash: "a".repeat(64),
    createDate: null,
    shipDate: null,
    voidDate: null,
    isReturnLabel: false,
    declaredContentsEvidence: {
      evidenceSchemaVersion: 1 as const,
      status: contentsStatus,
      providerItemCount: authoritative ? 1 : 0,
      recognizedProviderItemCount: authoritative ? 1 : 0,
      canonicalLineCount: authoritative ? 1 : 0,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
      rejectedItemCount: 0,
      reviewRequired: !authoritative,
      lines: authoritative
        ? [{ lineItemKey: `wms-item-${sourceId}`, quantity: 2 }]
        : [],
    },
  };
  return Object.freeze({
    evidenceKey: "shipping-provider-label:42",
    persistedEvidence: Object.freeze({
      shippingProviderLabelId: 42,
      provider: "shipstation",
      providerPhysicalShipmentId,
      currentTrackingNumber: trackingNumber,
      currentLabelStatus: "active",
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      labelDirection: "outbound",
      labelEvents: Object.freeze([Object.freeze({
        id: 542,
        shippingProviderLabelId: 42,
        eventHash: sha256(canonicalJson({
          provider: "shipstation",
          ...payload,
          labelStatus: "active",
        })),
        eventType: "label_observed",
        labelStatus: "active",
        trackingNumber,
        providerOccurredAt: observedAt,
        sanitizedPayload: payload,
        receivedAt: observedAt,
      })]),
      confirmedCarrierEvents: Object.freeze([]),
    }),
  });
}

function command() {
  return {
    contractVersion: 1 as const,
    authorityMode: "shadow_only" as const,
    bootstrapMode: "relationship_discovery" as const,
    sourceWmsShipmentItemIds: [sourceId],
    writeContext: {
      createdBy: "system:package_allocation_bootstrap",
      reason: "Persist locked relationship-discovered package authority",
    },
  };
}

function fixture(options: {
  readonly packageEvidence?: LockedPackageAllocationAuthorityEvidence;
  readonly currentVersion?: number;
  readonly conflictsBeforeSuccess?: number;
  readonly discoverPackages?: boolean;
} = {}) {
  const calls: string[] = [];
  const pkg = options.packageEvidence ?? lockedPackage();
  const groupKey = derivePackageAllocationBootstrapGroupKey([sourceId]);
  const transaction = {
    lockGroup: vi.fn(async (requestedKey: string, createIfMissing: boolean) => {
      calls.push(`group:${requestedKey}:${createIfMissing}`);
      if (options.currentVersion === undefined) return null;
      return { id: "1", groupKey: requestedKey, currentVersion: options.currentVersion };
    }),
    lockSourceFacts: vi.fn(async (ids: readonly number[]) => {
      calls.push(`sources:${ids.join(",")}`);
      return [sourceFacts()];
    }),
    discoverAuthorityReadinessPackageSelection: vi.fn(async (ids: readonly number[]) => {
      calls.push(`discover:${ids.join(",")}`);
      if (options.discoverPackages === false) return [];
      return [{
        shippingProviderLabelId: 42,
        relationshipTypes: ["shipping_engine_order_link", "provider_order_id_match"],
      }];
    }),
    lockAuthorityReadinessPackages: vi.fn(async (ids: readonly number[]) => {
      calls.push(`packages:${ids.join(",")}`);
      return [pkg];
    }),
  } as unknown as PackageAllocationLedgerTransaction;
  const planning = {
    persistInTransaction: vi.fn(async () => ({
      kind: "created" as const,
      groupId: "1",
      planId: "101",
      persistedPlanVersion: 1,
      currentGroupVersion: 1,
      plannerResult: {} as any,
    })),
  };
  let attempts = 0;
  const repository: PackageAllocationLedgerRepository = {
    withSerializableTransaction: async (work) => {
      attempts += 1;
      if (attempts <= (options.conflictsBeforeSuccess ?? 0)) {
        throw new PackageAllocationLedgerRepositoryError(
          "CONCURRENT_WRITE",
          "synthetic serialization conflict",
        );
      }
      return work(transaction);
    },
  };
  return {
    calls,
    groupKey,
    planning,
    repository,
    transaction,
    attempts: () => attempts,
  };
}

describe("PackageAllocationBootstrapPersistenceService", () => {
  it("locks discovered evidence and persists one inert resolved plan with provenance", async () => {
    const f = fixture();
    const result = await new PackageAllocationBootstrapPersistenceService(
      f.repository,
      f.planning,
    ).persistDiscovered(command());

    expect(result).toMatchObject({
      authority: "shadow_only",
      groupKey: f.groupKey,
      outcome: "persisted",
      selectedShippingProviderLabelIds: [42],
      persistence: { kind: "created", planId: "101" },
    });
    expect(f.calls).toEqual([
      `group:${f.groupKey}:false`,
      `sources:${sourceId}`,
      `discover:${sourceId}`,
      "packages:42",
    ]);
    expect(f.planning.persistInTransaction).toHaveBeenCalledTimes(1);
    expect(f.planning.persistInTransaction).toHaveBeenCalledWith(
      f.transaction,
      expect.objectContaining({
        groupKey: f.groupKey,
        expectedGroupVersion: 0,
        actions: [],
        writeContext: command().writeContext,
      }),
      expect.objectContaining({
        authorityMode: "shadow_only",
        selectionAuthority: "database_relationship_closure",
        selectionCompleteness: "unproven_outside_persisted_relationships",
        relationshipSelectionEvidence: expect.objectContaining({
          evidenceType: "package_allocation_relationship_selection",
          packages: [{
            shippingProviderLabelId: 42,
            relationshipTypes: [
              "provider_order_id_match",
              "shipping_engine_order_link",
            ],
          }],
        }),
      }),
    );
    expect(result.resolution?.plannerResult.state.desiredEffectIntents.every(
      (intent) => intent.executable === false,
    )).toBe(true);
  });

  it("returns review without creating a group or plan when contents are not authoritative", async () => {
    const f = fixture({ packageEvidence: lockedPackage("empty") });
    const result = await new PackageAllocationBootstrapPersistenceService(
      f.repository,
      f.planning,
    ).persistDiscovered(command());

    expect(result.outcome).toBe("review");
    expect(result.persistence).toBeNull();
    expect(result.resolution?.outcome).toBe("review");
    expect(result.resolution?.reviews).toEqual([{
      code: "package_contents_unavailable",
      packageKeys: [packageAllocationPackageKey("shipstation", "44001")],
    }]);
    expect(f.planning.persistInTransaction).not.toHaveBeenCalled();
    expect(f.transaction.lockGroup).toHaveBeenCalledTimes(1);
    expect(f.transaction.lockGroup).toHaveBeenCalledWith(f.groupKey, false);
  });

  it("returns review without requesting an invalid empty package lock", async () => {
    const f = fixture({ discoverPackages: false });
    const result = await new PackageAllocationBootstrapPersistenceService(
      f.repository,
      f.planning,
    ).persistDiscovered(command());

    expect(result).toMatchObject({
      outcome: "review",
      reviewReason: "no_related_packages_discovered",
      selectedShippingProviderLabelIds: [],
      readiness: null,
      resolution: null,
      persistence: null,
    });
    expect(f.transaction.lockAuthorityReadinessPackages).not.toHaveBeenCalled();
    expect(f.planning.persistInTransaction).not.toHaveBeenCalled();
  });

  it("retries bounded serialization conflicts and re-runs all locked reads", async () => {
    const f = fixture({ conflictsBeforeSuccess: 2 });
    const result = await new PackageAllocationBootstrapPersistenceService(
      f.repository,
      f.planning,
    ).persistDiscovered(command());

    expect(result.outcome).toBe("persisted");
    expect(f.attempts()).toBe(3);
    expect(f.transaction.lockSourceFacts).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate source identities before opening a transaction", async () => {
    const f = fixture();
    await expect(new PackageAllocationBootstrapPersistenceService(
      f.repository,
      f.planning,
    ).persistDiscovered({
      ...command(),
      sourceWmsShipmentItemIds: [sourceId, sourceId],
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PackageAllocationBootstrapPersistenceError);
      expect(error).toMatchObject({
        code: "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      });
      return true;
    });
    expect(f.attempts()).toBe(0);
  });

  it("refuses to bootstrap over a multi-version group history", async () => {
    const f = fixture({ currentVersion: 2 });
    await expect(new PackageAllocationBootstrapPersistenceService(
      f.repository,
      f.planning,
    ).persistDiscovered(command())).rejects.toMatchObject({
      code: "EXISTING_GROUP_REQUIRES_VERSIONED_REPLAY",
      context: { groupKey: f.groupKey, currentVersion: 2 },
    });
    expect(f.transaction.lockSourceFacts).not.toHaveBeenCalled();
    expect(f.planning.persistInTransaction).not.toHaveBeenCalled();
  });

  it("derives one stable group key from the sorted source identity set", () => {
    const derived = derivePackageAllocationBootstrapGroupKey([9, 2, 5]);
    expect(derived).toBe(derivePackageAllocationBootstrapGroupKey([5, 9, 2]));
    expect(derived).toBe("932486fe-67f7-8213-b61d-130f4fc3051b");
    expect(derived).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("rejects invalid or duplicate group-key inputs", () => {
    expect(() => derivePackageAllocationBootstrapGroupKey([])).toThrowError(
      expect.objectContaining({ code: "INVALID_BOOTSTRAP_COMMAND" }),
    );
    expect(() => derivePackageAllocationBootstrapGroupKey([2, 2])).toThrowError(
      expect.objectContaining({
        code: "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      }),
    );
  });
});
