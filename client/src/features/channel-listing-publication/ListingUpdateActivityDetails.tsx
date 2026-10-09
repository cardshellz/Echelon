import type { ListingUpdateView } from "@shared/types/channel-listing-update";
import { ListingUpdateVerification } from "./ListingUpdateVerification";

export function ListingUpdateActivityDetails({
  channelId,
  update,
  verifyCurrentItem,
}: {
  channelId: number;
  update: ListingUpdateView;
  verifyCurrentItem: boolean;
}) {
  return (
    <div className="min-w-0 space-y-3 text-sm">
      <div>
        <p className="font-medium [overflow-wrap:anywhere]">{update.title}</p>
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{update.sku}</p>
      </div>
      {update.state === "accepted" ? (
        <p>Walmart processed this feed. Acceptance alone does not confirm the item's category or publication.</p>
      ) : update.message && (
        <p className={`[overflow-wrap:anywhere] ${update.state === "needs_attention" || update.state === "uncertain" ? "text-destructive" : ""}`}>
          {update.message}
        </p>
      )}
      {update.state === "accepted" && verifyCurrentItem && (
        <ListingUpdateVerification channelId={channelId} updateId={update.id} />
      )}
      <dl className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-x-2">
          <dt>Update</dt>
          <dd className="min-w-0 break-all font-mono">{update.id}</dd>
        </div>
        {update.submissionId && (
          <div className="flex flex-wrap gap-x-2">
            <dt>Walmart feed</dt>
            <dd className="min-w-0 break-all font-mono">{update.submissionId}</dd>
          </div>
        )}
        <div className="flex flex-wrap gap-x-2">
          <dt>Updated</dt>
          <dd><time dateTime={update.updatedAt}>{new Date(update.updatedAt).toLocaleString()}</time></dd>
        </div>
      </dl>
    </div>
  );
}
