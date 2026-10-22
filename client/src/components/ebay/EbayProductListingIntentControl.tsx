import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ebayProductExclusionRequestSchema, ebayProductExclusionResultSchema, type EbayProductExclusionResult } from "@shared/types/ebay-listing-exclusion";
import { ebayListingSyncJobSchema, type EbayListingSyncJob } from "@shared/types/ebay-listing-sync";
import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { apiRequest } from "@/lib/queryClient";
import { listingIssueFromError } from "@/lib/ebay-listing-issue";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EbayListingIssueCard } from "./EbayListingIssueCard";
import { EbayWithdrawalIssueCard } from "./EbayWithdrawalIssueCard";

type ExclusionCommand = z.infer<typeof ebayProductExclusionRequestSchema>;

/** Inclusion intent and verified removal are separate results. The exact saved
 * command survives a missing response, closing the dialog, and page reloads. */
export function EbayProductListingIntentControl({ productId, productName, excluded, currentJob, disabled, retryRequested = 0, onRetryHandled, onIssueAction, onSyncSaved, onSync }: {
  productId: number; productName: string; excluded: boolean; currentJob?: EbayListingSyncJob; disabled?: boolean;
  retryRequested?: number;
  onRetryHandled: (productId: number, request: number) => void;
  onSyncSaved: (batchId: string) => void;
  onSync: () => void;
  onIssueAction: (issue: EbayListingIssue, productId: number, jobId?: string) => void;
}) {
  const queryClient = useQueryClient();
  const path = `/api/ebay/product-exclusion/${productId}`;
  const storageKey = `ebay:product-exclusion:${productId}`;
  const [open, setOpen] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [command, setCommand] = useState<ExclusionCommand | null>(null);
  const [result, setResult] = useState<EbayProductExclusionResult | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  function loadSavedRequest() {
    try {
      const saved = sessionStorage.getItem(storageKey);
      setCommand(saved ? ebayProductExclusionRequestSchema.parse(JSON.parse(saved)) : null);
      setStorageError(null);
    } catch {
      setStorageError("Your browser could not read the saved listing request. An earlier request may have been sent. Allow browser storage, then load that request before changing inclusion again.");
    }
    setInitialized(true);
  }
  useEffect(loadSavedRequest, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  function validate(value: unknown, request: ExclusionCommand) {
    const parsed = ebayProductExclusionResultSchema.parse(value);
    if (parsed.productId !== productId || parsed.commandKey !== request.commandKey || parsed.excluded !== request.excluded ||
      (parsed.job && (parsed.job.productId !== productId || parsed.job.operation !== "withdraw")) ||
      (parsed.remoteAction === "queued_withdrawal" && (!parsed.job || !parsed.excluded))) {
      throw new Error("The saved listing response does not match this product and request. Check the same request before changing inclusion again.");
    }
    return parsed;
  }
  function accept(value: EbayProductExclusionResult) {
    setResult(value); setCommand(null);
    if (!value.excluded && value.syncBatchId) { setOpen(false); onSyncSaved(value.syncBatchId); }
    try { sessionStorage.removeItem(storageKey); } catch { /* A retained accepted command replays safely. */ }
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
  }
  const save = useMutation({
    mutationFn: async (request: ExclusionCommand) => validate(await (await apiRequest("PUT", path, request)).json(), request),
    onSuccess: accept,
  });
  const receipt = useQuery({
    queryKey: [path, "commands", command?.commandKey],
    queryFn: async () => {
      if (!command) throw new Error("No saved request is available.");
      return validate(await (await apiRequest("GET", `${path}/commands/${command.commandKey}`)).json(), command);
    },
    enabled: initialized && !!command && !save.isPending, retry: false, staleTime: 0, refetchInterval: command ? 10_000 : false,
  });
  useEffect(() => { if (receipt.data && command && receipt.data.commandKey === command.commandKey) accept(receipt.data); }, [receipt.data, command]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = useQuery({
    queryKey: [path, "withdrawal", result?.job?.id],
    queryFn: async () => {
      const value = z.object({ job: ebayListingSyncJobSchema }).parse(await (await apiRequest("GET", `/api/ebay/listings/sync-jobs/${result?.job?.id}`)).json());
      if (value.job.productId !== productId || value.job.id !== result?.job?.id || value.job.operation !== "withdraw") throw new Error("The removal status belongs to another request.");
      return value.job;
    },
    enabled: !!result?.job, retry: false, staleTime: 0,
    refetchInterval: query => query.state.data?.state === "completed" ? false : 10_000,
  });
  useEffect(() => {
    if (!status.data) return;
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
  }, [status.data, queryClient]);

  function changeInclusion(included: boolean) {
    setOpen(true);
    if (command || storageError || !initialized) return;
    const request = { excluded: !included, commandKey: crypto.randomUUID() };
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setStorageError("Your browser could not save this request's retry details. No new request was sent. Allow browser storage, then load saved requests and try the switch again."); return; }
    setResult(null); setCommand(request); save.mutate(request);
  }
  useEffect(() => {
    if (retryRequested > 0 && initialized) { changeInclusion(false); onRetryHandled(productId, retryRequested); }
  }, [retryRequested, initialized]); // eslint-disable-line react-hooks/exhaustive-deps
  const job = status.data ?? result?.job;
  const jobIssue = job && ["needs_attention", "awaiting_evidence"].includes(job.state)
    ? job.issue ?? resolveEbayListingIssue({ code: job.code, message: job.message, productId, jobId: job.id, state: job.state }) : null;
  const requestIssue = save.isError && command ? listingIssueFromError(save.error, productId) : null;
  const withdrawalActive = currentJob?.operation === "withdraw" && ["queued", "running", "recovering", "awaiting_evidence"].includes(currentJob.state);
  return <div className="flex flex-col gap-1 items-start" onClick={event => event.stopPropagation()}>
    <Switch checked={!excluded} disabled={disabled || !initialized || !!command || !!storageError || save.isPending || withdrawalActive}
      onCheckedChange={changeInclusion} title={excluded ? "Include in eBay listings" : "Exclude from eBay listings"} aria-label={`${excluded ? "Include" : "Exclude"} ${productName} ${excluded ? "in" : "from"} eBay listings`} />
    {(command || storageError) && <Button variant="link" className="h-auto min-h-9 p-0 text-xs whitespace-normal text-left" onClick={() => setOpen(true)}>Check saved request</Button>}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{command?.excluded || result?.excluded ? "Remove listing from eBay" : "eBay listing inclusion"}</DialogTitle><DialogDescription>{productName}. Local inclusion and confirmed removal from eBay are tracked separately.</DialogDescription></DialogHeader>
      {storageError && <div role="alert" className="space-y-2 text-sm"><p>{storageError}</p><Button variant="outline" onClick={loadSavedRequest}>Load saved request</Button></div>}
      {save.isPending && <p role="status">Saving the listing request…</p>}
      {command && !save.isPending && <div className="space-y-3 text-sm">
        <p role="status">The result of this request is not confirmed yet.</p><p>A missing response does not prove that eBay removed the listing. Checking or retrying below uses the same saved request.</p>
        {requestIssue && <EbayListingIssueCard issue={requestIssue} onAction={requestIssue.action.kind === "retry_sync" ? undefined : issue => {
          setOpen(false); onIssueAction(issue, productId, issue.reference);
        }} />}
        {receipt.isError && <p role="alert">The saved receipt could not be confirmed. Check it again or retry this same request.</p>}
        <div className="flex gap-2 flex-wrap"><Button variant="outline" disabled={receipt.isFetching} onClick={() => receipt.refetch()}>Check saved request</Button>
          {(!requestIssue || requestIssue.retryable || requestIssue.code === "EBAY_LISTING_OPERATION_FAILED") && <Button disabled={receipt.isFetching} onClick={() => save.mutate(command)}>Retry same request</Button>}</div>
        <p className="text-xs text-muted-foreground break-all">Request reference: {command.commandKey}</p>
      </div>}
      {result && <div className="space-y-3 text-sm">
        <p role="status">{job?.state === "completed" ? "Removed from eBay. The provider's listing state is verified." : result.remoteAction === "included" ? "Included. Sync this product to create or update its channel listing and check any remaining requirements." : result.remoteAction === "local_exclusion" ? "Excluded from future publishing. No provider removal was performed by this request." : jobIssue ? "Exclusion saved. Removal from eBay needs the next step below." : "Exclusion saved. Removing the listing from eBay; completion is not yet confirmed."}</p>
        {jobIssue?.action.kind === "review_mapping" ? <EbayWithdrawalIssueCard issue={jobIssue} busy={status.isFetching}
          onCheck={() => void status.refetch()} onRetry={job?.state === "needs_attention" ? () => changeInclusion(false) : undefined} /> : jobIssue && <EbayListingIssueCard issue={jobIssue} onAction={issue => {
          if (issue.action.kind === "retry_sync" && issue.retryable) changeInclusion(false);
          else { setOpen(false); onIssueAction(issue, productId, job?.id); }
        }} />}
        {!result.excluded && !result.syncBatchId && <Button onClick={() => { setOpen(false); onSync(); }}>Sync product</Button>}
        {status.isError && <p role="alert">The latest removal status could not be loaded. Refresh the saved status; do not assume the listing has ended.</p>}
        {job && <Button variant="outline" disabled={status.isFetching} onClick={() => status.refetch()}>Refresh removal status</Button>}
      </div>}
      <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
    </DialogContent></Dialog>
  </div>;
}
