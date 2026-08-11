import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
} from "./dropship-ports";

/**
 * Dropship return policy resolution (design spec D1 + D2; build spec B1).
 *
 * All policy is versioned, immutable config. Resolution is hierarchical:
 *   vendor+store > vendor > store > global
 * Tie-break within a scope level: priority DESC, then id DESC.
 * Exactly one active global row exists (partial unique index, migration 186).
 */

export const dropshipReturnFeeTypeSchema = z.enum([
  "restocking_fee",
  "processing_fee",
  "return_shipping_fee",
]);
export type DropshipReturnFeeType = z.infer<typeof dropshipReturnFeeTypeSchema>;

export const dropshipReturnFeeFaultCategorySchema = z.enum([
  "card_shellz",
  "vendor",
  "customer",
  "marketplace",
  "carrier",
]);
export type DropshipReturnFeeFaultCategory = z.infer<
  typeof dropshipReturnFeeFaultCategorySchema
>;

export const dropshipReturnFeeAmountTypeSchema = z.enum([
  "flat_cents",
  "percent",
]);
export type DropshipReturnFeeAmountType = z.infer<
  typeof dropshipReturnFeeAmountTypeSchema
>;

const positiveIdSchema = z.number().int().positive();

export const resolveReturnPolicyInputSchema = z
  .object({
    vendorId: positiveIdSchema.nullable().optional(),
    storeConnectionId: positiveIdSchema.nullable().optional(),
    at: z.coerce.date().optional(),
  })
  .strict();
export type ResolveReturnPolicyInput = z.infer<
  typeof resolveReturnPolicyInputSchema
>;

export const resolveReturnFeesInputSchema = z
  .object({
    vendorId: positiveIdSchema.nullable().optional(),
    storeConnectionId: positiveIdSchema.nullable().optional(),
    faultCategory: dropshipReturnFeeFaultCategorySchema,
    at: z.coerce.date().optional(),
  })
  .strict();
export type ResolveReturnFeesInput = z.infer<
  typeof resolveReturnFeesInputSchema
>;

export const resolveDefaultReturnFeesInputSchema =
  resolveReturnPolicyInputSchema;
export type ResolveDefaultReturnFeesInput = z.infer<
  typeof resolveDefaultReturnFeesInputSchema
>;

export interface DropshipReturnPolicyVersionRecord {
  policyId: number;
  version: number;
  returnWindowDays: number;
  vendorId: number | null;
  storeConnectionId: number | null;
  priority: number;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipReturnFeeScheduleRecord {
  feeId: number;
  version: number;
  feeType: DropshipReturnFeeType;
  faultCategory: DropshipReturnFeeFaultCategory;
  amountType: DropshipReturnFeeAmountType;
  /** flat_cents: integer cents. percent: 0-100 (two-decimal numeric from DB). */
  amount: number;
  vendorId: number | null;
  storeConnectionId: number | null;
  priority: number;
  isActive: boolean;
  isDefault: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipResolvedReturnFees {
  restockingFee: DropshipReturnFeeScheduleRecord | null;
  processingFee: DropshipReturnFeeScheduleRecord | null;
  /** Presence means the vendor pays return shipping for this fault category. */
  returnShippingFee: DropshipReturnFeeScheduleRecord | null;
}

const createReturnPolicyVersionInputSchema = z
  .object({
    returnWindowDays: z.number().int().positive().max(365),
    vendorId: positiveIdSchema.nullable().optional(),
    storeConnectionId: positiveIdSchema.nullable().optional(),
    priority: z.number().int().min(0).max(1_000_000).default(0),
    effectiveFrom: z.coerce.date().optional(),
    // Edit-as-new-version: when set, the referenced row is deactivated in the
    // same transaction (replacement semantics even if the scope key changed).
    supersedesPolicyId: positiveIdSchema.optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
    actor: z
      .object({
        actorType: z.enum(["admin", "system"]),
        actorId: z.string().trim().min(1).max(255).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.storeConnectionId != null && input.vendorId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["storeConnectionId"],
        message:
          "store-scoped policies require a vendorId (store connections belong to vendors).",
      });
    }
  });
export type CreateReturnPolicyVersionInput = z.infer<
  typeof createReturnPolicyVersionInputSchema
>;

const createReturnFeeVersionInputSchema = z
  .object({
    feeType: dropshipReturnFeeTypeSchema,
    faultCategory: dropshipReturnFeeFaultCategorySchema,
    amountType: dropshipReturnFeeAmountTypeSchema.default("flat_cents"),
    amount: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
    vendorId: positiveIdSchema.nullable().optional(),
    storeConnectionId: positiveIdSchema.nullable().optional(),
    priority: z.number().int().min(0).max(1_000_000).default(0),
    isDefault: z.boolean().default(false),
    effectiveFrom: z.coerce.date().optional(),
    // Edit-as-new-version: same replacement semantics as supersedesPolicyId.
    supersedesFeeId: positiveIdSchema.optional(),
    idempotencyKey: z.string().trim().min(8).max(200),
    actor: z
      .object({
        actorType: z.enum(["admin", "system"]),
        actorId: z.string().trim().min(1).max(255).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.storeConnectionId != null && input.vendorId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["storeConnectionId"],
        message:
          "store-scoped fee rows require a vendorId (store connections belong to vendors).",
      });
    }
    if (input.amountType === "flat_cents" && !Number.isInteger(input.amount)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "flat_cents amounts must be integer cents.",
      });
    }
    if (input.amountType === "percent" && input.amount > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "percent amounts must be between 0 and 100.",
      });
    }
  });
