import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { describeError } from "../api";
import { formatAbsoluteTime } from "../format";
import { SALES_STATUS_QUERY_ROOT, fetchStoppedSalesStatuses } from "../sales-status-api";
import type { ExceptionSubject } from "./ExceptionSheet";
import { Callout, SectionCard, StatePill } from "./primitives";

/**
 * Read-only: every product and SKU a sales status stops, on all channels or
 * on one, newest first. Opening one shows its sales status, where it can be
 * resumed. Lists stops only; a "Selling" exception is not a stop.
 */
export function StoppedSalesCard({ onOpen }: { onOpen(subject: ExceptionSubject): void }) {
  const query = useQuery({
    queryKey: [...SALES_STATUS_QUERY_ROOT, "stopped"],
    queryFn: ({ signal }) => fetchStoppedSalesStatuses(signal),
    retry: false,
  });
  return (
    <SectionCard
      title="Stopped from selling"
      description="Products and SKUs whose sales status is Stopped, on every channel or on one. They send 0 and keep their listings."
    >
      {query.isLoading ? <Skeleton className="h-12 w-full" />
        : !query.data ? (
          <Callout tone="danger" title="Stopped items could not be loaded"
            action={<Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>}>
            {describeError(query.error).message}
          </Callout>
        ) : query.data.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is stopped.</p>
        ) : (
          <>
            <ul className="divide-y rounded-md border" aria-label="Stopped from selling">
              {query.data.entries.map(({ entry, productName, productSku, variantSku, channelName }) => (
                <li key={entry.scopeKey} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                  <span className="min-w-[12rem] flex-1">
                    <span className="block truncate text-sm font-medium">{productName}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      <span className="font-mono-sku">{variantSku ?? productSku ?? `Product #${entry.scope.productId}`}</span>
                      {variantSku ? "" : " · whole product"} · since {formatAbsoluteTime(entry.updatedAt)} by {entry.updatedBy}
                      {entry.note ? ` · ${entry.note}` : ""}
                    </span>
                  </span>
                  <StatePill tone="blocked">{channelName ? `Stopped on ${channelName}` : "Stopped everywhere"}</StatePill>
                  <Button type="button" size="sm" variant="outline"
                    aria-label={`Open sales status for ${variantSku ?? productName}`}
                    onClick={() => onOpen({ productId: entry.scope.productId, productVariantId: entry.scope.productVariantId })}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
            {query.data.truncated && <p className="text-xs text-muted-foreground">Showing the most recent stops only.</p>}
          </>
        )}
    </SectionCard>
  );
}
