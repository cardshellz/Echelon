import { useLocation, useSearch } from "wouter";
import { ApPaymentApplications, PaymentBalanceSummary } from "@/features/purchasing/ApPaymentApplications";
import { ApPaymentRecovery } from "@/features/purchasing/ApPaymentRecovery";
import { useApPaymentCommands } from "@/features/purchasing/use-ap-payment-commands";
import { formatPaymentAmount, parsePaymentAmount, paymentAllocationInputs, recordPaymentInputSchema, sumPaymentCents } from "@/lib/ap-payment-command";
import { formatPaymentCalendarDate } from "@shared/procurement/ap-payment-contract";
import { invoiceWorkListQuery, paymentWorkListQuery, apVendorOptionsQuery } from "@/features/purchasing/ap-work-list-query";
import { WorkListPagination } from "@/features/purchasing/WorkListPagination";
import React, { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Plus, Search, CreditCard, XCircle } from "lucide-react";
import { format, parseISO } from "date-fns";
const formatCents = formatPaymentAmount;

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

const METHOD_LABELS: Record<string, string> = {
  ach: "ACH", check: "Check", wire: "Wire", credit_card: "Credit Card", other: "Other",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  scheduled: "bg-blue-100 text-blue-700",
  processing: "bg-indigo-100 text-indigo-700",
  completed: "bg-green-100 text-green-700",
  returned: "bg-red-100 text-red-700",
  voided: "bg-slate-100 text-slate-400",
};

const COMMAND_LABELS: Record<string, string> = {
  approve_invoice: "Invoice approved",
  dispute_invoice: "Invoice disputed",
  void_invoice: "Invoice voided",
  record_payment: "Payment recorded",
  void_payment: "Payment voided",
  apply_payment: "Existing payment applied",
};

