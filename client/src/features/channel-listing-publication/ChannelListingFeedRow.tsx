import type { ChannelCatalogRow } from "@shared/types/channel-catalog";
import type { ListingOperationItem } from "@shared/types/channel-listing-publication";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { ListingFeedRow } from "./feed-model";
import { money, priceSourceLabel } from "./model";

const mappingLabels: Record<ChannelCatalogRow["mappingStatus"], string> = {
  linked: "Linked",
  matched: "Exact SKU match",
  unmatched: "Needs match",
  conflict: "Conflict",
  unavailable: "Unavailable",
};
const submissionLabels: Record<ListingOperationItem["state"], string> = {
  queued: "Queued",
  processing: "Processing",
  accepted: "Accepted · verification pending",
  verified: "Item verified",
  needs_attention: "Needs attention",
  needs_reconciliation: "Outcome needs verification",
};

export function ChannelListingFeedRow({
  row,
  canEdit,
  locked,
  selected,
  selectable,
  onSelect,
  onEdit,
  onRemove,
  onMatch,
  onActivity,
}: {
  row: ListingFeedRow;
  canEdit: boolean;
  locked: boolean;
  selected: boolean;
  selectable: boolean;
  onSelect(checked: boolean): void;
  onEdit(variantId: number): void;
  onRemove(variantId: number): void;
  onMatch(item: ChannelCatalogRow): void;
  onActivity(): void;
}) {
  const { draft, catalog, remote, operation } = row;
  const variantId = draft?.variantId ?? operation?.item.variantId;
  const title =
    draft?.title ??
    catalog?.name ??
    remote?.title ??
    row.sku ??
    `Variant ${variantId}`;
  const localVariantName =
    catalog?.variantName ??
    (remote?.variant && remote.variant.id === variantId
      ? remote.variant.name
      : `Variant ${variantId}`);
  const showRemoteVariant =
    remote?.variant &&
    (variantId === undefined ||
      remote.variant.id !== variantId ||
      remote.mappingStatus !== "linked");
  return (
    <TableRow className="align-top">
      {canEdit && (
        <TableCell className="pt-4">
          <input
            type="checkbox"
            aria-label={`Select ${row.sku ?? `variant ${variantId}`}`}
            checked={selected}
            disabled={!selectable || locked}
            onChange={(event) => onSelect(event.target.checked)}
          />
        </TableCell>
      )}
      <TableCell className="min-w-44 max-w-72">
        <p className="break-words font-medium">{title}</p>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {row.sku ?? "SKU unavailable"}
        </p>
        {catalog && (
          <p className="mt-1 text-xs text-muted-foreground">
            {catalog.variantName} · {catalog.unitLabel}
          </p>
        )}
        {draft && (
          <p className="mt-2 text-xs text-muted-foreground">
            {draft.productType || "Choose product type"} ·{" "}
            {draft.method === "match" ? "Catalog match" : "Create product"}
          </p>
        )}
      </TableCell>
      <TableCell className="min-w-44 max-w-72 space-y-2">
        {draft && <Badge variant="secondary">Draft · review required</Badge>}
        {remote && (
          <div>
            <Badge variant="outline">{remote.publishedStatus}</Badge>
            <p className="mt-1 text-xs text-muted-foreground">
              Account listing · {remote.lifecycleStatus}
            </p>
          </div>
        )}
        {operation && (
          <div>
            <Badge
              variant={
                operation.item.state.startsWith("needs_")
                  ? "destructive"
                  : "outline"
              }
            >
              {submissionLabels[operation.item.state]}
            </Badge>
            <p className="mt-1 text-xs text-muted-foreground">
              Latest submission outcome
            </p>
            {operation.item.error && (
              <p className="mt-1 break-words text-xs text-destructive">
                {operation.item.error}
              </p>
            )}
          </div>
        )}
        {row.issue && (
          <p className="break-words text-xs text-destructive">{row.issue}</p>
        )}
      </TableCell>
      <TableCell className="min-w-40 max-w-64">
        {variantId !== undefined && (
          <div>
            <p className="text-xs text-muted-foreground">
              {draft ? "Draft variant" : "Submitted variant"}
            </p>
            <p className="break-words">{localVariantName}</p>
          </div>
        )}
        {showRemoteVariant && remote.variant && (
          <div className={variantId !== undefined ? "mt-2" : ""}>
            <p className="text-xs text-muted-foreground">
              {remote.mappingStatus === "linked"
                ? "Linked variant"
                : remote.mappingStatus === "matched"
                  ? "Suggested variant"
                  : "Reported variant"}
            </p>
            <p className="break-words">{remote.variant.name}</p>
            <p className="break-all font-mono text-xs text-muted-foreground">
              {remote.variant.sku}
            </p>
          </div>
        )}
        {variantId === undefined && !remote?.variant && (
          <span className="text-muted-foreground">No match</span>
        )}
        {remote && (
          <>
            <Badge
              className="mt-2"
              variant={
                remote.mappingStatus === "conflict"
                  ? "destructive"
                  : remote.mappingStatus === "linked"
                    ? "default"
                    : "secondary"
              }
            >
              {mappingLabels[remote.mappingStatus]}
            </Badge>
            {remote.mappingStatus === "matched" && (
              <p className="mt-1 text-xs text-muted-foreground">
                Suggested variant · not linked
              </p>
            )}
            {remote.message && remote.message !== row.issue && (
              <p className="mt-1 break-words text-xs">{remote.message}</p>
            )}
          </>
        )}
        {draft && !catalog && (
          <p className="mt-1 text-xs text-muted-foreground">
            Catalog details unavailable
          </p>
        )}
      </TableCell>
      <TableCell className="min-w-36 space-y-2">
        {draft && (
          <div>
            <p className="font-medium">
              {money(draft.priceOverrideCents ?? catalog?.priceCents ?? null)}
            </p>
            <p className="text-xs text-muted-foreground">
              Draft price ·{" "}
              {draft.priceOverrideCents !== null
                ? "Fixed item price"
                : priceSourceLabel(catalog?.priceSource)}
            </p>
          </div>
        )}
        {operation && (
          <div>
            <p>{money(operation.item.priceCents)}</p>
            <p className="text-xs text-muted-foreground">Submitted price</p>
          </div>
        )}
        {!draft && !operation && (
          <p className="text-xs text-muted-foreground">
            Account price unavailable
          </p>
        )}
      </TableCell>
      <TableCell>
        <div className="flex min-w-28 flex-col items-start gap-2">
          {draft && (
            <Button
              variant="outline"
              size="sm"
              disabled={locked}
              aria-label={`${canEdit ? "Edit" : "View"} ${row.sku ?? `variant ${draft.variantId}`}`}
              onClick={() => onEdit(draft.variantId)}
            >
              {canEdit ? "Edit details" : "View details"}
            </Button>
          )}
          {draft && canEdit && (
            <Button
              variant="ghost"
              size="sm"
              disabled={locked}
              aria-label={`Remove ${row.sku ?? `variant ${draft.variantId}`} from draft`}
              onClick={() => onRemove(draft.variantId)}
            >
              Remove
            </Button>
          )}
          {remote &&
            canEdit &&
            !row.issue &&
            ["matched", "unmatched"].includes(remote.mappingStatus) && (
              <Button
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() => onMatch(remote)}
              >
                Choose variant
              </Button>
            )}
          {operation && (
            <Button
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={onActivity}
            >
              View activity
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
