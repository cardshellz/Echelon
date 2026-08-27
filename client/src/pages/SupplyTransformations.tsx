import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createTransformationModelDraftRequestSchema,
  createTransformationModelDraftResultSchema,
  inventoryPlanningProductOptionsResponseSchema,
  supplyTransformationsAdminViewSchema,
  updateTransformationModelDraftRequestSchema,
  type CreateTransformationModelDraftRequest,
  type UpdateTransformationModelDraftRequest,
} from "@shared/types/inventory-availability-admin";
import { z } from "zod";
import { AlertTriangle, ArrowRight, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  activeBuildRecipeIdsFromModel,
  bindingSnapshotEquation,
  deriveLosslessPath,
  deriveRecipePath,
  directedPairIsOccupied,
  draftHasUnsupportedBindings,
  isCompatibleConversionRecipe,
  prefillPathsFromModel,
  preserveSelectedProductOption,
  productOptionLabel,
  recipeEquation,
  variantDisplayName,
  type PathDraft,
  type ProductOption,
  type SupplyTransformationsAdminView,
  type TransformationAdminBinding,
  type TransformationAdminModel,
  type TransformationAdminRecipe,
  type TransformationAdminVariant,
  unavailableBuildBindingsForEdit,
} from "./supply-transformations-model";

type DraftMutationInput =
  | { kind: "create"; request: CreateTransformationModelDraftRequest }
  | {
      kind: "update";
      productId: number;
      draftModelId: number;
      request: UpdateTransformationModelDraftRequest;
    };

