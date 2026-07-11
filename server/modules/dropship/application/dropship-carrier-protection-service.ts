import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";

const positiveId = z.number().int().positive();
const nonnegativeCents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const idempotencyKey = z.string().trim().min(8).max(200);
const actor = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

const createPolicySchema = z.object({
  policyKey: z.string().trim().min(1).max(80),
  supersedesPolicyId: positiveId.optional(),
  name: z.string().trim().min(1).max(160),
  status: z.enum(["draft", "active"]).default("draft"),
  coveredLoss: z.boolean().default(true),
  coveredMisdelivery: z.boolean().default(true),
  coveredDamage: z.boolean().default(true),
  merchandiseReimbursementBps: z.number().int().min(0).max(10000).default(10000),
  shippingReimbursementBps: z.number().int().min(0).max(10000).default(10000),
  deductibleCents: nonnegativeCents.default(0),
  maxCreditCents: nonnegativeCents.nullable().optional(),
  lossWaitDays: z.number().int().min(0).max(365).default(7),
  misdeliveryWaitDays: z.number().int().min(0).max(365).default(2),
  damageInspectionRequired: z.boolean().default(true),
  payoutTrigger: z.enum(["internal_approval", "carrier_claim_approved", "carrier_payment_received"]).default("internal_approval"),
  carrierClaimRequired: z.boolean().default(true),
  approvalMode: z.enum(["manual", "automatic"]).default("manual"),
  automaticApprovalLimitCents: nonnegativeCents.nullable().optional(),
  effectiveFrom: z.coerce.date().nullable().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  idempotencyKey,
  actor,
}).strict().superRefine((input, context) => {
  if (!input.coveredLoss && !input.coveredMisdelivery && !input.coveredDamage) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["coveredLoss"], message: "At least one carrier event must be covered." });
  }
  if (input.approvalMode === "automatic" && input.automaticApprovalLimitCents == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["automaticApprovalLimitCents"], message: "Automatic approval requires a credit limit." });
  }
  if (input.approvalMode === "manual" && input.automaticApprovalLimitCents != null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["automaticApprovalLimitCents"], message: "Manual approval cannot have an automatic approval limit." });
  }
  if (input.payoutTrigger !== "internal_approval" && !input.carrierClaimRequired) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["carrierClaimRequired"], message: "Carrier-dependent payout triggers require carrier claim tracking." });
  }
  if (input.effectiveFrom && input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "Policy end must be after its start." });
  }
});

const policyCommandSchema = z.object({ policyId: positiveId, idempotencyKey, actor }).strict();

const createAssignmentSchema = z.object({
  policyId: positiveId,
  name: z.string().trim().min(1).max(160),
  priority: z.number().int().min(-100000).max(100000).default(0),
  channelId: positiveId.nullable().optional(),
  warehouseId: positiveId.nullable().optional(),
  carrier: z.string().trim().min(1).max(80).nullable().optional(),
  service: z.string().trim().min(1).max(120).nullable().optional(),
  destinationCountry: z.string().trim().length(2).nullable().optional(),
  destinationRegion: z.string().trim().min(1).max(100).nullable().optional(),
  minShipmentValueCents: nonnegativeCents.nullable().optional(),
  maxShipmentValueCents: nonnegativeCents.nullable().optional(),
  isDefault: z.boolean().default(false),
  idempotencyKey,
  actor,
}).strict().superRefine((input, context) => {
  if (input.minShipmentValueCents != null && input.maxShipmentValueCents != null && input.maxShipmentValueCents < input.minShipmentValueCents) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxShipmentValueCents"], message: "Maximum shipment value must be at least the minimum." });
  }
  if (input.isDefault && hasAssignmentScope(input)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["isDefault"], message: "The default assignment cannot contain match conditions." });
  }
  if (input.service && !input.carrier) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["carrier"], message: "A service match requires a carrier match." });
  }
  if (input.destinationRegion && !input.destinationCountry) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationCountry"], message: "A destination region requires a destination country." });
  }
});

