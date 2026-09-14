export type InventoryTransformationRuntimeAuthority = "legacy" | "canonical";
export type PackageConversionOperation = "break_pack" | "assemble_pack";
export type BuildRecipeRelationshipRole = "component_build" | "directional_conversion";

export type TransformationRuntimeEvidence = Readonly<{
  authority: InventoryTransformationRuntimeAuthority;
  revision: string;
  activationRunId: string | null;
}>;

export type PackageConversionVariantSnapshot = Readonly<{
  variantId: number;
  productId: number;
  unitsPerVariant: number;
}>;

export type PackageConversionAuthorizationRequest = Readonly<{
  productId: number;
  operation: PackageConversionOperation;
  source: PackageConversionVariantSnapshot;
  destination: PackageConversionVariantSnapshot;
}>;

export type PackageConversionAuthorization = Readonly<{
  runtime: TransformationRuntimeEvidence;
  productId: number;
  operation: PackageConversionOperation;
  headRevision: string | null;
  modelId: number | null;
  modelVersion: number | null;
  modelDefinitionHash: string | null;
  pathId: number | null;
  inputQty: number | null;
  outputQty: number | null;
}>;

export type BuildComponentSnapshot = Readonly<{
  componentVariantId: number;
  componentProductId: number;
  componentUnitsPerVariant: number;
  componentQty: number;
}>;

export type BuildAuthorizationRequest = Readonly<{
  recipeId: number;
  recipeCode: string;
  recipeVersion: number;
  recipeType: "assembly" | "conversion";
  warehouseId: number;
  outputProductId: number;
  outputVariantId: number;
  outputUnitsPerVariant: number;
  outputQty: number;
  components: readonly BuildComponentSnapshot[];
}>;

export type BuildAuthorization = Readonly<{
  runtime: TransformationRuntimeEvidence;
  productId: number;
  headRevision: string | null;
  modelId: number | null;
  modelVersion: number | null;
  modelDefinitionHash: string | null;
  bindingId: number | null;
  bindingDefinitionHash: string | null;
  relationshipRole: BuildRecipeRelationshipRole | null;
  warehouseId: number | null;
  request: BuildAuthorizationRequest;
}>;

export class TransformationExecutionAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "TransformationExecutionAuthorityError";
  }
}

export interface RuntimeAuthorityRecord {
  authority: unknown;
  revision: unknown;
  activationRunId: unknown;
}

export interface PackageConversionDefinitionRecord {
  headRevision: unknown;
  modelId: unknown;
  modelProductId: unknown;
  modelVersion: unknown;
  modelLifecycleStatus: unknown;
  modelValidationState: unknown;
  modelValidationErrors: unknown;
  modelDefinitionHash: unknown;
  pathId: unknown;
  pathModelId: unknown;
  sourceVariantId: unknown;
  destinationVariantId: unknown;
  inputQty: unknown;
  outputQty: unknown;
  sourceUnitsPerVariant: unknown;
  destinationUnitsPerVariant: unknown;
  operationType: unknown;
  authorityState: unknown;
  pathValidationState: unknown;
  pathValidationErrors: unknown;
  sourceProductId: unknown;
  currentSourceUnitsPerVariant: unknown;
  destinationProductId: unknown;
  currentDestinationUnitsPerVariant: unknown;
}

export interface BuildBindingDefinitionRecord {
  headRevision: unknown;
  modelId: unknown;
  modelProductId: unknown;
  modelVersion: unknown;
  modelLifecycleStatus: unknown;
  modelValidationState: unknown;
  modelValidationErrors: unknown;
  modelDefinitionHash: unknown;
  bindingId: unknown;
  bindingModelId: unknown;
  recipeId: unknown;
  relationshipRole: unknown;
  warehouseId: unknown;
  recipeCodeSnapshot: unknown;
  recipeVersionSnapshot: unknown;
  recipeDefinitionHash: unknown;
  outputProductIdSnapshot: unknown;
  outputVariantIdSnapshot: unknown;
  outputUnitsPerVariantSnapshot: unknown;
  outputQtySnapshot: unknown;
  bindingValidationState: unknown;
  bindingValidationErrors: unknown;
  definitionHashValid: unknown;
  catalogSnapshotsValid: unknown;
  components: unknown;
  linkedPath: unknown;
}

function positiveInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TransformationExecutionAuthorityError(
      "TRANSFORMATION_AUTHORITY_RECORD_INVALID",
      `${field} must be a positive safe integer.`,
      { field, value },
    );
  }
  return normalized;
}

function positiveBigintText(value: unknown, field: string): string {
  const normalized = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new TransformationExecutionAuthorityError(
      "TRANSFORMATION_RUNTIME_AUTHORITY_INVALID",
      `${field} must be a positive integer string.`,
      { field, value },
    );
  }
  return normalized;
}

function nonNegativeBigintText(value: unknown, field: string): string {
  const normalized = typeof value === "bigint" ? value.toString() : String(value ?? "");
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new TransformationExecutionAuthorityError(
      "TRANSFORMATION_AUTHORITY_RECORD_INVALID",
      `${field} must be a non-negative integer string.`,
      { field, value },
    );
  }
  return normalized;
}

function nullableNonNegativeBigintText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return nonNegativeBigintText(value, field);
}

function nullablePositiveBigintText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return positiveBigintText(value, field);
}

function validHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TransformationExecutionAuthorityError(
      "TRANSFORMATION_AUTHORITY_RECORD_INVALID",
      `${field} must be a SHA-256 hash.`,
      { field },
    );
  }
  return value;
}

function isEmptyErrorArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function assertRequestVariant(snapshot: PackageConversionVariantSnapshot, field: string): void {
  positiveInteger(snapshot.variantId, `${field}.variantId`);
  positiveInteger(snapshot.productId, `${field}.productId`);
  positiveInteger(snapshot.unitsPerVariant, `${field}.unitsPerVariant`);
}

function runtimeEquals(left: TransformationRuntimeEvidence, right: TransformationRuntimeEvidence): boolean {
  return left.authority === right.authority
    && left.revision === right.revision
    && left.activationRunId === right.activationRunId;
}

export function parseTransformationRuntimeAuthority(
  records: readonly RuntimeAuthorityRecord[],
  expected?: TransformationRuntimeEvidence,
): TransformationRuntimeEvidence {
  if (records.length !== 1) {
    throw new TransformationExecutionAuthorityError(
      "TRANSFORMATION_RUNTIME_AUTHORITY_UNAVAILABLE",
      "The inventory runtime authority singleton is missing or duplicated.",
      { rowCount: records.length },
    );
  }
  const row = records[0]!;
  if (row.authority !== "legacy" && row.authority !== "canonical") {
    throw new TransformationExecutionAuthorityError(
      "TRANSFORMATION_RUNTIME_AUTHORITY_INVALID",
      "The inventory runtime authority has an unsupported value.",
      { authority: row.authority },
    );
  }
  const evidence: TransformationRuntimeEvidence = Object.freeze({
    authority: row.authority,
    revision: positiveBigintText(row.revision, "runtime.revision"),
    activationRunId: nullablePositiveBigintText(row.activationRunId, "runtime.activationRunId"),
  });
  if ((evidence.authority === "legacy") !== (evidence.activationRunId === null)) {
    throw new TransformationExecutionAuthorityError(
      "TRANSFORMATION_RUNTIME_AUTHORITY_INVALID",
      "The inventory runtime authority has invalid activation lineage.",
      { authority: evidence.authority, activationRunId: evidence.activationRunId },
    );
  }
  if (expected && !runtimeEquals(evidence, expected)) {
    throw new TransformationExecutionAuthorityError(
      "TRANSFORMATION_RUNTIME_AUTHORITY_CHANGED",
      "Inventory runtime authority changed after the transformation was planned.",
      { expected, actual: evidence },
    );
  }
  return evidence;
}

