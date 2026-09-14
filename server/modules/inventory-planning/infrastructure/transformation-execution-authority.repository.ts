import { sql } from "drizzle-orm";
import { calculateRecipeDefinitionHash } from "../domain/inventory-availability-master-data.contracts";
import type {
  TransformationAuthorityTransaction,
  TransformationExecutionAuthorityPort,
} from "../../inventory/application/transformation-execution-authority.port";
import {
  assertBuildAuthorizationSnapshot,
  authorizeBuildBindingDefinition,
  authorizePackageConversionDefinition,
  parseTransformationRuntimeAuthority,
  TransformationExecutionAuthorityError,
  type BuildAuthorization,
  type BuildAuthorizationRequest,
  type BuildBindingDefinitionRecord,
  type BuildComponentSnapshot,
  type PackageConversionAuthorization,
  type PackageConversionAuthorizationRequest,
  type PackageConversionDefinitionRecord,
  type RuntimeAuthorityRecord,
  type TransformationRuntimeEvidence,
} from "../../inventory/domain/transformation-execution-authority";

type QueryOwner = TransformationAuthorityTransaction;

function rows(result: { rows?: any[] }): any[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TransformationExecutionAuthorityError(
      "TRANSFORMATION_AUTHORITY_INPUT_INVALID", `${field} must be a positive safe integer.`, { field, value });
  }
  return id;
}

function lockClause(lock: boolean) {
  return lock ? sql` FOR SHARE` : sql``;
}

function buildRequestFromRecipe(recipe: any, components: any[], warehouseId: number): BuildAuthorizationRequest {
  return {
    recipeId: Number(recipe.id),
    recipeCode: String(recipe.code),
    recipeVersion: Number(recipe.version),
    recipeType: recipe.recipe_type,
    warehouseId,
    outputProductId: Number(recipe.output_product_id),
    outputVariantId: Number(recipe.output_variant_id),
    outputUnitsPerVariant: Number(recipe.output_units_per_variant),
    outputQty: Number(recipe.output_qty),
    components: components.map((component) => ({
      componentVariantId: Number(component.component_variant_id),
      componentProductId: Number(component.component_product_id),
      componentUnitsPerVariant: Number(component.component_units_per_variant),
      componentQty: Number(component.qty),
    })),
  };
}

function buildRequestFromOrder(order: any, components: any[]): BuildAuthorizationRequest {
  return {
    recipeId: Number(order.recipe_id),
    recipeCode: String(order.recipe_code),
    recipeVersion: Number(order.recipe_version),
    recipeType: order.recipe_type,
    warehouseId: Number(order.warehouse_id),
    outputProductId: Number(order.output_product_id),
    outputVariantId: Number(order.output_variant_id),
    outputUnitsPerVariant: Number(order.output_units_per_variant),
    outputQty: Number(order.output_qty_per_build),
    components: components.map((component) => ({
      componentVariantId: Number(component.component_variant_id),
      componentProductId: Number(component.component_product_id),
      componentUnitsPerVariant: Number(component.component_units_per_variant),
      componentQty: Number(component.qty_per_build),
    })),
  };
}

/**
 * Pins authority -> active model head -> sealed model -> exact path/binding ->
 * catalog snapshots. Operational owners then take task/cost/inventory locks.
 */
