import { useQuery } from "@tanstack/react-query";
import { listingUpdateVerificationSchema } from "@shared/types/channel-listing-update";
import { Button } from "@/components/ui/button";
import { publicationRequest } from "./api";
import { errorMessage } from "./model";

/** Only mounted for the newest submitted update of a SKU. Historical feeds are
 * not proof of current content, and opening Activity must not poll every receipt. */
export function ListingUpdateVerification({
  channelId,
  updateId,
}: {
  channelId: number;
  updateId: string;
}) {
  const url = `/api/channels/${channelId}/listing-updates/${updateId}/verification`;
  const query = useQuery({
    queryKey: [url],
    queryFn: () => publicationRequest("GET", url, listingUpdateVerificationSchema),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const result = query.data;
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">Item result on Walmart</p>
      {query.isFetching && <p role="status">Checking the item on Walmart…</p>}
      {query.error && (
        <p role="alert" className="text-destructive">
          {errorMessage(query.error)}
        </p>
      )}
      {result && (
        <>
          <dl className="space-y-1 break-words">
            <div>
              <dt className="inline text-muted-foreground">Submitted product type: </dt>
              <dd className="inline">{result.requestedProductType}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Walmart currently reports: </dt>
              <dd className="inline">{result.current.productType || "Not returned"}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Listing status: </dt>
              <dd className="inline">{result.current.publishedStatus}</dd>
            </div>
          </dl>
          {result.categoryMatches ? (
            <p>
              Walmart reports the submitted product type. Listing status is shown separately above.
            </p>
          ) : (
            <p className="text-amber-800 dark:text-amber-300">
              The product type is not confirmed. Walmart still reports a different
              type. Check the item again before sending another update.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Checked {new Date(result.checkedAt).toLocaleString()}
          </p>
        </>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Check item on Walmart
      </Button>
    </div>
  );
}