function assertModelAuthority(record: {
  modelId: unknown;
  modelProductId: unknown;
  modelVersion: unknown;
  modelLifecycleStatus: unknown;
  modelValidationState: unknown;
  modelValidationErrors: unknown;
  modelDefinitionHash: unknown;
}, productId: number, retained = false): { modelId: number; modelVersion: number; modelDefinitionHash: string } {
  const modelId = positiveInteger(record.modelId, "model.id");
  const lifecycleAllowed = retained
    ? record.modelLifecycleStatus === "sealed" || record.modelLifecycleStatus === "retired"
    : record.modelLifecycleStatus === "sealed";
  if (positiveInteger(record.modelProductId, "model.productId") !== productId
    || !lifecycleAllowed
    || record.modelValidationState !== "valid"
    || !isEmptyErrorArray(record.modelValidationErrors)) {
    throw new TransformationExecutionAuthorityError(
      retained ? "RETAINED_TRANSFORMATION_MODEL_INVALID" : "ACTIVE_TRANSFORMATION_MODEL_INVALID",
      retained
        ? "The retained transformation model is not an exact sealed or retired valid model for this product."
        : "The active transformation model is not the exact sealed valid model for this product.",
      { productId, modelId, lifecycleStatus: record.modelLifecycleStatus },
    );
  }
  return {
    modelId,
    modelVersion: positiveInteger(record.modelVersion, "model.version"),
    modelDefinitionHash: validHash(record.modelDefinitionHash, "model.definitionHash"),
  };
}

export function authorizePackageConversionDefinition(input: {
  request: PackageConversionAuthorizationRequest;
  runtime: TransformationRuntimeEvidence;
  records: readonly PackageConversionDefinitionRecord[];
  expected?: PackageConversionAuthorization;
}): PackageConversionAuthorization {
  const { request, runtime, records, expected } = input;
  positiveInteger(request.productId, "request.productId");
  assertRequestVariant(request.source, "request.source");
  assertRequestVariant(request.destination, "request.destination");
  if (request.source.productId !== request.productId || request.destination.productId !== request.productId
    || request.source.variantId === request.destination.variantId) {
    throw new TransformationExecutionAuthorityError(
      "PACKAGE_CONVERSION_INPUT_INVALID",
      "A package conversion must connect two distinct variants of the requested product.",
      { request },
    );
  }
  if (runtime.authority === "legacy") {
    const authorization: PackageConversionAuthorization = Object.freeze({
      runtime, productId: request.productId, operation: request.operation,
      headRevision: null, modelId: null, modelVersion: null, modelDefinitionHash: null,
      pathId: null, inputQty: null, outputQty: null,
    });
    if (expected && JSON.stringify(expected) !== JSON.stringify(authorization)) {
      throw new TransformationExecutionAuthorityError(
        "PACKAGE_CONVERSION_AUTHORIZATION_CHANGED",
        "Package conversion authorization changed after planning.",
        { expected, actual: authorization },
      );
    }
    return authorization;
  }
  if (records.length !== 1) {
    throw new TransformationExecutionAuthorityError(
      records.length === 0 ? "PACKAGE_CONVERSION_PATH_NOT_ALLOWED" : "PACKAGE_CONVERSION_PATH_AMBIGUOUS",
      records.length === 0
        ? "No exact allowed active transformation path authorizes this package conversion."
        : "More than one active transformation path authorizes this package conversion.",
      { productId: request.productId, sourceVariantId: request.source.variantId,
        destinationVariantId: request.destination.variantId, operation: request.operation, rowCount: records.length },
    );
  }
  const row = records[0]!;
  const model = assertModelAuthority(row, request.productId);
  const headRevision = nonNegativeBigintText(row.headRevision, "head.revision");
  const pathId = positiveInteger(row.pathId, "path.id");
  const inputQty = positiveInteger(row.inputQty, "path.inputQty");
  const outputQty = positiveInteger(row.outputQty, "path.outputQty");
  const sourceUnits = positiveInteger(row.sourceUnitsPerVariant, "path.sourceUnitsPerVariant");
  const destinationUnits = positiveInteger(row.destinationUnitsPerVariant, "path.destinationUnitsPerVariant");
  if (positiveInteger(row.pathModelId, "path.modelId") !== model.modelId
    || positiveInteger(row.sourceVariantId, "path.sourceVariantId") !== request.source.variantId
    || positiveInteger(row.destinationVariantId, "path.destinationVariantId") !== request.destination.variantId
    || row.operationType !== request.operation
    || row.authorityState !== "allowed"
    || row.pathValidationState !== "valid"
    || !isEmptyErrorArray(row.pathValidationErrors)
    || positiveInteger(row.sourceProductId, "source.productId") !== request.source.productId
    || positiveInteger(row.destinationProductId, "destination.productId") !== request.destination.productId
    || positiveInteger(row.currentSourceUnitsPerVariant, "source.unitsPerVariant") !== request.source.unitsPerVariant
    || positiveInteger(row.currentDestinationUnitsPerVariant, "destination.unitsPerVariant") !== request.destination.unitsPerVariant
    || sourceUnits !== request.source.unitsPerVariant
    || destinationUnits !== request.destination.unitsPerVariant
    || (request.operation === "break_pack" && sourceUnits <= destinationUnits)
    || (request.operation === "assemble_pack" && sourceUnits >= destinationUnits)
    || BigInt(inputQty) * BigInt(sourceUnits) !== BigInt(outputQty) * BigInt(destinationUnits)) {
    throw new TransformationExecutionAuthorityError(
      "PACKAGE_CONVERSION_PATH_INVALID",
      "The active transformation path does not match the exact variant and unit snapshots.",
      { productId: request.productId, pathId },
    );
  }
  const authorization: PackageConversionAuthorization = Object.freeze({
    runtime, productId: request.productId, operation: request.operation,
    headRevision, modelId: model.modelId, modelVersion: model.modelVersion,
    modelDefinitionHash: model.modelDefinitionHash, pathId, inputQty, outputQty,
  });
  if (expected && JSON.stringify(expected) !== JSON.stringify(authorization)) {
    throw new TransformationExecutionAuthorityError(
      "PACKAGE_CONVERSION_AUTHORIZATION_CHANGED",
      "Package conversion authorization changed after planning.",
      { expected, actual: authorization },
    );
  }
  return authorization;
}

