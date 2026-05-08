import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipApplicationPorts } from "../../application";
import {
  DROPSHIP_REQUIRED_USE_CASE_NAMES,
  createDropshipUseCaseRegistry,
  dropshipUseCaseDescriptors,
  validateDropshipUseCaseInput,
} from "../../application";

const transaction = { id: "txn-1" };

function expectDropshipError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(DropshipError);
  expect((error as DropshipError).code).toBe(code);
}

describe("Dropship V2 use-case registry", () => {
  it("exposes every required consolidated-design use case", () => {
    const registry = createDropshipUseCaseRegistry(makePorts());

    expect(Object.keys(registry).sort()).toEqual(
      [...DROPSHIP_REQUIRED_USE_CASE_NAMES].sort(),
    );
    expect(Object.keys(dropshipUseCaseDescriptors).sort()).toEqual(
      [...DROPSHIP_REQUIRED_USE_CASE_NAMES].sort(),
    );
  });

  it("requires transaction, idempotency, and audit policies for mutating use cases", () => {
    for (const name of DROPSHIP_REQUIRED_USE_CASE_NAMES) {
      const descriptor = dropshipUseCaseDescriptors[name];
      if (name === "GenerateVendorListingPreview") {
        expect(descriptor.transactionPolicy).toBe("read_only");
        expect(descriptor.idempotencyPolicy).toBe("not_required");
        expect(descriptor.auditPolicy).toBe("not_required");
        continue;
      }

      expect(descriptor.transactionPolicy).toBe("required");
      expect(descriptor.idempotencyPolicy).toBe("required");
      expect(descriptor.auditPolicy).toBe("required");
    }
  });

  it("documents external API mocks required by effectful use cases", () => {
    expect(dropshipUseCaseDescriptors.ProcessListingPushJob.externalApiMocksRequired).toEqual([
      "ebay",
      "shopify",
    ]);
    expect(dropshipUseCaseDescriptors.ProcessMarketplaceOrderCancellations.externalApiMocksRequired).toEqual([
      "ebay",
      "shopify",
    ]);
    expect(dropshipUseCaseDescriptors.CreditWalletFunding.externalApiMocksRequired).toEqual([
      "stripe",
      "usdc_base",
    ]);
    expect(dropshipUseCaseDescriptors.QuoteDropshipShipping.externalApiMocksRequired).toEqual([
      "carrier",
    ]);
    expect(dropshipUseCaseDescriptors.SendDropshipNotification.externalApiMocksRequired).toEqual([
      "email",
    ]);
    expect(dropshipUseCaseDescriptors.NotifyExpiringPaymentHolds.externalApiMocksRequired).toEqual([
      "email",
    ]);
  });
});

