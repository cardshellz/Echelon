import { describe, expect, it } from "vitest";
import {
  DropshipOrderRejectionService,
  type DropshipLogEvent,
  type DropshipNotificationSenderInput,
  type DropshipOrderRejectionRepository,
  type DropshipOrderRejectionResult,
} from "../../application";

const now = new Date("2026-05-06T12:00:00.000Z");

describe("DropshipOrderRejectionService", () => {
  it("rejects a vendor order intake with audited context", async () => {
    const repository = new FakeOrderRejectionRepository(makeResult());
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderRejectionService({
      repository,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.rejectOrder({
      intakeId: 42,
      vendorId: 10,
      reason: "Cannot fulfill selected SKU.",
      idempotencyKey: "reject-order-42",
      actor: {
        actorType: "vendor",
        actorId: "member-1",
      },
    });

    expect(result).toMatchObject({
      intakeId: 42,
      status: "rejected",
      cancellationStatus: "order_intake_rejected",
      idempotentReplay: false,
    });
    expect(repository.lastInput).toMatchObject({
      intakeId: 42,
      vendorId: 10,
      rejectedAt: now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_ORDER_REJECTED_BY_VENDOR",
      context: {
        intakeId: 42,
        vendorId: 10,
        storeConnectionId: 22,
        previousStatus: "received",
        status: "rejected",
        cancellationStatus: "order_intake_rejected",
        idempotencyKey: "reject-order-42",
      },
    });
  });

  it("sends one critical rejection notification for new vendor rejections", async () => {
    const repository = new FakeOrderRejectionRepository(makeResult());
    const notificationSender = new FakeNotificationSender();
    const service = new DropshipOrderRejectionService({
      repository,
      notificationSender,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await service.rejectOrder({
      intakeId: 42,
      vendorId: 10,
      reason: "Cannot fulfill selected SKU.",
      idempotencyKey: "reject-order-42",
      actor: {
        actorType: "vendor",
        actorId: "member-1",
      },
    });

    expect(notificationSender.sent).toHaveLength(1);
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_order_rejected",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship order rejected",
      idempotencyKey: "order-rejected:42:reject-order-42",
      payload: {
        intakeId: 42,
        vendorId: 10,
        storeConnectionId: 22,
        externalOrderId: "external-1",
        externalOrderNumber: "1001",
        previousStatus: "received",
        status: "rejected",
        cancellationStatus: "order_intake_rejected",
        rejectionReason: "Cannot fulfill selected SKU.",
        rejectedAt: now.toISOString(),
        actorType: "vendor",
        actorId: "member-1",
      },
    });
  });

  it("does not resend rejection notifications for idempotent replays", async () => {
    const repository = new FakeOrderRejectionRepository(makeResult({ idempotentReplay: true }));
    const notificationSender = new FakeNotificationSender();
    const service = new DropshipOrderRejectionService({
      repository,
      notificationSender,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await service.rejectOrder({
      intakeId: 42,
      vendorId: 10,
      reason: "Cannot fulfill selected SKU.",
      idempotencyKey: "reject-order-42",
      actor: {
        actorType: "vendor",
        actorId: "member-1",
      },
    });

    expect(notificationSender.sent).toHaveLength(0);
  });

  it("does not fail rejection when notification delivery fails", async () => {
    const repository = new FakeOrderRejectionRepository(makeResult());
    const notificationSender = new FakeNotificationSender(new Error("email unavailable"));
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderRejectionService({
      repository,
      notificationSender,
      clock: { now: () => now },
      logger: captureLogger(logs),
    });

    const result = await service.rejectOrder({
      intakeId: 42,
      vendorId: 10,
      reason: "Cannot fulfill selected SKU.",
      idempotencyKey: "reject-order-42",
      actor: {
        actorType: "vendor",
        actorId: "member-1",
      },
    });

    expect(result.status).toBe("rejected");
    expect(logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_ORDER_REJECTION_NOTIFICATION_FAILED",
      context: expect.objectContaining({
        intakeId: 42,
        error: "email unavailable",
      }),
    }));
  });

  it("rejects invalid input before repository access", async () => {
    const repository = new FakeOrderRejectionRepository(makeResult());
    const service = new DropshipOrderRejectionService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await expect(service.rejectOrder({
      intakeId: 42,
      vendorId: 10,
      reason: "x",
      idempotencyKey: "reject-order-42",
      actor: {
        actorType: "vendor",
        actorId: "member-1",
      },
    })).rejects.toMatchObject({ code: "DROPSHIP_ORDER_REJECTION_INVALID_INPUT" });
    expect(repository.lastInput).toBeNull();
  });
});

class FakeOrderRejectionRepository implements DropshipOrderRejectionRepository {
  lastInput: Parameters<DropshipOrderRejectionRepository["rejectOrder"]>[0] | null = null;

  constructor(private readonly result: DropshipOrderRejectionResult) {}

  async rejectOrder(
    input: Parameters<DropshipOrderRejectionRepository["rejectOrder"]>[0],
  ): Promise<DropshipOrderRejectionResult> {
    this.lastInput = input;
    return this.result;
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];

  constructor(private readonly error: Error | null = null) {}

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

function makeResult(
  overrides: Partial<DropshipOrderRejectionResult> = {},
): DropshipOrderRejectionResult {
  return {
    intakeId: 42,
    vendorId: 10,
    storeConnectionId: 22,
    externalOrderId: "external-1",
    externalOrderNumber: "1001",
    previousStatus: "received",
    status: "rejected",
    cancellationStatus: "order_intake_rejected",
    rejectionReason: "Cannot fulfill selected SKU.",
    idempotentReplay: false,
    rejectedAt: now,
    ...overrides,
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
