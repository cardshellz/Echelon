import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipOrderIntakeService,
  evaluateDropshipOrderIntakeEligibility,
  hashDropshipOrderIntakePayload,
  type DropshipNotificationSenderInput,
  type DropshipOrderIntakeRecord,
  type DropshipOrderIntakeRepository,
  type DropshipOrderIntakeRepositoryInput,
  type DropshipOrderIntakeRepositoryResult,
  type DropshipOrderIntakeStoreContext,
  type RecordDropshipOrderIntakeInput,
} from "../../application/dropship-order-intake-service";

const now = new Date("2026-05-01T22:30:00.000Z");

describe("DropshipOrderIntakeService", () => {
  let repository: FakeOrderIntakeRepository;
  let notificationSender: FakeNotificationSender;
  let logs: DropshipLogEvent[];
  let service: DropshipOrderIntakeService;

  beforeEach(() => {
    repository = new FakeOrderIntakeRepository();
    notificationSender = new FakeNotificationSender();
    logs = [];
    service = new DropshipOrderIntakeService({
      repository,
      notificationSender,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });
  });

  it("records a connected marketplace order into received intake", async () => {
    const result = await service.recordMarketplaceOrder(makeInput());

    expect(result.action).toBe("created");
    expect(result.intake).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      externalOrderId: "gid://shopify/Order/1001",
      status: "received",
      rejectionReason: null,
    });
    expect(repository.lastRecordInput?.payloadHash).toHaveLength(64);
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_order_received",
      critical: false,
      idempotencyKey: "order-intake:1:received",
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_ORDER_INTAKE_RECORDED",
      context: { action: "created", status: "received" },
    });
  });

  it("keeps payload hashing stable regardless of raw object key order", () => {
    const left = hashDropshipOrderIntakePayload({
      rawPayload: { b: 2, a: { z: true, y: false } },
      normalizedPayload: makeInput().normalizedPayload,
    });
    const right = hashDropshipOrderIntakePayload({
      rawPayload: { a: { y: false, z: true }, b: 2 },
      normalizedPayload: makeInput().normalizedPayload,
    });

    expect(left).toBe(right);
  });

  it("records disconnected store orders as rejected intake for audit visibility", async () => {
    repository.context = {
      ...repository.context,
      storeStatus: "needs_reauth",
    };

    const result = await service.recordMarketplaceOrder(makeInput());

    expect(result.intake.status).toBe("rejected");
    expect(result.intake.rejectionReason).toContain("needs_reauth");
    expect(notificationSender.sent[0]).toMatchObject({
      eventType: "dropship_order_intake_rejected",
      critical: true,
      idempotencyKey: "order-intake:1:rejected",
    });
  });

  it("rejects platform mismatches before writing intake", async () => {
    repository.context = {
      ...repository.context,
      platform: "ebay",
    };

    await expect(service.recordMarketplaceOrder(makeInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_STORE_PLATFORM_MISMATCH",
    });
    expect(repository.records).toHaveLength(0);
  });

  it("replays duplicate marketplace deliveries when payload hash matches", async () => {
    const first = await service.recordMarketplaceOrder(makeInput());
    const replay = await service.recordMarketplaceOrder(makeInput());

    expect(first.action).toBe("created");
    expect(replay.action).toBe("replayed");
    expect(replay.intake.intakeId).toBe(first.intake.intakeId);
    expect(repository.records).toHaveLength(1);
    expect(notificationSender.sent).toHaveLength(1);
  });

  it("blocks payload changes after intake is accepted", async () => {
    const first = await service.recordMarketplaceOrder(makeInput());
    repository.records[0] = {
      ...first.intake,
      status: "accepted",
      acceptedAt: now,
    };

    await expect(service.recordMarketplaceOrder(makeInput({
      rawPayload: { order: { id: "1001", updated: true } },
    }))).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE",
    });
  });
});

