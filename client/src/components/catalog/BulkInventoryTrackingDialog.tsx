import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { BULK_INVENTORY_TRACKING_PATH, bulkInventoryTrackingPreviewSchema, bulkInventoryTrackingResultSchema,
  type BulkInventoryTrackingPreview, type BulkInventoryTrackingResult } from "@shared/catalog/bulk-inventory-tracking";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InventoryTrackingBlockerDetails } from "./InventoryTrackingBlockerDetails";

class InventoryTrackingRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
const reviewRequiredCodes = new Set([
  "BULK_INVENTORY_PREVIEW_STALE", "BULK_INVENTORY_TRACKING_BLOCKED",
  "INVENTORY_POLICY_HAS_DEPENDENCIES", "CATALOG_PRODUCT_MISSING", "CATALOG_VARIANT_IDENTITY_CHANGED",
]);
async function readResult<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const failure = z.object({ error: z.string(), code: z.string().optional() }).safeParse(body);
    throw new InventoryTrackingRequestError(failure.success ? failure.data.error : "The request failed. Try again.",
      failure.success ? failure.data.code : undefined);
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new InventoryTrackingRequestError("The server returned an invalid response. Refresh and review the selection again.");
  return result.data;
}

export function BulkInventoryTrackingDialog({ productIds, onClose, onApplied }: {
  productIds: number[];
  onClose: () => void;
  onApplied: (result: BulkInventoryTrackingResult, remainingProductIds: number[]) => void;
}) {
  const [next, setNext] = useState(false);
  const [preview, setPreview] = useState<BulkInventoryTrackingPreview | null>(null);
  const [commandKey, setCommandKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewProductIds, setReviewProductIds] = useState(productIds);
  const [showBlockedOnly, setShowBlockedOnly] = useState(false);
  const review = useMutation({
    mutationFn: async (ids: number[]) => readResult(await fetch(`${BULK_INVENTORY_TRACKING_PATH}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productIds: ids, inventoryTrackingDefault: next }),
    }), bulkInventoryTrackingPreviewSchema),
    onMutate: ids => { setReviewProductIds(ids); setShowBlockedOnly(false); setError(null); setPreview(null); setCommandKey(null); },
    onSuccess: result => { setPreview(result); setCommandKey(crypto.randomUUID()); },
    onError: (failure: Error) => setError(failure.message),
  });
  const apply = useMutation({
    mutationFn: async () => {
      if (!preview || !commandKey) throw new Error("Review the selection before applying changes.");
      return readResult(await fetch(`${BULK_INVENTORY_TRACKING_PATH}/apply`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": commandKey },
        body: JSON.stringify({ productIds: reviewProductIds, inventoryTrackingDefault: preview.inventoryTrackingDefault, expectedPreviewHash: preview.previewHash }),
      }), bulkInventoryTrackingResultSchema);
    },
    onMutate: () => setError(null),
    onSuccess: result => {
      const completed = new Set([...result.changedProductIds, ...result.unchangedProductIds]);
      onApplied(result, productIds.filter(id => !completed.has(id)));
    },
    onError: (failure: Error) => {
      setError(failure.message);
      if (failure instanceof InventoryTrackingRequestError && reviewRequiredCodes.has(failure.code ?? "")) {
        setPreview(null); setCommandKey(null);
      }
      // An uncertain transport result retains this exact request and command
      // key. Retrying returns its saved result rather than applying it again.
    },
  });
  const busy = review.isPending || apply.isPending;
  const changedCount = preview?.products.filter(product => product.status === "change").length ?? 0;
  const blockedCount = preview?.products.filter(product => product.status === "blocked").length ?? 0;
  const overrides = preview?.products.reduce((sum, product) => sum + product.trackedOverrideCount + product.untrackedOverrideCount, 0) ?? 0;
  const excludedCount = productIds.length - reviewProductIds.length;
  const eligibleIds = preview?.products.filter(product => product.status !== "blocked").map(product => product.productId) ?? [];

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>Bulk inventory tracking</DialogTitle>
        <DialogDescription>Change the default for {productIds.length} selected products. Variant overrides remain unchanged.</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="bulk-inventory-tracking-default">Product inventory default</Label>
        <Select value={String(next)} disabled={busy} onValueChange={value => {
          setNext(value === "true"); setReviewProductIds(productIds); setShowBlockedOnly(false); setPreview(null); setCommandKey(null); setError(null);
        }}>
          <SelectTrigger id="bulk-inventory-tracking-default" data-testid="bulk-inventory-default"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="false">Do not track inventory</SelectItem>
            <SelectItem value="true">Track inventory</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">Products without variants use this default directly. Inheriting variants follow it; explicit variant choices are kept. Existing orders keep their recorded policy.</p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {excludedCount > 0 && <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="bulk-inventory-excluded">
        <p>Reviewing {reviewProductIds.length} of {productIds.length} selected products. {excludedCount} excluded products will stay unchanged and selected for follow-up.</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => review.mutate(productIds)}>Review full selection</Button>
      </div>}
      {preview && <div className="space-y-3" data-testid="bulk-inventory-review">
        <p className="text-sm">{changedCount} products to change · {preview.products.filter(product => product.status === "unchanged").length} already set · {overrides} variant overrides preserved</p>
        {blockedCount > 0 && <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">{blockedCount} products have blockers. No products will change from this review. Review eligible products separately or resolve the blockers below.</p>
          <div className="flex flex-wrap gap-2">
            {changedCount > 0 && <Button variant="outline" size="sm" disabled={busy} onClick={() => review.mutate(eligibleIds)}>Review eligible products only ({eligibleIds.length})</Button>}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setShowBlockedOnly(value => !value)}>{showBlockedOnly ? "Show all products" : "Show blockers only"}</Button>
          </div>
        </div>}
        <ul className="max-h-80 overflow-y-auto divide-y rounded-md border">
          {preview.products.filter(product => !showBlockedOnly || product.status === "blocked").map(product => <li key={product.productId} className="p-3 space-y-2" data-testid={`bulk-inventory-product-${product.productId}`}>
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium text-sm">{product.name}</span>
              <Badge variant={product.status === "blocked" ? "destructive" : "secondary"}>{product.status === "change" ? "Will change" : product.status === "unchanged" ? "Already set" : "Blocked"}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{product.sku ?? `Product ${product.productId}`} · {product.currentDefault === null ? "Unavailable" : product.currentDefault ? "Tracks inventory" : "Does not track inventory"}
              {product.status === "change" && ` → ${next ? "Track inventory" : "Do not track inventory"}`}</p>
            <p className="text-xs text-muted-foreground">{product.variantCount === 0 ? "No variants — product default applies directly." : `${product.changingVariantCount} variants change; ${product.trackedOverrideCount} explicit Track and ${product.untrackedOverrideCount} explicit Do not track overrides are kept.`}</p>
            {product.blockers.map((blocker, index) => <InventoryTrackingBlockerDetails key={`${blocker.variantId}-${blocker.code}-${index}`} blocker={blocker} />)}
          </li>)}
        </ul>
      </div>}
      <DialogFooter className="gap-2">
        <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant={preview ? "outline" : "default"} disabled={busy} onClick={() => review.mutate(reviewProductIds)}>{review.isPending ? "Reviewing…" : preview ? "Refresh review" : "Review changes"}</Button>
        {preview && <Button disabled={busy || blockedCount > 0 || changedCount === 0} onClick={() => apply.mutate()} data-testid="bulk-inventory-apply">
          {apply.isPending ? "Applying…" : `Apply to ${changedCount} products`}
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
