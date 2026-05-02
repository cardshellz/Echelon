import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type { DropshipVendorProvisioningService } from "./dropship-vendor-provisioning-service";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const eventTypeSchema = z.string().trim().min(1).max(100);
const titleSchema = z.string().trim().min(1).max(300);
const nullableTextSchema = z.string().trim().max(5000).nullable().optional();
const jsonObjectSchema = z.record(z.unknown());

export const dropshipNotificationChannelSchema = z.enum(["email", "in_app"]);
export type DropshipNotificationChannel = z.infer<typeof dropshipNotificationChannelSchema>;

export const dropshipNotificationStatusSchema = z.enum(["pending", "delivered", "failed"]);
export type DropshipNotificationStatus = z.infer<typeof dropshipNotificationStatusSchema>;

const sendDropshipNotificationInputSchema = z.object({
  vendorId: positiveIdSchema,
  eventType: eventTypeSchema,
  channels: z.array(dropshipNotificationChannelSchema).min(1).max(2).optional(),
  critical: z.boolean().default(false),
  title: titleSchema,
  message: nullableTextSchema,
  payload: jsonObjectSchema.default({}),
  idempotencyKey: idempotencyKeySchema,
}).strict();

const listDropshipNotificationsInputSchema = z.object({
  vendorId: positiveIdSchema,
  unreadOnly: z.boolean().default(false),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(50),
}).strict();

const markDropshipNotificationReadInputSchema = z.object({
  vendorId: positiveIdSchema,
  notificationEventId: positiveIdSchema,
  now: z.date(),
}).strict();

const updateDropshipNotificationPreferenceInputSchema = z.object({
  vendorId: positiveIdSchema,
  eventType: eventTypeSchema,
  critical: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  inAppEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  webhookEnabled: z.boolean().optional(),
}).strict();

export type SendDropshipNotificationServiceInput = z.infer<typeof sendDropshipNotificationInputSchema>;
export type ListDropshipNotificationsInput = z.infer<typeof listDropshipNotificationsInputSchema>;
export type MarkDropshipNotificationReadInput = z.infer<typeof markDropshipNotificationReadInputSchema>;
export type UpdateDropshipNotificationPreferenceInput = z.infer<typeof updateDropshipNotificationPreferenceInputSchema>;

export interface DropshipNotificationEventRecord {
  notificationEventId: number;
  vendorId: number;
  eventType: string;
  channel: DropshipNotificationChannel;
  critical: boolean;
  title: string;
  message: string | null;
  payload: Record<string, unknown>;
  status: DropshipNotificationStatus;
  deliveredAt: Date | null;
  readAt: Date | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
}

