import { describe, expect, it, vi } from "vitest";

import {
  buildHistoricalSplitRepairComponents,
  HISTORICAL_SPLIT_REPAIR_SOURCE,
  historicalSplitRunId,
  parseHistoricalProviderPackage,
  runHistoricalShipStationSplitRepair,
  type HistoricalSplitRepairDependencies,
  type HistoricalSplitRepairFlags,
  type HistoricalSplitRepairPackagePlan,
  type HistoricalSplitRetryCandidate,
} from "../../historical-shipstation-split-repair.service";

function providerShipment(overrides: Record<string, unknown> = {}): any {
  return {
    shipmentId: 442730042,
    orderId: 755802673,
    orderKey: "echelon-wms-shp-4842",
    orderNumber: "#59564",
    trackingNumber: "9400150106151288520521",
    carrierCode: "stamps_com",
    serviceCode: "usps_ground_advantage",
    shipDate: "2026-06-28T14:10:00.000Z",
    voidDate: null,
    isReturnLabel: false,
    shipmentItems: [
      { lineItemKey: "wms-item-9001", quantity: 1 },
      { lineItemKey: "wms-item-9002", quantity: 2 },
    ],
    ...overrides,
  };
}

function flags(overrides: Partial<HistoricalSplitRepairFlags> = {}): HistoricalSplitRepairFlags {
  return {
    mode: "dry-run",
    limit: 25,
    providerShipmentId: null,
    confirmCount: null,
    operator: null,
    reason: null,
    idempotencyKey: null,
    delayMs: 0,
    json: true,
    ...overrides,
  };
}

function candidate(id = 442730042): HistoricalSplitRetryCandidate {
  return Object.freeze({ providerShipmentId: id, retryIds: Object.freeze([115755, 115720]) });
}

function packagePlan(id: number, sourceIds: number[]): HistoricalSplitRepairPackagePlan {
  return Object.freeze({
    providerPackage: Object.freeze({
      providerShipmentId: id,
      providerOrderId: 700000000 + id,
      providerOrderKey: `key-${id}`,
      orderNumber: `#${id}`,
      trackingNumber: `tracking-${id}`,
      carrierCode: "stamps_com",
      serviceCode: "usps_ground_advantage",
      shippedAt: new Date("2026-06-28T14:10:00.000Z"),
      items: Object.freeze(sourceIds.map((sourceShipmentItemId) =>
        Object.freeze({ sourceShipmentItemId, quantity: 1 })
      )),
    }),
    retryIds: Object.freeze([id]),
  });
}

function dependencies(
  overrides: Partial<HistoricalSplitRepairDependencies> = {},
): HistoricalSplitRepairDependencies {
  return {
    loadRetryCandidates: vi.fn(async () => [candidate()]),
    lookupProviderShipment: vi.fn(async () => providerShipment()),
    inspectPackages: vi.fn(async (packages) => ({
      alreadyCanonical: Object.freeze([]),
      repairableComponents: buildHistoricalSplitRepairComponents(packages),
      unsafe: Object.freeze([]),
    })),
    applyComponent: vi.fn(async (component) => component.packages.map((plan) => ({
      providerShipmentId: plan.providerPackage.providerShipmentId,
      legacyWmsShipmentIds: Object.freeze([7001]),
      wmsOrderIds: Object.freeze([8001]),
    }))),
    reconcileProviderPackage: vi.fn(async () => ({
      providerLabelLinkCount: 1,
      dispatchEvidence: "confirmed" as const,
      dispatchCommandCreated: true,
      trackingHydrationError: null,
    })),
    finalizeMappedPackage: vi.fn(async () => undefined),
    finalizeRepairedPackage: vi.fn(async () => undefined),
    finalizeNonOutboundPackage: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    now: () => new Date("2026-07-30T12:00:00.000Z"),
    log: vi.fn(),
    ...overrides,
  };
}