describe("Dropship V2 use-case DTO validation", () => {
  it("rejects raw ATP leakage on listing preview input", () => {
    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.GenerateVendorListingPreview,
        {
          vendorId: 1,
          storeConnectionId: 2,
          productVariantIds: [3],
          actor: { actorType: "vendor", actorId: "member-1" },
          rawAtpUnits: 500,
        },
      ),
    ).toThrow(DropshipError);
  });

  it("rejects fractional money and missing idempotency on wallet funding", () => {
    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.CreditWalletFunding,
        {
          vendorId: 1,
          walletAccountId: 2,
          amountCents: 10.5,
          referenceType: "stripe_payment_intent",
          referenceId: "pi_123",
          idempotencyKey: "funding-123",
        },
      ),
    ).toThrow(DropshipError);

    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.CreditWalletFunding,
        {
          vendorId: 1,
          walletAccountId: 2,
          amountCents: 1050,
          referenceType: "stripe_payment_intent",
          referenceId: "pi_123",
        },
      ),
    ).toThrow(DropshipError);
  });

  it("requires explicit timestamps for tracking pushes", () => {
    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.PushTrackingToVendorStore,
        {
          vendorId: 1,
          storeConnectionId: 2,
          intakeId: 3,
          carrier: "usps",
          trackingNumber: "9400",
          shippedAt: "2026-04-29T00:00:00.000Z",
          idempotencyKey: "tracking-123",
        },
      ),
    ).toThrow(DropshipError);
  });

  it("validates marketplace intake idempotency coordinates", () => {
    const parsed = validateDropshipUseCaseInput(
      dropshipUseCaseDescriptors.RecordMarketplaceOrderIntake,
      {
        vendorId: 1,
        storeConnectionId: 2,
        platform: "ebay",
        externalOrderId: "ORDER-1",
        rawPayload: { orderId: "ORDER-1" },
        payloadHash: "0123456789abcdef",
        idempotencyKey: "intake-ORDER-1",
      },
    );

    expect(parsed.storeConnectionId).toBe(2);
    expect(parsed.externalOrderId).toBe("ORDER-1");
  });

  it("validates order exception worker bounds", () => {
    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.RejectDropshipOrder,
        {
          intakeId: 1,
          vendorId: 1,
          reason: "no",
          idempotencyKey: "reject-order-123",
          actor: { actorType: "vendor", actorId: "member-1" },
        },
      ),
    ).toThrow(DropshipError);

    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.ProcessMarketplaceOrderCancellations,
        {
          workerId: "worker-1",
          limit: 501,
        },
      ),
    ).toThrow(DropshipError);

    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.NotifyExpiringPaymentHolds,
        {
          workerId: "worker-1",
          warningWindowMinutes: 60 * 24 * 8,
        },
      ),
    ).toThrow(DropshipError);
  });
});

