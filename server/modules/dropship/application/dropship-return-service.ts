import { createHash } from "crypto";
import { z } from "zod";
import { DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import {
  computeDropshipReturnSettlement,
  type DropshipReturnSettlement,
} from "../domain/return-fee-engine";
import {
  DROPSHIP_RMA_STATUSES,
  evaluateDropshipRmaTransition,
} from "../domain/rma-state-machine";
import {
  formatNotificationCurrency,
  sendDropshipNotificationSafely,
} from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type { DropshipOrderIntakeStatus } from "./dropship-order-intake-service";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";
import type { DropshipVendorProvisioningService } from "./dropship-vendor-provisioning-service";
import type { DropshipWalletLedgerRecord } from "./dropship-wallet-service";
import type { DropshipReturnPolicyService } from "./dropship-return-policy-service";

const positiveIdSchema = z.number().int().positive();
const nonnegativeCentsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const nullableStringSchema = z.string().trim().min(1).max(5000).nullable().optional();
const shortNullableStringSchema = z.string().trim().min(1).max(255).nullable().optional();
const jsonObjectSchema = z.record(z.unknown());

export const dropshipRmaStatusSchema = z.enum(DROPSHIP_RMA_STATUSES);
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
  policyVersionId: positiveIdSchema.nullable().optional(),
  actor: z.object({
    actorType: z.enum(["vendor", "admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict();

const createDropshipMemberRmaInputSchema = createDropshipRmaRequestSchema.omit({
  omsOrderId: true,
  returnWindowDays: true,
  storeConnectionId: true,
}).extend({
  intakeId: positiveIdSchema,
}).strict();

const createDropshipReturnPolicyInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  returnWindowDays: z.number().int().positive().max(365).default(DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS),
  isActive: z.boolean().default(true),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
  actor: z.object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict();

const MILLISECONDS_PER_DAY = 86_400_000;

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
  /** Units accepted at inspection. Defaults to the full requested quantity. */
  acceptedQuantity: z.number().int().min(0).max(1_000_000).nullable().optional(),
  finalCreditCents: nonnegativeCentsSchema.nullable().optional(),
  feeCents: nonnegativeCentsSchema.nullable().optional(),
}).strict();

const processDropshipRmaInspectionInputSchema = z.object({
  rmaId: positiveIdSchema,
  outcome: dropshipRmaInspectionOutcomeSchema,
  faultCategory: dropshipReturnFaultCategorySchema,
  /**
   * Admin override (D2b: rules propose, human disposes). When omitted, the
   * fee engine computes the settlement from the economics snapshot + fee
   * schedule. When provided, overrideReason is required.
   */
  creditCents: nonnegativeCentsSchema.nullable().optional(),
  feeCents: nonnegativeCentsSchema.nullable().optional(),
  overrideReason: z.string().trim().min(1).max(1000).nullable().optional(),
  /** Actual return label cost from channel evidence (D2a), when known. */
  returnShippingActualCents: nonnegativeCentsSchema.nullable().optional(),
  notes: nullableStringSchema,
  photos: z.array(jsonObjectSchema).max(20).default([]),
  items: z.array(inspectionItemInputSchema).max(200).default([]),
  idempotencyKey: idempotencyKeySchema,
  actor: z.object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  }).strict(),
}).strict().superRefine((input, ctx) => {
  const creditOverride = input.creditCents !== null && input.creditCents !== undefined;
  const feeOverride = input.feeCents !== null && input.feeCents !== undefined;
  if ((creditOverride || feeOverride) && !input.overrideReason?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["overrideReason"],
      message: "overrideReason is required when creditCents or feeCents override the computed settlement.",
    });
  }
  if (input.items.length === 0) return;
  const itemCredits = input.items.map((item) => item.finalCreditCents);
  const itemFees = input.items.map((item) => item.feeCents);
  const hasItemCredits = itemCredits.every((value) => value !== null && value !== undefined);
  const hasItemFees = itemFees.every((value) => value !== null && value !== undefined);
  if (creditOverride && hasItemCredits) {
    const creditTotal = (itemCredits as number[]).reduce((sum, value) => sum + value, 0);
    if (creditTotal !== input.creditCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Item final credit cents must add up to inspection credit cents.",
      });
    }
  }
  if (feeOverride && hasItemFees) {
    const feeTotal = (itemFees as number[]).reduce((sum, value) => sum + value, 0);
    if (feeTotal !== input.feeCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "Item fee cents must add up to inspection fee cents.",
      });
    }
  }
});

