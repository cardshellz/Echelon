import { useState, useRef, useEffect } from "react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  AlertTriangle,
  XCircle,
  MapPin,
  Building2,
  ChevronsUpDown
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
  productVariantId: number | null;
  productId: number | null;
  putawayLocationId: number | null;
  putawayComplete: number;
  status: string;
  unitCost: number | null;
  notes: string | null;
  purchaseOrderLineId: number | null;
}

interface ReceivingOrder {
  id: number;
  receiptNumber: string;
  poNumber: string | null;
  asnNumber: string | null;
  sourceType: string;
  vendorId: number | null;
  warehouseId: number | null;
  purchaseOrderId: number | null;
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

function LocationTypeahead({ 
  locations, 
  value, 
  onChange,
  disabled = false
}: { 
  locations: WarehouseLocation[];
  value: number | null;
  onChange: (locationId: number | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  
  const selectedLocation = locations.find(l => l.id === value);
  
  const filteredLocations = search.length > 0
    ? locations.filter(l => 
        l.code.toLowerCase().includes(search.toLowerCase()) ||
        (l.name && l.name.toLowerCase().includes(search.toLowerCase()))
      ).slice(0, 15)
    : locations.slice(0, 15);
  
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);
  
  if (disabled) {
    return <span className="text-sm">{selectedLocation?.code || "-"}</span>;
  }
  
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          className="w-28 min-h-[44px] h-10 justify-start text-left font-normal truncate"
        >
          {selectedLocation?.code || "Select..."}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start">
        <div className="p-2 border-b">
          <Input
            ref={inputRef}
            placeholder="Type to search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
        <ScrollArea className="h-48">
          <div className="p-1">
            <button
              className="w-full text-left px-2 py-3 text-sm rounded hover:bg-accent active:bg-accent/80 cursor-pointer min-h-[44px]"
              onClick={() => { onChange(null); setOpen(false); setSearch(""); }}
            >
              Clear
            </button>
            {filteredLocations.map((loc) => (
              <button
                key={loc.id}
                className={`w-full text-left px-2 py-3 text-sm rounded hover:bg-accent active:bg-accent/80 cursor-pointer min-h-[44px] ${loc.id === value ? 'bg-accent' : ''}`}
                onClick={() => { onChange(loc.id); setOpen(false); setSearch(""); }}
              >
                {loc.code}
              </button>
            ))}
            {filteredLocations.length === 0 && search && (
              <div className="px-2 py-4 text-sm text-muted-foreground text-center">
                No locations found
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
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
  const [importResults, setImportResults] = useState<{ errors: string[]; warnings: string[]; created: number; updated: number } | null>(null);
  const [showImportResults, setShowImportResults] = useState(false);
  const [showAddLineDialog, setShowAddLineDialog] = useState(false);
  // Resolution UI state
  const [resolvingLine, setResolvingLine] = useState<ReceivingLine | null>(null);
  const [showResolveDialog, setShowResolveDialog] = useState(false);
  const [resolveMode, setResolveMode] = useState<'sku' | 'location'>('sku');
  const [resolveSkuSearch, setResolveSkuSearch] = useState("");
  const [resolveSkuResults, setResolveSkuResults] = useState<{sku: string; name: string; productVariantId: number}[]>([]);
  const [resolveLocSearch, setResolveLocSearch] = useState("");
  const resolveSkuTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [newLine, setNewLine] = useState({
    sku: "",
    productName: "",
    expectedQty: "1",
    putawayLocationId: "",
    productId: null as number | null,
    productVariantId: null as number | null,
  });
  const [skuSearch, setSkuSearch] = useState("");
  const [skuResults, setSkuResults] = useState<{sku: string; name: string; productId: number | null; productVariantId: number; unitsPerVariant: number}[]>([]);
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
  
  // PO selection state (for "From Purchase Order" flow)
  const [selectedPoId, setSelectedPoId] = useState<number | null>(null);
  const [poSearch, setPoSearch] = useState("");
  const [poPickerOpen, setPoPickerOpen] = useState(false);

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

  const { data: variants = [] } = useQuery<{ id: number; sku: string; name: string; productId: number }[]>({
    queryKey: ["/api/product-variants"],
  });

  // Open POs for "From PO" flow (only fetch when PO source type selected)
  const { data: openPOs = [] } = useQuery<{ id: number; poNumber: string; status: string; vendorId: number; totalCents: number; lineCount: number; vendor?: { name: string } }[]>({
    queryKey: ["/api/purchase-orders", { status: "receivable" }],
    queryFn: async () => {
      const res = await fetch("/api/purchase-orders?status=sent,acknowledged,partially_received");
      if (!res.ok) return [];
      const data = await res.json();
      return data.purchaseOrders || [];
    },
    enabled: newReceipt.sourceType === "po",
  });

  // Mutations
  const createReceiptMutation = useMutation({
    mutationFn: async (data: typeof newReceipt) => {
      // If PO source type with a selected PO, use the create-receipt-from-PO endpoint
      if (data.sourceType === "po" && selectedPoId) {
        const res = await fetch(`/api/purchase-orders/${selectedPoId}/create-receipt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || "Failed to create receipt from PO");
        }
        return res.json();
      }
      // Regular receipt creation
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
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      setShowNewReceiptDialog(false);
      setNewReceipt({ sourceType: "blind", vendorId: "", warehouseId: "", poNumber: "", notes: "" });
      setSelectedPoId(null);
      setPoSearch("");
      toast({ title: "Receipt created", description: `Receipt ${receipt.receiptNumber} created` });
      // Fetch the full receipt with lines for the detail view
      fetch(`/api/receiving/${receipt.id}`).then(r => r.json()).then(full => {
        setSelectedReceipt(full);
        setShowReceiptDetail(true);
      }).catch(() => {
        setSelectedReceipt(receipt);
        setShowReceiptDetail(true);
      });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to create receipt", variant: "destructive" });
    },
  });

  const deleteReceiptMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/receiving/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete receipt");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      toast({ title: "Receipt deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
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
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.issues) {
          const err = new Error(body.error) as Error & { issues: any[] };
          err.issues = body.issues;
          throw err;
        }
        throw new Error(body?.error || "Failed to close receipt");
      }
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      toast({
        title: "Receipt closed",
        description: `${result.unitsReceived} units received across ${result.linesProcessed} lines`
      });
      setShowReceiptDetail(false);
    },
    onError: (error: any) => {
      if (error.issues) {
        const missingSku = error.issues.filter((i: any) => i.missingVariant).length;
        const missingLoc = error.issues.filter((i: any) => i.missingLocation).length;
        const parts: string[] = [];
        if (missingSku) parts.push(`${missingSku} missing product link`);
        if (missingLoc) parts.push(`${missingLoc} missing location`);
        toast({
          title: "Cannot close receipt",
          description: `Resolve issues first: ${parts.join(", ")}`,
          variant: "destructive",
        });
      } else {
        toast({ title: "Failed to close receipt", description: error.message, variant: "destructive" });
      }
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
        // Store results for persistent display
        setImportResults({
          errors: result.errors || [],
          warnings: result.warnings || [],
          created: result.created || 0,
          updated: result.updated || 0,
        });
        setShowImportResults(true);
        toast({ 
          title: `Import complete with issues`, 
          description: `${totalProcessed} lines processed. Click to view details.`,
          duration: 5000,
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
        productId: null,
        productVariantId: null,
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
        const updatedLines = selectedReceipt.lines.map(line => 
          line.id === updatedLine.id ? updatedLine : line
        );
        setSelectedReceipt({
          ...selectedReceipt,
          lines: updatedLines
        });
        
        // Check if the line was completed
        if (updatedLine.status === "complete") {
          // Check if all lines are now complete
          const allComplete = updatedLines.every(l => l.status === "complete");
          if (allComplete) {
            toast({ 
              title: "All lines complete!", 
              description: "Receipt is ready to close. Click 'Close & Update Inventory' to finalize.",
            });
          } else {
            toast({ title: "Line marked complete" });
          }
        }
      }
    },
    onError: () => {
      toast({ title: "Failed to update line", variant: "destructive" });
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

  // Create a new product variant from a receiving line's SKU
  const createVariantMutation = useMutation({
    mutationFn: async (lineId: number) => {
      const res = await fetch(`/api/receiving/lines/${lineId}/create-variant`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to create variant" }));
        throw new Error(err.error || "Failed to create variant");
      }
      return res.json();
    },
    onSuccess: async (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (!selectedReceipt?.lines) return;

      let updatedLines = selectedReceipt.lines.map(line =>
        line.id === data.line.id ? data.line : line
      );

      // Auto-link other lines with the same SKU that are also missing productVariantId
      const sameSku = updatedLines.filter(l =>
        l.id !== data.line.id && l.sku?.toUpperCase() === data.variant.sku.toUpperCase() && !l.productVariantId
      );
      for (const sibling of sameSku) {
        try {
          const res = await fetch(`/api/receiving/lines/${sibling.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ productVariantId: data.variant.id, productName: `${data.product.name} — ${data.variant.name}` }),
          });
          if (res.ok) {
            const updated = await res.json();
            updatedLines = updatedLines.map(l => l.id === updated.id ? updated : l);
          }
        } catch { /* continue */ }
      }

      setSelectedReceipt({ ...selectedReceipt, lines: updatedLines });

      const linkedCount = 1 + sameSku.length;
      toast({
        title: "Variant created & linked",
        description: `${data.variant.sku} (${data.variant.name}) — linked to ${linkedCount} line${linkedCount > 1 ? 's' : ''}`,
      });

      // Auto-advance to next unresolved line
      const nextIssue = updatedLines.find(l =>
        l.receivedQty > 0 && (!l.productVariantId || !l.putawayLocationId) && l.id !== data.line.id
      );
      if (nextIssue) {
        const mode = !nextIssue.productVariantId ? 'sku' : 'location';
        setResolvingLine(nextIssue);
        setResolveMode(mode);
        setResolveSkuSearch(nextIssue.sku || "");
        setResolveSkuResults([]);
        setResolveLocSearch("");
      } else {
        setShowResolveDialog(false);
      }
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create variant", description: error.message, variant: "destructive" });
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

  // Close receipt — server auto-resolves SKU→variant and blocks if data is missing
  const handlePreCloseValidation = () => {
    if (!selectedReceipt?.lines) return;
    closeReceiptMutation.mutate(selectedReceipt.id);
  };

  // Compute issue counts for the current receipt
  const issueLines = selectedReceipt?.lines?.filter(l => l.receivedQty > 0 && (!l.productVariantId || !l.putawayLocationId)) || [];
  const skuIssueCount = issueLines.filter(l => !l.productVariantId).length;
  const locIssueCount = issueLines.filter(l => !l.putawayLocationId).length;

  // Sort lines: issues first, then by id
  const sortedLines = selectedReceipt?.lines
    ? [...selectedReceipt.lines].sort((a, b) => {
        const aHasIssue = (!a.productVariantId || !a.putawayLocationId) ? 1 : 0;
        const bHasIssue = (!b.productVariantId || !b.putawayLocationId) ? 1 : 0;
        if (bHasIssue !== aHasIssue) return bHasIssue - aHasIssue;
        return a.id - b.id;
      })
    : [];

  // Resolution: open dialog for a specific line + issue type
  const openResolve = (line: ReceivingLine, mode: 'sku' | 'location') => {
    setResolvingLine(line);
    setResolveMode(mode);
    setResolveSkuSearch(line.sku || "");
    setResolveSkuResults([]);
    setResolveLocSearch("");
    setShowResolveDialog(true);
  };

  // Debounced SKU search for resolution dialog
  const handleResolveSkuSearch = (query: string) => {
    setResolveSkuSearch(query);
    if (resolveSkuTimeout.current) clearTimeout(resolveSkuTimeout.current);
    if (query.length < 2) { setResolveSkuResults([]); return; }
    resolveSkuTimeout.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/inventory/skus/search?q=${encodeURIComponent(query)}&limit=10`);
        if (res.ok) setResolveSkuResults(await res.json());
      } catch { /* ignore */ }
    }, 300);
  };

  // Parse a SKU to preview what product/variant will be created
  const parseSku = (sku: string | null) => {
    if (!sku) return null;
    const match = sku.match(/^(.+)-(P|B|C)(\d+)$/i);
    if (match) {
      const type = match[2].toUpperCase();
      const typeName = type === "P" ? "Pack" : type === "B" ? "Box" : "Case";
      return { baseSku: match[1].toUpperCase(), typeName, units: parseInt(match[3], 10) };
    }
    return { baseSku: sku.toUpperCase(), typeName: "Each", units: 1 };
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
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Truck className="h-5 w-5 md:h-6 md:w-6" />
            Receiving
          </h1>
          <p className="text-sm text-muted-foreground">
            Receive inventory and manage purchase orders
          </p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <Button variant="outline" onClick={() => setShowNewVendorDialog(true)} data-testid="btn-new-vendor" className="min-h-[44px] flex-1 sm:flex-none">
            <Building2 className="h-4 w-4 mr-2" />
            <span className="hidden sm:inline">New</span> Vendor
          </Button>
          <Button onClick={() => setShowNewReceiptDialog(true)} data-testid="btn-new-receipt" className="min-h-[44px] flex-1 sm:flex-none">
            <Plus className="h-4 w-4 mr-2" />
            <span className="hidden sm:inline">New</span> Receipt
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.total}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Total Receipts</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-blue-600">{stats.open}</div>
            <div className="text-xs md:text-sm text-muted-foreground">In Progress</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-green-600">{stats.closed}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Completed</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-gray-500">{stats.draft}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Drafts</div>
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
              <SelectTrigger className="w-40 h-10" data-testid="select-status-filter">
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

          {/* Mobile card view */}
          <div className="md:hidden space-y-3">
            {filteredReceipts.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-center text-muted-foreground">
                  No receipts found. Tap "Receipt" to create one.
                </CardContent>
              </Card>
            ) : (
              filteredReceipts.map((receipt) => (
                <Card 
                  key={receipt.id} 
                  className="cursor-pointer active:bg-accent/50"
                  onClick={() => loadReceiptDetail(receipt)}
                  data-testid={`receipt-card-${receipt.id}`}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-sm">{receipt.receiptNumber}</span>
                          <Badge variant={STATUS_BADGES[receipt.status]?.variant || "secondary"} className="text-xs">
                            {STATUS_BADGES[receipt.status]?.label || receipt.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                          <Badge variant="outline" className="text-xs">{receipt.sourceType}</Badge>
                          {receipt.vendor?.name && <span>• {receipt.vendor.name}</span>}
                        </div>
                        <div className="flex gap-4 mt-2 text-xs">
                          <span>Lines: {receipt.receivedLineCount || 0}/{receipt.expectedLineCount || 0}</span>
                          <span>Units: {receipt.receivedTotalUnits || 0}/{receipt.expectedTotalUnits || 0}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {format(new Date(receipt.createdAt), "MMM d, yyyy h:mm a")}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0" onClick={(e) => { e.stopPropagation(); loadReceiptDetail(receipt); }}>
                          <FileText className="h-4 w-4" />
                        </Button>
                        {receipt.status !== "closed" && (
                          <Button 
                            variant="ghost" 
                            size="sm"
                            className="min-h-[44px] min-w-[44px] p-0"
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              if (confirm(`Delete receipt ${receipt.receiptNumber}?`)) {
                                deleteReceiptMutation.mutate(receipt.id);
                              }
                            }}
                            disabled={deleteReceiptMutation.isPending}
                            data-testid={`btn-delete-receipt-mobile-${receipt.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          {/* Desktop table view */}
          <Card className="hidden md:block">
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
                  <TableHead>Created At</TableHead>
                  <TableHead>Closed At</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredReceipts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
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
                      <TableCell className="text-sm">{format(new Date(receipt.createdAt), "MMM d, yyyy h:mm a")}</TableCell>
                      <TableCell className="text-sm">
                        {receipt.closedDate ? format(new Date(receipt.closedDate), "MMM d, yyyy h:mm a") : "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); loadReceiptDetail(receipt); }}>
                            <FileText className="h-4 w-4" />
                          </Button>
                          {receipt.status !== "closed" && (
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                if (confirm(`Delete receipt ${receipt.receiptNumber}?`)) {
                                  deleteReceiptMutation.mutate(receipt.id);
                                }
                              }}
                              disabled={deleteReceiptMutation.isPending}
                              data-testid={`btn-delete-receipt-${receipt.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="vendors" className="space-y-4">
          {/* Mobile card view */}
          <div className="md:hidden space-y-3">
            {vendors.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-center text-muted-foreground">
                  No vendors found. Tap "Vendor" to add one.
                </CardContent>
              </Card>
            ) : (
              vendors.map((vendor) => (
                <Card key={vendor.id} data-testid={`vendor-card-${vendor.id}`}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-sm">{vendor.code}</span>
                          <Badge variant={vendor.active ? "default" : "secondary"} className="text-xs">
                            {vendor.active ? "Active" : "Inactive"}
                          </Badge>
                        </div>
                        <div className="font-medium mt-1">{vendor.name}</div>
                        {vendor.contactName && (
                          <div className="text-xs text-muted-foreground mt-1">{vendor.contactName}</div>
                        )}
                        {vendor.email && (
                          <div className="text-xs text-muted-foreground">{vendor.email}</div>
                        )}
                        {vendor.phone && (
                          <div className="text-xs text-muted-foreground">{vendor.phone}</div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          {/* Desktop table view */}
          <Card className="hidden md:block">
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
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Create New Receipt</DialogTitle>
            <DialogDescription>Create a new receiving document to receive inventory</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-sm">Receipt Type</Label>
              <Select value={newReceipt.sourceType} onValueChange={(v) => setNewReceipt({ ...newReceipt, sourceType: v })}>
                <SelectTrigger className="h-11" data-testid="select-receipt-type">
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
            
            <details className="group">
              <summary className="text-sm font-medium cursor-pointer list-none flex items-center gap-2">
                <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                Optional Fields
              </summary>
              <div className="space-y-4 mt-4 pl-4 border-l-2">
                <div>
                  <Label className="text-sm">Vendor</Label>
                  <Select value={newReceipt.vendorId} onValueChange={(v) => setNewReceipt({ ...newReceipt, vendorId: v })}>
                    <SelectTrigger className="h-11" data-testid="select-vendor">
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
                  <Label className="text-sm">Warehouse</Label>
                  <Select value={newReceipt.warehouseId} onValueChange={(v) => setNewReceipt({ ...newReceipt, warehouseId: v })}>
                    <SelectTrigger className="h-11" data-testid="select-warehouse">
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
                {newReceipt.sourceType === "po" && (
                  <div>
                    <Label className="text-sm">Purchase Order</Label>
                    <Popover open={poPickerOpen} onOpenChange={setPoPickerOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between h-11 font-normal">
                          {selectedPoId
                            ? (() => {
                                const po = openPOs.find(p => p.id === selectedPoId);
                                return po ? `${po.poNumber} — ${po.vendor?.name || "Unknown"}` : "Select PO...";
                              })()
                            : "Select open PO..."}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                        <Command shouldFilter={false}>
                          <CommandInput placeholder="Search PO#..." value={poSearch} onValueChange={setPoSearch} />
                          <CommandList>
                            <CommandEmpty>No open POs found</CommandEmpty>
                            <CommandGroup>
                              {openPOs
                                .filter(po =>
                                  !poSearch ||
                                  po.poNumber.toLowerCase().includes(poSearch.toLowerCase()) ||
                                  po.vendor?.name?.toLowerCase().includes(poSearch.toLowerCase())
                                )
                                .slice(0, 50)
                                .map(po => (
                                  <CommandItem
                                    key={po.id}
                                    value={po.id.toString()}
                                    onSelect={() => {
                                      setSelectedPoId(po.id);
                                      setNewReceipt(prev => ({
                                        ...prev,
                                        poNumber: po.poNumber,
                                        vendorId: po.vendorId?.toString() || prev.vendorId,
                                      }));
                                      setPoPickerOpen(false);
                                      setPoSearch("");
                                    }}
                                  >
                                    <Check className={`mr-2 h-4 w-4 ${selectedPoId === po.id ? "opacity-100" : "opacity-0"}`} />
                                    <div className="flex-1 min-w-0">
                                      <div className="font-medium">{po.poNumber}</div>
                                      <div className="text-xs text-muted-foreground truncate">
                                        {po.vendor?.name || "No vendor"} — {po.lineCount} lines — ${((po.totalCents || 0) / 100).toFixed(2)}
                                      </div>
                                    </div>
                                    <Badge variant="outline" className="ml-2 text-xs shrink-0">{po.status}</Badge>
                                  </CommandItem>
                                ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                )}
                {newReceipt.sourceType === "asn" && (
                  <div>
                    <Label className="text-sm">PO / Reference Number</Label>
                    <Input
                      className="h-11"
                      value={newReceipt.poNumber}
                      onChange={(e) => setNewReceipt({ ...newReceipt, poNumber: e.target.value })}
                      placeholder="Enter PO or reference number"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-testid="input-po-number"
                    />
                  </div>
                )}
                <div>
                  <Label className="text-sm">Notes</Label>
                  <Textarea 
                    value={newReceipt.notes} 
                    onChange={(e) => setNewReceipt({ ...newReceipt, notes: e.target.value })}
                    placeholder="Any notes about this receipt..."
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-notes"
                  />
                </div>
              </div>
            </details>
            
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" className="min-h-[44px]" onClick={() => setShowNewReceiptDialog(false)}>Cancel</Button>
              <Button 
                className="min-h-[44px]"
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
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Add New Vendor</DialogTitle>
            <DialogDescription>Add a supplier to track receiving</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-sm">Code *</Label>
                <Input 
                  className="h-11"
                  value={newVendor.code} 
                  onChange={(e) => setNewVendor({ ...newVendor, code: e.target.value.toUpperCase() })}
                  placeholder="e.g., ACME"
                  maxLength={20}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  data-testid="input-vendor-code"
                />
              </div>
              <div>
                <Label className="text-sm">Name *</Label>
                <Input 
                  className="h-11"
                  value={newVendor.name} 
                  onChange={(e) => setNewVendor({ ...newVendor, name: e.target.value })}
                  placeholder="Company name"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-vendor-name"
                />
              </div>
            </div>
            
            <details className="group">
              <summary className="text-sm font-medium cursor-pointer list-none flex items-center gap-2">
                <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                Optional Contact Details
              </summary>
              <div className="space-y-4 mt-4 pl-4 border-l-2">
                <div>
                  <Label className="text-sm">Contact Name</Label>
                  <Input 
                    className="h-11"
                    value={newVendor.contactName} 
                    onChange={(e) => setNewVendor({ ...newVendor, contactName: e.target.value })}
                    placeholder="Contact person"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm">Email</Label>
                    <Input 
                      className="h-11"
                      type="email"
                      value={newVendor.email} 
                      onChange={(e) => setNewVendor({ ...newVendor, email: e.target.value })}
                      placeholder="email@example.com"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </div>
                  <div>
                    <Label className="text-sm">Phone</Label>
                    <Input 
                      className="h-11"
                      type="tel"
                      value={newVendor.phone} 
                      onChange={(e) => setNewVendor({ ...newVendor, phone: e.target.value })}
                      placeholder="Phone number"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </div>
                </div>
              </div>
            </details>
            
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" className="min-h-[44px]" onClick={() => setShowNewVendorDialog(false)}>Cancel</Button>
              <Button 
                className="min-h-[44px]"
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
        <DialogContent className="max-w-4xl md:max-w-4xl max-h-[90vh] overflow-y-auto p-4">
          {selectedReceipt && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <FileText className="h-5 w-5" />
                  <span className="text-base md:text-lg">Receipt {selectedReceipt.receiptNumber}</span>
                  <Badge variant={STATUS_BADGES[selectedReceipt.status]?.variant || "secondary"} className="text-xs">
                    {STATUS_BADGES[selectedReceipt.status]?.label || selectedReceipt.status}
                  </Badge>
                </DialogTitle>
                <DialogDescription className="text-xs md:text-sm">
                  {selectedReceipt.sourceType === "initial_load" ? "Initial Inventory Load" :
                   selectedReceipt.sourceType === "po" ? (
                     selectedReceipt.purchaseOrderId ? (
                       <span>PO: <a href={`/purchase-orders/${selectedReceipt.purchaseOrderId}`} className="text-primary underline">{selectedReceipt.poNumber}</a></span>
                     ) : `PO: ${selectedReceipt.poNumber}`
                   ) : selectedReceipt.sourceType}
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
                        className="min-h-[44px] text-xs md:text-sm flex-1 sm:flex-none"
                        onClick={downloadTemplate}
                        data-testid="btn-download-template"
                      >
                        <Download className="h-4 w-4 mr-1 md:mr-2" />
                        <span className="hidden sm:inline">Download</span> Template
                      </Button>
                      <Button 
                        variant="outline"
                        className="min-h-[44px] text-xs md:text-sm flex-1 sm:flex-none"
                        onClick={() => { setShowCSVImport(true); }}
                        data-testid="btn-import-csv"
                      >
                        <Upload className="h-4 w-4 mr-1 md:mr-2" />
                        <span className="hidden sm:inline">Import</span> CSV
                      </Button>
                      <Button 
                        className="min-h-[44px] text-xs md:text-sm flex-1 sm:flex-none"
                        onClick={() => openReceiptMutation.mutate(selectedReceipt.id)}
                        disabled={openReceiptMutation.isPending}
                        data-testid="btn-open-receipt"
                      >
                        <Play className="h-4 w-4 mr-1 md:mr-2" />
                        Start
                      </Button>
                    </>
                  )}
                  {(selectedReceipt.status === "open" || selectedReceipt.status === "receiving") && (
                    <>
                      <Button 
                        variant="outline"
                        className="min-h-[44px] text-xs md:text-sm flex-1 sm:flex-none"
                        onClick={() => completeAllMutation.mutate(selectedReceipt.id)}
                        disabled={completeAllMutation.isPending}
                        data-testid="btn-complete-all"
                      >
                        <CheckCircle className="h-4 w-4 mr-1 md:mr-2" />
                        Complete All
                      </Button>
                      <Button
                        className="min-h-[44px] text-xs md:text-sm flex-1 sm:flex-none"
                        onClick={handlePreCloseValidation}
                        disabled={closeReceiptMutation.isPending}
                        data-testid="btn-close-receipt"
                      >
                        <CheckCircle className="h-4 w-4 mr-1 md:mr-2" />
                        Close
                      </Button>
                    </>
                  )}
                </div>

                {/* Lines section */}
                <Card>
                  <CardHeader className="p-3 md:pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-sm md:text-base">Lines ({selectedReceipt.lines?.length || 0})</CardTitle>
                    {selectedReceipt.status !== "closed" && (
                      <Button 
                        variant="outline" 
                        size="sm"
                        className="min-h-[44px]"
                        onClick={() => setShowAddLineDialog(true)}
                        data-testid="btn-add-line"
                      >
                        <Plus className="h-4 w-4 mr-1" />
                        Add Line
                      </Button>
                    )}
                  </CardHeader>
                  {/* Issue summary banner */}
                  {selectedReceipt.status !== "closed" && issueLines.length > 0 && (
                    <div
                      className="mx-3 mb-2 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2 text-sm cursor-pointer hover:bg-amber-100 transition-colors"
                      onClick={() => {
                        const first = issueLines[0];
                        if (first) openResolve(first, !first.productVariantId ? 'sku' : 'location');
                      }}
                    >
                      <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                      <div className="flex-1">
                        <div className="font-medium text-amber-800">
                          {issueLines.length} line{issueLines.length !== 1 ? 's' : ''} need attention
                        </div>
                        <div className="text-amber-700 text-xs mt-0.5">
                          {skuIssueCount > 0 && <span>{skuIssueCount} unmatched SKU{skuIssueCount !== 1 ? 's' : ''}</span>}
                          {skuIssueCount > 0 && locIssueCount > 0 && <span> + </span>}
                          {locIssueCount > 0 && <span>{locIssueCount} missing location{locIssueCount !== 1 ? 's' : ''}</span>}
                          <span> — tap to resolve</span>
                        </div>
                      </div>
                    </div>
                  )}
                  <CardContent className="p-0">
                    {/* Mobile card view for lines */}
                    <div className="md:hidden p-2 space-y-2">
                      {sortedLines.length === 0 ? (
                        <div className="text-center text-muted-foreground py-8 text-sm">
                          No lines yet. Import CSV or add lines manually.
                        </div>
                      ) : (
                        sortedLines.map((line) => (
                          <Card key={line.id} className="border">
                            <CardContent className="p-3 space-y-2">
                              <div className="flex items-start justify-between">
                                <div className="flex-1 min-w-0">
                                  <div className="font-mono text-sm font-medium truncate">{line.sku || "-"}</div>
                                  <div className="text-xs text-muted-foreground truncate">{line.productName || "-"}</div>
                                </div>
                                <Badge variant={
                                  line.status === "complete" ? "default" :
                                  line.status === "partial" ? "outline" :
                                  line.status === "overage" ? "destructive" :
                                  "secondary"
                                } className="text-xs ml-2">
                                  {line.status}
                                </Badge>
                              </div>
                              {/* Issue badges */}
                              {selectedReceipt.status !== "closed" && (!line.productVariantId || !line.putawayLocationId) && (
                                <div className="flex gap-1 flex-wrap">
                                  {!line.productVariantId && (
                                    <button
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                                      onClick={() => openResolve(line, 'sku')}
                                    >
                                      <AlertTriangle className="h-3 w-3" /> SKU not linked
                                    </button>
                                  )}
                                  {!line.putawayLocationId && (
                                    <button
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                                      onClick={() => openResolve(line, 'location')}
                                    >
                                      <AlertTriangle className="h-3 w-3" /> Location missing
                                    </button>
                                  )}
                                </div>
                              )}
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div>
                                  <Label className="text-xs text-muted-foreground">Expected</Label>
                                  <div className="font-medium">{line.expectedQty}</div>
                                </div>
                                <div>
                                  <Label className="text-xs text-muted-foreground">Received</Label>
                                  {selectedReceipt.status !== "closed" ? (
                                    <Input
                                      type="number"
                                      value={line.receivedQty}
                                      onChange={(e) => updateLineMutation.mutate({
                                        lineId: line.id,
                                        updates: { receivedQty: parseInt(e.target.value) || 0 }
                                      })}
                                      className="h-10 w-full mt-1"
                                      min={0}
                                      autoComplete="off"
                                    />
                                  ) : (
                                    <div className="font-medium">{line.receivedQty}</div>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex-1">
                                  <Label className="text-xs text-muted-foreground">Location</Label>
                                  <div className="mt-1">
                                    {selectedReceipt.status === "closed" ? (
                                      <span className="text-sm">
                                        {line.putawayLocationId 
                                          ? locations.find(l => l.id === line.putawayLocationId)?.code || "Set"
                                          : "Via CSV"
                                        }
                                      </span>
                                    ) : (
                                      <LocationTypeahead
                                        locations={locations}
                                        value={line.putawayLocationId}
                                        onChange={(locationId) => updateLineMutation.mutate({
                                          lineId: line.id,
                                          updates: { putawayLocationId: locationId }
                                        })}
                                        disabled={false}
                                      />
                                    )}
                                  </div>
                                </div>
                                {selectedReceipt.status !== "closed" && line.status !== "complete" && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="min-h-[44px]"
                                    onClick={() => updateLineMutation.mutate({
                                      lineId: line.id,
                                      updates: { 
                                        receivedQty: line.expectedQty || 0,
                                        status: "complete" 
                                      }
                                    })}
                                    disabled={updateLineMutation.isPending}
                                    data-testid={`btn-complete-line-mobile-${line.id}`}
                                  >
                                    <Check className="h-4 w-4 mr-1" />
                                    Done
                                  </Button>
                                )}
                                {line.status === "complete" && (
                                  <Check className="h-5 w-5 text-green-600" />
                                )}
                              </div>
                            </CardContent>
                          </Card>
                        ))
                      )}
                    </div>
                    
                    {/* Desktop table view for lines */}
                    <Table className="hidden md:table">
                      <TableHeader>
                        <TableRow>
                          <TableHead>SKU</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead>Expected</TableHead>
                          <TableHead>Received</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead>Status</TableHead>
                          {selectedReceipt.status !== "closed" && <TableHead>Issues</TableHead>}
                          {selectedReceipt.status !== "closed" && <TableHead></TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedLines.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                              No lines yet. Import CSV or add lines manually.
                            </TableCell>
                          </TableRow>
                        ) : (
                          sortedLines.map((line) => (
                            <TableRow key={line.id}>
                              <TableCell className="font-mono whitespace-nowrap">{line.sku || "-"}</TableCell>
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
                                    className="w-20 h-10"
                                    min={0}
                                    autoComplete="off"
                                  />
                                ) : (
                                  line.receivedQty
                                )}
                              </TableCell>
                              <TableCell>
                                {selectedReceipt.status === "closed" ? (
                                  <span className="text-sm text-muted-foreground">
                                    {line.putawayLocationId 
                                      ? locations.find(l => l.id === line.putawayLocationId)?.code || "Set"
                                      : "Via CSV"
                                    }
                                  </span>
                                ) : (
                                  <LocationTypeahead
                                    locations={locations}
                                    value={line.putawayLocationId}
                                    onChange={(locationId) => updateLineMutation.mutate({
                                      lineId: line.id,
                                      updates: { putawayLocationId: locationId }
                                    })}
                                    disabled={false}
                                  />
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
                              {selectedReceipt.status !== "closed" && (
                                <TableCell>
                                  {(!line.productVariantId || !line.putawayLocationId) && (
                                    <div className="flex gap-1">
                                      {!line.productVariantId && (
                                        <button
                                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                                          onClick={() => openResolve(line, 'sku')}
                                          title="SKU not linked to a product variant"
                                        >
                                          <AlertTriangle className="h-3 w-3" /> SKU
                                        </button>
                                      )}
                                      {!line.putawayLocationId && (
                                        <button
                                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100"
                                          onClick={() => openResolve(line, 'location')}
                                          title="Location not set"
                                        >
                                          <AlertTriangle className="h-3 w-3" /> Loc
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </TableCell>
                              )}
                              {selectedReceipt.status !== "closed" && (
                                <TableCell>
                                  {line.status !== "complete" ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="min-h-[44px]"
                                      onClick={() => updateLineMutation.mutate({
                                        lineId: line.id,
                                        updates: {
                                          receivedQty: line.expectedQty || 0,
                                          status: "complete"
                                        }
                                      })}
                                      disabled={updateLineMutation.isPending}
                                      data-testid={`btn-complete-line-${line.id}`}
                                    >
                                      <Check className="h-4 w-4" />
                                    </Button>
                                  ) : (!line.productVariantId || !line.putawayLocationId) ? (
                                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                                  ) : (
                                    <Check className="h-4 w-4 text-green-600" />
                                  )}
                                </TableCell>
                              )}
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
        <DialogContent className="max-w-md md:max-w-2xl max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Import from CSV</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              Paste CSV data with columns: sku, qty, location (optional)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <details className="group">
              <summary className="text-sm font-medium cursor-pointer list-none flex items-center gap-2">
                <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                View Example Format
              </summary>
              <div className="bg-muted p-3 rounded text-xs md:text-sm font-mono mt-2">
                sku,qty,location<br/>
                PROD-001,100,A-01<br/>
                PROD-002,50,B-02
              </div>
            </details>
            
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="flex items-center justify-center gap-2 border-2 border-dashed rounded-lg p-4 cursor-pointer hover:border-primary transition-colors active:bg-accent/50 min-h-[60px]">
                  <Upload className="h-5 w-5 text-muted-foreground" />
                  <span className="text-xs md:text-sm text-muted-foreground">Choose CSV file or drag & drop</span>
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
              className="min-h-[150px] md:min-h-[200px] font-mono text-xs md:text-sm"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-testid="textarea-csv"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" className="min-h-[44px]" onClick={() => setShowCSVImport(false)}>Cancel</Button>
              <Button 
                className="min-h-[44px]"
                onClick={handleCSVImport}
                disabled={bulkImportMutation.isPending || !csvText.trim()}
                data-testid="btn-import"
              >
                <Upload className="h-4 w-4 mr-2" />
                Import
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Line Dialog */}
      <Dialog open={showAddLineDialog} onOpenChange={setShowAddLineDialog}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Add Line</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              Add a product line to this receiving order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-sm">SKU</Label>
              <div className="relative">
                <Input
                  className="h-11"
                  value={skuSearch}
                  onChange={(e) => handleSkuSearch(e.target.value)}
                  onFocus={() => skuResults.length > 0 && setShowSkuDropdown(true)}
                  onBlur={() => setTimeout(() => setShowSkuDropdown(false), 200)}
                  placeholder="Search by SKU or product name..."
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-add-line-sku"
                />
                {showSkuDropdown && skuResults.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {skuResults.map((item) => (
                      <button
                        key={item.productVariantId}
                        type="button"
                        className="w-full px-3 py-3 text-left hover:bg-gray-100 active:bg-gray-200 text-sm min-h-[44px]"
                        onClick={() => {
                          setNewLine({
                            ...newLine,
                            sku: item.sku,
                            productName: item.name,
                            productId: item.productId,
                            productVariantId: item.productVariantId,
                          });
                          setSkuSearch(item.sku);
                          setShowSkuDropdown(false);
                        }}
                        data-testid={`sku-option-${item.sku}`}
                      >
                        <div className="font-mono text-sm">{item.sku}</div>
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
              <Label className="text-sm">{selectedReceipt?.sourceType === "blind" ? "Quantity" : "Expected Qty"}</Label>
              <Input
                className="h-11"
                type="number"
                inputMode="numeric"
                value={newLine.expectedQty}
                onChange={(e) => setNewLine({ ...newLine, expectedQty: e.target.value })}
                min="1"
                autoComplete="off"
                data-testid="input-add-line-expected"
              />
              {selectedReceipt?.sourceType === "blind" && (
                <div className="text-xs text-muted-foreground">
                  For initial inventory loads, this is the quantity you're adding to inventory.
                </div>
              )}
            </div>

            <details className="group">
              <summary className="text-sm font-medium cursor-pointer list-none flex items-center gap-2">
                <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                Put-away Location (optional)
              </summary>
              <div className="space-y-2 mt-3">
                <div className="relative">
                  <Input
                    className="h-11"
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
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-add-line-location"
                  />
                  {showLocationDropdown && locationResults.length > 0 && (
                    <div className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
                      {locationResults.map((loc) => (
                        <button
                          key={loc.id}
                          type="button"
                          className="w-full px-3 py-3 text-left hover:bg-gray-100 active:bg-gray-200 text-sm min-h-[44px]"
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
            </details>

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" className="min-h-[44px]" onClick={() => {
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
                  productId: null,
                  productVariantId: null,
                });
              }}>
                Cancel
              </Button>
              <Button 
                className="min-h-[44px]"
                onClick={() => {
                  if (!selectedReceipt || !newLine.sku) return;
                  const qty = parseInt(newLine.expectedQty) || 1;
                  const isBlind = selectedReceipt.sourceType === "blind";
                  addLineMutation.mutate({
                    orderId: selectedReceipt.id,
                    line: {
                      sku: newLine.sku,
                      productName: newLine.productName,
                      expectedQty: qty,
                      receivedQty: isBlind ? qty : 0,
                      status: isBlind ? "complete" : "pending",
                      putawayLocationId: newLine.putawayLocationId ? parseInt(newLine.putawayLocationId) : null,
                      productId: newLine.productId,
                      productVariantId: newLine.productVariantId,
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

      {/* Import Results Dialog - Persistent error/warning log */}
      <Dialog open={showImportResults} onOpenChange={setShowImportResults}>
        <DialogContent className="max-w-md md:max-w-2xl max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base md:text-lg">
              {importResults?.errors?.length ? (
                <XCircle className="h-5 w-5 text-red-500" />
              ) : (
                <AlertTriangle className="h-5 w-5 text-yellow-500" />
              )}
              Import Results
            </DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              {importResults?.created || 0} lines created, {importResults?.updated || 0} lines updated
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2 max-h-[50vh] overflow-y-auto">
            {importResults?.errors && importResults.errors.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-medium text-red-600 flex items-center gap-1 text-sm">
                  <XCircle className="h-4 w-4" />
                  Errors ({importResults.errors.length})
                </h4>
                <div className="bg-red-50 border border-red-200 rounded-md p-2 md:p-3 space-y-1 text-xs md:text-sm">
                  {importResults.errors.map((err, i) => (
                    <div key={i} className="text-red-700">{err}</div>
                  ))}
                </div>
              </div>
            )}
            {importResults?.warnings && importResults.warnings.length > 0 && (
              <div className="space-y-2">
                <h4 className="font-medium text-yellow-600 flex items-center gap-1 text-sm">
                  <AlertTriangle className="h-4 w-4" />
                  Warnings ({importResults.warnings.length})
                </h4>
                <div className="bg-yellow-50 border border-yellow-200 rounded-md p-2 md:p-3 space-y-1 text-xs md:text-sm">
                  {importResults.warnings.map((warn, i) => (
                    <div key={i} className="text-yellow-700">{warn}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-col sm:flex-row justify-between gap-2 pt-2">
            <Button
              variant="outline"
              className="min-h-[44px] text-sm"
              onClick={() => {
                const allIssues = [
                  ...(importResults?.errors || []).map(e => `ERROR: ${e}`),
                  ...(importResults?.warnings || []).map(w => `WARNING: ${w}`),
                ];
                const blob = new Blob([allIssues.join('\n')], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `import-issues-${new Date().toISOString().split('T')[0]}.txt`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              data-testid="btn-download-issues"
            >
              <Download className="h-4 w-4 mr-2" />
              Download Log
            </Button>
            <Button className="min-h-[44px]" onClick={() => setShowImportResults(false)} data-testid="btn-close-results">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Line Resolution Dialog */}
      <Dialog open={showResolveDialog} onOpenChange={setShowResolveDialog}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              {resolveMode === 'sku' ? 'Resolve SKU' : 'Resolve Location'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {resolvingLine && (
                <>Line: <span className="font-mono">{resolvingLine.sku}</span> (Qty: {resolvingLine.receivedQty})</>
              )}
            </DialogDescription>
          </DialogHeader>

          {resolveMode === 'sku' && resolvingLine && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                CSV SKU: <span className="font-mono font-medium">{resolvingLine.sku}</span>
              </div>

              {/* Option 1: Search existing variants */}
              <div>
                <Label className="text-xs font-medium text-muted-foreground mb-1 block">Link to existing variant</Label>
                <Input
                  placeholder="Search product variants..."
                  value={resolveSkuSearch}
                  onChange={(e) => handleResolveSkuSearch(e.target.value)}
                  className="h-10"
                  autoFocus
                />
                <ScrollArea className="h-32 mt-1">
                  {resolveSkuResults.map((r: any) => (
                    <button
                      key={r.productVariantId}
                      className="w-full text-left px-3 py-2 text-sm rounded hover:bg-accent border-b last:border-0"
                      onClick={() => {
                        updateLineMutation.mutate({
                          lineId: resolvingLine.id,
                          updates: { productVariantId: r.productVariantId }
                        });
                        setShowResolveDialog(false);
                        toast({ title: "SKU linked", description: `${resolvingLine.sku} → ${r.sku}` });
                      }}
                    >
                      <div className="font-mono font-medium">{r.sku}</div>
                      <div className="text-xs text-muted-foreground truncate">{r.name}</div>
                    </button>
                  ))}
                  {resolveSkuResults.length === 0 && resolveSkuSearch.length >= 2 && (
                    <div className="text-center text-sm text-muted-foreground py-3">No existing variants found</div>
                  )}
                </ScrollArea>
              </div>

              {/* Option 2: Create new variant from SKU pattern */}
              {(() => {
                const parsed = parseSku(resolvingLine.sku);
                if (!parsed) return null;
                return (
                  <div className="border-t pt-3">
                    <Label className="text-xs font-medium text-muted-foreground mb-2 block">Or create new variant</Label>
                    <div className="bg-muted/50 border rounded-lg p-3 space-y-2">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                        <span className="text-muted-foreground">Product:</span>
                        <span className="font-mono font-medium">{parsed.baseSku}</span>
                        <span className="text-muted-foreground">Variant:</span>
                        <span className="font-medium">{parsed.typeName} of {parsed.units}</span>
                        <span className="text-muted-foreground">SKU:</span>
                        <span className="font-mono font-medium">{resolvingLine.sku?.toUpperCase()}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Creates the product (if it doesn't exist) and variant, then links it to this line.
                      </p>
                      <Button
                        className="w-full min-h-[44px]"
                        onClick={() => createVariantMutation.mutate(resolvingLine.id)}
                        disabled={createVariantMutation.isPending}
                      >
                        {createVariantMutation.isPending ? (
                          <><span className="animate-spin mr-2">⏳</span> Creating...</>
                        ) : (
                          <><Plus className="h-4 w-4 mr-2" /> Create & Link Variant</>
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })()}

              <div className="flex justify-end pt-1">
                <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => setShowResolveDialog(false)}>
                  Skip
                </Button>
              </div>
            </div>
          )}

          {resolveMode === 'location' && resolvingLine && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                {resolvingLine.notes?.includes('CSV location:') ? (
                  <>CSV location: <span className="font-mono font-medium">{resolvingLine.notes.match(/CSV location: (.+?)(?:\s*\||$)/)?.[1] || '—'}</span></>
                ) : (
                  <>No CSV location recorded</>
                )}
              </div>
              <Input
                placeholder="Search locations..."
                value={resolveLocSearch}
                onChange={(e) => setResolveLocSearch(e.target.value)}
                className="h-10"
                autoFocus
              />
              <ScrollArea className="h-48">
                {locations
                  .filter(loc => !resolveLocSearch || loc.code.toLowerCase().includes(resolveLocSearch.toLowerCase()) || (loc.name && loc.name.toLowerCase().includes(resolveLocSearch.toLowerCase())))
                  .slice(0, 15)
                  .map(loc => (
                    <button
                      key={loc.id}
                      className="w-full text-left px-3 py-2 text-sm rounded hover:bg-accent border-b last:border-0"
                      onClick={() => {
                        updateLineMutation.mutate({
                          lineId: resolvingLine.id,
                          updates: { putawayLocationId: loc.id }
                        });
                        setShowResolveDialog(false);
                        toast({ title: "Location set", description: `${resolvingLine.sku} → ${loc.code}` });
                      }}
                    >
                      <div className="font-mono font-medium">{loc.code}</div>
                      {loc.name && <div className="text-xs text-muted-foreground">{loc.name}</div>}
                    </button>
                  ))}
              </ScrollArea>
              <div className="flex justify-end pt-2">
                <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => setShowResolveDialog(false)}>
                  Skip
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Pre-Close Validation Dialog removed — server now auto-resolves SKU→variant
          and returns 400 with structured issues if lines can't be processed */}
    </div>
  );
}