describe("historical ShipStation split repair", () => {
  it("uses a persisted source value that fits outbound_shipments.source", () => {
    expect(HISTORICAL_SPLIT_REPAIR_SOURCE.length).toBeLessThanOrEqual(30);
  });

  it("parses and aggregates exact positive wms-item package evidence", () => {
    const parsed = parseHistoricalProviderPackage(providerShipment({
      shipmentItems: [
        { lineItemKey: "wms-item-9001", quantity: 1 },
        { lineItemKey: "wms-item-9001", quantity: 2 },
        { lineItemKey: "wms-item-9002", quantity: 1 },
      ],
    }));
    expect(parsed.providerShipmentId).toBe(442730042);
    expect(parsed.items).toEqual([
      { sourceShipmentItemId: 9001, quantity: 3 },
      { sourceShipmentItemId: 9002, quantity: 1 },
    ]);
  });

  it.each([
    [{ shipmentItems: [] }, "PROVIDER_PACKAGE_ITEMS_MISSING"],
    [{ shipmentItems: [{ lineItemKey: "sku-only", quantity: 1 }] }, "PROVIDER_PACKAGE_ITEM_IDENTITY_INCOMPLETE"],
    [{ shipmentItems: [{ lineItemKey: "wms-item-9001", quantity: 0 }] }, "PROVIDER_PACKAGE_ITEM_IDENTITY_INCOMPLETE"],
    [{ trackingNumber: "" }, "PROVIDER_PACKAGE_IDENTITY_INCOMPLETE"],
  ])("rejects incomplete provider proof %#", (override, code) => {
    expect(() => parseHistoricalProviderPackage(providerShipment(override))).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("groups packages sharing any source item into one atomic component", () => {
    const components = buildHistoricalSplitRepairComponents([
      packagePlan(10, [1]),
      packagePlan(11, [1, 2]),
      packagePlan(12, [2]),
      packagePlan(20, [9]),
    ]);
    expect(components.map((component) =>
      component.packages.map((plan) => plan.providerPackage.providerShipmentId)
    )).toEqual([[10, 11, 12], [20]]);
  });

  it("performs no persistence during dry-run", async () => {
    const deps = dependencies();
    const summary = await runHistoricalShipStationSplitRepair(flags(), deps);
    expect(summary.repairable).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(deps.applyComponent).not.toHaveBeenCalled();
    expect(deps.reconcileProviderPackage).not.toHaveBeenCalled();
    expect(deps.finalizeRepairedPackage).not.toHaveBeenCalled();
  });

  it("rejects execute when the selected cohort changed", async () => {
    const deps = dependencies();
    await expect(runHistoricalShipStationSplitRepair(flags({
      mode: "execute",
      confirmCount: 2,
      operator: "owner@cardshellz.com",
      reason: "historical repair",
      idempotencyKey: "historical-repair-1",
    }), deps)).rejects.toThrow("does not match selected dry-run count 1");
    expect(deps.lookupProviderShipment).not.toHaveBeenCalled();
  });

  it("links exact provider evidence before clearing historical split failures", async () => {
    const deps = dependencies();
    const summary = await runHistoricalShipStationSplitRepair(flags({
      mode: "execute",
      confirmCount: 1,
      operator: "owner@cardshellz.com",
      reason: "historical repair",
      idempotencyKey: "historical-repair-1",
    }), deps);
    expect(summary).toMatchObject({
      repaired: 1,
      providerLabelsLinked: 1,
      dispatchConfirmed: 1,
      dispatchCommandsCreated: 1,
      trackingDeferred: 0,
    });
    expect(deps.reconcileProviderPackage).toHaveBeenCalledTimes(1);
    expect(deps.finalizeMappedPackage).toHaveBeenCalledWith(
      expect.objectContaining({ providerShipmentId: 442730042 }),
      expect.any(Object),
      expect.objectContaining({
        providerLabelLinkCount: 1,
        dispatchEvidence: "confirmed",
      }),
      expect.objectContaining({
        operator: "owner@cardshellz.com",
        reason: "historical repair",
        runId: historicalSplitRunId("historical-repair-1"),
      }),
    );
    expect(deps.finalizeRepairedPackage).not.toHaveBeenCalled();
  });

  it("does not clear split failures when exact provider linkage cannot be proven", async () => {
    const deps = dependencies({
      reconcileProviderPackage: vi.fn(async () => ({
        providerLabelLinkCount: 0,
        dispatchEvidence: null,
        dispatchCommandCreated: false,
        trackingHydrationError: null,
      })),
    });
    const summary = await runHistoricalShipStationSplitRepair(flags({
      mode: "execute",
      confirmCount: 1,
      operator: "owner@cardshellz.com",
      reason: "historical repair",
      idempotencyKey: "historical-repair-link-failure",
    }), deps);
    expect(summary.repaired).toBe(0);
    expect(summary.failures).toEqual([
      expect.objectContaining({ code: "PROVIDER_LABEL_LINKAGE_NOT_PROVEN" }),
    ]);
    expect(deps.finalizeMappedPackage).not.toHaveBeenCalled();
  });

  it("records deferred carrier hydration without losing proven package mapping", async () => {
    const deps = dependencies({
      reconcileProviderPackage: vi.fn(async () => ({
        providerLabelLinkCount: 1,
        dispatchEvidence: null,
        dispatchCommandCreated: false,
        trackingHydrationError: "temporary provider timeout",
      })),
    });
    const summary = await runHistoricalShipStationSplitRepair(flags({
      mode: "execute",
      confirmCount: 1,
      operator: "owner@cardshellz.com",
      reason: "historical repair",
      idempotencyKey: "historical-repair-deferred-tracking",
    }), deps);
    expect(summary).toMatchObject({ repaired: 1, trackingDeferred: 1, dispatchConfirmed: 0 });
    expect(deps.finalizeMappedPackage).toHaveBeenCalledTimes(1);
  });

  it("resolves a return label without reshaping outbound fulfillment", async () => {
    const deps = dependencies({
      lookupProviderShipment: vi.fn(async () => providerShipment({ isReturnLabel: true })),
    });
    const summary = await runHistoricalShipStationSplitRepair(flags({
      mode: "execute",
      confirmCount: 1,
      operator: "owner@cardshellz.com",
      reason: "historical repair",
      idempotencyKey: "historical-repair-return",
    }), deps);
    expect(summary.returnLabels).toBe(1);
    expect(deps.finalizeNonOutboundPackage).toHaveBeenCalledWith(
      candidate(), expect.any(Object), "return_label", expect.any(Object),
    );
    expect(deps.inspectPackages).not.toHaveBeenCalled();
    expect(deps.applyComponent).not.toHaveBeenCalled();
  });
  it("resolves a voided label without reshaping fulfillment", async () => {
    const deps = dependencies({
      lookupProviderShipment: vi.fn(async () => providerShipment({
        voidDate: "2026-06-29T10:00:00.000Z",
      })),
    });
    const summary = await runHistoricalShipStationSplitRepair(flags({
      mode: "execute",
      confirmCount: 1,
      operator: "owner@cardshellz.com",
      reason: "historical repair",
      idempotencyKey: "historical-repair-void",
    }), deps);
    expect(summary.voided).toBe(1);
    expect(deps.finalizeNonOutboundPackage).toHaveBeenCalledWith(
      candidate(), expect.any(Object), "voided", expect.any(Object),
    );
    expect(deps.inspectPackages).not.toHaveBeenCalled();
    expect(deps.applyComponent).not.toHaveBeenCalled();
  });
});