import React, { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import { format } from "date-fns";
import { supplierReturnOptionsSchema, supplierReturnPreviewInputSchema, supplierReturnRecordInputSchema, type SupplierReturnStockPreview, type SupplierReturnStockOptions } from "@shared/procurement/supplier-return";

import { apVendorOptionsQuery } from "./ap-work-list-query";
import { supplierReturnQuantity, supplierReturnUnits, supplierReturnMaximumPieces, type SupplierReturnOption } from "@/lib/supplier-return-quantity";
import { type ShipmentQuantityDraft } from "@/lib/shipment-unit-entry";
import { verifySupplierReturnPreview } from "@/lib/supplier-return-command";
import { financialCommandFetchJson, FinancialCommandRequestError } from "@/lib/financial-command";
import { ShipmentQuantityControl } from "@/components/purchasing/ShipmentQuantityControl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SupplierReturnValue } from "./SupplierReturnValue";
import type { SupplierReturnCommands } from "./use-supplier-return-commands";

type Selected = { option: SupplierReturnOption; draft: ShipmentQuantityDraft };
export function SupplierReturnCreate({ commands, initialVendorId, purchaseOrderId, receivingOrderId, onCancel }: {
  commands: SupplierReturnCommands; initialVendorId: number | null; purchaseOrderId: number | null; receivingOrderId: number | null; onCancel: () => void;
}) {
  const [vendorId, setVendorId] = useState(initialVendorId);
  const [selected, setSelected] = useState<Record<number, Selected>>({});
  const [reviewed, setReviewed] = useState<SupplierReturnStockPreview | null>(null);
  const [date, setDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [reference, setReference] = useState("");
  const [supplierReference, setSupplierReference] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const activeActor = useRef(commands.userId); activeActor.current = commands.userId;
  const vendors = useQuery(apVendorOptionsQuery);
  const options = useInfiniteQuery<SupplierReturnStockOptions, Error, InfiniteData<SupplierReturnStockOptions>, readonly unknown[], number | null>({
    queryKey: ["/api/supplier-returns/options", vendorId, purchaseOrderId, receivingOrderId, commands.userId], enabled: vendorId !== null,
    initialPageParam: null as number | null, getNextPageParam: page => page.nextAfterLotId ?? undefined, staleTime: 0, retry: false,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ vendorId: String(vendorId), limit: "25" });
      if (purchaseOrderId) params.set("purchaseOrderId", String(purchaseOrderId));
      if (receivingOrderId) params.set("receivingOrderId", String(receivingOrderId));
      if (pageParam) params.set("afterLotId", String(pageParam));
      const response = await fetch(`/api/supplier-returns/options?${params}`, { credentials: "include", signal });
      if (!response.ok) throw new Error("Return stock choices could not be loaded.");
      const page = supplierReturnOptionsSchema.parse(await response.json());
      if (page.items.some(item => (purchaseOrderId && item.purchaseOrderId !== purchaseOrderId) || (receivingOrderId && item.receivingOrderId !== receivingOrderId))
        || (pageParam !== null && page.items.some(item => item.inventoryLotId <= pageParam))
        || (page.nextAfterLotId !== null && (page.items.length === 0 || page.nextAfterLotId !== page.items.at(-1)?.inventoryLotId))) throw new Error("Return stock choices do not match this source page. Reload the source.");
      return page;
    },
  });
  const rows = [...new Map((options.data?.pages.flatMap(page => page.items) ?? []).map(option => [option.inventoryLotId, option])).values()];
  function invalidateReview() { generation.current++; setReviewed(null); setConfirmed(false); setError(null); setPreviewPending(false); }
  useEffect(() => { generation.current++; setSelected({}); setReviewed(null); setConfirmed(false); setError(null); setPreviewPending(false); setReference(""); setSupplierReference(""); setReason(""); }, [commands.userId, vendorId, purchaseOrderId, receivingOrderId]);
  useEffect(() => () => { generation.current++; }, []);
  const blocked = commands.blocked || !commands.canApprove;
  async function preview() {
    if (blocked || !vendorId) return;
    const requestGeneration = ++generation.current;
    const actor = commands.userId;
    setPreviewPending(true); setReviewed(null); setConfirmed(false); setError(null);
    try {
      const input = supplierReturnPreviewInputSchema.parse({ vendorId, lines: Object.values(selected).map(({ option, draft }) => ({ inventoryLotId: option.inventoryLotId, quantity: supplierReturnQuantity(draft, option) })) });
      const raw = await financialCommandFetchJson<unknown>("/api/supplier-returns/preview", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const result = verifySupplierReturnPreview(input, raw);
      if (generation.current === requestGeneration && activeActor.current === actor) setReviewed(result);
    } catch (failure) { if (generation.current === requestGeneration && activeActor.current === actor) setError(failure instanceof Error ? failure.message : "Return stock could not be reviewed."); }
    finally { if (generation.current === requestGeneration && activeActor.current === actor) setPreviewPending(false); }
  }
  async function record() {
    if (blocked || !reviewed || !confirmed) return;
    const actor = commands.userId;
    try {
      const payload = supplierReturnRecordInputSchema.parse({ vendorId: reviewed.vendorId, lines: reviewed.lines.map(({ inventoryLotId, quantity }) => ({ inventoryLotId, quantity })), expectedSourceFingerprint: reviewed.sourceFingerprint,
        returnCalendarDate: date, evidenceReference: reference, reason, ...(supplierReference.trim() ? { supplierReference } : {}) });
      setError(null); await commands.execute({ command: "record", payload, reviewed });
    } catch (failure) {
      if (activeActor.current !== actor) return;
      if (failure instanceof FinancialCommandRequestError && !failure.ambiguous && failure.status !== null && failure.status >= 400 && failure.status < 500
        && failure.details?.supplierReturnCommandOutcome === "rejected" && failure.details.actorId === actor && failure.details.command === "record") { setReviewed(null); setConfirmed(false); }
      setError(failure instanceof Error ? failure.message : "Review the return fields.");
    }
  }
  return <section aria-label="Record accepted stock return" className="space-y-5">
    <p className="text-sm text-muted-foreground">Record goods collected from accepted inventory. Original receipts and purchase quantities remain in history. Supplier credit documents are recorded separately.</p>
    <div className="space-y-1"><Label htmlFor="return-vendor">Supplier</Label><select id="return-vendor" className="w-full rounded border bg-background p-2" disabled={blocked || vendors.isPending || vendors.isError} value={vendorId ?? ""} onChange={event => { invalidateReview(); setVendorId(event.target.value ? Number(event.target.value) : null); }}><option value="">Choose supplier</option>{vendors.data?.map(vendor => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select>
      {vendors.isError && <div role="alert">Suppliers are unavailable. <Button variant="outline" onClick={() => void vendors.refetch()}>Retry suppliers</Button></div>}
    </div>
    {(purchaseOrderId || receivingOrderId) && <p className="text-sm">Stock discovery is limited to {purchaseOrderId ? `purchase #${purchaseOrderId}` : ""}{purchaseOrderId && receivingOrderId ? " and " : ""}{receivingOrderId ? `receipt #${receivingOrderId}` : ""}.</p>}
    {vendorId !== null && <section aria-label="Available return stock" className="space-y-3">
      <h2 className="text-lg font-semibold">Choose physical stock</h2>
      {options.isPending ? <p role="status">Loading source-proven lots…</p> : <>
        {options.isError && <div role="alert"><p>Return stock choices are unavailable.</p><Button variant="outline" onClick={() => void options.refetch()}>Retry return stock</Button></div>}
        {rows.map(option => <article key={option.inventoryLotId} className="rounded border p-3 space-y-3">
          <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 size-5 shrink-0" aria-label={`Return lot ${option.lotNumber}`} checked={selected[option.inventoryLotId] !== undefined} disabled={blocked || !option.eligible || options.isFetching} onChange={event => { invalidateReview(); setSelected(current => { const next = { ...current }; if (event.target.checked) next[option.inventoryLotId] = { option, draft: { variantId: option.productVariantId, unitsPerVariant: option.unitsPerVariant!, quantity: "" } }; else delete next[option.inventoryLotId]; return next; }); }} /><span><strong>{option.sku ?? "SKU not recorded"} · {option.lotNumber}</strong><br /><span className="text-sm">{option.locationCode} · {option.availableQuantity.toLocaleString()} recorded units available · {option.unitLabel}</span></span></label>
          {option.issues.map(issue => <p key={issue.code} className="text-sm text-amber-800 dark:text-amber-200">{issue.message}</p>)}
          {selected[option.inventoryLotId] && <ShipmentQuantityControl id={`return-${option.inventoryLotId}`} value={selected[option.inventoryLotId].draft} units={supplierReturnUnits(selected[option.inventoryLotId].option)} purpose="supplier-return" quantityLabel="Pieces to return" maximumPieces={supplierReturnMaximumPieces(selected[option.inventoryLotId].option)} disabled={blocked} onChange={draft => { invalidateReview(); setSelected(current => ({ ...current, [option.inventoryLotId]: { ...current[option.inventoryLotId], draft } })); }} />}
        </article>)}
        {!options.isError && rows.length === 0 && <p>No source-proven stock is available for these filters.</p>}
        {options.hasNextPage && <Button variant="outline" disabled={options.isFetching} onClick={() => void options.fetchNextPage()}>Load more return stock</Button>}
      </>}
    </section>}
    <div className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={blocked || previewPending || Object.keys(selected).length === 0 || options.isError} onClick={() => void preview()}>{previewPending ? "Reviewing stock and value…" : "Review return quantity and value"}</Button><span className="text-sm">{Object.keys(selected).length} selected lot(s)</span></div>
    {reviewed && <section aria-label="Reviewed physical return" className="rounded border p-4 space-y-4">
      <h2 className="text-lg font-semibold">Review the collection</h2>
      {reviewed.lines.map(line => <div key={line.inventoryLotId} className="space-y-2 border-b pb-3"><p className="font-medium">{line.lotNumber} · {line.locationCode}</p><p>{line.quantity.toLocaleString()} recorded units × {line.unitsPerVariant.toLocaleString()} pieces = {line.basePieces.toLocaleString()} pieces to return</p><p className="text-xs text-muted-foreground">Receipt #{line.sourceProof.origin.receivingOrderId}, purchase #{line.sourceProof.origin.purchaseOrderId}{line.sourceProof.transfers.length ? `, ${line.sourceProof.transfers.length} verified transfer(s)` : ""}</p><SupplierReturnValue value={line.costs} label={`Lot ${line.lotNumber} value`} /></div>)}
      <SupplierReturnValue value={reviewed.totals} label="Total inventory value to remove" />
      {reviewed.costProvisional && <p className="text-sm rounded border border-amber-400 p-3">This value includes provisional costs. Later verified cost updates remain in the return value history; this does not establish the supplier's credit amount.</p>}
      <fieldset disabled={blocked} className="space-y-3"><div className="grid sm:grid-cols-2 gap-3"><div><Label htmlFor="return-date">Collection date</Label><Input id="return-date" type="date" value={date} onChange={event => { setDate(event.target.value); setConfirmed(false); }} /></div><div><Label htmlFor="return-reference">Collection evidence reference</Label><Input id="return-reference" value={reference} maxLength={1000} onChange={event => { setReference(event.target.value); setConfirmed(false); }} /></div></div>
      <div><Label htmlFor="return-supplier-reference">Supplier return reference (optional)</Label><Input id="return-supplier-reference" value={supplierReference} maxLength={200} onChange={event => { setSupplierReference(event.target.value); setConfirmed(false); }} /></div>
      <div><Label htmlFor="return-reason">Reason for return</Label><Textarea id="return-reason" value={reason} maxLength={2000} onChange={event => { setReason(event.target.value); setConfirmed(false); }} /></div>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-5 shrink-0" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I verified the collected goods, source locations, quantities and value above.</label>
      <Button disabled={!confirmed || !reference.trim() || reason.trim().length < 3} onClick={() => void record()}>{commands.pending ? "Recording return…" : "Record collected supplier return"}</Button></fieldset>
    </section>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <Button variant="ghost" onClick={onCancel}>Back to supplier returns</Button>
  </section>;
}
