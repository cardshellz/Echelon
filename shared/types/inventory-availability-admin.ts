import { z } from "zod";
import { PRODUCT_INVENTORY_STRATEGIES } from "../catalog/inventory-strategy";
import { VARIANT_UOM_TYPES } from "../catalog/variant-uom";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
export const postgresBigintStringSchema = z.string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= POSTGRES_BIGINT_MAX, {
    message: "Must be a nonnegative PostgreSQL bigint decimal string",
  });
const nonblank = (max: number) => z.string().trim().min(1).max(max);

export const inventoryPlanningProductOptionsQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const inventoryPlanningProductOptionSchema = z.object({
  id: positiveInteger,
  sku: z.string().max(100).nullable(),
  name: z.string(),
}).strict();

export const inventoryPlanningProductOptionsResponseSchema = z.object({
  products: z.array(inventoryPlanningProductOptionSchema).max(100),
}).strict();

export type InventoryPlanningProductOptionsQuery = z.infer<
  typeof inventoryPlanningProductOptionsQuerySchema
>;

export type InventoryPlanningProductOptionsResponse = z.infer<
  typeof inventoryPlanningProductOptionsResponseSchema
>;

export const transformationDraftBindingInputSchema = z.object({
  bindingKey: nonblank(120),
  recipeId: positiveInteger,
  relationshipRole: z.enum([
    "component_build",
    "directional_conversion",
    "disassembly",
  ]),
  warehouseId: positiveInteger.nullable(),
}).strict();

export const transformationDraftPathInputSchema = z.object({
  sourceVariantId: positiveInteger,
  destinationVariantId: positiveInteger,
  inputQty: positiveInteger,
  outputQty: positiveInteger,
  operationType: z.enum([
    "break_pack",
    "assemble_pack",
    "directed_conversion",
  ]),
  authorityState: z.enum(["allowed", "blocked"]),
  transformationRecipeBindingKey: nonblank(120).nullable(),
}).strict();

