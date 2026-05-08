import { describe, expect, it } from "vitest";
import type {
  DropshipNotificationOpsEventRecord,
  DropshipNotificationOpsListResult,
  DropshipNotificationOpsPreparedRetry,
  DropshipNotificationOpsRepository,
} from "../../application/dropship-notification-ops-service";
import { DropshipNotificationOpsService } from "../../application/dropship-notification-ops-service";
import type { DropshipNotificationEmailSender } from "../../application/dropship-notification-service";

const now = new Date("2026-05-07T19:00:00.000Z");

describe("DropshipNotificationOpsService", () => {
  it("lists failed and pending notification events by default", async () => {
    const repository = new FakeNotificationOpsRepository();
    const service = makeService(repository);

    const result = await service.listEvents({ page: 1, limit: 25 });

    expect(result.statuses).toEqual(["failed", "pending"]);
    expect(repository.inputs[0]).toMatchObject({
      statuses: ["failed", "pending"],
      page: 1,
      limit: 25,
    });
  });

  it("preserves explicit filters for ops search", async () => {
    const repository = new FakeNotificationOpsRepository();
    const service = makeService(repository);

    await service.listEvents({
      statuses: ["delivered"],
      channels: ["email"],
      vendorId: 12,
      critical: true,
      search: "payment hold",
      page: 2,
      limit: 10,
    });

    expect(repository.inputs[0]).toEqual({
      statuses: ["delivered"],
      channels: ["email"],
      vendorId: 12,
      critical: true,
      search: "payment hold",
      page: 2,
      limit: 10,
    });
  });

  it("rejects invalid status filters before the repository is called", async () => {
    const repository = new FakeNotificationOpsRepository();
    const service = makeService(repository);

    await expect(service.listEvents({ statuses: ["retrying"] })).rejects.toMatchObject({
      code: "DROPSHIP_NOTIFICATION_OPS_LIST_INVALID_INPUT",
    });
    expect(repository.inputs).toHaveLength(0);
  });

  it("retries failed email notification events and records delivery context", async () => {
    const repository = new FakeNotificationOpsRepository();
    const emailSender = new FakeEmailSender();
    const logs: any[] = [];
    const service = makeService(repository, emailSender, logs);

    const result = await service.retryEvent({
      notificationEventId: 72,
      idempotencyKey: "notification-retry-72",
      reason: "SMTP outage cleared",
      actor: { actorType: "admin", actorId: "ops-user" },
    });

    expect(emailSender.sent).toEqual([{
      toEmail: "vendor@cardshellz.test",
      eventType: "dropship_order_rejected",
      title: "Order rejected",
      message: "Order rejected.",
      payload: { intakeId: 55 },
    }]);
    expect(repository.retryInputs[0]).toMatchObject({
      notificationEventId: 72,
      idempotencyKey: "notification-retry-72",
      reason: "SMTP outage cleared",
      actor: { actorType: "admin", actorId: "ops-user" },
      now,
    });
    expect(repository.deliveryInputs[0]).toMatchObject({
      notificationEventId: 72,
      status: "delivered",
      deliveredAt: now,
      failureCode: null,
      failureMessage: null,
      idempotencyKey: "notification-retry-72",
    });
    expect(result).toMatchObject({
      notificationEventId: 72,
      previousStatus: "failed",
      status: "delivered",
      failureCode: null,
      idempotentReplay: false,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_NOTIFICATION_OPS_EMAIL_RETRY_DELIVERED",
      context: {
        notificationEventId: 72,
        vendorId: 10,
        eventType: "dropship_order_rejected",
        idempotencyKey: "notification-retry-72",
      },
    });
  });

  it("marks retry failed when the vendor email is missing", async () => {
    const repository = new FakeNotificationOpsRepository();
    repository.preparedEvent = makeEvent({ vendor: { ...makeVendor(), email: null } });
    const emailSender = new FakeEmailSender();
    const logs: any[] = [];
    const service = makeService(repository, emailSender, logs);

    const result = await service.retryEvent({
      notificationEventId: 72,
      idempotencyKey: "notification-retry-72",
      actor: { actorType: "admin", actorId: "ops-user" },
    });

    expect(emailSender.sent).toHaveLength(0);
    expect(repository.deliveryInputs[0]).toMatchObject({
      status: "failed",
      failureCode: "DROPSHIP_NOTIFICATION_EMAIL_MISSING",
      failureMessage: "Vendor email is missing.",
    });
    expect(result).toMatchObject({
      previousStatus: "failed",
      status: "failed",
      failureCode: "DROPSHIP_NOTIFICATION_EMAIL_MISSING",
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_NOTIFICATION_OPS_EMAIL_RETRY_SKIPPED",
    });
  });

  it("rejects invalid retry input before delivery is attempted", async () => {
    const repository = new FakeNotificationOpsRepository();
    const emailSender = new FakeEmailSender();
    const service = makeService(repository, emailSender);

    await expect(service.retryEvent({
      notificationEventId: 72,
      idempotencyKey: "short",
      actor: { actorType: "admin" },
    })).rejects.toMatchObject({
      code: "DROPSHIP_NOTIFICATION_OPS_RETRY_INVALID_INPUT",
    });
    expect(repository.retryInputs).toHaveLength(0);
    expect(emailSender.sent).toHaveLength(0);
  });
});