export type CreateReturnFeeVersionInput = z.infer<
  typeof createReturnFeeVersionInputSchema
>;

const deactivateReturnPolicyInputSchema = z
  .object({
    policyId: positiveIdSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
    actor: z
      .object({
        actorType: z.enum(["admin", "system"]),
        actorId: z.string().trim().min(1).max(255).optional(),
      })
      .strict(),
  })
  .strict();

const deactivateReturnFeeInputSchema = z
  .object({
    feeId: positiveIdSchema,
    idempotencyKey: z.string().trim().min(8).max(200),
    actor: z
      .object({
        actorType: z.enum(["admin", "system"]),
        actorId: z.string().trim().min(1).max(255).optional(),
      })
      .strict(),
  })
  .strict();

const listReturnPoliciesInputSchema = z
  .object({
    vendorId: positiveIdSchema.nullable().optional(),
    storeConnectionId: positiveIdSchema.nullable().optional(),
    includeInactive: z.boolean().default(false),
  })
  .strict();

const listReturnFeesInputSchema = z
  .object({
    vendorId: positiveIdSchema.nullable().optional(),
    storeConnectionId: positiveIdSchema.nullable().optional(),
    feeType: dropshipReturnFeeTypeSchema.optional(),
    faultCategory: dropshipReturnFeeFaultCategorySchema.optional(),
    includeInactive: z.boolean().default(false),
  })
  .strict();

export interface DropshipReturnPolicyMutationResult {
  policy: DropshipReturnPolicyVersionRecord;
  idempotentReplay: boolean;
}

export interface DropshipReturnFeeMutationResult {
  fee: DropshipReturnFeeScheduleRecord;
  idempotentReplay: boolean;
}

export interface DropshipReturnPolicyRepository {
  resolveReturnPolicy(input: {
    vendorId: number | null;
    storeConnectionId: number | null;
    at: Date;
  }): Promise<DropshipReturnPolicyVersionRecord | null>;
  resolveReturnFees(input: {
    vendorId: number | null;
    storeConnectionId: number | null;
    faultCategory: DropshipReturnFeeFaultCategory;
    at: Date;
  }): Promise<DropshipResolvedReturnFees>;
  resolveDefaultReturnFees(input: {
    vendorId: number | null;
    storeConnectionId: number | null;
    at: Date;
  }): Promise<DropshipResolvedReturnFees>;
  listPolicies(
    input: z.infer<typeof listReturnPoliciesInputSchema>,
  ): Promise<DropshipReturnPolicyVersionRecord[]>;
  listFees(
    input: z.infer<typeof listReturnFeesInputSchema>,
  ): Promise<DropshipReturnFeeScheduleRecord[]>;
  createPolicyVersion(
    input: Omit<
      CreateReturnPolicyVersionInput,
      "idempotencyKey" | "actor" | "supersedesPolicyId"
    > & {
      supersedesPolicyId: number | null;
      effectiveFrom: Date;
      idempotencyKey: string;
      actor: { actorType: "admin" | "system"; actorId?: string };
      now: Date;
    },
  ): Promise<DropshipReturnPolicyMutationResult>;
  createFeeVersion(
    input: Omit<
      CreateReturnFeeVersionInput,
      "idempotencyKey" | "actor" | "supersedesFeeId"
    > & {
      supersedesFeeId: number | null;
      effectiveFrom: Date;
      idempotencyKey: string;
      actor: { actorType: "admin" | "system"; actorId?: string };
      now: Date;
    },
  ): Promise<DropshipReturnFeeMutationResult>;
  deactivatePolicy(input: {
    policyId: number;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    now: Date;
  }): Promise<DropshipReturnPolicyMutationResult>;
  deactivateFee(input: {
    feeId: number;
    idempotencyKey: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    now: Date;
  }): Promise<DropshipReturnFeeMutationResult>;
}