describe("dropship order intake eligibility", () => {
  it("allows only active vendors, active entitlements, and connected stores", () => {
    expect(evaluateDropshipOrderIntakeEligibility(makeContext())).toEqual({
      status: "received",
      rejectionReason: null,
    });
    expect(evaluateDropshipOrderIntakeEligibility({
      ...makeContext(),
      entitlementStatus: "lapsed",
    })).toMatchObject({ status: "rejected" });
    expect(evaluateDropshipOrderIntakeEligibility({
      ...makeContext(),
      storeStatus: "grace_period",
    })).toMatchObject({ status: "rejected" });
  });
});

class FakeOrderIntakeRepository implements DropshipOrderIntakeRepository {
  context: DropshipOrderIntakeStoreContext = makeContext();
  records: DropshipOrderIntakeRecord[] = [];
  lastRecordInput: DropshipOrderIntakeRepositoryInput | null = null;

  async loadStoreContext(): Promise<DropshipOrderIntakeStoreContext | null> {
    return this.context;
  }

  async recordMarketplaceIntake(
    input: DropshipOrderIntakeRepositoryInput,
  ): Promise<DropshipOrderIntakeRepositoryResult> {
    this.lastRecordInput = input;
    const existingIndex = this.records.findIndex((record) => {
      return record.storeConnectionId === input.storeConnectionId
        && record.externalOrderId === input.externalOrderId;
    });
    if (existingIndex >= 0) {
      const existing = this.records[existingIndex];
      if (existing.payloadHash === input.payloadHash) {
        return { intake: existing, action: "replayed" };
      }
      if (["accepted", "cancelled", "rejected"].includes(existing.status)) {
        throw new DropshipError(
          "DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE",
          "Payload changed after immutable status.",
        );
      }
      const updated = makeRecord(input, existing.intakeId);
      this.records[existingIndex] = updated;
      return { intake: updated, action: "updated" };
    }
    const record = makeRecord(input, this.records.length + 1);
    this.records.push(record);
    return { intake: record, action: "created" };
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
  }
}

function makeInput(
  overrides: Partial<RecordDropshipOrderIntakeInput> = {},
): RecordDropshipOrderIntakeInput {
  return {
    vendorId: 10,
    storeConnectionId: 22,
    platform: "shopify",
    externalOrderId: "gid://shopify/Order/1001",
    externalOrderNumber: "1001",
    rawPayload: { order: { id: "1001" } },
    normalizedPayload: {
      lines: [
        {
          externalLineItemId: "line-1",
          sku: "SKU-101",
          productVariantId: 101,
          quantity: 2,
          unitRetailPriceCents: 1299,
          title: "Toploader",
        },
      ],
      shipTo: {
        name: "Card Buyer",
        address1: "1 Main St",
        city: "New York",
        region: "NY",
        postalCode: "10001",
        country: "US",
      },
      totals: {
        retailSubtotalCents: 2598,
        shippingPaidCents: 500,
        taxCents: 0,
        discountCents: 0,
        grandTotalCents: 3098,
        currency: "USD",
      },
      orderedAt: "2026-05-01T20:00:00.000Z",
      marketplaceStatus: "paid",
    },
    idempotencyKey: "intake-shopify-1001",
    ...overrides,
  };
}

function makeContext(overrides: Partial<DropshipOrderIntakeStoreContext> = {}): DropshipOrderIntakeStoreContext {
  return {
    vendorId: 10,
    vendorStatus: "active",
    entitlementStatus: "active",
    storeConnectionId: 22,
    storeStatus: "connected",
    platform: "shopify",
    ...overrides,
  };
}

function makeRecord(
  input: DropshipOrderIntakeRepositoryInput,
  intakeId: number,
): DropshipOrderIntakeRecord {
  return {
    intakeId,
    channelId: 7,
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    platform: input.platform,
    externalOrderId: input.externalOrderId,
    externalOrderNumber: input.externalOrderNumber ?? null,
    sourceOrderId: input.sourceOrderId ?? null,
    status: input.status,
    paymentHoldExpiresAt: null,
    rejectionReason: input.rejectionReason,
    cancellationStatus: null,
    rawPayload: input.rawPayload,
    normalizedPayload: input.normalizedPayload,
    payloadHash: input.payloadHash,
    omsOrderId: null,
    receivedAt: input.receivedAt,
    acceptedAt: null,
    updatedAt: input.receivedAt,
  };
}
