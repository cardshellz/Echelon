import React, { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRightLeft, RefreshCw } from "lucide-react";
import type { ProductInventoryStrategy } from "@shared/catalog/inventory-strategy";
import type { SupplyTransformationsAdminView } from "@shared/types/inventory-availability-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { prefillPathsFromModel, transformationRuntimeLabel } from "@/pages/supply-transformations-model";
import { ProductBuildRelationships } from "./ProductBuildRelationships";
import {
  buildPackageLadder, updatePackageLadderDirection, type PackageDirection,
} from "./package-conversion-ladder";
import {
  beginPackageConversionEdit, buildPackageConversionCommand, loadProductConversions,
  PACKAGE_CONVERSION_AUDIT_NOTE, packageConversionEditIssues, packageConversionHasChanges,
  PackageConversionHttpError, savePackageConversionCommand, transformationQueryKey,
  type PackageConversionCommand, type PackageConversionEdit,
} from "./package-conversion-draft";

type Props = { productId: number; inventoryStrategy: ProductInventoryStrategy; enabled: boolean };
const STRATEGY_TITLES: Record<ProductInventoryStrategy, string> = {
  physical_fungible: "Package hierarchy", recipe_managed: "Build managed", physical_only: "Physical only",
};
const DIRECTIONS: ReadonlyArray<{ value: PackageDirection; label: string }> = [
  { value: "none", label: "None" }, { value: "break_down", label: "Break down" },
  { value: "build_up", label: "Build up" }, { value: "reversible", label: "Reversible" },
];

function useProductConversions(productId: number, enabled: boolean) {
  return useQuery({
    queryKey: transformationQueryKey(productId),
    queryFn: ({ signal }) => loadProductConversions(productId, signal),
    enabled: enabled && Number.isSafeInteger(productId) && productId > 0,
    retry: false,
  });
}

function verifiedActiveModel(view: SupplyTransformationsAdminView) {
  return view.activeModel?.lifecycleStatus === "sealed"
    && view.head?.activeModelId === view.activeModel.id
    && view.activeModel.productId === view.product.id ? view.activeModel : null;
}

function ModelSummary({ view, editing }: { view: SupplyTransformationsAdminView; editing: boolean }) {
  const model = editing ? view.draftModel ?? verifiedActiveModel(view) : verifiedActiveModel(view);
  const allowedCount = model?.paths.filter(path => path.authorityState === "allowed").length ?? 0;
  return <div className="space-y-1 text-sm" data-testid="product-conversion-model-summary">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">{editing ? "Your changes — not live"
        : model ? `${view.runtimeSelection?.authority === "canonical" ? "Active rules" : "Approved rules — runtime not confirmed"} · v${model.version}`
          : "No active conversion model"}</Badge>
      {!editing && model && <Badge variant={model.validationState === "valid" ? "secondary" : "destructive"}>
        {model.validationState === "valid" ? "Validated" : "Needs review"}
      </Badge>}
      {!editing && <span>{allowedCount} allowed direction{allowedCount === 1 ? "" : "s"} · {model?.bindings.length ?? 0} recipe bindings</span>}
    </div>
    <p className="text-xs text-muted-foreground">{transformationRuntimeLabel(view)}.</p>
    {editing && <p className="text-xs text-muted-foreground">Saving a draft does not change active rules.</p>}
  </div>;
}

/** Catalog access alone must not issue a planning request or expose cached planning data. */
export function ProductConversionSummary({ productId, enabled }: Pick<Props, "productId" | "enabled">) {
  const { hasPermission } = useAuth();
  if (!hasPermission("inventory_planning", "view")) return <p className="text-xs text-muted-foreground">
    Inventory planning view permission is required to see conversion rules.
  </p>;
  return <AuthorizedConversionSummary productId={productId} enabled={enabled} />;
}

