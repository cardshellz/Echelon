import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  ChevronLeft,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Link2,
  Plus,
  CreditCard,
  Unlink,
} from "lucide-react";
import { format, parseISO } from "date-fns";

function formatCents(cents: number | null | undefined): string {
  if (!cents && cents !== 0) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  received: "bg-blue-100 text-blue-700",
  approved: "bg-indigo-100 text-indigo-700",
  partially_paid: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700",
  disputed: "bg-red-100 text-red-700",
  voided: "bg-slate-100 text-slate-400",
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  ach: "ACH",
  check: "Check",
  wire: "Wire",
  credit_card: "Credit Card",
  other: "Other",
};

export default function APInvoiceDetail() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/ap-invoices/:id");
  const invoiceId = params?.id ? Number(params.id) : null;

  const [showDisputeDialog, setShowDisputeDialog] = useState(false);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [showLinkPoDialog, setShowLinkPoDialog] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [reason, setReason] = useState("");
  const [linkPoId, setLinkPoId] = useState("");
  const [linkAmount, setLinkAmount] = useState("");

  const [payment, setPayment] = useState({
    paymentDate: format(new Date(), "yyyy-MM-dd"),
    paymentMethod: "ach",
    referenceNumber: "",
    checkNumber: "",
    bankAccountLabel: "",
    amountDollars: "",
    notes: "",
  });

  const { data: invoice, isLoading } = useQuery<any>({
    queryKey: [`/api/vendor-invoices/${invoiceId}`],
    enabled: !!invoiceId,
  });

  const { data: vendorsData } = useQuery<any>({ queryKey: ["/api/vendors"] });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/vendor-invoices/${invoiceId}`] });
    queryClient.invalidateQueries({ queryKey: ["/api/vendor-invoices"] });
    queryClient.invalidateQueries({ queryKey: ["/api/ap/summary"] });
  };

  function action(endpoint: string, body?: any) {
    return fetch(`/api/vendor-invoices/${invoiceId}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    });
  }

  const receiveMutation = useMutation({
    mutationFn: () => action("receive"),
    onSuccess: () => { invalidate(); toast({ title: "Invoice received" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const approveMutation = useMutation({
    mutationFn: () => action("approve"),
    onSuccess: () => { invalidate(); toast({ title: "Invoice approved" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const disputeMutation = useMutation({
    mutationFn: () => action("dispute", { reason }),
    onSuccess: () => { invalidate(); setShowDisputeDialog(false); setReason(""); toast({ title: "Invoice disputed" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const voidMutation = useMutation({
    mutationFn: () => action("void", { reason }),
    onSuccess: () => { invalidate(); setShowVoidDialog(false); setReason(""); toast({ title: "Invoice voided" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const linkPoMutation = useMutation({
    mutationFn: () => fetch(`/api/vendor-invoices/${invoiceId}/po-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purchaseOrderId: parseInt(linkPoId),
        allocatedAmountCents: linkAmount ? Math.round(parseFloat(linkAmount) * 100) : undefined,
      }),
    }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => { invalidate(); setShowLinkPoDialog(false); setLinkPoId(""); setLinkAmount(""); toast({ title: "PO linked" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const unlinkPoMutation = useMutation({
    mutationFn: (poId: number) => fetch(`/api/vendor-invoices/${invoiceId}/po-links/${poId}`, { method: "DELETE" })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => { invalidate(); toast({ title: "PO unlinked" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const paymentMutation = useMutation({
    mutationFn: () => fetch("/api/ap-payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendorId: invoice?.vendorId,
        paymentDate: payment.paymentDate,
        paymentMethod: payment.paymentMethod,
        referenceNumber: payment.referenceNumber || undefined,
        checkNumber: payment.checkNumber || undefined,
        bankAccountLabel: payment.bankAccountLabel || undefined,
        totalAmountCents: Math.round(parseFloat(payment.amountDollars || "0") * 100),
        notes: payment.notes || undefined,
        allocations: [{
          vendorInvoiceId: invoiceId,
          appliedAmountCents: Math.round(parseFloat(payment.amountDollars || "0") * 100),
        }],
      }),
    }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["/api/ap-payments"] });
      setShowPaymentDialog(false);
      setPayment({ paymentDate: format(new Date(), "yyyy-MM-dd"), paymentMethod: "ach", referenceNumber: "", checkNumber: "", bankAccountLabel: "", amountDollars: "", notes: "" });
      toast({ title: "Payment recorded" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  if (!invoice) {
    return <div className="p-6 text-muted-foreground">Invoice not found.</div>;
  }

  const status = invoice.status;
  const canReceive = status === "draft";
  const canApprove = ["received", "disputed"].includes(status);
  const canDispute = ["received", "approved", "partially_paid"].includes(status);
  const canVoid = status !== "voided";
  const canPay = ["approved", "partially_paid"].includes(status);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Back + Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/ap-invoices")}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            Invoices
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold">Invoice #{invoice.invoiceNumber}</h1>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[status] ?? ""}`}>
                {status.replace("_", " ")}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">{invoice.vendorName}</p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap justify-end">
          {canReceive && (
            <Button size="sm" variant="outline" onClick={() => receiveMutation.mutate()} disabled={receiveMutation.isPending}>
              Mark Received
            </Button>
          )}
          {canApprove && (
            <Button size="sm" onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending}>
              <CheckCircle className="h-4 w-4 mr-1" />
              Approve
            </Button>
          )}
          {canPay && (
            <Button size="sm" onClick={() => {
              setPayment(p => ({ ...p, amountDollars: (invoice.balanceCents / 100).toFixed(2) }));
              setShowPaymentDialog(true);
            }}>
              <CreditCard className="h-4 w-4 mr-1" />
              Record Payment
            </Button>
          )}
          {canDispute && (
            <Button size="sm" variant="outline" className="text-red-600 border-red-200" onClick={() => setShowDisputeDialog(true)}>
              <AlertTriangle className="h-4 w-4 mr-1" />
              Dispute
            </Button>
          )}
          {canVoid && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setShowVoidDialog(true)}>
              <XCircle className="h-4 w-4 mr-1" />
              Void
            </Button>
          )}
        </div>
      </div>

      {/* Amounts Card */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5 text-center">
            <p className="text-xs text-muted-foreground mb-1">Invoiced</p>
            <p className="text-2xl font-bold">{formatCents(invoice.invoicedAmountCents)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 text-center">
            <p className="text-xs text-muted-foreground mb-1">Paid</p>
            <p className="text-2xl font-bold text-green-600">{formatCents(invoice.paidAmountCents)}</p>
          </CardContent>
        </Card>
        <Card className={invoice.balanceCents > 0 ? "border-amber-200" : ""}>
          <CardContent className="pt-5 text-center">
            <p className="text-xs text-muted-foreground mb-1">Balance</p>
            <p className={`text-2xl font-bold ${invoice.balanceCents > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
              {formatCents(invoice.balanceCents)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Details */}
      <Card>
        <CardHeader><CardTitle className="text-sm">Invoice Details</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><p className="text-muted-foreground">Invoice Date</p><p className="font-medium">{formatDate(invoice.invoiceDate)}</p></div>
            <div><p className="text-muted-foreground">Due Date</p><p className="font-medium">{formatDate(invoice.dueDate)}</p></div>
            <div><p className="text-muted-foreground">Our Reference</p><p className="font-medium">{invoice.ourReference || "—"}</p></div>
            <div><p className="text-muted-foreground">Payment Terms</p><p className="font-medium">{invoice.paymentTermsDays ? `Net ${invoice.paymentTermsDays}` : "—"}</p></div>
            {invoice.approvedAt && <div><p className="text-muted-foreground">Approved</p><p className="font-medium">{formatDate(invoice.approvedAt)}</p></div>}
            {invoice.disputeReason && <div className="col-span-2"><p className="text-muted-foreground">Dispute Reason</p><p className="font-medium text-red-600">{invoice.disputeReason}</p></div>}
            {invoice.notes && <div className="col-span-2"><p className="text-muted-foreground">Notes</p><p className="font-medium">{invoice.notes}</p></div>}
          </div>
        </CardContent>
      </Card>

      {/* Linked POs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Linked Purchase Orders</CardTitle>
          {status !== "voided" && (
            <Button size="sm" variant="outline" onClick={() => setShowLinkPoDialog(true)}>
              <Link2 className="h-4 w-4 mr-1" />
              Link PO
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {invoice.poLinks?.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">No POs linked yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PO Number</TableHead>
                  <TableHead>PO Status</TableHead>
                  <TableHead className="text-right">PO Total</TableHead>
                  <TableHead className="text-right">Allocated Amount</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.poLinks.map((link: any) => (
                  <TableRow key={link.id}>
                    <TableCell>
                      <Link href={`/purchase-orders/${link.purchaseOrderId}`} className="font-mono text-blue-600 hover:underline">
                        {link.poNumber}
                      </Link>
                    </TableCell>
                    <TableCell><Badge variant="outline" className="text-xs">{link.poStatus}</Badge></TableCell>
                    <TableCell className="text-right font-mono">{formatCents(link.poTotalCents)}</TableCell>
                    <TableCell className="text-right font-mono">{link.allocatedAmountCents ? formatCents(link.allocatedAmountCents) : "—"}</TableCell>
                    <TableCell>
                      {status !== "voided" && (
                        <Button size="sm" variant="ghost" className="h-7 text-muted-foreground"
                          onClick={() => unlinkPoMutation.mutate(link.purchaseOrderId)}
                          disabled={unlinkPoMutation.isPending}
                        >
                          <Unlink className="h-3.5 w-3.5" />
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

      {/* Payment History */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Payment History</CardTitle>
          {canPay && (
            <Button size="sm" variant="outline" onClick={() => {
              setPayment(p => ({ ...p, amountDollars: (invoice.balanceCents / 100).toFixed(2) }));
              setShowPaymentDialog(true);
            }}>
              <Plus className="h-4 w-4 mr-1" />
              Record Payment
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {invoice.payments?.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">No payments recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payment #</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Applied</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoice.payments.map((p: any) => (
                  <TableRow key={p.id} className={p.paymentStatus === "voided" ? "opacity-50" : ""}>
                    <TableCell>
                      <Link href={`/ap-payments/${p.apPaymentId}`} className="font-mono text-blue-600 hover:underline">
                        {p.paymentNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{formatDate(p.paymentDate)}</TableCell>
                    <TableCell className="text-sm">{PAYMENT_METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}</TableCell>
                    <TableCell className="text-sm font-mono text-muted-foreground">{p.referenceNumber || "—"}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{formatCents(p.appliedAmountCents)}</TableCell>
                    <TableCell><Badge variant="outline" className="text-xs">{p.paymentStatus}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dispute Dialog */}
      <Dialog open={showDisputeDialog} onOpenChange={setShowDisputeDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Dispute Invoice</DialogTitle>
            <DialogDescription>Describe the discrepancy with this invoice.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Textarea placeholder="Reason for dispute..." value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowDisputeDialog(false)}>Cancel</Button>
              <Button variant="destructive" onClick={() => disputeMutation.mutate()} disabled={!reason || disputeMutation.isPending}>
                {disputeMutation.isPending ? "Saving..." : "Mark Disputed"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Void Dialog */}
      <Dialog open={showVoidDialog} onOpenChange={setShowVoidDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Void Invoice</DialogTitle>
            <DialogDescription>This cannot be undone. Provide a reason.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Textarea placeholder="Void reason..." value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowVoidDialog(false)}>Cancel</Button>
              <Button variant="destructive" onClick={() => voidMutation.mutate()} disabled={!reason || voidMutation.isPending}>
                {voidMutation.isPending ? "Voiding..." : "Void Invoice"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Link PO Dialog */}
      <Dialog open={showLinkPoDialog} onOpenChange={setShowLinkPoDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Link Purchase Order</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>PO Number or ID</Label>
              <Input placeholder="e.g. PO-20240101-001 or ID" value={linkPoId} onChange={(e) => setLinkPoId(e.target.value)} />
              <p className="text-xs text-muted-foreground">Enter the purchase order ID (number).</p>
            </div>
            <div className="space-y-2">
              <Label>Allocated Amount ($) <span className="text-muted-foreground">(optional)</span></Label>
              <Input type="number" step="0.01" min="0" placeholder="Leave blank for full invoice" value={linkAmount} onChange={(e) => setLinkAmount(e.target.value)} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowLinkPoDialog(false)}>Cancel</Button>
              <Button onClick={() => linkPoMutation.mutate()} disabled={!linkPoId || linkPoMutation.isPending}>
                {linkPoMutation.isPending ? "Linking..." : "Link PO"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Record Payment Dialog */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>Balance due: {formatCents(invoice.balanceCents)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Payment Date *</Label>
                <Input type="date" value={payment.paymentDate} onChange={(e) => setPayment(p => ({ ...p, paymentDate: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Method *</Label>
                <select className="w-full border rounded-md h-10 px-3 text-sm bg-background" value={payment.paymentMethod} onChange={(e) => setPayment(p => ({ ...p, paymentMethod: e.target.value }))}>
                  <option value="ach">ACH</option>
                  <option value="check">Check</option>
                  <option value="wire">Wire</option>
                  <option value="credit_card">Credit Card</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Amount ($) *</Label>
              <Input type="number" step="0.01" min="0" value={payment.amountDollars} onChange={(e) => setPayment(p => ({ ...p, amountDollars: e.target.value }))} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Reference # <span className="text-muted-foreground text-xs">(ACH/wire)</span></Label>
                <Input placeholder="Trace / wire ref" value={payment.referenceNumber} onChange={(e) => setPayment(p => ({ ...p, referenceNumber: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Check #</Label>
                <Input placeholder="If paying by check" value={payment.checkNumber} onChange={(e) => setPayment(p => ({ ...p, checkNumber: e.target.value }))} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Bank Account</Label>
              <Input placeholder="e.g. Chase Operating" value={payment.bankAccountLabel} onChange={(e) => setPayment(p => ({ ...p, bankAccountLabel: e.target.value }))} />
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Input placeholder="Optional" value={payment.notes} onChange={(e) => setPayment(p => ({ ...p, notes: e.target.value }))} />
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowPaymentDialog(false)}>Cancel</Button>
              <Button onClick={() => paymentMutation.mutate()} disabled={!payment.amountDollars || paymentMutation.isPending}>
                {paymentMutation.isPending ? "Recording..." : "Record Payment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
