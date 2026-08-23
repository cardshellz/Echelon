import {
  BuildDomainError,
  requireBuildRecipeType,
  requirePositiveInteger,
} from "../domain/build.domain";
import {
  createBuildRepository,
  type BuildCancellationResult,
  type BuildOrderCompletedContext,
  type BuildExecutionResult,
  type BuildRepository,
  type BuildReversalResult,
  type CancelBuildOrderInput,
  type CreateBuildOrderInput,
  type CreateBuildRecipeInput,
  type ExecuteBuildRunInput,
  type ReverseBuildRunInput,
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
export type BuildInventoryChangeTrigger =
  | "build_released"
  | "build_completed"
  | "build_cancelled"
  | "build_reversed";

type InventoryChangedCallback = (variantId: number, trigger: BuildInventoryChangeTrigger) => void;

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

function requiredIdempotencyKey(value: unknown): string {
  const key = requiredText(value, "idempotencyKey", 100);
  if (key.length < 8) {
    throw new BuildDomainError(
      "INVALID_BUILD_INPUT",
      "idempotencyKey must contain at least 8 characters",
      { field: "idempotencyKey" },
    );
  }
  return key;
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

  async createOrder(input: CreateBuildOrderInput, txOverride?: BuildDb): Promise<any> {
    const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
    const sourceLocations = requiredArray<CreateBuildOrderInput["sourceLocations"][number]>(
      input.sourceLocations,
      "sourceLocations",
    );
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
    }, txOverride);
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


  private async notifyInventoryChanged(
    buildOrderId: number,
    trigger: BuildInventoryChangeTrigger,
  ): Promise<void> {
    if (!this.inventoryChangedCallback) return;
    const affectedVariantIds = await this.changes.listAffectedVariantIds(buildOrderId);
    for (const variantId of affectedVariantIds) {
      try {
        this.inventoryChangedCallback(variantId, trigger);
      } catch (error: any) {
        console.warn(JSON.stringify({
          event: "build_inventory_notification_failed",
          buildOrderId,
          productVariantId: variantId,
          trigger,
          error: error?.message ?? String(error),
        }));
      }
    }
  }

  async releaseOrder(buildOrderId: number, actorId?: string, txOverride?: BuildDb): Promise<any> {
    const id = requirePositiveInteger(buildOrderId, "buildOrderId");
    const result = await this.repository.releaseOrder(id, actorId, txOverride);
    await this.notifyInventoryChanged(id, "build_released");
    console.info(JSON.stringify({
      event: "build_order_released",
      buildOrderId: id,
      actorId: actorId ?? null,
      status: result.status,
    }));
    return result;
  }

  async executeOrder(input: ExecuteBuildRunInput): Promise<BuildExecutionResult> {
    const command: ExecuteBuildRunInput = {
      buildOrderId: requirePositiveInteger(input.buildOrderId, "buildOrderId"),
      buildsCompleted: requirePositiveInteger(input.buildsCompleted, "buildsCompleted"),
      idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
      actorId: input.actorId,
    };
    const result = await this.repository.executeOrder(command);
    if (!result.alreadyPosted) {
      await this.notifyInventoryChanged(command.buildOrderId, "build_completed");
    }
    console.info(JSON.stringify({
      event: result.alreadyPosted ? "build_run_reused" : "build_run_posted",
      buildOrderId: result.buildOrderId,
      buildRunId: result.buildRunId,
      runNumber: result.runNumber,
      buildsCompleted: result.buildsCompleted,
      completedBuilds: result.completedBuilds,
      plannedBuilds: result.plannedBuilds,
      status: result.status,
      actorId: command.actorId ?? null,
    }));
    return result;
  }

  async linkDependency(input: {
    dependentBuildOrderId: number;
    prerequisiteBuildOrderId: number;
    componentVariantId: number;
    requiredQty: number;
  }, tx: BuildDb): Promise<void> {
    return this.repository.linkDependency({
      dependentBuildOrderId: requirePositiveInteger(input.dependentBuildOrderId, "dependentBuildOrderId"),
      prerequisiteBuildOrderId: requirePositiveInteger(input.prerequisiteBuildOrderId, "prerequisiteBuildOrderId"),
      componentVariantId: requirePositiveInteger(input.componentVariantId, "componentVariantId"),
      requiredQty: requirePositiveInteger(input.requiredQty, "requiredQty"),
    }, tx);
  }

  async cancelOrder(input: CancelBuildOrderInput, txOverride?: BuildDb): Promise<BuildCancellationResult> {
    const command: CancelBuildOrderInput = {
      buildOrderId: requirePositiveInteger(input.buildOrderId, "buildOrderId"),
      reason: requiredText(input.reason, "reason", 2000),
      actorId: input.actorId,
    };
    const result = await this.repository.cancelOrder(command, txOverride);
    if (!result.alreadyCancelled && result.releasedReservationQty > 0) {
      await this.notifyInventoryChanged(command.buildOrderId, "build_cancelled");
    }
    console.info(JSON.stringify({
      event: result.alreadyCancelled ? "build_cancellation_reused" : "build_order_cancelled",
      buildOrderId: result.buildOrderId,
      releasedReservationQty: result.releasedReservationQty,
      actorId: command.actorId ?? null,
    }));
    return result;
  }

  async reverseRun(input: ReverseBuildRunInput): Promise<BuildReversalResult> {
    const command: ReverseBuildRunInput = {
      buildOrderId: requirePositiveInteger(input.buildOrderId, "buildOrderId"),
      buildRunId: requirePositiveInteger(input.buildRunId, "buildRunId"),
      idempotencyKey: requiredIdempotencyKey(input.idempotencyKey),
      reason: requiredText(input.reason, "reason", 2000),
      actorId: input.actorId,
    };
    const result = await this.repository.reverseRun(command);
    if (!result.alreadyReversed) {
      await this.notifyInventoryChanged(command.buildOrderId, "build_reversed");
    }
    console.info(JSON.stringify({
      event: result.alreadyReversed ? "build_reversal_reused" : "build_run_reversed",
      buildOrderId: result.buildOrderId,
      buildRunId: result.buildRunId,
      reversalId: result.reversalId,
      restoredComponentQty: result.restoredComponentQty,
      removedOutputQty: result.removedOutputQty,
      actorId: command.actorId ?? null,
    }));
    return result;
  }
}

export function createBuildUseCases(
  db: BuildDb,
  options: { onBuildOrderCompleted?: (tx: BuildDb, context: BuildOrderCompletedContext) => Promise<void> } = {},
): BuildUseCases {
  return new BuildUseCases(
    createBuildRepository(db, options),
    createBuildChangeRepository(db),
    createBuildQueryRepository(db),
  );
}
