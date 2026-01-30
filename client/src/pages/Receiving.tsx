import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { 
  Package, 
  Plus, 
  Truck, 
  Upload, 
  Download,
  Check, 
  X, 
  FileText, 
  Edit, 
  Trash2,
  Play,
  CheckCircle,
  Clock,
  AlertCircle,
  MapPin,
  Building2
} from "lucide-react";

interface Vendor {
  id: number;
  code: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  active: number;
}

interface ReceivingLine {
  id: number;
  receivingOrderId: number;
  sku: string | null;
  productName: string | null;
  expectedQty: number;
  receivedQty: number;
  damagedQty: number;
  inventoryItemId: number | null;
  uomVariantId: number | null;
  catalogProductId: number | null;
  putawayLocationId: number | null;
  putawayComplete: number;
  status: string;
  unitCost: number | null;
  notes: string | null;
}

interface ReceivingOrder {
  id: number;
  receiptNumber: string;
  poNumber: string | null;
  asnNumber: string | null;
  sourceType: string;
  vendorId: number | null;
  warehouseId: number | null;
  status: string;
  expectedDate: string | null;
  receivedDate: string | null;
  closedDate: string | null;
  expectedLineCount: number | null;
  receivedLineCount: number | null;
  expectedTotalUnits: number | null;
  receivedTotalUnits: number | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  vendor?: Vendor | null;
  lines?: ReceivingLine[];
}

interface WarehouseLocation {
  id: number;
  code: string;
  zone: string | null;
  name: string | null;
}

const STATUS_BADGES: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  open: { variant: "default", label: "Open" },
  receiving: { variant: "default", label: "Receiving" },
  verified: { variant: "outline", label: "Verified" },
  closed: { variant: "secondary", label: "Closed" },
  cancelled: { variant: "destructive", label: "Cancelled" },
};

