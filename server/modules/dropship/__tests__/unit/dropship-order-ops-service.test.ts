import { describe, expect, it } from "vitest";
import {
  DROPSHIP_ALL_INTAKE_STATUSES,
  DROPSHIP_OPS_DEFAULT_INTAKE_STATUSES,
  DropshipOrderOpsService,
  type DropshipLogEvent,
  type DropshipOrderOpsActionResult,
  type DropshipOrderOpsIntakeListResult,
  type DropshipOrderOpsRepository,
} from "../../application";

const now = new Date("2026-05-02T12:00:00.000Z");

describe("DropshipOrderOpsService", () => {
  it("lists operationally risky order intake states by default", async () => {
    const repository = new FakeOrderOpsRepository();
    const service = new DropshipOrderOpsService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.listIntakes({
      page: 2,
      limit: 25,
      search: "EXT-1",
    });

    expect(result.items[0].intakeId).toBe(1);
    expect(repository.lastListInput).toMatchObject({
      page: 2,
      limit: 25,
      search: "EXT-1",
      statuses: DROPSHIP_OPS_DEFAULT_INTAKE_STATUSES,
    });
  });

  it("preserves explicit statuses for vendor order history reads", async () => {
    const repository = new FakeOrderOpsRepository();
    const service = new DropshipOrderOpsService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await service.listIntakes({
      vendorId: 10,
      statuses: DROPSHIP_ALL_INTAKE_STATUSES,
      page: 1,
      limit: 50,
    });

    expect(repository.lastListInput).toMatchObject({
      vendorId: 10,
      statuses: DROPSHIP_ALL_INTAKE_STATUSES,
    });
  });

  it("loads scoped order detail for vendor dogfooding reads", async () => {
    const repository = new FakeOrderOpsRepository();
    const service = new DropshipOrderOpsService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.getIntakeDetail({
      intakeId: 1,
      vendorId: 10,
    });

    expect(result.lines).toEqual([
      expect.objectContaining({
        sku: "SKU-1",
        quantity: 2,
        unitRetailPriceCents: 1299,
        lineRetailTotalCents: 2598,
      }),
    ]);
    expect(repository.lastDetailInput).toMatchObject({
      intakeId: 1,
      vendorId: 10,
    });
  });

  it("rejects invalid detail input before repository access", async () => {
    const repository = new FakeOrderOpsRepository();
    const service = new DropshipOrderOpsService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await expect(service.getIntakeDetail({
      intakeId: 0,
      vendorId: 10,
    })).rejects.toMatchObject({ code: "DROPSHIP_ORDER_OPS_DETAIL_INVALID_INPUT" });
    expect(repository.lastDetailInput).toBeNull();
  });

  it("requests retry with actor, clock, idempotency, and audit log context", async () => {
    const repository = new FakeOrderOpsRepository();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderOpsService({
      repository,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.retryIntake({
      intakeId: 7,
      reason: "rate config repaired",
      idempotencyKey: "retry-intake-7",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result).toMatchObject({ intakeId: 7, previousStatus: "failed", status: "retrying" });
    expect(repository.lastRetryInput).toMatchObject({
      intakeId: 7,
      reason: "rate config repaired",
      idempotencyKey: "retry-intake-7",
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_ORDER_OPS_RETRY_REQUESTED",
      context: {
        intakeId: 7,
        previousStatus: "failed",
        status: "retrying",
        idempotencyKey: "retry-intake-7",
      },
    });
  });

  it("marks an order intake as an ops exception", async () => {
    const repository = new FakeOrderOpsRepository();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderOpsService({
      repository,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.markException({
      intakeId: 9,
      reason: "marketplace cancellation failed",
      idempotencyKey: "exception-intake-9",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result).toMatchObject({ intakeId: 9, previousStatus: "failed", status: "exception" });
    expect(repository.lastExceptionInput).toMatchObject({
      intakeId: 9,
      reason: "marketplace cancellation failed",
      idempotencyKey: "exception-intake-9",
      now,
    });
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_ORDER_OPS_EXCEPTION_MARKED" });
  });

  it("rejects invalid action input before repository calls", async () => {
    const repository = new FakeOrderOpsRepository();
    const service = new DropshipOrderOpsService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await expect(service.retryIntake({
      intakeId: 0,
      idempotencyKey: "retry-intake-7",
      actor: { actorType: "admin" },
    })).rejects.toMatchObject({ code: "DROPSHIP_ORDER_OPS_RETRY_INVALID_INPUT" });
    expect(repository.lastRetryInput).toBeNull();
  });
});

class FakeOrderOpsRepository implements DropshipOrderOpsRepository {
  lastListInput: Parameters<DropshipOrderOpsRepository["listIntakes"]>[0] | null = null;
  lastDetailInput: Parameters<DropshipOrderOpsRepository["getIntakeDetail"]>[0] | null = null;
  lastRetryInput: Parameters<DropshipOrderOpsRepository["retryIntake"]>[0] | null = null;
  lastExceptionInput: Parameters<DropshipOrderOpsRepository["markException"]>[0] | null = null;

  async listIntakes(
    input: Parameters<DropshipOrderOpsRepository["listIntakes"]>[0],
  ): Promise<DropshipOrderOpsIntakeListResult> {
    this.lastListInput = input;
    return {
      items: [makeListItem()],
      total: 1,
      page: input.page,
      limit: input.limit,
      statuses: input.statuses,
      summary: [{ status: "failed", count: 1 }],
    };
  }

  async getIntakeDetail(
    input: Parameters<DropshipOrderOpsRepository["getIntakeDetail"]>[0],
  ): Promise<Awaited<ReturnType<DropshipOrderOpsRepository["getIntakeDetail"]>>> {
    this.lastDetailInput = input;
    return {
      ...makeListItem(),
      sourceOrderId: "gid://shopify/Order/1",
      orderedAt: "2026-05-02T11:30:00.000Z",
      marketplaceStatus: "paid",
      totals: {
        retailSubtotalCents: 2598,
        shippingPaidCents: 599,
        taxCents: 0,
        discountCents: 0,
        grandTotalCents: 3197,
        currency: "USD",
      },
      lines: [{
        lineIndex: 0,
        externalLineItemId: "line-1",
        externalListingId: "listing-1",
        externalOfferId: null,
        sku: "SKU-1",
        productVariantId: 123,
        quantity: 2,
        unitRetailPriceCents: 1299,
        lineRetailTotalCents: 2598,
        title: "Card Shell",
      }],
      economicsSnapshot: null,
      shippingQuoteSnapshot: null,
      walletLedgerEntry: null,
      auditEvents: [],
    };
  }

  async retryIntake(
    input: Parameters<DropshipOrderOpsRepository["retryIntake"]>[0],
  ): Promise<DropshipOrderOpsActionResult> {
    this.lastRetryInput = input;
    return {
      intakeId: input.intakeId,
      previousStatus: "failed",
      status: "retrying",
      idempotentReplay: false,
      updatedAt: input.now,
    };
  }

  async markException(
    input: Parameters<DropshipOrderOpsRepository["markException"]>[0],
  ): Promise<DropshipOrderOpsActionResult> {
    this.lastExceptionInput = input;
    return {
      intakeId: input.intakeId,
      previousStatus: "failed",
      status: "exception",
      idempotentReplay: false,
      updatedAt: input.now,
    };
  }
}

function makeListItem(): DropshipOrderOpsIntakeListResult["items"][number] {
  return {
    intakeId: 1,
    vendor: {
      vendorId: 10,
      memberId: "member-1",
      businessName: "Vendor",
      email: "vendor@example.com",
      status: "active",
      entitlementStatus: "active",
    },
    storeConnection: {
      storeConnectionId: 22,
      platform: "shopify",
      status: "connected",
      setupStatus: "ready",
      externalDisplayName: "Shop",
      shopDomain: "shop.example.com",
    },
    platform: "shopify",
    externalOrderId: "EXT-1",
    externalOrderNumber: "1001",
    status: "failed",
    paymentHoldExpiresAt: null,
    rejectionReason: "Missing rate",
    cancellationStatus: null,
    omsOrderId: null,
    receivedAt: now,
    acceptedAt: null,
    updatedAt: now,
    lineCount: 1,
    totalQuantity: 2,
    shipTo: { country: "US", postalCode: "10001" },
    latestAuditEvent: null,
  };
}

function captureLogger(logs: DropshipLogEvent[]) {
  return {
    info: (event: DropshipLogEvent) => logs.push(event),
    warn: (event: DropshipLogEvent) => logs.push(event),
    error: (event: DropshipLogEvent) => logs.push(event),
  };
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