export interface DropshipNotificationPreferenceRecord {
  notificationPreferenceId: number;
  vendorId: number;
  eventType: string;
  critical: boolean;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  smsEnabled: boolean;
  webhookEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipNotificationListResult {
  items: DropshipNotificationEventRecord[];
  total: number;
  page: number;
  limit: number;
  unreadOnly: boolean;
}

export interface DropshipNotificationSendResult {
  events: DropshipNotificationEventRecord[];
  idempotentReplay: boolean;
}

export interface DropshipNotificationVendorContact {
  vendorId: number;
  email: string | null;
}

export interface DropshipNotificationEmailSender {
  send(input: {
    toEmail: string;
    eventType: string;
    title: string;
    message: string | null;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface RecordDropshipNotificationEventsRepositoryInput extends SendDropshipNotificationServiceInput {
  channels: DropshipNotificationChannel[];
  requestHash: string;
  now: Date;
}

export interface UpsertDropshipNotificationPreferenceRepositoryInput
  extends UpdateDropshipNotificationPreferenceInput {
  now: Date;
}

export interface DropshipNotificationRepository {
  send(input: RecordDropshipNotificationEventsRepositoryInput): Promise<DropshipNotificationSendResult>;
  getVendorContact(vendorId: number): Promise<DropshipNotificationVendorContact>;
  updateEmailDelivery(input: {
    vendorId: number;
    notificationEventId: number;
    status: "delivered" | "failed";
    deliveredAt: Date | null;
  }): Promise<DropshipNotificationEventRecord>;
  listEvents(input: ListDropshipNotificationsInput): Promise<DropshipNotificationListResult>;
  markRead(input: MarkDropshipNotificationReadInput): Promise<DropshipNotificationEventRecord>;
  listPreferences(vendorId: number): Promise<DropshipNotificationPreferenceRecord[]>;
  upsertPreference(
    input: UpsertDropshipNotificationPreferenceRepositoryInput,
  ): Promise<DropshipNotificationPreferenceRecord>;
}

export class DropshipNotificationService {
  constructor(
    private readonly deps: {
      vendorProvisioning: DropshipVendorProvisioningService;
      repository: DropshipNotificationRepository;
      emailSender: DropshipNotificationEmailSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async send(input: unknown): Promise<DropshipNotificationSendResult> {
    const parsed = parseNotificationInput(sendDropshipNotificationInputSchema, input, "DROPSHIP_NOTIFICATION_INVALID_SEND");
    const normalized = {
      ...parsed,
      channels: normalizeNotificationChannels(parsed.channels, parsed.critical),
    };
    const result = await this.deps.repository.send({
      ...normalized,
      requestHash: hashDropshipNotificationSend(normalized),
      now: this.deps.clock.now(),
    });
    const delivered = await this.deliverEmailNotifications(result.events);
    if (!result.idempotentReplay && result.events.length > 0) {
      this.deps.logger.info({
        code: "DROPSHIP_NOTIFICATION_RECORDED",
        message: "Dropship notification event was recorded.",
        context: {
          vendorId: normalized.vendorId,
          eventType: normalized.eventType,
          channels: result.events.map((event) => event.channel),
          critical: normalized.critical,
        },
      });
    }
    return { ...result, events: delivered };
  }

  async listForMember(memberId: string, input: unknown = {}): Promise<DropshipNotificationListResult> {
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.listForVendor(vendor.vendor.vendorId, input);
  }

  async listForVendor(vendorId: number, input: unknown = {}): Promise<DropshipNotificationListResult> {
    const parsed = parseNotificationInput(listDropshipNotificationsInputSchema, {
      ...(typeof input === "object" && input !== null ? input : {}),
      vendorId,
    }, "DROPSHIP_NOTIFICATION_INVALID_LIST");
    return this.deps.repository.listEvents(parsed);
  }

  async markReadForMember(memberId: string, notificationEventId: number): Promise<DropshipNotificationEventRecord> {
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.deps.repository.markRead({
      vendorId: vendor.vendor.vendorId,
      notificationEventId,
      now: this.deps.clock.now(),
    });
  }

  async listPreferencesForMember(memberId: string): Promise<DropshipNotificationPreferenceRecord[]> {
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.deps.repository.listPreferences(vendor.vendor.vendorId);
  }

  async updatePreferenceForMember(
    memberId: string,
    eventType: string,
    input: unknown,
  ): Promise<DropshipNotificationPreferenceRecord> {
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.updatePreference({
      ...(typeof input === "object" && input !== null ? input : {}),
      vendorId: vendor.vendor.vendorId,
      eventType,
    });
  }

  async updatePreference(input: unknown): Promise<DropshipNotificationPreferenceRecord> {
    const parsed = parseNotificationInput(
      updateDropshipNotificationPreferenceInputSchema,
      input,
      "DROPSHIP_NOTIFICATION_INVALID_PREFERENCE",
    );
    if (parsed.smsEnabled === true || parsed.webhookEnabled === true) {
      throw new DropshipError(
        "DROPSHIP_NOTIFICATION_CHANNEL_UNSUPPORTED",
        "SMS and webhook notifications are Phase 2 channels and cannot be enabled yet.",
        {
          eventType: parsed.eventType,
          smsEnabled: parsed.smsEnabled === true,
          webhookEnabled: parsed.webhookEnabled === true,
        },
      );
    }
    if (parsed.critical === true && (parsed.emailEnabled === false || parsed.inAppEnabled === false)) {
      throw new DropshipError(
        "DROPSHIP_NOTIFICATION_CRITICAL_MUTE_REJECTED",
        "Critical dropship notifications must keep email and in-app delivery enabled.",
        { eventType: parsed.eventType },
      );
    }
    const preference = await this.deps.repository.upsertPreference({
      ...parsed,
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: "DROPSHIP_NOTIFICATION_PREFERENCE_UPDATED",
      message: "Dropship notification preference was updated.",
      context: {
        vendorId: preference.vendorId,
        eventType: preference.eventType,
        critical: preference.critical,
      },
    });
    return preference;
  }

  private async deliverEmailNotifications(
    events: DropshipNotificationEventRecord[],
  ): Promise<DropshipNotificationEventRecord[]> {
    const delivered = [...events];
    const emailEvents = events.filter((event) => event.channel === "email" && event.status === "pending");
    if (emailEvents.length === 0) {
      return delivered;
    }
    const contact = await this.deps.repository.getVendorContact(emailEvents[0].vendorId);
    for (const event of emailEvents) {
      const index = delivered.findIndex((candidate) => candidate.notificationEventId === event.notificationEventId);
      if (!contact.email) {
        const failed = await this.deps.repository.updateEmailDelivery({
          vendorId: event.vendorId,
          notificationEventId: event.notificationEventId,
          status: "failed",
          deliveredAt: null,
        });
        if (index >= 0) delivered[index] = failed;
        this.deps.logger.warn({
          code: "DROPSHIP_NOTIFICATION_EMAIL_SKIPPED",
          message: "Dropship notification email could not be sent because the vendor email is missing.",
          context: {
            vendorId: event.vendorId,
            notificationEventId: event.notificationEventId,
            eventType: event.eventType,
          },
        });
        continue;
      }
      try {
        await this.deps.emailSender.send({
          toEmail: contact.email,
          eventType: event.eventType,
          title: event.title,
          message: event.message,
          payload: event.payload,
        });
        const updated = await this.deps.repository.updateEmailDelivery({
          vendorId: event.vendorId,
          notificationEventId: event.notificationEventId,
          status: "delivered",
          deliveredAt: this.deps.clock.now(),
        });
        if (index >= 0) delivered[index] = updated;
      } catch (error) {
        const failed = await this.deps.repository.updateEmailDelivery({
          vendorId: event.vendorId,
          notificationEventId: event.notificationEventId,
          status: "failed",
          deliveredAt: null,
        });
        if (index >= 0) delivered[index] = failed;
        this.deps.logger.error({
          code: "DROPSHIP_NOTIFICATION_EMAIL_FAILED",
          message: "Dropship notification email delivery failed.",
          context: {
            vendorId: event.vendorId,
            notificationEventId: event.notificationEventId,
            eventType: event.eventType,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return delivered;
  }
}

export function hashDropshipNotificationSend(
  input: SendDropshipNotificationServiceInput & { channels: DropshipNotificationChannel[] },
): string {
  return createHash("sha256").update(JSON.stringify({
    vendorId: input.vendorId,
    eventType: input.eventType,
    channels: [...input.channels].sort(),
    critical: input.critical,
    title: input.title,
    message: input.message ?? null,
    payload: input.payload,
  })).digest("hex");
}

export function makeDropshipNotificationLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipNotificationEvent("info", event),
    warn: (event) => logDropshipNotificationEvent("warn", event),
    error: (event) => logDropshipNotificationEvent("error", event),
  };
}

export const systemDropshipNotificationClock: DropshipClock = {
  now: () => new Date(),
};

function normalizeNotificationChannels(
  channels: DropshipNotificationChannel[] | undefined,
  critical: boolean,
): DropshipNotificationChannel[] {
  const requested = channels ?? ["email", "in_app"];
  const normalized = Array.from(new Set(requested));
  if (critical) {
    if (!normalized.includes("email")) normalized.push("email");
    if (!normalized.includes("in_app")) normalized.push("in_app");
  }
  return normalized.sort();
}

function parseNotificationInput<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
  code: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(code, "Dropship notification input failed validation.", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function logDropshipNotificationEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}
