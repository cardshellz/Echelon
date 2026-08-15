import {
  BuildDomainError,
  requireBuildRecipeType,
  requirePositiveInteger,
} from "../domain/build.domain";
import {
  createBuildRepository,
  type BuildExecutionResult,
  type BuildRepository,
  type CreateBuildOrderInput,
  type CreateBuildRecipeInput,
} from "../infrastructure/build.repository";
import {
  createBuildChangeRepository,
  type BuildChangeRepository,
} from "../infrastructure/build-change.repository";
import {
  createBuildQueryRepository,
  type BuildQueryRepository,
} from "../infrastructure/build-query.repository";

type BuildDb = ConstructorParameters<typeof BuildRepository>[0];
type InventoryChangedCallback = (variantId: number, trigger: "build_completed") => void;

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new BuildDomainError(
      "INVALID_BUILD_INPUT",
      `${field} must contain between 1 and ${maxLength} characters`,
      { field },
    );
  }
  return value.trim();
}

function requiredArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) {
    throw new BuildDomainError(
      "INVALID_BUILD_INPUT",
      `${field} must be an array`,
      { field },
    );
  }
  return value as T[];
}

export class BuildUseCases {
  private inventoryChangedCallback: InventoryChangedCallback | null = null;

  constructor(
    private readonly repository: BuildRepository,
    private readonly changes: BuildChangeRepository,
    private readonly queries: BuildQueryRepository,
  ) {}

  onInventoryChange(callback: InventoryChangedCallback): void {
    this.inventoryChangedCallback = callback;
  }

  async createRecipe(input: CreateBuildRecipeInput): Promise<any> {
    const code = requiredText(input.code, "code", 50).toUpperCase();
    const components = requiredArray<CreateBuildRecipeInput["components"][number]>(input.components, "components");
    const status = input.status ?? "draft";
    if (status !== "draft" && status !== "active") {
      throw new BuildDomainError("INVALID_BUILD_INPUT", "status must be draft or active", { field: "status" });
    }
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) {
      throw new BuildDomainError(
        "INVALID_BUILD_RECIPE_CODE",
        "code may contain only letters, numbers, underscores, and hyphens",
        { code },
      );
    }
    return this.repository.createRecipe({
      ...input,
      code,
      name: requiredText(input.name, "name", 150),
      status,
      recipeType: requireBuildRecipeType(input.recipeType),
      outputVariantId: requirePositiveInteger(input.outputVariantId, "outputVariantId"),
      outputQty: requirePositiveInteger(input.outputQty, "outputQty"),
      notes: input.notes?.trim() || undefined,
      components: components.map((component, index) => ({
        componentVariantId: requirePositiveInteger(
          component.componentVariantId,
          `components[${index}].componentVariantId`,
        ),
        qtyPerBuild: requirePositiveInteger(component.qtyPerBuild, `components[${index}].qtyPerBuild`),
      })),
    });
  }

  async createOrder(input: CreateBuildOrderInput): Promise<any> {
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 100);
    const sourceLocations = requiredArray<CreateBuildOrderInput["sourceLocations"][number]>(
      input.sourceLocations,
      "sourceLocations",
    );
    if (idempotencyKey.length < 8) {
      throw new BuildDomainError(
        "INVALID_BUILD_INPUT",
        "idempotencyKey must contain at least 8 characters",
        { field: "idempotencyKey" },
      );
    }
    return this.repository.createOrder({
      ...input,
      recipeId: requirePositiveInteger(input.recipeId, "recipeId"),
      plannedBuilds: requirePositiveInteger(input.plannedBuilds, "plannedBuilds"),
      warehouseId: requirePositiveInteger(input.warehouseId, "warehouseId"),
      outputLocationId: requirePositiveInteger(input.outputLocationId, "outputLocationId"),
      idempotencyKey,
      sourceLocations: sourceLocations.map((location, index) => ({
        componentVariantId: requirePositiveInteger(
          location.componentVariantId,
          `sourceLocations[${index}].componentVariantId`,
        ),
        sourceLocationId: requirePositiveInteger(
          location.sourceLocationId,
          `sourceLocations[${index}].sourceLocationId`,
        ),
      })),
    });
  }
  async listProductRelationships(
    productId: number,
  ): Promise<Awaited<ReturnType<BuildQueryRepository["listProductRelationships"]>>> {
    return this.queries.listProductRelationships(requirePositiveInteger(productId, "productId"));
  }
  async listRecipes(): Promise<Awaited<ReturnType<BuildQueryRepository["listRecipes"]>>> {
    return this.queries.listRecipes();
  }

  async listOrders(warehouseId?: number): Promise<Awaited<ReturnType<BuildQueryRepository["listOrders"]>>> {
    const normalizedWarehouseId = warehouseId == null
      ? undefined
      : requirePositiveInteger(warehouseId, "warehouseId");
    return this.queries.listOrders(normalizedWarehouseId);
  }

  async getOrder(buildOrderId: number): Promise<Awaited<ReturnType<BuildQueryRepository["getOrder"]>>> {
    return this.queries.getOrder(requirePositiveInteger(buildOrderId, "buildOrderId"));
  }


  async releaseOrder(buildOrderId: number, actorId?: string): Promise<any> {
    return this.repository.releaseOrder(requirePositiveInteger(buildOrderId, "buildOrderId"), actorId);
  }

  async executeOrder(buildOrderId: number, actorId?: string): Promise<BuildExecutionResult> {
    const id = requirePositiveInteger(buildOrderId, "buildOrderId");
    const result = await this.repository.executeOrder(id, actorId);
    if (!result.alreadyCompleted && this.inventoryChangedCallback) {
      const affectedVariantIds = await this.changes.listAffectedVariantIds(id);
      for (const variantId of affectedVariantIds) {
        try {
          this.inventoryChangedCallback(variantId, "build_completed");
        } catch (error: any) {
          console.warn(JSON.stringify({
            event: "build_inventory_notification_failed",
            buildOrderId: id,
            productVariantId: variantId,
            error: error?.message ?? String(error),
          }));
        }
      }
    }
    return result;
  }
}

export function createBuildUseCases(db: BuildDb): BuildUseCases {
  return new BuildUseCases(
    createBuildRepository(db),
    createBuildChangeRepository(db),
    createBuildQueryRepository(db),
  );
}
