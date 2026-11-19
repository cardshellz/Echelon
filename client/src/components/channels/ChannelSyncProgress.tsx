import type {
  ChannelSyncBatch,
  ChannelSyncItem,
} from "@shared/types/channel-sync-batch";
import type { ChannelSyncBatchesController } from "@/hooks/use-channel-sync-batches";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const labels: Record<ChannelSyncItem["state"], string> = {
  pending: "Preparing request",
  queued: "Waiting in queue",
  running: "Updating",
  retrying: "Retry scheduled",
  verifying: "Checking provider outcome",
  completed: "Synced",
  needs_attention: "Needs attention",
  unavailable: "Status unavailable",
};
function headline(batch: ChannelSyncBatch): string {
  if (batch.counts.total === 0) return "No eligible listings to sync";
  if (batch.state === "completed") return "Sync complete";
  if (batch.state === "needs_attention") return "Sync finished with issues";
  if (batch.state === "unavailable") return "Sync status unavailable";
  return "Sync in progress";
}
function summary(batch: ChannelSyncBatch): string {
  const c = batch.counts;
  return [
    `${c.completed} synced`,
    c.pending && `${c.pending} preparing`,
    c.queued && `${c.queued} queued`,
    c.running && `${c.running} updating`,
    c.retrying && `${c.retrying} retrying`,
    c.verifying && `${c.verifying} verifying`,
    c.needsAttention && `${c.needsAttention} need attention`,
    c.unavailable && `${c.unavailable} unavailable`,
  ]
    .filter(Boolean)
    .join(" · ");
}
function BatchProgress({
  batch,
  stale = false,
}: {
  batch: ChannelSyncBatch;
  stale?: boolean;
}) {
  const c = batch.counts;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">
        {stale ? "Last known progress" : headline(batch)} — {c.finished} of{" "}
        {c.total} products processed
      </p>
      <div
        role="progressbar"
        aria-label="Sync batch progress"
        aria-valuemin={0}
        aria-valuemax={Math.max(c.total, 1)}
        aria-valuenow={c.finished}
        aria-valuetext={`${c.finished} of ${c.total} processed; ${c.completed} synced; ${c.needsAttention} need attention`}
        className="h-2 w-full overflow-hidden rounded bg-muted"
      >
        <div
          className="h-full transition-[width]"
          style={{
            width: `${c.total ? (100 * c.finished) / c.total : 0}%`,
            backgroundColor:
              stale || c.needsAttention || c.unavailable
                ? "#d97706"
                : batch.state === "completed"
                  ? "#16a34a"
                  : "#4f46e5",
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {summary(batch)}
      </p>
    </div>
  );
}
export function ChannelSyncProgress({
  controller: c,
  canEdit,
  onReview,
}: {
  controller: ChannelSyncBatchesController;
  canEdit: boolean;
  onReview(item: ChannelSyncItem): void;
}) {
  const { batch, query } = c;
  if (!batch && !query.isError && !c.starting && !c.requestError && !c.open)
    return null;
  const refresh = () => {
    void query.refetch();
  };
  const error = query.isError
    ? "Progress could not be refreshed. The figures below may be out of date; saved work continues."
    : c.requestError;
  return (
    <>
      <section
        aria-label="Channel sync progress"
        className="rounded-lg border bg-card p-3 space-y-2"
      >
        {batch && <BatchProgress batch={batch} stale={query.isError} />}
        {c.starting && (
          <p role="status" className="text-sm">
            Saving your sync request…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-amber-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {batch && (
            <span className="text-muted-foreground">
              Started {new Date(batch.createdAt).toLocaleString()} · Last
              checked {new Date(batch.checkedAt).toLocaleTimeString()}
            </span>
          )}
          <Button size="sm" variant="outline" onClick={() => c.setOpen(true)}>
            View sync progress
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={query.isFetching}
            onClick={refresh}
          >
            {query.isFetching ? "Checking status…" : "Refresh sync progress"}
          </Button>
          {c.requestError && !c.requestRefused && canEdit && (
            <Button
              size="sm"
              variant="outline"
              disabled={c.starting}
              onClick={() => void c.start()}
            >
              Resume saved request
            </Button>
          )}
        </div>
      </section>
      <Dialog open={c.open} onOpenChange={c.setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {c.starting
                ? "Saving sync request"
                : c.requestError
                  ? c.requestRefused
                    ? "Sync request needs attention"
                    : "Sync request not confirmed"
                  : query.isError
                    ? "Sync status unavailable"
                    : batch
                      ? headline(batch)
                      : "Sync progress"}
            </DialogTitle>
            <DialogDescription>
              You can close this window. Progress stays on the channel page and
              returns when you reload.
            </DialogDescription>
          </DialogHeader>
          {batch && <BatchProgress batch={batch} stale={query.isError} />}
          {error && (
            <p role="alert" className="text-sm text-amber-700">
              {error}
            </p>
          )}
          {c.batches.length > 1 && (
            <label className="text-sm">
              Saved sync
              <select
                aria-label="Saved sync"
                value={batch?.id ?? ""}
                className="ml-2 max-w-full rounded border p-1"
                onChange={(event) => c.setSelectedId(event.target.value)}
              >
                {batch && !c.batches.some((saved) => saved.id === batch.id) && (
                  <option value={batch.id}>
                    {new Date(batch.createdAt).toLocaleString()} —{" "}
                    {batch.counts.completed}/{batch.counts.total} synced
                  </option>
                )}
                {c.batches.map((saved) => (
                  <option key={saved.id} value={saved.id}>
                    {new Date(saved.createdAt).toLocaleString()} —{" "}
                    {saved.counts.completed}/{saved.counts.total} synced
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="min-h-0 overflow-y-auto divide-y">
            {batch?.items.map((item) => (
              <div
                key={item.commandKey}
                className="py-2 flex items-start gap-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium break-words">{item.name}</p>
                  {item.sku && (
                    <p className="text-xs text-muted-foreground break-all">
                      {item.sku}
                    </p>
                  )}
                  <p className="text-xs">{labels[item.state]}</p>
                  {item.message && (
                    <p className="text-xs text-muted-foreground break-words">
                      {item.message}
                    </p>
                  )}
                  {item.nextAttemptAt &&
                    ["retrying", "verifying"].includes(item.state) && (
                      <p className="text-xs text-muted-foreground">
                        Next check no earlier than{" "}
                        {new Date(item.nextAttemptAt).toLocaleTimeString()}
                      </p>
                    )}
                  {item.code && (
                    <details className="text-xs text-muted-foreground">
                      <summary>Technical details</summary>
                      {item.code}
                    </details>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    c.setOpen(false);
                    onReview(item);
                  }}
                >
                  Review listing
                </Button>
              </div>
            ))}
            {!batch && !error && (
              <p className="py-3 text-sm">
                The batch will appear here once its request is saved.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetching}
              onClick={refresh}
            >
              {query.isFetching ? "Checking status…" : "Refresh sync progress"}
            </Button>
            {c.offset > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  c.setSelectedId(null);
                  c.setOffset(Math.max(0, c.offset - 10));
                }}
              >
                Newer runs
              </Button>
            )}
            {c.batches.length === 10 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  c.setSelectedId(null);
                  c.setOffset(c.offset + 10);
                }}
              >
                Older runs
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => c.setOpen(false)}
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
