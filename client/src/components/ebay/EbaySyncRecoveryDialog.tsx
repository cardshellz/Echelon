import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { ebayListingSyncJobSchema, type EbayListingSyncJob } from "@shared/types/ebay-listing-sync";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { ebayPublicationRecoveryPreviewSchema, ebayPublicationRecoveryResultSchema } from "@shared/types/ebay-publication-recovery";
import { apiRequest } from "@/lib/queryClient";
import { listingIssueFromError } from "@/lib/ebay-listing-issue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EbayListingIssueCard } from "./EbayListingIssueCard";

const recoverySchema = ebayPublicationRecoveryPreviewSchema.extend({
  jobId: z.string().uuid().nullable(), productId: z.number().int().positive(),
  canRecover: z.boolean(), requiredPermission: z.string().nullish(),
});
const recoveryResultSchema = ebayPublicationRecoveryResultSchema.extend({
  job: ebayListingSyncJobSchema.nullable(), productId: z.number().int().positive().optional(), nextAction: z.literal("retry_publish").optional(),
}).refine((result) => result.job !== null || (result.productId !== undefined && result.nextAction === "retry_publish"), {
  message: "A recovery without a saved job must identify the product and its next action.",
});
const identitySchema = z.object({
  groupKey: z.string().nullable(),
  variants: z.array(z.object({
    variantId: z.number().int().positive(), catalogSku: z.string().optional(), sku: z.string(),
    externalSku: z.string().nullable().optional(), offerId: z.string().nullable().optional(), listingId: z.string().nullable().optional(),
  })),
}).nullable();
const mappingSchema = z.object({ job: ebayListingSyncJobSchema.nullable(), sourceIdentity: identitySchema, providerIdentity: identitySchema });

interface EbaySyncRecoveryDialogProps {
  jobId: string | null;
  productId: number | null;
  productName: string;
  issue: EbayListingIssue | null;
  onClose: () => void;
  onRecheck: () => void;
  onRecovered: () => void;
  checking: boolean;
  mode: "recovery" | "mapping";
  onIssueAction: (issue: EbayListingIssue, productId: number, jobId?: string) => void;
}

