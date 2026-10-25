import { SupplierCreditLink } from "@/features/purchasing/SupplierCreditLink";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { format } from "date-fns";
import { createShipmentInvoiceCommandSchema, type ShipmentInvoiceCommandResponse } from "@shared/procurement/shipment-invoice-command";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { createShipmentInvoiceClient, createShipmentInvoiceRecoveryStore, parseShipmentInvoiceAmount, shipmentInvoiceAmountInput, type ShipmentInvoiceRecovery } from "@/lib/shipment-invoice-command";
import { shipmentInvoiceVendorsSchema, parseShipmentInvoiceCosts } from "@/lib/shipment-invoice-reads";
import { invalidateApInvoiceQueries } from "@/features/purchasing/ap-work-list-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Props = { open: boolean; onOpenChange: (open: boolean) => void; shipmentId: number; sourceVerified?: boolean; invoiceHref?: (invoiceId: number) => string };
type Vendor = { vendorId: number; vendorName: string; unbilledCostCount: number; unbilledTotalCents: number };
type Line = { costId: number; description: string; costType: string; costAmountCents: number; amount: string; included: boolean };

export function AddInvoiceFromCostsModal(props: Props) {
  const { user } = useAuth();
  return user ? <ShipmentInvoiceForm key={`${user.id}:${props.shipmentId}`} {...props} userId={user.id} /> : null;
}

