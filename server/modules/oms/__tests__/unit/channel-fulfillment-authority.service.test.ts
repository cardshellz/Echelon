import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  ChannelFulfillmentAuthorityRepository,
  ClaimedChannelFulfillmentCommand,
} from "../../channel-fulfillment-authority.repository";
import {
  calculateChannelFulfillmentRetryAt,
  createChannelFulfillmentAuthorityService,
  createCompatibilityChannelFulfillmentProviderExecutor,
} from "../../channel-fulfillment-authority.service";

function command(overrides: Partial<ClaimedChannelFulfillmentCommand> = {}): ClaimedChannelFulfillmentCommand {
  return {
    id: 41,
    commandKey: "fulfillment:v1:shopify:100:200:order",
    requestHash: "a".repeat(64),
    omsOrderId: 100,
    physicalShipmentId: 200,
    channelProvider: "shopify",
    channelFulfillmentScopeKey: "order",
    trackingNumber: "1ZTEST",
    carrier: "UPS",
    trackingUrl: null,
    shippedAt: new Date("2026-07-22T12:00:00.000Z"),
    attemptNumber: 1,
    maxAttempts: 12,
    leaseToken: "lease-1",
    metadata: Object.freeze({ legacyWmsShipmentIds: [501] }),
    items: Object.freeze([{
      physicalShipmentItemId: 300,
      packageAllocationEntryId: null,
      shipmentRequestItemId: 250,
      legacyWmsShipmentId: 501,
      legacyWmsShipmentItemId: 700,
      omsOrderLineId: 101,
      channelOrderLineId: "gid://shopify/LineItem/1",
      quantity: 2,
    }]),
    ...overrides,
  };
}

function repositoryMock(
  claimed: readonly ClaimedChannelFulfillmentCommand[],
): ChannelFulfillmentAuthorityRepository {
  return {
    resolveLegacyPhysicalPackage: vi.fn(),
    materializePhysicalPackage: vi.fn(),
    materializePackageAllocationCommercialFulfillment: vi.fn(),
    activatePackageAllocationCommercialFulfillment: vi.fn(),
    claimCommands: vi.fn().mockResolvedValue(claimed),
    completeAttempt: vi.fn().mockResolvedValue(undefined),
  };
}

