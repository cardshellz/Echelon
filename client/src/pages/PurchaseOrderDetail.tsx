import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  ArrowLeft,
  FileText,
  Send,
  CheckCircle,
  XCircle,
  Clock,
  Plus,
  Trash2,
  Package,
  ChevronsUpDown,
  Check,
  AlertTriangle,
  RotateCcw,
  Ban,
  Archive,
  Truck,
} from "lucide-react";

const STATUS_BADGES: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string; color?: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  pending_approval: { variant: "outline", label: "Pending Approval", color: "text-amber-600 border-amber-300" },
  approved: { variant: "default", label: "Approved" },
  sent: { variant: "default", label: "Sent", color: "bg-blue-500" },
  acknowledged: { variant: "default", label: "Acknowledged", color: "bg-indigo-500" },
  partially_received: { variant: "outline", label: "Partial Receipt", color: "text-orange-600 border-orange-300" },
  received: { variant: "default", label: "Received", color: "bg-green-600" },
  closed: { variant: "secondary", label: "Closed" },
  cancelled: { variant: "destructive", label: "Cancelled" },
};

function formatCents(cents: number | null | undefined): string {
  if (!cents && cents !== 0) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PurchaseOrderDetail() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/purchase-orders/:id");
  const poId = params?.id ? Number(params.id) : null;

  const [activeTab, setActiveTab] = useState("lines");
  const [showAddLineDialog, setShowAddLineDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showAckDialog, setShowAckDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [ackData, setAckData] = useState({ vendorRefNumber: "", confirmedDeliveryDate: "" });

  // Add line form
  const [productSearch, setProductSearch] = useState("");
  const [productOpen, setProductOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);
  const [selectedProductForLine, setSelectedProductForLine] = useState<any>(null);
  const [unitCostDollars, setUnitCostDollars] = useState("");
  const [saveToVendorCatalog, setSaveToVendorCatalog] = useState(true);
  const [setAsPreferred, setSetAsPreferred] = useState(false);
  const [newLine, setNewLine] = useState({
    productId: 0,
    productVariantId: 0,
    orderQty: 1,
    unitCostCents: 0,
    unitsPerUom: 1,
    vendorSku: "",
    description: "",
  });

  // Queries
  const { data: po, isLoading } = useQuery<any>({
    queryKey: [`/api/purchase-orders/${poId}`],
    enabled: !!poId,
  });

  const { data: historyData } = useQuery<{ history: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/history`],
    enabled: !!poId && activeTab === "history",
  });

  const { data: receiptsData } = useQuery<{ receipts: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/receipts`],
    enabled: !!poId && activeTab === "receipts",
  });

  const { data: products = [] } = useQuery<any[]>({
    queryKey: ["/api/products"],
    enabled: showAddLineDialog,
  });

  const lines = po?.lines ?? [];
  const history = historyData?.history ?? [];
  const receipts = receiptsData?.receipts ?? [];
  const isDraft = po?.status === "draft";

  // Filtered products for typeahead
  const filteredProducts = products
    .filter((p: any) =>
      !productSearch ||
      p.name?.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.sku?.toLowerCase().includes(productSearch.toLowerCase())
    )
    .slice(0, 50);

  // Selected variant info for case helper
  const selectedVariant = selectedProductForLine?.variants?.find(
    (v: any) => v.id === newLine.productVariantId
  );
  const casesEquiv = newLine.unitsPerUom > 1 && newLine.orderQty > 0
    ? Math.ceil(newLine.orderQty / newLine.unitsPerUom)
    : null;

  // Mutations
  function createTransitionMutation(endpoint: string, method = "POST") {
    return useMutation({
      mutationFn: async (body?: any) => {
        const res = await fetch(`/api/purchase-orders/${poId}/${endpoint}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || `Failed to ${endpoint}`);
        }
        return res.json();
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
        toast({ title: "Success", description: `PO ${endpoint.replace(/-/g, " ")} completed` });
      },
      onError: (err: Error) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      },
    });
  }

  const submitMutation = createTransitionMutation("submit");
  const returnToDraftMutation = createTransitionMutation("return-to-draft");
  const approveMutation = createTransitionMutation("approve");
  const sendMutation = createTransitionMutation("send");
  const closeMutation = createTransitionMutation("close");
  const createReceiptMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/purchase-orders/${poId}/create-receipt`, { method: "POST" });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to create receipt"); }
      return res.json();
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/receipts`] });
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      toast({ title: "Receipt created", description: `Receipt ${receipt.receiptNumber} created. Open Receiving to process it.` });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const acknowledgeMutation = useMutation({
    mutationFn: async (data: typeof ackData) => {
      const res = await fetch(`/api/purchase-orders/${poId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorRefNumber: data.vendorRefNumber || undefined,
          confirmedDeliveryDate: data.confirmedDeliveryDate || undefined,
        }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      setShowAckDialog(false);
      toast({ title: "Acknowledged", description: "Vendor acknowledgment recorded" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (reason: string) => {
      const endpoint = ["sent", "acknowledged"].includes(po?.status) ? "void" : "cancel";
      const res = await fetch(`/api/purchase-orders/${poId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      setShowCancelDialog(false);
      setCancelReason("");
      toast({ title: "Cancelled", description: "Purchase order cancelled" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const catalogUpsertMutation = useMutation({
    mutationFn: async (data: {
      vendorId: number; productId: number; productVariantId: number;
      vendorSku: string; unitCostCents: number; packSize: number; isPreferred: boolean;
    }) => {
      const res = await fetch("/api/vendor-products/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor-products"] });
      toast({
        title: result.created ? "Added to catalog" : "Catalog updated",
        description: result.created
          ? "Vendor catalog entry created for this product."
          : "Vendor catalog entry updated with latest cost.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Catalog save failed", description: err.message, variant: "destructive" });
    },
  });

  const addLineMutation = useMutation({
    mutationFn: async (data: typeof newLine & { unitCostCents: number }) => {
      const res = await fetch(`/api/purchase-orders/${poId}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      // Capture before state reset
      const catalogData = saveToVendorCatalog && po?.vendorId && newLine.productVariantId ? {
        vendorId: po.vendorId,
        productId: newLine.productId,
        productVariantId: newLine.productVariantId,
        vendorSku: newLine.vendorSku,
        unitCostCents: Math.round(parseFloat(unitCostDollars || "0") * 100),
        packSize: newLine.unitsPerUom,
        isPreferred: setAsPreferred,
      } : null;

      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      setShowAddLineDialog(false);
      setNewLine({ productId: 0, productVariantId: 0, orderQty: 1, unitCostCents: 0, unitsPerUom: 1, vendorSku: "", description: "" });
      setProductSearch("");
      setSelectedProductForLine(null);
      setUnitCostDollars("");
      setSaveToVendorCatalog(true);
      setSetAsPreferred(false);
      toast({ title: "Line added" });

      if (catalogData) catalogUpsertMutation.mutate(catalogData);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteLineMutation = useMutation({
    mutationFn: async (lineId: number) => {
      const res = await fetch(`/api/purchase-orders/lines/${lineId}`, { method: "DELETE" });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      toast({ title: "Line removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!po) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Purchase order not found.</p>
        <Button variant="link" onClick={() => navigate("/purchase-orders")}>Back to list</Button>
      </div>
    );
  }

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/purchase-orders")} className="min-h-[44px]">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl md:text-2xl font-bold font-mono">{po.poNumber}</h1>
            <Badge
              variant={STATUS_BADGES[po.status]?.variant || "secondary"}
              className={`text-sm ${STATUS_BADGES[po.status]?.color || ""}`}
            >
              {STATUS_BADGES[po.status]?.label || po.status}
            </Badge>
            {po.priority === "rush" && <Badge variant="destructive">Rush</Badge>}
            {po.priority === "high" && <Badge variant="outline" className="text-orange-600 border-orange-300">High</Badge>}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {po.vendor?.name || `Vendor #${po.vendorId}`}
            {po.poType !== "standard" && ` • ${po.poType}`}
          </p>
        </div>

        {/* Context-sensitive action buttons */}
        <div className="flex gap-2 flex-wrap w-full sm:w-auto">
          {po.status === "draft" && (
            <Button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Send className="h-4 w-4 mr-2" />
              Submit
            </Button>
          )}
          {po.status === "pending_approval" && (
            <>
              <Button onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
                <CheckCircle className="h-4 w-4 mr-2" />
                Approve
              </Button>
              <Button variant="outline" onClick={() => returnToDraftMutation.mutate()} disabled={returnToDraftMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
                <RotateCcw className="h-4 w-4 mr-2" />
                Return to Draft
              </Button>
            </>
          )}
          {po.status === "approved" && (
            <Button onClick={() => sendMutation.mutate()} disabled={sendMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Send className="h-4 w-4 mr-2" />
              Mark as Sent
            </Button>
          )}
          {po.status === "sent" && (
            <Button onClick={() => setShowAckDialog(true)} className="flex-1 sm:flex-none min-h-[44px]">
              <CheckCircle className="h-4 w-4 mr-2" />
              Acknowledge
            </Button>
          )}
          {["sent", "acknowledged", "partially_received"].includes(po.status) && (
            <Button variant="outline" onClick={() => createReceiptMutation.mutate()} disabled={createReceiptMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Truck className="h-4 w-4 mr-2" />
              Create Receipt
            </Button>
          )}
          {po.status === "received" && (
            <Button onClick={() => closeMutation.mutate()} disabled={closeMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Archive className="h-4 w-4 mr-2" />
              Close PO
            </Button>
          )}
          {!["closed", "cancelled"].includes(po.status) && (
            <Button variant="outline" onClick={() => setShowCancelDialog(true)} className="flex-1 sm:flex-none min-h-[44px] text-red-600 hover:text-red-700">
              <Ban className="h-4 w-4 mr-2" />
              {["sent", "acknowledged"].includes(po.status) ? "Void" : "Cancel"}
            </Button>
          )}
        </div>
      </div>

      {/* Summary card */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Subtotal</div>
            <div className="font-mono font-medium">{formatCents(po.subtotalCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Discount</div>
            <div className="font-mono font-medium">{formatCents(po.discountCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Tax</div>
            <div className="font-mono font-medium">{formatCents(po.taxCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Shipping</div>
            <div className="font-mono font-medium">{formatCents(po.shippingCostCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Total</div>
            <div className="font-mono font-bold text-lg">{formatCents(po.totalCents)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs: Lines, Receipts, History */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="lines">Lines ({lines.length})</TabsTrigger>
          <TabsTrigger value="receipts">Receipts</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* ── Lines Tab ── */}
        <TabsContent value="lines" className="space-y-4">
          {isDraft && (
            <Button variant="outline" onClick={() => setShowAddLineDialog(true)} className="min-h-[44px]">
              <Plus className="h-4 w-4 mr-2" />
              Add Line
            </Button>
          )}

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {lines.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-center text-muted-foreground">
                  No lines. {isDraft ? "Add items to this PO." : ""}
                </CardContent>
              </Card>
            ) : (
              lines.map((line: any) => (
                <Card key={line.id}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">{line.sku || "—"}</span>
                          <Badge variant="outline" className="text-xs">{line.status}</Badge>
                        </div>
                        <div className="text-sm mt-1 truncate">{line.productName || "—"}</div>
                        <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                          <span>
                            {(line.unitsPerUom || 1) > 1
                              ? `${(line.orderQty || 0).toLocaleString()} pcs (${Math.ceil((line.orderQty || 0) / (line.unitsPerUom || 1))} cases)`
                              : `Qty: ${line.receivedQty || 0}/${line.orderQty}`}
                          </span>
                          <span>@ {formatCents(line.unitCostCents)}/pc</span>
                          <span className="font-medium">{formatCents(line.lineTotalCents)}</span>
                        </div>
                      </div>
                      {isDraft && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[44px] min-w-[44px] p-0"
                          onClick={() => { if (confirm("Remove this line?")) deleteLineMutation.mutate(line.id); }}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          {/* Desktop table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Vendor SKU</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Unit Cost</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                  <TableHead>Status</TableHead>
                  {isDraft && <TableHead className="w-12"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={isDraft ? 10 : 9} className="text-center text-muted-foreground py-8">
                      No lines. {isDraft ? "Click \"Add Line\" to add items." : ""}
                    </TableCell>
                  </TableRow>
                ) : (
                  lines.map((line: any) => (
                    <TableRow key={line.id}>
                      <TableCell className="text-muted-foreground">{line.lineNumber}</TableCell>
                      <TableCell className="font-mono">{line.sku || "—"}</TableCell>
                      <TableCell className="max-w-[200px] truncate">{line.productName || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{line.vendorSku || "—"}</TableCell>
                      <TableCell className="text-right">
                        {(line.unitsPerUom || 1) > 1
                          ? <span>{(line.orderQty || 0).toLocaleString()} pcs<br /><span className="text-xs text-muted-foreground">({Math.ceil((line.orderQty || 0) / (line.unitsPerUom || 1))} cases)</span></span>
                          : line.orderQty}
                      </TableCell>
                      <TableCell className="text-right">
                        {(line.unitsPerUom || 1) > 1
                          ? <span>{(line.receivedQty || 0).toLocaleString()} pcs<br /><span className="text-xs text-muted-foreground">({Math.ceil((line.receivedQty || 0) / (line.unitsPerUom || 1))} cases)</span></span>
                          : line.receivedQty || 0}
                        {(line.damagedQty || 0) > 0 && (
                          <span className="text-red-500 ml-1">({line.damagedQty} dmg)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatCents(line.unitCostCents)}</TableCell>
                      <TableCell className="text-right font-mono font-medium">{formatCents(line.lineTotalCents)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{line.status}</Badge>
                      </TableCell>
                      {isDraft && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { if (confirm("Remove this line?")) deleteLineMutation.mutate(line.id); }}
                            disabled={deleteLineMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ── Receipts Tab ── */}
        <TabsContent value="receipts" className="space-y-4">
          {receipts.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-center text-muted-foreground">
                No receipts linked to this PO yet.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>PO Line</TableHead>
                    <TableHead>Receiving Order</TableHead>
                    <TableHead className="text-right">Qty Received</TableHead>
                    <TableHead className="text-right">PO Cost</TableHead>
                    <TableHead className="text-right">Actual Cost</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipts.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell>Line #{r.purchaseOrderLineId}</TableCell>
                      <TableCell>RO #{r.receivingOrderId}</TableCell>
                      <TableCell className="text-right">{r.qtyReceived}</TableCell>
                      <TableCell className="text-right font-mono">{formatCents(r.poUnitCostCents)}</TableCell>
                      <TableCell className="text-right font-mono">{formatCents(r.actualUnitCostCents)}</TableCell>
                      <TableCell className={`text-right font-mono ${(r.varianceCents || 0) > 0 ? "text-red-500" : (r.varianceCents || 0) < 0 ? "text-green-500" : ""}`}>
                        {formatCents(r.varianceCents)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.createdAt ? format(new Date(r.createdAt), "MMM d, yyyy") : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* ── History Tab ── */}
        <TabsContent value="history" className="space-y-4">
          {history.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-center text-muted-foreground">
                No status history.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {history.map((h: any, i: number) => (
                <Card key={h.id || i}>
                  <CardContent className="p-3 flex items-start gap-3">
                    <div className="mt-1">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {h.fromStatus && (
                          <>
                            <Badge variant="outline" className="text-xs">{h.fromStatus}</Badge>
                            <span className="text-xs text-muted-foreground">→</span>
                          </>
                        )}
                        <Badge variant={STATUS_BADGES[h.toStatus]?.variant || "secondary"} className={`text-xs ${STATUS_BADGES[h.toStatus]?.color || ""}`}>
                          {STATUS_BADGES[h.toStatus]?.label || h.toStatus}
                        </Badge>
                      </div>
                      {h.notes && <p className="text-sm mt-1">{h.notes}</p>}
                      <p className="text-xs text-muted-foreground mt-1">
                        {h.changedAt ? format(new Date(h.changedAt), "MMM d, yyyy h:mm a") : ""}
                        {h.changedBy && ` • ${h.changedBy}`}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Add Line Dialog ── */}
      <Dialog open={showAddLineDialog} onOpenChange={(open) => {
        setShowAddLineDialog(open);
        if (!open) {
          setProductSearch("");
          setSelectedProductForLine(null);
          setUnitCostDollars("");
          setSaveToVendorCatalog(true);
          setSetAsPreferred(false);
          setNewLine({ productId: 0, productVariantId: 0, orderQty: 1, unitCostCents: 0, unitsPerUom: 1, vendorSku: "", description: "" });
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Line Item</DialogTitle>
            <DialogDescription>Search by product, then select the variant (e.g. case size).</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">

            {/* Step 1: Product search */}
            <div className="space-y-2">
              <Label>Product *</Label>
              <Popover open={productOpen} onOpenChange={setProductOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-between h-10 font-normal">
                    {selectedProductForLine ? selectedProductForLine.name : "Search product..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Search name or SKU..." value={productSearch} onValueChange={setProductSearch} />
                    <CommandList>
                      <CommandEmpty>No products found.</CommandEmpty>
                      <CommandGroup>
                        {filteredProducts.map((p: any) => (
                          <CommandItem
                            key={p.id}
                            value={String(p.id)}
                            onSelect={() => {
                              setSelectedProductForLine(p);
                              setNewLine(prev => ({ ...prev, productId: p.id, productVariantId: 0, unitsPerUom: 1 }));
                              setProductOpen(false);
                              setProductSearch("");
                            }}
                          >
                            <Check className={`mr-2 h-4 w-4 ${selectedProductForLine?.id === p.id ? "opacity-100" : "opacity-0"}`} />
                            <span className="font-mono text-xs mr-2 text-muted-foreground">{p.sku}</span>
                            <span className="truncate">{p.name}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            {/* Step 2: Variant (case size) — only shown after product selected */}
            {selectedProductForLine && (
              <div className="space-y-2">
                <Label>Variant / Case Size *</Label>
                <Popover open={variantOpen} onOpenChange={setVariantOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-between h-10 font-normal">
                      {selectedVariant
                        ? `${selectedVariant.sku} — ${selectedVariant.name}`
                        : "Select variant..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command>
                      <CommandList>
                        <CommandEmpty>No variants available.</CommandEmpty>
                        <CommandGroup>
                          {(selectedProductForLine.variants || []).map((v: any) => (
                            <CommandItem
                              key={v.id}
                              value={String(v.id)}
                              onSelect={() => {
                                setNewLine(prev => ({
                                  ...prev,
                                  productVariantId: v.id,
                                  unitsPerUom: v.unitsPerVariant || 1,
                                }));
                                setVariantOpen(false);
                              }}
                            >
                              <Check className={`mr-2 h-4 w-4 ${newLine.productVariantId === v.id ? "opacity-100" : "opacity-0"}`} />
                              <span className="font-mono text-xs mr-2">{v.sku}</span>
                              <span className="truncate">{v.name}</span>
                              {(v.unitsPerVariant || 1) > 1 && (
                                <span className="ml-auto text-xs text-muted-foreground">{v.unitsPerVariant} pcs/case</span>
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            )}

            {/* Qty in pieces + case helper */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Qty (pieces) *</Label>
                <Input
                  type="number"
                  min="1"
                  value={newLine.orderQty || ""}
                  onChange={e => setNewLine(prev => ({ ...prev, orderQty: parseInt(e.target.value) || 0 }))}
                  className="h-10"
                />
                {casesEquiv !== null && (
                  <p className="text-xs text-muted-foreground">= {casesEquiv} cases @ {newLine.unitsPerUom} pcs/case</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Unit Cost ($/pc) *</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  placeholder="0.05"
                  value={unitCostDollars}
                  onChange={e => setUnitCostDollars(e.target.value)}
                  className="h-10"
                />
                {unitCostDollars && newLine.orderQty > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Total: {formatCents(Math.round(parseFloat(unitCostDollars || "0") * 100) * newLine.orderQty)}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Vendor SKU</Label>
              <Input
                value={newLine.vendorSku}
                onChange={e => setNewLine(prev => ({ ...prev, vendorSku: e.target.value }))}
                placeholder="Vendor's catalog number"
                className="h-10"
              />
            </div>

            {/* Vendor catalog section */}
            {newLine.productVariantId > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="saveToVendorCatalog"
                      checked={saveToVendorCatalog}
                      onCheckedChange={(v) => setSaveToVendorCatalog(!!v)}
                    />
                    <label htmlFor="saveToVendorCatalog" className="text-sm cursor-pointer select-none">
                      Save to vendor catalog
                    </label>
                  </div>
                  {saveToVendorCatalog && (
                    <div className="flex items-center gap-2 ml-6">
                      <Checkbox
                        id="setAsPreferred"
                        checked={setAsPreferred}
                        onCheckedChange={(v) => setSetAsPreferred(!!v)}
                      />
                      <label htmlFor="setAsPreferred" className="text-sm cursor-pointer select-none text-muted-foreground">
                        Set as preferred vendor for this product
                      </label>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAddLineDialog(false)}>Cancel</Button>
              <Button
                onClick={() => addLineMutation.mutate({
                  ...newLine,
                  unitCostCents: Math.round(parseFloat(unitCostDollars || "0") * 100),
                })}
                disabled={!newLine.productVariantId || newLine.orderQty < 1 || !unitCostDollars || addLineMutation.isPending || catalogUpsertMutation.isPending}
              >
                {addLineMutation.isPending ? "Adding..." : "Add Line"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Cancel Dialog ── */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              {["sent", "acknowledged"].includes(po.status) ? "Void" : "Cancel"} Purchase Order
            </DialogTitle>
            <DialogDescription>This action cannot be undone. Please provide a reason.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Textarea
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="Why is this PO being cancelled?"
                rows={3}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCancelDialog(false)}>Back</Button>
              <Button
                variant="destructive"
                onClick={() => cancelMutation.mutate(cancelReason)}
                disabled={!cancelReason.trim() || cancelMutation.isPending}
              >
                {cancelMutation.isPending ? "Cancelling..." : "Confirm Cancel"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Acknowledge Dialog ── */}
      <Dialog open={showAckDialog} onOpenChange={setShowAckDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Vendor Acknowledgment</DialogTitle>
            <DialogDescription>Record the vendor's acknowledgment of this PO.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Vendor Reference #</Label>
              <Input
                value={ackData.vendorRefNumber}
                onChange={e => setAckData(prev => ({ ...prev, vendorRefNumber: e.target.value }))}
                placeholder="Vendor's order confirmation number"
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label>Confirmed Delivery Date</Label>
              <Input
                type="date"
                value={ackData.confirmedDeliveryDate}
                onChange={e => setAckData(prev => ({ ...prev, confirmedDeliveryDate: e.target.value }))}
                className="h-10"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAckDialog(false)}>Cancel</Button>
              <Button
                onClick={() => acknowledgeMutation.mutate(ackData)}
                disabled={acknowledgeMutation.isPending}
              >
                {acknowledgeMutation.isPending ? "Saving..." : "Record Acknowledgment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
