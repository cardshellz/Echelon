import { describe, expect, it } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipNotificationService,
  type DropshipNotificationEventRecord,
  type DropshipNotificationListResult,
  type DropshipNotificationEmailSender,
  type DropshipNotificationPreferenceRecord,
  type DropshipNotificationRepository,
  type DropshipNotificationSendResult,
  type DropshipNotificationVendorContact,
  type RecordDropshipNotificationEventsRepositoryInput,
  type UpsertDropshipNotificationPreferenceRepositoryInput,
} from "../../application/dropship-notification-service";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";

const now = new Date("2026-05-02T18:00:00.000Z");

describe("DropshipNotificationService", () => {
  it("keeps critical notifications on email and in-app channels", async () => {
    const repository = new FakeNotificationRepository();
    const emailSender = new FakeEmailSender();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, emailSender, logs);

    const result = await service.send({
      vendorId: 10,
      eventType: "return_credited",
      channels: ["email"],
      critical: true,
      title: "Return credited",
      message: "RMA-1 was credited.",
      payload: { rmaId: 1 },
      idempotencyKey: "notification-return-credited-1",
    });

    expect(repository.lastSend?.channels).toEqual(["email", "in_app"]);
    expect(result.events.map((event) => event.channel)).toEqual(["email", "in_app"]);
    expect(result.events.find((event) => event.channel === "email")?.status).toBe("delivered");
    expect(emailSender.sent).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_NOTIFICATION_RECORDED",
      context: { critical: true, eventType: "return_credited" },
    });
  });

  it("rejects Phase 2 notification channels in preferences", async () => {
    const service = makeService(new FakeNotificationRepository(), new FakeEmailSender(), []);

    await expect(service.updatePreference({
      vendorId: 10,
      eventType: "order_failed",
      smsEnabled: true,
    })).rejects.toMatchObject({ code: "DROPSHIP_NOTIFICATION_CHANNEL_UNSUPPORTED" });
  });

  it("rejects muting email or in-app for critical notification preferences", async () => {
    const service = makeService(new FakeNotificationRepository(), new FakeEmailSender(), []);

    await expect(service.updatePreference({
      vendorId: 10,
      eventType: "return_credited",
      critical: true,
      emailEnabled: false,
      inAppEnabled: true,
    })).rejects.toMatchObject({ code: "DROPSHIP_NOTIFICATION_CRITICAL_MUTE_REJECTED" });
  });
});

class FakeNotificationRepository implements DropshipNotificationRepository {
  lastSend: RecordDropshipNotificationEventsRepositoryInput | null = null;
  preferences: DropshipNotificationPreferenceRecord[] = [];
  contact: DropshipNotificationVendorContact = { vendorId: 10, email: "vendor@cardshellz.test" };

  async send(input: RecordDropshipNotificationEventsRepositoryInput): Promise<DropshipNotificationSendResult> {
    this.lastSend = input;
    return {
      events: input.channels.map((channel, index) => makeEvent({
        notificationEventId: index + 1,
        channel,
        eventType: input.eventType,
        critical: input.critical,
        title: input.title,
        message: input.message ?? null,
        payload: input.payload,
        status: channel === "email" ? "pending" : "delivered",
        deliveredAt: channel === "in_app" ? input.now : null,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      })),
      idempotentReplay: false,
    };
  }

  async listEvents(): Promise<DropshipNotificationListResult> {
    return { items: [], total: 0, page: 1, limit: 50, unreadOnly: false };
  }

  async getVendorContact(): Promise<DropshipNotificationVendorContact> {
    return this.contact;
  }

  async updateEmailDelivery(input: Parameters<DropshipNotificationRepository["updateEmailDelivery"]>[0]): Promise<DropshipNotificationEventRecord> {
    return makeEvent({
      notificationEventId: input.notificationEventId,
      vendorId: input.vendorId,
      channel: "email",
      status: input.status,
      deliveredAt: input.deliveredAt,
    });
  }

  async markRead(): Promise<DropshipNotificationEventRecord> {
    return makeEvent();
  }

  async listPreferences(): Promise<DropshipNotificationPreferenceRecord[]> {
    return this.preferences;
  }

  async upsertPreference(
    input: UpsertDropshipNotificationPreferenceRepositoryInput,
  ): Promise<DropshipNotificationPreferenceRecord> {
    const preference = makePreference({
      eventType: input.eventType,
      critical: input.critical ?? false,
      emailEnabled: input.critical ? true : input.emailEnabled ?? true,
      inAppEnabled: input.critical ? true : input.inAppEnabled ?? true,
      smsEnabled: input.smsEnabled ?? false,
      webhookEnabled: input.webhookEnabled ?? false,
      updatedAt: input.now,
    });
    this.preferences = [preference];
    return preference;
  }
}

class FakeVendorProvisioningService {
  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: makeVendor({ memberId }),
      created: false,
      changedFields: [],
    };
  }
}

class FakeEmailSender implements DropshipNotificationEmailSender {
  sent: Array<Parameters<DropshipNotificationEmailSender["send"]>[0]> = [];

  async send(input: Parameters<DropshipNotificationEmailSender["send"]>[0]): Promise<void> {
    this.sent.push(input);
  }
}

function makeService(
  repository: DropshipNotificationRepository,
  emailSender: DropshipNotificationEmailSender,
  logs: DropshipLogEvent[],
): DropshipNotificationService {
  return new DropshipNotificationService({
    vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
    repository,
    emailSender,
    clock: { now: () => now },
    logger: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
  });
}

function makeEvent(overrides: Partial<DropshipNotificationEventRecord> = {}): DropshipNotificationEventRecord {
  return {
    notificationEventId: 1,
    vendorId: 10,
    eventType: "return_credited",
    channel: "in_app",
    critical: false,
    title: "Return credited",
    message: null,
    payload: {},
    status: "delivered",
    deliveredAt: now,
    readAt: null,
    idempotencyKey: null,
    requestHash: null,
    createdAt: now,
    ...overrides,
  };
}

function makePreference(overrides: Partial<DropshipNotificationPreferenceRecord> = {}): DropshipNotificationPreferenceRecord {
  return {
    notificationPreferenceId: 1,
    vendorId: 10,
    eventType: "return_credited",
    critical: false,
    emailEnabled: true,
    inAppEnabled: true,
    smsEnabled: false,
    webhookEnabled: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeVendor(overrides: Partial<DropshipProvisionedVendorProfile> = {}): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: "member-1",
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops",
    businessName: null,
    contactName: null,
    email: "vendor@cardshellz.test",
    phone: null,
    status: "active",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
