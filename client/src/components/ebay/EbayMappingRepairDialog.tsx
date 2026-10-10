import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  ebayListingMappingApplySchema, ebayListingMappingReviewSchema, ebayListingMappingResultSchema, mappingRepairFailureDisposition,
  type EbayListingMappingApply, type EbayListingMappingResult, type EbayListingMappingRow,
} from "@shared/types/ebay-listing-mapping";
import { ebayListingSyncJobSchema, type EbayListingSyncJob } from "@shared/types/ebay-listing-sync";
import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { apiRequest } from "@/lib/queryClient";
import { listingIssueFromError } from "@/lib/ebay-listing-issue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EbayListingIssueCard } from "./EbayListingIssueCard";

interface EbayMappingRepairDialogProps {
  productId: number;
  productName: string;
  onClose: () => void;
  onQueued: (job: EbayListingSyncJob) => void;
  onReviewRegisteredListing: () => Promise<void>;
  onIssueAction: (issue: EbayListingIssue, productId: number, jobId?: string) => void;
}

const rowLabels: Record<EbayListingMappingRow["problem"], string> = {
  matches: "Mapping verified", mapping_missing: "Saved mapping is incomplete", offer_changed: "eBay offer changed",
  listing_changed: "eBay listing changed", unpublished: "Offer is not published", missing: "Offer was not found",
  ambiguous: "More than one matching offer", read_failed: "eBay could not be checked", invalid_response: "eBay returned incomplete details",
  membership_changed: "Listing variants changed",
};

function safeActionHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    if (href.startsWith("/") && !href.includes("\\")) {
      const relative = new URL(href, "https://echelon.invalid");
      if (relative.origin === "https://echelon.invalid") return `${relative.pathname}${relative.search}${relative.hash}`;
      return undefined;
    }
    const url = new URL(href);
    if (url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "ebay.com" || url.hostname.endsWith(".ebay.com"))) return url.href;
  } catch { /* Invalid links are rendered as text, never navigated. */ }
  return undefined;
}

function MappingRow({ row }: { row: EbayListingMappingRow }) {
  return <section className="rounded-md border p-3 space-y-3 min-w-0">
    <div><h3 className="font-semibold break-all">{row.catalogSku}</h3><p className="text-sm">{rowLabels[row.problem]}</p></div>
    <div className="grid gap-3 sm:grid-cols-2 text-xs">
      <div className="min-w-0"><h4 className="font-medium mb-1">Saved in Echelon</h4><dl className="space-y-1 break-all">
        <div><dt className="inline text-muted-foreground">eBay SKU: </dt><dd className="inline">{row.savedSku ?? "Not saved"}</dd></div>
        <div><dt className="inline text-muted-foreground">Offer ID: </dt><dd className="inline">{row.savedOfferId ?? "Not saved"}</dd></div>
        <div><dt className="inline text-muted-foreground">Listing ID: </dt><dd className="inline">{row.savedListingId ?? "Not saved"}</dd></div>
      </dl></div>
      <div className="min-w-0"><h4 className="font-medium mb-1">Current eBay details</h4>
        {row.observedOffers.length === 0 ? <p>No matching offer was verified by this check.</p> : row.observedOffers.map((offer) => <dl key={offer.offerId} className="space-y-1 break-all mb-2">
          <div><dt className="inline text-muted-foreground">eBay SKU: </dt><dd className="inline">{offer.sku ?? "Not returned"}</dd></div>
          <div><dt className="inline text-muted-foreground">Offer ID: </dt><dd className="inline">{offer.offerId}</dd></div>
          <div><dt className="inline text-muted-foreground">Listing ID: </dt><dd className="inline">{offer.listingId ?? "Not returned"}</dd></div>
          <div><dt className="inline text-muted-foreground">Offer status: </dt><dd className="inline">{offer.status === "PUBLISHED" ? "Published" : "Unpublished"}{offer.listingStatus ? ` · ${offer.listingStatus}` : ""}</dd></div>
        </dl>)}
      </div>
    </div>
    <p className="text-sm"><span className="font-medium">Recommended fix: </span>{row.recommendation}</p>
  </section>;
}

