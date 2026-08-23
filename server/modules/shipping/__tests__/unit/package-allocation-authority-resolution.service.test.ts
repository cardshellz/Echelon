import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";

import { SHIPSTATION_LABEL_OBSERVATION_SOURCE } from "../../carrier-tracking.domain";
import type { PersistedDeclaredPackageEvidence } from "../../declared-package-lifecycle-shadow.domain";
import {
  packageAllocationPackageKey,
} from "../../package-allocation-authority-resolution.domain";
import {
  PackageAllocationAuthorityResolutionPreviewService,
  PackageAllocationAuthorityResolutionPreviewServiceError,
  type PackageAllocationAuthorityResolutionPreviewCommand,
} from "../../package-allocation-authority-resolution.service";
import type {
  LockedPackageAllocationAuthorityEvidence,
  LockedPackageAllocationGroup,
  PackageAllocationLedgerRepository,
  PackageAllocationLedgerTransaction,
} from "../../package-allocation-ledger.repository";
import type { PackageAllocationSourceFacts } from "../../package-allocation-source-identity.domain";

const groupKey = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";
const sourceId = 7_001;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceFacts(id = sourceId): PackageAllocationSourceFacts {
  return Object.freeze({
    sourceWmsShipmentItemId: id,
    shipmentRequestItemId: String(90_000 + id),
    sourceQuantity: 2,
    shipmentItemPurpose: "customer_fulfillment",
    orderItemId: 80_000 + id,
    replacementForOrderItemId: null,
    correctionForShipmentItemId: null,
    productVariantId: 70_000 + id,
    orderItemSku: `SKU-${id}`,
    replacementOrderItemSku: null,
    productVariantSku: `SKU-${id}`,
  });
}

type ContentsStatus = "authoritative" | "empty" | "omitted";

interface PersistedPackageOptions {
  readonly shippingProviderLabelId: number;
  readonly providerPhysicalShipmentId: string;
  readonly observedAt: string;
  readonly contentsStatus?: ContentsStatus;
  readonly provider?: string;
}

function declaredContentsEvidence(status: ContentsStatus) {
  const authoritative = status === "authoritative";
  return {
    evidenceSchemaVersion: 1 as const,
    status,
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
  };
}

function persistedPackage(
  options: PersistedPackageOptions,
): PersistedDeclaredPackageEvidence {
  const status = options.contentsStatus ?? "authoritative";
  const trackingNumber = `1Z${options.providerPhysicalShipmentId.padStart(16, "0")}`;
  const payload = {
    payloadSchemaVersion: 2 as const,
    providerLabelId: options.providerPhysicalShipmentId,
    trackingNumber,
    observationSource: SHIPSTATION_LABEL_OBSERVATION_SOURCE,
    sourceObservationHash: "a".repeat(64),
    createDate: null,
    shipDate: null,
    voidDate: null,
    isReturnLabel: false,
    declaredContentsEvidence: declaredContentsEvidence(status),
  };
  const provider = options.provider ?? "shipstation";
  return Object.freeze({
    shippingProviderLabelId: options.shippingProviderLabelId,
    provider,
    providerPhysicalShipmentId: options.providerPhysicalShipmentId,
    currentTrackingNumber: trackingNumber,
    currentLabelStatus: "active",
    firstObservedAt: options.observedAt,
    lastObservedAt: options.observedAt,
    labelDirection: "outbound",
    labelEvents: Object.freeze([
      Object.freeze({
        id: 500 + options.shippingProviderLabelId,
        shippingProviderLabelId: options.shippingProviderLabelId,
        eventHash: sha256(
          canonicalJson({ provider, ...payload, labelStatus: "active" }),
        ),
        eventType: "label_observed",
        labelStatus: "active",
        trackingNumber,
        providerOccurredAt: options.observedAt,
        sanitizedPayload: payload,
        receivedAt: options.observedAt,
      }),
    ]),
    confirmedCarrierEvents: Object.freeze([]),
  });
}

function lockedPackage(
  options: PersistedPackageOptions,
): LockedPackageAllocationAuthorityEvidence {
  return Object.freeze({
    evidenceKey: `shipping-provider-label:${options.shippingProviderLabelId}`,
    persistedEvidence: persistedPackage(options),
  });
}

function command(): PackageAllocationAuthorityResolutionPreviewCommand {
  return {
    contractVersion: 1,
    authorityMode: "shadow_only",
    previewMode: "bootstrap_selected_scope",
    groupKey,
    sourceWmsShipmentItemIds: [sourceId],
    shippingProviderLabelIds: [43, 42],
  };
}

function discoveryCommand() {
  return {
    contractVersion: 1 as const,
    authorityMode: "shadow_only" as const,
    previewMode: "bootstrap_relationship_discovery" as const,
    groupKey,
    sourceWmsShipmentItemIds: [sourceId],
  };
}

interface RepositoryFixture {
  readonly repository: PackageAllocationLedgerRepository;
  readonly calls: string[];
}

