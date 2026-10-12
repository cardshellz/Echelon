import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ebayListingSyncJobSchema } from "@shared/types/ebay-listing-sync";
import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EbayListingIssueCard } from "./EbayListingIssueCard";

/** Read-only observation of an accepted job. Refresh never publishes or grants
 * permission to replace an unknown provider outcome. */
export function EbayListingJobStatusDialog({ jobId, productId, productName, onClose, onIssueAction }: {
  jobId: string; productId: number; productName: string; onClose: () => void;
  onIssueAction: (issue: EbayListingIssue, productId: number, jobId?: string) => void;
}) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["/api/ebay/listings/sync-jobs", "read-only-status", jobId],
    queryFn: async () => {
      const { job } = z.object({ job: ebayListingSyncJobSchema }).parse(await (await apiRequest("GET", `/api/ebay/listings/sync-jobs/${jobId}`)).json());
      if (job.id !== jobId || job.productId !== productId) throw new Error("The saved status does not match this listing request.");
      return job;
    },
    retry: false, staleTime: 0,
    refetchInterval: query => query.state.data?.state === "completed" ? false : 10_000,
  });
  useEffect(() => {
    const job = status.data;
    if (!job) return;
    // This may be an older request. Refresh the authoritative product list
    // instead of replacing a newer job with the status of this selected job.
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"], exact: true });
    if (job.state === "completed") void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
  }, [status.data, productId, queryClient]);
  const job = status.data;
  const issue = job && job.state !== "completed" && job.code
    ? job.issue ?? resolveEbayListingIssue({ code: job.code, message: job.message, productId, jobId, state: job.state }) : null;
  return <Dialog open onOpenChange={value => { if (!value) onClose(); }}><DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
    <DialogHeader><DialogTitle>Publishing status</DialogTitle><DialogDescription>{productName}. This view checks the saved request without starting another publication.</DialogDescription></DialogHeader>
    {status.isLoading && <p role="status">Loading saved publishing status…</p>}
    {status.isError && <p role="alert">The saved publishing status could not be loaded. Refresh below to check this same request. No new publication was sent.</p>}
    {job && <div className="space-y-3 text-sm">
      <p role="status">{job.state === "completed" ? job.operation === "publish" ? "Published. Listing and pictures verified." : "Listing update verified." : issue?.title ?? "Publishing is queued or running. Completion is not yet confirmed."}</p>
      {issue && <EbayListingIssueCard issue={issue} busy={status.isFetching} onAction={next => {
        if (next.action.kind === "check_status") void status.refetch();
        else { onClose(); onIssueAction(next, productId, jobId); }
      }} />}
      {job.state === "recovering" && <p>Next automatic check: {new Date(job.nextAttemptAt).toLocaleString()}</p>}
    </div>}
    <p className="text-xs text-muted-foreground break-all">Request reference: {jobId}</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={status.isFetching} onClick={() => void status.refetch()}>Refresh publishing status</Button><Button variant="outline" className="min-h-11" onClick={onClose}>Close</Button></div>
  </DialogContent></Dialog>;
}
