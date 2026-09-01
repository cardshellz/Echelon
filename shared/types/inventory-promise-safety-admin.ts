import { z } from "zod";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonnegativeInteger = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);
const nonblank = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const postgresBigintString = z.string().regex(/^(0|[1-9]\d*)$/);

export const INVENTORY_DEMAND_METHOD_VERSION = "irreversible_consumption_v1_28d";
export const INVENTORY_DEMAND_OBSERVATION_DAYS = 28;
export const INVENTORY_DEMAND_MIN_OBSERVED_DAYS = 14;
export const INVENTORY_DEMAND_MIN_SOURCE_EVENTS = 2;
export const INVENTORY_DEMAND_MIN_ACTIVE_DAYS = 2;
export const INVENTORY_DEMAND_MIN_CONSUMPTION_UNITS = 3;
export const INVENTORY_DEMAND_RECENCY_DAYS = 14;
export const INVENTORY_DEMAND_EVIDENCE_MAX_AGE_HOURS = 36;

export const promiseSafetyAdminScopeSchema = z.discriminatedUnion("scopeType", [
  z.object({ scopeType: z.literal("business") }).strict(),
  z.object({
    scopeType: z.literal("network_variant"),
    productVariantId: positiveInteger,
  }).strict(),
  z.object({
    scopeType: z.literal("warehouse_variant"),
    warehouseId: positiveInteger,
    productVariantId: positiveInteger,
  }).strict(),
]);

export const promiseSafetyAdminValueSchema = z.discriminatedUnion("policyMode", [
  z.object({ policyMode: z.literal("inherit") }).strict(),
  z.object({ policyMode: z.literal("off") }).strict(),
  z.object({
    policyMode: z.literal("fixed_units"),
    fixedUnits: nonnegativeInteger,
  }).strict(),
  z.object({
    policyMode: z.literal("days_of_cover"),
    daysOfCoverMilliDays: positiveInteger,
    untrustedDemandFallbackUnits: nonnegativeInteger,
    demandMethodVersion: nonblank(60),
  }).strict(),
]);