function repositoryFixture(
  packages: readonly LockedPackageAllocationAuthorityEvidence[],
  group: LockedPackageAllocationGroup | null = null,
): RepositoryFixture {
  const calls: string[] = [];
  const unexpectedWrite = async (): Promise<never> => {
    throw new Error("preview must not call ledger persistence");
  };
  const transaction = {
    lockGroup: async (requestedGroupKey: string, createIfMissing: boolean) => {
      calls.push(`group:${requestedGroupKey}:${String(createIfMissing)}`);
      return group;
    },
    lockSourceFacts: async (ids: readonly number[]) => {
      calls.push(`sources:${ids.join(",")}`);
      return ids.map(sourceFacts);
    },
    discoverAuthorityReadinessPackageLabelIds: async (ids: readonly number[]) => {
      calls.push(`discover:${ids.join(",")}`);
      return [42, 43];
    },
    lockAuthorityReadinessPackages: async (ids: readonly number[]) => {
      calls.push(`labels:${ids.join(",")}`);
      return packages;
    },
    ensureSourceRegistrations: unexpectedWrite,
    ensurePackageBindings: unexpectedWrite,
    loadPlanByVersion: unexpectedWrite,
    loadPlanByInputHash: unexpectedWrite,
    loadPlanEntries: unexpectedWrite,
    loadPlanIntents: unexpectedWrite,
    appendPlan: unexpectedWrite,
  } as unknown as PackageAllocationLedgerTransaction;
  return {
    calls,
    repository: {
      withSerializableTransaction: async (work) => {
        calls.push("transaction");
        return work(transaction);
      },
    },
  };
}

function activePackageA(): LockedPackageAllocationAuthorityEvidence {
  return lockedPackage({
    shippingProviderLabelId: 42,
    providerPhysicalShipmentId: "44001",
    observedAt: "2026-08-23T12:00:00.000Z",
  });
}

function activePackageB(
  contentsStatus: ContentsStatus = "authoritative",
): LockedPackageAllocationAuthorityEvidence {
  return lockedPackage({
    shippingProviderLabelId: 43,
    providerPhysicalShipmentId: "44002",
    observedAt: "2026-08-23T12:01:00.000Z",
    contentsStatus,
  });
}

