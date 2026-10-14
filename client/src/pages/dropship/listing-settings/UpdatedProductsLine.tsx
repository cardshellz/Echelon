import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  updatedProductsLine,
  updatedProductsLineQueryOptions,
  type UpdatedProductsLine as UpdatedProductsLineModel,
  type UpdatedProductsSummaryFacts,
} from "@/lib/dropship-listing-settings-updated";
import { useReportListTooLarge } from "./ProductsTab";

export interface UpdatedProductsLineProps {
  storeConnectionId: number;
  /** The step's summary read: the line's read is off while the selection is too large (D18). */
  summary: UpdatedProductsSummaryFacts;
  /** [Review]: the step puts "Card Shellz updated products" in the address (`?sheet=updated`, D21). */
  onOpen: () => void;
  /** The read refused as too large before the summary says so: the step shows the banner (D18). */
  onTooLarge?: (error: unknown) => void;
}

/**
 * "Card Shellz moved 4 products to another category." [Review] (Listing
 * settings PR 10g, plan 10.2, UX-M10): one line under the attention strip,
 * from the first page of the updated-products read made when the step mounts
 * (a list read, at most 60 seconds old). It shows only when that page counts
 * a move; a read still loading or failed shows nothing and no banner (UX-M9),
 * and a selection too large to check makes no read at all and shows no
 * earlier answer (D18). It never sits in
 * a Category card, so it needs none (10e).
 */
export function UpdatedProductsLine({ storeConnectionId, summary, onOpen, onTooLarge }: UpdatedProductsLineProps) {
  const read = useQuery(updatedProductsLineQueryOptions(storeConnectionId, summary));
  useReportListTooLarge(read.error, onTooLarge);
  const line = updatedProductsLine({ data: read.data, error: read.error }, summary);
  if (line === null) return null;
  return <UpdatedProductsLineView line={line} onOpen={onOpen} />;
}

/** The line as drawn (hook-free, so a test can press its button). */
export function UpdatedProductsLineView({ line, onOpen }: { line: UpdatedProductsLineModel; onOpen: () => void }) {
  return (
    <div
      data-testid="updated-products-line"
      className="mt-3 flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-800 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="flex min-w-0 items-start gap-2">
        <span aria-hidden="true" className="leading-5 text-amber-600">●</span>
        <span className="min-w-0 break-words">{line.text}</span>
      </p>
      <Button type="button" size="sm" variant="outline" className="min-h-11 shrink-0 self-start sm:min-h-8 sm:self-auto" onClick={onOpen}>
        {line.label}
      </Button>
    </div>
  );
}
