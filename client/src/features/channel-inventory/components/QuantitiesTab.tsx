import { Fragment, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

import { ChannelInventoryApiError, describeError, runAvailabilitySnapshot } from "../api";
import { describePackUnit, formatAbsoluteTime, formatRelativeTime, formatUnits, pluralize } from "../format";
import { PREVIEW_QUERY_KEY, useCommandKey, useQuantityPreview } from "../hooks";
import {
  POLICY_FIELDS,
  describeDestination,
  describeSourceScopeKey,
  describeWarehouseContributions,
  explainQuantity,
  type Channel,
  type Preview,
  type PreviewRow,
  type Target,
  type View,
} from "../model";
import { IdentityCell } from "./IdentityEditor";
import { ProductPicker } from "./ProductPicker";
import { PublicationStatus } from "./PublicationStatus";
import { Callout, SectionCard, SourceTag, StatePill } from "./primitives";
import { NoDestinationYet } from "./SupplyTab";

const NO_SNAPSHOT_CODE = "INVENTORY_CHANNEL_EXPOSURE_SHADOW_NOT_FOUND";

/** What quantity results for each SKU of a product at one destination, and why. */
export function QuantitiesTab({ view, channel, target, canEdit, productId, onProductChange, onAddDestination, onManagePublishing, onReload, reloading, now }: {
  view: View;
  channel: Channel;
  target: Target | null;
  canEdit: boolean;
  productId: number | null;
  onProductChange(productId: number): void;
  onAddDestination(): void;
  onManagePublishing(): void;
  onReload(): void;
  reloading: boolean;
  now: () => Date;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const command = useCommandKey();
  const preview = useQuantityPreview(target?.id ?? null, productId);
  const snapshot = useMutation({
    // The key is retained only until a run succeeds, so a retry after a lost
    // response replays the same run while the next click captures a new one.
    mutationFn: () => runAvailabilitySnapshot(productId!, command.keyFor(`snapshot:${productId}`)),
    onSuccess: async (run) => {
      command.clear();
      await queryClient.invalidateQueries({ queryKey: PREVIEW_QUERY_KEY });
      toast({
        title: run.status === "blocked" ? "Stock calculation needs attention" : "Stock calculation updated",
        description: "This updates the preview only. No marketplace quantities were changed.",
      });
    },
    onError: (error) => {
      const described = describeError(error);
      toast({ title: described.title, description: described.message, variant: "destructive" });
    },
  });

  if (!target) return <NoDestinationYet canEdit={canEdit} onAdd={onAddDestination} />;
  const identity = describeDestination(target, view);
  const noSnapshot = preview.error instanceof ChannelInventoryApiError && preview.error.code === NO_SNAPSHOT_CODE;
  const currentPreview = preview.error ? undefined : preview.data;

  return (
    <SectionCard
      title={`Stock preview for ${identity.title}`}
      description="See available stock and the quantity after your saved stock rules. This preview does not send an update."
      actions={canEdit && productId !== null ? (
        <Button type="button" variant="outline" size="sm" disabled={snapshot.isPending} onClick={() => snapshot.mutate()}>
          <RefreshCw className={cn("mr-1 h-3.5 w-3.5", snapshot.isPending && "animate-spin")} aria-hidden="true" />
          {snapshot.isPending ? "Calculating…" : "Recalculate stock"}
        </Button>
      ) : undefined}
    >
      {target.publicationAuthority === "echelon" && (target.state !== "live" || view.runtimeAuthority !== "canonical") && (
        <Callout title={view.runtimeAuthority === "canonical" ? "Automatic stock updates are off" : "These stock settings are not active"} action={(
          <Button type="button" size="sm" onClick={onManagePublishing}>Set up stock updates</Button>
        )}>
          {view.runtimeAuthority === "canonical"
            ? `Review the setup and next steps before Echelon can send quantities to ${channel.name}.`
            : "The existing inventory setup still controls stock updates. View the setup to see what is needed before these settings can take over."}
        </Callout>
      )}
      {target.publicationAuthority !== "echelon" && (
        <p className="text-sm text-muted-foreground">
          Stock for this account is managed {target.publicationAuthority === "manual" ? "manually" : "by another system"}.
          Echelon does not send stock updates for it.
        </p>
      )}
      <div className="max-w-lg space-y-1.5">
        <Label htmlFor="quantities-product">Product</Label>
        <ProductPicker id="quantities-product" products={view.products} value={productId} onChange={onProductChange} />
      </div>

      {productId === null && <Callout>Choose a product to see its SKU quantities.</Callout>}

      {productId !== null && preview.isLoading && (
        <div className="space-y-2" aria-busy="true" aria-label="Calculating quantities">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {productId !== null && noSnapshot && (
        <Callout
          title="Calculate stock for this product"
          action={canEdit ? (
            <Button type="button" size="sm" disabled={snapshot.isPending} onClick={() => snapshot.mutate()}>
              {snapshot.isPending ? "Calculating…" : "Calculate stock"}
            </Button>
          ) : undefined}
        >
          There is no stock calculation to preview yet. Calculate it using the selected warehouses and saved rules.
        </Callout>
      )}

      {productId !== null && preview.error && !noSnapshot && (
        <Callout tone="danger" title="Stock preview unavailable" action={(
          <Button type="button" variant="outline" size="sm" disabled={preview.isFetching} onClick={() => { void preview.refetch(); }}>Try again</Button>
        )}>
          <p>The stock calculation could not be loaded.</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-medium">Technical details</summary>
            <p className="mt-2 break-words text-xs">{describeError(preview.error).message}</p>
          </details>
        </Callout>
      )}

      {currentPreview && (
        <PreviewTable
          view={view}
          channel={channel}
          target={target}
          preview={currentPreview}
          canEdit={canEdit}
          onReload={onReload}
          reloading={reloading}
          now={now}
        />
      )}
      {productId !== null && <PublicationStatus key={`${target.id}:${productId}`} target={target} productId={productId} view={view} />}
    </SectionCard>
  );
}

function PreviewTable({ view, channel, target, preview, canEdit, onReload, reloading, now }: {
  view: View;
  channel: Channel;
  target: Target;
  preview: Preview;
  canEdit: boolean;
  onReload(): void;
  reloading: boolean;
  now: () => Date;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const mobile = useIsMobile();
  const draftPolicies = preview.selectedPolicies.filter((policy) => policy.authority === "draft").length;
  const provider = describeDestination(target, view).provider;
  const usesDraft = preview.sourceBindingAuthority === "draft" || draftPolicies > 0
    || preview.rows.some((row) => row.mapping?.authority === "draft");
  const issues = describePreviewIssues(preview);
  const emptyPreview = describeEmptyPreview(preview);
  const hasSupply = preview.sourceBindingAuthority !== "missing";
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Stock captured <time dateTime={preview.shadowCapturedAt} title={formatAbsoluteTime(preview.shadowCapturedAt)}>{formatRelativeTime(preview.shadowCapturedAt, now())}</time>.
        {" "}{preview.publicationAuthority !== "echelon" ? "Stock is managed outside this setup."
          : !hasSupply ? "Supply warehouses have not been selected."
          : usesDraft ? "Includes saved changes that are not applied yet." : "Uses applied settings."}
      </p>

      {preview.hold && (
        <Callout title="Stock is held at zero">
          This preview includes the hold. Reason: {preview.hold.reason}.
        </Callout>
      )}

      {issues.length > 0 && (
        <Callout tone="warning" title="Stock setup needs attention">
          <ul className="list-disc space-y-1 pl-4">
            {issues.map((message) => <li key={message}>{message}</li>)}
          </ul>
        </Callout>
      )}

      {preview.rows.length === 0 ? (
        <div className="rounded-md border bg-muted/20 p-4">
          <p className="text-sm font-medium">{emptyPreview.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{emptyPreview.description}</p>
        </div>
      ) : mobile ? (
        <div className="space-y-3">{preview.rows.map(row => {
          const isOpen = expanded === row.productVariantId;
          return <article key={row.productVariantId} className="overflow-hidden rounded-lg border" aria-label={`${row.sku ?? row.productVariantId} stock preview`}>
            <div className="space-y-3 p-4">
              <div><p className="break-all font-medium">{row.sku ?? `SKU #${row.productVariantId}`}</p>
                <p className="text-xs text-muted-foreground">{describePackUnit(row.unitsPerVariant)}</p></div>
              <dl className="grid grid-cols-2 gap-3">
                <div><dt className="text-xs text-muted-foreground">Available stock</dt><dd className="text-lg tabular-nums">{hasSupply ? formatUnits(row.canonicalAtpUnits) : "Not calculated"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">After stock rules</dt><dd className="text-lg font-semibold tabular-nums">{hasSupply && row.policy ? formatUnits(row.publishedUnits) : "Not calculated"}</dd></div>
              </dl>
              {!row.policy && <StatePill tone="blocked">Complete stock rules</StatePill>}
              {row.hold && <StatePill tone="held">Held at zero</StatePill>}
              <IdentityCell view={view} target={target}
                variant={{ id: row.productVariantId, sku: row.sku, name: row.sku ?? `SKU #${row.productVariantId}` }}
                provider={provider} canEdit={canEdit} onReload={onReload} reloading={reloading} />
              <Button type="button" size="sm" variant="outline" aria-expanded={isOpen} aria-label={`Explain ${row.sku ?? row.productVariantId}`}
                onClick={() => setExpanded(isOpen ? null : row.productVariantId)}>
                {isOpen ? "Hide calculation" : "Explain quantity"}<ChevronDown className={cn("ml-2 h-4 w-4", isOpen && "rotate-180")} aria-hidden="true" />
              </Button>
            </div>
            {isOpen && <div className="border-t bg-muted/30"><RowExplanation row={row} view={view} hasSupply={hasSupply} explanation={explainQuantity(row)} /></div>}
          </article>;
        })}</div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Available stock</TableHead>
                <TableHead className="text-right">After stock rules</TableHead>
                <TableHead>Listing at {channel.name}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.rows.map((row) => {
                const explanation = explainQuantity(row);
                const isOpen = expanded === row.productVariantId;
                return (
                  <Fragment key={row.productVariantId}>
                    <TableRow className={cn("cursor-pointer", isOpen && "bg-accent/40")} onClick={() => setExpanded(isOpen ? null : row.productVariantId)}>
                      <TableCell>
                        <button type="button" aria-expanded={isOpen} aria-label={`Explain ${row.sku ?? row.productVariantId}`} className="rounded p-0.5 hover:bg-accent">
                          <ChevronDown className={cn("h-4 w-4 transition-transform", isOpen && "rotate-180")} aria-hidden="true" />
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{row.sku ?? `SKU #${row.productVariantId}`}</div>
                        <div className="text-xs text-muted-foreground">{describePackUnit(row.unitsPerVariant)}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{hasSupply ? formatUnits(row.canonicalAtpUnits) : "Not calculated"}</TableCell>
                      <TableCell className="text-right">
                        <span className="text-base font-semibold tabular-nums">{hasSupply && row.policy ? formatUnits(row.publishedUnits) : "Not calculated"}</span>
                        {!row.policy && <div><StatePill tone="blocked">Complete stock rules</StatePill></div>}
                        {row.hold && <div><StatePill tone="held">Held at zero</StatePill></div>}
                      </TableCell>
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <IdentityCell
                          view={view}
                          target={target}
                          variant={{ id: row.productVariantId, sku: row.sku, name: row.sku ?? `SKU #${row.productVariantId}` }}
                          provider={provider}
                          canEdit={canEdit}
                          onReload={onReload}
                          reloading={reloading}
                        />
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={5} className="p-0">
                          <RowExplanation row={row} view={view} hasSupply={hasSupply} explanation={explanation} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <details className="rounded-md border px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">Technical details</summary>
        <div className="mt-3 space-y-3 text-muted-foreground">
          <p>Stock captured {formatAbsoluteTime(preview.shadowCapturedAt)}. {pluralize(preview.warehouseIds.length, "selected warehouse")}.
            {" "}Warehouse settings: {preview.sourceBindingAuthority}. {pluralize(preview.selectedPolicies.length, "saved rule")}; {draftPolicies} not applied.</p>
          {preview.membership && <p>SKU selection: {preview.membership.mode === "explicit"
            ? `${preview.membership.includedVariantIds.length} selected for this product`
            : "All eligible SKUs in this product"}.</p>}
          {preview.hold && <p>Hold entered by {preview.hold.heldBy} on {formatAbsoluteTime(preview.hold.heldAt)}.</p>}
          {preview.blockers.length > 0 && <ul className="space-y-2">
            {preview.blockers.map((blocker) => (
              <li key={`${blocker.code}:${JSON.stringify(blocker.context)}`} className="break-words">
                <span className="font-mono">{blocker.code}</span>: {blocker.message}
              </li>
            ))}
          </ul>}
        </div>
      </details>
    </div>
  );
}

function RowExplanation({ row, view, hasSupply, explanation }: { row: PreviewRow; view: View; hasSupply: boolean; explanation: ReturnType<typeof explainQuantity> }) {
  const contributions = describeWarehouseContributions(row, view.fulfillmentNodes);
  return (
    <div className="grid gap-4 p-4 md:grid-cols-3">
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Calculation</p>
        {!hasSupply ? <p className="text-sm text-muted-foreground">Choose supply warehouses before calculating this SKU.</p> : <ol className="space-y-1.5 text-sm">
          {explanation.steps.map((step, index) => (
            <li key={step.label} className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{index === 0 ? "" : "→ "}{step.label}</span>
              <span className="tabular-nums font-medium">{formatUnits(step.units)}</span>
            </li>
          ))}
        </ol>}
        {hasSupply && explanation.zeroReason && <p className="text-xs text-amber-700 dark:text-amber-300">{explanation.zeroReason}</p>}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Where the stock is</p>
        {contributions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No eligible warehouse contributed availability.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {contributions.map((entry) => (
              <li key={entry.label} className="flex items-baseline justify-between gap-3">
                <span>{entry.label}</span>
                <span className="tabular-nums">{formatUnits(entry.units)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Which rule set each field</p>
        {row.policy ? (
          <ul className="space-y-1 text-sm">
            {POLICY_FIELDS.map((field) => (
              <li key={field.key} className="flex items-baseline justify-between gap-3">
                <span>{field.label}</span>
                <SourceTag kind={describeSourceScopeKey(row.policy!.sources[field.sourceKey])} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            A required field is not set by any rule for this SKU, so no quantity can be proposed.
          </p>
        )}
      </div>
    </div>
  );
}

/** Explain only conditions the preview explicitly reports; keep raw errors available below. */
function describePreviewIssues(preview: Preview): string[] {
  const labels: Readonly<Record<string, string>> = {
    CHANNEL_EXPOSURE_POLICY_INCOMPLETE: "Complete the stock rules for the affected SKUs.",
    PUBLICATION_TARGET_VARIANT_MAPPING_MISSING: "Link the affected SKUs to their channel listings below.",
    CHANNEL_SOURCE_BINDING_MISSING: "Choose the warehouses that supply this account.",
    CHANNEL_SOURCE_WAREHOUSE_MISSING_FROM_SHADOW: "Some selected warehouses are missing from this stock calculation. Recalculate stock after checking the warehouse selection.",
    CHANNEL_SOURCE_OVERRIDE_UNAVAILABLE: "A product or SKU uses a warehouse that is unavailable in this stock calculation.",
    PUBLICATION_MEMBER_VARIANT_UNAVAILABLE: "A selected SKU is no longer available for stock updates. Check its catalog status and listing selection.",
    CHANNEL_EXPOSURE_SKU_MISSING_FROM_SHADOW: "Some selected SKUs are missing from this stock calculation. Recalculate stock to check them again.",
    SHADOW_MODEL_STALE: "The product setup changed after this stock calculation. Recalculate stock to use the latest setup.",
    CANONICAL_SHADOW_BLOCKED: "The latest stock calculation did not complete successfully. Check the inventory issue in Technical details.",
  };
  const messages = new Set<string>();
  for (const blocker of preview.blockers) {
    // The account status and setup action already explain this state above.
    if (blocker.code === "PUBLICATION_TARGET_NOT_IN_PREVIEW") continue;
    messages.add(labels[blocker.code] ?? "Another inventory check failed. Open Technical details for the returned error.");
  }
  return [...messages];
}

function describeEmptyPreview(preview: Preview): { title: string; description: string } {
  if (preview.publicationAuthority !== "echelon") {
    return {
      title: "Stock is managed outside Echelon",
      description: "This account does not use Echelon's calculated stock quantities.",
    };
  }
  if (preview.membership?.mode === "explicit" && preview.membership.includedVariantIds.length === 0) {
    return {
      title: "No SKUs selected for stock updates",
      description: "This preview includes only SKUs selected for this account. None are selected for this product yet.",
    };
  }
  if (preview.blockers.some((blocker) => blocker.code !== "PUBLICATION_TARGET_NOT_IN_PREVIEW")) {
    return {
      title: "Stock could not be calculated",
      description: "Resolve the setup issues above, then recalculate stock.",
    };
  }
  if (preview.membership?.mode === "whole_product") {
    return {
      title: "No eligible SKUs to preview",
      description: "This product has no active, sellable SKUs that ship and track inventory.",
    };
  }
  return {
    title: "No stock quantities returned",
    description: "No SKU quantities are available for this product in the current preview.",
  };
}