function AuthorizedConversionSummary({ productId, enabled }: Pick<Props, "productId" | "enabled">) {
  const query = useProductConversions(productId, enabled);
  if (query.isError) return <p role="alert" className="text-xs text-destructive">Conversion status unavailable. Open Variants to reload.</p>;
  if (!query.data) return <p className="text-xs text-muted-foreground">Loading conversion status…</p>;
  return <ActivePackageSharingSummary view={query.data} />;
}

function ActivePackageSharingSummary({ view }: { view: SupplyTransformationsAdminView }) {
  const inlinePathLimit = 3;
  // A draft is proposed authority. Only the matching sealed head can describe
  // approved package sharing, and the runtime label separately proves its use.
  const model = verifiedActiveModel(view);
  const paths = model?.paths.filter(path => path.authorityState === "allowed") ?? [];
  const variants = new Map(view.variants.map(variant => [variant.id, variant]));
  const variantLabel = (variantId: number) => {
    const variant = variants.get(variantId);
    return variant?.sku ?? variant?.name ?? `Variant #${variantId}`;
  };
  const pathList = <ul className="space-y-1">
    {paths.map(path => <li key={`${path.sourceVariantId}:${path.destinationVariantId}`} className="break-words">
      {path.inputQty} {variantLabel(path.sourceVariantId)} → {path.outputQty} {variantLabel(path.destinationVariantId)}
    </li>)}
  </ul>;
  return <div className="space-y-2 text-xs" data-testid="product-conversion-active-summary">
    <p className="font-medium">{transformationRuntimeLabel(view)}.</p>
    <div>
      <p className="font-medium">Sealed package sharing{model ? ` · v${model.version}` : ""}</p>
      {!model ? <p className="text-muted-foreground">
        {view.activeModel ? "The sealed model could not be verified against its saved head." : "No sealed model is recorded."}
      </p> : paths.length === 0 ? <p className="text-muted-foreground">No allowed package-sharing directions.</p>
        : paths.length <= inlinePathLimit ? pathList
          : <details><summary className="cursor-pointer">{paths.length} allowed directions</summary>{pathList}</details>}
    </div>
    {view.draftModel && <Badge variant="outline">Proposed draft v{view.draftModel.version} — not live</Badge>}
  </div>;
}

export function ProductConversionCard(props: Props) {
  const { user, hasPermission } = useAuth();
  if (props.inventoryStrategy === "physical_only") return null;
  if (!hasPermission("inventory_planning", "view")) return <Card>
    <CardHeader><CardTitle className="text-base">{STRATEGY_TITLES[props.inventoryStrategy]}</CardTitle></CardHeader>
    <CardContent className="text-sm text-muted-foreground">Inventory planning view permission is required to see conversion rules.</CardContent>
  </Card>;
  return <AuthorizedConversionCard key={`${props.productId}:${user?.id}`} {...props}
    canEdit={hasPermission("inventory_planning", "edit")} />;
}

