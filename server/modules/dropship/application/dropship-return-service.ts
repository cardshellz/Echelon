import { createHash } from "crypto";
import { z } from "zod";
import { DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import {
  formatNotificationCurrency,
  sendDropshipNotificationSafely,
} from "./dropship-notification-dispatch";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";
import type { DropshipVendorProvisioningService } from "./dropship-vendor-provisioning-service";
import type { DropshipWalletLedgerRecord } from "./dropship-wallet-service";

const positiveIdSchema = z.number().int().positive();
const nonnegativeCentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const nullableStringSchema = z.string().trim().min(1).max(5000).nullable().optional();
const shortNullableStringSchema = z.string().trim().min(1).max(255).nullable().optional();
const jsonObjectSchema = z.record(z.unknown());

export const dropshipRmaStatusSchema = z.enum([
  "requested",
  "in_transit",
  "received",
  "inspecting",
  "approved",
  "rejected",
  "credited",
  "closed",
]);
export type DropshipRmaStatus = z.infer<typeof dropshipRmaStatusSchema>;

export const dropshipReturnFaultCategorySchema = z.enum([
  "card_shellz",
  "vendor",
  "customer",
  "marketplace",
  "carrier",
]);
export type DropshipReturnFaultCategory = z.infer<typeof dropshipReturnFaultCategorySchema>;

export const dropshipRmaInspectionOutcomeSchema = z.enum(["approved", "rejected"]);
export type DropshipRmaInspectionOutcome = z.infer<typeof dropshipRmaInspectionOutcomeSchema>;

const rmaItemInputSchema = z.object({
  productVariantId: positiveIdSchema.nullable().optional(),
  quantity: z.number().int().positive(),
  status: z.string().trim().min(1).max(40).default("requested"),
  requestedCreditCents: nonnegativeCentsSchema.nullable().optional(),
}).strict();

const createDropshipRmaRequestSchema = z.object({
  rmaNumber: z.string().trim().min(1).max(80),
  storeConnectionId: positiveIdSchema.nullable().optional(),
  intakeId: positiveIdSchema.nullable().optional(),
  omsOrderId: positiveIdSchema.nullable().optional(),
  reasonCode: shortNullableStringSchema,
  faultCategory: dropshipReturnFaultCategorySchema.nullable().optional(),
  returnWindowDays: z.number().int().positive().max(365).default(DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS),
  labelSource: shortNullableStringSchema,
  returnTrackingNumber: shortNullableStringSchema,
  vendorNotes: nullableStringSchema,
  items: z.array(rmaItemInputSchema).max(200).default([]),
  idempotencyKey: idempotencyKeySchema,
}).strict();

const createDropshipRmaInputSchema = createDropshipRmaRequestSchema.extend({
  vendorId: positiveIdSchema,
  actor: z.object({
    actorType: z.enum(["vendor", "admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict();

const createDropshipMemberRmaInputSchema = createDropshipRmaRequestSchema.omit({ returnWindowDays: true }).strict();

const listDropshipRmasInputSchema = z.object({
  vendorId: positiveIdSchema.optional(),
  statuses: z.array(dropshipRmaStatusSchema).min(1).max(8).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(50),
}).strict();

const updateDropshipRmaStatusInputSchema = z.object({
  rmaId: positiveIdSchema,
  status: dropshipRmaStatusSchema,
  vendorId: positiveIdSchema.optional(),
  notes: nullableStringSchema,
  idempotencyKey: idempotencyKeySchema,
  actor: z.object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict();

const inspectionItemInputSchema = z.object({
  rmaItemId: positiveIdSchema,
  status: z.string().trim().min(1).max(40).default("inspected"),
  finalCreditCents: nonnegativeCentsSchema.default(0),
  feeCents: nonnegativeCentsSchema.default(0),
}).strict();

const processDropshipRmaInspectionInputSchema = z.object({
  rmaId: positiveIdSchema,
  outcome: dropshipRmaInspectionOutcomeSchema,
  faultCategory: dropshipReturnFaultCategorySchema,
  creditCents: nonnegativeCentsSchema.default(0),
  feeCents: nonnegativeCentsSchema.default(0),
  notes: nullableStringSchema,
  photos: z.array(jsonObjectSchema).max(20).default([]),
  items: z.array(inspectionItemInputSchema).max(200).default([]),
  idempotencyKey: idempotencyKeySchema,
  actor: z.object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict().superRefine((input, ctx) => {
  if (input.items.length === 0) return;
  const creditTotal = input.items.reduce((sum, item) => sum + item.finalCreditCents, 0);
  const feeTotal = input.items.reduce((sum, item) => sum + item.feeCents, 0);
  if (creditTotal !== input.creditCents) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: "Item final credit cents must add up to inspection credit cents.",
    });
  }
  if (feeTotal !== input.feeCents) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["items"],
      message: "Item fee cents must add up to inspection fee cents.",
    });
  }
});

export type CreateDropshipRmaInput = z.infer<typeof createDropshipRmaInputSchema>;
export type CreateDropshipMemberRmaInput = z.infer<typeof createDropshipMemberRmaInputSchema>;
export type ListDropshipRmasInput = z.infer<typeof listDropshipRmasInputSchema>;
export type UpdateDropshipRmaStatusInput = z.infer<typeof updateDropshipRmaStatusInputSchema>;
export type ProcessDropshipRmaInspectionInput = z.infer<typeof processDropshipRmaInspectionInputSchema>;

export interface DropshipRmaListItem {
  rmaId: number;
  rmaNumber: string;
  vendorId: number;
  vendorName: string | null;
  vendorEmail: string | null;
  storeConnectionId: number | null;
  platform: string | null;
  intakeId: number | null;
  omsOrderId: number | null;
  status: DropshipRmaStatus;
  reasonCode: string | null;
  faultCategory: DropshipReturnFaultCategory | null;
  returnWindowDays: number;
  returnTrackingNumber: string | null;
  requestedAt: Date;
  receivedAt: Date | null;
  inspectedAt: Date | null;
  creditedAt: Date | null;
  updatedAt: Date;
  itemCount: number;
  totalQuantity: number;
}

export interface DropshipRmaItemRecord {
  rmaItemId: number;
  rmaId: number;
  productVariantId: number | null;
  quantity: number;
  status: string;
  requestedCreditCents: number | null;
  finalCreditCents: number | null;
  feeCents: number | null;
  createdAt: Date;
}

export interface DropshipRmaInspectionRecord {
  rmaInspectionId: number;
  rmaId: number;
  outcome: DropshipRmaInspectionOutcome;
  faultCategory: DropshipReturnFaultCategory | null;
  notes: string | null;
  photos: Record<string, unknown>[];
  creditCents: number;
  feeCents: number;
  inspectedBy: string | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
}

export interface DropshipRmaDetail extends DropshipRmaListItem {
  labelSource: string | null;
  vendorNotes: string | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  items: DropshipRmaItemRecord[];
  inspections: DropshipRmaInspectionRecord[];
  walletLedger: DropshipWalletLedgerRecord[];
}

export interface DropshipRmaListResult {
  items: DropshipRmaListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface DropshipRmaInspectionResult {
  rma: DropshipRmaDetail;
  inspection: DropshipRmaInspectionRecord;
  walletLedger: DropshipWalletLedgerRecord[];
  idempotentReplay: boolean;
}

export interface DropshipRmaStatusUpdateResult {
  rma: DropshipRmaDetail;
  idempotentReplay: boolean;
}

export interface DropshipReturnRepository {
  listRmas(input: ListDropshipRmasInput): Promise<DropshipRmaListResult>;
  getRma(input: { rmaId: number; vendorId?: number }): Promise<DropshipRmaDetail | null>;
  createRma(input: CreateDropshipRmaInput & { requestHash: string; now: Date }): Promise<{
    rma: DropshipRmaDetail;
    idempotentReplay: boolean;
  }>;
  updateStatus(input: UpdateDropshipRmaStatusInput & { requestHash: string; now: Date }): Promise<DropshipRmaStatusUpdateResult>;
  processInspection(input: ProcessDropshipRmaInspectionInput & { requestHash: string; now: Date }): Promise<DropshipRmaInspectionResult>;
}

export class DropshipReturnService {
  constructor(
    private readonly deps: {
      vendorProvisioning: DropshipVendorProvisioningService;
      repository: DropshipReturnRepository;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async listForMember(memberId: string, input: unknown = {}): Promise<DropshipRmaListResult> {
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.listForVendor(vendor.vendor.vendorId, input);
  }

  async listForVendor(vendorId: number, input: unknown = {}): Promise<DropshipRmaListResult> {
    const parsed = parseReturnInput(listDropshipRmasInputSchema, {
      ...(typeof input === "object" && input !== null ? input : {}),
      vendorId,
    }, "DROPSHIP_RETURN_LIST_INVALID_INPUT");
    return this.deps.repository.listRmas(parsed);
  }

  async listForAdmin(input: unknown = {}): Promise<DropshipRmaListResult> {
    const parsed = parseReturnInput(listDropshipRmasInputSchema, input, "DROPSHIP_RETURN_LIST_INVALID_INPUT");
    return this.deps.repository.listRmas(parsed);
  }

  async getForMember(memberId: string, rmaId: number): Promise<DropshipRmaDetail> {
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.requireRma({ rmaId, vendorId: vendor.vendor.vendorId });
  }

  async getForAdmin(rmaId: number): Promise<DropshipRmaDetail> {
    return this.requireRma({ rmaId });
  }

  async createRmaForMember(memberId: string, input: unknown): Promise<{ rma: DropshipRmaDetail; idempotentReplay: boolean }> {
    const parsed = parseReturnInput(createDropshipMemberRmaInputSchema, input, "DROPSHIP_RETURN_CREATE_INVALID_INPUT");
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.createRma({
      ...parsed,
      vendorId: vendor.vendor.vendorId,
      actor: { actorType: "vendor", actorId: memberId },
    });
  }

  async createRma(input: unknown): Promise<{ rma: DropshipRmaDetail; idempotentReplay: boolean }> {
    const parsed = parseReturnInput(createDropshipRmaInputSchema, input, "DROPSHIP_RETURN_CREATE_INVALID_INPUT");
    const requestHash = hashDropshipRmaCreate(parsed);
    const result = await this.deps.repository.createRma({
      ...parsed,
      requestHash,
      now: this.deps.clock.now(),
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_RMA_CREATED",
        message: "Dropship RMA was created.",
        context: {
          rmaId: result.rma.rmaId,
          rmaNumber: result.rma.rmaNumber,
          vendorId: result.rma.vendorId,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
    }
    if (!result.idempotentReplay) {
      await this.notifyRmaCreated(result.rma);
    }
    return result;
  }

  async updateStatus(input: unknown): Promise<DropshipRmaStatusUpdateResult> {
    const parsed = parseReturnInput(updateDropshipRmaStatusInputSchema, input, "DROPSHIP_RETURN_STATUS_INVALID_INPUT");
    const result = await this.deps.repository.updateStatus({
      ...parsed,
      requestHash: hashDropshipRmaStatusUpdate(parsed),
      now: this.deps.clock.now(),
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_RMA_STATUS_UPDATED",
        message: "Dropship RMA status was updated.",
        context: {
          rmaId: result.rma.rmaId,
          status: result.rma.status,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
    }
    return result;
  }

  async processInspection(input: unknown): Promise<DropshipRmaInspectionResult> {
    const parsed = parseReturnInput(
      processDropshipRmaInspectionInputSchema,
      input,
      "DROPSHIP_RETURN_INSPECTION_INVALID_INPUT",
    );
    const result = await this.deps.repository.processInspection({
      ...parsed,
      requestHash: hashDropshipRmaInspection(parsed),
      now: this.deps.clock.now(),
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_RMA_INSPECTED",
        message: "Dropship RMA inspection was finalized.",
        context: {
          rmaId: result.rma.rmaId,
          outcome: result.inspection.outcome,
          faultCategory: result.inspection.faultCategory,
          creditCents: result.inspection.creditCents,
          feeCents: result.inspection.feeCents,
          walletLedgerIds: result.walletLedger.map((entry) => entry.ledgerEntryId),
          idempotencyKey: parsed.idempotencyKey,
        },
      });
      await this.notifyReturnCreditPosted(result);
    }
    return result;
  }

  private async requireRma(input: { rmaId: number; vendorId?: number }): Promise<DropshipRmaDetail> {
    const rma = await this.deps.repository.getRma(input);
    if (!rma) {
      throw new DropshipError("DROPSHIP_RMA_NOT_FOUND", "Dropship RMA was not found.", input);
    }
    return rma;
  }

  private async notifyRmaCreated(rma: DropshipRmaDetail): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: rma.vendorId,
      eventType: "dropship_rma_opened",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship RMA opened",
      message: `RMA ${rma.rmaNumber} was opened for review.`,
      payload: {
        rmaId: rma.rmaId,
        rmaNumber: rma.rmaNumber,
        vendorId: rma.vendorId,
        storeConnectionId: rma.storeConnectionId,
        intakeId: rma.intakeId,
        omsOrderId: rma.omsOrderId,
        status: rma.status,
        reasonCode: rma.reasonCode,
      },
      idempotencyKey: `rma-opened:${rma.rmaId}`,
    }, {
      code: "DROPSHIP_RMA_OPENED_NOTIFICATION_FAILED",
      message: "Dropship RMA opened notification failed after RMA creation.",
      context: {
        rmaId: rma.rmaId,
        rmaNumber: rma.rmaNumber,
        vendorId: rma.vendorId,
      },
    });
  }

  private async notifyReturnCreditPosted(result: DropshipRmaInspectionResult): Promise<void> {
    if (result.inspection.creditCents <= 0 || result.walletLedger.length === 0) {
      return;
    }
    const creditCurrency = result.walletLedger[0]?.currency ?? "USD";

    await sendDropshipNotificationSafely(this.deps, {
      vendorId: result.rma.vendorId,
      eventType: "dropship_return_credit_posted",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship return credit posted",
      message: `RMA ${result.rma.rmaNumber} credit posted for ${formatNotificationCurrency(result.inspection.creditCents, creditCurrency)}.`,
      payload: {
        rmaId: result.rma.rmaId,
        rmaNumber: result.rma.rmaNumber,
        vendorId: result.rma.vendorId,
        inspectionId: result.inspection.rmaInspectionId,
        outcome: result.inspection.outcome,
        faultCategory: result.inspection.faultCategory,
        creditCents: result.inspection.creditCents,
        currency: creditCurrency,
        feeCents: result.inspection.feeCents,
        walletLedgerIds: result.walletLedger.map((entry) => entry.ledgerEntryId),
      },
      idempotencyKey: `rma-credit-posted:${result.rma.rmaId}:${result.inspection.rmaInspectionId}`,
    }, {
      code: "DROPSHIP_RETURN_CREDIT_NOTIFICATION_FAILED",
      message: "Dropship return credit notification failed after inspection finalization.",
      context: {
        rmaId: result.rma.rmaId,
        rmaNumber: result.rma.rmaNumber,
        vendorId: result.rma.vendorId,
        inspectionId: result.inspection.rmaInspectionId,
        creditCents: result.inspection.creditCents,
      },
    });
  }
}

export function hashDropshipRmaCreate(input: CreateDropshipRmaInput): string {
  return hashReturnRequest({
    vendorId: input.vendorId,
    rmaNumber: input.rmaNumber,
    storeConnectionId: input.storeConnectionId ?? null,
    intakeId: input.intakeId ?? null,
    omsOrderId: input.omsOrderId ?? null,
    reasonCode: input.reasonCode ?? null,
    faultCategory: input.faultCategory ?? null,
    returnWindowDays: input.returnWindowDays,
    labelSource: input.labelSource ?? null,
    returnTrackingNumber: input.returnTrackingNumber ?? null,
    vendorNotes: input.vendorNotes ?? null,
    items: input.items,
  });
}

export function hashDropshipRmaInspection(input: ProcessDropshipRmaInspectionInput): string {
  return hashReturnRequest({
    rmaId: input.rmaId,
    outcome: input.outcome,
    faultCategory: input.faultCategory,
    creditCents: input.creditCents,
    feeCents: input.feeCents,
    notes: input.notes ?? null,
    photos: input.photos,
    items: input.items,
  });
}

export function hashDropshipRmaStatusUpdate(input: UpdateDropshipRmaStatusInput): string {
  return hashReturnRequest({
    rmaId: input.rmaId,
    vendorId: input.vendorId ?? null,
    status: input.status,
    notes: input.notes ?? null,
    actor: input.actor,
  });
}

export function makeDropshipReturnLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipReturnEvent("info", event),
    warn: (event) => logDropshipReturnEvent("warn", event),
    error: (event) => logDropshipReturnEvent("error", event),
  };
}

export const systemDropshipReturnClock: DropshipClock = {
  now: () => new Date(),
};

function parseReturnInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown, code: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(code, "Dropship return input failed validation.", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function hashReturnRequest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function logDropshipReturnEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
