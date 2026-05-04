import { createHash } from "crypto";
import { z } from "zod";
import {
  CentsSchema,
  CurrencyCodeSchema,
} from "../../../../shared/validation/currency";
import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const platformSchema = z.enum(["ebay", "shopify"]);
const jsonObjectSchema = z.record(z.unknown());

const normalizedOrderLineSchema = z.object({
  externalLineItemId: z.string().trim().min(1).max(255).optional(),
  externalListingId: z.string().trim().min(1).max(255).optional(),
  externalOfferId: z.string().trim().min(1).max(255).optional(),
  sku: z.string().trim().min(1).max(120).optional(),
  productVariantId: positiveIdSchema.optional(),
  quantity: z.number().int().positive(),
  unitRetailPriceCents: CentsSchema.optional(),
  title: z.string().trim().min(1).max(500).optional(),
}).strict();

const normalizedShipToSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  company: z.string().trim().min(1).max(255).optional(),
  address1: z.string().trim().min(1).max(255).optional(),
  address2: z.string().trim().min(1).max(255).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  region: z.string().trim().min(1).max(100).optional(),
  postalCode: z.string().trim().min(1).max(30).optional(),
  country: z.string().trim().length(2).optional(),
  phone: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email().max(255).optional(),
}).strict();

const normalizedTotalsSchema = z.object({
  retailSubtotalCents: CentsSchema.optional(),
  shippingPaidCents: CentsSchema.optional(),
  taxCents: CentsSchema.optional(),
  discountCents: CentsSchema.optional(),
  grandTotalCents: CentsSchema.optional(),
  currency: CurrencyCodeSchema.default("USD"),
}).strict();