function AuthorizedConversionCard({ productId, inventoryStrategy, enabled, canEdit }: Props & { canEdit: boolean }) {
  const query = useProductConversions(productId, enabled);
  const queryClient = useQueryClient();
  const [edit, setEdit] = useState<PackageConversionEdit | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const pendingCommand = useRef<PackageConversionCommand | null>(null);
  const mutation = useMutation({
    mutationFn: savePackageConversionCommand,
    onSuccess: async result => {
      pendingCommand.current = null;
      setEdit(null); setError(null); setConflict(false); setUncertain(false);
      setMessage(`Draft v${result.version} saved. Live conversion rules and inventory are unchanged.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: transformationQueryKey(productId) }),
        queryClient.invalidateQueries({ queryKey: ["/api/inventory-planning/admin/migration-queue"] }),
      ]);
    },
    onError: (failure: Error) => {
      const rejected = failure instanceof PackageConversionHttpError && failure.status >= 400 && failure.status < 500;
      const stale = failure instanceof PackageConversionHttpError && failure.status === 409;
      setConflict(stale);
      setUncertain(!rejected);
      if (rejected) pendingCommand.current = null;
      setError(stale ? "The draft or its references changed. Reload and review before editing again. Your edit was not applied."
        : rejected ? failure.message
        : "The save outcome is unknown. Retry the same save to check its recorded result; do not start a second draft.");
    },
  });
  const view = edit?.baseline ?? query.data;
  // Pending drafts must never masquerade as the current rules. Editing alone
  // selects the captured draft baseline; normal viewing follows the active head.
  const model = edit ? view?.draftModel ?? (view ? verifiedActiveModel(view) : null)
    : view ? verifiedActiveModel(view) : null;
  const paths = edit?.paths ?? (model ? prefillPathsFromModel(model, 1).paths : []);
  const ladder = buildPackageLadder(view?.variants ?? [], paths);
  const issues = view ? packageConversionEditIssues(view) : [];
  const strategy = view?.product.legacyInventoryStrategy ?? inventoryStrategy;
  const busy = mutation.isPending || uncertain || conflict;
  const advancedUrl = `/inventory/supply-transformations?productId=${productId}`;
  const editDirection = (lowerVariantId: number, upperVariantId: number, direction: PackageDirection) => {
    if (!edit || !canEdit || busy) return;
    try {
      const next = updatePackageLadderDirection({ variants: edit.baseline.variants, paths: edit.paths,
        lowerVariantId, upperVariantId, direction, nextRowId: edit.nextRowId });
      setEdit({ ...edit, ...next }); setError(null); pendingCommand.current = null;
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not change that direction."); }
  };
  const save = () => {
    if (!edit || !canEdit || conflict || mutation.isPending) return;
    try {
      pendingCommand.current ??= buildPackageConversionCommand(edit, `catalog-conversions:${productId}:${crypto.randomUUID()}`);
      mutation.mutate(pendingCommand.current);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Review the conversion directions."); }
  };
  if (strategy === "physical_only") return null;
  return <div className="space-y-4">
    <Card data-testid="product-conversion-card">
      <CardHeader className="p-3 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><CardTitle className="flex items-center gap-2 text-base md:text-lg"><ArrowRightLeft className="h-4 w-4" />
            {STRATEGY_TITLES[strategy]}</CardTitle>
            <CardDescription className="mt-1">{strategy === "physical_fungible"
              ? "Choose how adjacent package sizes can convert. Quantities come from their units per variant."
              : strategy === "recipe_managed" ? "Recipes define what these SKUs produce or consume."
                : "This catalog strategy uses stocked SKUs independently."}</CardDescription>
          </div>
          <Button asChild variant="outline" size="sm"><Link href={advancedUrl}>Detailed rules</Link></Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-3 pt-0 md:p-6 md:pt-0">
        {query.isError && !edit ? <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Conversion rules could not be loaded. No editing is available.</p>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
        </div> : !view ? <p className="text-sm text-muted-foreground">Loading conversion rules…</p> : <>
          <ModelSummary view={view} editing={edit !== null} />
          {!edit && view.draftModel && <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">Draft changes available · Draft v{view.draftModel.version}</p>
            <p className="text-muted-foreground">The rules below have not been replaced by this draft.</p>
          </div>}
          {strategy === "physical_fungible" ? <>
            {ladder.issues.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
              {ladder.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
            {ladder.rows.length === 0 && ladder.issues.length === 0 && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              Add at least two active package sizes to configure a conversion.
            </p>}
            <div className="space-y-3">{ladder.rows.map(row => <section key={`${row.lower.id}:${row.upper.id}`}
              aria-label={`Conversion ${row.lower.sku ?? row.lower.name} to ${row.upper.sku ?? row.upper.name}`}
              className="rounded-md border p-3 md:p-4">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3">
                <div className="min-w-0"><p className="break-words font-mono text-sm font-semibold">{row.lower.sku ?? row.lower.name}</p>
                  <p className="text-xs text-muted-foreground">{row.lower.unitsPerVariant} units / package</p></div>
                <ArrowRightLeft className="mt-1 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 text-right"><p className="break-words font-mono text-sm font-semibold">{row.upper.sku ?? row.upper.name}</p>
                  <p className="text-xs text-muted-foreground">{row.upper.unitsPerVariant} units / package</p></div>
              </div>
              <p className="my-3 break-words text-sm font-medium">{row.equation}</p>
              {row.issue ? <p className="text-sm text-amber-800 dark:text-amber-300">{row.issue} Review in Detailed rules.</p>
                : !canEdit ? <Badge variant="secondary">{DIRECTIONS.find(direction => direction.value === row.direction)?.label}</Badge>
                : <fieldset disabled={!edit || busy}>
                  <legend className="sr-only">Allowed directions for {row.lower.sku ?? row.lower.name} and {row.upper.sku ?? row.upper.name}</legend>
                  <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1 sm:grid-cols-4">
                    {DIRECTIONS.map(direction => <label key={direction.value}
                      className={`relative flex min-h-10 cursor-pointer items-center justify-center rounded px-2 py-2 text-center text-xs font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${row.direction === direction.value ? "bg-background shadow-sm ring-1 ring-border" : "text-muted-foreground"}`}>
                      <input type="radio" className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default" name={`conversion-${productId}-${row.lower.id}-${row.upper.id}`}
                        value={direction.value} checked={row.direction === direction.value}
                        onChange={() => editDirection(row.lower.id, row.upper.id, direction.value)} />{direction.label}
                    </label>)}
                  </div>
                </fieldset>}
              <p className="mt-2 text-xs text-muted-foreground">
                Break down: {row.upper.sku ?? row.upper.name} → {row.lower.sku ?? row.lower.name}. Build up: {row.lower.sku ?? row.lower.name} → {row.upper.sku ?? row.upper.name}.
              </p>
            </section>)}</div>
            {ladder.unmanagedPaths.length > 0 && <p className="text-sm text-muted-foreground">
              {ladder.unmanagedPaths.length} additional path(s) remain unchanged. Review them in <Link className="underline" href={advancedUrl}>Detailed rules</Link>.
            </p>}
            {issues.length > 0 && <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">This model needs the detailed editor</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
            </div>}
            {!canEdit && <p className="text-sm text-muted-foreground">View only. Inventory planning edit permission is required to change directions.</p>}
            {canEdit && !edit && <Button variant="outline" disabled={issues.length > 0 || ladder.rows.length === 0 || query.isFetching}
              onClick={() => {
                if (!query.data) return;
                try { setEdit(beginPackageConversionEdit(query.data)); setMessage(null); setError(null); }
                catch (failure) { setError(failure instanceof Error ? failure.message : "Reload before editing."); }
              }}>{view.draftModel ? "Continue editing draft" : "Edit directions"}</Button>}
            {edit && <div className="space-y-3 border-t pt-4">
              <p className="text-xs text-muted-foreground">Save creates a draft only. Automatic audit note: {PACKAGE_CONVERSION_AUDIT_NOTE}</p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={save} disabled={!canEdit || mutation.isPending || conflict || !packageConversionHasChanges(edit)}>
                  {mutation.isPending ? "Saving…" : uncertain ? "Retry same save" : "Save draft"}</Button>
                <Button variant="outline" disabled={mutation.isPending || uncertain} onClick={async () => {
                  setEdit(null); setError(null); setConflict(false); pendingCommand.current = null;
                  await query.refetch();
                }}>{conflict ? "Reload and review" : "Cancel"}</Button>
              </div>
            </div>}
          </> : <p className="text-sm text-muted-foreground">Recipe relationships are shown below. Package paths and model approval remain available in Detailed rules.</p>}
        </>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {message && <p role="status" className="text-sm text-green-700 dark:text-green-300">{message}</p>}
      </CardContent>
    </Card>
    {strategy === "recipe_managed" && <ProductBuildRelationships productId={productId} enabled={enabled} />}
  </div>;
}