/**
 * An allowed path grants only whole repetitions of its captured input/output
 * recipe. It does not implicitly authorize a fractional batch merely because
 * the live variant UOMs happen to conserve base units.
 */
export function assertAuthorizedPackageConversionQuantity(
  authorization: PackageConversionAuthorization,
  sourceQty: number,
  destinationQty: number,
): void {
  const normalizedSourceQty = positiveInteger(sourceQty, "conversion.sourceQty");
  const normalizedDestinationQty = positiveInteger(destinationQty, "conversion.destinationQty");
  if (authorization.runtime.authority === "legacy") return;

  const inputQty = positiveInteger(authorization.inputQty, "authorization.inputQty");
  const outputQty = positiveInteger(authorization.outputQty, "authorization.outputQty");
  if (normalizedSourceQty % inputQty !== 0
    || (normalizedSourceQty / inputQty) * outputQty !== normalizedDestinationQty) {
    throw new TransformationExecutionAuthorityError(
      "PACKAGE_CONVERSION_QUANTITY_NOT_AUTHORIZED",
      "The requested conversion is not a whole-number repetition of the active directed path.",
      {
        pathId: authorization.pathId,
        sourceQty: normalizedSourceQty,
        destinationQty: normalizedDestinationQty,
        pathInputQty: inputQty,
        pathOutputQty: outputQty,
      },
    );
  }
}

function normalizeBuildRequest(request: BuildAuthorizationRequest): BuildAuthorizationRequest {
  positiveInteger(request.recipeId, "request.recipeId");
  positiveInteger(request.recipeVersion, "request.recipeVersion");
  positiveInteger(request.warehouseId, "request.warehouseId");
  positiveInteger(request.outputProductId, "request.outputProductId");
  positiveInteger(request.outputVariantId, "request.outputVariantId");
  positiveInteger(request.outputUnitsPerVariant, "request.outputUnitsPerVariant");
  positiveInteger(request.outputQty, "request.outputQty");
  if (typeof request.recipeCode !== "string" || request.recipeCode.trim() === ""
    || (request.recipeType !== "assembly" && request.recipeType !== "conversion")) {
    throw new TransformationExecutionAuthorityError(
      "BUILD_AUTHORIZATION_INPUT_INVALID",
      "Build authorization requires an exact recipe identity and type.",
      { recipeId: request.recipeId, recipeType: request.recipeType },
    );
  }
  const seen = new Set<number>();
  const components = request.components.map((component) => {
    const normalized = {
      componentVariantId: positiveInteger(component.componentVariantId, "component.variantId"),
      componentProductId: positiveInteger(component.componentProductId, "component.productId"),
      componentUnitsPerVariant: positiveInteger(component.componentUnitsPerVariant, "component.unitsPerVariant"),
      componentQty: positiveInteger(component.componentQty, "component.qty"),
    };
    if (seen.has(normalized.componentVariantId)) {
      throw new TransformationExecutionAuthorityError(
        "BUILD_AUTHORIZATION_INPUT_INVALID",
        "A build authorization may snapshot each component variant only once.",
        { componentVariantId: normalized.componentVariantId },
      );
    }
    seen.add(normalized.componentVariantId);
    return Object.freeze(normalized);
  }).sort((left, right) => left.componentVariantId - right.componentVariantId);
  if (components.length === 0) {
    throw new TransformationExecutionAuthorityError(
      "BUILD_AUTHORIZATION_INPUT_INVALID",
      "A build authorization requires at least one component snapshot.",
      { recipeId: request.recipeId },
    );
  }
  return Object.freeze({ ...request, recipeCode: request.recipeCode.trim(), components: Object.freeze(components) });
}

