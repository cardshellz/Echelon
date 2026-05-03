import { createHash } from "crypto";
import { z } from "zod";
import { CurrencyCodeSchema } from "../../../../shared/validation/currency";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

const positiveIdSchema = z.number().int().positive();
const nonNegativeIntSchema = z.number().int().min(0);
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const optionalTrimmedStringSchema = (max: number) => z.string().trim().min(1).max(max).nullable().optional();
const commandActorSchema = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

const listShippingConfigInputSchema = z.object({
  search: z.string().trim().min(1).max(255).optional(),
  packageProfileLimit: z.number().int().positive().max(250).default(50),
  rateTableLimit: z.number().int().positive().max(100).default(25),
}).strict();

const upsertBoxInputSchema = z.object({
  boxId: positiveIdSchema.optional(),
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  lengthMm: positiveIdSchema,
  widthMm: positiveIdSchema,
  heightMm: positiveIdSchema,
  tareWeightGrams: nonNegativeIntSchema.default(0),
  maxWeightGrams: positiveIdSchema.nullable().optional(),
  isActive: z.boolean().default(true),
  idempotencyKey: idempotencyKeySchema,
  actor: commandActorSchema,
}).strict();

const upsertPackageProfileInputSchema = z.object({
  productVariantId: positiveIdSchema,
  weightGrams: positiveIdSchema,
  lengthMm: positiveIdSchema,
  widthMm: positiveIdSchema,
  heightMm: positiveIdSchema,
  shipAlone: z.boolean().default(false),
  defaultCarrier: optionalTrimmedStringSchema(50),
  defaultService: optionalTrimmedStringSchema(80),
  defaultBoxId: positiveIdSchema.nullable().optional(),
  maxUnitsPerPackage: positiveIdSchema.nullable().optional(),
  isActive: z.boolean().default(true),
  idempotencyKey: idempotencyKeySchema,
  actor: commandActorSchema,
}).strict();

const upsertZoneRuleInputSchema = z.object({
  zoneRuleId: positiveIdSchema.optional(),
  originWarehouseId: positiveIdSchema,
  destinationCountry: z.string().trim().min(2).max(2).default("US"),
  destinationRegion: optionalTrimmedStringSchema(100),
  postalPrefix: optionalTrimmedStringSchema(20),
  zone: z.string().trim().min(1).max(40),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
  idempotencyKey: idempotencyKeySchema,
  actor: commandActorSchema,
}).strict();

const createRateTableRowInputSchema = z.object({
  warehouseId: positiveIdSchema.nullable().optional(),
  destinationZone: z.string().trim().min(1).max(40),
  minWeightGrams: nonNegativeIntSchema.default(0),
  maxWeightGrams: positiveIdSchema,
  rateCents: nonNegativeIntSchema,
}).strict().superRefine((row, context) => {
  if (row.maxWeightGrams < row.minWeightGrams) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxWeightGrams"],
      message: "maxWeightGrams must be greater than or equal to minWeightGrams.",
    });
  }
});

const createRateTableInputSchema = z.object({
  carrier: z.string().trim().min(1).max(50),
  service: z.string().trim().min(1).max(80),
  currency: CurrencyCodeSchema.default("USD"),
  status: z.enum(["draft", "active", "archived"]).default("active"),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  rows: z.array(createRateTableRowInputSchema).min(1).max(500),
  metadata: z.record(z.unknown()).optional(),
  idempotencyKey: idempotencyKeySchema,
  actor: commandActorSchema,
}).strict().superRefine((input, context) => {
  if (input.effectiveTo && input.effectiveFrom && input.effectiveTo <= input.effectiveFrom) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveTo"],
      message: "effectiveTo must be after effectiveFrom.",
    });
  }
});

const createMarkupPolicyInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  markupBps: z.number().int().min(0).max(10000),
  fixedMarkupCents: nonNegativeIntSchema.default(0),
  minMarkupCents: nonNegativeIntSchema.nullable().optional(),
  maxMarkupCents: nonNegativeIntSchema.nullable().optional(),
  isActive: z.boolean().default(true),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
  actor: commandActorSchema,
}).strict().superRefine((input, context) => {
  validateCentsBounds(input.minMarkupCents ?? null, input.maxMarkupCents ?? null, context);
  validateEffectiveWindow(input.effectiveFrom, input.effectiveTo ?? null, context);
});

const createInsurancePolicyInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  feeBps: z.number().int().min(0).max(10000),
  minFeeCents: nonNegativeIntSchema.nullable().optional(),
  maxFeeCents: nonNegativeIntSchema.nullable().optional(),
  isActive: z.boolean().default(true),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
  actor: commandActorSchema,
}).strict().superRefine((input, context) => {
  validateCentsBounds(input.minFeeCents ?? null, input.maxFeeCents ?? null, context);
  validateEffectiveWindow(input.effectiveFrom, input.effectiveTo ?? null, context);
});