function makeService(
  repository: DropshipNotificationOpsRepository,
  emailSender: DropshipNotificationEmailSender = new FakeEmailSender(),
  logs: any[] = [],
): DropshipNotificationOpsService {
  return new DropshipNotificationOpsService({
    repository,
    emailSender,
    logger: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
    clock: { now: () => now },
  });
}

class FakeNotificationOpsRepository implements DropshipNotificationOpsRepository {
  inputs: Parameters<DropshipNotificationOpsRepository["listEvents"]>[0][] = [];
  retryInputs: Parameters<DropshipNotificationOpsRepository["prepareEmailRetry"]>[0][] = [];
  deliveryInputs: Parameters<DropshipNotificationOpsRepository["updateEmailRetryDelivery"]>[0][] = [];
  preparedEvent: DropshipNotificationOpsEventRecord = makeEvent();

  async listEvents(
    input: Parameters<DropshipNotificationOpsRepository["listEvents"]>[0],
  ): Promise<DropshipNotificationOpsListResult> {
    this.inputs.push(input);
    return {
      items: [],
      total: 0,
      page: input.page,
      limit: input.limit,
      statuses: input.statuses,
      channels: input.channels ?? null,
      summary: [],
      channelSummary: [],
    };
  }

  async prepareEmailRetry(
    input: Parameters<DropshipNotificationOpsRepository["prepareEmailRetry"]>[0],
  ): Promise<DropshipNotificationOpsPreparedRetry> {
    this.retryInputs.push(input);
    return {
      event: this.preparedEvent,
      previousStatus: "failed",
    };
  }

  async updateEmailRetryDelivery(
    input: Parameters<DropshipNotificationOpsRepository["updateEmailRetryDelivery"]>[0],
  ): Promise<DropshipNotificationOpsEventRecord> {
    this.deliveryInputs.push(input);
    return makeEvent({
      status: input.status,
      deliveredAt: input.deliveredAt,
    });
  }
}

class FakeEmailSender implements DropshipNotificationEmailSender {
  sent: Array<Parameters<DropshipNotificationEmailSender["send"]>[0]> = [];

  async send(input: Parameters<DropshipNotificationEmailSender["send"]>[0]): Promise<void> {
    this.sent.push(input);
  }
}

function makeEvent(
  overrides: Partial<DropshipNotificationOpsEventRecord> = {},
): DropshipNotificationOpsEventRecord {
  return {
    notificationEventId: 72,
    vendor: makeVendor(),
    eventType: "dropship_order_rejected",
    channel: "email",
    critical: true,
    title: "Order rejected",
    message: "Order rejected.",
    payload: { intakeId: 55 },
    status: "failed",
    deliveredAt: null,
    readAt: null,
    idempotencyKey: "notification-order-rejected-55",
    requestHash: "request-hash",
    createdAt: now,
    ...overrides,
  };
}

function makeVendor(): DropshipNotificationOpsEventRecord["vendor"] {
  return {
    vendorId: 10,
    memberId: "member-1",
    businessName: "Vendor",
    email: "vendor@cardshellz.test",
    status: "active",
    entitlementStatus: "active",
  };
}
