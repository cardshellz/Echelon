import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

function formatCents(cents: number | null | undefined): string {
  if (!cents && cents !== 0) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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

export default function APPayments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
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

  const { data, isLoading } = useQuery<{ payments: any[] }>({
    queryKey: ["/api/ap-payments"],
  });

  const { data: vendorsData } = useQuery<any>({ queryKey: ["/api/vendors"] });
  const vendors: any[] = vendorsData?.vendors ?? [];

  const { data: openInvoicesData } = useQuery<{ invoices: any[] }>({
    queryKey: ["/api/vendor-invoices?status=approved,partially_paid"],
    enabled: showPaymentDialog,
  });
  const openInvoices = openInvoicesData?.invoices ?? [];

  const [allocations, setAllocations] = useState<Record<number, string>>({});

  const createMutation = useMutation({
    mutationFn: async () => {
      const body = {
        vendorId: parseInt(newPayment.vendorId),
        paymentDate: newPayment.paymentDate,
        paymentMethod: newPayment.paymentMethod,
        referenceNumber: newPayment.referenceNumber || undefined,
        checkNumber: newPayment.checkNumber || undefined,
        bankAccountLabel: newPayment.bankAccountLabel || undefined,
        totalAmountCents: Math.round(parseFloat(newPayment.totalAmountDollars || "0") * 100),
        notes: newPayment.notes || undefined,
        allocations: Object.entries(allocations)
          .filter(([, val]) => parseFloat(val) > 0)
          .map(([invId, val]) => ({
            vendorInvoiceId: parseInt(invId),
            appliedAmountCents: Math.round(parseFloat(val) * 100),
          })),
      };
      const res = await fetch("/api/ap-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ap-payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ap/summary"] });
      setShowPaymentDialog(false);
      setNewPayment({ vendorId: "", paymentDate: format(new Date(), "yyyy-MM-dd"), paymentMethod: "ach", referenceNumber: "", checkNumber: "", bankAccountLabel: "", totalAmountDollars: "", notes: "" });
      setAllocations({});
      toast({ title: "Payment recorded" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const voidMutation = useMutation({
    mutationFn: (id: number) => fetch(`/api/ap-payments/${id}/void`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: voidReason }),
    }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ap-payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor-invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ap/summary"] });
      setShowVoidDialog(null);
      setVoidReason("");
      toast({ title: "Payment voided" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const payments = (data?.payments ?? []).filter((p: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      p.paymentNumber?.toLowerCase().includes(q) ||
      p.vendorName?.toLowerCase().includes(q) ||
      p.referenceNumber?.toLowerCase().includes(q) ||
      p.checkNumber?.toLowerCase().includes(q)
    );
  });

  // Filter open invoices by selected vendor in new payment dialog
  const vendorOpenInvoices = openInvoices.filter((inv: any) =>
    !newPayment.vendorId || inv.vendorId === parseInt(newPayment.vendorId)
  );

  const allocTotal = Object.values(allocations).reduce((s, v) => s + (parseFloat(v) || 0), 0);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">AP Payments</h1>
          <p className="text-muted-foreground text-sm">Payment disbursement ledger</p>
        </div>
        <Button size="sm" onClick={() => setShowPaymentDialog(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Record Payment
        </Button>
      </div>

      <div className="relative w-72">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search payments..."
          className="pl-9 h-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
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
                    <TableCell className="font-mono font-medium">{p.paymentNumber}</TableCell>
                    <TableCell>{p.vendorName ?? "—"}</TableCell>
                    <TableCell className="text-sm">{formatDate(p.paymentDate)}</TableCell>
                    <TableCell className="text-sm">{METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}</TableCell>
                    <TableCell className="text-sm font-mono text-muted-foreground">
                      {p.referenceNumber || p.checkNumber || "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium">{formatCents(p.totalAmountCents)}</TableCell>
                    <TableCell>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[p.status] ?? ""}`}>
                        {p.status}
                      </span>
                    </TableCell>
                    <TableCell>
                      {p.status !== "voided" && (
                        <Button size="sm" variant="ghost" className="h-7 text-muted-foreground"
                          onClick={() => setShowVoidDialog(p.id)}>
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
      </Card>

      {/* Record Payment Dialog */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Vendor *</Label>
              <select className="w-full border rounded-md h-10 px-3 text-sm bg-background"
                value={newPayment.vendorId}
                onChange={(e) => { setNewPayment(p => ({ ...p, vendorId: e.target.value })); setAllocations({}); }}>
                <option value="">Select vendor...</option>
                {vendors.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Payment Date *</Label>
                <Input type="date" value={newPayment.paymentDate} onChange={(e) => setNewPayment(p => ({ ...p, paymentDate: e.target.value }))} />
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
            {newPayment.vendorId && vendorOpenInvoices.length > 0 && (
              <div className="space-y-2">
                <Label>Apply to Invoices <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <div className="border rounded-md divide-y">
                  {vendorOpenInvoices.map((inv: any) => (
                    <div key={inv.id} className="flex items-center gap-3 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">#{inv.invoiceNumber}</p>
                        <p className="text-xs text-muted-foreground">Balance: {formatCents(inv.balanceCents)}</p>
                      </div>
                      <Input
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
                </div>
                {allocTotal > 0 && (
                  <p className={`text-xs ${allocTotal > parseFloat(newPayment.totalAmountDollars || "0") ? "text-red-500" : "text-muted-foreground"}`}>
                    Allocated: ${allocTotal.toFixed(2)} of ${parseFloat(newPayment.totalAmountDollars || "0").toFixed(2)}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label>Notes</Label>
              <Input placeholder="Optional" value={newPayment.notes} onChange={(e) => setNewPayment(p => ({ ...p, notes: e.target.value }))} />
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowPaymentDialog(false)}>Cancel</Button>
              <Button onClick={() => createMutation.mutate()} disabled={!newPayment.vendorId || !newPayment.totalAmountDollars || createMutation.isPending}>
                {createMutation.isPending ? "Recording..." : "Record Payment"}
              </Button>
            </div>
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
          <div className="space-y-4">
            <Input placeholder="Void reason..." value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowVoidDialog(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => showVoidDialog && voidMutation.mutate(showVoidDialog)} disabled={!voidReason || voidMutation.isPending}>
                {voidMutation.isPending ? "Voiding..." : "Void Payment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