export type ListDropshipShippingConfigInput = z.infer<typeof listShippingConfigInputSchema>;
export type UpsertDropshipBoxInput = z.infer<typeof upsertBoxInputSchema>;
export type UpsertDropshipPackageProfileInput = z.infer<typeof upsertPackageProfileInputSchema>;
export type UpsertDropshipZoneRuleInput = z.infer<typeof upsertZoneRuleInputSchema>;
export type CreateDropshipRateTableInput = z.infer<typeof createRateTableInputSchema>;
export type CreateDropshipMarkupPolicyInput = z.infer<typeof createMarkupPolicyInputSchema>;
export type CreateDropshipInsurancePolicyInput = z.infer<typeof createInsurancePolicyInputSchema>;

export interface DropshipBoxConfigRecord {
  boxId: number;
  code: string;
  name: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  tareWeightGrams: number;
  maxWeightGrams: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipPackageProfileConfigRecord {
  packageProfileId: number;
  productVariantId: number;
  productSku: string | null;
  productName: string | null;
  variantSku: string | null;
  variantName: string | null;
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  shipAlone: boolean;
  defaultCarrier: string | null;
  defaultService: string | null;
  defaultBoxId: number | null;
  maxUnitsPerPackage: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipZoneRuleConfigRecord {
  zoneRuleId: number;
  originWarehouseId: number;
  destinationCountry: string;
  destinationRegion: string | null;
  postalPrefix: string | null;
  zone: string;
  priority: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipRateTableRowConfigRecord {
  rateTableRowId: number;
  rateTableId: number;
  warehouseId: number | null;
  destinationZone: string;
  minWeightGrams: number;
  maxWeightGrams: number;
  rateCents: number;
  createdAt: Date;
}

export interface DropshipRateTableConfigRecord {
  rateTableId: number;
  carrier: string;
  service: string;
  currency: string;
  status: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  rows: DropshipRateTableRowConfigRecord[];
}

export interface DropshipShippingMarkupPolicyRecord {
  policyId: number;
  name: string;
  markupBps: number;
  fixedMarkupCents: number;
  minMarkupCents: number | null;
  maxMarkupCents: number | null;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
}

export interface DropshipInsurancePoolPolicyRecord {
  policyId: number;
  name: string;
  feeBps: number;
  minFeeCents: number | null;
  maxFeeCents: number | null;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
}

export interface DropshipShippingConfigOverview {
  boxes: DropshipBoxConfigRecord[];
  packageProfiles: DropshipPackageProfileConfigRecord[];
  zoneRules: DropshipZoneRuleConfigRecord[];
  rateTables: DropshipRateTableConfigRecord[];
  activeMarkupPolicy: DropshipShippingMarkupPolicyRecord | null;
  activeInsurancePolicy: DropshipInsurancePoolPolicyRecord | null;
  generatedAt: Date;
}

export interface DropshipShippingConfigMutationResult<TRecord> {
  record: TRecord;
  idempotentReplay: boolean;
}

export interface DropshipShippingConfigRepository {
  getOverview(input: ListDropshipShippingConfigInput & { generatedAt: Date }): Promise<DropshipShippingConfigOverview>;
  upsertBox(
    input: NormalizedUpsertDropshipBoxInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipBoxConfigRecord>>;
  upsertPackageProfile(
    input: NormalizedUpsertDropshipPackageProfileInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipPackageProfileConfigRecord>>;
  upsertZoneRule(
    input: NormalizedUpsertDropshipZoneRuleInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipZoneRuleConfigRecord>>;
  createRateTable(
    input: NormalizedCreateDropshipRateTableInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipRateTableConfigRecord>>;
  createMarkupPolicy(
    input: NormalizedCreateDropshipMarkupPolicyInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipShippingMarkupPolicyRecord>>;
  createInsurancePolicy(
    input: NormalizedCreateDropshipInsurancePolicyInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipInsurancePoolPolicyRecord>>;
}

export interface DropshipShippingConfigCommandContext {
  idempotencyKey: string;
  requestHash: string;
  actor: {
    actorType: "admin" | "system";
    actorId?: string;
  };
  now: Date;
}

export type NormalizedUpsertDropshipBoxInput = Omit<UpsertDropshipBoxInput, "idempotencyKey" | "actor">;
export type NormalizedUpsertDropshipPackageProfileInput = Omit<UpsertDropshipPackageProfileInput, "idempotencyKey" | "actor">;
export type NormalizedUpsertDropshipZoneRuleInput = Omit<UpsertDropshipZoneRuleInput, "idempotencyKey" | "actor">;
export type NormalizedCreateDropshipRateTableInput = Omit<CreateDropshipRateTableInput, "idempotencyKey" | "actor">;
export type NormalizedCreateDropshipMarkupPolicyInput = Omit<CreateDropshipMarkupPolicyInput, "idempotencyKey" | "actor">;
export type NormalizedCreateDropshipInsurancePolicyInput = Omit<CreateDropshipInsurancePolicyInput, "idempotencyKey" | "actor">;

export class DropshipShippingConfigService {
  constructor(private readonly deps: {
    repository: DropshipShippingConfigRepository;
    clock: DropshipClock;
    logger: DropshipLogger;
  }) {}

  async getOverview(input: unknown = {}): Promise<DropshipShippingConfigOverview> {
    const parsed = listShippingConfigInputSchema.parse(input);
    return this.deps.repository.getOverview({
      ...parsed,
      generatedAt: this.deps.clock.now(),
    });
  }

  async upsertBox(input: unknown): Promise<DropshipShippingConfigMutationResult<DropshipBoxConfigRecord>> {
    const parsed = upsertBoxInputSchema.parse(input);
    const normalized: NormalizedUpsertDropshipBoxInput = {
      ...parsed,
      code: normalizeConfigCode(parsed.code),
      name: parsed.name.trim(),
      maxWeightGrams: parsed.maxWeightGrams ?? null,
    };
    const result = await this.deps.repository.upsertBox(this.withCommandContext("shipping_box_upserted", normalized, parsed));
    this.logMutation("DROPSHIP_SHIPPING_BOX_UPSERTED", result, {
      boxId: result.record.boxId,
      code: result.record.code,
    });
    return result;
  }

  async upsertPackageProfile(
    input: unknown,
  ): Promise<DropshipShippingConfigMutationResult<DropshipPackageProfileConfigRecord>> {
    const parsed = upsertPackageProfileInputSchema.parse(input);
    const normalized: NormalizedUpsertDropshipPackageProfileInput = {
      ...parsed,
      defaultCarrier: parsed.defaultCarrier?.trim() || null,
      defaultService: parsed.defaultService?.trim() || null,
      defaultBoxId: parsed.defaultBoxId ?? null,
      maxUnitsPerPackage: parsed.maxUnitsPerPackage ?? null,
    };
    const result = await this.deps.repository.upsertPackageProfile(
      this.withCommandContext("shipping_package_profile_upserted", normalized, parsed),
    );
    this.logMutation("DROPSHIP_SHIPPING_PACKAGE_PROFILE_UPSERTED", result, {
      packageProfileId: result.record.packageProfileId,
      productVariantId: result.record.productVariantId,
    });
    return result;
  }

  async upsertZoneRule(
    input: unknown,
  ): Promise<DropshipShippingConfigMutationResult<DropshipZoneRuleConfigRecord>> {
    const parsed = upsertZoneRuleInputSchema.parse(input);
    const normalized: NormalizedUpsertDropshipZoneRuleInput = {
      ...parsed,
      destinationCountry: parsed.destinationCountry.trim().toUpperCase(),
      destinationRegion: parsed.destinationRegion?.trim().toUpperCase() || null,
      postalPrefix: parsed.postalPrefix?.trim().toUpperCase() || null,
      zone: normalizeConfigCode(parsed.zone),
    };
    const result = await this.deps.repository.upsertZoneRule(
      this.withCommandContext("shipping_zone_rule_upserted", normalized, parsed),
    );
    this.logMutation("DROPSHIP_SHIPPING_ZONE_RULE_UPSERTED", result, {
      zoneRuleId: result.record.zoneRuleId,
      zone: result.record.zone,
    });
    return result;
  }

  async createRateTable(
    input: unknown,
  ): Promise<DropshipShippingConfigMutationResult<DropshipRateTableConfigRecord>> {
    const parsed = createRateTableInputSchema.parse(input);
    const now = this.deps.clock.now();
    const normalized: NormalizedCreateDropshipRateTableInput = {
      ...parsed,
      carrier: normalizeConfigCode(parsed.carrier),
      service: parsed.service.trim(),
      currency: parsed.currency.toUpperCase(),
      effectiveFrom: parsed.effectiveFrom ?? now,
      effectiveTo: parsed.effectiveTo ?? null,
      metadata: parsed.metadata ?? {},
      rows: parsed.rows.map((row) => ({
        ...row,
        warehouseId: row.warehouseId ?? null,
        destinationZone: normalizeConfigCode(row.destinationZone),
      })),
    };
    const result = await this.deps.repository.createRateTable(
      this.withCommandContext("shipping_rate_table_created", normalized, parsed, now),
    );
    this.logMutation("DROPSHIP_SHIPPING_RATE_TABLE_CREATED", result, {
      rateTableId: result.record.rateTableId,
      rowCount: result.record.rows.length,
    });
    return result;
  }

  async createMarkupPolicy(
    input: unknown,
  ): Promise<DropshipShippingConfigMutationResult<DropshipShippingMarkupPolicyRecord>> {
    const parsed = createMarkupPolicyInputSchema.parse(input);
    const now = this.deps.clock.now();
    const normalized: NormalizedCreateDropshipMarkupPolicyInput = {
      ...parsed,
      name: parsed.name.trim(),
      minMarkupCents: parsed.minMarkupCents ?? null,
      maxMarkupCents: parsed.maxMarkupCents ?? null,
      effectiveFrom: parsed.effectiveFrom ?? now,
      effectiveTo: parsed.effectiveTo ?? null,
    };
    const result = await this.deps.repository.createMarkupPolicy(
      this.withCommandContext("shipping_markup_policy_created", normalized, parsed, now),
    );
    this.logMutation("DROPSHIP_SHIPPING_MARKUP_POLICY_CREATED", result, {
      policyId: result.record.policyId,
      markupBps: result.record.markupBps,
    });
    return result;
  }

  async createInsurancePolicy(
    input: unknown,
  ): Promise<DropshipShippingConfigMutationResult<DropshipInsurancePoolPolicyRecord>> {
    const parsed = createInsurancePolicyInputSchema.parse(input);
    const now = this.deps.clock.now();
    const normalized: NormalizedCreateDropshipInsurancePolicyInput = {
      ...parsed,
      name: parsed.name.trim(),
      minFeeCents: parsed.minFeeCents ?? null,
      maxFeeCents: parsed.maxFeeCents ?? null,
      effectiveFrom: parsed.effectiveFrom ?? now,
      effectiveTo: parsed.effectiveTo ?? null,
    };
    const result = await this.deps.repository.createInsurancePolicy(
      this.withCommandContext("shipping_insurance_policy_created", normalized, parsed, now),
    );
    this.logMutation("DROPSHIP_SHIPPING_INSURANCE_POLICY_CREATED", result, {
      policyId: result.record.policyId,
      feeBps: result.record.feeBps,
    });
    return result;
  }

  private withCommandContext<TInput extends object>(
    commandType: string,
    normalized: TInput,
    parsed: { idempotencyKey: string; actor: DropshipShippingConfigCommandContext["actor"] },
    now = this.deps.clock.now(),
  ): TInput & DropshipShippingConfigCommandContext {
    return {
      ...normalized,
      idempotencyKey: parsed.idempotencyKey,
      requestHash: hashDropshipShippingConfigCommand(commandType, normalized),
      actor: parsed.actor,
      now,
    };
  }

  private logMutation(
    code: string,
    result: DropshipShippingConfigMutationResult<unknown>,
    context: Record<string, unknown>,
  ): void {
    this.deps.logger.info({
      code: result.idempotentReplay ? `${code}_REPLAYED` : code,
      message: result.idempotentReplay
        ? "Dropship shipping config command was replayed by idempotency key."
        : "Dropship shipping config command completed.",
      context: {
        ...context,
        idempotentReplay: result.idempotentReplay,
      },
    });
  }
}

export function hashDropshipShippingConfigCommand(commandType: string, payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ commandType, payload: sortJsonValue(payload) }))
    .digest("hex");
}

export function makeDropshipShippingConfigLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipShippingConfigEvent("info", event),
    warn: (event) => logDropshipShippingConfigEvent("warn", event),
    error: (event) => logDropshipShippingConfigEvent("error", event),
  };
}

export const systemDropshipShippingConfigClock: DropshipClock = {
  now: () => new Date(),
};

function validateCentsBounds(
  minCents: number | null,
  maxCents: number | null,
  context: z.RefinementCtx,
): void {
  if (minCents !== null && maxCents !== null && maxCents < minCents) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxCents"],
      message: "Maximum cents must be greater than or equal to minimum cents.",
    });
  }
}

function validateEffectiveWindow(
  effectiveFrom: Date | undefined,
  effectiveTo: Date | null,
  context: z.RefinementCtx,
): void {
  if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveTo"],
      message: "effectiveTo must be after effectiveFrom.",
    });
  }
}

function normalizeConfigCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "_");
}

function sortJsonValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }
  return value;
}

function logDropshipShippingConfigEvent(
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
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}

export function shippingConfigValidationError(error: unknown): DropshipError | null {
  if (error && typeof error === "object" && "issues" in error) {
    return new DropshipError(
      "DROPSHIP_SHIPPING_CONFIG_INVALID_INPUT",
      "Dropship shipping configuration input failed validation.",
      { issues: (error as { issues: unknown }).issues },
    );
  }
  return null;
}