describe("Dropship V2 port-backed use-case execution", () => {
  it("executes read-only listing previews without a write transaction or audit event", async () => {
    const ports = makePorts();
    ports.listings.generateVendorListingPreview = vi.fn().mockResolvedValue({ rows: [] });
    const registry = createDropshipUseCaseRegistry(ports);

    await expect(
      registry.GenerateVendorListingPreview.execute({
        vendorId: 1,
        storeConnectionId: 2,
        productVariantIds: [3],
        actor: { actorType: "vendor", actorId: "member-1" },
      }),
    ).resolves.toEqual({ rows: [] });

    expect(ports.listings.generateVendorListingPreview).toHaveBeenCalledWith({
      vendorId: 1,
      storeConnectionId: 2,
      productVariantIds: [3],
      actor: { actorType: "vendor", actorId: "member-1" },
    });
    expect(ports.transactions.runInTransaction).not.toHaveBeenCalled();
    expect(ports.auditEvents.record).not.toHaveBeenCalled();
  });

  it("runs mutating use cases in a transaction and audits the successful execution", async () => {
    const ports = makePorts();
    ports.listings.enqueueListingPush = vi.fn().mockResolvedValue(55);
    const registry = createDropshipUseCaseRegistry(ports);

    await expect(
      registry.CreateListingPushJob.execute({
        vendorId: 1,
        storeConnectionId: 2,
        productVariantIds: [3, 4],
        requestedRetailPricesByVariantId: { "3": 1200, "4": 1500 },
        idempotencyKey: "listing-job-123",
        requestedBy: { actorType: "vendor", actorId: "member-1" },
      }),
    ).resolves.toEqual({ jobId: 55 });

    expect(ports.transactions.runInTransaction).toHaveBeenCalledTimes(1);
    expect(ports.listings.enqueueListingPush).toHaveBeenCalledWith({
      vendorId: 1,
      storeConnectionId: 2,
      productVariantIds: [3, 4],
      requestedRetailPricesByVariantId: { "3": 1200, "4": 1500 },
      idempotencyKey: "listing-job-123",
      requestedBy: { actorType: "vendor", actorId: "member-1" },
      transaction,
    });
    expect(ports.auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        vendorId: 1,
        storeConnectionId: 2,
        entityType: "dropship_use_case",
        entityId: "CreateListingPushJob",
        eventType: "dropship_use_case_create_listing_push_job",
        actorType: "vendor",
        actorId: "member-1",
        severity: "info",
        payload: expect.objectContaining({
          useCaseName: "CreateListingPushJob",
          input: expect.objectContaining({
            productVariantCount: 2,
            requestedRetailPriceVariantCount: 2,
            idempotencyKey: "listing-job-123",
          }),
        }),
      }),
      transaction,
    );
  });

  it("redacts raw marketplace payloads from use-case audit events", async () => {
    const ports = makePorts();
    ports.orderIntake.recordMarketplaceIntake = vi.fn().mockResolvedValue(44);
    const registry = createDropshipUseCaseRegistry(ports);

    await expect(
      registry.RecordMarketplaceOrderIntake.execute({
        vendorId: 1,
        storeConnectionId: 2,
        platform: "shopify",
        externalOrderId: "gid://shopify/Order/1",
        rawPayload: {
          customer: {
            email: "buyer@example.com",
          },
        },
        payloadHash: "0123456789abcdef",
        idempotencyKey: "intake-shopify-1",
      }),
    ).resolves.toEqual({ intakeId: 44 });

    expect(ports.auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          input: expect.objectContaining({
            rawPayload: "[redacted]",
          }),
        }),
      }),
      transaction,
    );
  });

  it("covers vendor order rejection in the executable use-case contract", async () => {
    const ports = makePorts();
    ports.orderRejection.rejectOrder = vi.fn().mockResolvedValue({ intakeId: 88, status: "rejected" });
    const registry = createDropshipUseCaseRegistry(ports);

    await expect(
      registry.RejectDropshipOrder.execute({
        intakeId: 88,
        vendorId: 1,
        reason: "Buyer requested cancellation",
        idempotencyKey: "reject-order-88",
        actor: { actorType: "vendor", actorId: "member-1" },
      }),
    ).resolves.toEqual({ intakeId: 88, status: "rejected" });

    expect(ports.orderRejection.rejectOrder).toHaveBeenCalledWith({
      intakeId: 88,
      vendorId: 1,
      reason: "Buyer requested cancellation",
      idempotencyKey: "reject-order-88",
      actor: { actorType: "vendor", actorId: "member-1" },
      transaction,
    });
    expect(ports.auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        vendorId: 1,
        entityId: "RejectDropshipOrder",
        eventType: "dropship_use_case_reject_dropship_order",
        actorType: "vendor",
        actorId: "member-1",
      }),
      transaction,
    );
  });

  it("covers worker-driven order exception flows with job actor audit context", async () => {
    const ports = makePorts();
    ports.orderCancellations.processPendingCancellations = vi.fn().mockResolvedValue({ attempted: 1 });
    ports.paymentHolds.expireExpiredPaymentHolds = vi.fn().mockResolvedValue({ expiredCount: 1 });
    ports.paymentHolds.notifyExpiringPaymentHolds = vi.fn().mockResolvedValue({ notifiedCount: 1 });
    const registry = createDropshipUseCaseRegistry(ports);

    await expect(
      registry.ProcessMarketplaceOrderCancellations.execute({
        workerId: "worker-1",
        limit: 25,
      }),
    ).resolves.toEqual({ attempted: 1 });
    await expect(
      registry.ExpirePaymentHolds.execute({
        workerId: "worker-1",
        limit: 10,
      }),
    ).resolves.toEqual({ expiredCount: 1 });
    await expect(
      registry.NotifyExpiringPaymentHolds.execute({
        workerId: "worker-1",
        warningWindowMinutes: 120,
      }),
    ).resolves.toEqual({ notifiedCount: 1 });

    expect(ports.orderCancellations.processPendingCancellations).toHaveBeenCalledWith({
      workerId: "worker-1",
      limit: 25,
      transaction,
    });
    expect(ports.paymentHolds.expireExpiredPaymentHolds).toHaveBeenCalledWith({
      workerId: "worker-1",
      limit: 10,
      transaction,
    });
    expect(ports.paymentHolds.notifyExpiringPaymentHolds).toHaveBeenCalledWith({
      workerId: "worker-1",
      warningWindowMinutes: 120,
      transaction,
    });
    expect(ports.auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "ProcessMarketplaceOrderCancellations",
        actorType: "job",
        actorId: "worker-1",
      }),
      transaction,
    );
    expect(ports.auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "ExpirePaymentHolds",
        actorType: "job",
        actorId: "worker-1",
      }),
      transaction,
    );
    expect(ports.auditEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "NotifyExpiringPaymentHolds",
        actorType: "job",
        actorId: "worker-1",
      }),
      transaction,
    );
  });

  it("throws structured validation errors before implementation errors", async () => {
    const ports = makePorts();
    const registry = createDropshipUseCaseRegistry(ports);
    let thrown: unknown;

    try {
      await registry.DebitWalletForOrder.execute({
        vendorId: 1,
        walletAccountId: 2,
        intakeId: 3,
        amountCents: 0,
        idempotencyKey: "debit-123",
      });
    } catch (error) {
      thrown = error;
    }

    expectDropshipError(thrown, "DROPSHIP_INVALID_USE_CASE_INPUT");
    expect((thrown as DropshipError).context).toMatchObject({
      useCaseName: "DebitWalletForOrder",
    });
    expect(ports.transactions.runInTransaction).not.toHaveBeenCalled();
  });
});

