import { Fragment, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
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
import { Callout, EvidenceNote, SectionCard, SourceTag, StatePill } from "./primitives";
import { NoDestinationYet } from "./SupplyTab";

const NO_SNAPSHOT_CODE = "INVENTORY_CHANNEL_EXPOSURE_SHADOW_NOT_FOUND";

/** What quantity results for each SKU of a product at one destination, and why. */
export function QuantitiesTab({ view, channel, target, canEdit, productId, onProductChange, onAddDestination, onReload, reloading, now }: {
  view: View;
  channel: Channel;
  target: Target | null;
  canEdit: boolean;
  productId: number | null;
  onProductChange(productId: number): void;
  onAddDestination(): void;
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
        title: run.status === "blocked" ? "Snapshot captured with blockers" : "Availability snapshot captured",
        description: "Calculated only. No quantity was sent to any provider.",
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

  return (
    <SectionCard
      title={`Quantities for ${identity.title}`}
      description="Each SKU's proposed quantity from the saved rules and the latest availability snapshot. Proposed is what would be sent; it is not what the marketplace currently shows."
      actions={canEdit && productId !== null ? (
        <Button type="button" variant="outline" size="sm" disabled={snapshot.isPending} onClick={() => snapshot.mutate()}>
          <RefreshCw className={cn("mr-1 h-3.5 w-3.5", snapshot.isPending && "animate-spin")} aria-hidden="true" />
          {snapshot.isPending ? "Calculating…" : "Refresh availability"}
        </Button>
      ) : undefined}
    >
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
          title="No availability snapshot for this product yet"
          action={canEdit ? (
            <Button type="button" size="sm" disabled={snapshot.isPending} onClick={() => snapshot.mutate()}>
              {snapshot.isPending ? "Calculating…" : "Calculate availability"}
            </Button>
          ) : undefined}
        >
          Quantities are calculated from a captured availability snapshot. Capture one to see what
          these rules would propose; nothing is sent to the provider.
        </Callout>
      )}

      {productId !== null && preview.error && !noSnapshot && (
        <Callout tone="danger" title={describeError(preview.error).title}>{describeError(preview.error).message}</Callout>
      )}

      {preview.data && (
        <PreviewTable
          view={view}
          channel={channel}
          target={target}
          preview={preview.data}
          canEdit={canEdit}
          onReload={onReload}
          reloading={reloading}
          now={now}
        />
      )}
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
  const draftPolicies = preview.selectedPolicies.filter((policy) => policy.authority === "draft").length;
  const provider = describeDestination(target, view).provider;
  return (
    <div className="space-y-3">
      <EvidenceNote>
        Availability snapshot captured {formatRelativeTime(preview.shadowCapturedAt, now())} ({formatAbsoluteTime(preview.shadowCapturedAt)}).
        {" "}Supply: {preview.sourceBindingAuthority === "missing" ? "not configured" : `${preview.sourceBindingAuthority === "draft" ? "saved draft" : "active"} (${pluralize(preview.warehouseIds.length, "warehouse")})`}.
        {" "}Rules: {pluralize(preview.selectedPolicies.length, "saved definition")}{draftPolicies > 0 ? `, ${draftPolicies} pending activation` : ""}.
        {" "}No quantity was sent to the provider.
      </EvidenceNote>

      {preview.hold && (
        <Callout tone="warning" title="Held at zero">
          Every quantity this destination publishes is zero while the hold stands.
          {" "}Held by {preview.hold.heldBy}: {preview.hold.reason}. The canonical ATP below is what would publish once released.
        </Callout>
      )}

      {preview.blockers.length > 0 && (
        <Callout tone="warning" title={`${pluralize(preview.blockers.length, "blocker")} in the availability snapshot`}>
          <ul className="list-disc space-y-1 pl-4">
            {preview.blockers.map((blocker) => (
              <li key={`${blocker.code}:${JSON.stringify(blocker.context)}`}>
                <span className="font-mono text-xs">{blocker.code}</span> — {blocker.message}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {preview.rows.length === 0 ? (
        <Callout>This product has no sellable, tracked SKUs to calculate.</Callout>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">After offer</TableHead>
                <TableHead className="text-right">After keep back</TableHead>
                <TableHead className="text-right">After maximum</TableHead>
                <TableHead className="text-right">Proposed</TableHead>
                <TableHead>Identity at {channel.name}</TableHead>
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
                      <TableCell className="text-right tabular-nums">{formatUnits(row.canonicalAtpUnits)}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.policy ? formatUnits(row.sharedUnits) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.policy ? formatUnits(row.afterHoldbackUnits) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.policy ? formatUnits(row.cappedUnits) : "—"}</TableCell>
                      <TableCell className="text-right">
                        <span className="text-base font-semibold tabular-nums">{formatUnits(row.publishedUnits)}</span>
                        {!row.policy && <div><StatePill tone="blocked">No complete rule</StatePill></div>}
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
                        <TableCell colSpan={8} className="p-0">
                          <RowExplanation row={row} view={view} explanation={explanation} />
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
      <EvidenceNote>
        Available counts only the warehouses chosen for this destination. Provider acknowledgements
        and read-back quantities are not shown on this page yet; use the sync log for delivery history.
      </EvidenceNote>
    </div>
  );
}

function RowExplanation({ row, view, explanation }: { row: PreviewRow; view: View; explanation: ReturnType<typeof explainQuantity> }) {
  const contributions = describeWarehouseContributions(row, view.fulfillmentNodes);
  return (
    <div className="grid gap-4 p-4 md:grid-cols-3">
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Calculation</p>
        <ol className="space-y-1.5 text-sm">
          {explanation.steps.map((step, index) => (
            <li key={step.label} className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{index === 0 ? "" : "→ "}{step.label}</span>
              <span className="tabular-nums font-medium">{formatUnits(step.units)}</span>
            </li>
          ))}
        </ol>
        {explanation.zeroReason && <p className="text-xs text-amber-700 dark:text-amber-300">{explanation.zeroReason}</p>}
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