describe("channel fulfillment authority service", () => {
  it("materializes, projects, and activates exact package-allocation commands without remote dispatch", async () => {
    const repository = repositoryMock([]);
    vi.mocked(repository.materializePackageAllocationCommercialFulfillment).mockResolvedValue({
      packageAllocationPlanId: "501",
      physicalShipmentIds: Object.freeze([202, 201]),
      channelCommands: Object.freeze([
        { id: 302, commandKey: "command-302", pushStatus: "shadow", replayed: false },
        { id: 301, commandKey: "command-301", pushStatus: "shadow", replayed: false },
      ]),
      customerFulfillmentItemCount: 2,
      replayed: false,
    });
    vi.mocked(repository.activatePackageAllocationCommercialFulfillment).mockResolvedValue({
      packageAllocationPlanId: "501",
      commandIds: Object.freeze([301, 302]),
      activatedCommandCount: 2,
      replayed: false,
    });
    const projector = { projectPhysicalShipment: vi.fn().mockResolvedValue(undefined) };
    const providerExecutor = { execute: vi.fn() };
    const activatedAt = new Date("2026-09-02T14:30:00.000Z");
    const service = createChannelFulfillmentAuthorityService({
      repository,
      projector,
      providerExecutor,
      clock: { now: () => activatedAt },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.materializeAndActivatePackageAllocationCommercialFulfillment({
      packageAllocationPlanId: "501",
      source: "shipstation_label_observed",
      correlationId: "shipping-provider-label:42",
      causationId: "shipstation-shipment:44001",
      activatedBy: "system:test",
      activationReason: "Prove label-time activation",
    });

    expect(result.activation).toMatchObject({ commandIds: [301, 302], replayed: false });
    expect(projector.projectPhysicalShipment.mock.calls).toEqual([[202], [201]]);
    expect(repository.activatePackageAllocationCommercialFulfillment).toHaveBeenCalledWith({
      packageAllocationPlanId: "501",
      activatedBy: "system:test",
      reason: "Prove label-time activation",
      activatedAt,
      correlationId: "shipping-provider-label:42",
      causationId: "shipstation-shipment:44001",
    });
    expect(repository.claimCommands).not.toHaveBeenCalled();
    expect(providerExecutor.execute).not.toHaveBeenCalled();
  });

  it("derives OMS order authority from exact OMS-line lineage, not a legacy aggregate cast", () => {
    const repositorySource = readFileSync(
      resolve(__dirname, "../../channel-fulfillment-authority.repository.ts"),
      "utf8",
    );

    expect(repositorySource).toContain("oms_order.id AS oms_order_id");
    expect(repositorySource).toContain("oms_order.external_order_id AS oms_external_order_id");
    expect(repositorySource).not.toContain("wms_order.oms_fulfillment_order_id::bigint");
  });

  it("locks fulfillment plan lines before aggregating shipped quantity", () => {
    const repositorySource = readFileSync(
      resolve(__dirname, "../../channel-fulfillment-authority.repository.ts"),
      "utf8",
    );
    const recalculateSource = repositorySource.match(
      /async function recalculatePlanLine[\s\S]*?(?=\nasync function findLineWritebackEligibility)/,
    )?.[0];

    expect(recalculateSource).toBeDefined();
    expect(recalculateSource).toMatch(
      /FROM wms\.fulfillment_plan_lines AS line[\s\S]*FOR UPDATE OF line/,
    );
    expect(recalculateSource).toMatch(
      /SUM\(item\.quantity_shipped\)[\s\S]*FROM wms\.effective_physical_shipment_items AS item/,
    );
    expect(recalculateSource).not.toMatch(/GROUP BY[\s\S]*FOR UPDATE/);
    expect(repositorySource).toContain(
      ")].sort((left, right) => left - right);",
    );
  });

  it("excludes suppressed providers before evaluating channel writeback policy", () => {
    const repositorySource = readFileSync(
      resolve(__dirname, "../../channel-fulfillment-authority.repository.ts"),
      "utf8",
    );
    const materializationSource = repositorySource.match(
      /async function materializePhysicalPackage[\s\S]*?(?=\n  async function claimCommands)/,
    )?.[0];

    expect(materializationSource).toBeDefined();
    expect(materializationSource).toMatch(
      /const writebackCandidateItems = input\.suppressChannelWriteback[\s\S]*?materializedCustomerItems\.filter\([\s\S]*?suppressChannelProviders/,
    );
    expect(materializationSource).toMatch(
      /findLineWritebackEligibility\(\s*tx,\s*writebackCandidateItems,\s*\)/,
    );
    expect(materializationSource).not.toMatch(
      /findLineWritebackEligibility\(\s*tx,\s*materializedCustomerItems,\s*\)/,
    );
  });

  it("passes historical channel suppression through legacy shipment materialization", async () => {
    const repository = repositoryMock([]);
    vi.mocked(repository.resolveLegacyPhysicalPackage).mockResolvedValue({
      legacyWmsShipmentIds: [501],
      shippingProvider: "shipstation",
      providerPhysicalShipmentId: "physical-1",
      providerOrderId: "order-1",
      providerOrderKey: "key-1",
      trackingNumber: "1ZTEST",
      carrier: "UPS",
      trackingUrl: null,
      serviceCode: null,
      shippedAt: new Date("2026-07-22T12:00:00.000Z"),
      source: "shipstation",
      correlationId: null,
      causationId: null,
      legacyHeaderPolicy: "strict",
    });
    vi.mocked(repository.materializePhysicalPackage).mockResolvedValue({
      physicalShipmentId: 200,
      shipmentRequestId: 201,
      fulfillmentPlanIds: Object.freeze([202]),
      channelCommands: Object.freeze([]),
      replayed: false,
    });
    const projector = { projectPhysicalShipment: vi.fn().mockResolvedValue(undefined) };
    const service = createChannelFulfillmentAuthorityService({
      repository,
      projector,
      providerExecutor: { execute: vi.fn() },
    });

    await service.ensureLegacyShipment(501, {
      source: "script:historical-refund-authority-repair",
      suppressChannelWriteback: true,
      suppressChannelProviders: ["shopify"],
    });

    expect(repository.materializePhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "script:historical-refund-authority-repair",
        suppressChannelWriteback: true,
        suppressChannelProviders: ["shopify"],
      }),
    );
    expect(projector.projectPhysicalShipment).toHaveBeenCalledWith(200);
  });

  it("completes a leased command only after its provider succeeds", async () => {
    const repository = repositoryMock([command()]);
    const providerExecutor = {
      execute: vi.fn().mockResolvedValue({
        outcome: "success" as const,
        providerResponseId: "gid://shopify/Fulfillment/1",
        metadata: Object.freeze({ verified: true }),
      }),
    };
    const now = new Date("2026-07-22T12:00:00.000Z");
    const service = createChannelFulfillmentAuthorityService({
      repository,
      providerExecutor,
      clock: { now: () => now },
      createLeaseToken: () => "lease-1",
    });

    const result = await service.runDueBatch({ commandIds: [41], limit: 1 });

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, retryScheduled: 0 });
    expect(providerExecutor.execute).toHaveBeenCalledWith(expect.objectContaining({ id: 41 }));
    expect(repository.completeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 41,
      leaseToken: "lease-1",
      outcome: "success",
      providerResponseId: "gid://shopify/Fulfillment/1",
    }));
  });

  it("schedules deterministic exponential retry after a transient failure", async () => {
    const repository = repositoryMock([command({ attemptNumber: 3 })]);
    const providerExecutor = {
      execute: vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
    };
    const now = new Date("2026-07-22T12:00:00.000Z");
    const service = createChannelFulfillmentAuthorityService({
      repository,
      providerExecutor,
      clock: { now: () => now },
      createLeaseToken: () => "lease-1",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.runDueBatch({ limit: 1 });

    expect(result.retryScheduled).toBe(1);
    expect(repository.completeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "retry_scheduled",
      errorCode: "ETIMEDOUT",
      nextAttemptAt: new Date("2026-07-22T12:04:00.000Z"),
    }));
  });

  it("moves deterministic invalid provider input to review without retrying", async () => {
    const repository = repositoryMock([command()]);
    const providerExecutor = {
      execute: vi.fn().mockRejectedValue(Object.assign(new Error("invalid line"), {
        context: { code: "shopify_push_invalid_input" },
      })),
    };
    const service = createChannelFulfillmentAuthorityService({
      repository,
      providerExecutor,
      createLeaseToken: () => "lease-1",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.runDueBatch({ limit: 1 });

    expect(result.reviewRequired).toBe(1);
    expect(repository.completeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "review_required",
      errorCode: "shopify_push_invalid_input",
    }));
  });

  it("dead-letters the final transient attempt", async () => {
    const repository = repositoryMock([command({ attemptNumber: 12, maxAttempts: 12 })]);
    const service = createChannelFulfillmentAuthorityService({
      repository,
      providerExecutor: { execute: vi.fn().mockRejectedValue(new Error("provider unavailable")) },
      createLeaseToken: () => "lease-1",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.runDueBatch({ limit: 1 });

    expect(result.deadLettered).toBe(1);
    expect(repository.completeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "dead_lettered",
      nextAttemptAt: null,
    }));
  });

  it("uses exact sorted legacy shipment lineage in the Shopify compatibility adapter", async () => {
    const pushShopifyFulfillmentForCommand = vi.fn()
      .mockResolvedValue({
        shopifyFulfillmentId: "gid://shopify/Fulfillment/1",
        alreadyPushed: false,
        writebackComplete: true,
      });
    const executor = createCompatibilityChannelFulfillmentProviderExecutor({
      pushShopifyFulfillmentForCommand,
    });

    const result = await executor.execute(command({
      metadata: Object.freeze({ legacyWmsShipmentIds: [502, 501, 502] }),
      items: Object.freeze([
        {
          physicalShipmentItemId: 301,
          packageAllocationEntryId: null,
          shipmentRequestItemId: 251,
          legacyWmsShipmentId: 502,
          legacyWmsShipmentItemId: 701,
          omsOrderLineId: 102,
          channelOrderLineId: "gid://shopify/LineItem/2",
          quantity: 1,
        },
        {
          physicalShipmentItemId: 300,
          packageAllocationEntryId: null,
          shipmentRequestItemId: 250,
          legacyWmsShipmentId: 501,
          legacyWmsShipmentItemId: 700,
          omsOrderLineId: 101,
          channelOrderLineId: "gid://shopify/LineItem/1",
          quantity: 2,
        },
      ]),
    }));

    expect(pushShopifyFulfillmentForCommand).toHaveBeenCalledTimes(1);
    expect(pushShopifyFulfillmentForCommand).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 41,
      legacyWmsShipmentIds: [501, 502],
      trackingNumber: "1ZTEST",
      items: [
        expect.objectContaining({
          legacyWmsShipmentId: 501,
          legacyWmsShipmentItemId: 700,
          quantity: 2,
        }),
        expect.objectContaining({
          legacyWmsShipmentId: 502,
          legacyWmsShipmentItemId: 701,
          quantity: 1,
        }),
      ],
    }));
    expect(result).toMatchObject({
      outcome: "success",
      providerResponseId: "gid://shopify/Fulfillment/1",
    });
  });

  it("sends one eBay fulfillment for a physical package spanning legacy shipment rows", async () => {
    const pushTrackingForShipmentCommand = vi.fn().mockResolvedValue(true);
    const executor = createCompatibilityChannelFulfillmentProviderExecutor({
      pushTrackingForShipmentCommand,
    });

    const result = await executor.execute(command({
      channelProvider: "ebay",
      metadata: Object.freeze({ legacyWmsShipmentIds: [502, 501] }),
      items: Object.freeze([
        {
          physicalShipmentItemId: 300,
          packageAllocationEntryId: null,
          shipmentRequestItemId: 250,
          legacyWmsShipmentId: 501,
          legacyWmsShipmentItemId: 700,
          omsOrderLineId: 101,
          channelOrderLineId: "line-1",
          quantity: 2,
        },
        {
          physicalShipmentItemId: 301,
          packageAllocationEntryId: null,
          shipmentRequestItemId: 251,
          legacyWmsShipmentId: 502,
          legacyWmsShipmentItemId: 701,
          omsOrderLineId: 102,
          channelOrderLineId: "line-2",
          quantity: 1,
        },
      ]),
    }));

    expect(pushTrackingForShipmentCommand).toHaveBeenCalledTimes(1);
    expect(pushTrackingForShipmentCommand).toHaveBeenCalledWith(expect.objectContaining({
      legacyWmsShipmentIds: [501, 502],
      items: [
        expect.objectContaining({ legacyWmsShipmentItemId: 700, quantity: 2 }),
        expect.objectContaining({ legacyWmsShipmentItemId: 701, quantity: 1 }),
      ],
    }));
    expect(result).toMatchObject({ outcome: "success", providerResponseId: null });
  });

  it("rejects command items outside the immutable physical-package shipment set", async () => {
    const executor = createCompatibilityChannelFulfillmentProviderExecutor({
      pushShopifyFulfillmentForCommand: vi.fn(),
    });

    await expect(executor.execute(command({
      metadata: Object.freeze({ legacyWmsShipmentIds: [999] }),
    }))).rejects.toMatchObject({
      code: "channel_fulfillment_lineage_mismatch",
    });
  });

  it("caps retry delay at six hours", () => {
    const completedAt = new Date("2026-07-22T12:00:00.000Z");
    expect(calculateChannelFulfillmentRetryAt(completedAt, 20)).toEqual(
      new Date("2026-07-22T18:00:00.000Z"),
    );
  });
});