function makePorts(): DropshipApplicationPorts {
  return {
    clock: {
      now: vi.fn(() => new Date("2026-05-08T12:00:00.000Z")),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    transactions: {
      runInTransaction: vi.fn(async (operation) => operation(transaction)),
    },
    auditEvents: {
      record: vi.fn(async () => undefined),
    },
    identity: {
      resolveMemberByCardShellzEmail: vi.fn(async () => null),
    },
    entitlement: {
      getEntitlementByMemberId: vi.fn(async () => null),
    },
    authChallenges: {
      createSensitiveActionChallenge: vi.fn(async () => ({
        challengeId: 1,
        expiresAt: new Date("2026-05-08T12:10:00.000Z"),
      })),
    },
    catalog: {
      assertVariantCatalogVisible: vi.fn(async () => undefined),
    },
    listings: {
      generateVendorListingPreview: vi.fn(async () => ({ rows: [] })),
      enqueueListingPush: vi.fn(async () => 1),
      processListingPushJob: vi.fn(async () => ({ processed: true })),
    },
    orderIntake: {
      recordMarketplaceIntake: vi.fn(async () => 1),
    },
    orderAcceptance: {
      acceptOrder: vi.fn(async () => ({ accepted: true })),
    },
    orderRejection: {
      rejectOrder: vi.fn(async () => ({ rejected: true })),
    },
    orderCancellations: {
      processPendingCancellations: vi.fn(async () => ({ processed: true })),
    },
    paymentHolds: {
      expireExpiredPaymentHolds: vi.fn(async () => ({ expiredCount: 0 })),
      notifyExpiringPaymentHolds: vi.fn(async () => ({ notifiedCount: 0 })),
    },
    wallet: {
      creditFunding: vi.fn(async () => undefined),
      debitOrder: vi.fn(async () => undefined),
      handleAutoReload: vi.fn(async () => ({ handled: true })),
    },
    reservations: {
      reserveForAcceptedOrder: vi.fn(async () => undefined),
    },
    shipping: {
      quote: vi.fn(async () => 1),
    },
    marketplace: {
      refreshStoreToken: vi.fn(async () => undefined),
      pushTracking: vi.fn(async () => undefined),
    },
    returns: {
      processInspection: vi.fn(async () => undefined),
    },
    notifications: {
      send: vi.fn(async () => undefined),
    },
  };
}
