/**
 * PushProgressModal — Real-time eBay push progress via SSE
 *
 * Shows a modal with:
 * - Progress bar
 * - Live log of results per product
 * - Running counts (succeeded, failed, skipped)
 * - Cancel button
 * - On completion: summary, retry failed button
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
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
  SkipForward,
  Loader2,
  X,
  RefreshCw,
  Clock,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";

// ============================================================================
// Types
// ============================================================================

interface ProgressEvent {
  type: "progress";
  product: string;
  productId: number;
  status: "success" | "error" | "skipped";
  error?: string;
  variantsListed?: number;
  listingId?: string;
  current: number;
  total: number;
  variantDetails?: Array<{ sku: string; success: boolean; error?: string }>;
}

interface RateLimitEvent {
  type: "rate_limited";
  waitSeconds: number;
  product: string;
  productId: number;
}

interface CompleteEvent {
  type: "complete";
  summary: {
    succeeded: number;
    failed: number;
    skipped: number;
    total: number;
  };
  cancelled: boolean;
}

interface ErrorEvent {
  type: "error";
  error: string;
}

type PushEvent = ProgressEvent | RateLimitEvent | CompleteEvent | ErrorEvent;

interface PushResult {
  product: string;
  productId: number;
  status: "success" | "error" | "skipped";
  error?: string;
  variantsListed?: number;
  listingId?: string;
  variantDetails?: Array<{ sku: string; success: boolean; error?: string }>;
}

// ============================================================================
// Props
// ============================================================================

interface PushProgressModalProps {
  open: boolean;
  onClose: () => void;
  productIds: number[];
  onRetryFailed?: (failedIds: number[]) => void;
}

// ============================================================================
// Component
// ============================================================================

export function PushProgressModal({
  open,
  onClose,
  productIds,
  onRetryFailed,
}: PushProgressModalProps) {
  const queryClient = useQueryClient();
  const [results, setResults] = useState<PushResult[]>([]);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(productIds.length);
  const [isComplete, setIsComplete] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [rateLimitMessage, setRateLimitMessage] = useState<string | null>(null);
  const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());
  const [summary, setSummary] = useState<{ succeeded: number; failed: number; skipped: number; total: number } | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest result
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [results]);

  // Start SSE when modal opens
  useEffect(() => {
    if (!open || productIds.length === 0) return;

    // Reset state
    setResults([]);
    setCurrent(0);
    setTotal(productIds.length);
    setIsComplete(false);
    setIsCancelled(false);
    setGlobalError(null);
    setRateLimitMessage(null);
    setExpandedErrors(new Set());
    setSummary(null);

    const idsParam = productIds.join(",");
    const es = new EventSource(`/api/ebay/listings/push-stream?productIds=${idsParam}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data: PushEvent = JSON.parse(event.data);

        switch (data.type) {
          case "progress":
            setCurrent(data.current);
            setTotal(data.total);
            setRateLimitMessage(null);
            setResults((prev) => [
              ...prev,
              {
                product: data.product,
                productId: data.productId,
                status: data.status,
                error: data.error,
                variantsListed: data.variantsListed,
                listingId: data.listingId,
                variantDetails: data.variantDetails,
              },
            ]);
            break;

          case "rate_limited":
            setRateLimitMessage(`Rate limited — waiting ${data.waitSeconds}s...`);
            break;

          case "complete":
            setIsComplete(true);
            setSummary(data.summary);
            setIsCancelled(data.cancelled);
            setRateLimitMessage(null);
            es.close();
            // Invalidate feed data
            queryClient.invalidateQueries({ queryKey: ["/api/ebay/listing-feed"] });
            queryClient.invalidateQueries({ queryKey: ["/api/ebay/effective-prices"] });
            break;

          case "error":
            setGlobalError(data.error);
            setIsComplete(true);
            es.close();
            break;
        }
      } catch (e) {
        console.error("[PushProgress] Failed to parse SSE event:", e);
      }
    };

    es.onerror = () => {
      if (!isComplete) {
        setGlobalError("Connection lost. Check server logs for push status.");
        setIsComplete(true);
      }
      es.close();
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [open, productIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancel = useCallback(() => {
    setIsCancelled(true);
    eventSourceRef.current?.close();
    // The server will detect the closed connection and stop processing
  }, []);

  const handleClose = useCallback(() => {
    eventSourceRef.current?.close();
    onClose();
  }, [onClose]);

  const handleRetryFailed = useCallback(() => {
    const failedIds = results
      .filter((r) => r.status === "error")
      .map((r) => r.productId);
    if (failedIds.length > 0 && onRetryFailed) {
      handleClose();
      onRetryFailed(failedIds);
    }
  }, [results, onRetryFailed, handleClose]);

  const toggleErrorExpanded = (productId: number) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "error").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  const progressPercent = total > 0 ? (current / total) * 100 : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-lg w-full mx-2 sm:mx-auto max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-6 pb-0">
          <DialogTitle className="text-base sm:text-lg">
            {isComplete
              ? isCancelled
                ? "Push Cancelled"
                : globalError
                ? "Push Error"
                : "Push Complete"
              : "Pushing to eBay..."
            }
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col px-4 sm:px-6 pb-4 sm:pb-6 gap-3">
          {/* Summary banner (when complete) */}
          {isComplete && summary && !globalError && (
            <div className={`rounded-lg p-3 text-sm ${
              summary.failed === 0 ? "bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300" :
              summary.succeeded > 0 ? "bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300" :
              "bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300"
            }`}>
              <p className="font-medium">
                {summary.total} product{summary.total !== 1 ? "s" : ""} processed:
                {summary.succeeded > 0 && ` ${summary.succeeded} listed`}
                {summary.failed > 0 && `${summary.succeeded > 0 ? "," : ""} ${summary.failed} failed`}
                {summary.skipped > 0 && `, ${summary.skipped} skipped`}
              </p>
              {isCancelled && <p className="text-xs mt-1 opacity-75">Push was cancelled before completion.</p>}
            </div>
          )}

          {/* Global error */}
          {globalError && (
            <div className="rounded-lg p-3 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 text-sm">
              <p className="font-medium">Error</p>
              <p className="text-xs mt-1">{globalError}</p>
            </div>
          )}

          {/* Progress bar */}
          {!isComplete && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Pushing {current}/{total}...</span>
                <span>{Math.round(progressPercent)}%</span>
              </div>
              <Progress value={progressPercent} className="h-2" />
              {rateLimitMessage && (
                <div className="flex items-center gap-1.5 text-xs text-amber-600">
                  <Clock className="h-3 w-3 animate-pulse" />
                  {rateLimitMessage}
                </div>
              )}
            </div>
          )}

          {/* Running counts */}
          <div className="flex items-center gap-3 flex-wrap text-xs">
            {succeeded > 0 && (
              <Badge className="bg-green-600 hover:bg-green-600 text-xs gap-1">
                <CheckCircle2 className="h-3 w-3" />
                {succeeded} listed
              </Badge>
            )}
            {failed > 0 && (
              <Badge variant="destructive" className="text-xs gap-1">
                <XCircle className="h-3 w-3" />
                {failed} failed
              </Badge>
            )}
            {skippedCount > 0 && (
              <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
                <SkipForward className="h-3 w-3" />
                {skippedCount} skipped
              </Badge>
            )}
            {!isComplete && current > 0 && (
              <span className="text-muted-foreground ml-auto">
                {current} of {total}
              </span>
            )}
          </div>

          {/* Results log */}
          <div className="flex-1 overflow-y-auto border rounded-lg min-h-[150px] max-h-[400px]">
            <div className="divide-y">
              {results.map((result, i) => (
                <div key={`${result.productId}-${i}`} className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    {result.status === "success" && (
                      <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0 mt-0.5" />
                    )}
                    {result.status === "error" && (
                      <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                    )}
                    {result.status === "skipped" && (
                      <SkipForward className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{result.product}</span>
                        {result.status === "success" && result.variantsListed && (
                          <span className="text-xs text-muted-foreground">
                            — {result.variantsListed} variant{result.variantsListed !== 1 ? "s" : ""} listed
                          </span>
                        )}
                        {result.status === "success" && result.listingId && (
                          <a
                            href={`https://www.ebay.com/itm/${result.listingId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-500 hover:text-blue-700"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {result.status === "skipped" && result.error && (
                          <span className="text-xs text-muted-foreground">— {result.error}</span>
                        )}
                      </div>
                      {result.status === "error" && result.error && (
                        <div className="mt-1">
                          <button
                            className="flex items-center gap-1 text-xs text-red-600 hover:text-red-700"
                            onClick={() => toggleErrorExpanded(result.productId)}
                          >
                            {expandedErrors.has(result.productId) ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                            {expandedErrors.has(result.productId) ? "Hide error" : "Show error"}
                          </button>
                          {expandedErrors.has(result.productId) && (
                            <p className="text-xs text-red-600/80 mt-1 font-mono break-all bg-red-50 dark:bg-red-950/20 rounded p-2">
                              {result.error}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {!isComplete && results.length === 0 && (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Starting push...
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {!isComplete && (
              <Button
                variant="destructive"
                size="sm"
                className="min-h-[44px] sm:min-h-0"
                onClick={handleCancel}
              >
                <X className="h-4 w-4 mr-1" />
                Cancel
              </Button>
            )}
            {isComplete && failed > 0 && onRetryFailed && (
              <Button
                variant="default"
                size="sm"
                className="min-h-[44px] sm:min-h-0"
                onClick={handleRetryFailed}
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                Retry Failed ({failed})
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