export const promiseSafetyPolicyVersionAdminSchema = z.object({
  policyId: positiveInteger,
  version: positiveInteger,
  lifecycleStatus: z.enum(["draft", "sealed", "retired"]),
  scope: promiseSafetyAdminScopeSchema,
  value: promiseSafetyAdminValueSchema,
  definitionHash: sha256Hex,
  changeReason: nonblank(1000),
  createdBy: nonblank(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const promiseSafetyPolicyHeadAdminSchema = z.object({
  scopeKey: nonblank(160),
  revision: postgresBigintString,
  activePolicy: promiseSafetyPolicyVersionAdminSchema.nullable(),
  draftPolicy: promiseSafetyPolicyVersionAdminSchema.nullable(),
}).strict();

export const demandEvidenceAdminSchema = z.object({
  evidenceId: postgresBigintString,
  productVariantId: positiveInteger,
  warehouseId: positiveInteger,
  windowStartedAt: z.string().datetime(),
  windowEndedAt: z.string().datetime(),
  irreversibleConsumptionUnits: postgresBigintString,
  observedDays: nonnegativeInteger,
  dailyDemandMilliUnits: postgresBigintString,
  trustStatus: z.enum(["trusted", "untrusted", "overridden"]),
  trustReasons: z.array(nonblank(500)),
  methodVersion: nonblank(60),
  inputFingerprint: sha256Hex,
  overrideBy: z.string().nullable(),
  overrideReason: z.string().nullable(),
  overrideExpiresAt: z.string().datetime().nullable(),
  calculatedAt: z.string().datetime(),
}).strict();

export const promiseSafetyAdminViewSchema = z.object({
  product: z.object({
    id: positiveInteger,
    sku: z.string().max(100).nullable(),
    name: z.string(),
  }).strict(),
  variants: z.array(z.object({
    id: positiveInteger,
    sku: z.string().max(100).nullable(),
    name: z.string(),
    unitsPerVariant: positiveInteger,
    salesEligibility: z.enum(["sellable", "internal_only"]),
    isActive: z.boolean(),
  }).strict()),
  warehouses: z.array(z.object({
    id: positiveInteger,
    code: nonblank(20),
    name: nonblank(200),
    warehouseType: nonblank(30),
    inventorySourceType: nonblank(20),
  }).strict()),
  policyHeads: z.array(promiseSafetyPolicyHeadAdminSchema),
  demandMethod: z.object({
    methodVersion: z.literal(INVENTORY_DEMAND_METHOD_VERSION),
    observationDays: z.literal(INVENTORY_DEMAND_OBSERVATION_DAYS),
    minimumObservedDays: z.literal(INVENTORY_DEMAND_MIN_OBSERVED_DAYS),
    minimumSourceEvents: z.literal(INVENTORY_DEMAND_MIN_SOURCE_EVENTS),
    minimumActiveDays: z.literal(INVENTORY_DEMAND_MIN_ACTIVE_DAYS),
    minimumConsumptionUnits: z.literal(INVENTORY_DEMAND_MIN_CONSUMPTION_UNITS),
    recencyDays: z.literal(INVENTORY_DEMAND_RECENCY_DAYS),
    maximumEvidenceAgeHours: z.literal(INVENTORY_DEMAND_EVIDENCE_MAX_AGE_HOURS),
  }).strict(),
  demandEvidence: z.array(demandEvidenceAdminSchema),
}).strict();

export const createPromiseSafetyPolicyDraftAdminRequestSchema = z.object({
  scope: promiseSafetyAdminScopeSchema,
  value: promiseSafetyAdminValueSchema,
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict().superRefine((input, context) => {
  if (input.scope.scopeType === "business" && input.value.policyMode === "inherit") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value", "policyMode"],
      message: "The business safety policy cannot inherit from another scope.",
    });
  }
});

export const updatePromiseSafetyPolicyDraftAdminRequestSchema = z.object({
  expectedVersion: positiveInteger,
  expectedDefinitionHash: sha256Hex,
  expectedHeadRevision: postgresBigintString,
  value: promiseSafetyAdminValueSchema,
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict();

export const promiseSafetyPolicyDraftAdminResultSchema = z.object({
  policyId: positiveInteger,
  version: positiveInteger,
  scopeKey: nonblank(160),
  definitionHash: sha256Hex,
  alreadyApplied: z.boolean(),
}).strict();

export const refreshDemandEvidenceAdminRequestSchema = z.object({
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict();

export const refreshDemandEvidenceAdminResultSchema = z.object({
  productId: positiveInteger,
  methodVersion: z.literal(INVENTORY_DEMAND_METHOD_VERSION),
  windowStartedAt: z.string().datetime(),
  windowEndedAt: z.string().datetime(),
  calculatedAt: z.string().datetime(),
  createdSnapshots: nonnegativeInteger,
  reusedSnapshots: nonnegativeInteger,
  trustedSnapshots: nonnegativeInteger,
  untrustedSnapshots: nonnegativeInteger,
  alreadyApplied: z.boolean(),
}).strict();

export type PromiseSafetyAdminScope = z.infer<typeof promiseSafetyAdminScopeSchema>;
export type PromiseSafetyAdminValue = z.infer<typeof promiseSafetyAdminValueSchema>;
export type PromiseSafetyPolicyVersionAdmin = z.infer<
  typeof promiseSafetyPolicyVersionAdminSchema
>;
export type PromiseSafetyPolicyHeadAdmin = z.infer<typeof promiseSafetyPolicyHeadAdminSchema>;
export type PromiseSafetyAdminView = z.infer<typeof promiseSafetyAdminViewSchema>;
export type DemandEvidenceAdmin = z.infer<typeof demandEvidenceAdminSchema>;
export type UpdatePromiseSafetyPolicyDraftAdminRequest = z.infer<
  typeof updatePromiseSafetyPolicyDraftAdminRequestSchema
>;
export type RefreshDemandEvidenceAdminRequest = z.infer<
  typeof refreshDemandEvidenceAdminRequestSchema
>;
export type RefreshDemandEvidenceAdminResult = z.infer<
  typeof refreshDemandEvidenceAdminResultSchema
>;