export class PostgresTransformationExecutionAuthorityRepository
implements TransformationExecutionAuthorityPort {
  constructor(private readonly database: QueryOwner) {}

  private async loadRuntime(
    owner: QueryOwner,
    lock: boolean,
    expected?: TransformationRuntimeEvidence,
  ): Promise<TransformationRuntimeEvidence> {
    const result = await owner.execute(sql`
      SELECT authority, revision::text AS revision,
             activation_run_id::text AS "activationRunId"
      FROM inventory.availability_runtime_authority
      WHERE singleton_key = true${lockClause(lock)}
    `);
    const records: RuntimeAuthorityRecord[] = rows(result).map((row) => ({
      authority: row.authority,
      revision: row.revision,
      activationRunId: row.activationRunId ?? row.activation_run_id ?? null,
    }));
    return parseTransformationRuntimeAuthority(records, expected);
  }

  async readRuntime(expected?: TransformationRuntimeEvidence): Promise<TransformationRuntimeEvidence> {
    return this.loadRuntime(this.database, false, expected);
  }

  async pinRuntime(
    tx: TransformationAuthorityTransaction,
    expected: TransformationRuntimeEvidence,
  ): Promise<TransformationRuntimeEvidence> {
    return this.loadRuntime(tx, true, expected);
  }

  private async loadActiveModel(owner: QueryOwner, productId: number, lock: boolean): Promise<any> {
    const headResult = await owner.execute(sql`
      SELECT active_model_id, revision::text AS head_revision
      FROM inventory.transformation_model_heads
      WHERE product_id = ${productId}${lockClause(lock)}
    `);
    const headRows = rows(headResult);
    if (headRows.length !== 1 || !headRows[0]?.active_model_id) {
      throw new TransformationExecutionAuthorityError(
        "ACTIVE_TRANSFORMATION_MODEL_MISSING",
        "The product has no exact active transformation model.",
        { productId, rowCount: headRows.length },
      );
    }
    const head = headRows[0];
    const modelResult = await owner.execute(sql`
      SELECT id, product_id, version, lifecycle_status, validation_state,
             validation_errors, definition_hash
      FROM inventory.transformation_model_versions
      WHERE id = ${Number(head.active_model_id)} AND product_id = ${productId}${lockClause(lock)}
    `);
    const modelRows = rows(modelResult);
    if (modelRows.length !== 1) {
      throw new TransformationExecutionAuthorityError(
        "ACTIVE_TRANSFORMATION_MODEL_INVALID",
        "The active transformation model pointer does not resolve exactly once.",
        { productId, modelId: head.active_model_id, rowCount: modelRows.length },
      );
    }
    return { head, model: modelRows[0] };
  }

  private async packageRecords(
    owner: QueryOwner,
    request: PackageConversionAuthorizationRequest,
    lock: boolean,
  ): Promise<PackageConversionDefinitionRecord[]> {
    const { head, model } = await this.loadActiveModel(owner, request.productId, lock);
    const pathResult = await owner.execute(sql`
      SELECT id, model_id, source_variant_id, destination_variant_id, input_qty,
             output_qty, source_units_per_variant, destination_units_per_variant,
             operation_type, authority_state, validation_state, validation_errors
      FROM inventory.transformation_model_paths
      WHERE model_id = ${Number(model.id)}
        AND source_variant_id = ${request.source.variantId}
        AND destination_variant_id = ${request.destination.variantId}
        AND operation_type = ${request.operation}
      ORDER BY id${lockClause(lock)}
    `);
    const paths = rows(pathResult);
    if (paths.length === 0) return [];
    const variantResult = await owner.execute(sql`
      SELECT id, product_id, units_per_variant
      FROM catalog.product_variants
      WHERE id IN (${request.source.variantId}, ${request.destination.variantId})
      ORDER BY id${lockClause(lock)}
    `);
    const variants = new Map(rows(variantResult).map((variant) => [Number(variant.id), variant]));
    return paths.map((path) => ({
      headRevision: head.head_revision,
      modelId: model.id,
      modelProductId: model.product_id,
      modelVersion: model.version,
      modelLifecycleStatus: model.lifecycle_status,
      modelValidationState: model.validation_state,
      modelValidationErrors: model.validation_errors,
      modelDefinitionHash: model.definition_hash,
      pathId: path.id,
      pathModelId: path.model_id,
      sourceVariantId: path.source_variant_id,
      destinationVariantId: path.destination_variant_id,
      inputQty: path.input_qty,
      outputQty: path.output_qty,
      sourceUnitsPerVariant: path.source_units_per_variant,
      destinationUnitsPerVariant: path.destination_units_per_variant,
      operationType: path.operation_type,
      authorityState: path.authority_state,
      pathValidationState: path.validation_state,
      pathValidationErrors: path.validation_errors,
      sourceProductId: variants.get(request.source.variantId)?.product_id,
      currentSourceUnitsPerVariant: variants.get(request.source.variantId)?.units_per_variant,
      destinationProductId: variants.get(request.destination.variantId)?.product_id,
      currentDestinationUnitsPerVariant: variants.get(request.destination.variantId)?.units_per_variant,
    }));
  }

  async authorizePackageConversion(
    request: PackageConversionAuthorizationRequest,
    expectedRuntime?: TransformationRuntimeEvidence,
  ): Promise<PackageConversionAuthorization> {
    const runtime = await this.loadRuntime(this.database, false, expectedRuntime);
    const records = runtime.authority === "canonical"
      ? await this.packageRecords(this.database, request, false)
      : [];
    return authorizePackageConversionDefinition({ request, runtime, records });
  }

  async pinPackageConversion(
    tx: TransformationAuthorityTransaction,
    request: PackageConversionAuthorizationRequest,
    expected: PackageConversionAuthorization,
  ): Promise<PackageConversionAuthorization> {
    const runtime = await this.loadRuntime(tx, true, expected.runtime);
    const records = runtime.authority === "canonical" ? await this.packageRecords(tx, request, true) : [];
    return authorizePackageConversionDefinition({ request, runtime, records, expected });
  }

  private async loadBuildBindingRecords(
    tx: QueryOwner,
    request: BuildAuthorizationRequest,
    retained?: Readonly<{ model: any; headRevision: string | null; bindingId: number }>,
  ): Promise<BuildBindingDefinitionRecord[]> {
    const { head, model } = retained
      ? { head: { head_revision: retained.headRevision }, model: retained.model }
      : await this.loadActiveModel(tx, request.outputProductId, true);
    const bindingPredicate = retained
      ? sql`AND id = ${retained.bindingId}`
      : sql`AND recipe_id = ${request.recipeId}
            AND (warehouse_id IS NULL OR warehouse_id = ${request.warehouseId})`;
    const bindingResult = await tx.execute(sql`
      SELECT id, model_id, recipe_id, relationship_role, warehouse_id,
             recipe_code_snapshot, recipe_version_snapshot, recipe_definition_hash,
             output_product_id_snapshot, output_variant_id_snapshot,
             output_units_per_variant_snapshot, output_qty_snapshot,
             validation_state, validation_errors
      FROM inventory.transformation_recipe_bindings
      WHERE model_id = ${Number(model.id)}
        ${bindingPredicate}
      ORDER BY id FOR SHARE
    `);
    const bindings = rows(bindingResult);
    const records: BuildBindingDefinitionRecord[] = [];
    for (const binding of bindings) {
      const componentResult = await tx.execute(sql`
        SELECT component_variant_id, component_product_id,
               component_units_per_variant, component_qty
        FROM inventory.transformation_recipe_component_snapshots
        WHERE transformation_recipe_binding_id = ${Number(binding.id)}
          AND model_id = ${Number(model.id)}
        ORDER BY component_variant_id FOR SHARE
      `);
      const components: BuildComponentSnapshot[] = rows(componentResult).map((component) => ({
        componentVariantId: Number(component.component_variant_id),
        componentProductId: Number(component.component_product_id),
        componentUnitsPerVariant: Number(component.component_units_per_variant),
        componentQty: Number(component.component_qty),
      }));
      const variantIds = [
        Number(binding.output_variant_id_snapshot),
        ...components.map((component) => component.componentVariantId),
      ];
      const variantResult = await tx.execute(sql`
        SELECT id, product_id, units_per_variant
        FROM catalog.product_variants
        WHERE id IN (${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)})
        ORDER BY id FOR SHARE
      `);
      const variants = new Map(rows(variantResult).map((variant) => [Number(variant.id), variant]));
      const outputVariant = variants.get(Number(binding.output_variant_id_snapshot));
      const catalogSnapshotsValid = variants.size === new Set(variantIds).size
        && Number(outputVariant?.product_id) === Number(binding.output_product_id_snapshot)
        && Number(outputVariant?.units_per_variant) === Number(binding.output_units_per_variant_snapshot)
        && components.every((component) => {
          const variant = variants.get(component.componentVariantId);
          return Number(variant?.product_id) === component.componentProductId
            && Number(variant?.units_per_variant) === component.componentUnitsPerVariant;
        });
      const hashInput = {
        bindingKey: "runtime-validation-only",
        recipeId: Number(binding.recipe_id),
        relationshipRole: binding.relationship_role,
        warehouseId: binding.warehouse_id == null ? null : Number(binding.warehouse_id),
        recipeCodeSnapshot: String(binding.recipe_code_snapshot),
        recipeVersionSnapshot: Number(binding.recipe_version_snapshot),
        recipeDefinitionHash: String(binding.recipe_definition_hash),
        outputProductIdSnapshot: Number(binding.output_product_id_snapshot),
        outputVariantIdSnapshot: Number(binding.output_variant_id_snapshot),
        outputUnitsPerVariantSnapshot: Number(binding.output_units_per_variant_snapshot),
        outputQtySnapshot: Number(binding.output_qty_snapshot),
        components,
      };
      const pathResult = request.recipeType === "conversion"
        ? await tx.execute(sql`
            SELECT transformation_recipe_binding_id, model_id, source_variant_id,
                   destination_variant_id, input_qty, output_qty,
                   source_units_per_variant, destination_units_per_variant,
                   operation_type, authority_state, validation_state, validation_errors
            FROM inventory.transformation_model_paths
            WHERE model_id = ${Number(model.id)}
              AND transformation_recipe_binding_id = ${Number(binding.id)}
            ORDER BY id FOR SHARE
          `)
        : { rows: [] };
      const linkedPaths = rows(pathResult);
      records.push({
        headRevision: head.head_revision,
        modelId: model.id,
        modelProductId: model.product_id,
        modelVersion: model.version,
        modelLifecycleStatus: model.lifecycle_status,
        modelValidationState: model.validation_state,
        modelValidationErrors: model.validation_errors,
        modelDefinitionHash: model.definition_hash,
        bindingId: binding.id,
        bindingModelId: binding.model_id,
        recipeId: binding.recipe_id,
        relationshipRole: binding.relationship_role,
        warehouseId: binding.warehouse_id,
        recipeCodeSnapshot: binding.recipe_code_snapshot,
        recipeVersionSnapshot: binding.recipe_version_snapshot,
        recipeDefinitionHash: binding.recipe_definition_hash,
        outputProductIdSnapshot: binding.output_product_id_snapshot,
        outputVariantIdSnapshot: binding.output_variant_id_snapshot,
        outputUnitsPerVariantSnapshot: binding.output_units_per_variant_snapshot,
        outputQtySnapshot: binding.output_qty_snapshot,
        bindingValidationState: binding.validation_state,
        bindingValidationErrors: binding.validation_errors,
        definitionHashValid: calculateRecipeDefinitionHash(hashInput as any) === binding.recipe_definition_hash,
        catalogSnapshotsValid,
        components,
        linkedPath: linkedPaths.length === 1 ? {
          bindingId: linkedPaths[0].transformation_recipe_binding_id,
          modelId: linkedPaths[0].model_id,
          sourceVariantId: linkedPaths[0].source_variant_id,
          destinationVariantId: linkedPaths[0].destination_variant_id,
          inputQty: linkedPaths[0].input_qty,
          outputQty: linkedPaths[0].output_qty,
          sourceUnitsPerVariant: linkedPaths[0].source_units_per_variant,
          destinationUnitsPerVariant: linkedPaths[0].destination_units_per_variant,
          operationType: linkedPaths[0].operation_type,
          authorityState: linkedPaths[0].authority_state,
          validationState: linkedPaths[0].validation_state,
          validationErrors: linkedPaths[0].validation_errors,
        } : null,
      });
    }
    return records;
  }

  async pinBuildRecipe(
    tx: TransformationAuthorityTransaction,
    recipeId: number,
    warehouseId: number,
  ): Promise<BuildAuthorization> {
    const normalizedRecipeId = positiveId(recipeId, "recipeId");
    const normalizedWarehouseId = positiveId(warehouseId, "warehouseId");
    const runtime = await this.loadRuntime(tx, true);
    if (runtime.authority === "legacy") {
      return authorizeBuildBindingDefinition({
        runtime,
        request: {
          recipeId: normalizedRecipeId, recipeCode: "legacy", recipeVersion: 1,
          recipeType: "assembly", warehouseId: normalizedWarehouseId, outputProductId: 1,
          outputVariantId: 1, outputUnitsPerVariant: 1, outputQty: 1,
          components: [{ componentVariantId: 2, componentProductId: 2, componentUnitsPerVariant: 1, componentQty: 1 }],
        },
        records: [],
      });
    }
    const recipeResult = await tx.execute(sql`
      SELECT id, code, version, status, recipe_type, output_product_id,
             output_variant_id, output_units_per_variant, output_qty
      FROM inventory.build_recipes WHERE id = ${normalizedRecipeId}
    `);
    const recipeRows = rows(recipeResult);
    if (recipeRows.length !== 1) {
      throw new TransformationExecutionAuthorityError(
        "BUILD_RECIPE_NOT_FOUND", "The requested build recipe was not found exactly once.",
        { recipeId: normalizedRecipeId, rowCount: recipeRows.length });
    }
    const componentResult = await tx.execute(sql`
      SELECT component_variant_id, component_product_id, component_units_per_variant, qty
      FROM inventory.build_recipe_components
      WHERE recipe_id = ${normalizedRecipeId}
      ORDER BY component_variant_id
    `);
    const request = buildRequestFromRecipe(recipeRows[0], rows(componentResult), normalizedWarehouseId);
    return authorizeBuildBindingDefinition({
      request, runtime, records: await this.loadBuildBindingRecords(tx, request),
    });
  }

  async pinBuildOrder(
    tx: TransformationAuthorityTransaction,
    buildOrderId: number,
  ): Promise<BuildAuthorization> {
    const normalizedOrderId = positiveId(buildOrderId, "buildOrderId");
    const runtime = await this.loadRuntime(tx, true);
    if (runtime.authority === "legacy") {
      return authorizeBuildBindingDefinition({
        runtime,
        request: {
          recipeId: normalizedOrderId, recipeCode: "legacy", recipeVersion: 1,
          recipeType: "assembly", warehouseId: 1, outputProductId: 1,
          outputVariantId: 1, outputUnitsPerVariant: 1, outputQty: 1,
          components: [{ componentVariantId: 2, componentProductId: 2, componentUnitsPerVariant: 1, componentQty: 1 }],
        },
        records: [],
      });
    }
    const orderResult = await tx.execute(sql`
      SELECT id, recipe_id, recipe_code, recipe_version, recipe_type,
             output_product_id, output_variant_id, output_units_per_variant,
             output_qty_per_build, warehouse_id
      FROM inventory.build_orders WHERE id = ${normalizedOrderId}
    `);
    const orderRows = rows(orderResult);
    if (orderRows.length !== 1) {
      throw new TransformationExecutionAuthorityError(
        "BUILD_ORDER_NOT_FOUND", "The requested build order was not found exactly once.",
        { buildOrderId: normalizedOrderId, rowCount: orderRows.length });
    }
    const componentResult = await tx.execute(sql`
      SELECT component_variant_id, component_product_id,
             component_units_per_variant, qty_per_build
      FROM inventory.build_order_components
      WHERE build_order_id = ${normalizedOrderId}
      ORDER BY component_variant_id
    `);
    const request = buildRequestFromOrder(orderRows[0], rows(componentResult));
    return authorizeBuildBindingDefinition({
      request, runtime, records: await this.loadBuildBindingRecords(tx, request),
    });
  }

  async validatePinnedBuildOrder(
    tx: TransformationAuthorityTransaction,
    buildOrderId: number,
  ): Promise<BuildAuthorization> {
    const normalizedOrderId = positiveId(buildOrderId, "buildOrderId");
    const currentRuntime = await this.loadRuntime(tx, true);
    const orderResult = await tx.execute(sql`
      SELECT id, recipe_id, recipe_code, recipe_version, recipe_type,
             output_product_id, output_variant_id, output_units_per_variant,
             output_qty_per_build, warehouse_id,
             transformation_authority,
             transformation_authority_revision::text,
             transformation_activation_run_id::text,
             transformation_model_head_revision::text,
             transformation_model_id,
             transformation_model_version,
             transformation_model_definition_hash,
             transformation_recipe_binding_id,
             transformation_recipe_definition_hash,
             transformation_authorized_at,
             transformation_authorized_by
      FROM inventory.build_orders
      WHERE id = ${normalizedOrderId}
    `);
    const orderRows = rows(orderResult);
    if (orderRows.length !== 1) {
      throw new TransformationExecutionAuthorityError(
        "BUILD_ORDER_NOT_FOUND", "The requested build order was not found exactly once.",
        { buildOrderId: normalizedOrderId, rowCount: orderRows.length });
    }
    const order = orderRows[0];
    const componentResult = await tx.execute(sql`
      SELECT component_variant_id, component_product_id,
             component_units_per_variant, qty_per_build
      FROM inventory.build_order_components
      WHERE build_order_id = ${normalizedOrderId}
      ORDER BY component_variant_id
    `);
    const request = buildRequestFromOrder(order, rows(componentResult));
    const frozenFields = [
      order.transformation_authority,
      order.transformation_authority_revision,
      order.transformation_activation_run_id,
      order.transformation_model_head_revision,
      order.transformation_model_id,
      order.transformation_model_version,
      order.transformation_model_definition_hash,
      order.transformation_recipe_binding_id,
      order.transformation_recipe_definition_hash,
      order.transformation_authorized_at,
      order.transformation_authorized_by,
    ];
    const hasFrozenEvidence = frozenFields.some((value) => value !== null && value !== undefined);

    if (currentRuntime.authority === "legacy") {
      if (hasFrozenEvidence) {
        throw new TransformationExecutionAuthorityError(
          "BUILD_AUTHORIZATION_STATE_INVALID",
          "A legacy build cannot carry canonical transformation authority evidence.",
          { buildOrderId: normalizedOrderId, transformationAuthority: order.transformation_authority },
        );
      }
      return authorizeBuildBindingDefinition({ request, runtime: currentRuntime, records: [] });
    }

    if (!hasFrozenEvidence) {
      throw new TransformationExecutionAuthorityError(
        "BUILD_CANONICAL_AUTHORIZATION_MISSING",
        "Canonical build execution requires immutable release-time transformation authority evidence.",
        { buildOrderId: normalizedOrderId },
      );
    }
    if (order.transformation_authority !== "canonical"
      || order.transformation_authority_revision == null
      || order.transformation_activation_run_id == null
      || order.transformation_model_id == null
      || order.transformation_model_version == null
      || order.transformation_model_definition_hash == null
      || order.transformation_recipe_binding_id == null
      || order.transformation_recipe_definition_hash == null
      || order.transformation_authorized_at == null
      || typeof order.transformation_authorized_by !== "string"
      || order.transformation_authorized_by.trim() === "") {
      throw new TransformationExecutionAuthorityError(
        "BUILD_AUTHORIZATION_STATE_INVALID",
        "The build order has incomplete or unsupported transformation authority evidence.",
        { buildOrderId: normalizedOrderId, transformationAuthority: order.transformation_authority },
      );
    }

    const frozenRuntime = parseTransformationRuntimeAuthority([{
      authority: order.transformation_authority,
      revision: order.transformation_authority_revision,
      activationRunId: order.transformation_activation_run_id,
    }], currentRuntime);
    const modelId = positiveId(order.transformation_model_id, "buildOrder.transformationModelId");
    const bindingId = positiveId(order.transformation_recipe_binding_id, "buildOrder.transformationRecipeBindingId");
    const modelResult = await tx.execute(sql`
      SELECT id, product_id, version, lifecycle_status, validation_state,
             validation_errors, definition_hash
      FROM inventory.transformation_model_versions
      WHERE id = ${modelId}
        AND product_id = ${request.outputProductId}
      FOR SHARE
    `);
    const modelRows = rows(modelResult);
    if (modelRows.length !== 1) {
      throw new TransformationExecutionAuthorityError(
        "RETAINED_TRANSFORMATION_MODEL_INVALID",
        "The build order's retained transformation model does not resolve exactly once.",
        { buildOrderId: normalizedOrderId, modelId, rowCount: modelRows.length },
      );
    }
    const authorization = authorizeBuildBindingDefinition({
      request,
      runtime: frozenRuntime,
      records: await this.loadBuildBindingRecords(tx, request, {
        model: modelRows[0],
        headRevision: order.transformation_model_head_revision ?? null,
        bindingId,
      }),
      retained: true,
    });
    const frozenEvidenceMatches = authorization.modelId === modelId
      && authorization.modelVersion === Number(order.transformation_model_version)
      && authorization.modelDefinitionHash === order.transformation_model_definition_hash
      && authorization.bindingId === bindingId
      && authorization.bindingDefinitionHash === order.transformation_recipe_definition_hash;
    if (!frozenEvidenceMatches) {
      throw new TransformationExecutionAuthorityError(
        "BUILD_AUTHORIZATION_SNAPSHOT_CHANGED",
        "The retained model or binding no longer matches the build order's immutable authorization evidence.",
        { buildOrderId: normalizedOrderId, modelId, bindingId },
      );
    }
    if (order.transformation_model_head_revision == null) {
      const handoffResult = await tx.execute(sql`
        SELECT build_order_id
        FROM inventory.availability_claim_build_handoffs
        WHERE build_order_id = ${normalizedOrderId}
      `);
      if (rows(handoffResult).length !== 1) {
        throw new TransformationExecutionAuthorityError(
          "BUILD_AUTHORIZATION_STATE_INVALID",
          "Only a claim-owned build may omit its release-time transformation model head revision.",
          { buildOrderId: normalizedOrderId },
        );
      }
    }
    return authorization;
  }

  assertBuildSnapshot(authorization: BuildAuthorization, request: BuildAuthorizationRequest): void {
    assertBuildAuthorizationSnapshot(authorization, request);
  }
}

export function createTransformationExecutionAuthorityRepository(
  database: QueryOwner,
): TransformationExecutionAuthorityPort {
  return new PostgresTransformationExecutionAuthorityRepository(database);
}
