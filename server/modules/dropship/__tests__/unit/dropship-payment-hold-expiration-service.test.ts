import { describe, expect, it } from "vitest";
import {
  DropshipPaymentHoldExpirationService,
  type DropshipExpiringPaymentHoldRecord,
  type DropshipExpiredPaymentHoldRecord,
  type DropshipLogEvent,
  type DropshipNotificationSenderInput,
  type DropshipPaymentHoldExpirationRepository,
} from "../../application";

const now = new Date("2026-05-01T18:00:00.000Z");
const expiredAt = new Date("2026-05-01T17:59:00.000Z");
const expiringAt = new Date("2026-05-01T19:15:00.000Z");

describe("DropshipPaymentHoldExpirationService", () => {
  it("expires due payment holds with deterministic worker context", async () => {
    const repository = new FakePaymentHoldExpirationRepository([makeExpiredHold()]);
    const notificationSender = new FakeNotificationSender();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipPaymentHoldExpirationService({
      repository,
      notificationSender,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });

    const result = await service.expireExpiredPaymentHolds({
      workerId: "worker-1",
      limit: 25,
    });

    expect(result.expiredCount).toBe(1);
    expect(result.expired[0]).toMatchObject({
      intakeId: 1,
      cancellationStatus: "payment_hold_expired",
    });
    expect(repository.lastInput).toEqual({
      now,
      limit: 25,
      workerId: "worker-1",
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_PAYMENT_HOLDS_EXPIRED",
      context: {
        expiredCount: 1,
        workerId: "worker-1",
        intakeIds: [1],
      },
    });
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_order_payment_hold_expired",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship order payment hold expired",
      idempotencyKey: "payment-hold-expiration:1:expired",
      payload: {
        intakeId: 1,
        storeConnectionId: 22,
        externalOrderId: "EXT-1",
        paymentHoldExpiresAt: expiredAt.toISOString(),
        cancellationStatus: "payment_hold_expired",
      },
    });
  });

  it("logs notification failures without undoing expired payment holds", async () => {
    const repository = new FakePaymentHoldExpirationRepository([makeExpiredHold()]);
    const notificationSender = new FakeNotificationSender(new Error("email unavailable"));
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipPaymentHoldExpirationService({
      repository,
      notificationSender,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });

    const result = await service.expireExpiredPaymentHolds({
      workerId: "worker-1",
      limit: 25,
    });

    expect(result.expiredCount).toBe(1);
    expect(notificationSender.sent).toHaveLength(1);
    expect(logs.some((event) => (
      event.code === "DROPSHIP_PAYMENT_HOLD_EXPIRATION_NOTIFICATION_FAILED"
        && event.context?.intakeId === 1
    ))).toBe(true);
  });

  it("uses the default batch limit when none is supplied", async () => {
    const repository = new FakePaymentHoldExpirationRepository([]);
    const service = new DropshipPaymentHoldExpirationService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await service.expireExpiredPaymentHolds({ workerId: "worker-1" });

    expect(repository.lastInput?.limit).toBe(100);
  });

  it("notifies active payment holds approaching expiration once per hold deadline", async () => {
    const repository = new FakePaymentHoldExpirationRepository([], [makeExpiringHold()]);
    const notificationSender = new FakeNotificationSender();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipPaymentHoldExpirationService({
      repository,
      notificationSender,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });

    const result = await service.notifyExpiringPaymentHolds({
      workerId: "worker-1",
      limit: 10,
      warningWindowMinutes: 120,
    });

    expect(result.notifiedCount).toBe(1);
    expect(repository.lastExpiringInput).toEqual({
      now,
      limit: 10,
      warningWindowMinutes: 120,
    });
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_order_payment_hold_expiring",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship order payment hold expiring",
      idempotencyKey: `payment-hold-expiring:2:${expiringAt.toISOString()}`,
      payload: {
        intakeId: 2,
        storeConnectionId: 22,
        externalOrderId: "EXT-2",
        paymentHoldExpiresAt: expiringAt.toISOString(),
        minutesUntilExpiration: 75,
        warningWindowMinutes: 120,
      },
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_PAYMENT_HOLDS_EXPIRING",
      context: {
        notifiedCount: 1,
        intakeIds: [2],
      },
    });
  });

  it("rejects invalid expiring notification input before repository calls", async () => {
    const repository = new FakePaymentHoldExpirationRepository([]);
    const service = new DropshipPaymentHoldExpirationService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await expect(service.notifyExpiringPaymentHolds({
      workerId: "worker-1",
      warningWindowMinutes: 0,
    })).rejects.toMatchObject({ code: "DROPSHIP_PAYMENT_HOLD_EXPIRING_NOTIFICATION_INVALID_INPUT" });
    expect(repository.lastExpiringInput).toBeNull();
  });

  it("rejects invalid input before repository calls", async () => {
    const repository = new FakePaymentHoldExpirationRepository([]);
    const service = new DropshipPaymentHoldExpirationService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await expect(service.expireExpiredPaymentHolds({
      workerId: "",
      limit: 1,
    })).rejects.toMatchObject({ code: "DROPSHIP_PAYMENT_HOLD_EXPIRATION_INVALID_INPUT" });
    expect(repository.lastInput).toBeNull();
  });
});

class FakePaymentHoldExpirationRepository implements DropshipPaymentHoldExpirationRepository {
  lastInput: Parameters<DropshipPaymentHoldExpirationRepository["expirePaymentHolds"]>[0] | null = null;
  lastExpiringInput: Parameters<DropshipPaymentHoldExpirationRepository["listExpiringPaymentHolds"]>[0] | null = null;

  constructor(
    private readonly expired: DropshipExpiredPaymentHoldRecord[],
    private readonly expiring: DropshipExpiringPaymentHoldRecord[] = [],
  ) {}

  async listExpiringPaymentHolds(
    input: Parameters<DropshipPaymentHoldExpirationRepository["listExpiringPaymentHolds"]>[0],
  ): Promise<DropshipExpiringPaymentHoldRecord[]> {
    this.lastExpiringInput = input;
    return this.expiring;
  }

  async expirePaymentHolds(
    input: Parameters<DropshipPaymentHoldExpirationRepository["expirePaymentHolds"]>[0],
  ): Promise<DropshipExpiredPaymentHoldRecord[]> {
    this.lastInput = input;
    return this.expired;
  }
}

function makeExpiringHold(): DropshipExpiringPaymentHoldRecord {
  return {
    intakeId: 2,
    vendorId: 10,
    storeConnectionId: 22,
    externalOrderId: "EXT-2",
    paymentHoldExpiresAt: expiringAt,
  };
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

function makeExpiredHold(): DropshipExpiredPaymentHoldRecord {
  return {
    intakeId: 1,
    vendorId: 10,
    storeConnectionId: 22,
    externalOrderId: "EXT-1",
    paymentHoldExpiresAt: expiredAt,
    cancellationStatus: "payment_hold_expired",
  };
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
