import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ebayListingPushCommandSchema, ebayListingPushResponseSchema, type EbayListingPushCommand, type EbayListingPushResponse } from "@shared/types/ebay-listing-push";
import { ebayListingSyncJobSchema, type EbayListingSyncJob } from "@shared/types/ebay-listing-sync";
import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { apiRequest } from "@/lib/queryClient";
import { listingSyncIssueFromError } from "@/lib/ebay-listing-issue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EbayListingIssueCard } from "./EbayListingIssueCard";

interface PushProgressModalProps {
  open: boolean;
  onClose: () => void;
  productIds: number[];
  onIssueAction?: (issue: EbayListingIssue, productId: number, jobId?: string) => void;
}

const storageKey = (productId: number) => `ebay:publication-command:${productId}`;
const jobResponse = z.object({ job: ebayListingSyncJobSchema });

/** Saves publication commands before sending them. A disconnected browser only
 * stops observing; the durable job owns publication and provider recovery. */
export function PushProgressModal({ open, onClose, productIds, onIssueAction }: PushProgressModalProps) {
  const queryClient = useQueryClient();
  const started = useRef(false);
  const [commands, setCommands] = useState<EbayListingPushCommand[]>([]);
  const [jobs, setJobs] = useState<Map<number, EbayListingSyncJob>>(new Map());
  const [response, setResponse] = useState<EbayListingPushResponse | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  function rememberJobs(saved: EbayListingSyncJob[]) {
    if (!saved.length) return;
    setJobs(previous => new Map([...previous, ...saved.map(job => [job.productId, job] as const)]));
    // An exact command can be older than another user's latest request. Keep it
    // in this modal, but reload the authoritative latest-per-product feed.
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"], exact: true });
    for (const job of saved) {
      try { sessionStorage.removeItem(storageKey(job.productId)); } catch { /* Replaying a saved command remains safe. */ }
    }
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
  }
  const save = useMutation({
    mutationFn: async (requested: EbayListingPushCommand[]) => {
      const parsed = ebayListingPushResponseSchema.parse(await (await apiRequest("POST", "/api/ebay/listings/push", {
        productIds: requested.map(command => command.productId), commands: requested,
      })).json());
      const expected = new Set(requested.map(command => command.productId));
      if (parsed.results.length !== expected.size || new Set(parsed.results.map(result => result.productId)).size !== expected.size ||
        parsed.results.some(result => !expected.has(result.productId) || (result.job && (result.job.productId !== result.productId || result.job.operation !== "publish")))) {
        throw new Error("The publishing response did not match the requested products. Check the saved requests before trying again.");
      }
      return parsed;
    },
    onSuccess: value => { setResponse(value); rememberJobs(value.results.flatMap(result => result.job ? [result.job] : [])); },
  });

  function start() {
    const pending: EbayListingPushCommand[] = [];
    try {
      for (const productId of productIds) {
        const stored = sessionStorage.getItem(storageKey(productId));
        const command = stored ? ebayListingPushCommandSchema.parse(JSON.parse(stored)) : { productId, commandKey: crypto.randomUUID() };
        if (command.productId !== productId) throw new Error("Saved request belongs to another product");
        // Persist all commands before any POST. If storage fails, no new request
        // is sent; previously stored commands are reused after storage recovers.
        sessionStorage.setItem(storageKey(productId), JSON.stringify(command));
        pending.push(command);
      }
    } catch {
      setStorageError("Your browser could not read or save the publishing retry details. An earlier request may have been sent. Allow browser storage, then retry loading the saved requests; no new request was sent by this attempt.");
      return;
    }
    setStorageError(null); setCommands(pending); save.mutate(pending);
  }
  useEffect(() => { if (open && productIds.length && !started.current) { started.current = true; start(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = useQuery({
    queryKey: ["/api/ebay/listings/sync-jobs", "publication-requests", commands.map(command => command.commandKey).join(",")],
    queryFn: async () => Promise.all(commands.map(async command => {
      try {
        const parsed = jobResponse.parse(await (await apiRequest("GET", `/api/ebay/listings/sync-jobs/${jobs.get(command.productId)?.id ?? command.commandKey}`)).json());
        if (parsed.job.productId !== command.productId || parsed.job.operation !== "publish") throw new Error("The saved publishing status belongs to a different request.");
        return { productId: command.productId, job: parsed.job, error: null };
      } catch (error) {
        return { productId: command.productId, job: null, error: error instanceof Error ? error.message : "Publishing status could not be checked." };
      }
    })),
    enabled: open && commands.length > 0 && !save.isPending,
    retry: false, staleTime: 0,
    refetchInterval: jobs.size === productIds.length && [...jobs.values()].every(job => ["completed", "needs_attention", "awaiting_evidence"].includes(job.state)) ? false : 10_000,
  });
  useEffect(() => { if (status.data) rememberJobs(status.data.flatMap(item => item.job ? [item.job] : [])); }, [status.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const unresolved = commands.filter(command => !jobs.has(command.productId));
  const saveIssue = save.isError && commands[0] ? listingSyncIssueFromError(save.error, commands[0].productId) : null;
  const retryableRequests = unresolved.filter(command => {
    if (saveIssue && !saveIssue.retryable) return false;
    const result = response?.results.find(item => item.productId === command.productId);
    return !result || result.status !== "error" || (result.issue ?? resolveEbayListingIssue({ code: result.code, message: result.error, productId: command.productId })).retryable;
  });
  const completed = [...jobs.values()].filter(job => job.state === "completed").length;
  const needsAttention = [...jobs.values()].some(job => ["needs_attention", "awaiting_evidence"].includes(job.state)) || response?.results.some(result => result.status === "error");
  return <Dialog open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{completed === productIds.length ? "Published on eBay" : needsAttention ? "Publishing needs attention" : "Publishing on eBay"}</DialogTitle>
        <DialogDescription>Publishing continues after you close this window. A listing is complete only after its publication and pictures have been verified.</DialogDescription></DialogHeader>
      {storageError && <div role="alert" className="space-y-2 text-sm"><p>{storageError}</p><Button variant="outline" className="min-h-11" onClick={start}>Retry loading saved requests</Button></div>}
      {save.isPending && <p role="status">Saving publishing requests…</p>}
      {saveIssue && unresolved.length > 0 && <div role="alert" className="space-y-2 text-sm"><EbayListingIssueCard issue={saveIssue} /></div>}
      <div className="space-y-3">
        {productIds.map(productId => {
          const result = response?.results.find(item => item.productId === productId);
          const job = jobs.get(productId);
          const issue = job && ["needs_attention", "awaiting_evidence"].includes(job.state)
            ? job.issue ?? resolveEbayListingIssue({ code: job.code, message: job.message, productId, jobId: job.id, state: job.state })
            : !job && result?.status === "error" ? result.issue ?? resolveEbayListingIssue({ code: result.code, message: result.error, productId }) : null;
          const readError = status.data?.find(item => item.productId === productId)?.error;
          return <section key={productId} className="rounded-md border p-3 space-y-2 text-sm">
            <h3 className="font-medium">{result?.productName ?? `Product ${productId}`}</h3>
            <p role="status">{job?.state === "completed" ? "Published. Listing and pictures verified." : job?.code === "EBAY_PUBLICATION_READBACK_PENDING" ? "eBay accepted publication. Checking the published listing and pictures automatically." : issue ? "Publishing paused — follow the next step below." : job?.state === "recovering" ? "Publishing — automatically checking the interrupted update." : job ? "Publishing — queued or running. Publication is not yet confirmed." : "Checking whether the publishing request was saved."}</p>
            {issue && <EbayListingIssueCard issue={issue} onAction={onIssueAction ? action => { onClose(); onIssueAction(action, productId, job?.id); } : undefined} />}
            {readError && (!job || !readError.startsWith("404:")) && <p role="alert">{readError.startsWith("404:") ? "No saved request was found yet. Refresh its status or follow the next step above." : "The latest publishing status could not be loaded. Refresh the saved status below."}</p>}
          </section>;
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {commands.length > 0 && <Button variant="outline" className="min-h-11" disabled={status.isFetching || save.isPending} onClick={() => void status.refetch()}>Refresh publishing status</Button>}
        {retryableRequests.length > 0 && !save.isPending && <Button className="min-h-11" disabled={status.isFetching} onClick={() => save.mutate(retryableRequests)}>Retry saved publishing requests</Button>}
        <Button variant="outline" className="min-h-11" onClick={onClose}>Close</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