const assignmentCommandSchema = z.object({ assignmentId: positiveId, idempotencyKey, actor }).strict();
const resolvePolicySchema = z.object({
  eventType: z.enum(["loss", "misdelivery", "damage"]),
  channelId: positiveId,
  warehouseId: positiveId,
  carrier: z.string().trim().min(1).max(80),
  service: z.string().trim().min(1).max(120),
  destinationCountry: z.string().trim().length(2),
  destinationRegion: z.string().trim().min(1).max(100).nullable().optional(),
  shipmentValueCents: nonnegativeCents,
  occurredAt: z.coerce.date().optional(),
}).strict();

export type CarrierProtectionPolicyStatus = "draft" | "active" | "retired";
export type CarrierProtectionEventType = "loss" | "misdelivery" | "damage";
export type CarrierProtectionPayoutTrigger = "internal_approval" | "carrier_claim_approved" | "carrier_payment_received";
export type CarrierProtectionApprovalMode = "manual" | "automatic";

export interface CarrierProtectionPolicyRecord {
  policyId: number;
  policyKey: string;
  version: number;
  supersedesPolicyId: number | null;
  name: string;
  status: CarrierProtectionPolicyStatus;
  coveredLoss: boolean;
  coveredMisdelivery: boolean;
  coveredDamage: boolean;
  merchandiseReimbursementBps: number;
  shippingReimbursementBps: number;
  deductibleCents: number;
  maxCreditCents: number | null;
  lossWaitDays: number;
  misdeliveryWaitDays: number;
  damageInspectionRequired: boolean;
  payoutTrigger: CarrierProtectionPayoutTrigger;
  carrierClaimRequired: boolean;
  approvalMode: CarrierProtectionApprovalMode;
  automaticApprovalLimitCents: number | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdBy: string | null;
  createdAt: Date;
  retiredAt: Date | null;
}

export interface CarrierProtectionAssignmentRecord {
  assignmentId: number;
  policyId: number;
  policyName: string;
  policyVersion: number;
  name: string;
  priority: number;
  channelId: number | null;
  channelName: string | null;
  warehouseId: number | null;
  warehouseName: string | null;
  carrier: string | null;
  service: string | null;
  destinationCountry: string | null;
  destinationRegion: string | null;
  minShipmentValueCents: number | null;
  maxShipmentValueCents: number | null;
  isDefault: boolean;
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
  deactivatedAt: Date | null;
}

export interface CarrierProtectionOverview {
  policies: CarrierProtectionPolicyRecord[];
  assignments: CarrierProtectionAssignmentRecord[];
  generatedAt: Date;
}
export interface CarrierProtectionMatch {
  policy: CarrierProtectionPolicyRecord;
  assignment: CarrierProtectionAssignmentRecord;
}

export interface CarrierProtectionMutationResult<T> { record: T; idempotentReplay: boolean }
export interface CarrierProtectionCommandContext {
  idempotencyKey: string;
  requestHash: string;
  actor: { actorType: "admin" | "system"; actorId?: string };
  now: Date;
}

export type NormalizedCreateCarrierProtectionPolicy = Omit<z.infer<typeof createPolicySchema>, "idempotencyKey" | "actor" | "effectiveFrom" | "effectiveTo"> & {
  effectiveFrom: Date;
  effectiveTo: Date | null;
};
export type NormalizedCreateCarrierProtectionAssignment = Omit<z.infer<typeof createAssignmentSchema>, "idempotencyKey" | "actor">;

