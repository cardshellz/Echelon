import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipStoreWebhookRepairService,
  type DropshipStoreWebhookRepairCredentials,
  type DropshipStoreWebhookRepairRepository,
} from "../../application/dropship-store-webhook-repair-service";
import type { DropshipStoreConnectionPostConnectProvider } from "../../application/dropship-store-connection-service";

const now = new Date("2026-05-03T23:00:00.000Z");

describe("DropshipStoreWebhookRepairService", () => {
  it("repairs Shopify webhooks with stored credentials and records an audit trail", async () => {
    const repository = new FakeWebhookRepairRepository();
    const provider = new FakePostConnectProvider();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipStoreWebhookRepairService({
      repository,
      postConnectProvider: provider,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.repairShopifyWebhooks({
      storeConnectionId: 22,
      idempotencyKey: "repair-webhooks-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result).toEqual({
      storeConnectionId: 22,
      vendorId: 10,
      platform: "shopify",
      shopDomain: "vendor-shop.myshopify.com",
      repairedAt: now,
    });
    expect(repository.lastLoadInput).toEqual({ storeConnectionId: 22 });
    expect(provider.calls).toEqual([{
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      shopDomain: "vendor-shop.myshopify.com",
      accessToken: "shopify-token",
      connectedAt: now,
    }]);
    expect(repository.lastAuditInput).toEqual({
      vendorId: 10,
      storeConnectionId: 22,
      shopDomain: "vendor-shop.myshopify.com",
      idempotencyKey: "repair-webhooks-1",
      actor: { actorType: "admin", actorId: "admin-1" },
      repairedAt: now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_SHOPIFY_WEBHOOK_REPAIR_COMPLETED",
      context: {
        vendorId: 10,
        storeConnectionId: 22,
        idempotencyKey: "repair-webhooks-1",
      },
    });
  });

  it("rejects invalid repair input before loading credentials", async () => {
    const repository = new FakeWebhookRepairRepository();
    const service = new DropshipStoreWebhookRepairService({
      repository,
      postConnectProvider: new FakePostConnectProvider(),
      clock: { now: () => now },
      logger: captureLogger([]),
    });

    await expect(service.repairShopifyWebhooks({
      storeConnectionId: 0,
      idempotencyKey: "short",
      actor: { actorType: "admin" },
    })).rejects.toMatchObject({
      code: "DROPSHIP_STORE_WEBHOOK_REPAIR_INVALID_INPUT",
    } satisfies Partial<DropshipError>);
    expect(repository.lastLoadInput).toBeNull();
  });

  it("does not record successful audit when Shopify repair fails", async () => {
    const repository = new FakeWebhookRepairRepository();
    const provider = new FakePostConnectProvider(new DropshipError(
      "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_HTTP_ERROR",
      "Shopify rejected webhook repair.",
      { retryable: true },
    ));
    const service = new DropshipStoreWebhookRepairService({
      repository,
      postConnectProvider: provider,
      clock: { now: () => now },
      logger: captureLogger([]),
    });

    await expect(service.repairShopifyWebhooks({
      storeConnectionId: 22,
      idempotencyKey: "repair-webhooks-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({
      code: "DROPSHIP_SHOPIFY_WEBHOOK_SUBSCRIPTION_HTTP_ERROR",
    } satisfies Partial<DropshipError>);
    expect(repository.lastAuditInput).toBeNull();
  });
});

class FakeWebhookRepairRepository implements DropshipStoreWebhookRepairRepository {
  credentials: DropshipStoreWebhookRepairCredentials = {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "shopify",
    shopDomain: "vendor-shop.myshopify.com",
    accessToken: "shopify-token",
  };
  lastLoadInput: Parameters<DropshipStoreWebhookRepairRepository["loadShopifyStoreConnectionForWebhookRepair"]>[0] | null = null;
  lastAuditInput: Parameters<DropshipStoreWebhookRepairRepository["recordShopifyWebhookRepair"]>[0] | null = null;

  async loadShopifyStoreConnectionForWebhookRepair(
    input: Parameters<DropshipStoreWebhookRepairRepository["loadShopifyStoreConnectionForWebhookRepair"]>[0],
  ): Promise<DropshipStoreWebhookRepairCredentials> {
    this.lastLoadInput = input;
    return this.credentials;
  }

  async recordShopifyWebhookRepair(
    input: Parameters<DropshipStoreWebhookRepairRepository["recordShopifyWebhookRepair"]>[0],
  ): Promise<void> {
    this.lastAuditInput = input;
  }
}

class FakePostConnectProvider implements DropshipStoreConnectionPostConnectProvider {
  calls: Array<Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0]> = [];

  constructor(private readonly error: Error | null = null) {}

  async afterStoreConnected(
    input: Parameters<DropshipStoreConnectionPostConnectProvider["afterStoreConnected"]>[0],
  ): Promise<void> {
    this.calls.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

function captureLogger(logs: DropshipLogEvent[]) {
  return {
    info: (event: DropshipLogEvent) => logs.push(event),
    warn: (event: DropshipLogEvent) => logs.push(event),
    error: (event: DropshipLogEvent) => logs.push(event),
  };
}
