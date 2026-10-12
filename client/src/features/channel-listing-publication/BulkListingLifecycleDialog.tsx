import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ListingAccount } from "@shared/types/channel-listing-publication";
import { listingLifecycleViewSchema } from "@shared/types/channel-listing-lifecycle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { publicationRequest } from "./api";
import { errorMessage } from "./model";
import type { ListingLifecycleSelection } from "./ListingLifecycleActions";

export interface BulkLifecycleSelection {
  account: ListingAccount;
  items: ListingLifecycleSelection[];
  skipped: number;
}

/** Use the same idempotent per-SKU command as the row action. Preserve individual
 * failures so retry never repeats a successfully recorded stop. */
export function BulkListingLifecycleDialog({
  channelId,
  selection,
  onClose,
}: {
  channelId: number;
  selection: BulkLifecycleSelection;
  onClose(succeeded: readonly string[]): void;
}) {
  const client = useQueryClient();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ReadonlyMap<string, string | null>>(
    new Map(),
  );
  const [refreshError, setRefreshError] = useState("");
  const remove = selection.items[0].action === "remove";
  const succeeded = [...results]
    .filter(([, error]) => error === null)
    .map(([sku]) => sku);
  const remaining = selection.items.filter(
    (item) => !results.has(item.sku) || results.get(item.sku) !== null,
  );
  async function confirm() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setRefreshError("");
    try {
      for (const item of remaining) {
        let failure: string | null = null;
        try {
          await publicationRequest(
            "POST",
            `/api/channels/${channelId}/listing-lifecycle`,
            listingLifecycleViewSchema,
            { account: selection.account, sku: item.sku, action: item.action },
          );
        } catch (error) {
          failure = errorMessage(error);
        }
        setResults((previous) => new Map(previous).set(item.sku, failure));
      }
      try {
        await Promise.all([
          client.invalidateQueries({
            queryKey: [`/api/channels/${channelId}/listing-lifecycle`],
          }),
          client.invalidateQueries({
            queryKey: [`/api/channels/${channelId}/catalog`],
          }),
        ]);
      } catch {
        setRefreshError(
          "Requests were saved, but the feed could not refresh. Refresh listings to see their status.",
        );
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose(succeeded);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {remove ? "Remove" : "Unpublish"} {selection.items.length} listings?
          </DialogTitle>
          <DialogDescription>
            {remove
              ? "Stop selling on Walmart and remove these listings from Echelon after Walmart confirms."
              : "Stop selling these items on Walmart. Keep their listings in Echelon."}{" "}
            Future listing and stock updates will stop for these SKUs.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
          {selection.items.map((item) => (
            <div
              key={item.sku}
              className="p-3 text-sm [overflow-wrap:anywhere]"
            >
              <p className="font-medium">{item.title}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {item.sku}
              </p>
              {results.has(item.sku) && (
                <p
                  role={results.get(item.sku) ? "alert" : "status"}
                  className={
                    results.get(item.sku)
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {results.get(item.sku) ??
                    "Request saved · waiting for Walmart confirmation"}
                </p>
              )}
            </div>
          ))}
        </div>
        {selection.skipped > 0 && (
          <p className="text-sm">
            {selection.skipped} other selected rows are excluded from this
            action.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Catalog products, orders, and history are kept. Walmart confirmation
          can take up to 48 hours.
        </p>
        {refreshError && (
          <p role="alert" className="text-sm text-destructive">
            {refreshError}
          </p>
        )}
        {busy && (
          <p role="status" className="text-sm">
            Saving requests ({results.size} of {selection.items.length})…
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onClose(succeeded)}
          >
            {results.size ? "Done" : "Cancel"}
          </Button>
          {remaining.length > 0 && (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy
                ? "Saving…"
                : results.size
                  ? `Retry ${remaining.length} failed requests`
                  : remove
                    ? "Unpublish and remove"
                    : "Unpublish from Walmart"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