export interface CarrierProtectionRepository {
  getOverview(generatedAt: Date): Promise<CarrierProtectionOverview>;
  createPolicy(input: NormalizedCreateCarrierProtectionPolicy & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>>;
  activatePolicy(input: { policyId: number } & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>>;
  retirePolicy(input: { policyId: number } & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>>;
  createAssignment(input: NormalizedCreateCarrierProtectionAssignment & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionAssignmentRecord>>;
  deactivateAssignment(input: { assignmentId: number } & CarrierProtectionCommandContext): Promise<CarrierProtectionMutationResult<CarrierProtectionAssignmentRecord>>;
  resolvePolicy(input: z.infer<typeof resolvePolicySchema> & { occurredAt: Date }): Promise<CarrierProtectionMatch | null>;
}

export class DropshipCarrierProtectionService {
  constructor(private readonly deps: { repository: CarrierProtectionRepository; clock: DropshipClock; logger: DropshipLogger }) {}

  getOverview(): Promise<CarrierProtectionOverview> {
    return this.deps.repository.getOverview(this.deps.clock.now());
  }

  async createPolicy(input: unknown): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>> {
    const parsed = createPolicySchema.parse(input);
    const now = this.deps.clock.now();
    const policyKey = normalizePolicyKey(parsed.policyKey);
    if (!policyKey) {
      throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_INVALID_INPUT", "Policy code must contain at least one letter or number.");
    }
    const normalized: NormalizedCreateCarrierProtectionPolicy = {
      ...parsed,
      policyKey,
      name: parsed.name.trim(),
      maxCreditCents: parsed.maxCreditCents ?? null,
      automaticApprovalLimitCents: parsed.automaticApprovalLimitCents ?? null,
      effectiveFrom: parsed.effectiveFrom ?? now,
      effectiveTo: parsed.effectiveTo ?? null,
    };
    const result = await this.deps.repository.createPolicy(withContext("carrier_protection_policy_created", normalized, parsed, now));
    this.log("DROPSHIP_CARRIER_PROTECTION_POLICY_CREATED", result, { policyId: result.record.policyId, version: result.record.version });
    return result;
  }

  async retirePolicy(input: unknown): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>> {
    const parsed = policyCommandSchema.parse(input);
    const result = await this.deps.repository.retirePolicy(withContext("carrier_protection_policy_retired", { policyId: parsed.policyId }, parsed, this.deps.clock.now()));
    this.log("DROPSHIP_CARRIER_PROTECTION_POLICY_RETIRED", result, { policyId: result.record.policyId });
    return result;
  }

  async activatePolicy(input: unknown): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>> {
    const parsed = policyCommandSchema.parse(input);
    const result = await this.deps.repository.activatePolicy(withContext("carrier_protection_policy_activated", { policyId: parsed.policyId }, parsed, this.deps.clock.now()));
    this.log("DROPSHIP_CARRIER_PROTECTION_POLICY_ACTIVATED", result, { policyId: result.record.policyId });
    return result;
  }

  async createAssignment(input: unknown): Promise<CarrierProtectionMutationResult<CarrierProtectionAssignmentRecord>> {
    const parsed = createAssignmentSchema.parse(input);
    const normalized: NormalizedCreateCarrierProtectionAssignment = {
      ...parsed,
      channelId: parsed.channelId ?? null,
      warehouseId: parsed.warehouseId ?? null,
      carrier: parsed.carrier?.trim().toUpperCase() ?? null,
      service: parsed.service?.trim() ?? null,
      destinationCountry: parsed.destinationCountry?.trim().toUpperCase() ?? null,
      destinationRegion: parsed.destinationRegion?.trim().toUpperCase() ?? null,
      minShipmentValueCents: parsed.minShipmentValueCents ?? null,
      maxShipmentValueCents: parsed.maxShipmentValueCents ?? null,
    };
    const result = await this.deps.repository.createAssignment(withContext("carrier_protection_assignment_created", normalized, parsed, this.deps.clock.now()));
    this.log("DROPSHIP_CARRIER_PROTECTION_ASSIGNMENT_CREATED", result, { assignmentId: result.record.assignmentId, policyId: result.record.policyId });
    return result;
  }

  async deactivateAssignment(input: unknown): Promise<CarrierProtectionMutationResult<CarrierProtectionAssignmentRecord>> {
    const parsed = assignmentCommandSchema.parse(input);
    const result = await this.deps.repository.deactivateAssignment(withContext("carrier_protection_assignment_deactivated", { assignmentId: parsed.assignmentId }, parsed, this.deps.clock.now()));
    this.log("DROPSHIP_CARRIER_PROTECTION_ASSIGNMENT_DEACTIVATED", result, { assignmentId: result.record.assignmentId });
    return result;
  }

  async resolvePolicy(input: unknown): Promise<CarrierProtectionMatch> {
    const parsed = resolvePolicySchema.parse(input);
    const match = await this.deps.repository.resolvePolicy({
      ...parsed,
      carrier: parsed.carrier.trim().toUpperCase(),
      service: parsed.service.trim(),
      destinationCountry: parsed.destinationCountry.trim().toUpperCase(),
      destinationRegion: parsed.destinationRegion?.trim().toUpperCase() ?? null,
      occurredAt: parsed.occurredAt ?? this.deps.clock.now(),
    });
    if (!match) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_POLICY_NOT_FOUND", "No active carrier-protection policy matches this shipment.");
    return match;
  }

  private log(code: string, result: CarrierProtectionMutationResult<unknown>, context: Record<string, unknown>): void {
    this.deps.logger.info({ code: result.idempotentReplay ? `${code}_REPLAYED` : code, message: "Carrier-protection configuration command completed.", context: { ...context, idempotentReplay: result.idempotentReplay } });
  }
}

export function calculateCarrierProtectionCredit(input: {
  wholesaleCostCents: number;
  shippingChargeCents: number;
  policy: Pick<CarrierProtectionPolicyRecord, "merchandiseReimbursementBps" | "shippingReimbursementBps" | "deductibleCents" | "maxCreditCents">;
}): number {
  assertMoney(input.wholesaleCostCents);
  assertMoney(input.shippingChargeCents);
  const merchandise = Number((BigInt(input.wholesaleCostCents) * BigInt(input.policy.merchandiseReimbursementBps)) / BigInt(10000));
  const shipping = Number((BigInt(input.shippingChargeCents) * BigInt(input.policy.shippingReimbursementBps)) / BigInt(10000));
  const afterDeductible = Math.max(0, merchandise + shipping - input.policy.deductibleCents);
  return input.policy.maxCreditCents == null ? afterDeductible : Math.min(afterDeductible, input.policy.maxCreditCents);
}

function withContext<T extends object>(command: string, normalized: T, parsed: { idempotencyKey: string; actor: CarrierProtectionCommandContext["actor"] }, now: Date): T & CarrierProtectionCommandContext {
  return { ...normalized, idempotencyKey: parsed.idempotencyKey, requestHash: createHash("sha256").update(JSON.stringify({ command, normalized }, (_key, value) => value instanceof Date ? value.toISOString() : value)).digest("hex"), actor: parsed.actor, now };
}

function hasAssignmentScope(input: Record<string, unknown>): boolean {
  return ["channelId", "warehouseId", "carrier", "service", "destinationCountry", "destinationRegion", "minShipmentValueCents", "maxShipmentValueCents"].some((key) => input[key] != null);
}

function normalizePolicyKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function assertMoney(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new DropshipError("DROPSHIP_CARRIER_PROTECTION_INVALID_MONEY", "Carrier-protection calculations require non-negative integer cents.");
}

export function carrierProtectionValidationError(error: unknown): DropshipError | null {
  return error instanceof z.ZodError ? new DropshipError("DROPSHIP_CARRIER_PROTECTION_INVALID_INPUT", "Carrier-protection input failed validation.", { issues: error.issues }) : null;
}

export const systemCarrierProtectionClock: DropshipClock = { now: () => new Date() };
