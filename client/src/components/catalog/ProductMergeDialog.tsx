import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  PRODUCT_MERGE_EXECUTE_PATH,
  PRODUCT_MERGE_PREVIEW_PATH,
  PRODUCT_MERGE_RESUME_PATH,
  TERMINAL_PRODUCT_MERGE_STATUSES,
  productMergePreviewSchema,
  productMergeRunSchema,
  type ProductMergePreview,
  type ProductMergeRun,
} from "@shared/catalog/product-merge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

class MergeRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

async function readResult<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = z.object({ error: z.string(), code: z.string().optional() }).safeParse(body);
    throw new MergeRequestError(failure.success ? failure.data.error : "The request failed. Try again.",
      failure.success ? failure.data.code : undefined);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new MergeRequestError("The server returned an invalid response. Refresh and try again.");
  return parsed.data;
}

const productSearchSchema = z.array(z.object({ id: z.number(), sku: z.string().nullable().optional(), name: z.string() }).passthrough());

const RUN_STATUS_TEXT: Record<ProductMergeRun["status"], string> = {
  releasing: "Releasing order holds",
  merging: "Moving stock and orders",
  reclaiming: "Re-reserving orders",
  compensating: "Restoring order holds",
  completed: "Merged",
  completed_with_review: "Merged — some orders need review",
  failed: "Not merged — nothing was moved",
};

/**
 * "Merge into…" for a duplicate product. The current product is the SOURCE:
 * its stock, open orders, open PO lines, supplier links and bins move to the
 * chosen target, and it is archived. The target keeps its channel links.
 */
