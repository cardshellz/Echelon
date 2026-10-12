import type { ListingLifecycleView } from "@shared/types/channel-listing-lifecycle";
import type { ListingFeedRow } from "./feed-model";

export function listingTitle(
  row: ListingFeedRow,
  control?: ListingLifecycleView,
): string {
  return (
    row.draft?.title ??
    row.catalog?.name ??
    row.remote?.title ??
    control?.title ??
    row.sku ??
    `Variant ${row.draft?.variantId ?? row.operation?.item.variantId}`
  );
}

/** Current provider state wins over historical submission evidence. */
export function listingStatus(
  row: ListingFeedRow,
  control?: ListingLifecycleView,
): { label: string; tone: "good" | "attention" | "neutral" } {
  if (control) {
    if (control.state === "retired")
      return {
        label: control.action === "remove" ? "Removed" : "Unpublished",
        tone: "neutral",
      };
    return {
      label: control.state === "failed" ? "Unpublish failed" : "Unpublishing",
      tone: control.state === "failed" ? "attention" : "neutral",
    };
  }
  if (row.draft) return { label: "Draft", tone: "neutral" };
  if (row.remote) {
    const published = row.remote.publishedStatus.toUpperCase();
    const lifecycle = row.remote.lifecycleStatus.toUpperCase();
    if (published === "PUBLISHED" && lifecycle === "ACTIVE")
      return { label: "Active", tone: "good" };
    if (["RETIRED", "ARCHIVED"].includes(lifecycle))
      return { label: "Unpublished", tone: "neutral" };
    if (published === "UNPUBLISHED")
      return { label: "Unpublished", tone: "neutral" };
    if (
      published === "SYSTEM_PROBLEM" ||
      row.operation?.item.state.startsWith("needs_")
    )
      return { label: "Needs attention", tone: "attention" };
  }
  const state = row.operation?.item.state;
  if (state?.startsWith("needs_"))
    return { label: "Needs attention", tone: "attention" };
  if (state === "verified") return { label: "Last verified", tone: "neutral" };
  if (state) return { label: "Processing", tone: "neutral" };
  return { label: "Unknown", tone: "neutral" };
}

export function listingPrice(row: ListingFeedRow): {
  cents: number | null;
  source: "Draft" | "Walmart" | "Submitted" | "Unavailable";
} {
  if (row.draft)
    return {
      cents: row.draft.priceOverrideCents ?? row.catalog?.priceCents ?? null,
      source: "Draft",
    };
  if (row.remote?.priceCents != null)
    return { cents: row.remote.priceCents, source: "Walmart" };
  if (row.operation)
    return { cents: row.operation.item.priceCents, source: "Submitted" };
  return { cents: null, source: "Unavailable" };
}

/** Mixed selection never silently turns a local draft into a remote removal. */
export function lifecycleTargets(
  rows: readonly ListingFeedRow[],
  controls: ReadonlyMap<string, ListingLifecycleView>,
  action: "unpublish" | "remove",
) {
  return rows
    .filter(
      (row) =>
        !row.draft &&
        row.sku &&
        (row.remote || row.operation || controls.has(row.sku)),
    )
    .filter((row) =>
      action === "unpublish"
        ? !controls.has(row.sku!)
        : controls.get(row.sku!)?.action !== "remove",
    )
    .map((row) => ({
      sku: row.sku!,
      title: listingTitle(row, controls.get(row.sku!)),
      action,
    }));
}
