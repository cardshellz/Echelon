import { createHash } from "crypto";
import { z } from "zod";
import { DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
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

const createDropshipRmaInputSchema = z.object({
  vendorId: positiveIdSchema,
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
  actor: z.object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict();

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

export interface DropshipReturnRepository {
  listRmas(input: ListDropshipRmasInput): Promise<DropshipRmaListResult>;
  getRma(input: { rmaId: number; vendorId?: number }): Promise<DropshipRmaDetail | null>;
  createRma(input: CreateDropshipRmaInput & { requestHash: string; now: Date }): Promise<{
    rma: DropshipRmaDetail;
    idempotentReplay: boolean;
  }>;
  updateStatus(input: UpdateDropshipRmaStatusInput & { now: Date }): Promise<DropshipRmaDetail>;
  processInspection(input: ProcessDropshipRmaInspectionInput & { requestHash: string; now: Date }): Promise<DropshipRmaInspectionResult>;
}

export class DropshipReturnService {
  constructor(
    private readonly deps: {
      vendorProvisioning: DropshipVendorProvisioningService;
      repository: DropshipReturnRepository;
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
    return result;
  }

  async updateStatus(input: unknown): Promise<DropshipRmaDetail> {
    const parsed = parseReturnInput(updateDropshipRmaStatusInputSchema, input, "DROPSHIP_RETURN_STATUS_INVALID_INPUT");
    const rma = await this.deps.repository.updateStatus({
      ...parsed,
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: "DROPSHIP_RMA_STATUS_UPDATED",
      message: "Dropship RMA status was updated.",
      context: {
        rmaId: rma.rmaId,
        status: rma.status,
        idempotencyKey: parsed.idempotencyKey,
      },
    });
    return rma;
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
