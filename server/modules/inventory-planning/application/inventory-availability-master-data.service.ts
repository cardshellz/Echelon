import type {
  CreateTransformationModelDraftRequest,
  CreateTransformationModelDraftResult,
  InventoryPlanningProductOptionsQuery,
  InventoryPlanningProductOptionsResponse,
  SupplyTransformationsAdminView,
  TransformationAdminRecipe,
  UpdateTransformationModelDraftRequest,
} from "@shared/types/inventory-availability-admin";
import {
  createTransformationModelDraftRequestSchema,
  inventoryPlanningProductOptionsQuerySchema,
  inventoryPlanningProductOptionsResponseSchema,
  supplyTransformationsAdminViewSchema,
  updateTransformationModelDraftRequestSchema,
} from "@shared/types/inventory-availability-admin";
import { z } from "zod";

import {
  auditedDraftCommandSchema,
  calculateLocationPromisePolicyDefinitionHash,
  calculateMasterDataDraftRequestHash,
  calculatePromiseSafetyPolicyDefinitionHash,
  calculateRecipeDefinitionHash,
  InventoryAvailabilityMasterDataError,
  locationPromisePolicyDraftSchema,
  promiseSafetyPolicyDraftSchema,
  transformationModelDefinitionSchema,
  type InventoryAvailabilityMasterDataRepository,
  type TransformationModelDefinition,
} from "../domain/inventory-availability-master-data.contracts";

const actorSchema = z.string().trim().min(1).max(100);
const draftMetadataSchema = z.object({
  changeReason: z.string().trim().min(1).max(1000),
  idempotencyKey: z.string().trim().min(1).max(120),
}).strict();

export type CreateLocationPromisePolicyDraftInput =
  z.infer<typeof locationPromisePolicyDraftSchema>
  & z.infer<typeof draftMetadataSchema>;

export type CreatePromiseSafetyPolicyDraftInput =
  z.infer<typeof promiseSafetyPolicyDraftSchema>
  & z.infer<typeof draftMetadataSchema>;

export type InventoryAvailabilityMasterDataReplay =
  | {
      commandType: "transformation_model";
      requestHash: string;
      result: CreateTransformationModelDraftResult;
    }
  | {
      commandType: "transformation_model_draft_update";
      requestHash: string;
      result: CreateTransformationModelDraftResult;
    }
  | {
      commandType: "location_promise_policy";
      requestHash: string;
      result: { policyId: number; version: number; alreadyApplied: boolean };
    }
  | {
      commandType: "promise_safety_policy";
      requestHash: string;
      result: {
        policyId: number;
        version: number;
        scopeKey: string;
        alreadyApplied: boolean;
      };
    };

export interface InventoryAvailabilityMasterDataAdminStore
extends InventoryAvailabilityMasterDataRepository {
  findMasterDataDraftReplay(
    idempotencyKey: string,
  ): Promise<InventoryAvailabilityMasterDataReplay | null>;
  listProductOptions(
    query: InventoryPlanningProductOptionsQuery,
  ): Promise<InventoryPlanningProductOptionsResponse["products"]>;
  getSupplyTransformationsAdminView(
    productId: number,
  ): Promise<SupplyTransformationsAdminView | null>;
}

export interface InventoryAvailabilityMasterDataClock {
  now(): Date;
}

const systemClock: InventoryAvailabilityMasterDataClock = {
  now: () => new Date(),
};

export class InventoryAvailabilityMasterDataService {
  constructor(
    private readonly store: InventoryAvailabilityMasterDataAdminStore,
    private readonly clock: InventoryAvailabilityMasterDataClock = systemClock,
  ) {}

  async listProductOptions(
    input: InventoryPlanningProductOptionsQuery,
  ): Promise<InventoryPlanningProductOptionsResponse> {
    const query = parseInput(
      inventoryPlanningProductOptionsQuerySchema,
      input,
      "Review the product search fields.",
    );
    const products = await this.store.listProductOptions(query);
    return inventoryPlanningProductOptionsResponseSchema.parse({ products });
  }

