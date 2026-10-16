import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { ebayListingSyncJobSchema, type EbayListingSyncJob } from "@shared/types/ebay-listing-sync";
import { ebayListingRecoveryPreviewSchema, ebayListingRecoveryResultSchema } from "@shared/types/ebay-listing-recovery";
import { apiRequest } from "@/lib/queryClient";
import { listingIssueFromError } from "@/lib/ebay-listing-issue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EbayListingIssueCard } from "./EbayListingIssueCard";

const recoverySchema = ebayListingRecoveryPreviewSchema.extend({
  jobId: z.string().uuid().nullable(), productId: z.number().int().positive(),
  canRecover: z.boolean(), requiredPermission: z.string().nullish(),
});
interface EbaySyncRecoveryDialogProps {
  jobId: string | null;
  productId: number | null;
  productName: string;
  issue: EbayListingIssue | null;
  onClose: () => void;
  onRecheck: () => void;
  onRecovered: (job: EbayListingSyncJob | null) => void;
  checking: boolean;
  operation?: EbayListingSyncJob["operation"];
}

export function EbaySyncRecoveryDialog({ jobId, productId, productName, issue, onClose, onRecheck, onRecovered, checking, operation }: EbaySyncRecoveryDialogProps) {
  const queryClient = useQueryClient();
  const [acknowledged, setAcknowledged] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [retryPublish, setRetryPublish] = useState(false);
  const resourcePath = jobId ? `/api/ebay/listings/sync-jobs/${jobId}` : `/api/ebay/listings/products/${productId}`;
  const savedRequest = useQuery({
    queryKey: [resourcePath, "recovery-operation"],
    queryFn: async () => {
      const { job } = z.object({ job: ebayListingSyncJobSchema }).parse(await (await apiRequest("GET", resourcePath)).json());
      if (job.id !== jobId || job.productId !== productId) throw new Error("The saved recovery request belongs to another product.");
      return job;
    },
    enabled: productId !== null && jobId !== null && operation === undefined, retry: false, staleTime: 0,
  });
  const resolvedOperation = operation ?? savedRequest.data?.operation;
  const operationKnown = !jobId || resolvedOperation !== undefined;
  // A retry after a lost response uses the same command for this exact preview.
  const recoveryCommand = useRef<{ previewHash: string; publicationRetryHash?: string; idempotencyKey: string } | null>(null);
  const recovery = useQuery({
    queryKey: [resourcePath, "recovery"],
    queryFn: async () => {
      const preview = recoverySchema.parse(await (await apiRequest("GET", `${resourcePath}/recovery`)).json());
      if (preview.productId !== productId || preview.jobId !== jobId) throw new Error("The recovery preview belongs to another listing request.");
      return preview;
    },
    enabled: productId !== null, staleTime: 0,
  });
  const resume = useMutation({
    mutationFn: async () => {
      const preview = recovery.data;
      if (!productId || !preview?.canRecover || !preview.canResume || !acknowledged || !operationKnown) throw new Error("Load and confirm the recovery preview before continuing.");
      const publicationRetryHash = preview.publicationRetry?.reviewHash;
      if (recoveryCommand.current?.previewHash !== preview.previewHash || recoveryCommand.current?.publicationRetryHash !== publicationRetryHash) {
        recoveryCommand.current = { previewHash: preview.previewHash, ...(publicationRetryHash ? { publicationRetryHash } : {}), idempotencyKey: crypto.randomUUID() };
      }
      const response = await apiRequest("POST", `${resourcePath}/recovery`, {
        ...recoveryCommand.current, acknowledgeUnknownOutcome: true,
      });
      const result = ebayListingRecoveryResultSchema.parse(await response.json());
      if ((result.job && result.job.productId !== productId) || (result.productId !== undefined && result.productId !== productId)) throw new Error("The recovery response belongs to another product. Check this saved request before continuing.");
      return result;
    },
    onSuccess: (result) => {
      setRecovered(true); setRetryPublish(result.nextAction === "retry_publish"); setAcknowledged(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      // The saved-status view owns observation after recovery. Keeping the
      // returned job here would freeze a queued or blocked response forever.
      onRecovered(result.job);
    },
  });
  useEffect(() => {
    setAcknowledged(false); setRecovered(false); setRetryPublish(false); recoveryCommand.current = null; resume.reset();
  }, [jobId, productId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAcknowledged(false); }, [recovery.data?.previewHash, recovery.data?.publicationRetry?.reviewHash]);
  const publicationRetry = recovery.data?.publicationRetry;
  const withdrawal = resolvedOperation === "withdraw";

  return (
    <Dialog open={productId !== null} onOpenChange={(open) => { if (!open && !resume.isPending) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{!operationKnown ? "Review saved listing request" : withdrawal ? "Resolve listing removal" : publicationRetry ? "Resume interrupted publication" : "Resolve listing sync"}</DialogTitle>
          <DialogDescription>{productName}. Review the saved request before resuming updates.</DialogDescription>
        </DialogHeader>
        {recovered ? <div role="status" className="space-y-2 text-sm">
          <p className="font-medium">{retryPublish ? "Recovery saved. Retry Publish to finish listing setup using current inventory." : "Recovery saved. Opening the current saved request status…"}</p>
          <p>The original request remains in the audit history. {retryPublish ? "The listing has not been confirmed published." : "Check the listing's saved sync status for completion."}</p>
          {retryPublish && <Button onClick={() => { onClose(); onRecheck(); }}>Retry Publish</Button>}
        </div> : <>
          {issue && <EbayListingIssueCard issue={issue} />}
          {recovery.isLoading && <p role="status">Loading saved request details…</p>}
          {!operationKnown && <div role="status" className="space-y-2 text-sm"><p>The saved operation must be checked before recovery can be confirmed.</p><Button variant="outline" disabled={savedRequest.isFetching} onClick={() => savedRequest.refetch()}>Check saved operation</Button></div>}
          {recovery.isError && <div role="alert" className="space-y-2 text-sm">
            <p>Saved request details could not be loaded. No recovery was performed.</p>
            <Button variant="outline" onClick={() => recovery.refetch()}>Reload request details</Button>
          </div>}
          {recovery.data && <div className="space-y-3 text-sm">
            {publicationRetry && operationKnown && <div className="rounded-md border p-3 space-y-2"><p className="font-medium">{withdrawal ? "Removal was interrupted before its result was recorded." : "Publication was interrupted before its result was recorded."}</p><p>{publicationRetry.message}</p><p>{withdrawal ? "The original attempt remains in the audit history. Resuming allows this saved removal to check the exact existing eBay offers and end them only if they remain published." : "The original attempt remains in the audit history. Resuming allows the saved job to check the existing eBay offers and finish publication using current inventory and catalog pictures."}</p></div>}
            {recovery.data.attempts.length === 0 && !publicationRetry && <p>{jobId
              ? withdrawal ? "No unresolved quantity request is currently recorded. Check the saved removal status for its current result and next step." : "No unresolved request is currently recorded for this sync. Continue the saved sync to check its current state."
              : "No unresolved request is currently recorded for this product. Retry Publish to check its existing eBay offers and finish setup using current inventory."}</p>}
            {recovery.data.attempts.map((attempt) => <section key={attempt.attemptId} className="rounded-md border p-3 space-y-2">
              <h3 className="font-medium break-words">{attempt.skus.join(", ")} · Attempt {attempt.attemptId}</h3>
              <p>The final outcome of this earlier quantity request has not been resolved.</p>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer py-1">Recorded response details</summary>
                <p className="py-1">State: {attempt.state} · Started {new Date(attempt.startedAt).toLocaleString()}</p>
                {attempt.requests.map((request) => <div key={request.requestId} className="border-t py-2 break-words">
                  <p>{request.method} {request.path}</p>
                  <p>HTTP response: {request.httpStatus ?? "No status recorded"} · Result: {request.outcome ?? "Not recorded"}</p>
                  <p>eBay codes: {request.errorCodes.length ? request.errorCodes.join(", ") : "None recorded"}</p>
                  <p>Request reference: {request.requestId}</p>
                </div>)}
              </details>
            </section>)}
            {recovery.data.blockReason === "active_request" && <p>A request may still be running. Wait for it to finish, then refresh these details.</p>}
            {recovery.data.blockReason === "broader_scope" && <p>This request also affects other listings. An inventory administrator must review all affected listings before resuming it. Share the attempt references above.</p>}
            {!recovery.data.canRecover && (recovery.data.attempts.length > 0 || publicationRetry) && <p>An inventory administrator must authorize this recovery. Share {publicationRetry ? `saved ${withdrawal ? "removal" : "publishing"} request ${jobId}` : "the attempt references above"} with them.</p>}
            {recovery.data.canResume && recovery.data.canRecover && operationKnown && <div className="space-y-3 rounded-md border border-amber-300 p-3">
              <p className="font-medium">{publicationRetry ? withdrawal ? "Resume saved removal" : "Resume saved publication" : "Resume with current inventory"}</p>
              <p>{publicationRetry ? withdrawal ? "The original removal request may have reached eBay. This records your permission to resume the same saved removal after checking the exact existing offers. It does not claim that the earlier request succeeded." : "The original publish request may have reached eBay. This records your permission to resume the saved publication after checking the existing offers. It does not claim that the earlier request succeeded." : "The original update may have reached eBay. This records your recovery decision and allows a fresh update calculated from current inventory. It does not replay the old quantity or claim the old request succeeded."}</p>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={resume.isPending} />
                <span>{publicationRetry ? withdrawal ? "I understand the original removal outcome is unknown and authorize resuming the saved removal." : "I understand the original publication outcome is unknown and authorize resuming the saved publication." : "I understand the old outcome is unknown and authorize resuming with current inventory."}</span>
              </label>
              <Button disabled={!acknowledged || resume.isPending || recovery.isFetching} onClick={() => resume.mutate()}>{resume.isPending ? "Saving recovery…" : publicationRetry ? withdrawal ? "Resume saved removal" : "Resume saved publication" : "Resume with current inventory"}</Button>
            </div>}
            {resume.isError && <div role="alert"><EbayListingIssueCard issue={listingIssueFromError(resume.error, recovery.data.productId)} /></div>}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={recovery.isFetching || resume.isPending} onClick={() => { setAcknowledged(false); void recovery.refetch(); }}>Refresh request details</Button>
              {recovery.data.attempts.length === 0 && !publicationRetry && <Button variant="outline" disabled={checking} onClick={onRecheck}>{checking ? "Checking listing…" : jobId ? withdrawal ? "Check saved removal" : "Continue saved sync" : "Retry Publish"}</Button>}
            </div>
          </div>}
        </>}
        <Button variant="outline" disabled={resume.isPending} onClick={onClose}>Close</Button>
      </DialogContent>
    </Dialog>
  );
}