export const createTransformationModelDraftRequestSchema = z.object({
  productId: positiveInteger,
  buildToPromiseEnabled: z.boolean(),
  paths: z.array(transformationDraftPathInputSchema).max(500),
  recipeBindings: z.array(transformationDraftBindingInputSchema).max(200),
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict();

export const updateTransformationModelDraftRequestSchema = z.object({
  expectedVersion: positiveInteger,
  expectedDefinitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  expectedHeadRevision: postgresBigintStringSchema,
  buildToPromiseEnabled: z.boolean(),
  paths: z.array(transformationDraftPathInputSchema).max(500),
  recipeBindings: z.array(transformationDraftBindingInputSchema).max(200),
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict();

export type CreateTransformationModelDraftRequest = z.infer<
  typeof createTransformationModelDraftRequestSchema
>;

export type UpdateTransformationModelDraftRequest = z.infer<
  typeof updateTransformationModelDraftRequestSchema
>;

export const createTransformationModelDraftResultSchema = z.object({
  modelId: positiveInteger,
  version: positiveInteger,
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  alreadyApplied: z.boolean(),
}).strict();

export const locationPromisePolicyDraftResultSchema = z.object({
  policyId: positiveInteger,
  version: positiveInteger,
  alreadyApplied: z.boolean(),
}).strict();

export const promiseSafetyPolicyDraftResultSchema = z.object({
  policyId: positiveInteger,
  version: positiveInteger,
  scopeKey: nonblank(250),
  alreadyApplied: z.boolean(),
}).strict();

export const transformationAdminVariantSchema = z.object({
  id: positiveInteger,
  productId: positiveInteger,
  sku: z.string().max(100).nullable(),
  name: z.string(),
  unitsPerVariant: positiveInteger,
  uomType: z.enum(VARIANT_UOM_TYPES),
  isActive: z.boolean(),
}).strict();

export const transformationAdminRecipeComponentSchema = z.object({
  componentVariantId: positiveInteger,
  componentProductId: positiveInteger,
  componentUnitsPerVariant: positiveInteger,
  componentQty: positiveInteger,
  sku: z.string().max(100).nullable(),
  name: z.string(),
  isActive: z.boolean(),
}).strict();

export const transformationAdminRecipeSchema = z.object({
  id: positiveInteger,
  code: nonblank(50),
  name: nonblank(150),
  version: positiveInteger,
  status: z.literal("active"),
  recipeType: z.enum(["assembly", "conversion"]),
  outputProductId: positiveInteger,
  outputVariantId: positiveInteger,
  outputUnitsPerVariant: positiveInteger,
  outputQty: positiveInteger,
  components: z.array(transformationAdminRecipeComponentSchema),
}).strict();

export const transformationAdminBindingComponentSchema = z.object({
  componentVariantId: positiveInteger,
  componentProductId: positiveInteger,
  componentUnitsPerVariant: positiveInteger,
  componentQty: positiveInteger,
}).strict();

export const transformationAdminBindingSchema = z.object({
  bindingKey: nonblank(120),
  recipeId: positiveInteger,
  relationshipRole: z.enum([
    "component_build",
    "directional_conversion",
    "disassembly",
  ]),
  warehouseId: positiveInteger.nullable(),
  recipeCodeSnapshot: nonblank(50),
  recipeVersionSnapshot: positiveInteger,
  recipeDefinitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  outputProductIdSnapshot: positiveInteger,
  outputVariantIdSnapshot: positiveInteger,
  outputUnitsPerVariantSnapshot: positiveInteger,
  outputQtySnapshot: positiveInteger,
  components: z.array(transformationAdminBindingComponentSchema).min(1),
}).strict();

export const transformationAdminPathSchema = z.object({
  sourceVariantId: positiveInteger,
  destinationVariantId: positiveInteger,
  inputQty: positiveInteger,
  outputQty: positiveInteger,
  sourceUnitsPerVariant: positiveInteger,
  destinationUnitsPerVariant: positiveInteger,
  operationType: z.enum(["break_pack", "assemble_pack", "directed_conversion"]),
  authorityState: z.enum(["allowed", "blocked"]),
  transformationRecipeBindingKey: nonblank(120).nullable(),
}).strict();

export const transformationAdminModelSchema = z.object({
  id: positiveInteger,
  productId: positiveInteger,
  version: positiveInteger,
  lifecycleStatus: z.enum(["draft", "sealed", "retired"]),
  buildToPromiseEnabled: z.boolean(),
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  origin: z.enum(["operator", "phase3_backfill"]),
  originInputHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  originResultHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  validationState: z.enum(["valid", "invalid"]),
  validationErrors: z.array(z.unknown()),
  changeReason: z.string(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  bindings: z.array(transformationAdminBindingSchema),
  paths: z.array(transformationAdminPathSchema),
}).strict().superRefine((model, context) => {
  const hasBackfillHashes = model.originInputHash !== null && model.originResultHash !== null;
  if ((model.origin === "phase3_backfill") !== hasBackfillHashes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["originInputHash"],
      message: "Phase 3 backfill models require both origin hashes; operator models require neither",
    });
  }
});

export const supplyTransformationsAdminViewSchema = z.object({
  product: z.object({
    id: positiveInteger,
    sku: z.string().max(100).nullable(),
    name: z.string(),
    isActive: z.boolean(),
    legacyInventoryStrategy: z.enum(PRODUCT_INVENTORY_STRATEGIES),
  }).strict(),
  variants: z.array(transformationAdminVariantSchema),
  recipes: z.array(transformationAdminRecipeSchema),
  head: z.object({
    revision: postgresBigintStringSchema,
    activeModelId: positiveInteger.nullable(),
    draftModelId: positiveInteger.nullable(),
  }).strict().nullable(),
  activeModel: transformationAdminModelSchema.nullable(),
  draftModel: transformationAdminModelSchema.nullable(),
  runtimeAuthority: z.object({
    kind: z.literal("legacy_inventory_strategy"),
    value: z.enum(PRODUCT_INVENTORY_STRATEGIES),
    draftAffectsRuntime: z.literal(false),
  }).strict(),
}).strict();

export type CreateTransformationModelDraftResult = z.infer<
  typeof createTransformationModelDraftResultSchema
>;
export type LocationPromisePolicyDraftResult = z.infer<
  typeof locationPromisePolicyDraftResultSchema
>;
export type PromiseSafetyPolicyDraftResult = z.infer<
  typeof promiseSafetyPolicyDraftResultSchema
>;
export type TransformationAdminVariant = z.infer<typeof transformationAdminVariantSchema>;
export type TransformationAdminRecipeComponent = z.infer<
  typeof transformationAdminRecipeComponentSchema
>;
export type TransformationAdminRecipe = z.infer<typeof transformationAdminRecipeSchema>;
export type TransformationAdminBindingComponent = z.infer<
  typeof transformationAdminBindingComponentSchema
>;
export type TransformationAdminBinding = z.infer<typeof transformationAdminBindingSchema>;
export type TransformationAdminPath = z.infer<typeof transformationAdminPathSchema>;
export type TransformationAdminModel = z.infer<typeof transformationAdminModelSchema>;
export type SupplyTransformationsAdminView = z.infer<
  typeof supplyTransformationsAdminViewSchema
>;