export class DropshipReturnPolicyService {
  constructor(
    private readonly deps: {
      repository: DropshipReturnPolicyRepository;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  /**
   * Resolve the effective return window policy for a vendor+store at a point in
   * time. Most specific scope wins; ties break by priority DESC then id DESC.
   * Returns null when no row matches (the readiness gate treats that as blocked;
   * migration 186 seeds the global row so this should not happen in practice).
   */
  async resolveReturnPolicy(
    input: unknown,
  ): Promise<DropshipReturnPolicyVersionRecord | null> {
    const parsed = parsePolicyInput(
      resolveReturnPolicyInputSchema,
      input,
      "DROPSHIP_RETURN_POLICY_INVALID_INPUT",
    );
    return this.deps.repository.resolveReturnPolicy({
      vendorId: parsed.vendorId ?? null,
      storeConnectionId: parsed.storeConnectionId ?? null,
      at: parsed.at ?? this.deps.clock.now(),
    });
  }

  /**
   * Resolve the effective fee rows (one per fee type) for a fault category.
   */
  async resolveReturnFees(input: unknown): Promise<DropshipResolvedReturnFees> {
    const parsed = parsePolicyInput(
      resolveReturnFeesInputSchema,
      input,
      "DROPSHIP_RETURN_FEE_INVALID_INPUT",
    );
    return this.deps.repository.resolveReturnFees({
      vendorId: parsed.vendorId ?? null,
      storeConnectionId: parsed.storeConnectionId ?? null,
      faultCategory: parsed.faultCategory,
      at: parsed.at ?? this.deps.clock.now(),
    });
  }

  async resolveDefaultReturnFees(
    input: unknown,
  ): Promise<DropshipResolvedReturnFees> {
    const parsed = parsePolicyInput(
      resolveDefaultReturnFeesInputSchema,
      input,
      "DROPSHIP_RETURN_FEE_INVALID_INPUT",
    );
    return this.deps.repository.resolveDefaultReturnFees({
      vendorId: parsed.vendorId ?? null,
      storeConnectionId: parsed.storeConnectionId ?? null,
      at: parsed.at ?? this.deps.clock.now(),
    });
  }

  async listPolicies(
    input: unknown = {},
  ): Promise<DropshipReturnPolicyVersionRecord[]> {
    const parsed = parsePolicyInput(
      listReturnPoliciesInputSchema,
      input,
      "DROPSHIP_RETURN_POLICY_INVALID_INPUT",
    );
    return this.deps.repository.listPolicies(parsed);
  }

  async listFees(
    input: unknown = {},
  ): Promise<DropshipReturnFeeScheduleRecord[]> {
    const parsed = parsePolicyInput(
      listReturnFeesInputSchema,
      input,
      "DROPSHIP_RETURN_FEE_INVALID_INPUT",
    );
    return this.deps.repository.listFees(parsed);
  }

  /**
   * Create a new policy version. Money fields are immutable once effective —
   * changes are always a new row (new version), never a PATCH (D-governing).
   * Creating an active global row deactivates the previous active global row
   * inside the same transaction (exactly-one-global invariant).
   */
  async createPolicyVersion(
    input: unknown,
  ): Promise<DropshipReturnPolicyMutationResult> {
    const parsed = parsePolicyInput(
      createReturnPolicyVersionInputSchema,
      input,
      "DROPSHIP_RETURN_POLICY_INVALID_INPUT",
    );
    const now = this.deps.clock.now();
    const result = await this.deps.repository.createPolicyVersion({
      returnWindowDays: parsed.returnWindowDays,
      vendorId: parsed.vendorId ?? null,
      storeConnectionId: parsed.storeConnectionId ?? null,
      priority: parsed.priority,
      effectiveFrom: parsed.effectiveFrom ?? now,
      supersedesPolicyId: parsed.supersedesPolicyId ?? null,
      idempotencyKey: parsed.idempotencyKey,
      actor: parsed.actor,
      now,
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_RETURN_POLICY_VERSION_CREATED",
        message: "Dropship return policy version was created.",
        context: {
          policyId: result.policy.policyId,
          version: result.policy.version,
          vendorId: result.policy.vendorId,
          storeConnectionId: result.policy.storeConnectionId,
          returnWindowDays: result.policy.returnWindowDays,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
    }
    return result;
  }

  async createFeeVersion(
    input: unknown,
  ): Promise<DropshipReturnFeeMutationResult> {
    const parsed = parsePolicyInput(
      createReturnFeeVersionInputSchema,
      input,
      "DROPSHIP_RETURN_FEE_INVALID_INPUT",
    );
    const now = this.deps.clock.now();
    const effectiveFrom = parsed.effectiveFrom ?? now;
    if (parsed.isDefault && effectiveFrom > now) {
      throw new DropshipError(
        "DROPSHIP_RETURN_FEE_FUTURE_DEFAULT_UNSUPPORTED",
        "A default fee responsibility must take effect immediately; future default transitions are not supported.",
        {
          feeType: parsed.feeType,
          effectiveFrom: effectiveFrom.toISOString(),
          now: now.toISOString(),
        },
      );
    }
    const result = await this.deps.repository.createFeeVersion({
      feeType: parsed.feeType,
      faultCategory: parsed.faultCategory,
      amountType: parsed.amountType,
      amount: parsed.amount,
      vendorId: parsed.vendorId ?? null,
      storeConnectionId: parsed.storeConnectionId ?? null,
      priority: parsed.priority,
      isDefault: parsed.isDefault,
      effectiveFrom,
      supersedesFeeId: parsed.supersedesFeeId ?? null,
      idempotencyKey: parsed.idempotencyKey,
      actor: parsed.actor,
      now,
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_RETURN_FEE_VERSION_CREATED",
        message: "Dropship return fee schedule version was created.",
        context: {
          feeId: result.fee.feeId,
          version: result.fee.version,
          feeType: result.fee.feeType,
          faultCategory: result.fee.faultCategory,
          amountType: result.fee.amountType,
          amount: result.fee.amount,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
    }
    return result;
  }

  async deactivatePolicy(
    input: unknown,
  ): Promise<DropshipReturnPolicyMutationResult> {
    const parsed = parsePolicyInput(
      deactivateReturnPolicyInputSchema,
      input,
      "DROPSHIP_RETURN_POLICY_INVALID_INPUT",
    );
    const result = await this.deps.repository.deactivatePolicy({
      policyId: parsed.policyId,
      idempotencyKey: parsed.idempotencyKey,
      actor: parsed.actor,
      now: this.deps.clock.now(),
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_RETURN_POLICY_DEACTIVATED",
        message: "Dropship return policy was deactivated.",
        context: {
          policyId: result.policy.policyId,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
    }
    return result;
  }

  async deactivateFee(
    input: unknown,
  ): Promise<DropshipReturnFeeMutationResult> {
    const parsed = parsePolicyInput(
      deactivateReturnFeeInputSchema,
      input,
      "DROPSHIP_RETURN_FEE_INVALID_INPUT",
    );
    const result = await this.deps.repository.deactivateFee({
      feeId: parsed.feeId,
      idempotencyKey: parsed.idempotencyKey,
      actor: parsed.actor,
      now: this.deps.clock.now(),
    });
    if (!result.idempotentReplay) {
      this.deps.logger.info({
        code: "DROPSHIP_RETURN_FEE_DEACTIVATED",
        message: "Dropship return fee schedule row was deactivated.",
        context: {
          feeId: result.fee.feeId,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
    }
    return result;
  }
}

export function makeDropshipReturnPolicyLogger(): DropshipLogger {
  return {
    info: (event) => logPolicyEvent("info", event),
    warn: (event) => logPolicyEvent("warn", event),
    error: (event) => logPolicyEvent("error", event),
  };
}

export const systemDropshipReturnPolicyClock: DropshipClock = {
  now: () => new Date(),
};

function parsePolicyInput<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
  code: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      code,
      "Dropship return policy input failed validation.",
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

function logPolicyEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
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
