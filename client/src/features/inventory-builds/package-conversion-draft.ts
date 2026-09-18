import {
  createTransformationModelDraftRequestSchema,
  createTransformationModelDraftResultSchema,
  supplyTransformationsAdminViewSchema,
  updateTransformationModelDraftRequestSchema,
  type CreateTransformationModelDraftRequest,
  type SupplyTransformationsAdminView,
  type UpdateTransformationModelDraftRequest,
} from "@shared/types/inventory-availability-admin";
import { prefillPathsFromModel, type PathDraft } from "@/pages/supply-transformations-model";
import { packageLadderModelEditIssues } from "./package-conversion-ladder";
import { fetchJson } from "@/pages/inventory-planning-http";
export { HttpResponseError as PackageConversionHttpError } from "@/pages/inventory-planning-http";

export const PACKAGE_CONVERSION_AUDIT_NOTE =
  "Updated package conversion directions from the product Variants tab.";
export const transformationQueryKey = (productId: number) =>
  ["/api/inventory-planning/admin/supply-transformations", productId] as const;

export type PackageConversionEdit = {
  /** Capture once. Background refresh must never rebase the operator's edit. */
  baseline: SupplyTransformationsAdminView;
  paths: PathDraft[];
  nextRowId: number;
};

export type PackageConversionCommand =
  | { method: "POST"; url: string; request: CreateTransformationModelDraftRequest }
  | { method: "PUT"; url: string; request: UpdateTransformationModelDraftRequest };

export function packageConversionEditIssues(view: SupplyTransformationsAdminView): string[] {
  const issues = packageLadderModelEditIssues(view.variants, view.draftModel ?? view.activeModel);
  if (view.variants.some(variant => variant.productId !== view.product.id)
    || (view.draftModel !== null && view.draftModel.productId !== view.product.id)
    || (view.activeModel !== null && view.activeModel.productId !== view.product.id)) {
    issues.push("The model or variants belong to a different product. Reload before editing.");
  }
  if (!view.product.isActive) issues.push("Archived products cannot be edited here.");
  if (view.product.legacyInventoryStrategy !== "physical_fungible") {
    issues.push("The package ladder is available for Package hierarchy products only.");
  }
  if ((view.head?.draftModelId ?? null) !== (view.draftModel?.id ?? null)
    || (view.head?.activeModelId ?? null) !== (view.activeModel?.id ?? null)
    || (view.draftModel !== null && view.draftModel.lifecycleStatus !== "draft")
    || (view.activeModel !== null && view.activeModel.lifecycleStatus !== "sealed")) {
    issues.push("The loaded model does not match its saved head. Reload before editing.");
  }
  return issues;
}

export function beginPackageConversionEdit(view: SupplyTransformationsAdminView): PackageConversionEdit {
  const baseline = supplyTransformationsAdminViewSchema.parse(view);
  const issues = packageConversionEditIssues(baseline);
  if (issues.length) throw new Error(issues.join(" "));
  const model = baseline.draftModel ?? baseline.activeModel;
  return { baseline, ...(model ? prefillPathsFromModel(model, 1) : { paths: [], nextRowId: 1 }) };
}

export function packageConversionHasChanges(edit: PackageConversionEdit): boolean {
  const model = edit.baseline.draftModel ?? edit.baseline.activeModel;
  const original = model ? prefillPathsFromModel(model, 1).paths : [];
  const comparable = (paths: PathDraft[]) => JSON.stringify(paths.map(({ rowId: _rowId, ...path }) => path)
    .sort((a, b) => a.sourceVariantId - b.sourceVariantId || a.destinationVariantId - b.destinationVariantId));
  return comparable(original) !== comparable(edit.paths);
}

export function buildPackageConversionCommand(edit: PackageConversionEdit, idempotencyKey: string): PackageConversionCommand {
  const { baseline } = edit;
  const issues = packageConversionEditIssues(baseline);
  if (issues.length) throw new Error(issues.join(" "));
  if (!packageConversionHasChanges(edit)) throw new Error("Choose a conversion direction before saving.");
  const model = baseline.draftModel ?? baseline.activeModel;
  const definition = {
    buildToPromiseEnabled: model?.buildToPromiseEnabled ?? false,
    paths: edit.paths.map(path => ({
      sourceVariantId: path.sourceVariantId,
      destinationVariantId: path.destinationVariantId,
      inputQty: Number(path.inputQty),
      outputQty: Number(path.outputQty),
      operationType: path.operationType,
      authorityState: path.authorityState,
      transformationRecipeBindingKey: path.recipeBindingKey,
    })),
    recipeBindings: (model?.bindings ?? []).map(binding => ({
      bindingKey: binding.bindingKey, recipeId: binding.recipeId,
      relationshipRole: binding.relationshipRole, warehouseId: binding.warehouseId,
    })),
    changeReason: PACKAGE_CONVERSION_AUDIT_NOTE,
    idempotencyKey,
  };
  const url = `/api/inventory-planning/admin/supply-transformations/${baseline.product.id}/drafts`;
  if (baseline.draftModel && baseline.head) {
    return { method: "PUT", url: `${url}/${baseline.draftModel.id}`, request: updateTransformationModelDraftRequestSchema.parse({
      ...definition,
      expectedVersion: baseline.draftModel.version,
      expectedDefinitionHash: baseline.draftModel.definitionHash,
      expectedHeadRevision: baseline.head.revision,
    }) };
  }
  return { method: "POST", url, request: createTransformationModelDraftRequestSchema.parse({
    ...definition, productId: baseline.product.id,
  }) };
}

export async function loadProductConversions(productId: number, signal?: AbortSignal): Promise<SupplyTransformationsAdminView> {
  const view = await fetchJson(`/api/inventory-planning/admin/supply-transformations/${productId}`,
    supplyTransformationsAdminViewSchema, { signal });
  if (view.product.id !== productId) throw new Error("The server returned a different product. Reload before editing.");
  return view;
}

export async function savePackageConversionCommand(command: PackageConversionCommand) {
  return fetchJson(command.url, createTransformationModelDraftResultSchema, {
    method: command.method, credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command.request),
  });
}