  async getSupplyTransformationsAdminView(
    productIdInput: number,
  ): Promise<SupplyTransformationsAdminView> {
    const productId = parsePositiveId(productIdInput, "productId");
    const view = await this.store.getSupplyTransformationsAdminView(productId);
    if (!view) {
      throw new InventoryAvailabilityMasterDataError(
        404,
        "INVENTORY_AVAILABILITY_PRODUCT_NOT_FOUND",
        "The catalog product does not exist.",
      );
    }
    return supplyTransformationsAdminViewSchema.parse(view);
  }

  async createTransformationModelDraft(
    input: CreateTransformationModelDraftRequest,
    actorInput: string,
  ): Promise<CreateTransformationModelDraftResult> {
    const actorId = parseActor(actorInput);
    const request = parseInput(
      createTransformationModelDraftRequestSchema,
      input,
      "Review the transformation model draft fields.",
    );
    const requestHash = calculateMasterDataDraftRequestHash("transformation_model", {
      actorId,
      changeReason: request.changeReason,
      definition: transformationCreateIntent(request),
    });
    const replay = resolveReplay(
      await this.store.findMasterDataDraftReplay(request.idempotencyKey),
      "transformation_model",
      requestHash,
    );
    if (replay) return replay;

    const context = await this.getSupplyTransformationsAdminView(request.productId);
    if (!context.product.isActive) {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_PRODUCT_INACTIVE",
        "A transformation draft cannot be created for an inactive product.",
      );
    }

    const definition = buildTransformationDefinition(request, context);
    const audited = auditedDraftCommandSchema.parse({
      actorId,
      changeReason: request.changeReason,
      idempotencyKey: request.idempotencyKey,
      requestHash,
    });

    return this.store.createTransformationModelDraft({
      ...audited,
      definition,
      occurredAt: this.clock.now(),
    });
  }

  async updateTransformationModelDraft(
    productIdInput: number,
    draftModelIdInput: number,
    input: UpdateTransformationModelDraftRequest,
    actorInput: string,
  ): Promise<CreateTransformationModelDraftResult> {
    const productId = parsePositiveId(productIdInput, "productId");
    const draftModelId = parsePositiveId(draftModelIdInput, "draftModelId");
    const actorId = parseActor(actorInput);
    const request = parseInput(
      updateTransformationModelDraftRequestSchema,
      input,
      "Review the transformation model draft edit fields.",
    );
    const requestHash = calculateMasterDataDraftRequestHash(
      "transformation_model_draft_update",
      {
        actorId,
        changeReason: request.changeReason,
        definition: transformationUpdateIntent(productId, draftModelId, request),
      },
    );
    const replay = resolveReplay(
      await this.store.findMasterDataDraftReplay(request.idempotencyKey),
      "transformation_model_draft_update",
      requestHash,
    );
    if (replay) return replay;

    const context = await this.getSupplyTransformationsAdminView(productId);
    if (!context.product.isActive) {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_PRODUCT_INACTIVE",
        "A transformation draft cannot be edited for an inactive product.",
      );
    }
    const definition = buildTransformationDefinition({
      productId,
      buildToPromiseEnabled: request.buildToPromiseEnabled,
      paths: request.paths,
      recipeBindings: request.recipeBindings,
      changeReason: request.changeReason,
      idempotencyKey: request.idempotencyKey,
    }, context);
    const audited = auditedDraftCommandSchema.parse({
      actorId,
      changeReason: request.changeReason,
      idempotencyKey: request.idempotencyKey,
      requestHash,
    });
    return this.store.updateTransformationModelDraft({
      ...audited,
      productId,
      draftModelId,
      expectedVersion: request.expectedVersion,
      expectedDefinitionHash: request.expectedDefinitionHash,
      expectedHeadRevision: request.expectedHeadRevision,
      definition,
      occurredAt: this.clock.now(),
    });
  }

  async createLocationPromisePolicyDraft(
    input: CreateLocationPromisePolicyDraftInput,
    actorInput: string,
  ) {
    const actorId = parseActor(actorInput);
    const metadata = parseInput(draftMetadataSchema, {
      changeReason: input.changeReason,
      idempotencyKey: input.idempotencyKey,
    }, "Review the draft metadata.");
    const definition = parseInput(
      locationPromisePolicyDraftSchema,
      {
        warehouseLocationId: input.warehouseLocationId,
        eligibilityMode: input.eligibilityMode,
      },
      "Review the location promise-policy fields.",
    );
    const requestHash = calculateMasterDataDraftRequestHash("location_promise_policy", {
      actorId,
      changeReason: metadata.changeReason,
      definition,
    });
    const replay = resolveReplay(
      await this.store.findMasterDataDraftReplay(metadata.idempotencyKey),
      "location_promise_policy",
      requestHash,
    );
    if (replay) return replay;
    const audited = auditedDraftCommandSchema.parse({
      actorId,
      ...metadata,
      requestHash,
    });
    calculateLocationPromisePolicyDefinitionHash(definition);
    return this.store.createLocationPromisePolicyDraft({
      ...audited,
      ...definition,
      occurredAt: this.clock.now(),
    });
  }

  async createPromiseSafetyPolicyDraft(
    input: CreatePromiseSafetyPolicyDraftInput,
    actorInput: string,
  ) {
    const actorId = parseActor(actorInput);
    const metadata = parseInput(draftMetadataSchema, {
      changeReason: input.changeReason,
      idempotencyKey: input.idempotencyKey,
    }, "Review the draft metadata.");
    const definition = parseInput(
      promiseSafetyPolicyDraftSchema,
      {
        scope: input.scope,
        value: input.value,
      },
      "Review the promise-safety policy fields.",
    );
    const requestHash = calculateMasterDataDraftRequestHash("promise_safety_policy", {
      actorId,
      changeReason: metadata.changeReason,
      definition,
    });
    const replay = resolveReplay(
      await this.store.findMasterDataDraftReplay(metadata.idempotencyKey),
      "promise_safety_policy",
      requestHash,
    );
    if (replay) return replay;
    const audited = auditedDraftCommandSchema.parse({
      actorId,
      ...metadata,
      requestHash,
    });
    calculatePromiseSafetyPolicyDefinitionHash(definition);
    return this.store.createPromiseSafetyPolicyDraft({
      ...audited,
      ...definition,
      occurredAt: this.clock.now(),
    });
  }
}