export type CreateDropshipRmaInput = z.infer<typeof createDropshipRmaInputSchema>;
export type CreateDropshipMemberRmaInput = z.infer<typeof createDropshipMemberRmaInputSchema>;
export type CreateDropshipReturnPolicyInput = z.infer<typeof createDropshipReturnPolicyInputSchema>;
export type ListDropshipRmasInput = z.infer<typeof listDropshipRmasInputSchema>;
export type UpdateDropshipRmaStatusInput = z.infer<typeof updateDropshipRmaStatusInputSchema>;
export type ProcessDropshipRmaInspectionInput = z.infer<typeof processDropshipRmaInspectionInputSchema>;

export type NormalizedCreateDropshipReturnPolicyInput = Omit<
  CreateDropshipReturnPolicyInput,
  "idempotencyKey" | "actor"
> & {
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

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
  policyVersionId: number | null;
  items: DropshipRmaItemRecord[];
  inspections: DropshipRmaInspectionRecord[];
  walletLedger: DropshipWalletLedgerRecord[];
}

/** Economics snapshot slice the fee engine needs (credit basis, D2). */
export interface DropshipRmaOrderEconomics {
  intakeId: number;
  wholesaleSubtotalCents: number;
  shippingCents: number;
  currency: string;
  lines: {
    productVariantId: number | null;
    quantity: number;
    wholesaleUnitCostCents: number;
  }[];
}

export interface NormalizedInspectionItem {
  rmaItemId: number;
  status: string;
  finalCreditCents: number;
  feeCents: number;
}

