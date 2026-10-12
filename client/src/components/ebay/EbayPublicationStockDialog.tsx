import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ebayPublicationStockApplySchema, ebayPublicationStockReviewSchema, ebayPublicationStockResultSchema, ebayPublicationStockRefusalSchema,
  type EbayPublicationStockApply, type EbayPublicationStockResult } from "@shared/types/ebay-publication-stock";
import { ebayListingSyncJobSchema, type EbayListingSyncJob } from "@shared/types/ebay-listing-sync";
import type { EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { apiRequest } from "@/lib/queryClient";
import { listingIssueFromError } from "@/lib/ebay-listing-issue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EbayListingIssueCard } from "./EbayListingIssueCard";

interface Props {
  productId: number;
  productName: string;
  onClose: () => void;
  onQueued: (job: EbayListingSyncJob) => void;
  onIssueAction: (issue: EbayListingIssue, productId: number, jobId?: string) => void;
}

function stockCorrectionLink(action: string, productId: number, inventoryHref: string) {
  if (action === "reconnect") return { href: "/channels/ebay#connection", label: "Open connection settings" };
  if (action === "review_variant") return { href: `/products/${productId}?tab=variants`, label: "Open product variants" };
  return { href: inventoryHref, label: "Open this product's stock setup" };
}

/** Review quantities supplied by the inventory owner. This screen neither
 * calculates availability nor changes warehouse stock. */
export function EbayPublicationStockDialog({ productId, productName, onClose, onQueued, onIssueAction }: Props) {
  const queryClient = useQueryClient();
  const path = `/api/ebay/listings/products/${productId}/publication-readiness`;
  const storageKey = `ebay:publication-stock:${productId}`;
  const [initialized, setInitialized] = useState(false);
  const [storageFailure, setStorageFailure] = useState<"read" | "write" | null>(null);
  const [command, setCommand] = useState<EbayPublicationStockApply | null>(null);
  const [result, setResult] = useState<EbayPublicationStockResult | null>(null);
  const [applyIssue, setApplyIssue] = useState<EbayListingIssue | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);

  function loadSavedRequest() {
    try {
      const stored = sessionStorage.getItem(storageKey);
      setCommand(stored ? ebayPublicationStockApplySchema.parse(JSON.parse(stored)) : null);
      setStorageFailure(null);
    } catch { setStorageFailure("read"); }
    setInitialized(true);
  }
  useEffect(loadSavedRequest, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const review = useQuery({
    queryKey: [path],
    queryFn: async () => {
      const value = ebayPublicationStockReviewSchema.parse(await (await apiRequest("GET", path)).json());
      if (value.productId !== productId || value.inventory.productId !== productId) throw new Error("The stock review belongs to another product.");
      return value;
    },
    enabled: initialized && storageFailure !== "read" && !command && !result && !reviewRequired,
    retry: false, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false,
  });
  function validate(value: unknown, request: EbayPublicationStockApply) {
    const parsed = ebayPublicationStockResultSchema.parse(value);
    if (parsed.receipt.productId !== productId || parsed.job.productId !== productId || parsed.job.operation !== "publish" ||
      parsed.receipt.commandKey !== request.commandKey || parsed.receipt.reviewHash !== request.expectedReviewHash) {
      throw new Error("The stock setup receipt does not match this product and request. Check the saved request before trying again.");
    }
    return parsed;
  }
  function accept(value: EbayPublicationStockResult) {
    setResult(value); setCommand(null); setApplyIssue(null);
    try { sessionStorage.removeItem(storageKey); } catch { /* Retained commands replay their immutable receipt on reopen. */ }
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
    onQueued(value.job);
  }
  function handleFailure(error: unknown, receiptOnly = false) {
    if (!receiptOnly) setApplyIssue(listingIssueFromError(error, productId));
    try {
      const response: unknown = JSON.parse(error instanceof Error ? error.message.replace(/^\d{3}:\s*/, "") : "");
      // Only an immutable server refusal under the apply command lock proves
      // this UUID cannot later commit. A code or an HTTP status alone does not.
      if (!ebayPublicationStockRefusalSchema.safeParse(response).success) return;
      setApplyIssue(listingIssueFromError(error, productId));
      setReviewRequired(true); setCommand(null);
      try { sessionStorage.removeItem(storageKey); } catch { /* Saved refusals replay safely. */ }
    } catch { /* Unknown outcomes retain the exact command for receipt checks. */ }
  }
  const apply = useMutation({
    mutationFn: async (request: EbayPublicationStockApply) => validate(await (await apiRequest("POST", `${path}/apply`, request)).json(), request),
    onSuccess: accept,
    onError: error => handleFailure(error),
  });
  const receipt = useQuery({
    queryKey: [path, "commands", command?.commandKey, command?.expectedReviewHash],
    queryFn: async () => {
      if (!command) throw new Error("No saved stock request is available.");
      return validate(await (await apiRequest("GET", `${path}/commands/${command.commandKey}`)).json(), command);
    },
    enabled: initialized && !!command && !apply.isPending, retry: false, staleTime: 0, refetchInterval: command ? 10_000 : false,
  });
  useEffect(() => { if (receipt.data && command) accept(receipt.data); }, [receipt.data, command]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (receipt.isError && command) handleFailure(receipt.error, true); }, [receipt.error, receipt.isError, command]); // eslint-disable-line react-hooks/exhaustive-deps
  function submit() {
    if (!initialized || storageFailure === "read") return;
    if (command) { setApplyIssue(null); apply.mutate(command); return; }
    if (!review.data?.canApply || !review.data.allowedToApply || !review.data.inventory.ready || review.isError || review.isFetching || reviewRequired) return;
    const request = ebayPublicationStockApplySchema.parse({ commandKey: crypto.randomUUID(), expectedReviewHash: review.data.reviewHash });
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setStorageFailure("write"); return; }
    setStorageFailure(null); setCommand(request); setApplyIssue(null); apply.mutate(request);
  }
  async function recheck() {
    const refreshed = await review.refetch();
    if (refreshed.isSuccess) { setReviewRequired(false); setApplyIssue(null); }
  }
  function handleReviewIssue(issue: EbayListingIssue) {
    if (issue.action.kind === "review_publication_stock") void recheck();
    else { onClose(); onIssueAction(issue, productId, issue.reference); }
  }
  const status = useQuery({
    queryKey: [path, "publication", result?.job.id],
    queryFn: async () => {
      const value = z.object({ job: ebayListingSyncJobSchema }).parse(await (await apiRequest("GET", `/api/ebay/listings/sync-jobs/${result?.job.id}`)).json());
      if (value.job.id !== result?.job.id || value.job.productId !== productId || value.job.operation !== "publish") throw new Error("The publication status belongs to another request.");
      return value.job;
    },
    enabled: !!result, retry: false,
    refetchInterval: query => query.state.data?.state === "completed" ? false : 10_000,
  });
  useEffect(() => {
    if (!status.data) return;
    void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"], exact: true });
    if (status.data.state === "completed") void queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
  }, [status.data, queryClient]);
  const job = status.data ?? result?.job;
  const jobIssue = job && job.state !== "completed" && job.code
    ? job.issue ?? resolveEbayListingIssue({ code: job.code, message: job.message, productId, jobId: job.id, state: job.state }) : null;
  const data = review.data;
  const inventoryHref = data ? `/channels/inventory?channel=${data.inventory.channelId}${data.inventory.publicationTargetId ? `&destination=${data.inventory.publicationTargetId}` : ""}&product=${productId}` : "/channels/inventory";
  const canApply = initialized && data?.canApply && data.allowedToApply && data.inventory.ready && storageFailure !== "read" && !review.isFetching && !review.isError && !reviewRequired;

  return <Dialog open onOpenChange={open => { if (!open && !apply.isPending) onClose(); }}><DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
    <DialogHeader><DialogTitle>Connect stock and publish on eBay</DialogTitle><DialogDescription>{productName}</DialogDescription></DialogHeader>
    {storageFailure && <div role="alert" className="space-y-2 text-sm">
      <p>{storageFailure === "read" ? "Your browser could not read the saved request. An earlier stock setup may have been sent. Allow browser storage and load that request before applying another change." : "Your browser could not save retry details, so no request was sent. Allow browser storage and try again."}</p>
      {storageFailure === "read" && <Button variant="outline" onClick={loadSavedRequest}>Load saved request</Button>}
    </div>}
    {result && job ? <div className="space-y-3 text-sm">
      <p role="status" className="font-medium">{job.state === "completed" ? "Published on eBay. Listing and pictures verified." : job.state === "needs_attention" || job.state === "awaiting_evidence" ? "Stock setup saved. Publishing needs the next step below." : "Stock setup saved. Publishing is queued or running; publication is not yet confirmed."}</p>
      {job.state !== "completed" && <p>You can close this dialog and follow the saved publishing status in the listing feed.</p>}
      {jobIssue && <EbayListingIssueCard issue={jobIssue} onAction={issue => { onClose(); onIssueAction(issue, productId, job.id); }} />}
      {status.isError && <p role="alert">The latest publishing status could not be loaded. Refresh this saved request to check its result.</p>}
      <Button variant="outline" className="min-h-11" disabled={status.isFetching} onClick={() => status.refetch()}>Refresh publishing status</Button>
    </div> : command ? <div className="space-y-3 text-sm">
      <p role="status">{apply.isPending ? "Saving stock setup and publishing request…" : "Checking whether your stock setup and publishing request were saved."}</p>
      <p>A missing response does not prove the request failed. Checking or retrying below uses the same request, preserving its original stock review.</p>
      {receipt.isError && <p>No receipt could be confirmed. Check again or retry this same request.</p>}
      {applyIssue && <EbayListingIssueCard issue={applyIssue}
        onAction={applyIssue.action.kind === "check_status" ? issue => { onClose(); onIssueAction(issue, productId, issue.reference); } : undefined} />}
      <div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={apply.isPending || receipt.isFetching} onClick={() => receipt.refetch()}>Check saved request</Button>
        <Button className="min-h-11" disabled={apply.isPending || receipt.isFetching} onClick={submit}>Retry same request</Button></div>
      <p className="text-xs text-muted-foreground break-all">Request reference: {command.commandKey}</p>
    </div> : <div className="space-y-4 text-sm">
      {(!initialized || (review.isLoading && storageFailure !== "read")) && <p role="status">Checking stock setup and current quantities…</p>}
      {review.isError && <div role="alert"><p>The current stock plan could not be checked. No change was sent.</p><EbayListingIssueCard issue={listingIssueFromError(review.error, productId)} onAction={handleReviewIssue} /></div>}
      {applyIssue && <EbayListingIssueCard issue={applyIssue} onAction={handleReviewIssue} />}
      {reviewRequired && <p role="alert">This request was rejected without applying the stock plan. Recheck the current setup and review it before submitting another request.</p>}
      {data && <>
        <section className="space-y-2"><h2 className="font-semibold">{data.inventory.ready ? data.inventory.currentlyReady ? "Stock setup is already connected" : "The stock setup can be connected" : "Stock setup needs a correction"}</h2>
          <p>These quantities come from the inventory availability calculation. Publishing uses current inventory again when the saved request runs.</p>
          <p className="text-xs text-muted-foreground">Checked {new Date(data.observedAt).toLocaleString()}</p></section>
        <div className="space-y-2">{data.inventory.variants.map(variant => <section key={variant.productVariantId} className="rounded-md border p-3 space-y-2 min-w-0" aria-label={`Stock plan for ${variant.sku}`}>
          <h3 className="font-semibold break-all">{variant.sku}</h3>
          <p><span className="font-medium">Available to list now: </span>{variant.desiredQuantity ?? "Unavailable until the issue below is corrected"}{variant.desiredQuantity !== null ? " selling units" : ""}</p>
          <p>{variant.mappingAction === "create" ? "Connect this eBay SKU to its catalog inventory." : variant.mappingAction === "promote_draft" ? "Activate the existing draft inventory connection." : "No inventory connection change is proposed."}</p>
          <p>{variant.membershipAction === "include" ? "Include this SKU in the channel's stock publication." : "This SKU is already included in stock publication."}</p>
        </section>)}</div>
        {data.inventory.blockers.length > 0 && <section className="space-y-3" aria-label="Stock setup issues"><h3 className="font-semibold">Resolve before publishing</h3>{data.inventory.blockers.map((blocker, index) => {
          const variant = data.inventory.variants.find(row => row.productVariantId === blocker.productVariantId);
          const correctionLink = stockCorrectionLink(blocker.action, productId, inventoryHref);
          return <div key={`${blocker.code}-${index}`} className="border rounded-md p-3 space-y-2">
            {variant && <p className="font-medium break-all">{variant.sku}</p>}<p>{blocker.message}</p>
            {blocker.action === "refresh" ? <Button variant="outline" className="min-h-11" disabled={review.isFetching} onClick={() => void recheck()}>Recheck stock setup</Button> : <Button asChild variant="outline" className="min-h-11"><a href={correctionLink.href} target="_blank" rel="noopener noreferrer">{correctionLink.label}</a></Button>}
            <p className="text-xs text-muted-foreground break-all">Code: {blocker.code}</p>
          </div>;
        })}</section>}
        {data.effects.length > 0 && <section className="rounded-md bg-muted p-3 space-y-2"><h3 className="font-medium">What this action will do</h3><ul className="list-disc pl-5 space-y-1">{data.effects.map(effect => <li key={effect}>{effect}</li>)}</ul></section>}
        {!data.allowedToApply && <p role="status">You can review this plan. Applying it requires {data.requiredPermission ?? "permission to manage inventory publication"}. A team member with that permission can open this product's stock review and apply it.</p>}
      </>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" disabled={!initialized || review.isFetching || storageFailure === "read"} onClick={() => void recheck()}>Recheck stock setup</Button>
        {data && <Button className="min-h-11" disabled={!canApply || apply.isPending} onClick={submit}>{data.inventory.currentlyReady ? "Publish using current stock setup" : "Connect stock and publish"}</Button>}</div>
    </div>}
    <Button variant="outline" className="min-h-11" disabled={apply.isPending} onClick={onClose}>Close</Button>
  </DialogContent></Dialog>;
}
