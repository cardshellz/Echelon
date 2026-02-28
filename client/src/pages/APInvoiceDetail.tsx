import React, { useState, useRef } from "react";
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
  Pencil,
  Search,
  Upload,
  Download,
  Trash2,
  FileText,
  RefreshCw,
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

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_COLORS: Record<string, string> = {
  received: "bg-blue-100 text-blue-700",
  approved: "bg-indigo-100 text-indigo-700",
  partially_paid: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700",
  disputed: "bg-red-100 text-red-700",
  voided: "bg-slate-100 text-slate-400",
};

const MATCH_COLORS: Record<string, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-slate-100 text-slate-600" },
  matched: { label: "Matched", className: "bg-green-100 text-green-700" },
  qty_discrepancy: { label: "Qty Mismatch", className: "bg-amber-100 text-amber-700" },
  price_discrepancy: { label: "Price Mismatch", className: "bg-red-100 text-red-700" },
  over_billed: { label: "Over-billed", className: "bg-red-100 text-red-700" },
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  ach: "ACH",
  check: "Check",
  wire: "Wire",
  credit_card: "Credit Card",
  other: "Other",
};

// ── Link PO Dialog Content ──
function LinkPoDialogContent({ invoice, linkPoId, setLinkPoId, linkPoMutation, onClose }: any) {
  const [poSearch, setPoSearch] = useState("");
  const { data: posData } = useQuery<any>({
    queryKey: [`/api/purchase-orders?vendorId=${invoice.vendorId}&limit=100`],
    enabled: !!invoice.vendorId,
  });
  const allPos: any[] = posData?.purchaseOrders ?? posData ?? [];
  const linkedPoIds = new Set((invoice.poLinks || []).map((l: any) => l.purchaseOrderId));
  const availablePos = allPos.filter((p: any) => !linkedPoIds.has(p.id));
  const filteredPos = poSearch
    ? availablePos.filter((p: any) => p.poNumber?.toLowerCase().includes(poSearch.toLowerCase()))
    : availablePos;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Search POs</Label>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Filter by PO number..." value={poSearch} onChange={e => setPoSearch(e.target.value)} />
        </div>
        <div className="max-h-48 overflow-y-auto border rounded-md">
          {filteredPos.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground text-center">
              {availablePos.length === 0 ? "All POs already linked." : "No matching POs."}
            </p>
          ) : (
            filteredPos.map((p: any) => (
              <button
                key={p.id}
                type="button"
                className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 flex items-center justify-between ${String(p.id) === linkPoId ? "bg-primary/10 border-l-2 border-primary" : ""}`}
                onClick={() => setLinkPoId(String(p.id))}
              >
                <span className="font-mono">{p.poNumber}</span>
                <span className="text-muted-foreground">{formatCents(p.totalCents)}</span>
              </button>
            ))
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">PO line items will be automatically imported.</p>
      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => linkPoMutation.mutate()} disabled={!linkPoId || linkPoMutation.isPending}>
          {linkPoMutation.isPending ? "Linking..." : "Link & Import Lines"}
        </Button>
      </div>
    </div>
  );
}

// ── Main Component ──
export default function APInvoiceDetail() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/ap-invoices/:id");
  const invoiceId = params?.id ? Number(params.id) : null;
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tabs
  const [activeTab, setActiveTab] = useState<"lines" | "details" | "attachments">("lines");

  // Dialogs
  const [showDisputeDialog, setShowDisputeDialog] = useState(false);
  const [showVoidDialog, setShowVoidDialog] = useState(false);
  const [showLinkPoDialog, setShowLinkPoDialog] = useState(false);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [showAddLineDialog, setShowAddLineDialog] = useState(false);
  const [reason, setReason] = useState("");
  const [linkPoId, setLinkPoId] = useState("");

  // Editing
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    invoiceNumber: "", ourReference: "",
    invoiceDate: "", dueDate: "", paymentTermsDays: "", notes: "",
  });

  // Add line form
  const [newLine, setNewLine] = useState({ sku: "", productName: "", description: "", qtyInvoiced: "", unitCostDollars: "" });

  // Payment form
  const [payment, setPayment] = useState({
    paymentDate: format(new Date(), "yyyy-MM-dd"),
    paymentMethod: "ach",
    referenceNumber: "",
    checkNumber: "",
    bankAccountLabel: "",
    amountDollars: "",
    notes: "",
  });

  // Queries
  const { data: invoice, isLoading } = useQuery<any>({
    queryKey: [`/api/vendor-invoices/${invoiceId}`],
    enabled: !!invoiceId,
  });

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

  // ── Mutations ──

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
      body: JSON.stringify({ purchaseOrderId: parseInt(linkPoId) }),
    }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => { invalidate(); setShowLinkPoDialog(false); setLinkPoId(""); toast({ title: "PO linked & lines imported" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const unlinkPoMutation = useMutation({
    mutationFn: (poId: number) => fetch(`/api/vendor-invoices/${invoiceId}/po-links/${poId}`, { method: "DELETE" })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => { invalidate(); toast({ title: "PO unlinked" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateInvoiceMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/vendor-invoices/${invoiceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceNumber: editForm.invoiceNumber || undefined,
          ourReference: editForm.ourReference || undefined,
          invoiceDate: editForm.invoiceDate || undefined,
          dueDate: editForm.dueDate || undefined,
          paymentTermsDays: editForm.paymentTermsDays ? parseInt(editForm.paymentTermsDays) : undefined,
          notes: editForm.notes,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => { invalidate(); setEditing(false); toast({ title: "Invoice updated" }); },
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

  // ── Line Mutations ──

  const addLineMutation = useMutation({
    mutationFn: () => fetch(`/api/vendor-invoices/${invoiceId}/lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: newLine.sku || undefined,
        productName: newLine.productName || undefined,
        description: newLine.description || undefined,
        qtyInvoiced: parseInt(newLine.qtyInvoiced) || 1,
        unitCostCents: Math.round(parseFloat(newLine.unitCostDollars || "0") * 100),
      }),
    }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => {
      invalidate();
      setShowAddLineDialog(false);
      setNewLine({ sku: "", productName: "", description: "", qtyInvoiced: "", unitCostDollars: "" });
      toast({ title: "Line added" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteLineMutation = useMutation({
    mutationFn: (lineId: number) => fetch(`/api/vendor-invoice-lines/${lineId}`, { method: "DELETE" })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => { invalidate(); toast({ title: "Line removed" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const matchMutation = useMutation({
    mutationFn: () => action("match"),
    onSuccess: () => { invalidate(); toast({ title: "Match completed" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // ── Attachment Mutations ──

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/vendor-invoices/${invoiceId}/attachments`, { method: "POST", body: formData });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: () => { invalidate(); toast({ title: "File uploaded" }); },
    onError: (e: Error) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const deleteAttachmentMutation = useMutation({
    mutationFn: (id: number) => fetch(`/api/vendor-invoice-attachments/${id}`, { method: "DELETE" })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); return r.json(); }),
    onSuccess: () => { invalidate(); toast({ title: "Attachment removed" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  function startEditing() {
    setEditForm({
      invoiceNumber: invoice?.invoiceNumber || "",
      ourReference: invoice?.ourReference || "",
      invoiceDate: invoice?.invoiceDate ? invoice.invoiceDate.slice(0, 10) : "",
      dueDate: invoice?.dueDate ? invoice.dueDate.slice(0, 10) : "",
      paymentTermsDays: invoice?.paymentTermsDays ? String(invoice.paymentTermsDays) : "",
      notes: invoice?.notes || "",
    });
    setEditing(true);
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  if (!invoice) {
    return <div className="p-6 text-muted-foreground">Invoice not found.</div>;
  }

  const status = invoice.status;
  const canApprove = ["received", "disputed"].includes(status);
  const canDispute = ["received", "approved", "partially_paid"].includes(status);
  const canVoid = status !== "voided";
  const canPay = ["approved", "partially_paid"].includes(status);
  const canEdit = status !== "voided" && status !== "paid";
  const lines: any[] = invoice.lines ?? [];
  const attachments: any[] = invoice.attachments ?? [];

  return (
    <div className="p-2 md:p-6 max-w-5xl mx-auto space-y-4 md:space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/ap-invoices")}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            Invoices
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg md:text-xl font-bold">Invoice #{invoice.invoiceNumber}</h1>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[status] ?? ""}`}>
                {status.replace("_", " ")}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">{invoice.vendorName}</p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap justify-end">
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

      {/* ── Amount Cards ── */}
      <div className="grid grid-cols-3 gap-3 md:gap-4">
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">Invoiced</p>
            <p className="text-xl md:text-2xl font-bold">{formatCents(invoice.invoicedAmountCents)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">Paid</p>
            <p className="text-xl md:text-2xl font-bold text-green-600">{formatCents(invoice.paidAmountCents)}</p>
          </CardContent>
        </Card>
        <Card className={invoice.balanceCents > 0 ? "border-amber-200" : ""}>
          <CardContent className="pt-4 pb-3 text-center">
            <p className="text-xs text-muted-foreground mb-1">Balance</p>
            <p className={`text-xl md:text-2xl font-bold ${invoice.balanceCents > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
              {formatCents(invoice.balanceCents)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 border-b">
        {(["lines", "details", "attachments"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "lines" ? `Lines (${lines.length})` : tab === "attachments" ? `Attachments (${attachments.length})` : "Details"}
          </button>
        ))}
      </div>

      {/* ── Lines Tab ── */}
      {activeTab === "lines" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between py-3">
            <CardTitle className="text-sm">Invoice Line Items</CardTitle>
            {canEdit && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setShowLinkPoDialog(true)}>
                  <Link2 className="h-4 w-4 mr-1" />
                  Link PO
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowAddLineDialog(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Line
                </Button>
                {lines.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => matchMutation.mutate()} disabled={matchMutation.isPending}>
                    <RefreshCw className={`h-4 w-4 mr-1 ${matchMutation.isPending ? "animate-spin" : ""}`} />
                    Run Match
                  </Button>
                )}
              </div>
            )}
          </CardHeader>
          {/* Linked POs */}
          {invoice.poLinks?.length > 0 && (
            <div className="px-6 pb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">POs:</span>
              {invoice.poLinks.map((link: any) => (
                <span key={link.id} className="inline-flex items-center gap-1 text-xs bg-muted/60 rounded px-2 py-0.5">
                  <Link href={`/purchase-orders/${link.purchaseOrderId}`} className="font-mono text-blue-600 hover:underline">
                    {link.poNumber}
                  </Link>
                  {canEdit && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-red-500 ml-0.5"
                      onClick={() => unlinkPoMutation.mutate(link.purchaseOrderId)}
                      title="Unlink PO"
                    >
                      <XCircle className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          <CardContent className="p-0">
            {lines.length === 0 ? (
              <p className="px-6 py-4 text-sm text-muted-foreground">
                No line items yet. Click "Link PO" to import lines from a purchase order.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8">#</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="hidden md:table-cell">Product</TableHead>
                      <TableHead className="text-right">Qty Invoiced</TableHead>
                      <TableHead className="text-right hidden md:table-cell">Qty Ordered</TableHead>
                      <TableHead className="text-right hidden md:table-cell">Qty Received</TableHead>
                      <TableHead className="text-right">Unit Cost</TableHead>
                      <TableHead className="text-right">Line Total</TableHead>
                      <TableHead>Match</TableHead>
                      {canEdit && <TableHead></TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line: any) => {
                      const match = MATCH_COLORS[line.matchStatus] ?? MATCH_COLORS.pending;
                      return (
                        <TableRow key={line.id}>
                          <TableCell className="text-muted-foreground text-xs">{line.lineNumber}</TableCell>
                          <TableCell className="font-mono text-xs">{line.sku || "—"}</TableCell>
                          <TableCell className="hidden md:table-cell text-sm max-w-[200px] truncate">{line.productName || "—"}</TableCell>
                          <TableCell className="text-right font-mono">{line.qtyInvoiced}</TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground hidden md:table-cell">{line.qtyOrdered ?? "—"}</TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground hidden md:table-cell">{line.qtyReceived ?? "—"}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{formatCents(line.unitCostCents)}</TableCell>
                          <TableCell className="text-right font-mono font-medium">{formatCents(line.lineTotalCents)}</TableCell>
                          <TableCell>
                            <span className={`text-xs px-1.5 py-0.5 rounded ${match.className}`}>{match.label}</span>
                          </TableCell>
                          {canEdit && (
                            <TableCell>
                              <Button size="sm" variant="ghost" className="h-7 text-muted-foreground"
                                onClick={() => deleteLineMutation.mutate(line.id)}
                                disabled={deleteLineMutation.isPending}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                    {/* Summary row */}
                    <TableRow className="bg-muted/30 font-medium">
                      <TableCell colSpan={3} className="hidden md:table-cell" />
                      <TableCell className="text-right font-mono">{lines.reduce((s: number, l: any) => s + l.qtyInvoiced, 0)}</TableCell>
                      <TableCell className="hidden md:table-cell" />
                      <TableCell className="hidden md:table-cell" />
                      <TableCell />
                      <TableCell className="text-right font-mono">{formatCents(lines.reduce((s: number, l: any) => s + Number(l.lineTotalCents), 0))}</TableCell>
                      <TableCell />
                      {canEdit && <TableCell />}
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Details Tab ── */}
      {activeTab === "details" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between py-3">
            <CardTitle className="text-sm">Invoice Details</CardTitle>
            {!editing && canEdit && (
              <Button size="sm" variant="ghost" onClick={startEditing}>
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {editing ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs">Invoice Number</Label>
                    <Input value={editForm.invoiceNumber} onChange={e => setEditForm(f => ({ ...f, invoiceNumber: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Our Reference</Label>
                    <Input value={editForm.ourReference} onChange={e => setEditForm(f => ({ ...f, ourReference: e.target.value }))} placeholder="Internal ref" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Payment Terms (days)</Label>
                    <Input type="number" value={editForm.paymentTermsDays} onChange={e => setEditForm(f => ({ ...f, paymentTermsDays: e.target.value }))} placeholder="30" />
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="space-y-1">
                    <Label className="text-xs">Invoice Date</Label>
                    <Input type="date" value={editForm.invoiceDate} onChange={e => setEditForm(f => ({ ...f, invoiceDate: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Due Date</Label>
                    <Input type="date" value={editForm.dueDate} onChange={e => setEditForm(f => ({ ...f, dueDate: e.target.value }))} />
                  </div>
                  <div className="space-y-1 col-span-2">
                    <Label className="text-xs">Notes</Label>
                    <Input value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" />
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
                  <Button size="sm" onClick={() => updateInvoiceMutation.mutate()} disabled={updateInvoiceMutation.isPending}>
                    {updateInvoiceMutation.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div><p className="text-muted-foreground">Invoice Date</p><p className="font-medium">{formatDate(invoice.invoiceDate)}</p></div>
                <div><p className="text-muted-foreground">Due Date</p><p className="font-medium">{formatDate(invoice.dueDate)}</p></div>
                <div><p className="text-muted-foreground">Our Reference</p><p className="font-medium">{invoice.ourReference || "—"}</p></div>
                <div><p className="text-muted-foreground">Payment Terms</p><p className="font-medium">{invoice.paymentTermsDays ? `Net ${invoice.paymentTermsDays}` : "—"}</p></div>
                {invoice.approvedAt && <div><p className="text-muted-foreground">Approved</p><p className="font-medium">{formatDate(invoice.approvedAt)}</p></div>}
                {invoice.disputeReason && <div className="col-span-2"><p className="text-muted-foreground">Dispute Reason</p><p className="font-medium text-red-600">{invoice.disputeReason}</p></div>}
                {invoice.notes && <div className="col-span-2"><p className="text-muted-foreground">Notes</p><p className="font-medium">{invoice.notes}</p></div>}
                {invoice.internalNotes && <div className="col-span-2"><p className="text-muted-foreground">Internal Notes</p><p className="font-medium text-muted-foreground">{invoice.internalNotes}</p></div>}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Attachments Tab ── */}
      {activeTab === "attachments" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between py-3">
            <CardTitle className="text-sm">Attachments</CardTitle>
            {canEdit && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) uploadMutation.mutate(file);
                    e.target.value = "";
                  }}
                />
                <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={uploadMutation.isPending}>
                  <Upload className="h-4 w-4 mr-1" />
                  {uploadMutation.isPending ? "Uploading..." : "Upload File"}
                </Button>
              </>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {attachments.length === 0 ? (
              <p className="px-6 py-4 text-sm text-muted-foreground">No attachments. Upload vendor invoices (Excel, PDF) for record keeping.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attachments.map((att: any) => (
                    <TableRow key={att.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-sm truncate max-w-[250px]">{att.fileName}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatBytes(att.fileSizeBytes)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(att.uploadedAt)}</TableCell>
                      <TableCell>
                        <div className="flex gap-1 justify-end">
                          <Button size="sm" variant="ghost" className="h-7" asChild>
                            <a href={`/api/vendor-invoice-attachments/${att.id}/download`} download>
                              <Download className="h-3.5 w-3.5" />
                            </a>
                          </Button>
                          {canEdit && (
                            <Button size="sm" variant="ghost" className="h-7 text-muted-foreground"
                              onClick={() => deleteAttachmentMutation.mutate(att.id)}
                              disabled={deleteAttachmentMutation.isPending}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Payment History ── */}
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

      {/* ── Dispute Dialog ── */}
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

      {/* ── Void Dialog ── */}
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

      {/* ── Link PO Dialog ── */}
      <Dialog open={showLinkPoDialog} onOpenChange={setShowLinkPoDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Link Purchase Order</DialogTitle>
            <DialogDescription>Select a PO from {invoice.vendorName}. Line items will be imported automatically.</DialogDescription>
          </DialogHeader>
          <LinkPoDialogContent
            invoice={invoice}
            linkPoId={linkPoId}
            setLinkPoId={setLinkPoId}
            linkPoMutation={linkPoMutation}
            onClose={() => setShowLinkPoDialog(false)}
          />
        </DialogContent>
      </Dialog>

      {/* ── Add Line Dialog ── */}
      <Dialog open={showAddLineDialog} onOpenChange={setShowAddLineDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Invoice Line</DialogTitle>
            <DialogDescription>Manually add a line item.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>SKU</Label>
                <Input value={newLine.sku} onChange={e => setNewLine(f => ({ ...f, sku: e.target.value }))} placeholder="Optional" className="font-mono" />
              </div>
              <div className="space-y-2">
                <Label>Product Name</Label>
                <Input value={newLine.productName} onChange={e => setNewLine(f => ({ ...f, productName: e.target.value }))} placeholder="Optional" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={newLine.description} onChange={e => setNewLine(f => ({ ...f, description: e.target.value }))} placeholder="Optional" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Quantity *</Label>
                <Input type="number" min="1" value={newLine.qtyInvoiced} onChange={e => setNewLine(f => ({ ...f, qtyInvoiced: e.target.value }))} placeholder="1" />
              </div>
              <div className="space-y-2">
                <Label>Unit Cost ($) *</Label>
                <Input type="number" step="0.01" min="0" value={newLine.unitCostDollars} onChange={e => setNewLine(f => ({ ...f, unitCostDollars: e.target.value }))} placeholder="0.00" />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAddLineDialog(false)}>Cancel</Button>
              <Button onClick={() => addLineMutation.mutate()} disabled={!newLine.qtyInvoiced || !newLine.unitCostDollars || addLineMutation.isPending}>
                {addLineMutation.isPending ? "Adding..." : "Add Line"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Record Payment Dialog ── */}
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