export const recordDropshipOrderIntakeInputSchema = z.object({
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema,
  platform: platformSchema,
  externalOrderId: z.string().trim().min(1).max(255),
  externalOrderNumber: z.string().trim().min(1).max(100).optional(),
  sourceOrderId: z.string().trim().min(1).max(255).optional(),
  rawPayload: jsonObjectSchema,
  normalizedPayload: z.object({
    lines: z.array(normalizedOrderLineSchema).min(1).max(500),
    shipTo: normalizedShipToSchema.optional(),
    totals: normalizedTotalsSchema.optional(),
    orderedAt: z.string().trim().datetime().optional(),
    marketplaceStatus: z.string().trim().min(1).max(120).optional(),
  }).strict(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type RecordDropshipOrderIntakeInput = z.infer<typeof recordDropshipOrderIntakeInputSchema>;
export type NormalizedDropshipOrderPayload = RecordDropshipOrderIntakeInput["normalizedPayload"];

export type DropshipOrderIntakeStatus =
  | "received"
  | "processing"
  | "accepted"
  | "rejected"
  | "retrying"
  | "failed"
  | "payment_hold"
  | "cancelled"
  | "exception";

export interface DropshipOrderIntakeRecord {
  intakeId: number;
  channelId: number;
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  externalOrderId: string;
  externalOrderNumber: string | null;
  sourceOrderId: string | null;
  status: DropshipOrderIntakeStatus;
  paymentHoldExpiresAt: Date | null;
  rejectionReason: string | null;
  cancellationStatus: string | null;
  rawPayload: Record<string, unknown>;
  normalizedPayload: NormalizedDropshipOrderPayload;
  payloadHash: string;
  omsOrderId: number | null;
  receivedAt: Date;
  acceptedAt: Date | null;
  updatedAt: Date;
}

export interface DropshipOrderIntakeStoreContext {
  vendorId: number;
  vendorStatus: string;
  entitlementStatus: string;
  storeConnectionId: number;
  storeStatus: string;
  platform: DropshipSourcePlatform;
}

export interface DropshipOrderIntakeRepositoryInput extends RecordDropshipOrderIntakeInput {
  payloadHash: string;
  status: "received" | "rejected";
  rejectionReason: string | null;
  receivedAt: Date;
}

export interface DropshipOrderIntakeRepositoryResult {
  intake: DropshipOrderIntakeRecord;
  action: "created" | "updated" | "replayed";
}

export interface DropshipOrderIntakeRepository {
  loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipOrderIntakeStoreContext | null>;

  recordMarketplaceIntake(
    input: DropshipOrderIntakeRepositoryInput,
  ): Promise<DropshipOrderIntakeRepositoryResult>;
}

export class DropshipOrderIntakeService {
  constructor(
    private readonly deps: {
      repository: DropshipOrderIntakeRepository;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async recordMarketplaceOrder(input: unknown): Promise<DropshipOrderIntakeRepositoryResult> {
    const parsed = parseOrderIntakeInput(input);
    const context = await this.deps.repository.loadStoreContext({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
    });
    if (!context) {
      throw new DropshipError(
        "DROPSHIP_ORDER_STORE_CONNECTION_REQUIRED",
        "Dropship store connection is required before recording marketplace order intake.",
        { vendorId: parsed.vendorId, storeConnectionId: parsed.storeConnectionId },
      );
    }
    if (context.platform !== parsed.platform) {
      throw new DropshipError(
        "DROPSHIP_ORDER_STORE_PLATFORM_MISMATCH",
        "Dropship order platform does not match the store connection platform.",
        {
          vendorId: parsed.vendorId,
          storeConnectionId: parsed.storeConnectionId,
          storePlatform: context.platform,
          orderPlatform: parsed.platform,
        },
      );
    }

    const eligibility = evaluateDropshipOrderIntakeEligibility(context);
    const payloadHash = hashDropshipOrderIntakePayload({
      rawPayload: parsed.rawPayload,
      normalizedPayload: parsed.normalizedPayload,
    });
    const result = await this.deps.repository.recordMarketplaceIntake({
      ...parsed,
      payloadHash,
      status: eligibility.status,
      rejectionReason: eligibility.rejectionReason,
      receivedAt: this.deps.clock.now(),
    });

    this.deps.logger.info({
      code: "DROPSHIP_ORDER_INTAKE_RECORDED",
      message: "Dropship marketplace order intake was recorded.",
      context: {
        action: result.action,
        intakeId: result.intake.intakeId,
        vendorId: parsed.vendorId,
        storeConnectionId: parsed.storeConnectionId,
        platform: parsed.platform,
        externalOrderId: parsed.externalOrderId,
        status: result.intake.status,
      },
    });
    await this.notifyRecordedMarketplaceOrder(result);
    return result;
  }

  private async notifyRecordedMarketplaceOrder(
    result: DropshipOrderIntakeRepositoryResult,
  ): Promise<void> {
    if (result.action === "replayed") {
      return;
    }
    if (!["received", "rejected"].includes(result.intake.status)) {
      return;
    }

    const critical = result.intake.status === "rejected";
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: result.intake.vendorId,
      eventType: critical ? "dropship_order_intake_rejected" : "dropship_order_received",
      critical,
      channels: ["email", "in_app"],
      title: critical ? "Dropship order rejected" : "New dropship order received",
      message: critical
        ? `A ${result.intake.platform} order could not be accepted: ${result.intake.rejectionReason ?? "unknown reason"}.`
        : `A ${result.intake.platform} order is ready for dropship processing.`,
      payload: {
        intakeId: result.intake.intakeId,
        vendorId: result.intake.vendorId,
        storeConnectionId: result.intake.storeConnectionId,
        platform: result.intake.platform,
        externalOrderId: result.intake.externalOrderId,
        externalOrderNumber: result.intake.externalOrderNumber,
        status: result.intake.status,
        rejectionReason: result.intake.rejectionReason,
      },
      idempotencyKey: `order-intake:${result.intake.intakeId}:${result.intake.status}`,
    }, {
      code: "DROPSHIP_ORDER_INTAKE_NOTIFICATION_FAILED",
      message: "Dropship order intake notification failed after intake was recorded.",
      context: {
        intakeId: result.intake.intakeId,
        vendorId: result.intake.vendorId,
        storeConnectionId: result.intake.storeConnectionId,
        status: result.intake.status,
      },
    });
  }
}

export function evaluateDropshipOrderIntakeEligibility(
  context: DropshipOrderIntakeStoreContext,
): { status: "received" | "rejected"; rejectionReason: string | null } {
  if (context.vendorStatus !== "active") {
    return {
      status: "rejected",
      rejectionReason: `Vendor status ${context.vendorStatus} does not allow new dropship order intake.`,
    };
  }
  if (context.entitlementStatus !== "active") {
    return {
      status: "rejected",
      rejectionReason: `Entitlement status ${context.entitlementStatus} does not allow new dropship order intake.`,
    };
  }
  if (context.storeStatus !== "connected") {
    return {
      status: "rejected",
      rejectionReason: `Store connection status ${context.storeStatus} does not allow new dropship order intake.`,
    };
  }
  return { status: "received", rejectionReason: null };
}

export function hashDropshipOrderIntakePayload(input: {
  rawPayload: Record<string, unknown>;
  normalizedPayload: NormalizedDropshipOrderPayload;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJsonValue(input)))
    .digest("hex");
}

export function makeDropshipOrderIntakeLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipOrderIntakeEvent("info", event),
    warn: (event) => logDropshipOrderIntakeEvent("warn", event),
    error: (event) => logDropshipOrderIntakeEvent("error", event),
  };
}

export const systemDropshipOrderIntakeClock: DropshipClock = {
  now: () => new Date(),
};

function parseOrderIntakeInput(input: unknown): RecordDropshipOrderIntakeInput {
  const result = recordDropshipOrderIntakeInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INTAKE_INVALID_INPUT",
      "Dropship order intake input failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}

function logDropshipOrderIntakeEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