describe("PackageAllocationAuthorityResolutionPreviewService", () => {
  it("discovers related package labels between source and package locks", async () => {
    const fixture = repositoryFixture([activePackageB(), activePackageA()]);
    const input = discoveryCommand();
    const before = structuredClone(input);

    const result = await new PackageAllocationAuthorityResolutionPreviewService(
      fixture.repository,
    ).previewDiscovered(input);

    expect(input).toEqual(before);
    expect(fixture.calls).toEqual([
      "transaction",
      `group:${groupKey}:false`,
      `sources:${sourceId}`,
      `discover:${sourceId}`,
      "labels:42,43",
    ]);
    expect(result).toMatchObject({
      contractVersion: 1,
      authority: "none",
      outcome: "review",
      previewMode: "bootstrap_relationship_discovery",
      selectionAuthority: "database_relationship_closure",
      selectionCompleteness: "unproven_outside_persisted_relationships",
      selectedShippingProviderLabelIds: [42, 43],
      groupState: "absent",
      readiness: {
        authority: "none",
        outcome: "review",
      },
      resolution: {
        authority: "shadow_only",
        outcome: "review",
      },
    });
    expect(result.resolution?.plannerResult.state.desiredEffectIntents.every(
      (intent) => intent.executable === false,
    )).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.selectedShippingProviderLabelIds)).toBe(true);
  });

  it("previews exact active A+B as two physical consumptions without double fulfillment", async () => {
    const fixture = repositoryFixture([activePackageB(), activePackageA()]);
    const input = command();
    const before = structuredClone(input);

    const result = await new PackageAllocationAuthorityResolutionPreviewService(
      fixture.repository,
    ).preview(input);

    expect(input).toEqual(before);
    expect(fixture.calls).toEqual([
      "transaction",
      `group:${groupKey}:false`,
      `sources:${sourceId}`,
      "labels:42,43",
    ]);
    expect(result).toMatchObject({
      contractVersion: 1,
      authority: "none",
      outcome: "review",
      previewMode: "bootstrap_selected_scope",
      selectionAuthority: "caller_selected_unproven",
      groupState: "absent",
      readiness: {
        authority: "none",
        outcome: "review",
      },
      resolution: {
        authority: "shadow_only",
        outcome: "review",
      },
    });
    const intents = result.resolution!.plannerResult.state.desiredEffectIntents;
    expect(intents.filter((intent) => intent.effectType === "commercial_fulfillment")
      .map((intent) => intent.quantity)).toEqual([2]);
    expect(intents.filter((intent) => intent.effectType === "inventory_consumption")
      .map((intent) => intent.quantity).sort()).toEqual([2, 2]);
    expect(intents.every((intent) => intent.executable === false)).toBe(true);
    expect(result.resolution!.plannerResult.state.allocations.map((entry) => ({
      allocationKind: entry.allocationKind,
      packageKey: entry.packageKey,
      quantity: entry.quantity,
    }))).toEqual([
      {
        allocationKind: "additional_physical_consumption",
        packageKey: packageAllocationPackageKey("shipstation", "44002"),
        quantity: 2,
      },
      {
        allocationKind: "primary_transfer",
        packageKey: packageAllocationPackageKey("shipstation", "44001"),
        quantity: 2,
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.resolution!.plannerResult.state)).toBe(true);
  });

  it.each(["empty", "omitted"] as const)(
    "retains exact package B with %s item evidence but grants it no item authority",
    async (contentsStatus) => {
      const fixture = repositoryFixture([
        activePackageA(),
        activePackageB(contentsStatus),
      ]);

      const result = await new PackageAllocationAuthorityResolutionPreviewService(
        fixture.repository,
      ).preview(command());

      const packageBKey = packageAllocationPackageKey("shipstation", "44002");
      expect(result.resolution).not.toBeNull();
      expect(result.resolution!.reviews).toEqual([{
        code: "package_contents_unavailable",
        packageKeys: [packageBKey],
      }]);
      expect(result.resolution!.plannerResult.state.packageSnapshots.some(
        (snapshot) => snapshot.packageKey === packageBKey,
      )).toBe(true);
      expect(result.resolution!.plannerResult.state.allocations.some(
        (entry) => entry.packageKey === packageBKey,
      )).toBe(false);
      expect(result.resolution!.plannerResult.state.desiredEffectIntents.some(
        (intent) =>
          intent.packageKey === packageBKey
          && intent.wmsShipmentItemId !== null,
      )).toBe(false);
    },
  );

  it("keeps all authority off when any selected package evidence is rejected", async () => {
    const rejectedPackage = lockedPackage({
      shippingProviderLabelId: 43,
      providerPhysicalShipmentId: "44002",
      observedAt: "2026-08-23T12:01:00.000Z",
      provider: "unsupported-provider",
    });
    const fixture = repositoryFixture([activePackageA(), rejectedPackage]);

    const result = await new PackageAllocationAuthorityResolutionPreviewService(
      fixture.repository,
    ).preview(command());

    expect(result).toMatchObject({
      authority: "none",
      outcome: "review",
      selectionAuthority: "caller_selected_unproven",
      resolution: null,
    });
    expect(result.readiness.packageAssessments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceKey: "shipping-provider-label:43",
        lifecycleStatus: "rejected",
        lifecycleRejectionReason: "unsupported_provider",
      }),
    ]));
  });

  it("rejects an existing nonzero group before loading source or package evidence", async () => {
    const fixture = repositoryFixture([activePackageA(), activePackageB()], {
      id: "101",
      groupKey,
      currentVersion: 2,
    });

    await expect(
      new PackageAllocationAuthorityResolutionPreviewService(
        fixture.repository,
      ).preview(command()),
    ).rejects.toMatchObject({
      code: "EXISTING_GROUP_REQUIRES_REPLAY",
      context: { groupKey, currentVersion: 2 },
    });
    expect(fixture.calls).toEqual([
      "transaction",
      `group:${groupKey}:false`,
    ]);
  });

  it("accepts an existing empty group without creating or persisting it", async () => {
    const fixture = repositoryFixture([activePackageA(), activePackageB()], {
      id: "101",
      groupKey,
      currentVersion: 0,
    });

    const result = await new PackageAllocationAuthorityResolutionPreviewService(
      fixture.repository,
    ).preview(command());

    expect(result.groupState).toBe("empty");
    expect(fixture.calls[1]).toBe(`group:${groupKey}:false`);
  });

  it("validates duplicate identities and sanitizes invalid literals before a transaction", async () => {
    let transactionCalls = 0;
    const service = new PackageAllocationAuthorityResolutionPreviewService({
      withSerializableTransaction: async () => {
        transactionCalls += 1;
        throw new Error("must not run");
      },
    });

    await expect(service.preview({
      ...command(),
      shippingProviderLabelIds: [42, 42],
    })).rejects.toMatchObject({
      code: "DUPLICATE_SHIPPING_PROVIDER_LABEL_ID",
      context: { shippingProviderLabelId: 42 },
    });
    await expect(service.preview({
      ...command(),
      sourceWmsShipmentItemIds: [sourceId, sourceId],
    })).rejects.toMatchObject({
      code: "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      context: { sourceWmsShipmentItemId: sourceId },
    });
    await expect(service.previewDiscovered({
      ...discoveryCommand(),
      sourceWmsShipmentItemIds: [sourceId, sourceId],
    })).rejects.toMatchObject({
      code: "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      context: { sourceWmsShipmentItemId: sourceId },
    });

    const sentinel = "ROOT_AUTHORITY_PREVIEW_SENTINEL";
    let error: unknown;
    try {
      await service.preview({
        ...command(),
        authorityMode: sentinel,
      } as unknown as PackageAllocationAuthorityResolutionPreviewCommand);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(
      PackageAllocationAuthorityResolutionPreviewServiceError,
    );
    expect(error).toMatchObject({
      code: "INVALID_AUTHORITY_RESOLUTION_PREVIEW_COMMAND",
    });
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(transactionCalls).toBe(0);
  });
});
