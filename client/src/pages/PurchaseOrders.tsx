import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";

// Spec A feature flag shape. Only `useNewPoEditor` matters on this page;
// the rest of the keys are queried together and ignored here.
type ProcurementSettings = {
  useNewPoEditor: boolean;
  [key: string]: unknown;
};
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  ShoppingCart,
  Plus,
  Search,
  ChevronsUpDown,
  Check,
  FileText,
  DollarSign,
  Clock,
  Package,
  AlertCircle,
  Trash2,
} from "lucide-react";

// Status badge config
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
  if (!cents) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type Vendor = { id: number; name: string; code: string; defaultIncoterms?: string | null; email?: string | null; country?: string | null; };
type PurchaseOrder = {
  id: number;
  poNumber: string;
  vendorId: number;
  status: string;
  poType: string;
  priority: string;
  lineCount: number;
  totalCents: number | null;
  expectedDeliveryDate: string | null;
  createdAt: string;
  vendor?: Vendor;
};

type InlineLineItem = {
  id: string; // temp client-side id
  productId: number;
  productVariantId: number;
  productName: string;
  sku: string;
  orderQty: number;
  totalCostDollars: string;
  unitCostCents: number;
  unitsPerUom: number;
  vendorSku: string;
  vendorProductId?: number;
  saveToVendorCatalog: boolean;
};

/** Convert a dollar string to cents without floating-point artifacts */
function dollarsToCents(dollars: string): number {
  const parts = dollars.split(".");
  const whole = parseInt(parts[0] || "0", 10) * 100;
  if (!parts[1]) return whole;
  const frac = parts[1].padEnd(2, "0");
  const cents = parseInt(frac.slice(0, 2), 10);
  return whole + cents;
}