function ShipmentInvoiceForm({ open, onOpenChange, shipmentId, userId, sourceVerified = true, invoiceHref }: Props & { userId: string }) {
  const { user, hasPermission } = useAuth();
  const canCreate = user?.id === userId && hasPermission("purchasing", "edit");
  const queryClient = useQueryClient();
  const store = useMemo(() => createShipmentInvoiceRecoveryStore(() => window.sessionStorage, userId, shipmentId), [userId, shipmentId]);
  const client = useMemo(() => createShipmentInvoiceClient(() => `shipment-invoice-${crypto.randomUUID()}`, store, shipmentId), [store, shipmentId]);
  const [initial] = useState(() => {
    try { return { record: store.read(), error: null as string | null }; }
    catch (error) { return { record: null, error: error instanceof Error ? error.message : "Invoice recovery is unavailable." }; }
  });
  const [intent, setIntent] = useState(initial.record);
  const [localError, setLocalError] = useState(initial.error);
  const [storageBlocked, setStorageBlocked] = useState(initial.error !== null);
  const [blockedUntilReload, setBlockedUntilReload] = useState(false);
  const [selectedVendor, setSelectedVendor] = useState<Vendor | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [result, setResult] = useState<ShipmentInvoiceCommandResponse | null>(null);
  const mounted = useRef(false);
  const permission = useRef(canCreate); permission.current = canCreate;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const vendors = useQuery({
    queryKey: [`/api/inbound-shipments/${shipmentId}/cost-vendors`],
    enabled: open && !selectedVendor && !intent && !storageBlocked,
    staleTime: 0,
    queryFn: async () => shipmentInvoiceVendorsSchema.parse(await (await apiRequest("GET", `/api/inbound-shipments/${shipmentId}/cost-vendors`)).json()),
  });
  const costs = useQuery({
    queryKey: [`/api/inbound-shipments/${shipmentId}/cost-vendors/${selectedVendor?.vendorId}/costs`],
    enabled: open && selectedVendor !== null && !intent && !storageBlocked,
    staleTime: 0,
    queryFn: async () => {
      if (!selectedVendor) throw new Error("Choose the invoice supplier first.");
      return parseShipmentInvoiceCosts(await (await apiRequest("GET", `/api/inbound-shipments/${shipmentId}/cost-vendors/${selectedVendor.vendorId}/costs`)).json(), shipmentId, selectedVendor.vendorId);
    },
  });
  useEffect(() => {
    if (!costs.data || intent) return;
    setLines(costs.data.costs.map(cost => ({
      costId: cost.id, costType: cost.costType.replaceAll("_", " "),
      description: cost.description ?? `${cost.costType.replaceAll("_", " ")}: ${cost.performedByName ?? selectedVendor?.vendorName ?? ""}`,
      costAmountCents: cost.actualCents ?? cost.estimatedCents!, amount: shipmentInvoiceAmountInput(cost.actualCents ?? cost.estimatedCents!), included: (cost.actualCents ?? cost.estimatedCents!) >= 0,
    })));
  }, [costs.data, intent, selectedVendor]);

  const mutation = useMutation({
    retry: false, networkMode: "always",
    mutationFn: async (saved: ShipmentInvoiceRecovery) => {
      if (!mounted.current || !permission.current) throw new Error("Purchasing edit permission is required to create or retry this shipment invoice.");
      return client.execute(saved.body.payload, saved);
    },
    onSuccess: value => {
      if (!mounted.current || !permission.current) return;
      setIntent(null); setResult(value); setLocalError(null); setBlockedUntilReload(false);
      setSelectedVendor(null); setLines([]); setInvoiceNumber(""); setNotes(""); setDueDate(""); onOpenChange(false);
    },
    onError: error => {
      if (!mounted.current || !permission.current) return;
      setLocalError(error.message);
      try { const saved = store.read(); setIntent(saved); if (!saved) setBlockedUntilReload(true); }
      catch (failure) { setStorageBlocked(true); setLocalError(failure instanceof Error ? failure.message : "Invoice recovery is unavailable."); }
    },
    onSettled: async () => {
      await Promise.all([invalidatePurchaseCosts(queryClient), invalidateApInvoiceQueries(queryClient), queryClient.invalidateQueries({ queryKey: ["/api/ap/summary"] })]);
    },
  });
  function refreshRecovery() {
    try { setIntent(store.read()); setStorageBlocked(false); }
    catch (error) { setStorageBlocked(true); setLocalError(error instanceof Error ? error.message : "Invoice recovery is unavailable."); }
  }
  useEffect(() => {
    window.addEventListener("focus", refreshRecovery); window.addEventListener("storage", refreshRecovery);
    return () => { window.removeEventListener("focus", refreshRecovery); window.removeEventListener("storage", refreshRecovery); };
  }, [store]);
  async function reload() {
    try {
      const saved = store.read(); setIntent(saved); setStorageBlocked(false);
      if (!saved) {
        const refreshed = await (selectedVendor ? costs.refetch() : vendors.refetch());
        if (refreshed.error) throw refreshed.error;
      }
      setBlockedUntilReload(false); setLocalError(null);
    } catch (error) { setLocalError(error instanceof Error ? error.message : "Invoice sources could not be reloaded."); }
  }
  function submit() {
    if (!canCreate || !intent && !sourceVerified || mutation.isPending || storageBlocked || blockedUntilReload) return;
    try {
      if (!intent && (!selectedVendor || costs.isFetching || costs.isError || !costs.data)) throw new Error("Reload the supplier charges before creating an invoice.");
      const included = lines.filter(line => line.included);
      // Every displayed amount belongs to the reviewed request, including
      // unchanged defaults. A concurrent charge edit must not silently alter it.
      const overrides = included.map(line => {
        const unitCostCents = parseShipmentInvoiceAmount(line.amount);
        if (unitCostCents < 0) throw new Error("Shipment invoice amounts cannot be negative. Review this charge before creating an invoice.");
        return { freightCostId: line.costId, qtyInvoiced: 1, unitCostCents, description: line.description };
      });
      const payload = intent?.body.payload ?? createShipmentInvoiceCommandSchema.parse({
        vendorId: selectedVendor!.vendorId, invoiceNumber: invoiceNumber.trim(),
        // Retain this form's existing local-midnight timestamp convention.
        // Accounting calendar-date policy is a separate correction.
        invoiceDate: new Date(`${invoiceDate}T00:00:00`).toISOString(),
        ...(dueDate ? { dueDate: new Date(`${dueDate}T00:00:00`).toISOString() } : {}), costRowIds: included.map(line => line.costId),
        ...(overrides.length ? { lineOverrides: overrides } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      const saved = intent ?? store.acquire({ shipmentId, payload }, () => `shipment-invoice-${crypto.randomUUID()}`);
      setIntent(saved); setResult(null); setLocalError(null); mutation.mutate(saved);
    } catch (error) { setLocalError(error instanceof Error ? error.message : "Review the invoice fields."); }
  }
  const busy = mutation.isPending || !!intent || !canCreate || !sourceVerified || storageBlocked || blockedUntilReload;
  let total: bigint | null = BigInt(0);
  try { for (const line of lines.filter(line => line.included)) total += BigInt(parseShipmentInvoiceAmount(line.amount)); }
  catch { total = null; }
  const totalDisplay = total !== null && total >= BigInt(Number.MIN_SAFE_INTEGER) && total <= BigInt(Number.MAX_SAFE_INTEGER) ? formatIntegerCents(Number(total), "USD") : "Review amounts";

  return <>
    {(intent || storageBlocked) && !open && <section aria-label="Shipment invoice recovery" className="rounded-md border border-amber-300 p-3 text-sm space-y-2">
      <p>{intent ? `Invoice ${intent.body.payload.invoiceNumber} needs recovery. Its original request is saved for this shipment.` : localError}</p>
      <Button variant="outline" onClick={() => onOpenChange(true)}>Review pending shipment invoice</Button>
    </section>}
    {result && <p role="status" className="text-sm"><Link className="text-primary underline" href={invoiceHref?.(result.invoiceId) ?? `/ap-invoices/${result.invoiceId}`}>Open invoice {result.invoiceNumber}</Link> — created as received; approval is still required.</p>}
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{intent ? "Recover shipment invoice" : selectedVendor ? `Create Invoice — ${selectedVendor.vendorName}` : "Add Invoice"}</DialogTitle>
          <DialogDescription>Select verified unbilled shipment charges, then review the supplier invoice. Creating it does not approve or pay it.</DialogDescription>
        </DialogHeader>
        {!canCreate && <p role="alert">Purchasing edit permission is required to create or retry a shipment invoice.</p>}
        {!intent && !sourceVerified && <p role="alert">Reload shipment ownership before creating a new invoice.</p>}
        {localError && <p role="alert" className="text-sm text-destructive">{localError}</p>}
        {(storageBlocked || blockedUntilReload) && <Button variant="outline" onClick={() => void reload()}>Reload invoice sources</Button>}
        {intent ? <div className="space-y-3">
          <p role="status">The original request is saved. Retry uses the original supplier, charges and amounts to recover the same invoice.</p>
          <dl className="text-sm space-y-1"><div>Invoice: {intent.body.payload.invoiceNumber}</div><div>Supplier #{intent.body.payload.vendorId}</div><div>Shipment #{shipmentId} · {intent.body.payload.costRowIds.length} charge(s)</div></dl>
          <Button onClick={submit} disabled={!canCreate || mutation.isPending || storageBlocked || blockedUntilReload}>{mutation.isPending ? "Creating invoice…" : "Retry saved invoice"}</Button>
        </div> : !selectedVendor ? <>
          {vendors.isPending || vendors.isFetching ? <p role="status">Loading invoice suppliers…</p>
            : vendors.isError || !vendors.data ? <div role="alert" className="space-y-2"><p>Invoice suppliers could not be loaded. Unbilled charges are unavailable.</p><Button variant="outline" onClick={() => void vendors.refetch()}>Retry invoice suppliers</Button></div>
            : vendors.data.vendors.length === 0 ? <p>No verified unbilled charges with a supplier are available. Review charge ownership in the Costs tab.</p>
            : <div className="space-y-2">{vendors.data.vendors.map(vendor => <button key={vendor.vendorId} disabled={busy} className="w-full min-h-[44px] flex flex-wrap justify-between gap-2 rounded-lg border p-3 text-left disabled:opacity-50" onClick={() => { setSelectedVendor(vendor); setLines([]); }}><span>{vendor.vendorName}</span><span>{vendor.unbilledCostCount} charge(s) · {formatIntegerCents(vendor.unbilledTotalCents, "USD")}</span></button>)}</div>}
        </> : <>
          <Button variant="ghost" className="justify-start" disabled={busy} onClick={() => { setSelectedVendor(null); setLines([]); }}>Choose another supplier</Button>
          {costs.isPending || costs.isFetching ? <p role="status">Loading supplier charges…</p>
            : costs.isError || !costs.data ? <div role="alert" className="space-y-2"><p>Supplier charges could not be verified. Reload before creating an invoice.</p><Button variant="outline" onClick={() => void costs.refetch()}>Retry supplier charges</Button></div>
            : <fieldset disabled={busy} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1"><Label htmlFor="shipment-invoice-number">Invoice Number *</Label><Input id="shipment-invoice-number" placeholder="Vendor's invoice number" value={invoiceNumber} maxLength={100} onChange={event => setInvoiceNumber(event.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="shipment-invoice-date">Invoice Date *</Label><Input id="shipment-invoice-date" type="date" value={invoiceDate} onChange={event => setInvoiceDate(event.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="shipment-invoice-due">Due Date</Label><Input id="shipment-invoice-due" type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="shipment-invoice-notes">Notes</Label><Textarea id="shipment-invoice-notes" value={notes} maxLength={10000} onChange={event => setNotes(event.target.value)} /></div>
              </div>
              <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead>Include</TableHead><TableHead>Charge</TableHead><TableHead>Recorded</TableHead><TableHead>Invoice amount</TableHead></TableRow></TableHeader><TableBody>
                {lines.length === 0 ? <TableRow><TableCell colSpan={4}>No verified unbilled charges remain for this supplier.</TableCell></TableRow> : lines.map(line => <TableRow key={line.costId}>
                  <TableCell><Checkbox aria-label={`Include charge ${line.costId}`} checked={line.included} disabled={line.costAmountCents < 0} onCheckedChange={checked => setLines(current => current.map(row => row.costId === line.costId ? { ...row, included: checked === true } : row))} /></TableCell>
                  <TableCell className="min-w-[130px]"><p className="capitalize">{line.costType}</p><p className="text-xs text-muted-foreground">{line.description}</p>{line.costAmountCents < 0 && <div className="text-xs"><p>Negative charges require supplier credit review.</p><SupplierCreditLink inboundShipmentId={shipmentId} create /></div>}</TableCell>
                  <TableCell className="font-mono">{formatIntegerCents(line.costAmountCents, "USD")}</TableCell>
                  <TableCell><Input aria-label={`Invoice amount for charge ${line.costId}`} inputMode="decimal" value={line.amount} disabled={!line.included} className="w-28" onChange={event => setLines(current => current.map(row => row.costId === line.costId ? { ...row, amount: event.target.value } : row))} /></TableCell>
                </TableRow>)}
              </TableBody></Table></div>
              <p className="text-right font-medium">Total: {totalDisplay}</p>
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button><Button onClick={submit} disabled={!invoiceNumber.trim() || !invoiceDate || !lines.some(line => line.included) || total === null}>Create Invoice</Button></div>
            </fieldset>}
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
