import { useInfiniteQuery } from "@tanstack/react-query";
import { poAmendmentHistorySchema } from "@shared/procurement/po-quantity-amendment";
import { financialCommandFetchJson } from "@/lib/financial-command";
import { Button } from "@/components/ui/button";
import { PoAmendmentSummary } from "./PoQuantityAmendment";

export function PoAmendmentHistory({
  purchaseOrderId,
}: {
  purchaseOrderId: number;
}) {
  const root = `/api/purchase-orders/${purchaseOrderId}/quantity-amendment/history`;
  const query = useInfiniteQuery({
    queryKey: [root],
    initialPageParam: null as number | null,
    queryFn: async ({ pageParam }) =>
      poAmendmentHistorySchema.parse(
        await financialCommandFetchJson(
          `${root}${pageParam ? `?before=${pageParam}` : ""}`,
          { credentials: "include" },
        ),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  return (
    <section aria-label="Approved PO edits" className="space-y-3">
      <h3 className="font-semibold">Approved PO edits</h3>
      {query.isPending && <p role="status">Loading approved edits…</p>}
      {query.error && (
        <p role="alert">
          Approval history could not be loaded.{" "}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Reload
          </Button>
        </p>
      )}
      {query.data?.pages
        .flatMap((page) => page.entries)
        .map((entry) => (
          <details key={entry.id} className="rounded border bg-card p-3">
            <summary className="cursor-pointer">
              Revision {entry.revisionNumber} · approved by {entry.actorName} ·{" "}
              {new Date(entry.approvedAt).toLocaleString()}
            </summary>
            <p className="my-2 text-sm">{entry.preview.reason}</p>
            <PoAmendmentSummary preview={entry.preview} />
          </details>
        ))}
      {query.data?.pages[0].entries.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No approved PO edits recorded.
        </p>
      )}
      {query.hasNextPage && (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Older approvals
        </Button>
      )}
    </section>
  );
}