function formatCentsShort(cents: number | null | undefined): string {
  if (!cents) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PurchaseOrders() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  // Filters
  const [statusFilter, setStatusFilter] = useState("active");
  const [searchQuery, setSearchQuery] = useState("");
  const [vendorFilter, setVendorFilter] = useState<number | null>(null);

  // Spec A feature flag. When true, '+ New Purchase Order' navigates to the
  // new full-page editor instead of opening the legacy dialog. Flag lives on
  // procurement settings so an admin can flip it without a redeploy.
  const { data: procurementSettings } = useQuery<ProcurementSettings>({
    queryKey: ["/api/settings/procurement"],
    queryFn: async () => {
      const res = await fetch("/api/settings/procurement");
      if (!res.ok) throw new Error("Failed to load procurement settings");
      return res.json();
    },
    // Not critical for the rest of the page; default staleTime is fine.
    retry: false,
  });
  const useNewPoEditor = procurementSettings?.useNewPoEditor === true;

  function handleNewPoClick() {
    if (useNewPoEditor) {
      navigate("/purchase-orders/new");
      return;
    }
    setShowCreateDialog(true);
  }

  // Choose the right destination for clicking a PO row or card.
  // When the new editor flag is on, drafts open in the inline editor (same
  // flow as creation). Everything else (sent, received, etc.) opens in the
  // existing detail page where receipts/invoices/shipments/history tabs
  // still live.
  function poHref(po: PurchaseOrder): string {
    if (useNewPoEditor && po.status === "draft") {
      return `/purchase-orders/${po.id}/edit`;
    }
    return `/purchase-orders/${po.id}`;
  }

  // Create dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");

  // New vendor dialog
  const [showNewVendorDialog, setShowNewVendorDialog] = useState(false);
  const [newVendor, setNewVendor] = useState({ code: "", name: "", contactName: "", email: "", phone: "", address: "", notes: "" });
  const [newPO, setNewPO] = useState({
    vendorId: 0,
    poType: "standard",
    priority: "normal",
    incoterms: "",
    expectedDeliveryDate: "",
    vendorNotes: "",
    internalNotes: "",
  });

  // Inline line items for PO creation
  const [inlineLines, setInlineLines] = useState<InlineLineItem[]>([]);
  const [inlineProductOpen, setInlineProductOpen] = useState(false);
  const [inlineProductSearch, setInlineProductSearch] = useState("");
  const [inlineVariantOpen, setInlineVariantOpen] = useState(false);
  const [addingLine, setAddingLine] = useState(false);
  const [inlineSelectedProduct, setInlineSelectedProduct] = useState<any>(null);
  const [inlineSelectedVariant, setInlineSelectedVariant] = useState<any>(null);
  const [inlineQty, setInlineQty] = useState("1");
  const [inlineTotalCost, setInlineTotalCost] = useState("");
  const [inlineVendorSku, setInlineVendorSku] = useState("");
  const [inlineCatalogMode, setInlineCatalogMode] = useState<"catalog" | "search">("catalog");
  const [inlineCatalogSearch, setInlineCatalogSearch] = useState("");
  const [inlineSelectedCatalogEntry, setInlineSelectedCatalogEntry] = useState<any>(null);

  // Queries
  const { data: poData } = useQuery<{ purchaseOrders: PurchaseOrder[]; total: number }>({
    queryKey: ["/api/purchase-orders", statusFilter, searchQuery, vendorFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all" && statusFilter !== "active") params.set("status", statusFilter);
      if (searchQuery) params.set("search", searchQuery);
      if (vendorFilter) params.set("vendorId", String(vendorFilter));
      params.set("limit", "100");
      const res = await fetch(`/api/purchase-orders?${params}`);
      if (!res.ok) throw new Error("Failed to fetch POs");
      return res.json();
    },
  });

  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ["/api/vendors"],
  });

  // Products for inline line editor
  const { data: products = [] } = useQuery<any[]>({
    queryKey: ["/api/products"],
    enabled: showCreateDialog,
  });

  // Vendor catalog for inline line editor
  const { data: vendorCatalog = [] } = useQuery<any[]>({
    queryKey: ["/api/vendor-products", newPO.vendorId],
    queryFn: async () => {
      if (!newPO.vendorId) return [];
      const res = await fetch(`/api/vendor-products?vendorId=${newPO.vendorId}&isActive=1`);
      const data = await res.json();
      return Array.isArray(data) ? data : (data.vendorProducts ?? []);
    },
    enabled: showCreateDialog && !!newPO.vendorId,
  });

  // Check if solo mode (no approval tiers) for "Create & Send" button
  const { data: approvalTiersData } = useQuery<{ tiers: any[] }>({
    queryKey: ["/api/purchasing/approval-tiers"],
  });
  const isSoloMode = (approvalTiersData?.tiers?.length ?? 0) === 0;

  const purchaseOrders = statusFilter === "active"
    ? (poData?.purchaseOrders ?? []).filter(po => !["cancelled", "void"].includes(po.status))
    : (poData?.purchaseOrders ?? []);

  // Stats
  const stats = {
    total: poData?.total ?? 0,
    openValue: purchaseOrders
      .filter(po => !["closed", "cancelled"].includes(po.status))
      .reduce((sum, po) => sum + (Number(po.totalCents) || 0), 0),
    pendingApproval: purchaseOrders.filter(po => po.status === "pending_approval").length,
    awaitingReceipt: purchaseOrders.filter(po => ["sent", "acknowledged"].includes(po.status)).length,
  };

  // Create mutation with inline lines + optional send-to-vendor
  const createMutation = useMutation({
    mutationFn: async ({ poData, lines, sendToVendor }: { poData: typeof newPO; lines: InlineLineItem[]; sendToVendor: boolean }) => {
      // Step 1: Create the PO
      const res = await fetch("/api/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: poData.vendorId,
          poType: poData.poType,
          priority: poData.priority,
          incoterms: poData.incoterms || undefined,
          expectedDeliveryDate: poData.expectedDeliveryDate || undefined,
          vendorNotes: poData.vendorNotes || undefined,
          internalNotes: poData.internalNotes || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create PO");
      }
      const po = await res.json();

      // Step 2: Add lines in bulk if any
      if (lines.length > 0) {
        const bulkRes = await fetch(`/api/purchase-orders/${po.id}/lines/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lines: lines.map(l => ({
              productId: l.productId,
              productVariantId: l.productVariantId,
              vendorProductId: l.vendorProductId,
              orderQty: l.orderQty,
              unitCostCents: l.unitCostCents,
              unitsPerUom: l.unitsPerUom,
              vendorSku: l.vendorSku || undefined,
            })),
          }),
        });
        if (!bulkRes.ok) {
          const err = await bulkRes.json();
          throw new Error(err.error || "Failed to add lines");
        }

        // Save to vendor catalog for each line that opted in
        for (const line of lines) {
          if (line.saveToVendorCatalog && poData.vendorId) {
            try {
              await fetch("/api/vendor-products/upsert", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  vendorId: poData.vendorId,
                  productId: line.productId,
                  productVariantId: line.productVariantId,
                  vendorSku: line.vendorSku || "",
                  unitCostCents: line.unitCostCents,
                  packSize: line.unitsPerUom,
                  isPreferred: false,
                }),
              });
            } catch { /* non-critical */ }
          }
        }
      }

      // Step 3: Send to vendor if requested
      if (sendToVendor && lines.length > 0) {
        const sendRes = await fetch(`/api/purchase-orders/${po.id}/send-to-vendor`, { method: "POST" });
        if (!sendRes.ok) {
          // PO was created but send failed — navigate anyway
          const err = await sendRes.json();
          return { ...po, sendError: err.error };
        }
        const sentPo = await sendRes.json();
        return { ...sentPo, wasSent: true };
      }

      return po;
    },
    onSuccess: (po) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      setShowCreateDialog(false);
      setNewPO({ vendorId: 0, poType: "standard", priority: "normal", incoterms: "", expectedDeliveryDate: "", vendorNotes: "", internalNotes: "" });
      setInlineLines([]);
      if (po.sendError) {
        toast({ title: "PO created (send failed)", description: po.sendError, variant: "destructive" });
      } else if (po.wasSent) {
        toast({ title: "PO created & sent", description: `${po.poNumber} sent to vendor` });
      } else {
        toast({ title: "Purchase order created", description: `${po.poNumber} created as draft` });
      }
      // This dialog only runs when the new editor flag is OFF; send users
      // to the detail page as today.
      navigate(`/purchase-orders/${po.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createVendorMutation = useMutation({
    mutationFn: async (data: typeof newVendor) => {
      const res = await fetch("/api/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create vendor");
      }
      return res.json();
    },
    onSuccess: (vendor) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors"] });
      setNewPO(prev => ({ ...prev, vendorId: vendor.id }));
      setShowNewVendorDialog(false);
      setNewVendor({ code: "", name: "", contactName: "", email: "", phone: "", address: "", notes: "" });
      toast({ title: "Supplier created", description: `${vendor.code} — ${vendor.name} added and selected.` });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/purchase-orders/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete PO");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      toast({ title: "Purchase order deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const selectedVendor = vendors.find(v => v.id === newPO.vendorId);
  const filteredVendors = vendors.filter(v =>
    !vendorSearch || v.name.toLowerCase().includes(vendorSearch.toLowerCase()) || v.code.toLowerCase().includes(vendorSearch.toLowerCase())
  ).slice(0, 50);

  // Inline line item helpers
  const inlineLinesTotal = inlineLines.reduce((sum, l) => sum + dollarsToCents(l.totalCostDollars || "0"), 0);
  const filteredInlineProducts = products
    .filter((p: any) =>
      !inlineProductSearch ||
      p.name?.toLowerCase().includes(inlineProductSearch.toLowerCase()) ||
      p.sku?.toLowerCase().includes(inlineProductSearch.toLowerCase())
    )
    .slice(0, 50);

  const filteredInlineCatalog = vendorCatalog.filter((entry: any) => {
    if (!inlineCatalogSearch) return true;
    const s = inlineCatalogSearch.toLowerCase();
    const product = products.find((p: any) => p.id === entry.productId);
    const variant = product?.variants?.find((v: any) => v.id === entry.productVariantId);
    return (
      product?.name?.toLowerCase().includes(s) ||
      entry.vendorSku?.toLowerCase().includes(s) ||
      variant?.sku?.toLowerCase().includes(s) ||
      product?.sku?.toLowerCase().includes(s)
    );
  });

  function resetInlineLineForm() {
    setInlineSelectedProduct(null);
    setInlineSelectedVariant(null);
    setInlineQty("1");
    setInlineTotalCost("");
    setInlineVendorSku("");
    setInlineProductSearch("");
    setInlineCatalogSearch("");
    setInlineSelectedCatalogEntry(null);
    setAddingLine(false);
  }

  function addInlineLine() {
    if (!inlineSelectedVariant || !inlineTotalCost) return;
    const qty = parseInt(inlineQty) || 1;
    const totalCents = dollarsToCents(inlineTotalCost);
    const unitCostCents = qty > 0 ? totalCents / qty : 0;
    const newItem: InlineLineItem = {
      id: `temp-${Date.now()}-${Math.random()}`,
      productId: inlineSelectedProduct?.id || 0,
      productVariantId: inlineSelectedVariant.id,
      productName: inlineSelectedProduct?.name || "",
      sku: inlineSelectedVariant.sku,
      orderQty: qty,
      totalCostDollars: inlineTotalCost,
      unitCostCents,
      unitsPerUom: inlineSelectedVariant.unitsPerVariant || 1,
      vendorSku: inlineVendorSku,
      vendorProductId: inlineSelectedCatalogEntry?.id,
      saveToVendorCatalog: !inlineSelectedCatalogEntry, // save new entries to catalog
    };
    setInlineLines(prev => [...prev, newItem]);
    resetInlineLineForm();
  }

  function removeInlineLine(id: string) {
    setInlineLines(prev => prev.filter(l => l.id !== id));
  }

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 md:h-6 md:w-6" />
            Purchase Orders
          </h1>
          <p className="text-sm text-muted-foreground">
            Create and manage purchase orders
          </p>
        </div>
        <Button onClick={handleNewPoClick} className="min-h-[44px] w-full sm:w-auto">
          <Plus className="h-4 w-4 mr-2" />
          New Purchase Order
        </Button>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.total}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Total POs</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-green-600">{formatCents(stats.openValue)}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Open Value</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-amber-600">{stats.pendingApproval}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Pending Approval</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-blue-600">{stats.awaitingReceipt}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Awaiting Receipt</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search PO#, reference..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9 h-10"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-44 h-10">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="pending_approval">Pending Approval</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="acknowledged">Acknowledged</SelectItem>
            <SelectItem value="partially_received">Partial Receipt</SelectItem>
            <SelectItem value="received">Received</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden space-y-3">
        {purchaseOrders.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-center text-muted-foreground">
              No purchase orders found.
            </CardContent>
          </Card>
        ) : (
          purchaseOrders.map(po => (
            <Card
              key={po.id}
              className="cursor-pointer active:bg-accent/50"
              onClick={() => navigate(poHref(po))}
            >
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-medium text-sm">{po.poNumber}</span>
                      <Badge
                        variant={STATUS_BADGES[po.status]?.variant || "secondary"}
                        className={`text-xs ${STATUS_BADGES[po.status]?.color || ""}`}
                      >
                        {STATUS_BADGES[po.status]?.label || po.status}
                      </Badge>
                      {po.priority === "rush" && <Badge variant="destructive" className="text-xs">Rush</Badge>}
                      {po.priority === "high" && <Badge variant="outline" className="text-xs text-orange-600 border-orange-300">High</Badge>}
                    </div>
                    <div className="text-sm mt-1">{po.vendor?.name || `Vendor #${po.vendorId}`}</div>
                    <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                      <span>{po.lineCount || 0} lines</span>
                      <span>{formatCents(po.totalCents)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {format(new Date(po.createdAt), "MMM d, yyyy")}
                      {po.expectedDeliveryDate && ` • ETA ${format(new Date(po.expectedDeliveryDate), "MMM d")}`}
                    </div>
                  </div>
                  {po.status === "draft" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-[44px] min-w-[44px] p-0 shrink-0"
                      onClick={e => {
                        e.stopPropagation();
                        if (confirm(`Delete ${po.poNumber}? This cannot be undone.`)) {
                          deleteMutation.mutate(po.id);
                        }
                      }}
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

      {/* Desktop Table */}
      <Card className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>PO #</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {purchaseOrders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No purchase orders found. Click "New Purchase Order" to create one.
                </TableCell>
              </TableRow>
            ) : (
              purchaseOrders.map(po => (
                <TableRow
                  key={po.id}
                  className="cursor-pointer"
                  onClick={() => navigate(poHref(po))}
                >
                  <TableCell className="font-mono font-medium">
                    <div className="flex items-center gap-2">
                      {po.poNumber}
                      {po.priority === "rush" && <Badge variant="destructive" className="text-xs">Rush</Badge>}
                      {po.priority === "high" && <Badge variant="outline" className="text-xs text-orange-600 border-orange-300">High</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>{po.vendor?.name || `Vendor #${po.vendorId}`}</TableCell>
                  <TableCell className="capitalize">{po.poType}</TableCell>
                  <TableCell>
                    <Badge
                      variant={STATUS_BADGES[po.status]?.variant || "secondary"}
                      className={STATUS_BADGES[po.status]?.color || ""}
                    >
                      {STATUS_BADGES[po.status]?.label || po.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{po.lineCount || 0}</TableCell>
                  <TableCell className="text-right font-mono">{formatCents(po.totalCents)}</TableCell>
                  <TableCell>
                    {po.expectedDeliveryDate ? format(new Date(po.expectedDeliveryDate), "MMM d, yyyy") : "-"}
                  </TableCell>
                  <TableCell className="text-sm">{format(new Date(po.createdAt), "MMM d, yyyy")}</TableCell>
                  <TableCell onClick={e => e.stopPropagation()}>
                    {po.status === "draft" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => {
                          if (confirm(`Delete ${po.poNumber}? This cannot be undone.`)) {
                            deleteMutation.mutate(po.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Create PO Dialog — Full page style with inline line items */}
      <Dialog open={showCreateDialog} onOpenChange={(open) => {
        setShowCreateDialog(open);
        if (!open) {
          setNewPO({ vendorId: 0, poType: "standard", priority: "normal", incoterms: "", expectedDeliveryDate: "", vendorNotes: "", internalNotes: "" });
          setInlineLines([]);
          resetInlineLineForm();
        }
      }}>
        <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-2xl max-h-[90vh] flex flex-col overflow-hidden p-0">
          <DialogHeader className="px-4 pt-4 pb-2 sm:px-6">
            <DialogTitle>New Purchase Order</DialogTitle>
            <DialogDescription>Select a vendor, add line items, then create.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto flex-1 px-4 pb-4 sm:px-6">
            {/* Vendor typeahead */}
            <div className="space-y-2">
              <Label>Vendor *</Label>
              <Popover open={vendorOpen} onOpenChange={setVendorOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    className="w-full justify-between h-11 font-normal min-w-0"
                  >
                    <span className="truncate">{selectedVendor ? `${selectedVendor.code} — ${selectedVendor.name}` : "Select vendor..."}</span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Search vendors..."
                      value={vendorSearch}
                      onValueChange={setVendorSearch}
                    />
                    <CommandList>
                      <CommandEmpty>No vendors found.</CommandEmpty>
                      <CommandGroup>
                        {filteredVendors.map(v => (
                          <CommandItem
                            key={v.id}
                            value={String(v.id)}
                            onSelect={() => {
                              setNewPO(prev => ({ ...prev, vendorId: v.id, incoterms: v.defaultIncoterms || prev.incoterms }));
                              setVendorOpen(false);
                              setVendorSearch("");
                              setInlineLines([]); // reset lines when vendor changes
                              resetInlineLineForm();
                            }}
                          >
                            <Check className={`mr-2 h-4 w-4 ${newPO.vendorId === v.id ? "opacity-100" : "opacity-0"}`} />
                            <span className="font-mono text-xs mr-2">{v.code}</span>
                            {v.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                      <CommandGroup>
                        <CommandItem
                          onSelect={() => {
                            setVendorOpen(false);
                            setShowNewVendorDialog(true);
                          }}
                          className="text-primary"
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          Add New Vendor
                        </CommandItem>
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            {/* Incoterms + optional fields — collapsible */}
            <details className="group">
              <summary className="text-sm font-medium cursor-pointer list-none flex items-center gap-2">
                <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                Options{newPO.incoterms ? ` (${newPO.incoterms})` : ""}
              </summary>
              <div className="space-y-3 mt-3 pl-4 border-l-2">
                <div className="grid grid-cols-2 gap-3">
                  {(!selectedVendor || selectedVendor.country !== 'US') && (
                    <div className="space-y-1">
                      <Label className="text-xs">Incoterms</Label>
                      <Select value={newPO.incoterms} onValueChange={v => setNewPO(prev => ({ ...prev, incoterms: v }))}>
                        <SelectTrigger className="h-10">
                          <SelectValue placeholder="Select..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="EXW">EXW</SelectItem>
                          <SelectItem value="FCA">FCA</SelectItem>
                          <SelectItem value="FOB">FOB</SelectItem>
                          <SelectItem value="CFR">CFR</SelectItem>
                          <SelectItem value="CIF">CIF</SelectItem>
                          <SelectItem value="CPT">CPT</SelectItem>
                          <SelectItem value="CIP">CIP</SelectItem>
                          <SelectItem value="DAP">DAP</SelectItem>
                          <SelectItem value="DPU">DPU</SelectItem>
                          <SelectItem value="DDP">DDP</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs">Expected Delivery</Label>
                    <Input
                      type="date"
                      value={newPO.expectedDeliveryDate}
                      onChange={e => setNewPO(prev => ({ ...prev, expectedDeliveryDate: e.target.value }))}
                      className="h-10"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Type</Label>
                    <Select value={newPO.poType} onValueChange={v => setNewPO(prev => ({ ...prev, poType: v }))}>
                      <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="blanket">Blanket</SelectItem>
                        <SelectItem value="dropship">Dropship</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Priority</Label>
                    <Select value={newPO.priority} onValueChange={v => setNewPO(prev => ({ ...prev, priority: v }))}>
                      <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="normal">Normal</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="rush">Rush</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </details>

            {/* ── Inline Line Items ── */}
            {newPO.vendorId > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Line Items ({inlineLines.length})</Label>
                  {inlineLinesTotal > 0 && (
                    <span className="text-sm font-mono font-medium">{formatCentsShort(inlineLinesTotal)}</span>
                  )}
                </div>

                {/* Existing lines */}
                {inlineLines.length > 0 && (
                  <div className="rounded-md border divide-y">
                    {inlineLines.map(line => (
                      <div key={line.id} className="flex items-center gap-2 p-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{line.productName}</div>
                          <div className="text-xs text-muted-foreground flex gap-2">
                            <span className="font-mono">{line.sku}</span>
                            <span>Qty: {line.orderQty.toLocaleString()}</span>
                            <span className="font-mono">{formatCentsShort(dollarsToCents(line.totalCostDollars))}</span>
                          </div>
                        </div>
                        <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0 shrink-0" onClick={() => removeInlineLine(line.id)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add line form */}
                {!addingLine ? (
                  <Button variant="outline" className="w-full min-h-[44px]" onClick={() => { setAddingLine(true); setInlineCatalogMode("catalog"); }}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Line Item
                  </Button>
                ) : (
                  <div className="rounded-md border p-3 space-y-3 bg-muted/20">
                    {/* Mode toggle */}
                    <div className="flex rounded-lg border p-0.5 gap-0.5 bg-muted/30">
                      <Button
                        variant={inlineCatalogMode === "catalog" ? "default" : "ghost"}
                        size="sm" className="flex-1 h-8 text-xs"
                        onClick={() => { setInlineCatalogMode("catalog"); setInlineSelectedProduct(null); setInlineSelectedVariant(null); setInlineSelectedCatalogEntry(null); }}
                      >
                        Catalog{vendorCatalog.length > 0 ? ` (${vendorCatalog.length})` : ""}
                      </Button>
                      <Button
                        variant={inlineCatalogMode === "search" ? "default" : "ghost"}
                        size="sm" className="flex-1 h-8 text-xs"
                        onClick={() => { setInlineCatalogMode("search"); setInlineSelectedCatalogEntry(null); setInlineSelectedProduct(null); setInlineSelectedVariant(null); }}
                      >
                        All Products
                      </Button>
                    </div>

                    {/* Catalog mode */}
                    {inlineCatalogMode === "catalog" && !inlineSelectedVariant && (
                      <>
                        <Input
                          placeholder="Filter catalog..."
                          value={inlineCatalogSearch}
                          onChange={e => setInlineCatalogSearch(e.target.value)}
                          className="h-9"
                        />
                        {vendorCatalog.length === 0 ? (
                          <div className="text-center text-xs text-muted-foreground py-2">
                            No catalog entries.{" "}
                            <button className="text-primary underline" onClick={() => setInlineCatalogMode("search")}>Search all products</button>
                          </div>
                        ) : (
                          <div className="rounded-md border divide-y max-h-36 overflow-y-auto">
                            {filteredInlineCatalog.slice(0, 30).map((entry: any) => {
                              const product = products.find((p: any) => p.id === entry.productId);
                              const variant = product?.variants?.find((v: any) => v.id === entry.productVariantId);
                              return (
                                <button
                                  key={entry.id}
                                  type="button"
                                  className="w-full text-left p-2 hover:bg-muted/50 transition-colors"
                                  onClick={() => {
                                    setInlineSelectedCatalogEntry(entry);
                                    setInlineSelectedProduct(product || null);
                                    if (variant) {
                                      setInlineSelectedVariant(variant);
                                      setInlineVendorSku(entry.vendorSku || "");
                                    }
                                  }}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="text-sm font-medium truncate">{product?.name || entry.vendorProductName || `Product #${entry.productId}`}</div>
                                      <div className="text-xs text-muted-foreground flex gap-1.5 flex-wrap">
                                        {variant && <span className="font-mono">{variant.sku}</span>}
                                        {entry.vendorSku && <span>· {entry.vendorSku}</span>}
                                      </div>
                                    </div>
                                    <div className="text-sm font-mono shrink-0">{formatCentsShort(entry.unitCostCents)}</div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </>
                    )}

                    {/* Search mode - product picker */}
                    {inlineCatalogMode === "search" && !inlineSelectedVariant && (
                      <>
                        <Popover open={inlineProductOpen} onOpenChange={setInlineProductOpen}>
                          <PopoverTrigger asChild>
                            <Button variant="outline" className="w-full justify-between h-10 font-normal overflow-hidden">
                              <span className="truncate">{inlineSelectedProduct ? inlineSelectedProduct.name : "Search product..."}</span>
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                            <Command shouldFilter={false}>
                              <CommandInput placeholder="Search name or SKU..." value={inlineProductSearch} onValueChange={setInlineProductSearch} />
                              <CommandList>
                                <CommandEmpty>No products found.</CommandEmpty>
                                <CommandGroup>
                                  {filteredInlineProducts.map((p: any) => (
                                    <CommandItem
                                      key={p.id}
                                      value={String(p.id)}
                                      onSelect={() => {
                                        setInlineSelectedProduct(p);
                                        setInlineProductOpen(false);
                                        setInlineProductSearch("");
                                        // Auto-select if only one variant
                                        if (p.variants?.length === 1) {
                                          setInlineSelectedVariant(p.variants[0]);
                                        }
                                      }}
                                    >
                                      <span className="font-mono text-xs mr-2 text-muted-foreground">{p.sku}</span>
                                      <span className="truncate">{p.name}</span>
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>

                        {/* Variant picker */}
                        {inlineSelectedProduct && inlineSelectedProduct.variants?.length > 1 && (
                          <Popover open={inlineVariantOpen} onOpenChange={setInlineVariantOpen}>
                            <PopoverTrigger asChild>
                              <Button variant="outline" className="w-full justify-between h-10 font-normal overflow-hidden">
                                <span className="truncate">{inlineSelectedVariant ? `${inlineSelectedVariant.sku} — ${inlineSelectedVariant.name}` : "Select variant..."}</span>
                                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                              <Command>
                                <CommandList>
                                  <CommandEmpty>No variants.</CommandEmpty>
                                  <CommandGroup>
                                    {(inlineSelectedProduct.variants || []).map((v: any) => (
                                      <CommandItem key={v.id} value={String(v.id)} onSelect={() => { setInlineSelectedVariant(v); setInlineVariantOpen(false); }}>
                                        <span className="font-mono text-xs mr-2">{v.sku}</span>
                                        <span className="truncate">{v.name}</span>
                                        {(v.unitsPerVariant || 1) > 1 && <span className="ml-auto text-xs text-muted-foreground">{v.unitsPerVariant} pcs</span>}
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                        )}
                      </>
                    )}

                    {/* Qty + Cost fields (shown when variant selected) */}
                    {inlineSelectedVariant && (
                      <>
                        <div className="flex items-center gap-2 p-2 rounded bg-muted text-sm">
                          <span className="font-mono">{inlineSelectedVariant.sku}</span>
                          <span className="text-muted-foreground">—</span>
                          <span className="truncate">{inlineSelectedProduct?.name}</span>
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 ml-auto shrink-0" onClick={() => { setInlineSelectedVariant(null); setInlineSelectedProduct(inlineCatalogMode === "catalog" ? null : inlineSelectedProduct); setInlineSelectedCatalogEntry(null); }}>
                            <AlertCircle className="h-3 w-3" />
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label className="text-xs">Qty (pieces)</Label>
                            <Input type="number" min="1" value={inlineQty} onChange={e => setInlineQty(e.target.value)} className="h-10" />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Total Cost ($)</Label>
                            <Input type="number" min="0" step="0.01" placeholder="0.00" value={inlineTotalCost} onChange={e => setInlineTotalCost(e.target.value)} className="h-10" />
                          </div>
                        </div>
                        {inlineTotalCost && parseInt(inlineQty) > 0 && (
                          <div className="text-xs text-muted-foreground">
                            Unit cost: {formatCentsShort(dollarsToCents(inlineTotalCost) / parseInt(inlineQty))}/pc
                          </div>
                        )}
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" className="min-h-[44px] flex-1" onClick={resetInlineLineForm}>Cancel</Button>
                          <Button size="sm" className="min-h-[44px] flex-1" onClick={addInlineLine} disabled={!inlineTotalCost || parseInt(inlineQty) < 1}>
                            <Plus className="h-4 w-4 mr-1" /> Add
                          </Button>
                        </div>
                      </>
                    )}

                    {/* Cancel adding without variant selected */}
                    {!inlineSelectedVariant && (
                      <Button variant="ghost" size="sm" className="w-full min-h-[44px] text-muted-foreground" onClick={resetInlineLineForm}>Cancel</Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2 justify-end pt-2 border-t">
              <Button variant="outline" className="min-h-[44px]" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
              {isSoloMode && inlineLines.length > 0 && (
                <Button
                  variant="outline"
                  className="min-h-[44px]"
                  onClick={() => createMutation.mutate({ poData: newPO, lines: inlineLines, sendToVendor: false })}
                  disabled={!newPO.vendorId || createMutation.isPending}
                >
                  {createMutation.isPending ? "Creating..." : "Save Draft"}
                </Button>
              )}
              <Button
                className="min-h-[44px]"
                onClick={() => createMutation.mutate({ poData: newPO, lines: inlineLines, sendToVendor: isSoloMode && inlineLines.length > 0 })}
                disabled={!newPO.vendorId || createMutation.isPending}
              >
                {createMutation.isPending ? "Creating..." : (
                  isSoloMode && inlineLines.length > 0 ? "Create & Send" : "Create Draft"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Quick Add Vendor Dialog */}
      <Dialog open={showNewVendorDialog} onOpenChange={setShowNewVendorDialog}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add New Supplier</DialogTitle>
            <DialogDescription>Create a supplier to use in this purchase order.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Code *</Label>
                <Input
                  value={newVendor.code}
                  onChange={e => setNewVendor(prev => ({ ...prev, code: e.target.value.toUpperCase() }))}
                  placeholder="e.g. ULTRA-PRO"
                  className="h-10 font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input
                  value={newVendor.name}
                  onChange={e => setNewVendor(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Supplier name"
                  className="h-10"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label>Contact Name</Label>
                <Input
                  value={newVendor.contactName}
                  onChange={e => setNewVendor(prev => ({ ...prev, contactName: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={newVendor.email}
                  onChange={e => setNewVendor(prev => ({ ...prev, email: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  value={newVendor.phone}
                  onChange={e => setNewVendor(prev => ({ ...prev, phone: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Address</Label>
              <Input
                value={newVendor.address}
                onChange={e => setNewVendor(prev => ({ ...prev, address: e.target.value }))}
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={newVendor.notes}
                onChange={e => setNewVendor(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Internal notes..."
                rows={2}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowNewVendorDialog(false)}>Cancel</Button>
              <Button
                onClick={() => createVendorMutation.mutate(newVendor)}
                disabled={!newVendor.code || !newVendor.name || createVendorMutation.isPending}
              >
                {createVendorMutation.isPending ? "Creating..." : "Create Supplier"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
