import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { Plus, FileText, Search } from "lucide-react";
import { format, parseISO } from "date-fns";

function formatCents(cents: number | null | undefined): string {
  if (!cents && cents !== 0) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_COLORS: Record<string, string> = {
  received: "bg-blue-100 text-blue-700",
  approved: "bg-indigo-100 text-indigo-700",
  partially_paid: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700",
  disputed: "bg-red-100 text-red-700",
  voided: "bg-slate-100 text-slate-400 line-through",
};

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

function isOverdue(dueDate: string | null | undefined, status: string) {
  if (!dueDate || ["paid", "voided"].includes(status)) return false;
  return new Date(dueDate) < new Date();
}

export default function APInvoices() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState("open");
  const [search, setSearch] = useState("");
  const [showNewDialog, setShowNewDialog] = useState(false);

  const [newInvoice, setNewInvoice] = useState({
    invoiceNumber: "",
    ourReference: "",
    vendorId: "",
    invoicedAmountDollars: "",
    invoiceDate: "",
    dueDate: "",
    paymentTermsDays: "",
    notes: "",
  });

  const statusFilter: Record<string, string[] | undefined> = {
    open: ["received", "approved", "partially_paid"],
    needs_approval: ["received"],
    overdue: ["received", "approved", "partially_paid"],
    paid: ["paid"],
    voided: ["voided"],
    all: undefined,
  };

  const queryParams = new URLSearchParams();
  if (statusFilter[tab]) queryParams.set("status", statusFilter[tab]!.join(","));
  if (tab === "overdue") queryParams.set("overdue", "true");

  const { data, isLoading } = useQuery<{ invoices: any[] }>({
    queryKey: [`/api/vendor-invoices?${queryParams.toString()}`],
  });

  const { data: vendorsData } = useQuery<any[]>({ queryKey: ["/api/vendors"] });
  const vendors: any[] = vendorsData ?? [];

  const createMutation = useMutation({
    mutationFn: async (body: any) => {
      const res = await fetch("/api/vendor-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onSuccess: (invoice) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor-invoices"] });
      setShowNewDialog(false);
      toast({ title: "Invoice created" });
      navigate(`/ap-invoices/${invoice.id}`);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const invoices: any[] = (data?.invoices ?? []).filter((inv: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      inv.invoiceNumber?.toLowerCase().includes(q) ||
      inv.vendorName?.toLowerCase().includes(q) ||
      inv.ourReference?.toLowerCase().includes(q) ||
      inv.poNumbers?.some((p: string) => p.toLowerCase().includes(q))
    );
  });

  function handleCreate() {
    const vendorId = parseInt(newInvoice.vendorId);
    if (!vendorId || !newInvoice.invoiceNumber || !newInvoice.invoicedAmountDollars) {
      toast({ title: "Missing fields", description: "Vendor, invoice number, and amount are required", variant: "destructive" });
      return;
    }
    createMutation.mutate({
      vendorId,
      invoiceNumber: newInvoice.invoiceNumber,
      ourReference: newInvoice.ourReference || undefined,
      invoicedAmountCents: Math.round(parseFloat(newInvoice.invoicedAmountDollars) * 100),
      invoiceDate: newInvoice.invoiceDate || undefined,
      dueDate: newInvoice.dueDate || undefined,
      paymentTermsDays: newInvoice.paymentTermsDays ? parseInt(newInvoice.paymentTermsDays) : undefined,
      notes: newInvoice.notes || undefined,
    });
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Vendor Invoices</h1>
          <p className="text-muted-foreground text-sm">Track and approve vendor invoices</p>
        </div>
        <Button size="sm" onClick={() => setShowNewDialog(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Invoice
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="open">Open</TabsTrigger>
            <TabsTrigger value="needs_approval">Needs Approval</TabsTrigger>
            <TabsTrigger value="overdue">Overdue</TabsTrigger>
            <TabsTrigger value="paid">Paid</TabsTrigger>
            <TabsTrigger value="voided">Voided</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative ml-auto w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search invoices..."
            className="pl-9 h-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-48">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          ) : invoices.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <FileText className="h-10 w-10 mx-auto mb-3 opacity-20" />
              <p className="text-sm">No invoices found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>PO(s)</TableHead>
                  <TableHead>Invoice Date</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((inv: any) => {
                  const overdue = isOverdue(inv.dueDate, inv.status);
                  return (
                    <TableRow
                      key={inv.id}
                      className={`cursor-pointer hover:bg-muted/50 ${inv.status === "voided" ? "opacity-40" : ""}`}
                      onClick={() => navigate(`/ap-invoices/${inv.id}`)}
                    >
                      <TableCell className="font-mono font-medium">{inv.invoiceNumber}</TableCell>
                      <TableCell>{inv.vendorName ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {inv.poNumbers?.length > 0 ? inv.poNumbers.join(", ") : "—"}
                      </TableCell>
                      <TableCell className="text-sm">{formatDate(inv.invoiceDate)}</TableCell>
                      <TableCell className={`text-sm ${overdue ? "text-red-600 font-medium" : ""}`}>
                        {formatDate(inv.dueDate)}
                        {overdue && <span className="ml-1 text-xs">OVERDUE</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatCents(inv.invoicedAmountCents)}</TableCell>
                      <TableCell className="text-right font-mono font-medium">
                        {inv.balanceCents > 0 ? formatCents(inv.balanceCents) : <span className="text-green-600">Paid</span>}
                      </TableCell>
                      <TableCell>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[inv.status] ?? ""}`}>
                          {inv.status.replace("_", " ")}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* New Invoice Dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Vendor Invoice</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Vendor *</Label>
              <select
                className="w-full border rounded-md h-10 px-3 text-sm bg-background"
                value={newInvoice.vendorId}
                onChange={(e) => setNewInvoice((f) => ({ ...f, vendorId: e.target.value }))}
              >
                <option value="">Select vendor...</option>
                {vendors.map((v: any) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Invoice Number *</Label>
                <Input
                  placeholder="Vendor's invoice #"
                  value={newInvoice.invoiceNumber}
                  onChange={(e) => setNewInvoice((f) => ({ ...f, invoiceNumber: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Our Reference</Label>
                <Input
                  placeholder="Internal ref"
                  value={newInvoice.ourReference}
                  onChange={(e) => setNewInvoice((f) => ({ ...f, ourReference: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Invoice Amount ($) *</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={newInvoice.invoicedAmountDollars}
                onChange={(e) => setNewInvoice((f) => ({ ...f, invoicedAmountDollars: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Invoice Date</Label>
                <Input
                  type="date"
                  value={newInvoice.invoiceDate}
                  onChange={(e) => setNewInvoice((f) => ({ ...f, invoiceDate: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Due Date</Label>
                <Input
                  type="date"
                  value={newInvoice.dueDate}
                  onChange={(e) => setNewInvoice((f) => ({ ...f, dueDate: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Input
                placeholder="Optional notes"
                value={newInvoice.notes}
                onChange={(e) => setNewInvoice((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowNewDialog(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create Invoice"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