export default function Receiving() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [activeTab, setActiveTab] = useState("receipts");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showNewReceiptDialog, setShowNewReceiptDialog] = useState(false);
  const [showNewVendorDialog, setShowNewVendorDialog] = useState(false);
  const [selectedReceipt, setSelectedReceipt] = useState<ReceivingOrder | null>(null);
  const [showReceiptDetail, setShowReceiptDetail] = useState(false);
  const [showCSVImport, setShowCSVImport] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [showAddLineDialog, setShowAddLineDialog] = useState(false);
  const [newLine, setNewLine] = useState({
    sku: "",
    productName: "",
    expectedQty: "1",
    putawayLocationId: "",
    catalogProductId: null as number | null,
    inventoryItemId: null as number | null,
  });
  const [skuSearch, setSkuSearch] = useState("");
  const [skuResults, setSkuResults] = useState<{sku: string; name: string; catalogProductId: number; inventoryItemId: number | null}[]>([]);
  const [showSkuDropdown, setShowSkuDropdown] = useState(false);
  const [skuSearchTimeout, setSkuSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [locationSearch, setLocationSearch] = useState("");
  const [locationResults, setLocationResults] = useState<WarehouseLocation[]>([]);
  const [showLocationDropdown, setShowLocationDropdown] = useState(false);
  
  // Download CSV template
  const downloadTemplate = () => {
    const template = `sku,qty,location,damaged_qty,unit_cost,barcode,notes
ABC-123,100,A-01-01-01-01,0,12.50,123456789012,
XYZ-789,50,B-02-03-02-01,2,8.99,,2 units damaged in shipping
DEF-456,25,,,5.00,,Location TBD`;
    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'receiving_import_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
  
  // New receipt form
  const [newReceipt, setNewReceipt] = useState({
    sourceType: "blind",
    vendorId: "",
    warehouseId: "",
    poNumber: "",
    notes: "",
  });
  
  // New vendor form
  const [newVendor, setNewVendor] = useState({
    code: "",
    name: "",
    contactName: "",
    email: "",
    phone: "",
    address: "",
    notes: "",
  });

  // Queries
  const { data: receipts = [] } = useQuery<ReceivingOrder[]>({
    queryKey: ["/api/receiving"],
  });

  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ["/api/vendors"],
  });

  const { data: warehouses = [] } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: ["/api/warehouses"],
  });

  const { data: locations = [] } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/warehouse/locations"],
  });

  const { data: variants = [] } = useQuery<{ id: number; sku: string; name: string; inventoryItemId: number }[]>({
    queryKey: ["/api/inventory/variants"],
  });

  // Mutations
  const createReceiptMutation = useMutation({
    mutationFn: async (data: typeof newReceipt) => {
      const res = await fetch("/api/receiving", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType: data.sourceType,
          vendorId: data.vendorId ? parseInt(data.vendorId) : null,
          warehouseId: data.warehouseId ? parseInt(data.warehouseId) : null,
          poNumber: data.poNumber || null,
          notes: data.notes || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to create receipt");
      return res.json();
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      setShowNewReceiptDialog(false);
      setNewReceipt({ sourceType: "blind", vendorId: "", warehouseId: "", poNumber: "", notes: "" });
      toast({ title: "Receipt created", description: `Receipt ${receipt.receiptNumber} created` });
      setSelectedReceipt(receipt);
      setShowReceiptDetail(true);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create receipt", variant: "destructive" });
    },
  });

  const createVendorMutation = useMutation({
    mutationFn: async (data: typeof newVendor) => {
      const res = await fetch("/api/vendors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create vendor");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors"] });
      setShowNewVendorDialog(false);
      setNewVendor({ code: "", name: "", contactName: "", email: "", phone: "", address: "", notes: "" });
      toast({ title: "Vendor created" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create vendor", variant: "destructive" });
    },
  });

  const openReceiptMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/receiving/${id}/open`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to open receipt");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      setSelectedReceipt(data);
      toast({ title: "Receipt opened for receiving" });
    },
  });

  const closeReceiptMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/receiving/${id}/close`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to close receipt");
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      toast({ 
        title: "Receipt closed", 
        description: `${result.unitsReceived} units received across ${result.linesProcessed} lines` 
      });
      setShowReceiptDetail(false);
    },
  });

  const bulkImportMutation = useMutation({
    mutationFn: async ({ orderId, lines }: { orderId: number; lines: any[] }) => {
      const res = await fetch(`/api/receiving/${orderId}/lines/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
      if (!res.ok) throw new Error("Failed to import lines");
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      setShowCSVImport(false);
      setCsvText("");
      
      const totalProcessed = (result.created || 0) + (result.updated || 0);
      const createdMsg = result.created ? `${result.created} created` : "";
      const updatedMsg = result.updated ? `${result.updated} updated` : "";
      const linesMsg = [createdMsg, updatedMsg].filter(Boolean).join(", ");
      
      if (result.errors?.length || result.warnings?.length) {
        const allWarnings = [...(result.errors || []), ...(result.warnings || [])];
        console.log("Import warnings:", allWarnings);
        const warningList = allWarnings.slice(0, 5).join("\n");
        const moreCount = allWarnings.length > 5 ? `\n...and ${allWarnings.length - 5} more` : "";
        toast({ 
          title: `Import complete with ${allWarnings.length} warnings`, 
          description: `${totalProcessed} lines (${linesMsg}).\n\nWarnings:\n${warningList}${moreCount}`,
          duration: 10000,
        });
      } else {
        toast({ 
          title: "Import complete", 
          description: `${totalProcessed} lines processed (${linesMsg})` 
        });
      }
    },
  });

  const addLineMutation = useMutation({
    mutationFn: async ({ orderId, line }: { orderId: number; line: any }) => {
      const res = await fetch(`/api/receiving/${orderId}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(line),
      });
      if (!res.ok) throw new Error("Failed to add line");
      return res.json();
    },
    onSuccess: (updatedOrder) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (updatedOrder && selectedReceipt) {
        setSelectedReceipt(updatedOrder);
      }
      setShowAddLineDialog(false);
      setNewLine({
        sku: "",
        productName: "",
        expectedQty: "1",
        putawayLocationId: "",
        catalogProductId: null,
        inventoryItemId: null,
      });
      setSkuSearch("");
      setSkuResults([]);
      setLocationSearch("");
      setLocationResults([]);
      toast({ title: "Line added successfully" });
    },
    onError: (error) => {
      toast({ 
        title: "Failed to add line", 
        description: error.message,
        variant: "destructive" 
      });
    },
  });

  const updateLineMutation = useMutation({
    mutationFn: async ({ lineId, updates }: { lineId: number; updates: any }) => {
      const res = await fetch(`/api/receiving/lines/${lineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error("Failed to update line");
      return res.json();
    },
    onSuccess: (updatedLine) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (selectedReceipt && selectedReceipt.lines) {
        setSelectedReceipt({
          ...selectedReceipt,
          lines: selectedReceipt.lines.map(line => 
            line.id === updatedLine.id ? updatedLine : line
          )
        });
      }
    },
  });

  const completeAllMutation = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await fetch(`/api/receiving/${orderId}/complete-all`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Failed to complete all lines");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (data.order) {
        setSelectedReceipt(data.order);
      }
      toast({ title: "All lines marked complete" });
    },
  });

  // Location search for add line dialog (local filter, no API call needed)
  const handleLocationSearch = (query: string) => {
    setLocationSearch(query);
    if (query.length < 1) {
      setLocationResults([]);
      setShowLocationDropdown(false);
      return;
    }
    const filtered = locations.filter(loc => 
      loc.code.toLowerCase().includes(query.toLowerCase()) ||
      (loc.name && loc.name.toLowerCase().includes(query.toLowerCase()))
    ).slice(0, 20);
    setLocationResults(filtered);
    setShowLocationDropdown(filtered.length > 0);
  };

  // Debounced SKU search for add line dialog
  const handleSkuSearch = (query: string) => {
    setSkuSearch(query);
    if (skuSearchTimeout) {
      clearTimeout(skuSearchTimeout);
    }
    if (query.length < 2) {
      setSkuResults([]);
      setShowSkuDropdown(false);
      return;
    }
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/inventory/skus/search?q=${encodeURIComponent(query)}&limit=10`);
        if (res.ok) {
          const results = await res.json();
          setSkuResults(results);
          setShowSkuDropdown(results.length > 0);
        }
      } catch (error) {
        console.error("SKU search error:", error);
      }
    }, 300);
    setSkuSearchTimeout(timeout);
  };

  // Filter receipts
  const filteredReceipts = receipts.filter(r => 
    statusFilter === "all" || r.status === statusFilter
  );

  // Stats
  const stats = {
    total: receipts.length,
    open: receipts.filter(r => r.status === "open" || r.status === "receiving").length,
    closed: receipts.filter(r => r.status === "closed").length,
    draft: receipts.filter(r => r.status === "draft").length,
  };

  // Parse CSV for import
  const parseCSV = (text: string) => {
    const lines = text.trim().split("\n");
    const header = lines[0].toLowerCase().split(",").map(h => h.trim());
    
    // Required columns
    const skuIdx = header.findIndex(h => h === "sku" || h === "product_sku");
    const qtyIdx = header.findIndex(h => h === "qty" || h === "quantity" || h === "count");
    
    // Optional columns
    const locIdx = header.findIndex(h => h === "location" || h === "bin" || h === "loc");
    const damagedIdx = header.findIndex(h => h === "damaged_qty" || h === "damaged");
    const costIdx = header.findIndex(h => h === "unit_cost" || h === "cost" || h === "price");
    const barcodeIdx = header.findIndex(h => h === "barcode" || h === "upc" || h === "ean");
    const notesIdx = header.findIndex(h => h === "notes" || h === "note" || h === "comments");
    
    if (skuIdx === -1 || qtyIdx === -1) {
      return { error: "CSV must have 'sku' and 'qty' columns" };
    }
    
    const parsedLines = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      
      // Handle CSV with quoted fields (simple parser)
      const parts: string[] = [];
      let current = "";
      let inQuotes = false;
      for (const char of line) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          parts.push(current.trim());
          current = "";
        } else {
          current += char;
        }
      }
      parts.push(current.trim());
      
      if (parts.length > Math.max(skuIdx, qtyIdx)) {
        parsedLines.push({
          sku: parts[skuIdx],
          qty: parseInt(parts[qtyIdx], 10) || 0,
          location: locIdx >= 0 && parts[locIdx] ? parts[locIdx] : null,
          damaged_qty: damagedIdx >= 0 && parts[damagedIdx] ? parts[damagedIdx] : null,
          unit_cost: costIdx >= 0 && parts[costIdx] ? parts[costIdx] : null,
          barcode: barcodeIdx >= 0 && parts[barcodeIdx] ? parts[barcodeIdx] : null,
          notes: notesIdx >= 0 && parts[notesIdx] ? parts[notesIdx] : null,
        });
      }
    }
    
    return { lines: parsedLines };
  };

  const handleCSVImport = () => {
    if (!selectedReceipt) {
      toast({ title: "Error", description: "No receipt selected", variant: "destructive" });
      return;
    }
    const result = parseCSV(csvText);
    console.log("CSV parse result:", result);
    if (result.error) {
      toast({ title: "Error", description: result.error, variant: "destructive" });
      return;
    }
    if (!result.lines || result.lines.length === 0) {
      toast({ title: "Error", description: "No valid lines found in CSV", variant: "destructive" });
      return;
    }
    console.log("Importing lines:", result.lines);
    bulkImportMutation.mutate({ orderId: selectedReceipt.id, lines: result.lines });
  };

  const loadReceiptDetail = async (receipt: ReceivingOrder) => {
    const res = await fetch(`/api/receiving/${receipt.id}`);
    if (res.ok) {
      const data = await res.json();
      setSelectedReceipt(data);
      setShowReceiptDetail(true);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Truck className="h-6 w-6" />
            Receiving
          </h1>
          <p className="text-muted-foreground">
            Receive inventory and manage purchase orders
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowNewVendorDialog(true)} data-testid="btn-new-vendor">
            <Building2 className="h-4 w-4 mr-2" />
            New Vendor
          </Button>
          <Button onClick={() => setShowNewReceiptDialog(true)} data-testid="btn-new-receipt">
            <Plus className="h-4 w-4 mr-2" />
            New Receipt
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{stats.total}</div>
            <div className="text-sm text-muted-foreground">Total Receipts</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-blue-600">{stats.open}</div>
            <div className="text-sm text-muted-foreground">In Progress</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-green-600">{stats.closed}</div>
            <div className="text-sm text-muted-foreground">Completed</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold text-gray-500">{stats.draft}</div>
            <div className="text-sm text-muted-foreground">Drafts</div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="receipts">Receipts</TabsTrigger>
          <TabsTrigger value="vendors">Vendors</TabsTrigger>
        </TabsList>

        <TabsContent value="receipts" className="space-y-4">
          <div className="flex gap-2 items-center">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40" data-testid="select-status-filter">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="receiving">Receiving</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Receipt #</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>PO #</TableHead>
                  <TableHead>Lines</TableHead>
                  <TableHead>Units</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredReceipts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      No receipts found. Click "New Receipt" to create one.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredReceipts.map((receipt) => (
                    <TableRow 
                      key={receipt.id} 
                      className="cursor-pointer"
                      onClick={() => loadReceiptDetail(receipt)}
                      data-testid={`receipt-row-${receipt.id}`}
                    >
                      <TableCell className="font-mono font-medium">{receipt.receiptNumber}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{receipt.sourceType}</Badge>
                      </TableCell>
                      <TableCell>{receipt.vendor?.name || "-"}</TableCell>
                      <TableCell>{receipt.poNumber || "-"}</TableCell>
                      <TableCell>
                        {receipt.receivedLineCount || 0} / {receipt.expectedLineCount || 0}
                      </TableCell>
                      <TableCell>
                        {receipt.receivedTotalUnits || 0} / {receipt.expectedTotalUnits || 0}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_BADGES[receipt.status]?.variant || "secondary"}>
                          {STATUS_BADGES[receipt.status]?.label || receipt.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{format(new Date(receipt.createdAt), "MMM d, yyyy")}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); loadReceiptDetail(receipt); }}>
                          <FileText className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="vendors" className="space-y-4">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vendors.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                      No vendors found. Click "New Vendor" to add one.
                    </TableCell>
                  </TableRow>
                ) : (
                  vendors.map((vendor) => (
                    <TableRow key={vendor.id} data-testid={`vendor-row-${vendor.id}`}>
                      <TableCell className="font-mono font-medium">{vendor.code}</TableCell>
                      <TableCell>{vendor.name}</TableCell>
                      <TableCell>{vendor.contactName || "-"}</TableCell>
                      <TableCell>{vendor.email || "-"}</TableCell>
                      <TableCell>{vendor.phone || "-"}</TableCell>
                      <TableCell>
                        <Badge variant={vendor.active ? "default" : "secondary"}>
                          {vendor.active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      {/* New Receipt Dialog */}
      <Dialog open={showNewReceiptDialog} onOpenChange={setShowNewReceiptDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Receipt</DialogTitle>
            <DialogDescription>Create a new receiving document to receive inventory</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Receipt Type</Label>
              <Select value={newReceipt.sourceType} onValueChange={(v) => setNewReceipt({ ...newReceipt, sourceType: v })}>
                <SelectTrigger data-testid="select-receipt-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blind">Blind Receive</SelectItem>
                  <SelectItem value="po">Purchase Order</SelectItem>
                  <SelectItem value="asn">ASN (Advance Shipment)</SelectItem>
                  <SelectItem value="initial_load">Initial Inventory Load</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Vendor (Optional)</Label>
              <Select value={newReceipt.vendorId} onValueChange={(v) => setNewReceipt({ ...newReceipt, vendorId: v })}>
                <SelectTrigger data-testid="select-vendor">
                  <SelectValue placeholder="Select vendor..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Vendor</SelectItem>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id.toString()}>{v.name} ({v.code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Warehouse (Optional)</Label>
              <Select value={newReceipt.warehouseId} onValueChange={(v) => setNewReceipt({ ...newReceipt, warehouseId: v })}>
                <SelectTrigger data-testid="select-warehouse">
                  <SelectValue placeholder="Select warehouse..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Warehouse</SelectItem>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id.toString()}>{w.name} ({w.code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(newReceipt.sourceType === "po" || newReceipt.sourceType === "asn") && (
              <div>
                <Label>PO / Reference Number</Label>
                <Input 
                  value={newReceipt.poNumber} 
                  onChange={(e) => setNewReceipt({ ...newReceipt, poNumber: e.target.value })}
                  placeholder="Enter PO or reference number"
                  data-testid="input-po-number"
                />
              </div>
            )}
            <div>
              <Label>Notes (Optional)</Label>
              <Textarea 
                value={newReceipt.notes} 
                onChange={(e) => setNewReceipt({ ...newReceipt, notes: e.target.value })}
                placeholder="Any notes about this receipt..."
                data-testid="input-notes"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowNewReceiptDialog(false)}>Cancel</Button>
              <Button 
                onClick={() => createReceiptMutation.mutate(newReceipt)}
                disabled={createReceiptMutation.isPending}
                data-testid="btn-create-receipt"
              >
                Create Receipt
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* New Vendor Dialog */}
      <Dialog open={showNewVendorDialog} onOpenChange={setShowNewVendorDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Vendor</DialogTitle>
            <DialogDescription>Add a supplier to track receiving</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Code *</Label>
                <Input 
                  value={newVendor.code} 
                  onChange={(e) => setNewVendor({ ...newVendor, code: e.target.value.toUpperCase() })}
                  placeholder="e.g., ACME"
                  maxLength={20}
                  data-testid="input-vendor-code"
                />
              </div>
              <div>
                <Label>Name *</Label>
                <Input 
                  value={newVendor.name} 
                  onChange={(e) => setNewVendor({ ...newVendor, name: e.target.value })}
                  placeholder="Company name"
                  data-testid="input-vendor-name"
                />
              </div>
            </div>
            <div>
              <Label>Contact Name</Label>
              <Input 
                value={newVendor.contactName} 
                onChange={(e) => setNewVendor({ ...newVendor, contactName: e.target.value })}
                placeholder="Contact person"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Email</Label>
                <Input 
                  type="email"
                  value={newVendor.email} 
                  onChange={(e) => setNewVendor({ ...newVendor, email: e.target.value })}
                  placeholder="email@example.com"
                />
              </div>
              <div>
                <Label>Phone</Label>
                <Input 
                  value={newVendor.phone} 
                  onChange={(e) => setNewVendor({ ...newVendor, phone: e.target.value })}
                  placeholder="Phone number"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowNewVendorDialog(false)}>Cancel</Button>
              <Button 
                onClick={() => createVendorMutation.mutate(newVendor)}
                disabled={createVendorMutation.isPending || !newVendor.code || !newVendor.name}
                data-testid="btn-create-vendor"
              >
                Add Vendor
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Receipt Detail Dialog */}
      <Dialog open={showReceiptDetail} onOpenChange={setShowReceiptDetail}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          {selectedReceipt && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  Receipt {selectedReceipt.receiptNumber}
                  <Badge variant={STATUS_BADGES[selectedReceipt.status]?.variant || "secondary"} className="ml-2">
                    {STATUS_BADGES[selectedReceipt.status]?.label || selectedReceipt.status}
                  </Badge>
                </DialogTitle>
                <DialogDescription>
                  {selectedReceipt.sourceType === "initial_load" ? "Initial Inventory Load" : 
                   selectedReceipt.sourceType === "po" ? `PO: ${selectedReceipt.poNumber}` :
                   selectedReceipt.sourceType}
                  {selectedReceipt.vendor && ` • ${selectedReceipt.vendor.name}`}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* Action buttons */}
                <div className="flex gap-2 flex-wrap">
                  {selectedReceipt.status === "draft" && (
                    <>
                      <Button 
                        variant="outline" 
                        onClick={downloadTemplate}
                        data-testid="btn-download-template"
                      >
                        <Download className="h-4 w-4 mr-2" />
                        Download Template
                      </Button>
                      <Button 
                        variant="outline" 
                        onClick={() => { setShowCSVImport(true); }}
                        data-testid="btn-import-csv"
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Import CSV
                      </Button>
                      <Button 
                        onClick={() => openReceiptMutation.mutate(selectedReceipt.id)}
                        disabled={openReceiptMutation.isPending}
                        data-testid="btn-open-receipt"
                      >
                        <Play className="h-4 w-4 mr-2" />
                        Start Receiving
                      </Button>
                    </>
                  )}
                  {(selectedReceipt.status === "open" || selectedReceipt.status === "receiving") && (
                    <>
                      <Button 
                        variant="outline"
                        onClick={() => completeAllMutation.mutate(selectedReceipt.id)}
                        disabled={completeAllMutation.isPending}
                        data-testid="btn-complete-all"
                      >
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Complete All Lines
                      </Button>
                      <Button 
                        onClick={() => closeReceiptMutation.mutate(selectedReceipt.id)}
                        disabled={closeReceiptMutation.isPending}
                        data-testid="btn-close-receipt"
                      >
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Close & Update Inventory
                      </Button>
                    </>
                  )}
                </div>

                {/* Lines table */}
                <Card>
                  <CardHeader className="pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-base">Lines ({selectedReceipt.lines?.length || 0})</CardTitle>
                    {selectedReceipt.status !== "closed" && (
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => setShowAddLineDialog(true)}
                        data-testid="btn-add-line"
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Add Line
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>SKU</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead>Expected</TableHead>
                          <TableHead>Received</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(!selectedReceipt.lines || selectedReceipt.lines.length === 0) ? (
                          <TableRow>
                            <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                              No lines yet. Import CSV or add lines manually.
                            </TableCell>
                          </TableRow>
                        ) : (
                          selectedReceipt.lines.map((line) => (
                            <TableRow key={line.id}>
                              <TableCell className="font-mono">{line.sku || "-"}</TableCell>
                              <TableCell>{line.productName || "-"}</TableCell>
                              <TableCell>{line.expectedQty}</TableCell>
                              <TableCell>
                                {selectedReceipt.status !== "closed" ? (
                                  <Input 
                                    type="number"
                                    value={line.receivedQty}
                                    onChange={(e) => updateLineMutation.mutate({ 
                                      lineId: line.id, 
                                      updates: { receivedQty: parseInt(e.target.value) || 0 } 
                                    })}
                                    className="w-20 h-8"
                                    min={0}
                                  />
                                ) : (
                                  line.receivedQty
                                )}
                              </TableCell>
                              <TableCell>
                                {selectedReceipt.status !== "closed" ? (
                                  <Select 
                                    value={line.putawayLocationId?.toString() || "none"}
                                    onValueChange={(v) => updateLineMutation.mutate({
                                      lineId: line.id,
                                      updates: { putawayLocationId: v !== "none" ? parseInt(v) : null }
                                    })}
                                  >
                                    <SelectTrigger className="w-32 h-8">
                                      <SelectValue placeholder="Location" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="none">Select...</SelectItem>
                                      {locations.map((loc) => (
                                        <SelectItem key={loc.id} value={loc.id.toString()}>
                                          {loc.code}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : (
                                  locations.find(l => l.id === line.putawayLocationId)?.code || "-"
                                )}
                              </TableCell>
                              <TableCell>
                                <Badge variant={
                                  line.status === "complete" ? "default" :
                                  line.status === "partial" ? "outline" :
                                  line.status === "overage" ? "destructive" :
                                  "secondary"
                                }>
                                  {line.status}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* CSV Import Dialog */}
      <Dialog open={showCSVImport} onOpenChange={setShowCSVImport}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import from CSV</DialogTitle>
            <DialogDescription>
              Paste CSV data with columns: sku, qty, location (optional)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-muted p-3 rounded text-sm font-mono">
              Example:<br/>
              sku,qty,location<br/>
              PROD-001,100,A-01<br/>
              PROD-002,50,B-02
            </div>
            
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="flex items-center justify-center gap-2 border-2 border-dashed rounded-lg p-4 cursor-pointer hover:border-primary transition-colors">
                  <Upload className="h-5 w-5 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Choose CSV file or drag & drop</span>
                  <input 
                    type="file" 
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onload = (event) => {
                          setCsvText(event.target?.result as string || "");
                        };
                        reader.readAsText(file);
                      }
                    }}
                    data-testid="input-csv-file"
                  />
                </label>
              </div>
            </div>

            <div className="text-center text-xs text-muted-foreground">— or paste directly —</div>
            
            <Textarea 
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder="Paste your CSV data here..."
              className="min-h-[200px] font-mono text-sm"
              data-testid="textarea-csv"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCSVImport(false)}>Cancel</Button>
              <Button 
                onClick={handleCSVImport}
                disabled={bulkImportMutation.isPending || !csvText.trim()}
                data-testid="btn-import"
              >
                <Upload className="h-4 w-4 mr-2" />
                Import Lines
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Line Dialog */}
      <Dialog open={showAddLineDialog} onOpenChange={setShowAddLineDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Line</DialogTitle>
            <DialogDescription>
              Add a product line to this receiving order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>SKU</Label>
              <div className="relative">
                <Input
                  value={skuSearch}
                  onChange={(e) => handleSkuSearch(e.target.value)}
                  onFocus={() => skuResults.length > 0 && setShowSkuDropdown(true)}
                  onBlur={() => setTimeout(() => setShowSkuDropdown(false), 200)}
                  placeholder="Search by SKU or product name..."
                  data-testid="input-add-line-sku"
                />
                {showSkuDropdown && skuResults.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {skuResults.map((item) => (
                      <button
                        key={item.catalogProductId}
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-gray-100 text-sm"
                        onClick={() => {
                          setNewLine({
                            ...newLine,
                            sku: item.sku,
                            productName: item.name,
                            catalogProductId: item.catalogProductId,
                            inventoryItemId: item.inventoryItemId,
                          });
                          setSkuSearch(item.sku);
                          setShowSkuDropdown(false);
                        }}
                        data-testid={`sku-option-${item.sku}`}
                      >
                        <div className="font-mono">{item.sku}</div>
                        <div className="text-xs text-muted-foreground truncate">{item.name}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {newLine.sku && (
                <div className="text-xs text-muted-foreground">
                  Selected: {newLine.sku} - {newLine.productName}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Expected Qty</Label>
              <Input
                type="number"
                value={newLine.expectedQty}
                onChange={(e) => setNewLine({ ...newLine, expectedQty: e.target.value })}
                min="1"
                data-testid="input-add-line-expected"
              />
            </div>

            <div className="space-y-2">
              <Label>Put-away Location</Label>
              <div className="relative">
                <Input
                  value={locationSearch}
                  onChange={(e) => handleLocationSearch(e.target.value)}
                  onFocus={() => {
                    if (locationSearch.length > 0 && locationResults.length > 0) {
                      setShowLocationDropdown(true);
                    } else if (locationSearch.length === 0) {
                      const initial = locations.slice(0, 20);
                      setLocationResults(initial);
                      setShowLocationDropdown(initial.length > 0);
                    }
                  }}
                  onBlur={() => setTimeout(() => setShowLocationDropdown(false), 200)}
                  placeholder="Search location by code..."
                  data-testid="input-add-line-location"
                />
                {showLocationDropdown && locationResults.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {locationResults.map((loc) => (
                      <button
                        key={loc.id}
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-gray-100 text-sm"
                        onClick={() => {
                          setNewLine({ ...newLine, putawayLocationId: loc.id.toString() });
                          setLocationSearch(loc.code);
                          setShowLocationDropdown(false);
                        }}
                        data-testid={`location-option-${loc.code}`}
                      >
                        <div className="font-mono">{loc.code}</div>
                        {loc.name && <div className="text-xs text-muted-foreground">{loc.name}</div>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {newLine.putawayLocationId && !locationSearch && (
                <div className="text-xs text-muted-foreground">
                  Selected: {locations.find(l => l.id.toString() === newLine.putawayLocationId)?.code}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => {
                setShowAddLineDialog(false);
                setSkuSearch("");
                setSkuResults([]);
                setLocationSearch("");
                setLocationResults([]);
                setNewLine({
                  sku: "",
                  productName: "",
                  expectedQty: "1",
                  putawayLocationId: "",
                  catalogProductId: null,
                  inventoryItemId: null,
                });
              }}>
                Cancel
              </Button>
              <Button 
                onClick={() => {
                  if (!selectedReceipt || !newLine.sku) return;
                  addLineMutation.mutate({
                    orderId: selectedReceipt.id,
                    line: {
                      sku: newLine.sku,
                      productName: newLine.productName,
                      expectedQty: parseInt(newLine.expectedQty) || 1,
                      putawayLocationId: newLine.putawayLocationId ? parseInt(newLine.putawayLocationId) : null,
                      catalogProductId: newLine.catalogProductId,
                      inventoryItemId: newLine.inventoryItemId,
                    },
                  });
                }}
                disabled={!newLine.sku || addLineMutation.isPending}
                data-testid="btn-confirm-add-line"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Line
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
