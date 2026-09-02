import { describe, expect, it, vi } from "vitest";

import { PackageAllocationBootstrapPersistenceError } from "../../package-allocation-bootstrap.service";
import { PackageAllocationPersistenceError } from "../../package-allocation-planning.service";
import {
  PackageAllocationLabelCommercialFulfillmentService,
} from "../../package-allocation-label-commercial-fulfillment.service";

function fixture(enabled = true) {
  const labelLinker = {
    reconcileShipStationLabel: vi.fn().mockResolvedValue({
      shippingProviderLabelId: 42,
      linksInserted: 1,
      totalLinks: 1,
    }),
  };
  const bootstrap = {
    persistDiscovered: vi.fn().mockResolvedValue({
      contractVersion: 1,
      authority: "shadow_only",
      groupKey: "11111111-1111-8111-8111-111111111111",
      outcome: "persisted",
      reviewReason: null,
      selectedShippingProviderLabelIds: [42],
      relationshipSelectionEvidence: {},
      readiness: {},
      resolution: { reviews: [] },
      persistence: { kind: "created", planId: "501" },
    }),
  };
  const fulfillmentAuthority = {
    materializeAndActivatePackageAllocationCommercialFulfillment: vi.fn().mockResolvedValue({
      materialized: {
        packageAllocationPlanId: "501",
        physicalShipmentIds: [201],
        channelCommands: [{ id: 301, pushStatus: "shadow" }],
        customerFulfillmentItemCount: 1,
        replayed: false,
      },
      activation: {
        packageAllocationPlanId: "501",
        commandIds: [301],
        activatedCommandCount: 1,
        replayed: false,
      },
    }),
  };
  const reviewRepository = { record: vi.fn().mockResolvedValue(undefined) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new PackageAllocationLabelCommercialFulfillmentService({
    enabled,
    labelLinker,
    bootstrap: bootstrap as any,
    fulfillmentAuthority: fulfillmentAuthority as any,
    reviewRepository,
    logger,
  });
  return { service, labelLinker, bootstrap, fulfillmentAuthority, reviewRepository, logger };
}

const observation = {
  shippingProviderLabelId: 42,
  labelInserted: true,
  eventInserted: true,
};

function shipment(overrides: Record<string, unknown> = {}) {
  return {
    shipmentId: 44001,
    orderId: 55001,
    orderKey: "echelon-wms-shp-7001",
    orderNumber: "#1001",
    trackingNumber: "1ZTEST",
    isReturnLabel: false,
    voidDate: null,
    shipmentItems: [{ lineItemKey: "wms-item-70001", quantity: 1 }],
    ...overrides,
  };
}

describe("PackageAllocationLabelCommercialFulfillmentService", () => {
  it("reconciles label lineage, persists an exact plan, and activates its commands", async () => {
    const f = fixture();

    const result = await f.service.process(shipment(), observation);

    expect(result).toEqual({
      outcome: "activated",
      planId: "501",
      commandIds: [301],
      replayed: false,
    });
    expect(f.labelLinker.reconcileShipStationLabel).toHaveBeenCalledWith("44001");
    expect(f.bootstrap.persistDiscovered).toHaveBeenCalledWith(expect.objectContaining({
      authorityMode: "shadow_only",
      bootstrapMode: "relationship_discovery",
      sourceWmsShipmentItemIds: [70001],
    }));
    expect(f.fulfillmentAuthority.materializeAndActivatePackageAllocationCommercialFulfillment)
      .toHaveBeenCalledWith(expect.objectContaining({
        packageAllocationPlanId: "501",
        source: "shipstation_label_observed",
        correlationId: "shipping-provider-label:42",
        causationId: "shipstation-shipment:44001",
      }));
    expect(f.reviewRepository.record).not.toHaveBeenCalled();
  });

  it("records review and performs no plan or channel write when provider contents are not exact", async () => {
    const f = fixture();

    const result = await f.service.process(shipment({ shipmentItems: [] }), observation);

    expect(result).toEqual({ outcome: "review", reason: "provider_contents_not_authoritative" });
    expect(f.reviewRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      shippingProviderLabelId: 42,
      providerShipmentId: "44001",
      reasonCode: "provider_contents_not_authoritative",
      sourceWmsShipmentItemIds: [],
    }));
    expect(f.labelLinker.reconcileShipStationLabel).not.toHaveBeenCalled();
    expect(f.bootstrap.persistDiscovered).not.toHaveBeenCalled();
    expect(f.fulfillmentAuthority.materializeAndActivatePackageAllocationCommercialFulfillment)
      .not.toHaveBeenCalled();
  });

  it("records deterministic package-allocation review instead of retrying a blocked label", async () => {
    const f = fixture();
    f.bootstrap.persistDiscovered.mockResolvedValue({
      outcome: "review",
      reviewReason: null,
      selectedShippingProviderLabelIds: [42],
      readiness: {},
      resolution: { reviews: [{ code: "package_contents_unavailable" }] },
      persistence: null,
    });

    const result = await f.service.process(shipment(), observation);

    expect(result).toEqual({ outcome: "review", reason: "package_contents_unavailable" });
    expect(f.reviewRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "package_contents_unavailable",
      sourceWmsShipmentItemIds: [70001],
    }));
    expect(f.fulfillmentAuthority.materializeAndActivatePackageAllocationCommercialFulfillment)
      .not.toHaveBeenCalled();
  });

  it("routes an existing multi-version group to review", async () => {
    const f = fixture();
    f.bootstrap.persistDiscovered.mockRejectedValue(
      new PackageAllocationBootstrapPersistenceError(
        "EXISTING_GROUP_REQUIRES_VERSIONED_REPLAY",
        "Versioned replay required",
        { groupKey: "group-1", currentVersion: 2 },
      ),
    );

    await expect(f.service.process(shipment(), observation)).resolves.toEqual({
      outcome: "review",
      reason: "EXISTING_GROUP_REQUIRES_VERSIONED_REPLAY",
    });
    expect(f.reviewRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "EXISTING_GROUP_REQUIRES_VERSIONED_REPLAY",
    }));
  });

  it("routes changed evidence against an existing plan to review instead of endless retry", async () => {
    const f = fixture();
    f.bootstrap.persistDiscovered.mockRejectedValue(
      new PackageAllocationPersistenceError(
        "STALE_GROUP_VERSION",
        "The package-allocation group is already at version one",
        { expectedGroupVersion: 0, actualGroupVersion: 1 },
      ),
    );

    await expect(f.service.process(shipment(), observation)).resolves.toEqual({
      outcome: "review",
      reason: "STALE_GROUP_VERSION",
    });
    expect(f.reviewRepository.record).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "STALE_GROUP_VERSION",
    }));
  });

  it("leaves return, voided, and emergency-disabled labels inert", async () => {
    const disabled = fixture(false);
    await expect(disabled.service.process(shipment(), observation)).resolves.toEqual({
      outcome: "disabled",
      reason: "activation_disabled",
    });
    expect(disabled.bootstrap.persistDiscovered).not.toHaveBeenCalled();

    const active = fixture();
    await expect(active.service.process(shipment({ isReturnLabel: true }), observation))
      .resolves.toEqual({ outcome: "skipped", reason: "return_label" });
    await expect(active.service.process(shipment({ voidDate: "2026-09-02T14:00:00Z" }), observation))
      .resolves.toEqual({ outcome: "skipped", reason: "voided_label" });
    expect(active.bootstrap.persistDiscovered).not.toHaveBeenCalled();
  });

  it("rethrows unexpected infrastructure failures so the webhook retry path can recover", async () => {
    const f = fixture();
    f.labelLinker.reconcileShipStationLabel.mockRejectedValue(new Error("database unavailable"));

    await expect(f.service.process(shipment(), observation)).rejects.toThrow("database unavailable");
    expect(f.reviewRepository.record).not.toHaveBeenCalled();
  });
});