function parseBuildComponents(value: unknown): BuildComponentSnapshot[] {
  if (!Array.isArray(value)) {
    throw new TransformationExecutionAuthorityError(
      "BUILD_BINDING_INVALID", "The active recipe binding has no component snapshot array.");
  }
  return value.map((component) => {
    const row = component as Record<string, unknown>;
    return {
      componentVariantId: positiveInteger(row.componentVariantId, "binding.component.variantId"),
      componentProductId: positiveInteger(row.componentProductId, "binding.component.productId"),
      componentUnitsPerVariant: positiveInteger(row.componentUnitsPerVariant, "binding.component.unitsPerVariant"),
      componentQty: positiveInteger(row.componentQty, "binding.component.qty"),
    };
  }).sort((left, right) => left.componentVariantId - right.componentVariantId);
}

function sameComponents(left: readonly BuildComponentSnapshot[], right: readonly BuildComponentSnapshot[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertBuildAuthorizationSnapshot(
  authorization: BuildAuthorization,
  request: BuildAuthorizationRequest,
): void {
  const normalized = normalizeBuildRequest(request);
  if (JSON.stringify(authorization.request) !== JSON.stringify(normalized)) {
    throw new TransformationExecutionAuthorityError(
      "BUILD_AUTHORIZATION_SNAPSHOT_CHANGED",
      "The locked build order or recipe no longer matches its authorized transformation binding.",
      { recipeId: normalized.recipeId, bindingId: authorization.bindingId },
    );
  }
}

export function authorizeBuildBindingDefinition(input: {
  request: BuildAuthorizationRequest;
  runtime: TransformationRuntimeEvidence;
  records: readonly BuildBindingDefinitionRecord[];
  expected?: BuildAuthorization;
  retained?: boolean;
}): BuildAuthorization {
  const request = normalizeBuildRequest(input.request);
  if (input.runtime.authority === "legacy") {
    const authorization: BuildAuthorization = Object.freeze({
      runtime: input.runtime, productId: request.outputProductId, headRevision: null,
      modelId: null, modelVersion: null, modelDefinitionHash: null, bindingId: null,
      bindingDefinitionHash: null, relationshipRole: null, warehouseId: null, request,
    });
    if (input.expected && JSON.stringify(input.expected) !== JSON.stringify(authorization)) {
      throw new TransformationExecutionAuthorityError(
        "BUILD_AUTHORIZATION_CHANGED", "Build authorization changed after planning.",
        { expected: input.expected, actual: authorization },
      );
    }
    return authorization;
  }
  if (input.records.length !== 1) {
    throw new TransformationExecutionAuthorityError(
      input.records.length === 0 ? "BUILD_BINDING_NOT_ACTIVE" : "BUILD_BINDING_AMBIGUOUS",
      input.records.length === 0
        ? "No exact active transformation recipe binding authorizes this build."
        : "More than one active transformation recipe binding authorizes this build.",
      { recipeId: request.recipeId, warehouseId: request.warehouseId, rowCount: input.records.length },
    );
  }
  const row = input.records[0]!;
  const model = assertModelAuthority(row, request.outputProductId, input.retained === true);
  const bindingId = positiveInteger(row.bindingId, "binding.id");
  const bindingWarehouseId = row.warehouseId === null || row.warehouseId === undefined
    ? null
    : positiveInteger(row.warehouseId, "binding.warehouseId");
  const expectedRole: BuildRecipeRelationshipRole = request.recipeType === "assembly"
    ? "component_build"
    : "directional_conversion";
  const components = parseBuildComponents(row.components);
  if (positiveInteger(row.bindingModelId, "binding.modelId") !== model.modelId
    || positiveInteger(row.recipeId, "binding.recipeId") !== request.recipeId
    || row.relationshipRole !== expectedRole
    || (bindingWarehouseId !== null && bindingWarehouseId !== request.warehouseId)
    || row.recipeCodeSnapshot !== request.recipeCode
    || positiveInteger(row.recipeVersionSnapshot, "binding.recipeVersion") !== request.recipeVersion
    || positiveInteger(row.outputProductIdSnapshot, "binding.outputProductId") !== request.outputProductId
    || positiveInteger(row.outputVariantIdSnapshot, "binding.outputVariantId") !== request.outputVariantId
    || positiveInteger(row.outputUnitsPerVariantSnapshot, "binding.outputUnitsPerVariant") !== request.outputUnitsPerVariant
    || positiveInteger(row.outputQtySnapshot, "binding.outputQty") !== request.outputQty
    || row.bindingValidationState !== "valid"
    || !isEmptyErrorArray(row.bindingValidationErrors)
    || row.definitionHashValid !== true
    || row.catalogSnapshotsValid !== true
    || !sameComponents(components, request.components)) {
    throw new TransformationExecutionAuthorityError(
      "BUILD_BINDING_INVALID",
      "The active transformation recipe binding does not match the exact build snapshots.",
      { recipeId: request.recipeId, bindingId },
    );
  }
  if (request.recipeType === "conversion") {
    const linkedPath = row.linkedPath as Record<string, unknown> | null;
    const source = request.components[0];
    if (request.components.length !== 1 || !linkedPath || !source
      || positiveInteger(linkedPath.bindingId, "path.bindingId") !== bindingId
      || positiveInteger(linkedPath.modelId, "path.modelId") !== model.modelId
      || positiveInteger(linkedPath.sourceVariantId, "path.sourceVariantId") !== source.componentVariantId
      || positiveInteger(linkedPath.destinationVariantId, "path.destinationVariantId") !== request.outputVariantId
      || positiveInteger(linkedPath.inputQty, "path.inputQty") !== source.componentQty
      || positiveInteger(linkedPath.outputQty, "path.outputQty") !== request.outputQty
      || positiveInteger(linkedPath.sourceUnitsPerVariant, "path.sourceUnitsPerVariant") !== source.componentUnitsPerVariant
      || positiveInteger(linkedPath.destinationUnitsPerVariant, "path.destinationUnitsPerVariant") !== request.outputUnitsPerVariant
      || linkedPath.operationType !== "directed_conversion"
      || linkedPath.authorityState !== "allowed"
      || linkedPath.validationState !== "valid"
      || !isEmptyErrorArray(linkedPath.validationErrors)) {
      throw new TransformationExecutionAuthorityError(
        "BUILD_DIRECTED_PATH_INVALID",
        "A conversion build requires the exact allowed active directed path linked to its binding.",
        { recipeId: request.recipeId, bindingId },
      );
    }
  }
  const authorization: BuildAuthorization = Object.freeze({
    runtime: input.runtime, productId: request.outputProductId,
    headRevision: input.retained
      ? nullableNonNegativeBigintText(row.headRevision, "head.revision")
      : nonNegativeBigintText(row.headRevision, "head.revision"),
    modelId: model.modelId, modelVersion: model.modelVersion,
    modelDefinitionHash: model.modelDefinitionHash, bindingId,
    bindingDefinitionHash: validHash(row.recipeDefinitionHash, "binding.recipeDefinitionHash"),
    relationshipRole: expectedRole, warehouseId: bindingWarehouseId, request,
  });
  if (input.expected && JSON.stringify(input.expected) !== JSON.stringify(authorization)) {
    throw new TransformationExecutionAuthorityError(
      "BUILD_AUTHORIZATION_CHANGED", "Build authorization changed after planning.",
      { expected: input.expected, actual: authorization },
    );
  }
  return authorization;
}