export interface DropshipRmaSettlementContext {
  creditLedgerType: "return_credit" | "insurance_pool_credit";
  policyVersionId: number | null;
  breakdown: Record<string, unknown>;
  overrideReason: string | null;
  computed: DropshipReturnSettlement | null;
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

export interface DropshipRmaOrderLineReference {
  lineIndex: number;
  productVariantId: number | null;
  quantity: number;
}

export interface DropshipRmaOrderReference {
  intakeId: number;
  storeConnectionId: number;
  status: DropshipOrderIntakeStatus;
  omsOrderId: number | null;
  acceptedAt: Date | null;
  lines: DropshipRmaOrderLineReference[];
}

export interface DropshipReturnPolicyRecord {
  policyId: number;
  name: string;
  returnWindowDays: number;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
}

export interface DropshipReturnPolicyMutationResult {
  policy: DropshipReturnPolicyRecord;
  idempotentReplay: boolean;
}

export interface DropshipReturnPolicyCommandContext {
  idempotencyKey: string;
  requestHash: string;
  actor: {
    actorType: "admin" | "system";
    actorId?: string;
  };
  now: Date;
}

export interface DropshipReturnRepository {
  listRmas(input: ListDropshipRmasInput): Promise<DropshipRmaListResult>;
  getRma(input: { rmaId: number; vendorId?: number }): Promise<DropshipRmaDetail | null>;
  getOrderReference(input: { vendorId: number; intakeId: number }): Promise<DropshipRmaOrderReference | null>;
  getOrderEconomics(input: { rmaId: number }): Promise<DropshipRmaOrderEconomics | null>;
  getActiveReturnPolicy(at: Date): Promise<DropshipReturnPolicyRecord | null>;
  createReturnPolicy(
    input: NormalizedCreateDropshipReturnPolicyInput & DropshipReturnPolicyCommandContext,
  ): Promise<DropshipReturnPolicyMutationResult>;
  createRma(input: CreateDropshipRmaInput & { requestHash: string; now: Date }): Promise<{
    rma: DropshipRmaDetail;
    idempotentReplay: boolean;
  }>;
  updateStatus(
    input: UpdateDropshipRmaStatusInput & { policyVersionId: number | null; requestHash: string; now: Date },
  ): Promise<DropshipRmaStatusUpdateResult>;
  processInspection(
    input: NormalizedProcessDropshipRmaInspectionInput & { requestHash: string; now: Date },
  ): Promise<DropshipRmaInspectionResult>;
  closeNoShipTimedOutRmas(input: { now: Date }): Promise<{ closedCount: number }>;
}

/**
 * Repository-facing inspection input: amounts and items are always fully
 * normalized by the service (engine-computed or admin-overridden).
 */
export type NormalizedProcessDropshipRmaInspectionInput = Omit<
  ProcessDropshipRmaInspectionInput,
  "creditCents" | "feeCents" | "items"
> & {
  creditCents: number;
  feeCents: number;
  items: NormalizedInspectionItem[];
  settlement: DropshipRmaSettlementContext;
};

export class DropshipReturnService {
  constructor(
    private readonly deps: {
      vendorProvisioning: DropshipVendorProvisioningService;
      repository: DropshipReturnRepository;
      notificationSender?: DropshipNotificationSender;
      returnPolicyService?: DropshipReturnPolicyService;
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

  async getActiveReturnPolicy(): Promise<DropshipReturnPolicyRecord | null> {
    if (this.deps.returnPolicyService) {
      const resolved = await this.deps.returnPolicyService.resolveReturnPolicy({
        at: this.deps.clock.now(),
      });
      if (resolved) {
        return {
          policyId: resolved.policyId,
          name: `v${resolved.version} (${resolved.returnWindowDays}d)`,
          returnWindowDays: resolved.returnWindowDays,
          isActive: resolved.isActive,
          effectiveFrom: resolved.effectiveFrom,
          effectiveTo: resolved.effectiveTo,
          createdAt: resolved.createdAt,
        };
      }
    }
    return this.deps.repository.getActiveReturnPolicy(this.deps.clock.now());
  }

  /**
   * No-ship timeout sweep (D4): close `requested` RMAs whose return never
   * shipped within the policy-configured timeout (default 14 days, read from
   * the RMA's policy version row). System actor, idempotent per RMA via the
   * deterministic idempotency key. Returns the number of RMAs closed.
   */
  async closeNoShipTimedOutRmas(): Promise<{ closedCount: number }> {
    const now = this.deps.clock.now();
    const result = await this.deps.repository.closeNoShipTimedOutRmas({ now });
    if (result.closedCount > 0) {
      this.deps.logger.info({
        code: "DROPSHIP_RMA_NO_SHIP_SWEEP",
        message: "Dropship RMA no-ship timeout sweep closed requested RMAs.",
        context: { closedCount: result.closedCount, at: now.toISOString() },
      });
    }
    return result;
  }

  async createReturnPolicy(input: unknown): Promise<DropshipReturnPolicyMutationResult> {
    const parsed = parseReturnInput(
      createDropshipReturnPolicyInputSchema,
      input,
      "DROPSHIP_RETURN_POLICY_INVALID_INPUT",
    );
    const now = this.deps.clock.now();
    const normalized: NormalizedCreateDropshipReturnPolicyInput = {
      name: parsed.name.trim(),
      returnWindowDays: parsed.returnWindowDays,
      isActive: parsed.isActive,
      effectiveFrom: parsed.effectiveFrom ?? now,
      effectiveTo: parsed.effectiveTo ?? null,
    };
    assertReturnPolicyEffectiveWindow(normalized);
    const result = await this.deps.repository.createReturnPolicy({
      ...normalized,
      idempotencyKey: parsed.idempotencyKey,
      requestHash: hashDropshipReturnPolicyCreate(normalized),
      actor: parsed.actor,
      now,
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_RETURN_POLICY_CREATED",
        message: "Dropship return policy was created.",
        context: {
          policyId: result.policy.policyId,
          returnWindowDays: result.policy.returnWindowDays,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
    }
    return result;
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
    const now = this.deps.clock.now();
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    const orderReference = await this.deps.repository.getOrderReference({
      vendorId: vendor.vendor.vendorId,
      intakeId: parsed.intakeId,
    });
    if (!orderReference) {
      throw new DropshipError("DROPSHIP_ORDER_INTAKE_NOT_FOUND", "Dropship order intake was not found for the vendor.", {
        vendorId: vendor.vendor.vendorId,
        intakeId: parsed.intakeId,
      });
    }
    assertMemberRmaOrderIsAccepted(parsed, orderReference);
    const resolvedPolicy = this.deps.returnPolicyService
      ? await this.deps.returnPolicyService.resolveReturnPolicy({
          vendorId: vendor.vendor.vendorId,
          storeConnectionId: orderReference.storeConnectionId,
          at: now,
        })
      : null;
    const legacyPolicy = resolvedPolicy ? null : await this.deps.repository.getActiveReturnPolicy(now);
    const returnWindowDays = resolvedPolicy?.returnWindowDays ?? legacyPolicy?.returnWindowDays ?? null;
    if (returnWindowDays === null) {
      throw new DropshipError(
        "DROPSHIP_RETURN_POLICY_REQUIRED",
        "An active dropship return policy is required before vendor RMAs can be submitted.",
        {
          vendorId: vendor.vendor.vendorId,
          intakeId: parsed.intakeId,
          at: now.toISOString(),
        },
      );
    }
    assertMemberRmaWithinReturnWindow(parsed, orderReference, now, returnWindowDays);
    assertMemberRmaItemsMatchOrder(parsed, orderReference);
    return this.createRmaWithNow({
      ...parsed,
      storeConnectionId: orderReference.storeConnectionId,
      omsOrderId: orderReference.omsOrderId,
      returnWindowDays,
      policyVersionId: resolvedPolicy?.policyId ?? null,
      vendorId: vendor.vendor.vendorId,
      actor: { actorType: "vendor", actorId: memberId },
    }, now);
  }

  async createRma(input: unknown): Promise<{ rma: DropshipRmaDetail; idempotentReplay: boolean }> {
    return this.createRmaWithNow(input, this.deps.clock.now());
  }

  private async createRmaWithNow(
    input: unknown,
    now: Date,
  ): Promise<{ rma: DropshipRmaDetail; idempotentReplay: boolean }> {
    const parsed = parseReturnInput(createDropshipRmaInputSchema, input, "DROPSHIP_RETURN_CREATE_INVALID_INPUT");
    const requestHash = hashDropshipRmaCreate(parsed);
    const result = await this.deps.repository.createRma({
      ...parsed,
      requestHash,
      now,
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
    const rma = await this.requireRma({ rmaId: parsed.rmaId, vendorId: parsed.vendorId });
    // Idempotent-replay fast path: when the RMA is already in the target
    // status, the transition has already happened — defer to the repository's
    // idempotency layer (same key + hash replays; a different request with a
    // new key is rejected there as a conflict).
    if (rma.status !== parsed.status) {
      assertRmaTransitionAllowed({
        from: rma.status,
        to: parsed.status,
        actor: parsed.actor,
        reason: parsed.notes ?? null,
        systemLedgerCommit: false,
      });
    }
    const result = await this.deps.repository.updateStatus({
      ...parsed,
      policyVersionId: rma.policyVersionId ?? null,
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
    const now = this.deps.clock.now();
    const rma = await this.requireRma({ rmaId: parsed.rmaId });
    // Idempotent-replay fast path: when this idempotency key already finalized
    // an inspection on the RMA, defer to the repository's replay machinery
    // (hash mismatch there is a conflict, not an illegal transition).
    const alreadyInspectedWithKey = rma.inspections.some(
      (inspection) => inspection.idempotencyKey === parsed.idempotencyKey,
    );
    if (!alreadyInspectedWithKey) {
      // D4: inspection completes inspecting -> approved | rejected. The
      // repository re-enforces under row lock inside the transaction.
      assertRmaTransitionAllowed({
        from: rma.status,
        to: parsed.outcome,
        actor: parsed.actor,
        reason: parsed.notes ?? null,
        systemLedgerCommit: false,
      });
    }
    const settlement = await this.computeInspectionSettlement(parsed, rma, now);
    const result = await this.deps.repository.processInspection({
      ...parsed,
      creditCents: settlement.creditCents,
      feeCents: settlement.feeCents,
      items: settlement.items,
      settlement: {
        creditLedgerType: settlement.creditLedgerType,
        policyVersionId: rma.policyVersionId ?? null,
        breakdown: settlement.breakdown,
        overrideReason: parsed.overrideReason?.trim() || null,
        computed: settlement.computed,
      },
      requestHash: hashDropshipRmaInspection(parsed),
      now,
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

  /**
   * Fee engine entrypoint (D2/D5). When the admin supplies explicit
   * credit/fee overrides (D2b: human disposes), those win and the computed
   * proposal is recorded in the ledger metadata for audit. Otherwise the
   * computed settlement is the settlement.
   */
  private async computeInspectionSettlement(
    input: ProcessDropshipRmaInspectionInput,
    rma: DropshipRmaDetail,
    now: Date,
  ): Promise<{
    creditCents: number;
    feeCents: number;
    items: NormalizedInspectionItem[];
    creditLedgerType: "return_credit" | "insurance_pool_credit";
    breakdown: Record<string, unknown>;
    computed: DropshipReturnSettlement | null;
  }> {
    const creditOverride = input.creditCents !== null && input.creditCents !== undefined;
    const feeOverride = input.feeCents !== null && input.feeCents !== undefined;
    const itemAmountsProvided = input.items.length > 0 && input.items.every(
      (item) => item.finalCreditCents != null && item.feeCents != null,
    );

    // Rejected inspections never move money; fees/credits are zero by rule.
    if (input.outcome === "rejected") {
      return {
        creditCents: 0,
        feeCents: 0,
        items: normalizeInspectionItems(input.items, rma, () => 0, () => 0),
        creditLedgerType: "return_credit",
        breakdown: { version: 1, outcome: "rejected", faultCategory: input.faultCategory },
        computed: null,
      };
    }

    // Full manual path (legacy/admin override with per-item amounts): trust the
    // human disposition, skip the engine. overrideReason is schema-enforced.
    if (creditOverride && feeOverride && itemAmountsProvided) {
      return {
        creditCents: input.creditCents as number,
        feeCents: input.feeCents as number,
        items: normalizeInspectionItems(
          input.items,
          rma,
          (item) => item.finalCreditCents as number,
          (item) => item.feeCents as number,
        ),
        creditLedgerType: input.faultCategory === "carrier" ? "insurance_pool_credit" : "return_credit",
        breakdown: {
          version: 1,
          mode: "manual_override",
          faultCategory: input.faultCategory,
          overrideReason: input.overrideReason?.trim() ?? null,
        },
        computed: null,
      };
    }

    // Engine path: compute from the economics snapshot + resolved fee rows.
    if (!this.deps.returnPolicyService) {
      throw new DropshipError(
        "DROPSHIP_RETURN_FEE_ENGINE_UNAVAILABLE",
        "Dropship return policy service is required to compute the inspection settlement.",
        { rmaId: rma.rmaId },
      );
    }
    const snapshot = await this.deps.repository.getOrderEconomics({ rmaId: rma.rmaId });
    if (!snapshot) {
      throw new DropshipError(
        "DROPSHIP_RETURN_ECONOMICS_NOT_FOUND",
        "Dropship order economics snapshot was not found for the RMA intake.",
        { rmaId: rma.rmaId, intakeId: rma.intakeId },
      );
    }
    const fees = await this.deps.returnPolicyService.resolveReturnFees({
      vendorId: rma.vendorId,
      storeConnectionId: rma.storeConnectionId,
      faultCategory: input.faultCategory,
      at: now,
    });
    const acceptedLines = buildAcceptedLines(input.items, rma, snapshot);
    const computed = computeDropshipReturnSettlement({
      faultCategory: input.faultCategory,
      acceptedLines,
      originalShippingCents: snapshot.shippingCents,
      returnShippingActualCents: input.returnShippingActualCents ?? null,
      fees: {
        restockingFee: fees.restockingFee
          ? { feeType: "restocking_fee", amountType: fees.restockingFee.amountType, amount: fees.restockingFee.amount }
          : null,
        processingFee: fees.processingFee
          ? { feeType: "processing_fee", amountType: fees.processingFee.amountType, amount: fees.processingFee.amount }
          : null,
        returnShippingFee: fees.returnShippingFee
          ? { feeType: "return_shipping_fee", amountType: fees.returnShippingFee.amountType, amount: fees.returnShippingFee.amount }
          : null,
      },
    });

    const creditCents = creditOverride ? (input.creditCents as number) : computed.grossCreditCents;
    const feeCents = feeOverride ? (input.feeCents as number) : computed.totalFeeCents;
    return {
      creditCents,
      feeCents,
      items: allocateInspectionItemAmounts(input.items, rma, computed, creditCents, feeCents),
      creditLedgerType: computed.creditLedgerType,
      breakdown: {
        ...computed.breakdown,
        mode: creditOverride || feeOverride ? "override" : "computed",
        overrideReason: input.overrideReason?.trim() ?? null,
        finalCreditCents: creditCents,
        finalFeeCents: feeCents,
      },
      computed,
    };
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
      eventType: DROPSHIP_NOTIFICATION_EVENTS.RMA_OPENED,
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
      eventType: DROPSHIP_NOTIFICATION_EVENTS.RETURN_CREDIT_POSTED,
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
    creditCents: input.creditCents ?? null,
    feeCents: input.feeCents ?? null,
    overrideReason: input.overrideReason ?? null,
    returnShippingActualCents: input.returnShippingActualCents ?? null,
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

export function hashDropshipReturnPolicyCreate(input: NormalizedCreateDropshipReturnPolicyInput): string {
  return hashReturnRequest({
    name: input.name,
    returnWindowDays: input.returnWindowDays,
    isActive: input.isActive,
    effectiveFrom: input.effectiveFrom.toISOString(),
    effectiveTo: input.effectiveTo?.toISOString() ?? null,
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

function assertReturnPolicyEffectiveWindow(input: NormalizedCreateDropshipReturnPolicyInput): void {
  if (!input.effectiveTo || input.effectiveTo.getTime() > input.effectiveFrom.getTime()) {
    return;
  }
  throw new DropshipError(
    "DROPSHIP_RETURN_POLICY_INVALID_INPUT",
    "Dropship return policy effectiveTo must be after effectiveFrom.",
    {
      effectiveFrom: input.effectiveFrom.toISOString(),
      effectiveTo: input.effectiveTo.toISOString(),
    },
  );
}

function assertMemberRmaOrderIsAccepted(
  input: CreateDropshipMemberRmaInput,
  orderReference: DropshipRmaOrderReference,
): void {
  if (orderReference.status === "accepted" && orderReference.omsOrderId !== null) return;
  throw new DropshipError(
    "DROPSHIP_RETURN_CREATE_INVALID_INPUT",
    "RMA intake references must point to an accepted dropship order.",
    {
      intakeId: input.intakeId,
      status: orderReference.status,
      omsOrderId: orderReference.omsOrderId,
    },
  );
}

function assertMemberRmaWithinReturnWindow(
  input: CreateDropshipMemberRmaInput,
  orderReference: DropshipRmaOrderReference,
  now: Date,
  returnWindowDays: number,
): void {
  if (!orderReference.acceptedAt) {
    throw new DropshipError(
      "DROPSHIP_RETURN_CREATE_INVALID_INPUT",
      "RMA intake references must include an accepted timestamp.",
      { intakeId: input.intakeId },
    );
  }
  const expiresAt = new Date(orderReference.acceptedAt.getTime() + returnWindowDays * MILLISECONDS_PER_DAY);
  if (now.getTime() <= expiresAt.getTime()) {
    return;
  }
  throw new DropshipError(
    "DROPSHIP_RETURN_WINDOW_EXPIRED",
    "Dropship order is outside the return window.",
    {
      intakeId: input.intakeId,
      acceptedAt: orderReference.acceptedAt.toISOString(),
      returnWindowDays,
      expiredAt: expiresAt.toISOString(),
      now: now.toISOString(),
    },
  );
}

function assertMemberRmaItemsMatchOrder(
  input: CreateDropshipMemberRmaInput,
  orderReference: DropshipRmaOrderReference | null,
): void {
  const linkedItems = input.items.filter((item) => item.productVariantId !== null && item.productVariantId !== undefined);
  if (linkedItems.length === 0) {
    return;
  }
  if (!orderReference) {
    throw new DropshipError(
      "DROPSHIP_RETURN_CREATE_INVALID_INPUT",
      "Linked RMA item variants require a dropship order intake.",
      { linkedItemCount: linkedItems.length },
    );
  }

  const orderedQuantityByVariant = new Map<number, number>();
  for (const line of orderReference.lines) {
    if (!line.productVariantId) continue;
    orderedQuantityByVariant.set(
      line.productVariantId,
      (orderedQuantityByVariant.get(line.productVariantId) ?? 0) + line.quantity,
    );
  }

  const requestedQuantityByVariant = new Map<number, number>();
  for (const item of linkedItems) {
    const productVariantId = item.productVariantId;
    if (!productVariantId || !orderedQuantityByVariant.has(productVariantId)) {
      throw new DropshipError(
        "DROPSHIP_RETURN_CREATE_INVALID_INPUT",
        "RMA item product variant does not belong to the linked dropship order.",
        {
          intakeId: orderReference.intakeId,
          productVariantId,
        },
      );
    }
    const nextQuantity = (requestedQuantityByVariant.get(productVariantId) ?? 0) + item.quantity;
    const orderedQuantity = orderedQuantityByVariant.get(productVariantId) ?? 0;
    if (nextQuantity > orderedQuantity) {
      throw new DropshipError(
        "DROPSHIP_RETURN_CREATE_INVALID_INPUT",
        "RMA item quantity exceeds the linked dropship order quantity.",
        {
          intakeId: orderReference.intakeId,
          productVariantId,
          requestedQuantity: nextQuantity,
          orderedQuantity,
        },
      );
    }
    requestedQuantityByVariant.set(productVariantId, nextQuantity);
  }
}

function hashReturnRequest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * D4 enforcement: evaluate the requested transition and throw the 409-coded
 * error on any violation. The repository re-evaluates under row lock.
 */
function assertRmaTransitionAllowed(input: {
  from: DropshipRmaStatus;
  to: DropshipRmaStatus;
  actor: { actorType: "vendor" | "admin" | "system"; actorId?: string | null };
  reason: string | null;
  systemLedgerCommit: boolean;
}): void {
  const decision = evaluateDropshipRmaTransition({
    from: input.from,
    to: input.to,
    actor: {
      actorType: input.actor.actorType,
      actorId: input.actor.actorId ?? null,
    },
    reason: input.reason,
    systemLedgerCommit: input.systemLedgerCommit,
  });
  if (decision.allowed) return;
  throw new DropshipError(
    "DROPSHIP_RMA_ILLEGAL_TRANSITION",
    "Dropship RMA status transition is not allowed.",
    {
      from: input.from,
      to: input.to,
      violation: decision.violation,
    },
  );
}

/**
 * Build the fee engine's accepted lines: inspection items matched to the
 * economics snapshot's wholesale lines by product variant. An item counts as
 * accepted unless its inspection status is "rejected"; acceptedQuantity
 * overrides the default full requested quantity.
 */
function buildAcceptedLines(
  items: ProcessDropshipRmaInspectionInput["items"],
  rma: DropshipRmaDetail,
  snapshot: DropshipRmaOrderEconomics,
): { productVariantId: number | null; acceptedQuantity: number; wholesaleUnitCostCents: number }[] {
  const wholesaleByVariant = new Map<number, number>();
  for (const line of snapshot.lines) {
    if (line.productVariantId !== null && !wholesaleByVariant.has(line.productVariantId)) {
      wholesaleByVariant.set(line.productVariantId, line.wholesaleUnitCostCents);
    }
  }
  const lines: { productVariantId: number | null; acceptedQuantity: number; wholesaleUnitCostCents: number }[] = [];
  for (const item of items) {
    const rmaItem = rma.items.find((candidate) => candidate.rmaItemId === item.rmaItemId);
    if (!rmaItem) {
      throw new DropshipError(
        "DROPSHIP_RMA_ITEM_NOT_FOUND",
        "Dropship RMA inspection referenced an item that was not found on the RMA.",
        { rmaId: rma.rmaId, rmaItemId: item.rmaItemId },
      );
    }
    if (item.status === "rejected") continue;
    const acceptedQuantity = item.acceptedQuantity ?? rmaItem.quantity;
    if (acceptedQuantity <= 0) continue;
    if (acceptedQuantity > rmaItem.quantity) {
      throw new DropshipError(
        "DROPSHIP_RETURN_INSPECTION_INVALID_INPUT",
        "Accepted quantity exceeds the RMA item quantity.",
        { rmaId: rma.rmaId, rmaItemId: item.rmaItemId, acceptedQuantity, requestedQuantity: rmaItem.quantity },
      );
    }
    const wholesaleUnitCostCents = rmaItem.productVariantId !== null
      ? wholesaleByVariant.get(rmaItem.productVariantId) ?? null
      : null;
    if (wholesaleUnitCostCents === null) {
      throw new DropshipError(
        "DROPSHIP_RETURN_ECONOMICS_NOT_FOUND",
        "Dropship order economics snapshot has no wholesale line for the RMA item variant.",
        { rmaId: rma.rmaId, rmaItemId: item.rmaItemId, productVariantId: rmaItem.productVariantId },
      );
    }
    lines.push({
      productVariantId: rmaItem.productVariantId,
      acceptedQuantity,
      wholesaleUnitCostCents,
    });
  }
  return lines;
}

function normalizeInspectionItems(
  items: ProcessDropshipRmaInspectionInput["items"],
  rma: DropshipRmaDetail,
  creditFor: (item: ProcessDropshipRmaInspectionInput["items"][number]) => number,
  feeFor: (item: ProcessDropshipRmaInspectionInput["items"][number]) => number,
): NormalizedInspectionItem[] {
  return items.map((item) => ({
    rmaItemId: item.rmaItemId,
    status: item.status,
    finalCreditCents: creditFor(item),
    feeCents: feeFor(item),
  }));
}

/**
 * Allocate the RMA-level settlement across inspected items proportionally to
 * each item's computed line credit (largest-remainder rounding so the item
 * amounts always sum exactly to the RMA totals — integer cents only).
 */
function allocateInspectionItemAmounts(
  items: ProcessDropshipRmaInspectionInput["items"],
  rma: DropshipRmaDetail,
  settlement: DropshipReturnSettlement,
  totalCreditCents: number,
  totalFeeCents: number,
): NormalizedInspectionItem[] {
  const lineCreditByVariant = new Map<number | null, number>();
  for (const line of settlement.breakdown.acceptedLines as {
    productVariantId: number | null;
    lineCreditCents: number;
  }[]) {
    lineCreditByVariant.set(
      line.productVariantId,
      (lineCreditByVariant.get(line.productVariantId) ?? 0) + line.lineCreditCents,
    );
  }
  const basis = items.map((item) => {
    const rmaItem = rma.items.find((candidate) => candidate.rmaItemId === item.rmaItemId);
    if (!rmaItem || item.status === "rejected") return 0;
    return lineCreditByVariant.get(rmaItem.productVariantId) ?? 0;
  });
  const credits = allocateProRata(basis, totalCreditCents);
  const fees = allocateProRata(basis, totalFeeCents);
  return items.map((item, index) => ({
    rmaItemId: item.rmaItemId,
    status: item.status,
    finalCreditCents: credits[index] ?? 0,
    feeCents: fees[index] ?? 0,
  }));
}

/** Largest-remainder pro-rata allocation; sums exactly to totalCents. */
function allocateProRata(basis: readonly number[], totalCents: number): number[] {
  const basisTotal = basis.reduce((sum, value) => sum + value, 0);
  if (basis.length === 0) return [];
  if (basisTotal <= 0 || totalCents <= 0) return basis.map(() => 0);
  const exact = basis.map((value) => (value * totalCents) / basisTotal);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = totalCents - floors.reduce((sum, value) => sum + value, 0);
  const byFraction = floors
    .map((value, index) => ({ index, fraction: exact[index] - value }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  const allocated = [...floors];
  for (const entry of byFraction) {
    if (remainder <= 0) break;
    allocated[entry.index] += 1;
    remainder -= 1;
  }
  return allocated;
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
