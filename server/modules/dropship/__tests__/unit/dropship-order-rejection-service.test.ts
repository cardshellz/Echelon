import { describe, expect, it } from "vitest";
import {
  DropshipOrderRejectionService,
  type DropshipLogEvent,
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
