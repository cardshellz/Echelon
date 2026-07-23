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
    claimCommands: vi.fn().mockResolvedValue(claimed),
    completeAttempt: vi.fn().mockResolvedValue(undefined),
  };
}

describe("channel fulfillment authority service", () => {
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
      /SUM\(item\.quantity_shipped\)[\s\S]*FROM wms\.physical_shipment_items AS item/,
    );
    expect(recalculateSource).not.toMatch(/GROUP BY[\s\S]*FOR UPDATE/);
    expect(repositorySource).toContain(
      ")].sort((left, right) => left - right);",
    );
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
          shipmentRequestItemId: 251,
          legacyWmsShipmentId: 502,
          legacyWmsShipmentItemId: 701,
          omsOrderLineId: 102,
          channelOrderLineId: "gid://shopify/LineItem/2",
          quantity: 1,
        },
        {
          physicalShipmentItemId: 300,
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
          shipmentRequestItemId: 250,
          legacyWmsShipmentId: 501,
          legacyWmsShipmentItemId: 700,
          omsOrderLineId: 101,
          channelOrderLineId: "line-1",
          quantity: 2,
        },
        {
          physicalShipmentItemId: 301,
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
