import { useEffect, useState } from "react";
import type { ListingReview } from "@shared/types/channel-listing-publication";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { money } from "./model";

interface Props {
  review: ListingReview;
  submitting: boolean;
  error: string;
  onClose(): void;
  onSubmit(): void;
}

export function ListingReviewDialog({
  review,
  submitting,
  error,
  onClose,
  onSubmit,
}: Props) {
  const [expired, setExpired] = useState(
    Date.parse(review.expiresAt) <= Date.now(),
  );
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(review.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [review.expiresAt]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Review {review.items.length} Walmart items</DialogTitle>
          <DialogDescription>
            These exact variants and prices will be submitted to{" "}
            {review.account.market} · {review.account.environment}. Account{" "}
            {review.account.accountId}, fulfillment center{" "}
            {review.account.scopeId}.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">Stock publishing</p>
          <p className="mt-1 text-muted-foreground">
            {review.inventory.message}
          </p>
          <a
            className="mt-2 inline-block underline"
            href="/channels/inventory"
            target="_blank"
            rel="noreferrer"
          >
            Open Channel Inventory
          </a>
        </div>
        {review.issues.length > 0 && (
          <ul
            role="alert"
            className="list-disc space-y-1 pl-5 text-sm text-destructive"
          >
            {review.issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                {issue.message}
                {issue.field ? ` (${issue.field})` : ""}
              </li>
            ))}
          </ul>
        )}
        <div className="divide-y">
          {review.items.map((item) => (
            <div key={item.variantId} className="space-y-2 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{item.title}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {item.sku}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {item.unitLabel} ·{" "}
                    {item.method === "match"
                      ? "Match existing catalog product"
                      : "Create product"}
                    {item.productType ? ` · ${item.productType}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-medium">{money(item.priceCents)}</p>
                  <Badge
                    variant={item.issues.length ? "destructive" : "secondary"}
                  >
                    {item.issues.length ? "Needs attention" : "Ready to submit"}
                  </Badge>
                </div>
              </div>
              {item.issues.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-destructive">
                  {item.issues.map((issue, index) => (
                    <li key={`${issue.code}-${index}`}>
                      {issue.message}
                      {issue.field ? ` (${issue.field})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Walmart processes submissions asynchronously. Submission acceptance
          does not mean the item is live or stock is available.
        </p>
        {expired && (
          <p role="alert" className="text-sm text-destructive">
            This review has expired. Close it and review the draft again.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={onClose}>
            Back to draft
          </Button>
          <Button
            disabled={
              submitting ||
              expired ||
              !review.canSubmit ||
              review.items.length === 0
            }
            onClick={onSubmit}
          >
            {submitting
              ? "Submitting…"
              : `Publish ${review.items.length} items`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