export default function APPayments() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const paymentCommands = useApPaymentCommands();
  const [, navigate] = useLocation();
  const locationSearch = useSearch();
  const requestedId = new URLSearchParams(locationSearch).get("paymentId");
  const parsedPaymentId = requestedId && /^[1-9]\d*$/.test(requestedId) && Number(requestedId) <= 2_147_483_647 ? Number(requestedId) : null;
  const [reviewPaymentId, setReviewPaymentId] = useState<number | null>(parsedPaymentId);
  useEffect(() => setReviewPaymentId(parsedPaymentId), [parsedPaymentId]);
  const openPayment = (id: number | null) => { setReviewPaymentId(id); navigate(id === null ? "/ap-payments" : `/ap-payments?paymentId=${id}`); };
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [invoiceOffset, setInvoiceOffset] = useState(0);
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showVoidDialog, setShowVoidDialog] = useState<number | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const [newPayment, setNewPayment] = useState({
    vendorId: "",
    paymentDate: format(new Date(), "yyyy-MM-dd"),
    paymentMethod: "ach",
    referenceNumber: "",
    checkNumber: "",
    bankAccountLabel: "",
    totalAmountDollars: "",
    notes: "",
  });

  const { data, isLoading, isFetching, isError, refetch } = useQuery(paymentWorkListQuery({ search, offset, limit: 50 }));

  const { data: auditData, isLoading: isAuditLoading, isError: auditError, refetch: refetchAudit } = useQuery<{ events: any[] }>({
    queryKey: ["/api/ap/command-events?limit=8"],
  });

  const { data: vendorsData, isError: vendorsError, isLoading: vendorsLoading, refetch: refetchVendors } = useQuery(apVendorOptionsQuery);
  const vendors = vendorsData ?? [];

  const { data: openInvoicesData, isLoading: invoicesLoading, isFetching: invoicesFetching, isError: invoicesError, refetch: refetchInvoices } = useQuery({
    ...invoiceWorkListQuery({ status: "approved,partially_paid", vendorId: newPayment.vendorId, search: invoiceSearch, offset: invoiceOffset, limit: 20 }),
    enabled: showPaymentDialog && !!newPayment.vendorId,
    // Reopening the mounted dialog after settlement must refresh even when its key is unchanged.
    staleTime: 0,
  });
  const vendorOpenInvoices = openInvoicesData?.items ?? [];

  const [allocations, setAllocations] = useState<Record<number, string>>({});

  const createMutation = useMutation({
    mutationFn: async () => paymentCommands.execute({ operation: "record_payment", originInvoiceId: null, payload: recordPaymentInputSchema.parse({
      vendorId: Number(newPayment.vendorId), paymentDate: newPayment.paymentDate, paymentMethod: newPayment.paymentMethod,
      referenceNumber: newPayment.referenceNumber || undefined, checkNumber: newPayment.checkNumber || undefined,
      bankAccountLabel: newPayment.bankAccountLabel || undefined, totalAmountCents: parsePaymentAmount(newPayment.totalAmountDollars),
      notes: newPayment.notes || undefined, allocations: paymentAllocationInputs(allocations),
    }) }),
    onError: (error: Error) => toast({ title: "Payment request requires attention", description: error.message, variant: "destructive" }),
  });
  const voidMutation = useMutation({
    mutationFn: (paymentId: number) => paymentCommands.execute({ operation: "void_payment", paymentId, payload: { reason: voidReason } }),
    onError: (error: Error) => toast({ title: "Payment request requires attention", description: error.message, variant: "destructive" }),
  });

  useEffect(() => {
    if (paymentCommands.confirmed?.operation === "record_payment") {
      setShowPaymentDialog(false); setAllocations({});
      setNewPayment({ vendorId: "", paymentDate: format(new Date(), "yyyy-MM-dd"), paymentMethod: "ach", referenceNumber: "", checkNumber: "", bankAccountLabel: "", totalAmountDollars: "", notes: "" });
    } else if (paymentCommands.confirmed?.operation === "void_payment") { setShowVoidDialog(null); setVoidReason(""); }
  }, [paymentCommands.confirmed]);

  useEffect(() => {
    setShowPaymentDialog(false); setShowVoidDialog(null); setVoidReason(""); setAllocations({}); setInvoiceOffset(0); setInvoiceSearch("");
    setNewPayment({ vendorId: "", paymentDate: format(new Date(), "yyyy-MM-dd"), paymentMethod: "ach", referenceNumber: "", checkNumber: "", bankAccountLabel: "", totalAmountDollars: "", notes: "" });
  }, [paymentCommands.userId]);

  const payments = data?.items ?? [];
  const auditEvents = auditData?.events ?? [];

  let allocTotal: number | null = null;
  let recordedTotal: number | null = null;
  try { allocTotal = sumPaymentCents(paymentAllocationInputs(allocations).map(row => row.appliedAmountCents)); recordedTotal = parsePaymentAmount(newPayment.totalAmountDollars || "0"); } catch { /* Preserve invalid drafts for explicit correction. */ }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">AP Payments</h1>
          <p className="text-muted-foreground text-sm">Payment disbursement ledger</p>
        </div>
        {hasPermission("purchasing", "approve") && <Button size="sm" disabled={paymentCommands.blocked} onClick={() => setShowPaymentDialog(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Record Payment
        </Button>}
      </div>

      <ApPaymentRecovery commands={paymentCommands} />
      <div className="relative w-72 max-w-full">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search payments..."
          className="pl-9 h-9"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {isError ? (
            <div role="alert" className="p-6 space-y-2"><p>Unable to load payments. The list is unavailable.</p><Button variant="outline" onClick={() => void refetch()}>Retry payments</Button></div>
          ) : isLoading ? (
            <div className="flex items-center justify-center h-48">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          ) : payments.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <CreditCard className="h-10 w-10 mx-auto mb-3 opacity-20" />
              <p className="text-sm">No payments recorded yet</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payment #</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p: any) => (
                  <TableRow key={p.id} className={p.status === "voided" ? "opacity-50" : ""}>
                    <TableCell className="font-mono font-medium"><Button variant="link" className="h-auto p-0" aria-label={`Review payment ${p.paymentNumber}`} onClick={() => openPayment(p.id)}>{p.paymentNumber}</Button></TableCell>
                    <TableCell>{p.vendorName ?? "—"}</TableCell>
                    <TableCell className="text-sm">{formatPaymentCalendarDate(p)}</TableCell>
                    <TableCell className="text-sm">{METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}</TableCell>
                    <TableCell className="text-sm font-mono text-muted-foreground">
                      {p.referenceNumber || p.checkNumber || "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium">{formatCents(p.totalAmountCents)}<PaymentBalanceSummary value={p.paymentBalance} /></TableCell>
                    <TableCell>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[p.status] ?? ""}`}>
                        {p.status}
                      </span>
                    </TableCell>
                    <TableCell>
                      {p.status !== "voided" && p.status !== "completed" && <span className="text-xs text-amber-700">Historical status requires review</span>}
                      {p.status === "completed" && hasPermission("purchasing", "approve") && (
                        <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" aria-label={`Void payment ${p.paymentNumber}`}
                          disabled={paymentCommands.blocked} onClick={() => setShowVoidDialog(p.id)}>
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {!isError && <WorkListPagination page={data} busy={isFetching} onOffset={setOffset} label="payments" />}
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent AP Activity</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {auditError ? <div role="alert" className="p-4">Unable to load recent AP activity. <Button variant="link" onClick={() => void refetchAudit()}>Retry activity</Button></div> : isAuditLoading ? (
            <div className="flex items-center justify-center h-24">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
            </div>
          ) : auditEvents.length === 0 ? (
            <div className="px-4 py-8 text-sm text-muted-foreground">No recent AP command activity.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Linked POs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditEvents.map((event: any) => (
                  <TableRow key={event.id}>
                    <TableCell className="text-sm whitespace-nowrap">{formatDate(event.timestamp)}</TableCell>
                    <TableCell>
                      <div className="font-medium">{COMMAND_LABELS[event.command] ?? event.command}</div>
                      <div className="text-xs text-muted-foreground">{event.message}</div>
                    </TableCell>
                    <TableCell className="text-sm">{event.actor}</TableCell>
                    <TableCell className="text-sm font-mono">
                      {(event.affectedPurchaseOrderIds ?? []).length
                        ? event.affectedPurchaseOrderIds.join(", ")
                        : "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {reviewPaymentId !== null && <ApPaymentApplications key={reviewPaymentId} paymentId={reviewPaymentId} onClose={() => openPayment(null)} commands={paymentCommands} />}

      {/* Record Payment Dialog */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Record Payment</DialogTitle><DialogDescription>Record cash already paid to a supplier. To allocate an existing payment, open that payment instead.</DialogDescription></DialogHeader>
          <ApPaymentRecovery commands={paymentCommands} />
          <fieldset disabled={paymentCommands.blocked} className="space-y-4">
            <div className="space-y-2">
              <Label>Vendor *</Label>
              <select className="w-full border rounded-md h-10 px-3 text-sm bg-background"
                aria-label="Payment vendor" value={newPayment.vendorId}
                disabled={vendorsLoading || vendorsError}
                onChange={(e) => { setNewPayment(p => ({ ...p, vendorId: e.target.value })); setAllocations({}); setInvoiceOffset(0); setInvoiceSearch(""); }}>
                <option value="">Select vendor...</option>
                {vendors.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              {vendorsError && <p role="alert">Unable to load vendors. <Button variant="link" onClick={() => void refetchVendors()}>Retry vendors</Button></p>}
              {vendorsLoading && <p role="status">Loading vendors…</p>}
              {!vendorsLoading && !vendorsError && vendors.length === 0 && <p>No vendors available.</p>}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Payment Date *</Label>
                <Input aria-label="Payment date" type="date" value={newPayment.paymentDate} onChange={(e) => setNewPayment(p => ({ ...p, paymentDate: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Method *</Label>
                <select className="w-full border rounded-md h-10 px-3 text-sm bg-background" value={newPayment.paymentMethod} onChange={(e) => setNewPayment(p => ({ ...p, paymentMethod: e.target.value }))}>
                  <option value="ach">ACH</option>
                  <option value="check">Check</option>
                  <option value="wire">Wire</option>
                  <option value="credit_card">Credit Card</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Total Amount ($) *</Label>
              <Input type="number" step="0.01" min="0" placeholder="0.00" value={newPayment.totalAmountDollars} onChange={(e) => setNewPayment(p => ({ ...p, totalAmountDollars: e.target.value }))} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Reference #</Label>
                <Input placeholder="ACH trace / wire ref" value={newPayment.referenceNumber} onChange={(e) => setNewPayment(p => ({ ...p, referenceNumber: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Check #</Label>
                <Input placeholder="Check number" value={newPayment.checkNumber} onChange={(e) => setNewPayment(p => ({ ...p, checkNumber: e.target.value }))} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Bank Account</Label>
              <Input placeholder="e.g. Chase Operating" value={newPayment.bankAccountLabel} onChange={(e) => setNewPayment(p => ({ ...p, bankAccountLabel: e.target.value }))} />
            </div>

            {/* Invoice Allocations */}
            {newPayment.vendorId && (
              <div className="space-y-2">
                <Label>Apply to Invoices <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input aria-label="Search vendor invoices" placeholder="Search vendor invoices…" value={invoiceSearch} onChange={event => { setInvoiceSearch(event.target.value); setInvoiceOffset(0); }} />
                {invoicesError ? <div role="alert">Unable to load this vendor's invoices. <Button variant="link" onClick={() => void refetchInvoices()}>Retry invoice selection</Button></div>
                  : invoicesLoading ? <p role="status">Loading vendor invoices…</p>
                  : vendorOpenInvoices.length === 0 ? <p>No approved open invoices match this vendor and search.</p> : null}
                {invoicesFetching && !invoicesLoading && <p role="status">Refreshing vendor invoices…</p>}
                {!invoicesError && !invoicesLoading && <div className="border rounded-md divide-y">
                  {vendorOpenInvoices.map((inv: any) => (
                    <div key={inv.id} className="flex items-center gap-3 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">#{inv.invoiceNumber}</p>
                        <p className="text-xs text-muted-foreground">Balance: {formatCents(inv.balanceCents)}</p>
                      </div>
                      <Input
                        aria-label={`Apply to invoice ${inv.invoiceNumber}`}
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        className="w-28 h-8 text-sm"
                        value={allocations[inv.id] ?? ""}
                        onChange={(e) => setAllocations(a => ({ ...a, [inv.id]: e.target.value }))}
                      />
                    </div>
                  ))}
                </div>}
                {!invoicesError && <WorkListPagination page={openInvoicesData} busy={invoicesFetching} onOffset={setInvoiceOffset} label="vendor invoices" />}
                {Object.keys(allocations).length > 0 && <p className="text-xs text-muted-foreground">Allocations are retained across invoice pages and searches. <button type="button" className="underline" onClick={() => setAllocations({})}>Clear allocations</button></p>}
                {allocTotal === null || recordedTotal === null ? <p role="alert" className="text-sm text-destructive">Review the payment amounts. Use at most two decimal places.</p> : allocTotal > 0 && <p className={`text-xs ${allocTotal > recordedTotal ? "text-red-500" : "text-muted-foreground"}`}>Allocated: {formatCents(allocTotal)} of {formatCents(recordedTotal)}</p>}
              </div>
            )}

            <div className="space-y-2">
              <Label>Notes</Label>
              <Input placeholder="Optional" value={newPayment.notes} onChange={(e) => setNewPayment(p => ({ ...p, notes: e.target.value }))} />
            </div>


          </fieldset>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowPaymentDialog(false)}>Cancel</Button>
              <Button onClick={() => createMutation.mutate()} disabled={paymentCommands.blocked || !newPayment.vendorId || !newPayment.totalAmountDollars || allocTotal === null || recordedTotal === null || allocTotal > recordedTotal || createMutation.isPending}>
                {createMutation.isPending ? "Recording..." : "Record Payment"}
              </Button>
            </div>
        </DialogContent>
      </Dialog>

      {/* Void Dialog */}
      <Dialog open={showVoidDialog !== null} onOpenChange={() => setShowVoidDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Void Payment</DialogTitle>
            <DialogDescription>This will reverse any invoice allocations. Provide a reason.</DialogDescription>
          </DialogHeader>
          <ApPaymentRecovery commands={paymentCommands} />
          <div className="space-y-4">
            <Input disabled={paymentCommands.blocked} placeholder="Void reason..." value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowVoidDialog(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => showVoidDialog && voidMutation.mutate(showVoidDialog)} disabled={paymentCommands.blocked || !voidReason || voidMutation.isPending}>
                {voidMutation.isPending ? "Voiding..." : "Void Payment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