function transformationCreateIntent(request: CreateTransformationModelDraftRequest) {
  return {
    productId: request.productId,
    buildToPromiseEnabled: request.buildToPromiseEnabled,
    paths: request.paths,
    recipeBindings: request.recipeBindings,
  };
}

function transformationUpdateIntent(
  productId: number,
  draftModelId: number,
  request: UpdateTransformationModelDraftRequest,
) {
  return {
    productId,
    draftModelId,
    expectedVersion: request.expectedVersion,
    expectedDefinitionHash: request.expectedDefinitionHash,
    expectedHeadRevision: request.expectedHeadRevision,
    buildToPromiseEnabled: request.buildToPromiseEnabled,
    paths: request.paths,
    recipeBindings: request.recipeBindings,
  };
}

type ReplayResultByCommand = {
  [Replay in InventoryAvailabilityMasterDataReplay as Replay["commandType"]]: Replay["result"];
};

function resolveReplay<T extends keyof ReplayResultByCommand>(
  replay: InventoryAvailabilityMasterDataReplay | null,
  expectedCommandType: T,
  expectedRequestHash: string,
): ReplayResultByCommand[T] | null {
  if (!replay) return null;
  if (replay.commandType !== expectedCommandType) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used for a different command type.",
    );
  }
  if (replay.requestHash !== expectedRequestHash) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used for a different request.",
    );
  }
  return {
    ...replay.result,
    alreadyApplied: true,
  } as ReplayResultByCommand[T];
}