export function EbaySyncRecoveryDialog({ jobId, productId, productName, issue, onClose, onRecheck, onRecovered, checking, mode, onIssueAction }: EbaySyncRecoveryDialogProps) {
  const queryClient = useQueryClient();
  const [acknowledged, setAcknowledged] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [retryPublish, setRetryPublish] = useState(false);
  const [resumedJob, setResumedJob] = useState<EbayListingSyncJob | null>(null);
  const resourcePath = jobId ? `/api/ebay/listings/sync-jobs/${jobId}` : `/api/ebay/listings/products/${productId}`;
  // A retry after a lost response uses the same command for this exact preview.
  const recoveryCommand = useRef<{ previewHash: string; idempotencyKey: string } | null>(null);
  const recovery = useQuery({
    queryKey: [resourcePath, "recovery"],
    queryFn: async () => recoverySchema.parse(await (await apiRequest("GET", `${resourcePath}/recovery`)).json()),
    enabled: productId !== null && mode === "recovery", staleTime: 0,
  });
  const mapping = useQuery({
    queryKey: [resourcePath],
    queryFn: async () => mappingSchema.parse(await (await apiRequest("GET", resourcePath)).json()),
    enabled: productId !== null && mode === "mapping", staleTime: 0,
  });
  const resume = useMutation({
    mutationFn: async () => {
      const preview = recovery.data;
      if (!productId || !preview?.canRecover || !preview.canResume || !acknowledged) throw new Error("Load and confirm the recovery preview before continuing.");
      if (recoveryCommand.current?.previewHash !== preview.previewHash) {
        recoveryCommand.current = { previewHash: preview.previewHash, idempotencyKey: crypto.randomUUID() };
      }
      const response = await apiRequest("POST", `${resourcePath}/recovery`, {
        ...recoveryCommand.current, acknowledgeUnknownOutcome: true,
      });
      return recoveryResultSchema.parse(await response.json());
    },
    onSuccess: (result) => {
      setRecovered(true); setResumedJob(result.job); setRetryPublish(result.nextAction === "retry_publish"); setAcknowledged(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      onRecovered();
    },
  });
  useEffect(() => {
    setAcknowledged(false); setRecovered(false); setRetryPublish(false); setResumedJob(null); recoveryCommand.current = null; resume.reset();
  }, [jobId, productId, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAcknowledged(false); }, [recovery.data?.previewHash]);
  const resumedIssue = resumedJob && ["needs_attention", "awaiting_evidence"].includes(resumedJob.state)
    ? resumedJob.issue ?? resolveEbayListingIssue({ code: resumedJob.code, message: resumedJob.message, productId: resumedJob.productId, jobId: resumedJob.id, state: resumedJob.state }) : null;

  return (
    <Dialog open={productId !== null} onOpenChange={(open) => { if (!open && !resume.isPending) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "mapping" ? "Review listing mapping" : "Resolve listing sync"}</DialogTitle>
          <DialogDescription>{productName}. Review the saved request before resuming updates.</DialogDescription>
        </DialogHeader>
        {recovered ? <div role="status" className="space-y-2 text-sm">
          <p className="font-medium">{resumedIssue ? "Recovery saved. The listing still needs the correction below." : retryPublish ? "Recovery saved. Retry Publish to finish listing setup using current inventory." : resumedJob?.state === "completed" ? "Recovery saved. The listing update is verified." : "Recovery saved. The listing update will continue using current inventory."}</p>
          <p>The original request remains in the audit history. {retryPublish ? "The listing has not been confirmed published." : "Check the listing's saved sync status for completion."}</p>
          {retryPublish && <Button onClick={() => { onClose(); onRecheck(); }}>Retry Publish</Button>}
          {resumedIssue && resumedJob && <EbayListingIssueCard issue={resumedIssue} onAction={(nextIssue) => { onClose(); onIssueAction(nextIssue, resumedJob.productId, resumedJob.id); }} />}
        </div> : <>
          {issue && <EbayListingIssueCard issue={issue} />}
          {mode === "mapping" && <div className="space-y-3 text-sm">
            {mapping.isLoading && <p role="status">Loading saved listing mapping…</p>}
            {mapping.isError && <p role="alert">The mapping could not be loaded. Refresh it before trying another update.</p>}
            {mapping.data && <>
              {([ ["Saved source mapping", mapping.data.sourceIdentity], ["Resolved eBay mapping", mapping.data.providerIdentity] ] as const).map(([label, identity]) => <section key={label} className="rounded-md border p-3 space-y-2">
                <h3 className="font-medium">{label}</h3>
                {identity ? <>
                  <p className="break-words">Group: {identity.groupKey ?? "No group saved"}</p>
                  {identity.variants.map((variant) => <dl key={variant.variantId} className="border-t pt-2 break-words text-xs space-y-1">
                    <div><dt className="inline font-medium">Catalog SKU: </dt><dd className="inline">{variant.catalogSku ?? variant.sku}</dd></div>
                    <div><dt className="inline font-medium">eBay SKU: </dt><dd className="inline">{variant.externalSku ?? variant.sku}</dd></div>
                    <div><dt className="inline font-medium">Offer: </dt><dd className="inline">{variant.offerId ?? "Not verified"}</dd></div>
                    <div><dt className="inline font-medium">Listing: </dt><dd className="inline">{variant.listingId ?? "Not verified"}</dd></div>
                  </dl>)}
                </> : <p>No verified mapping was saved at this stage. Review the issue above; Echelon must verify the eBay listing before it can update it.</p>}
              </section>)}
              <p>Catalog and eBay SKUs may differ. Echelon must verify which variant each offer belongs to before sending an update.</p>
              <Button variant="outline" disabled={checking} onClick={onRecheck}>{checking ? "Checking mapping…" : "Verify mapping again"}</Button>
            </>}
            <Button variant="outline" disabled={mapping.isFetching} onClick={() => mapping.refetch()}>Refresh mapping details</Button>
          </div>}
          {mode === "recovery" && recovery.isLoading && <p role="status">Loading saved request details…</p>}
          {mode === "recovery" && recovery.isError && <div role="alert" className="space-y-2 text-sm">
            <p>Saved request details could not be loaded. No recovery was performed.</p>
            <Button variant="outline" onClick={() => recovery.refetch()}>Reload request details</Button>
          </div>}
          {mode === "recovery" && recovery.data && <div className="space-y-3 text-sm">
            {recovery.data.attempts.length === 0 && <p>{jobId
              ? "No unresolved request is currently recorded for this sync. Continue the saved sync to check its current state."
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
            {!recovery.data.canRecover && recovery.data.attempts.length > 0 && <p>An inventory administrator must authorize this recovery. Share the attempt references above with them.</p>}
            {recovery.data.canResume && recovery.data.canRecover && <div className="space-y-3 rounded-md border border-amber-300 p-3">
              <p className="font-medium">Resume with current inventory</p>
              <p>The original update may have reached eBay. This records your recovery decision and allows a fresh update calculated from current inventory. It does not replay the old quantity or claim the old request succeeded.</p>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={resume.isPending} />
                <span>I understand the old outcome is unknown and authorize resuming with current inventory.</span>
              </label>
              <Button disabled={!acknowledged || resume.isPending || recovery.isFetching} onClick={() => resume.mutate()}>{resume.isPending ? "Saving recovery…" : "Resume with current inventory"}</Button>
            </div>}
            {resume.isError && <div role="alert"><EbayListingIssueCard issue={listingIssueFromError(resume.error, recovery.data.productId)} /></div>}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={recovery.isFetching || resume.isPending} onClick={() => { setAcknowledged(false); void recovery.refetch(); }}>Refresh request details</Button>
              {recovery.data.attempts.length === 0 && <Button variant="outline" disabled={checking} onClick={onRecheck}>{checking ? "Checking listing…" : jobId ? "Continue saved sync" : "Retry Publish"}</Button>}
            </div>
          </div>}
        </>}
        <Button variant="outline" disabled={resume.isPending} onClick={onClose}>Close</Button>
      </DialogContent>
    </Dialog>
  );
}
