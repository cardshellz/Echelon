/**
 * SyncProgressModal — Real-time eBay sync progress via SSE
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { type EbayListingIssue } from "@shared/types/ebay-listing-issue";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { EbayListingIssueCard } from "./EbayListingIssueCard";
import { ebaySyncProgressEventSchema, type EbaySyncProgressEvent } from "@/lib/ebay-listing-progress";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  X,
} from "lucide-react";

type SyncCompleteEvent = Extract<EbaySyncProgressEvent, { type: "complete" }>;
type SyncResult = Omit<Extract<EbaySyncProgressEvent, { type: "progress" }>, "type" | "current" | "total">;

interface SyncProgressModalProps {
  open: boolean;
  onClose: () => void;
  productIds?: number[];
  onIssueAction?: (issue: EbayListingIssue, productId: number, jobId?: string) => void;
}

export function SyncProgressModal({ open, onClose, productIds, onIssueAction }: SyncProgressModalProps) {
  const queryClient = useQueryClient();
  const [results, setResults] = useState<SyncResult[]>([]);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalIssue, setGlobalIssue] = useState<EbayListingIssue | null>(null);
  const [summary, setSummary] = useState<SyncCompleteEvent["summary"] | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  // Event handlers outlive the render that opened the stream.
  const finishedRef = useRef(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [results]);

  useEffect(() => {
    if (!open) return;

    setResults([]);
    setCurrent(0);
    setTotal(0);
    setIsComplete(false);
    setIsCancelled(false);
    setGlobalError(null);
    setGlobalIssue(null);
    setSummary(null);
    finishedRef.current = false;

    const url =
      productIds && productIds.length > 0
        ? `/api/ebay/listings/sync-stream?productIds=${productIds.join(",")}`
        : `/api/ebay/listings/sync-stream`;

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = ebaySyncProgressEventSchema.parse(JSON.parse(event.data));
        switch (data.type) {
          case "progress":
            setCurrent(data.current);
            setTotal(data.total);
            setResults((prev) => [
              ...prev,
              {
                product: data.product,
                productId: data.productId,
                status: data.status,
                changes: data.changes,
                error: data.error,
                issue: data.issue,
                jobId: data.jobId,
              },
            ]);
            break;
          case "complete":
            finishedRef.current = true;
            // Admission/storage failure can prevent a job (and a progress event)
            // from existing. Its per-product result still needs a visible fix path.
            setResults((previous) => {
              const result = [...previous];
              const included = new Set(result.map((entry) => entry.productId));
              for (const detail of data.summary.details ?? []) {
                if (detail.success || !detail.productId || included.has(detail.productId)) continue;
                included.add(detail.productId);
                result.push({ productId: detail.productId, product: detail.productName ?? `Product ${detail.productId}`,
                  status: "error", error: detail.error,
                  issue: detail.issue ?? resolveEbayListingIssue({ code: detail.code, message: detail.error, productId: detail.productId }),
                });
              }
              return result;
            });
            setIsComplete(true);
            setSummary(data.summary);
            setIsCancelled(data.cancelled);
            es.close();
            queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
            queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
            queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"] });
            break;
          case "error":
            finishedRef.current = true;
            setGlobalError(data.error);
            setGlobalIssue(data.issue ?? resolveEbayListingIssue({ message: data.error }));
            setIsComplete(true);
            es.close();
            break;
        }
      } catch {
        finishedRef.current = true;
        setGlobalError("Sync progress could not be read. Close this window and refresh the saved sync status before trying again.");
        setIsComplete(true);
        es.close();
      }
    };

    es.onerror = () => {
      if (!finishedRef.current) {
        finishedRef.current = true;
        setGlobalError("Progress connection closed. Accepted sync jobs continue in the background; check the listing for saved status.");
        setIsComplete(true);
        queryClient.invalidateQueries({ queryKey: ["/api/ebay/listings/sync-jobs"] });
        queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
      }
      es.close();
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [open, productIds?.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancel = useCallback(() => {
    finishedRef.current = true;
    setIsCancelled(true);
    setIsComplete(true);
    eventSourceRef.current?.close();
  }, []);

  const handleClose = useCallback(() => {
    eventSourceRef.current?.close();
    onClose();
  }, [onClose]);

  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "error").length;
  const progressPercent = total > 0 ? (current / total) * 100 : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-lg w-full mx-2 sm:mx-auto max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-6 pb-0">
          <DialogTitle className="text-base sm:text-lg">
            {isComplete
              ? isCancelled
                ? "Progress View Closed"
                : globalError
                ? "Sync Error"
                : summary?.errors ? "Sync needs attention" : summary?.pending ? "Sync Saved — Processing" : "Sync Complete"
              : "Syncing eBay Listings..."}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col px-4 sm:px-6 pb-4 sm:pb-6 gap-3">
          {/* Summary banner */}
          {isComplete && summary && !globalError && (
            <div
              className={`rounded-lg p-3 text-sm ${
                summary.errors === 0
                  ? "bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300"
                  : summary.synced > 0
                  ? "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                  : "bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300"
              }`}
            >
              <p className="font-medium">
                {summary.synced} listing{summary.synced !== 1 ? "s" : ""} synced
                {summary.priceChanges > 0 &&
                  ` · ${summary.priceChanges} price update${summary.priceChanges !== 1 ? "s" : ""}`}
                {summary.qtyChanges > 0 &&
                  ` · ${summary.qtyChanges} qty update${summary.qtyChanges !== 1 ? "s" : ""}`}
                {summary.policyChanges > 0 &&
                  ` · ${summary.policyChanges} policy update${summary.policyChanges !== 1 ? "s" : ""}`}
                {summary.errors > 0 &&
                  ` · ${summary.errors} error${summary.errors !== 1 ? "s" : ""}`}
                {(summary.pending ?? 0) > 0 && ` · ${summary.pending} saved for processing`}
              </p>
              {isCancelled && (
                <p className="text-xs mt-1 opacity-75">Saved sync jobs continue in the background.</p>
              )}
            </div>
          )}

          {/* Global error */}
          {globalError && (globalIssue
            ? <EbayListingIssueCard issue={globalIssue} />
            : <div role="alert" className="rounded-lg p-3 bg-amber-50 text-amber-900 text-sm">{globalError}</div>)}

          {/* Progress bar */}
          {!isComplete && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Syncing {current}/{total > 0 ? total : "..."}...</span>
                {total > 0 && <span>{Math.round(progressPercent)}%</span>}
              </div>
              <Progress value={progressPercent} className="h-2" />
            </div>
          )}

          {/* Running counts */}
          <div className="flex items-center gap-3 flex-wrap text-xs">
            {succeeded > 0 && (
              <Badge className="bg-green-600 hover:bg-green-600 text-xs gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {succeeded} synced
              </Badge>
            )}
            {failed > 0 && (
              <Badge variant="destructive" className="text-xs gap-1">
                <XCircle className="h-3 w-3" />
                {failed} failed
              </Badge>
            )}
            {!isComplete && current > 0 && total > 0 && (
              <span className="text-muted-foreground ml-auto">
                {current} of {total}
              </span>
            )}
          </div>

          {/* Results log */}
          {(results.length > 0 || !isComplete) && <div className="flex-1 overflow-y-auto border rounded-lg min-h-[150px] max-h-[400px]">
            <div className="divide-y">
              {results.map((result, i) => (
                <div key={`${result.productId}-${i}`} className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    {result.status === "success" ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
                    ) : result.status === "pending" ? (
                      <Loader2 className="h-4 w-4 text-blue-600 shrink-0 mt-0.5 animate-spin" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{result.product}</span>
                        {result.status === "success" &&
                          result.changes &&
                          result.changes.length > 0 && (
                            <span className="text-xs text-muted-foreground">
                              — {result.changes.join(", ")} updated
                            </span>
                          )}
                        {result.status === "success" &&
                          (!result.changes || result.changes.length === 0) && (
                            <span className="text-xs text-muted-foreground">— no changes</span>
                          )}
                      </div>
                      {result.status === "pending" && <p className="text-xs mt-1">Update saved. Check the listing for progress; you can close this window.</p>}
                      {result.status === "error" && <div className="mt-2"><EbayListingIssueCard
                        issue={result.issue ?? resolveEbayListingIssue({ message: result.error, productId: result.productId, jobId: result.jobId })}
                        onAction={onIssueAction ? (issue) => { handleClose(); onIssueAction(issue, result.productId, result.jobId); } : undefined}
                      /></div>}
                    </div>
                  </div>
                </div>
              ))}
              {!isComplete && results.length === 0 && (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Starting sync...
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          </div>}

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {!isComplete && (
              <Button
                variant="destructive"
                size="sm"
                className="min-h-[44px] sm:min-h-0"
                onClick={handleCancel}
              >
                <X className="h-4 w-4 mr-1" />
                Stop viewing
              </Button>
            )}
            {isComplete && (
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] sm:min-h-0 ml-auto"
                onClick={handleClose}
              >
                Close
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
