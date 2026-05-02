import { describe, expect, it } from "vitest";
import {
  DropshipPaymentHoldExpirationService,
  type DropshipExpiredPaymentHoldRecord,
  type DropshipLogEvent,
  type DropshipPaymentHoldExpirationRepository,
} from "../../application";

const now = new Date("2026-05-01T18:00:00.000Z");
const expiredAt = new Date("2026-05-01T17:59:00.000Z");

describe("DropshipPaymentHoldExpirationService", () => {
  it("expires due payment holds with deterministic worker context", async () => {
    const repository = new FakePaymentHoldExpirationRepository([makeExpiredHold()]);
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipPaymentHoldExpirationService({
      repository,
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

  constructor(private readonly expired: DropshipExpiredPaymentHoldRecord[]) {}

  async expirePaymentHolds(
    input: Parameters<DropshipPaymentHoldExpirationRepository["expirePaymentHolds"]>[0],
  ): Promise<DropshipExpiredPaymentHoldRecord[]> {
    this.lastInput = input;
    return this.expired;
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