function buildTransformationDefinition(
  request: CreateTransformationModelDraftRequest,
  context: SupplyTransformationsAdminView,
): TransformationModelDefinition {
  const variants = new Map(context.variants.map((variant) => [variant.id, variant]));
  const recipes = new Map(context.recipes.map((recipe) => [recipe.id, recipe]));

  const recipeBindings = request.recipeBindings.map((binding, index) => {
    const recipe = recipes.get(binding.recipeId);
    if (!recipe) {
      throw invalidReference(
        `recipeBindings.${index}.recipeId`,
        `Active recipe ${binding.recipeId} is not available for this product.`,
      );
    }
    if (binding.relationshipRole === "component_build" && recipe.recipeType !== "assembly") {
      throw invalidReference(
        `recipeBindings.${index}.relationshipRole`,
        `Recipe ${recipe.code} is not an assembly recipe.`,
      );
    }
    if (
      binding.relationshipRole === "directional_conversion"
      && recipe.recipeType !== "conversion"
    ) {
      throw invalidReference(
        `recipeBindings.${index}.relationshipRole`,
        `Recipe ${recipe.code} is not a conversion recipe.`,
      );
    }
    const snapshot = {
      bindingKey: binding.bindingKey,
      recipeId: recipe.id,
      relationshipRole: binding.relationshipRole,
      warehouseId: binding.warehouseId,
      recipeCodeSnapshot: recipe.code,
      recipeVersionSnapshot: recipe.version,
      recipeDefinitionHash: "",
      outputProductIdSnapshot: recipe.outputProductId,
      outputVariantIdSnapshot: recipe.outputVariantId,
      outputUnitsPerVariantSnapshot: recipe.outputUnitsPerVariant,
      outputQtySnapshot: recipe.outputQty,
      components: recipe.components.map((component) => ({
        componentVariantId: component.componentVariantId,
        componentProductId: component.componentProductId,
        componentUnitsPerVariant: component.componentUnitsPerVariant,
        componentQty: component.componentQty,
      })),
    };
    return {
      ...snapshot,
      recipeDefinitionHash: calculateRecipeDefinitionHash(snapshot),
    };
  });

  const paths = request.paths.map((path, index) => {
    const source = requireProductVariant(
      variants,
      path.sourceVariantId,
      context.product.id,
      `paths.${index}.sourceVariantId`,
    );
    const destination = requireProductVariant(
      variants,
      path.destinationVariantId,
      context.product.id,
      `paths.${index}.destinationVariantId`,
    );
    return {
      ...path,
      sourceProductId: source.productId,
      destinationProductId: destination.productId,
      sourceUnitsPerVariant: source.unitsPerVariant,
      destinationUnitsPerVariant: destination.unitsPerVariant,
    };
  });

  return parseInput(
    transformationModelDefinitionSchema,
    {
      productId: context.product.id,
      buildToPromiseEnabled: request.buildToPromiseEnabled,
      paths,
      recipeBindings,
    },
    "The transformation graph is invalid.",
  );
}

function requireProductVariant(
  variants: ReadonlyMap<number, SupplyTransformationsAdminView["variants"][number]>,
  variantId: number,
  productId: number,
  field: string,
) {
  const variant = variants.get(variantId);
  if (!variant || variant.productId !== productId || !variant.isActive) {
    throw invalidReference(
      field,
      `Active variant ${variantId} does not belong to product ${productId}.`,
    );
  }
  return variant;
}

function invalidReference(field: string, message: string) {
  return new InventoryAvailabilityMasterDataError(
    400,
    "INVENTORY_AVAILABILITY_REFERENCE_INVALID",
    "A transformation reference is invalid.",
    [`${field}: ${message}`],
  );
}

function parseActor(input: string): string {
  const parsed = actorSchema.safeParse(input);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return parsed.data;
}

function parsePositiveId(input: number, field: string): number {
  const parsed = z.number().int().positive().max(2_147_483_647).safeParse(input);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_ID",
      `${field} must be a positive integer.`,
    );
  }
  return parsed.data;
}

function parseInput<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  message: string,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_INPUT",
      message,
      parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "request"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export function bindingKeyForRecipe(recipe: Pick<TransformationAdminRecipe, "id">, warehouseId: number | null) {
  return warehouseId === null
    ? `recipe:${recipe.id}:network`
    : `recipe:${recipe.id}:warehouse:${warehouseId}`;
}