export default function SupplyTransformations() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("inventory_planning", "edit");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const nextRowId = useRef(1);
  const idempotencyKey = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [productId, setProductId] = useState<number | null>(null);
  const [editingCurrentDraft, setEditingCurrentDraft] = useState(false);
  const [buildToPromiseEnabled, setBuildToPromiseEnabled] = useState(false);
  const [selectedBuildRecipeIds, setSelectedBuildRecipeIds] = useState<number[]>([]);
  const [buildAuthorityResolutionConfirmed, setBuildAuthorityResolutionConfirmed] = useState(false);
  const [paths, setPaths] = useState<PathDraft[]>([]);
  const [changeReason, setChangeReason] = useState("");

  const productsQuery = useQuery<ProductOption[]>({
    queryKey: ["/api/inventory-planning/admin/products", deferredSearch],
    queryFn: async () => (await fetchJson(
      `/api/inventory-planning/admin/products?limit=50${
        deferredSearch ? `&q=${encodeURIComponent(deferredSearch)}` : ""
      }`,
      inventoryPlanningProductOptionsResponseSchema,
    )).products,
  });
  const viewQuery = useQuery<SupplyTransformationsAdminView>({
    queryKey: ["/api/inventory-planning/admin/supply-transformations", productId],
    queryFn: () => fetchJson(
      `/api/inventory-planning/admin/supply-transformations/${productId}`,
      supplyTransformationsAdminViewSchema,
    ),
    enabled: productId !== null,
  });
  const view = viewQuery.data;

  useEffect(() => {
    setEditingCurrentDraft(false);
    setBuildToPromiseEnabled(false);
    setSelectedBuildRecipeIds([]);
    setBuildAuthorityResolutionConfirmed(false);
    setPaths([]);
    setChangeReason("");
    idempotencyKey.current = null;
  }, [productId]);

  useEffect(() => {
    idempotencyKey.current = null;
  }, [buildToPromiseEnabled, changeReason, paths, selectedBuildRecipeIds]);

  const persistDraft = useMutation({
    mutationFn: (input: DraftMutationInput) => {
      if (input.kind === "create") {
        return fetchJson(
          `/api/inventory-planning/admin/supply-transformations/${input.request.productId}/drafts`,
          createTransformationModelDraftResultSchema,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input.request),
          },
        );
      }
      return fetchJson(
        `/api/inventory-planning/admin/supply-transformations/${input.productId}/drafts/${input.draftModelId}`,
        createTransformationModelDraftResultSchema,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.request),
        },
      );
    },
    onSuccess: async (result, input) => {
      idempotencyKey.current = null;
      setEditingCurrentDraft(false);
      await queryClient.invalidateQueries({
        queryKey: ["/api/inventory-planning/admin/supply-transformations", productId],
      });
      toast({
        title: input.kind === "create" ? "Draft created" : "Draft updated",
        description: input.kind === "create"
          ? `Validated draft v${result.version} was recorded. Runtime ATP is unchanged.`
          : `Draft v${result.version} was updated in place. Its identity and version are unchanged.`,
      });
    },
    onError: async (error: Error) => {
      if (
        error instanceof HttpResponseError
        && error.status === 409
        && error.code === "INVENTORY_AVAILABILITY_DRAFT_STALE"
      ) {
        idempotencyKey.current = null;
        setEditingCurrentDraft(false);
        setBuildToPromiseEnabled(false);
        setSelectedBuildRecipeIds([]);
        setBuildAuthorityResolutionConfirmed(false);
        setPaths([]);
        setChangeReason("");
        await queryClient.invalidateQueries({
          queryKey: ["/api/inventory-planning/admin/supply-transformations", productId],
        });
        toast({
          title: "Draft changed and was reloaded",
          description: "Your unsaved edit was not applied. Review the current draft before editing again.",
          variant: "destructive",
        });
        return;
      }
      toast({
        title: "Draft not saved",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const isEditing = Boolean(view && (view.draftModel === null || editingCurrentDraft));
  const activeVariants = view?.variants.filter((variant) => variant.isActive) ?? [];
  const activeAssemblyRecipes = view?.recipes.filter((recipe) =>
    recipe.recipeType === "assembly" && recipe.status === "active") ?? [];
  const draftEditIsUnsupported = Boolean(
    view?.draftModel && draftHasUnsupportedBindings(view.draftModel),
  );
  const unavailableBuildBindings = view?.draftModel
    ? unavailableBuildBindingsForEdit(view.draftModel, view.recipes)
    : [];
  const unresolvedUnavailableBuildAuthority = editingCurrentDraft
    && unavailableBuildBindings.length > 0
    && buildToPromiseEnabled
    && !buildAuthorityResolutionConfirmed;
  const productOptions = preserveSelectedProductOption(
    productsQuery.data ?? [],
    view ? {
      id: view.product.id,
      sku: view.product.sku,
      name: view.product.name,
    } : null,
  );
  const previewModel = view?.draftModel ?? view?.activeModel ?? null;
  const previewPaths = previewModel
    ? prefillPathsFromModel(previewModel, 1).paths
    : [];
  const displayedPaths = isEditing ? paths : previewPaths;

  const addPath = (destinationVariantId: number) => {
    if (!view) return;
    const destination = activeVariants.find((variant) => variant.id === destinationVariantId);
    if (!destination) return;
    const source = activeVariants.find((variant) =>
      variant.id !== destination.id
      && variant.unitsPerVariant !== destination.unitsPerVariant
      && !directedPairIsOccupied(paths, destination.id, variant.id));
    if (!source) return;
    setPaths((current) => [
      ...current,
      deriveLosslessPath(nextRowId.current++, source, destination),
    ]);
  };

  const addRecipePath = (destinationVariantId: number) => {
    if (!view) return;
    const destination = activeVariants.find((variant) => variant.id === destinationVariantId);
    if (!destination) return;
    setPaths((current) => {
      const recipe = view.recipes.find((candidate) => {
        if (!isCompatibleConversionRecipe(candidate, destination, view.variants)) return false;
        const component = candidate.components[0]!;
        return !directedPairIsOccupied(
          current,
          destination.id,
          component.componentVariantId,
        );
      });
      if (!recipe) return current;
      const component = recipe.components[0]!;
      return [...current, deriveRecipePath({
        rowId: nextRowId.current++,
        sourceVariantId: component.componentVariantId,
        destinationVariantId: destination.id,
        inputQty: "1",
        outputQty: "1",
        operationType: "directed_conversion",
        authorityState: "allowed",
        recipeId: null,
        recipeBindingKey: null,
      }, recipe)];
    });
  };

  const updatePath = (rowId: number, update: Partial<PathDraft>) => {
    if (!view) return;
    setPaths((current) => current.map((path) => {
      if (path.rowId !== rowId) return path;
      const destination = activeVariants.find((variant) =>
        variant.id === path.destinationVariantId);
      if (!destination) return path;
      if (update.recipeId !== undefined && update.recipeId !== null) {
        const recipe = view.recipes.find((candidate) =>
          candidate.id === update.recipeId
          && isCompatibleConversionRecipe(candidate, destination, view.variants));
        return recipe ? deriveRecipePath(path, recipe) : path;
      }
      const sourceVariantId = update.sourceVariantId ?? path.sourceVariantId;
      const source = activeVariants.find((variant) => variant.id === sourceVariantId);
      if (!source) return path;
      if (update.recipeId === null || (path.recipeId === null && update.sourceVariantId !== undefined)) {
        return deriveLosslessPath(
          path.rowId,
          source,
          destination,
          update.authorityState ?? path.authorityState,
        );
      }
      return { ...path, ...update };
    }));
  };

  const request = useMemo(() => {
    if (!view || !isEditing) return null;
    const candidate = buildCreateRequestCandidate({
      view,
      buildToPromiseEnabled,
      selectedBuildRecipeIds,
      paths,
      changeReason,
      idempotencyKey: "pending-validation",
    });
    const parsed = createTransformationModelDraftRequestSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }, [
    buildToPromiseEnabled,
    changeReason,
    isEditing,
    paths,
    selectedBuildRecipeIds,
    view,
  ]);

  const submitDraft = () => {
    if (!view || !isEditing) return;
    const candidate = buildCreateRequestCandidate({
      view,
      buildToPromiseEnabled,
      selectedBuildRecipeIds,
      paths,
      changeReason,
      idempotencyKey: idempotencyKey.current
        ?? `transformation-model:${view.product.id}:${crypto.randomUUID()}`,
    });
    const parsed = createTransformationModelDraftRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      toast({
        title: "Review the draft",
        description: parsed.error.issues[0]?.message ?? "The draft is incomplete.",
        variant: "destructive",
      });
      return;
    }
    idempotencyKey.current = parsed.data.idempotencyKey;
    if (editingCurrentDraft && view.draftModel) {
      if (!view.head || view.head.draftModelId !== view.draftModel.id) {
        toast({
          title: "Reload the draft",
          description: "The loaded draft head is missing or inconsistent.",
          variant: "destructive",
        });
        return;
      }
      const { productId: requestProductId, ...definition } = parsed.data;
      persistDraft.mutate({
        kind: "update",
        productId: requestProductId,
        draftModelId: view.draftModel.id,
        request: updateTransformationModelDraftRequestSchema.parse({
          expectedVersion: view.draftModel.version,
          expectedDefinitionHash: view.draftModel.definitionHash,
          expectedHeadRevision: view.head.revision,
          ...definition,
        }),
      });
      return;
    }
    persistDraft.mutate({ kind: "create", request: parsed.data });
  };

  const beginDraftEdit = () => {
    if (!view?.draftModel || draftHasUnsupportedBindings(view.draftModel)) return;
    const prefill = prefillPathsFromModel(view.draftModel, nextRowId.current);
    nextRowId.current = prefill.nextRowId;
    setBuildToPromiseEnabled(view.draftModel.buildToPromiseEnabled);
    setSelectedBuildRecipeIds(activeBuildRecipeIdsFromModel(view.draftModel, view.recipes));
    setBuildAuthorityResolutionConfirmed(
      unavailableBuildBindingsForEdit(view.draftModel, view.recipes).length === 0,
    );
    setPaths(prefill.paths);
    setChangeReason("");
    idempotencyKey.current = null;
    setEditingCurrentDraft(true);
  };

  const cancelDraftEdit = () => {
    setEditingCurrentDraft(false);
    setBuildToPromiseEnabled(false);
    setSelectedBuildRecipeIds([]);
    setBuildAuthorityResolutionConfirmed(false);
    setPaths([]);
    setChangeReason("");
    idempotencyKey.current = null;
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Supply &amp; Transformations</h1>
        <p className="text-sm text-muted-foreground">
          Define explicit package conversions and build authority. Drafts do not affect ATP,
          reservations, builds, or channel quantities.
        </p>
      </div>

      <Card className="border-amber-300 bg-amber-50/60">
        <CardContent className="flex gap-3 pt-6 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
          <div>
            <div className="font-semibold text-amber-900">Legacy runtime authority remains active</div>
            <div className="text-amber-800">
              This page records validated drafts only. It has no activation endpoint and cannot
              publish inventory.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Select a product</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="transformation-product-search">Search</Label>
            <Input
              id="transformation-product-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="SKU or product name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="transformation-product">Product</Label>
            <select
              id="transformation-product"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={productId ?? ""}
              onChange={(event) => setProductId(
                event.target.value ? Number(event.target.value) : null,
              )}
            >
              <option value="">Choose a product</option>
              {productOptions.map((product) => (
                <option key={product.id} value={product.id}>{productOptionLabel(product)}</option>
              ))}
            </select>
            {productsQuery.isLoading && (
              <div className="text-xs text-muted-foreground">Loading products…</div>
            )}
            {productsQuery.error && (
              <div className="text-xs text-destructive">
                {(productsQuery.error as Error).message}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {viewQuery.isLoading && <div className="text-sm text-muted-foreground">Loading model…</div>}
      {viewQuery.error && (
        <div className="text-sm text-destructive">{(viewQuery.error as Error).message}</div>
      )}

      {view && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {view.product.sku ?? `Product ${view.product.id}`} — {view.product.name}
                <Badge variant="outline">legacy: {view.runtimeAuthority.value}</Badge>
                {view.draftModel && <Badge>draft v{view.draftModel.version}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>Head revision: {view.head?.revision ?? "not created"}</div>
              <div>
                Active new-model authority: {view.activeModel
                  ? `sealed v${view.activeModel.version}`
                  : "none"}
              </div>
              <div className="font-medium text-amber-800">
                Runtime ATP still reads legacy inventory strategy.
              </div>
              {view.draftModel && !editingCurrentDraft && canEdit && draftEditIsUnsupported && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
                  This draft contains warehouse-scoped or unsupported recipe authority. Editing is
                  disabled because this network-only page cannot preserve those controls. Use the
                  future warehouse-aware editor for this draft.
                </div>
              )}
              {view.draftModel && !editingCurrentDraft && canEdit && !draftEditIsUnsupported && (
                <Button type="button" variant="outline" onClick={beginDraftEdit}>
                  <Pencil className="mr-2 h-4 w-4" /> Edit current draft
                </Button>
              )}
              {view.draftModel && editingCurrentDraft && (
                <>
                  <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-blue-900">
                    Editing draft v{view.draftModel.version}. Saving updates this draft in place;
                    its ID and version remain unchanged. Runtime authority is still unaffected.
                  </div>
                  {unavailableBuildBindings.length > 0 && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
                      Frozen build recipe binding{unavailableBuildBindings.length === 1 ? "" : "s"}{" "}
                      {unavailableBuildBindings.map((binding) =>
                        `${binding.recipeCodeSnapshot} v${binding.recipeVersionSnapshot}`).join(", ")}{" "}
                      {unavailableBuildBindings.length === 1 ? "is" : "are"} no longer selectable.
                      Saving is disabled until you change the current recipe selection or turn
                      build-to-promise off.
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <DestinationColumns
            view={view}
            paths={displayedPaths}
            editable={canEdit && isEditing}
            onAddPath={addPath}
            onAddRecipePath={addRecipePath}
            onChangePath={updatePath}
            onRemovePath={(rowId) => setPaths((current) =>
              current.filter((candidate) => candidate.rowId !== rowId))}
          />

          {isEditing && canEdit && (
            <>
              <BuildAuthorityEditor
                view={view}
                recipes={activeAssemblyRecipes}
                enabled={buildToPromiseEnabled}
                selectedRecipeIds={selectedBuildRecipeIds}
                onEnabledChange={(enabled) => {
                  setBuildToPromiseEnabled(enabled);
                  if (!enabled) setBuildAuthorityResolutionConfirmed(true);
                }}
                onRecipeSelectionChange={(recipeIds) => {
                  setSelectedBuildRecipeIds(recipeIds);
                  setBuildAuthorityResolutionConfirmed(true);
                }}
              />

              <Card>
                <CardHeader><CardTitle>Record draft</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="transformation-change-reason">Change reason</Label>
                    <Textarea
                      id="transformation-change-reason"
                      value={changeReason}
                      onChange={(event) => setChangeReason(event.target.value)}
                      placeholder="Why this transformation authority is correct"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={
                        !request
                        || persistDraft.isPending
                        || (editingCurrentDraft && (!view.head || !view.draftModel))
                        || (buildToPromiseEnabled && selectedBuildRecipeIds.length === 0)
                        || unresolvedUnavailableBuildAuthority
                      }
                      onClick={submitDraft}
                    >
                      <ShieldCheck className="mr-2 h-4 w-4" />
                      {persistDraft.isPending
                        ? "Validating…"
                        : editingCurrentDraft
                          ? "Save draft updates"
                          : "Create validated draft"}
                    </Button>
                    {editingCurrentDraft && (
                      <Button type="button" variant="outline" onClick={cancelDraftEdit}>
                        Cancel
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {view.draftModel && !editingCurrentDraft && (
            <DraftEvidence model={view.draftModel} view={view} />
          )}
          {!canEdit && (
            <div className="text-sm text-muted-foreground">
              You have view access only. The inventory planning edit ability is required to
              create or update drafts.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DestinationColumns({
  view,
  paths,
  editable,
  onAddPath,
  onAddRecipePath,
  onChangePath,
  onRemovePath,
}: {
  view: SupplyTransformationsAdminView;
  paths: PathDraft[];
  editable: boolean;
  onAddPath: (destinationVariantId: number) => void;
  onAddRecipePath: (destinationVariantId: number) => void;
  onChangePath: (rowId: number, update: Partial<PathDraft>) => void;
  onRemovePath: (rowId: number) => void;
}) {
  const activeVariants = view.variants.filter((variant) => variant.isActive);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Authority by output SKU</CardTitle>
        <p className="text-xs text-muted-foreground">
          Each output column owns every incoming source path and its Allowed/Blocked authority.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {view.variants.map((destination) => {
          const destinationPaths = paths.filter((path) =>
            path.destinationVariantId === destination.id);
          const canAddLosslessPath = destination.isActive && activeVariants.some((source) =>
            source.id !== destination.id
            && source.unitsPerVariant !== destination.unitsPerVariant
            && !directedPairIsOccupied(paths, destination.id, source.id));
          const canAddRecipePath = destination.isActive && view.recipes.some((recipe) => {
            if (!isCompatibleConversionRecipe(recipe, destination, view.variants)) return false;
            const component = recipe.components[0]!;
            return !directedPairIsOccupied(
              paths,
              destination.id,
              component.componentVariantId,
            );
          });
          return (
            <div key={destination.id} className="space-y-3 rounded-md border p-3">
              <div>
                <div className="font-semibold">{variantDisplayName(destination)}</div>
                <div className="text-xs text-muted-foreground">
                  Output · {destination.unitsPerVariant} base unit{
                    destination.unitsPerVariant === 1 ? "" : "s"
                  }
                </div>
              </div>
              {destinationPaths.map((path) => editable ? (
                <DestinationPathEditor
                  key={path.rowId}
                  path={path}
                  destination={destination}
                  allPaths={paths}
                  view={view}
                  onChange={(update) => onChangePath(path.rowId, update)}
                  onRemove={() => onRemovePath(path.rowId)}
                />
              ) : (
                <DestinationPathEvidence key={path.rowId} path={path} view={view} />
              ))}
              {destinationPaths.length === 0 && (
                <div className="text-xs text-muted-foreground">Exact physical supply only</div>
              )}
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canAddLosslessPath}
                    onClick={() => onAddPath(destination.id)}
                  >
                    <Plus className="mr-2 h-3.5 w-3.5" /> Add package path
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canAddRecipePath}
                    onClick={() => onAddRecipePath(destination.id)}
                  >
                    <Plus className="mr-2 h-3.5 w-3.5" /> Add recipe path
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function DestinationPathEditor({
  path,
  destination,
  allPaths,
  view,
  onChange,
  onRemove,
}: {
  path: PathDraft;
  destination: TransformationAdminVariant;
  allPaths: PathDraft[];
  view: SupplyTransformationsAdminView;
  onChange: (update: Partial<PathDraft>) => void;
  onRemove: () => void;
}) {
  const variants = view.variants.filter((variant) => variant.isActive);
  const source = variants.find((variant) => variant.id === path.sourceVariantId);
  const compatibleRecipes = view.recipes.filter((recipe) => {
    if (!isCompatibleConversionRecipe(recipe, destination, view.variants)) return false;
    const component = recipe.components[0]!;
    return !directedPairIsOccupied(
      allPaths,
      destination.id,
      component.componentVariantId,
      path.rowId,
    );
  });
  const selectedRecipe = path.recipeId === null
    ? null
    : view.recipes.find((recipe) => recipe.id === path.recipeId) ?? null;
  return (
    <div className="space-y-3 rounded-md bg-muted/60 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">
          {variantDisplayName(source)} <ArrowRight className="inline h-3 w-3" />{
            " "}{variantDisplayName(destination)}
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label="Remove path">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-1">
        <Label>Source SKU</Label>
        <select
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={path.sourceVariantId}
          disabled={path.recipeId !== null}
          onChange={(event) => onChange({ sourceVariantId: Number(event.target.value) })}
        >
          {variants
            .filter((variant) =>
              variant.id !== destination.id
              && (path.recipeId !== null
                || variant.unitsPerVariant !== destination.unitsPerVariant)
              && !directedPairIsOccupied(allPaths, destination.id, variant.id, path.rowId))
            .map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variantDisplayName(variant)} ({variant.unitsPerVariant})
              </option>
            ))}
        </select>
      </div>
      <div className="rounded border bg-background p-2 text-xs">
        <div className="font-medium">
          {path.inputQty} × {variantDisplayName(source)} → {path.outputQty} ×{
            " "}{variantDisplayName(destination)}
        </div>
        <div className="text-muted-foreground">
          {selectedRecipe
            ? `Locked to ${selectedRecipe.code} v${selectedRecipe.version}`
            : "Reduced lossless ratio derived from package units"}
        </div>
      </div>
      <div className="space-y-1">
        <Label>Recipe authority</Label>
        <select
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={path.recipeId ?? ""}
          onChange={(event) => onChange({
            recipeId: event.target.value ? Number(event.target.value) : null,
          })}
        >
          {source && source.unitsPerVariant !== destination.unitsPerVariant && (
            <option value="">Lossless package path</option>
          )}
          {compatibleRecipes.map((recipe) => (
            <option key={recipe.id} value={recipe.id}>
              {recipe.code} v{recipe.version} · {recipeEquation(recipe, view.variants)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label>Authority</Label>
        <select
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          value={path.authorityState}
          onChange={(event) => onChange({
            authorityState: event.target.value as PathDraft["authorityState"],
          })}
        >
          <option value="allowed">Allowed</option>
          <option value="blocked">Blocked</option>
        </select>
      </div>
    </div>
  );
}

function DestinationPathEvidence({
  path,
  view,
}: {
  path: PathDraft;
  view: SupplyTransformationsAdminView;
}) {
  const source = view.variants.find((variant) => variant.id === path.sourceVariantId);
  const destination = view.variants.find((variant) => variant.id === path.destinationVariantId);
  const model = view.draftModel ?? view.activeModel;
  const binding = path.recipeBindingKey === null
    ? null
    : model?.bindings.find((candidate) =>
      candidate.bindingKey === path.recipeBindingKey) ?? null;
  return (
    <div className="space-y-2 rounded bg-muted p-2 text-sm">
      <div className="font-medium">
        {path.inputQty} × {variantDisplayName(source)} <ArrowRight className="inline h-3 w-3" />{
          " "}{path.outputQty} × {variantDisplayName(destination)}
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge variant={path.authorityState === "allowed" ? "default" : "secondary"}>
          {path.authorityState}
        </Badge>
        <Badge variant="outline">{formatOperation(path.operationType)}</Badge>
      </div>
      <div className="text-xs text-muted-foreground">
        {binding
          ? `Authorized by ${binding.recipeCodeSnapshot} v${binding.recipeVersionSnapshot}: ${bindingSnapshotEquation(binding, view.variants)}`
          : "Lossless package conversion; no recipe authority required."}
      </div>
    </div>
  );
}

function BuildAuthorityEditor({
  view,
  recipes,
  enabled,
  selectedRecipeIds,
  onEnabledChange,
  onRecipeSelectionChange,
}: {
  view: SupplyTransformationsAdminView;
  recipes: TransformationAdminRecipe[];
  enabled: boolean;
  selectedRecipeIds: number[];
  onEnabledChange: (enabled: boolean) => void;
  onRecipeSelectionChange: (recipeIds: number[]) => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>Build-to-promise authority</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <div className="font-medium">Allow component assembly in ATP</div>
            <div className="text-xs text-muted-foreground">
              Product-level draft authority only; it is not a channel setting or runtime switch.
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={onEnabledChange} />
        </div>
        {recipes.map((recipe) => (
          <label key={recipe.id} className="flex gap-3 rounded-md border p-3">
            <input
              type="checkbox"
              checked={selectedRecipeIds.includes(recipe.id)}
              onChange={(event) => onRecipeSelectionChange(
                event.target.checked
                  ? [...selectedRecipeIds, recipe.id]
                  : selectedRecipeIds.filter((id) => id !== recipe.id),
              )}
            />
            <span className="text-sm">
              <span className="font-medium">{recipe.code} v{recipe.version} · {recipe.name}</span>
              <span className="block text-muted-foreground">
                {recipeEquation(recipe, view.variants)}
              </span>
            </span>
          </label>
        ))}
        {recipes.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No active assembly recipe outputs this product.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DraftEvidence({
  model,
  view,
}: {
  model: TransformationAdminModel;
  view: SupplyTransformationsAdminView;
}) {
  const buildBindings = model.bindings.filter((binding) =>
    binding.relationshipRole === "component_build");
  return (
    <Card>
      <CardHeader><CardTitle>Immutable draft evidence</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-2 md:grid-cols-2">
          <div><span className="font-medium">Draft:</span> v{model.version} · ID {model.id}</div>
          <div>
            <span className="font-medium">Build-to-promise:</span>{" "}
            {model.buildToPromiseEnabled ? "Enabled" : "Off"}
          </div>
          <div><span className="font-medium">Validation:</span> {model.validationState}</div>
          <div className="break-all">
            <span className="font-medium">Definition hash:</span> {model.definitionHash}
          </div>
        </div>
        <div>
          <div className="font-medium">Build authority recipes</div>
          {buildBindings.length === 0 ? (
            <div className="text-muted-foreground">None recorded.</div>
          ) : (
            <div className="mt-2 space-y-2">
              {buildBindings.map((binding) => (
                <BindingSnapshotEvidence
                  key={binding.bindingKey}
                  binding={binding}
                  variants={view.variants}
                />
              ))}
            </div>
          )}
        </div>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
          Draft v{model.version} records recipe version and ordered BOM snapshots. Editing creates
          an audited update to this same draft ID/version; live recipe changes do not silently
          rewrite its recorded evidence. It cannot be activated here and has no runtime effect.
        </div>
      </CardContent>
    </Card>
  );
}

function BindingSnapshotEvidence({
  binding,
  variants,
}: {
  binding: TransformationAdminBinding;
  variants: TransformationAdminVariant[];
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="font-medium">
        {binding.recipeCodeSnapshot} v{binding.recipeVersionSnapshot}
      </div>
      <div className="text-muted-foreground">
        {bindingSnapshotEquation(binding, variants)}
      </div>
      <div className="text-xs text-muted-foreground">
        Immutable recipe hash: {binding.recipeDefinitionHash} · Scope:{" "}
        {binding.warehouseId === null ? "network" : `warehouse ${binding.warehouseId}`}
      </div>
    </div>
  );
}

function buildCreateRequestCandidate(input: {
  view: SupplyTransformationsAdminView;
  buildToPromiseEnabled: boolean;
  selectedBuildRecipeIds: number[];
  paths: PathDraft[];
  changeReason: string;
  idempotencyKey: string;
}): CreateTransformationModelDraftRequest {
  const directionalBindings = Array.from(new Map(input.paths.flatMap((path) =>
    path.recipeId === null || path.recipeBindingKey === null
      ? []
      : [[path.recipeBindingKey, {
          bindingKey: path.recipeBindingKey,
          recipeId: path.recipeId,
          relationshipRole: "directional_conversion" as const,
          warehouseId: null,
        }] as const],
  )).values());
  const existingBuildBindingKeyByRecipeId = new Map(
    (input.view.draftModel?.bindings ?? [])
      .filter((binding) =>
        binding.relationshipRole === "component_build" && binding.warehouseId === null)
      .map((binding) => [binding.recipeId, binding.bindingKey] as const),
  );
  return {
    productId: input.view.product.id,
    buildToPromiseEnabled: input.buildToPromiseEnabled,
    paths: input.paths.map((path) => ({
      sourceVariantId: path.sourceVariantId,
      destinationVariantId: path.destinationVariantId,
      inputQty: Number(path.inputQty),
      outputQty: Number(path.outputQty),
      operationType: path.operationType,
      authorityState: path.authorityState,
      transformationRecipeBindingKey: path.recipeBindingKey,
    })),
    recipeBindings: [
      ...input.selectedBuildRecipeIds.map((recipeId) => ({
        bindingKey: existingBuildBindingKeyByRecipeId.get(recipeId) ?? recipeBindingKey(recipeId),
        recipeId,
        relationshipRole: "component_build" as const,
        warehouseId: null,
      })),
      ...directionalBindings,
    ],
    changeReason: input.changeReason,
    idempotencyKey: input.idempotencyKey,
  };
}

function formatOperation(operation: PathDraft["operationType"]): string {
  switch (operation) {
    case "assemble_pack": return "assemble pack";
    case "break_pack": return "break pack";
    case "directed_conversion": return "directed recipe";
  }
}

function recipeBindingKey(recipeId: number): string {
  return `recipe:${recipeId}:network`;
}

async function fetchJson<T>(
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const serverError = parseServerError(body);
    throw new HttpResponseError(
      response.status,
      serverError?.code ?? null,
      serverError?.message ?? `Request failed (${response.status}).`,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "response";
    throw new Error(
      `Server returned invalid data at ${path}: ${issue?.message ?? "invalid response"}.`,
    );
  }
  return parsed.data;
}

class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "HttpResponseError";
  }
}

function parseServerError(body: unknown): { code: string | null; message: string } | null {
  const parsed = z.object({
    error: z.union([
      z.string(),
      z.object({
        code: z.string().optional(),
        message: z.string().optional(),
        details: z.array(z.string()).optional(),
      }).passthrough(),
    ]),
  }).passthrough().safeParse(body);
  if (!parsed.success) return null;
  if (typeof parsed.data.error === "string") {
    return { code: null, message: parsed.data.error };
  }
  const message = parsed.data.error.details?.[0] ?? parsed.data.error.message;
  return message ? { code: parsed.data.error.code ?? null, message } : null;
}