export function ProductMergeDialog({ product, onClose, onMerged }: {
  product: { id: number; sku: string | null; name: string };
  onClose: () => void;
  onMerged: (targetProductId: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<{ id: number; sku: string | null; name: string } | null>(null);
  const [adoptSourceSku, setAdoptSourceSku] = useState(true);
  const [pairOverrides, setPairOverrides] = useState<Record<number, number>>({});
  const [preview, setPreview] = useState<ProductMergePreview | null>(null);
  const [commandKey, setCommandKey] = useState<string | null>(null);
  const [run, setRun] = useState<ProductMergeRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const results = useQuery({
    queryKey: ["product-merge-target-search", search],
    enabled: search.trim().length >= 2 && !target,
    queryFn: async () => readResult(await fetch(`/api/products?q=${encodeURIComponent(search.trim())}&limit=10`), productSearchSchema),
  });

  // A new target discards the plan; any other change keeps it visible but
  // requires "Check again" before the merge can run.
  const [stale, setStale] = useState(false);
  useEffect(() => { setPreview(null); setCommandKey(null); setPairOverrides({}); }, [target]);
  useEffect(() => { setStale(true); }, [adoptSourceSku, pairOverrides]);

  const requestBody = useMemo(() => {
    if (!target) return null;
    const overrides = Object.entries(pairOverrides);
    return {
      targetProductId: target.id,
      adoptSourceSku,
      ...(overrides.length > 0 && preview ? {
        variantPairs: preview.pairs.map(pair => ({
          sourceVariantId: pair.source.id,
          targetVariantId: pairOverrides[pair.source.id] ?? pair.target?.id ?? 0,
        })).filter(pair => pair.targetVariantId > 0),
      } : {}),
    };
  }, [target, adoptSourceSku, pairOverrides, preview]);

  const review = useMutation({
    mutationFn: async () => readResult(await fetch(PRODUCT_MERGE_PREVIEW_PATH(product.id), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody),
    }), productMergePreviewSchema),
    onMutate: () => setError(null),
    onSuccess: result => { setPreview(result); setStale(false); setCommandKey(crypto.randomUUID()); },
    onError: (failure: Error) => setError(failure.message),
  });

  const execute = useMutation({
    mutationFn: async () => {
      if (!preview || !commandKey || !requestBody) throw new MergeRequestError("Review the merge first.");
      // Re-sending with the same Idempotency-Key continues the same run.
      return readResult(await fetch(PRODUCT_MERGE_EXECUTE_PATH(product.id), {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": commandKey },
        body: JSON.stringify({ ...requestBody, expectedPreviewHash: preview.previewHash }),
      }), productMergeRunSchema);
    },
    onMutate: () => setError(null),
    onSuccess: result => setRun(result),
    onError: (failure: Error) => setError(failure.message),
  });

  const resume = useMutation({
    mutationFn: async () => {
      if (!run) throw new MergeRequestError("No merge run to resume.");
      return readResult(await fetch(PRODUCT_MERGE_RESUME_PATH(run.id), { method: "POST" }), productMergeRunSchema);
    },
    onMutate: () => setError(null),
    onSuccess: result => setRun(result),
    onError: (failure: Error) => setError(failure.message),
  });

  const finished = run !== null && TERMINAL_PRODUCT_MERGE_STATUSES.includes(run.status);
  const busy = review.isPending || execute.isPending || resume.isPending;

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="dialog-product-merge">
        <DialogHeader>
          <DialogTitle>Merge {product.sku ?? product.name} into another product</DialogTitle>
          <DialogDescription>
            Use this when two products are the same physical item. This product's stock, open orders, open purchase
            orders, supplier links and bins move to the product you choose, and this product is archived. Shipped
            orders and stock history stay on the archived product.
          </DialogDescription>
        </DialogHeader>

        {!run && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="merge-target-search">Merge into</Label>
              {target ? (
                <div className="flex items-center justify-between rounded border p-2">
                  <span><span className="font-mono">{target.sku}</span> — {target.name}</span>
                  <Button variant="ghost" size="sm" onClick={() => setTarget(null)} disabled={busy}>Change</Button>
                </div>
              ) : (
                <>
                  <Input id="merge-target-search" placeholder="Search by SKU or name" value={search}
                    onChange={event => setSearch(event.target.value)} data-testid="input-merge-target-search" />
                  {results.data && (
                    <div className="max-h-48 overflow-y-auto rounded border">
                      {results.data.filter(row => row.id !== product.id).map(row => (
                        <button key={row.id} type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                          onClick={() => setTarget({ id: row.id, sku: row.sku ?? null, name: row.name })}
                          data-testid={`button-merge-target-${row.id}`}>
                          <span className="font-mono">{row.sku}</span> — {row.name}
                        </button>
                      ))}
                      {results.data.length === 0 && <p className="p-3 text-sm text-muted-foreground">No products found.</p>}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-start gap-2">
              <Checkbox id="merge-adopt-sku" checked={adoptSourceSku} onCheckedChange={value => setAdoptSourceSku(value === true)}
                data-testid="checkbox-merge-adopt-sku" />
              <Label htmlFor="merge-adopt-sku" className="font-normal leading-snug">
                Rename the surviving product to <span className="font-mono">{product.sku}</span> (and its SKUs to match).
                Keep this on when the channels already use the new SKU.
              </Label>
            </div>

            {preview && stale && <p className="text-sm text-amber-600">Settings changed. Check again before merging.</p>}
            {preview && <MergePreviewDetails preview={preview} overrides={pairOverrides}
              onOverride={(sourceId, targetId) => setPairOverrides(current => ({ ...current, [sourceId]: targetId }))} />}
          </div>
        )}

        {run && <MergeRunDetails run={run} />}

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

        <DialogFooter>
          {!run && (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="outline" onClick={() => review.mutate()} disabled={!target || busy} data-testid="button-merge-review">
                {review.isPending ? "Checking…" : preview ? "Check again" : "Review merge"}
              </Button>
              <Button variant="destructive" onClick={() => execute.mutate()}
                disabled={!preview || stale || preview.status !== "ready" || busy} data-testid="button-merge-confirm">
                {execute.isPending ? "Merging…" : `Merge into ${target?.sku ?? "target"}`}
              </Button>
            </>
          )}
          {run && !finished && (
            <Button onClick={() => resume.mutate()} disabled={busy} data-testid="button-merge-resume">
              {resume.isPending ? "Resuming…" : "Resume merge"}
            </Button>
          )}
          {run && finished && (
            <Button onClick={() => run.status === "failed" ? onClose() : onMerged(run.targetProductId)} data-testid="button-merge-done">
              {run.status === "failed" ? "Close" : "Open merged product"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MergePreviewDetails({ preview, overrides, onOverride }: {
  preview: ProductMergePreview;
  overrides: Record<number, number>;
  onOverride: (sourceVariantId: number, targetVariantId: number) => void;
}) {
  const targetOptions = preview.pairs.map(pair => pair.target).filter((value): value is NonNullable<typeof value> => value !== null);
  return (
    <div className="space-y-4 text-sm" data-testid="merge-preview">
      <div className="rounded border p-3">
        <p>After the merge, <span className="font-mono">{preview.target.sku}</span> becomes{" "}
          <span className="font-mono font-semibold">{preview.resultingTargetProductSku}</span>. This product is archived as{" "}
          <span className="font-mono">{preview.resultingSourceProductSku}</span>.</p>
      </div>

      <table className="w-full text-left">
        <thead><tr className="border-b"><th className="py-1">This product's SKU</th><th>Moves to</th><th>Units each</th><th>On hand moving</th><th>Becomes</th></tr></thead>
        <tbody>
          {preview.pairs.map(pair => (
            <tr key={pair.source.id} className="border-b">
              <td className="py-1 font-mono">{pair.source.sku}</td>
              <td>
                {pair.target && !(pair.source.id in overrides) ? <span className="font-mono">{pair.target.sku}</span> : (
                  <Select value={overrides[pair.source.id] ? String(overrides[pair.source.id]) : undefined}
                    onValueChange={value => onOverride(pair.source.id, Number(value))}>
                    <SelectTrigger className="h-8 w-44"><SelectValue placeholder="Choose SKU" /></SelectTrigger>
                    <SelectContent>
                      {targetOptions.map(option => <SelectItem key={option.id} value={String(option.id)}>{option.sku}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </td>
              <td>{pair.source.unitsPerVariant}{pair.target && pair.target.unitsPerVariant !== pair.source.unitsPerVariant
                ? ` → ${pair.target.unitsPerVariant}` : ""}</td>
              <td>{pair.stock.onHand}{pair.stock.reserved > 0 ? ` (${pair.stock.reserved} held for orders)` : ""}</td>
              <td className="font-mono">{pair.resultingTargetSku ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="list-disc pl-5 space-y-1">
        <li>{preview.openOrders.total} open order line(s) move. Their stock holds are released and re-reserved on the merged product.</li>
        <li>{preview.purchaseOrderLines.total} open purchase order line(s) and {preview.supplierLinks} supplier link(s) move.</li>
        <li>Kept on the archived product as history: {preview.historyRetained.shippedOrderLines} shipped order line(s) and{" "}
          {preview.historyRetained.inventoryTransactions} inventory transaction(s).</li>
      </ul>

      {preview.openOrders.records.length > 0 && (
        <div>
          <p className="font-medium">Open orders</p>
          <ul className="pl-5">
            {preview.openOrders.records.map(order => (
              <li key={`${order.wmsOrderId}-${order.omsOrderId}-${order.sourceVariantId}`}>
                {order.orderNumber ?? order.wmsOrderId} · qty {order.quantity} · {order.warehouseStatus ?? "not yet in warehouse"}{" "}
                {!order.movable && <Badge variant="destructive">in progress</Badge>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.blockers.length > 0 ? (
        <div className="rounded border border-destructive p-3" role="alert" data-testid="merge-blockers">
          <p className="font-medium text-destructive">This merge can't run yet:</p>
          <ul className="list-disc pl-5">{preview.blockers.map((blocker, index) => <li key={index}>{blocker.message}</li>)}</ul>
        </div>
      ) : <Badge>Ready to merge</Badge>}
    </div>
  );
}

function MergeRunDetails({ run }: { run: ProductMergeRun }) {
  return (
    <div className="space-y-3 text-sm" data-testid="merge-run">
      <p className="font-medium">{RUN_STATUS_TEXT[run.status]}</p>
      {run.errorMessage && <p className="text-destructive">{run.errorMessage}</p>}
      {run.result && (
        <ul className="list-disc pl-5">
          <li>{run.result.stockUnitsMoved} unit(s) of stock moved from {run.result.stockLocationsMoved} location(s)</li>
          <li>{run.result.orderLinesMoved} open order line(s) moved</li>
          <li>{run.result.purchaseOrderLinesMoved} purchase order line(s), {run.result.supplierLinksMoved} supplier link(s) and{" "}
            {run.result.binAssignmentsMoved} bin assignment(s) moved</li>
          <li>Surviving product SKU: <span className="font-mono">{run.result.targetProductSku}</span>{" "}
            ({run.result.variantsRenamed} variant SKU(s) renamed)</li>
        </ul>
      )}
      {run.orders.some(order => order.errorCode || order.released === false) && (
        <div>
          <p className="font-medium">Orders to check</p>
          <ul className="pl-5">
            {run.orders.filter(order => order.errorCode || order.released === false).map(order => (
              <li key={order.wmsOrderId}>Order {order.wmsOrderId}: {order.errorMessage
                ?? "had no stock held before the merge, so it was not re-reserved automatically"}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
