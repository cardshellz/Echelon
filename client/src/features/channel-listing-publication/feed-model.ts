import type { ChannelCatalogRow } from "@shared/types/channel-catalog";
import type {
  ListingCatalogItem,
  ListingDraftItem,
  ListingOperation,
  ListingOperationItem,
} from "@shared/types/channel-listing-publication";

export interface ListingFeedRow {
  key: string;
  sku: string | null;
  draft: ListingDraftItem | null;
  catalog: ListingCatalogItem | null;
  remote: ChannelCatalogRow | null;
  operation: { id: string; item: ListingOperationItem } | null;
  issue: string | null;
}

export interface ListingFeedInput {
  draftItems: readonly ListingDraftItem[];
  metadata: ReadonlyMap<number, ListingCatalogItem>;
  operations: readonly ListingOperation[];
  catalogItems: readonly ChannelCatalogRow[];
  sku: string;
}

/** Join exact seller identities only. Local drafts and recent submissions remain
 * visible across account pages; a remote variant match is merely a suggestion. */
export function buildListingFeedRows(
  input: ListingFeedInput,
): ListingFeedRow[] {
  const remoteBySku = new Map<string, ChannelCatalogRow>();
  const duplicateRemoteSkus = new Set<string>();
  for (const item of input.catalogItems) {
    if (remoteBySku.has(item.sku)) duplicateRemoteSkus.add(item.sku);
    else remoteBySku.set(item.sku, item);
  }

  const operationBySku = new Map<
    string,
    NonNullable<ListingFeedRow["operation"]>
  >();
  // Copy before sorting: operation order belongs to the caller. Invalid dates
  // sort last with the same stable ID tie-break, without consulting wall time.
  for (const operation of [...input.operations].sort(newestFirst))
    for (const item of operation.items)
      if (!operationBySku.has(item.sku))
        operationBySku.set(item.sku, { id: operation.id, item });

  const rows: ListingFeedRow[] = input.draftItems.map((draft) => {
    const metadata = input.metadata.get(draft.variantId);
    const catalog = metadata?.variantId === draft.variantId ? metadata : null;
    // Empty or unavailable metadata cannot establish a remote SKU identity.
    const sku = catalog?.sku.trim() ? catalog.sku : null;
    return {
      key: `variant:${draft.variantId}`,
      sku,
      draft,
      catalog,
      remote: sku === null ? null : (remoteBySku.get(sku) ?? null),
      operation: sku === null ? null : (operationBySku.get(sku) ?? null),
      issue: null,
    };
  });
  const draftCountBySku = new Map<string, number>();
  for (const row of rows)
    if (row.sku !== null)
      draftCountBySku.set(row.sku, (draftCountBySku.get(row.sku) ?? 0) + 1);

  const representedSkus = new Set(draftCountBySku.keys());
  for (const [sku, operation] of operationBySku) {
    if (representedSkus.has(sku)) continue;
    rows.push({
      key: `sku:${sku}`,
      sku,
      draft: null,
      catalog: null,
      remote: remoteBySku.get(sku) ?? null,
      operation,
      issue: null,
    });
    representedSkus.add(sku);
  }
  for (const [sku, remote] of remoteBySku) {
    if (representedSkus.has(sku)) continue;
    rows.push({
      key: `sku:${sku}`,
      sku,
      draft: null,
      catalog: null,
      remote,
      operation: null,
      issue: null,
    });
  }

  const exactSku = input.sku.trim();
  return rows
    .filter((row) => exactSku === "" || row.sku === exactSku)
    .map((row) => ({
      ...row,
      issue: rowIssue(row, draftCountBySku, duplicateRemoteSkus),
    }));
}

function newestFirst(left: ListingOperation, right: ListingOperation): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const timestampOrder =
    (Number.isFinite(rightTime) ? rightTime : -Infinity) -
    (Number.isFinite(leftTime) ? leftTime : -Infinity);
  if (timestampOrder) return timestampOrder;
  return left.id === right.id ? 0 : left.id < right.id ? 1 : -1;
}

function rowIssue(
  row: ListingFeedRow,
  draftCountBySku: ReadonlyMap<string, number>,
  duplicateRemoteSkus: ReadonlySet<string>,
): string | null {
  if (row.sku === null)
    return "This draft's SKU is unavailable. Reload its catalog details before publishing.";
  if ((draftCountBySku.get(row.sku) ?? 0) > 1)
    return "Multiple draft variants share this SKU. Resolve the conflicting identity before publishing.";
  if (duplicateRemoteSkus.has(row.sku))
    return "The account page contains duplicate records for this SKU. Refresh and resolve the listing identity.";
  if (
    row.draft &&
    row.operation &&
    row.draft.variantId !== row.operation.item.variantId
  )
    return "This SKU was submitted for a different Echelon variant. Resolve the conflicting identity before publishing.";
  const variantId = row.draft?.variantId ?? row.operation?.item.variantId;
  if (
    variantId !== undefined &&
    row.remote?.mappingStatus === "linked" &&
    row.remote.variant &&
    row.remote.variant.id !== variantId
  )
    return "This SKU is linked to a different Echelon variant. Resolve the conflicting identity before publishing.";
  if (row.remote?.mappingStatus === "conflict")
    return (
      row.remote.message ?? "This listing has a conflicting Echelon identity."
    );
  if (row.draft && (row.remote || row.catalog?.alreadyLinked))
    return "This SKU already has a listing. Remove it from the new-listing draft and manage the existing listing.";
  return null;
}
