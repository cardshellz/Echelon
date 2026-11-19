import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listingMemberConflictListSchema } from "@shared/types/listing-member-lifecycle";
import { Button } from "@/components/ui/button";
import { publicationRequest } from "./api";

/** A read-only summary of current conflicts from the shared listing owner.
 * There is deliberately no automatic poll or provider mutation here. */
export function ListingMemberConflictNotice({ channelId, enabled = true }: { channelId: number; enabled?: boolean }) {
  const [offset, setOffset] = useState(0);
  const url = `/api/channels/${channelId}/listing-lifecycle/members/conflicts`;
  const query = useQuery({
    queryKey: [url, offset],
    enabled,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: previous => previous,
    queryFn: async () => {
      const result = await publicationRequest("POST", url, listingMemberConflictListSchema, { offset });
      if (result.offset !== offset) throw new Error("The conflict list belongs to a different page.");
      return result;
    },
  });
  const items = query.data?.items ?? [];
  if (!items.length && query.isError) {
    return <div role="alert" className="rounded-md border border-amber-400 p-3 text-sm">
      <p>Archived listing conflicts could not be checked. Previously saved problems may still need attention.</p>
      <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
        Retry check
      </Button>
      {offset > 0 && <Button variant="outline" size="sm" onClick={() => setOffset(Math.max(0, offset - 100))}>Previous page</Button>}
    </div>;
  }
  if (!items.length && offset === 0) return null;
  const hasMore = query.data?.hasMore ?? false;
  const shownOffset = query.data?.offset ?? offset;
  return <details className="rounded-md border border-amber-400 p-3 text-sm" data-testid="listing-member-conflicts">
    <summary className="cursor-pointer font-medium">
      {shownOffset === 0 && !hasMore ? `${items.length} archived variant ${items.length === 1 ? "link needs" : "links need"} review`
        : "Archived variant links need review"}
    </summary>
    <div className="mt-2 space-y-2">
      {query.isError && <p role="alert">The latest check failed. These are the last loaded conflicts and may have changed.</p>}
      <p>Saved channel links conflict. Removal is paused to avoid changing the wrong listing; no removal has been confirmed.</p>
      <p>These archived links need technical review. The current catalog editor does not repair archived variant links.</p>
      <ul className="list-disc pl-5">
        {items.map(item => <li key={item.operationId}>
          <a className="underline" href={`/products/${item.productId}?tab=channels`}>
            {item.sku || `Variant ${item.productVariantId}`}
          </a>
        </li>)}
      </ul>
      <p>{items.length ? `Showing ${shownOffset + 1}–${shownOffset + items.length}.` : "No conflicts remain on this page."}</p>
      {shownOffset > 0 && <Button variant="outline" size="sm" disabled={query.isFetching || query.isError}
        onClick={() => setOffset(Math.max(0, shownOffset - 100))}>Previous page</Button>}
      {hasMore && <Button variant="outline" size="sm" disabled={query.isFetching || query.isError}
        onClick={() => setOffset(shownOffset + 100)}>Next page</Button>}
      <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
        Refresh conflicts
      </Button>
    </div>
  </details>;
}