export function EbayMappingRepairDialog({ productId, productName, onClose, onQueued, onReviewRegisteredListing, onIssueAction }: EbayMappingRepairDialogProps) {
  const queryClient = useQueryClient();
  const resourcePath = `/api/ebay/listings/products/${productId}`;
  const storageKey = `ebay:mapping-repair:${productId}`;
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageFailure, setStorageFailure] = useState<"read" | "write" | null>(null);
  const [command, setCommand] = useState<EbayListingMappingApply | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [result, setResult] = useState<EbayListingMappingResult | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [applyIssue, setApplyIssue] = useState<EbayListingIssue | null>(null);
  const registeredListingReview = useMutation({ mutationFn: onReviewRegisteredListing });
  function loadSavedCommand() {
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) setCommand(ebayListingMappingApplySchema.parse(JSON.parse(stored)));
      setStorageError(null); setStorageFailure(null);
    } catch {
      setStorageFailure("read");
      setStorageError("Your browser could not read the saved retry details. An earlier fix may have been sent. Allow browser storage, then retry loading the saved request before applying another fix.");
    }
    setInitialized(true);
  }
  useEffect(loadSavedCommand, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const review = useQuery({
    queryKey: [resourcePath, "mapping-review"],
    queryFn: async () => {
      const value = ebayListingMappingReviewSchema.parse(await (await apiRequest("GET", `${resourcePath}/mapping-review`)).json());
      if (value.productId !== productId) throw new Error("The mapping review belongs to a different product.");
      return value;
    },
    enabled: initialized && storageFailure !== "read" && !command && !result, retry: false, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false,
  });

  function acceptResult(value: unknown, requestedCommand: EbayListingMappingApply): EbayListingMappingResult {
    const parsed = ebayListingMappingResultSchema.parse(value);
    if (parsed.receipt.productId !== productId || parsed.job.productId !== productId || parsed.receipt.commandKey !== requestedCommand.commandKey || parsed.receipt.reviewHash !== requestedCommand.reviewHash) {
      throw new Error("The repair receipt does not match this product and request. Check the saved request before trying again.");
    }
    return parsed;
  }
  function rememberResult(value: EbayListingMappingResult) {
    setResult(value); setCommand(null); setApplyIssue(null);
    try { sessionStorage.removeItem(storageKey); } catch { /* Retaining a completed command is safe: its receipt is replayed on reopen. */ }
    queryClient.setQueryData<EbayListingSyncJob[]>(["/api/ebay/listings/sync-jobs"], (previous = []) =>
      [value.job, ...previous.filter((job) => job.productId !== productId)]);
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    onQueued(value.job);
  }
  const receipt = useQuery({
    queryKey: [resourcePath, "mapping-repairs", command?.commandKey, command?.reviewHash],
    queryFn: async () => {
      if (!command) throw new Error("No saved repair request is available.");
      return acceptResult(await (await apiRequest("GET", `${resourcePath}/mapping-repairs/${command.commandKey}`)).json(), command);
    },
    enabled: initialized && command !== null && result === null, retry: false, staleTime: 0, refetchInterval: 10_000,
  });
  useEffect(() => { if (receipt.data && command) rememberResult(receipt.data); }, [receipt.data, command]); // eslint-disable-line react-hooks/exhaustive-deps

  function requireNewReview(issue: EbayListingIssue) {
    setApplyIssue(issue); setReviewRequired(true); setCommand(null);
    try { sessionStorage.removeItem(storageKey); } catch { /* A journaled refusal remains safely replayable if storage is unavailable. */ }
  }
  useEffect(() => {
    if (!command || !receipt.isError) return;
    const issue = listingIssueFromError(receipt.error, productId);
    if (mappingRepairFailureDisposition(issue.code) === "review_again") requireNewReview(issue);
  }, [receipt.error, receipt.isError, command]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = useMutation({
    mutationFn: async (request: EbayListingMappingApply) => acceptResult(
      await (await apiRequest("POST", `${resourcePath}/mapping-review`, request)).json(), request),
    onSuccess: rememberResult,
    onError: (error) => {
      const issue = listingIssueFromError(error, productId);
      setApplyIssue(issue);
      // The server journals these refusals under the same command lock as a
      // successful repair. Unknown outcomes retain their original command.
      if (mappingRepairFailureDisposition(issue.code) === "review_again") requireNewReview(issue);
    },
  });
  function submitFix() {
    if (!initialized || storageFailure === "read") return;
    if (command) { setApplyIssue(null); apply.mutate(command); return; }
    const current = review.data;
    if (!current?.canApply || !current.allowedToApply || !current.reviewHash ||
      !["apply_fix", "resume_sync"].includes(current.action.kind) || review.isFetching || review.isError || reviewRequired) return;
    const nextCommand = { reviewHash: current.reviewHash, commandKey: crypto.randomUUID() };
    try {
      // Save before sending: closing/reloading after a lost response must use
      // this exact command, never create a second repair from an old review.
      sessionStorage.setItem(storageKey, JSON.stringify(nextCommand));
    } catch {
      setStorageFailure("write");
      setStorageError("Your browser could not save retry details, so the fix was not sent. Allow browser storage and try again.");
      return;
    }
    setStorageError(null); setStorageFailure(null); setCommand(nextCommand); setApplyIssue(null); apply.mutate(nextCommand);
  }
  async function recheck() {
    const refreshed = await review.refetch();
    if (refreshed.isSuccess) { setReviewRequired(false); setApplyIssue(null); }
  }
  const savedJob = useQuery({
    queryKey: ["/api/ebay/listings/sync-jobs", "mapping-repair", result?.job.id],
    queryFn: async () => {
      const parsed = z.object({ job: ebayListingSyncJobSchema }).parse(await (await apiRequest("GET", `/api/ebay/listings/sync-jobs/${result?.job.id}`)).json());
      if (parsed.job.productId !== productId || parsed.job.id !== result?.job.id) throw new Error("The saved sync status does not match this repair.");
      return parsed.job;
    },
    enabled: result !== null, retry: false,
    refetchInterval: (query) => query.state.data?.state === "completed" ? false : 10_000,
  });
  const job = savedJob.data ?? result?.job;
  const jobIssue = job && ["awaiting_evidence", "needs_attention"].includes(job.state)
    ? job.issue ?? resolveEbayListingIssue({ code: job.code, message: job.message, productId, jobId: job.id, state: job.state }) : null;
  const reviewData = review.data;
  const canSubmit = initialized && reviewData?.canApply && reviewData.allowedToApply && reviewData.reviewHash &&
    ["apply_fix", "resume_sync"].includes(reviewData.action.kind) && storageFailure !== "read" && !review.isFetching && !review.isError && !reviewRequired;
  return <Dialog open onOpenChange={(open) => { if (!open && !apply.isPending) onClose(); }}>
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Fix eBay listing mapping</DialogTitle><DialogDescription>{productName}</DialogDescription></DialogHeader>
      {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
      {storageFailure === "read" && <Button variant="outline" className="min-h-11" onClick={loadSavedCommand}>Retry loading saved request</Button>}
      {result && job ? <div className="space-y-3 text-sm">
        <p role="status" className="font-medium">{job.state === "completed" ? "Listing sync completed." : jobIssue ? "Mapping request saved. The listing needs the correction below." : "Mapping request saved. Listing sync is queued or running."}</p>
        {job.state !== "completed" && <p>The listing update is not yet confirmed complete. You can close this dialog and follow its saved status in the listing feed.</p>}
        {jobIssue && <EbayListingIssueCard issue={jobIssue} onAction={(issue) => { onClose(); onIssueAction(issue, productId, job.id); }} />}
        {savedJob.isError && <p role="alert">The latest sync status could not be loaded. The saved request is still available; refresh its status below.</p>}
        <Button variant="outline" className="min-h-11" disabled={savedJob.isFetching} onClick={() => savedJob.refetch()}>Refresh sync status</Button>
      </div> : command ? <div className="space-y-3 text-sm">
        <p role="status" className="font-medium">{apply.isPending ? "Saving the mapping fix…" : "Checking whether your fix was saved."}</p>
        <p>A missing response does not tell us whether the fix was applied. Echelon checks this exact request; retrying below uses the same request and cannot create a second repair.</p>
        {receipt.isError && <p>{/^404:/.test(receipt.error instanceof Error ? receipt.error.message : "") ? "No saved receipt was found yet. You can safely retry this request." : "The saved receipt could not be checked. Recheck it or retry the same request."}</p>}
        {applyIssue && <EbayListingIssueCard issue={applyIssue} />}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11" disabled={apply.isPending || receipt.isFetching} onClick={() => receipt.refetch()}>Check saved request</Button>
          <Button className="min-h-11" disabled={apply.isPending || receipt.isFetching} onClick={submitFix}>Retry this fix</Button>
        </div>
        <p className="text-xs text-muted-foreground break-all">Request reference: {command.commandKey}</p>
      </div> : <div className="space-y-4 text-sm">
        {(!initialized || (review.isLoading && storageFailure !== "read")) && <p role="status">Checking the current eBay listing…</p>}
        {review.isError && <div role="alert" className="space-y-2"><p>The current mapping could not be checked. No fix was sent. Recheck before applying a change.</p><EbayListingIssueCard issue={listingIssueFromError(review.error, productId)} /></div>}
        {reviewRequired && <p role="alert">This repair request was rejected. Recheck the current mapping and review the recommended next step before applying another fix.</p>}
        {applyIssue && <EbayListingIssueCard issue={applyIssue} />}
        {reviewData && <>
          <section className="space-y-2"><h2 className="font-semibold">{reviewData.title}</h2><p>{reviewData.explanation}</p><p className="text-xs text-muted-foreground">Checked {new Date(reviewData.observedAt).toLocaleString()}</p></section>
          {reviewData.membership && <section className="rounded-md border p-3 space-y-2 break-words">
            <h3 className="font-medium">Listing variants</h3>
            <p><span className="font-medium">Expected SKUs: </span>{reviewData.membership.expectedSkus.join(", ") || "None"}</p>
            <p><span className="font-medium">SKUs returned by eBay: </span>{reviewData.membership.observedSkus.join(", ") || "None verified"}</p>
            {reviewData.membership.missingSkus.length > 0 && <p><span className="font-medium">Missing from eBay: </span>{reviewData.membership.missingSkus.join(", ")}</p>}
            {reviewData.membership.extraSkus.length > 0 && <p><span className="font-medium">Additional eBay variants: </span>{reviewData.membership.extraSkus.join(", ")}</p>}
            {reviewData.membership.groupKey && <p className="text-xs text-muted-foreground">eBay group: {reviewData.membership.groupKey}</p>}
          </section>}
          {reviewData.rows.map((row) => <MappingRow key={row.variantId} row={row} />)}
          {reviewData.effects.length > 0 && <section className="space-y-2 rounded-md bg-muted p-3"><h3 className="font-medium">What this action will do</h3><ul className="list-disc pl-5 space-y-1">{reviewData.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul></section>}
          {reviewData.manualSteps.length > 0 && <section className="space-y-2"><h3 className="font-medium">Next steps</h3><ol className="list-decimal pl-5 space-y-2">{reviewData.manualSteps.map((step, index) => {
            const href = safeActionHref(step.href);
            return <li key={index}>{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-block underline text-primary py-2 break-words">{step.text} (opens in a new tab)</a> : step.text}</li>;
          })}</ol></section>}
          {reviewData.diagnosticCode && <p className="text-xs text-muted-foreground break-all">Diagnostic code: {reviewData.diagnosticCode}</p>}
          {!reviewData.allowedToApply && ["apply_fix", "resume_sync"].includes(reviewData.action.kind) && <p role="status">You can review this fix, but applying it requires permission to edit channels{reviewData.requiredPermission ? ` (${reviewData.requiredPermission})` : ""}. A team member with that permission can open this product and apply the reviewed fix.</p>}
          {!reviewData.allowedToApply && reviewData.action.kind === "review_registered_listing" && <p role="status">Opening the registered listing change workflow requires permission to edit channels{reviewData.requiredPermission ? ` (${reviewData.requiredPermission})` : ""}. A team member with that permission can review the registered listing for this product.</p>}
        </>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-11" disabled={!initialized || review.isFetching || storageFailure === "read"} onClick={() => void recheck()}>{review.isFetching ? "Checking mapping…" : reviewData?.action.kind === "retry_read" ? reviewData.action.label : "Recheck mapping"}</Button>
          {reviewData?.action.kind === "reconnect" && <Button asChild variant="outline" className="min-h-11"><a href="/channels/ebay#connection" target="_blank" rel="noopener noreferrer">Open connection settings</a></Button>}
          {reviewData?.action.kind === "review_registered_listing" && <Button className="min-h-11" disabled={!reviewData.allowedToApply || registeredListingReview.isPending} onClick={() => registeredListingReview.mutate()}>{registeredListingReview.isPending ? "Loading listing…" : reviewData.action.label}</Button>}
          {reviewData && ["apply_fix", "resume_sync"].includes(reviewData.action.kind) && <Button className="min-h-11" disabled={!canSubmit || apply.isPending} onClick={submitFix}>{reviewData.action.label}</Button>}
        </div>
        {registeredListingReview.isError && <p role="alert">The registered listing review could not be opened. Refresh the listing feed, then try Review registered listing again.</p>}
      </div>}
      <Button variant="outline" className="min-h-11" disabled={apply.isPending} onClick={onClose}>Close</Button>
    </DialogContent>
  </Dialog>;
}
