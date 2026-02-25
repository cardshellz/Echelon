import { useState, useRef } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";
import Papa from "papaparse";
import {
  ArrowLeft,
  Ship,
  Truck,
  Plane,
  Package,
  Plus,
  Trash2,
  ChevronsUpDown,
  Check,
  AlertTriangle,
  Ban,
  Clock,
  DollarSign,
  Upload,
  RefreshCw,
  Pencil,
  Anchor,
  MapPin,
  Calendar,
  FileText,
  CheckCircle,
  XCircle,
  BarChart3,
} from "lucide-react";

// ── Status badges ──

const STATUS_BADGES: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string; color?: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  booked: { variant: "outline", label: "Booked", color: "text-blue-600 border-blue-300" },
  in_transit: { variant: "default", label: "In Transit", color: "bg-blue-500" },
  at_port: { variant: "default", label: "At Port", color: "bg-indigo-500" },
  customs_clearance: { variant: "outline", label: "Customs Clearance", color: "text-amber-600 border-amber-300" },
  delivered: { variant: "default", label: "Delivered", color: "bg-green-600" },
  costing: { variant: "outline", label: "Costing", color: "text-purple-600 border-purple-300" },
  closed: { variant: "secondary", label: "Closed" },
  cancelled: { variant: "destructive", label: "Cancelled" },
};

const MODE_BADGES: Record<string, { label: string; icon: React.ReactNode }> = {
  ocean: { label: "Ocean", icon: <Ship className="h-3 w-3" /> },
  air: { label: "Air", icon: <Plane className="h-3 w-3" /> },
  truck: { label: "Truck", icon: <Truck className="h-3 w-3" /> },
  rail: { label: "Rail", icon: <Package className="h-3 w-3" /> },
  courier: { label: "Courier", icon: <Package className="h-3 w-3" /> },
};

const COST_TYPE_OPTIONS = [
  { value: "freight", label: "Freight" },
  { value: "duty", label: "Duty" },
  { value: "insurance", label: "Insurance" },
  { value: "brokerage", label: "Brokerage" },
  { value: "port_handling", label: "Port Handling" },
  { value: "drayage", label: "Drayage" },
  { value: "warehousing", label: "Warehousing" },
  { value: "inspection", label: "Inspection" },
  { value: "other", label: "Other" },
];

const ALLOCATION_METHOD_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "by_volume", label: "By Volume" },
  { value: "by_weight", label: "By Weight" },
  { value: "by_chargeable_weight", label: "By Chargeable Weight" },
  { value: "by_value", label: "By Value" },
  { value: "by_line_count", label: "By Line Count" },
];

const COST_STATUS_OPTIONS = [
  { value: "estimated", label: "Estimated" },
  { value: "quoted", label: "Quoted" },
  { value: "invoiced", label: "Invoiced" },
  { value: "paid", label: "Paid" },
];

// ── Helpers ──

function formatCents(cents: number | null | undefined, opts?: { unitCost?: boolean }): string {
  if (!cents && cents !== 0) return "$0.00";
  const n = Number(cents) / 100;
  if (opts?.unitCost && n > 0 && n < 0.01) {
    return `$${parseFloat(n.toFixed(4)).toString()}`;
  }
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(val: string | number | null | undefined, decimals = 2): string {
  if (val === null || val === undefined || val === "") return "—";
  return Number(val).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatDate(val: string | Date | null | undefined): string {
  if (!val) return "—";
  return format(new Date(val), "MMM d, yyyy");
}

// ── Component ──

export default function InboundShipmentDetail() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/shipments/:id");
  const shipmentId = params?.id ? Number(params.id) : null;

  const [activeTab, setActiveTab] = useState("lines");

  // Dialog states
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showAddFromPoDialog, setShowAddFromPoDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showAddCostDialog, setShowAddCostDialog] = useState(false);
  const [showEditCostDialog, setShowEditCostDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  // Inline editing state for lines
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  const [editingLineData, setEditingLineData] = useState<any>({});

  // Edit shipment form
  const [editForm, setEditForm] = useState<any>({});

  // Add from PO state
  const [poSearch, setPoSearch] = useState("");
  const [poOpen, setPoOpen] = useState(false);
  const [selectedPoId, setSelectedPoId] = useState<number | null>(null);
  const [selectedPoLineIds, setSelectedPoLineIds] = useState<number[]>([]);

  // Import packing list state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importParsed, setImportParsed] = useState<any[]>([]);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importMapping, setImportMapping] = useState<Record<string, string>>({});
  const [importStep, setImportStep] = useState<"upload" | "map" | "preview">("upload");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Add cost form
  const [newCost, setNewCost] = useState({
    costType: "freight",
    description: "",
    estimatedCents: 0,
    actualCents: 0,
    allocationMethod: "default",
    costStatus: "estimated",
    invoiceNumber: "",
    vendorName: "",
  });

  // Edit cost form
  const [editingCost, setEditingCost] = useState<any>(null);

  // ── Queries ──

  const { data: shipment, isLoading } = useQuery<any>({
    queryKey: [`/api/inbound-shipments/${shipmentId}`],
    enabled: !!shipmentId,
  });

  const { data: posData } = useQuery<any>({
    queryKey: ["/api/purchase-orders?limit=200"],
    enabled: showAddFromPoDialog,
  });

  const { data: selectedPo } = useQuery<any>({
    queryKey: [`/api/purchase-orders/${selectedPoId}`],
    enabled: !!selectedPoId,
  });

  const { data: allocationData } = useQuery<any>({
    queryKey: [`/api/inbound-shipments/${shipmentId}/allocation`],
    enabled: !!shipmentId && activeTab === "allocation",
    // Allocation is computed on-demand, use the lines data from the main query
    queryFn: async () => {
      // Return the lines from the main shipment query with their allocation data
      return { lines: shipment?.lines ?? [] };
    },
  });

  const lines = shipment?.lines ?? [];
  const costs = shipment?.costs ?? [];
  const statusHistory = shipment?.statusHistory ?? [];
  const purchaseOrders = posData?.pos ?? posData?.purchaseOrders ?? [];
  const poLines = selectedPo?.lines ?? [];

  const isEditable = !["closed", "cancelled"].includes(shipment?.status || "");
  const isPreClosed = !["closed", "cancelled"].includes(shipment?.status || "");

  // Container utilization
  const containerCapacityCbm = Number(shipment?.containerCapacityCbm || 0);
  const totalGrossVolumeCbm = Number(shipment?.totalGrossVolumeCbm || 0);
  const utilization = containerCapacityCbm > 0 ? (totalGrossVolumeCbm / containerCapacityCbm * 100) : null;

  // ── Filtered POs for typeahead ──
  const filteredPOs = (Array.isArray(purchaseOrders) ? purchaseOrders : [])
    .filter((po: any) =>
      !poSearch || po.poNumber?.toLowerCase().includes(poSearch.toLowerCase())
    )
    .slice(0, 50);

  // ── Mutations ──

  function createTransitionMutation(endpoint: string) {
    return useMutation({
      mutationFn: async (body: any = {}) => {
        const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/${endpoint}`, body || undefined);
        return res.json();
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
        queryClient.invalidateQueries({ queryKey: ["/api/inbound-shipments"] });
        toast({ title: "Success", description: `Shipment ${endpoint.replace(/-/g, " ")} completed` });
      },
      onError: (err: Error) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      },
    });
  }

  const bookMutation = createTransitionMutation("book");
  const inTransitMutation = createTransitionMutation("in-transit");
  const atPortMutation = createTransitionMutation("at-port");
  const customsClearanceMutation = createTransitionMutation("customs-clearance");
  const deliveredMutation = createTransitionMutation("delivered");
  const startCostingMutation = createTransitionMutation("start-costing");
  const closeMutation = createTransitionMutation("close");

  const cancelMutation = useMutation({
    mutationFn: async (reason: string) => {
      const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/cancel`, { reason });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/inbound-shipments"] });
      setShowCancelDialog(false);
      setCancelReason("");
      toast({ title: "Cancelled", description: "Shipment cancelled" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateShipmentMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PATCH", `/api/inbound-shipments/${shipmentId}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/inbound-shipments"] });
      setShowEditDialog(false);
      toast({ title: "Updated", description: "Shipment details updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Line mutations
  const addFromPoMutation = useMutation({
    mutationFn: async (data: { purchaseOrderId: number; lineIds: number[] }) => {
      const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/lines/from-po`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      setShowAddFromPoDialog(false);
      setSelectedPoId(null);
      setSelectedPoLineIds([]);
      setPoSearch("");
      toast({ title: "Lines added", description: "PO lines added to shipment" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const importPackingListMutation = useMutation({
    mutationFn: async (rows: any[]) => {
      const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/lines/import-packing-list`, { rows });
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      setShowImportDialog(false);
      resetImportState();
      toast({ title: "Import complete", description: `${result.imported ?? "Lines"} imported successfully` });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const resolveDimensionsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/lines/resolve-dimensions`);
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      toast({ title: "Dimensions resolved", description: `${result.resolved ?? "Lines"} updated from product data` });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateLineMutation = useMutation({
    mutationFn: async ({ lineId, data }: { lineId: number; data: any }) => {
      const res = await apiRequest("PATCH", `/api/inbound-shipments/lines/${lineId}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      setEditingLineId(null);
      setEditingLineData({});
      toast({ title: "Line updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteLineMutation = useMutation({
    mutationFn: async (lineId: number) => {
      const res = await apiRequest("DELETE", `/api/inbound-shipments/lines/${lineId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      toast({ title: "Line removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Cost mutations
  const addCostMutation = useMutation({
    mutationFn: async (data: any) => {
      const payload = {
        ...data,
        allocationMethod: data.allocationMethod === "default" ? null : data.allocationMethod,
      };
      const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/costs`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      setShowAddCostDialog(false);
      setNewCost({ costType: "freight", description: "", estimatedCents: 0, actualCents: 0, allocationMethod: "default", costStatus: "estimated", invoiceNumber: "", vendorName: "" });
      toast({ title: "Cost added" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateCostMutation = useMutation({
    mutationFn: async ({ costId, data }: { costId: number; data: any }) => {
      const payload = {
        ...data,
        allocationMethod: data.allocationMethod === "default" ? null : data.allocationMethod,
      };
      const res = await apiRequest("PATCH", `/api/inbound-shipments/costs/${costId}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      setShowEditCostDialog(false);
      setEditingCost(null);
      toast({ title: "Cost updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteCostMutation = useMutation({
    mutationFn: async (costId: number) => {
      const res = await apiRequest("DELETE", `/api/inbound-shipments/costs/${costId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      toast({ title: "Cost removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Allocation mutations
  const runAllocationMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/allocate`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      toast({ title: "Allocation complete", description: "Costs allocated to shipment lines" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/finalize`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
      toast({ title: "Finalized", description: "Landed costs finalized and snapshotted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ── Import helpers ──

  function resetImportState() {
    setImportFile(null);
    setImportParsed([]);
    setImportHeaders([]);
    setImportMapping({});
    setImportStep("upload");
  }

  function handleFileSelect(file: File) {
    setImportFile(file);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        if (result.data.length === 0) {
          toast({ title: "Empty file", description: "No rows found in CSV", variant: "destructive" });
          return;
        }
        const headers = result.meta.fields || [];
        setImportHeaders(headers);
        setImportParsed(result.data as any[]);
        // Auto-map common column names
        const autoMap: Record<string, string> = {};
        const mappableFields = ["sku", "qty_shipped", "weight_kg", "length_cm", "width_cm", "height_cm", "gross_volume_cbm", "carton_count", "pallet_count"];
        for (const field of mappableFields) {
          const match = headers.find((h: string) =>
            h.toLowerCase().replace(/[\s\-]/g, "_") === field ||
            h.toLowerCase().replace(/[\s\-]/g, "_").includes(field.replace(/_/g, ""))
          );
          if (match) autoMap[field] = match;
        }
        setImportMapping(autoMap);
        setImportStep("map");
      },
      error: (err) => {
        toast({ title: "Parse error", description: err.message, variant: "destructive" });
      },
    });
  }

  function buildImportRows(): any[] {
    return importParsed.map((row) => {
      const mapped: any = {};
      for (const [field, header] of Object.entries(importMapping)) {
        if (header && row[header] !== undefined) {
          mapped[field] = row[header];
        }
      }
      return mapped;
    });
  }

  // ── Loading / Not Found ──

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!shipment) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Shipment not found.</p>
        <Button variant="link" onClick={() => navigate("/shipments")}>Back to list</Button>
      </div>
    );
  }

  // ── Render ──

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* ═══════ Header ═══════ */}
      <div className="flex flex-col sm:flex-row items-start gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/shipments")} className="min-h-[44px]">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl md:text-2xl font-bold font-mono">{shipment.shipmentNumber}</h1>
            <Badge
              variant={STATUS_BADGES[shipment.status]?.variant || "secondary"}
              className={`text-sm ${STATUS_BADGES[shipment.status]?.color || ""}`}
            >
              {STATUS_BADGES[shipment.status]?.label || shipment.status}
            </Badge>
            {shipment.mode && MODE_BADGES[shipment.mode] && (
              <Badge variant="outline" className="text-sm gap-1">
                {MODE_BADGES[shipment.mode].icon}
                {MODE_BADGES[shipment.mode].label}
              </Badge>
            )}
          </div>

          {/* Carrier / Container / BOL */}
          <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground flex-wrap">
            {shipment.carrierName && <span>{shipment.carrierName}</span>}
            {shipment.containerNumber && (
              <span className="flex items-center gap-1">
                <Package className="h-3 w-3" />
                {shipment.containerNumber}
                {shipment.containerSize && ` (${shipment.containerSize})`}
              </span>
            )}
            {shipment.bolNumber && (
              <span className="flex items-center gap-1">
                <FileText className="h-3 w-3" />
                BOL: {shipment.bolNumber}
              </span>
            )}
          </div>

          {/* Utilization bar */}
          {utilization !== null && (
            <div className="flex items-center gap-2 mt-1 text-sm">
              <span className="text-muted-foreground">Utilization:</span>
              <div className="w-32 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${utilization > 95 ? "bg-red-500" : utilization > 80 ? "bg-amber-500" : "bg-green-500"}`}
                  style={{ width: `${Math.min(utilization, 100)}%` }}
                />
              </div>
              <span className="font-mono">{utilization.toFixed(1)}%</span>
              <span className="text-muted-foreground text-xs">
                ({formatNumber(shipment.totalGrossVolumeCbm, 2)} / {formatNumber(shipment.containerCapacityCbm, 2)} CBM)
              </span>
            </div>
          )}

          {/* Origin → Destination */}
          {(shipment.originPort || shipment.destinationPort) && (
            <div className="flex items-center gap-2 mt-1 text-sm">
              <MapPin className="h-3 w-3 text-muted-foreground" />
              <span>
                {shipment.originPort || shipment.originCountry || "Origin"}
                {" → "}
                {shipment.destinationPort || shipment.destinationCountry || "Destination"}
              </span>
            </div>
          )}

          {/* Key dates */}
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
            {shipment.etd && <span>ETD: {formatDate(shipment.etd)}</span>}
            {shipment.eta && <span>ETA: {formatDate(shipment.eta)}</span>}
            {shipment.shipDate && <span>Ship: {formatDate(shipment.shipDate)}</span>}
            {shipment.deliveredDate && <span>Delivered: {formatDate(shipment.deliveredDate)}</span>}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap w-full sm:w-auto">
          {isEditable && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditForm({
                  carrierName: shipment.carrierName || "",
                  forwarderName: shipment.forwarderName || "",
                  mode: shipment.mode || "",
                  originPort: shipment.originPort || "",
                  destinationPort: shipment.destinationPort || "",
                  originCountry: shipment.originCountry || "",
                  destinationCountry: shipment.destinationCountry || "",
                  containerNumber: shipment.containerNumber || "",
                  containerSize: shipment.containerSize || "",
                  containerCapacityCbm: shipment.containerCapacityCbm || "",
                  sealNumber: shipment.sealNumber || "",
                  bolNumber: shipment.bolNumber || "",
                  houseBol: shipment.houseBol || "",
                  bookingReference: shipment.bookingReference || "",
                  trackingNumber: shipment.trackingNumber || "",
                  etd: shipment.etd ? format(new Date(shipment.etd), "yyyy-MM-dd") : "",
                  eta: shipment.eta ? format(new Date(shipment.eta), "yyyy-MM-dd") : "",
                  notes: shipment.notes || "",
                  internalNotes: shipment.internalNotes || "",
                });
                setShowEditDialog(true);
              }}
              className="flex-1 sm:flex-none min-h-[44px]"
            >
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          )}

          {shipment.status === "draft" && (
            <Button onClick={() => bookMutation.mutate({})} disabled={bookMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Anchor className="h-4 w-4 mr-2" />
              Book
            </Button>
          )}

          {shipment.status === "booked" && (
            <Button onClick={() => inTransitMutation.mutate({})} disabled={inTransitMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Ship className="h-4 w-4 mr-2" />
              Mark In Transit
            </Button>
          )}

          {shipment.status === "in_transit" && (
            <>
              <Button onClick={() => atPortMutation.mutate({})} disabled={atPortMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
                <Anchor className="h-4 w-4 mr-2" />
                At Port
              </Button>
              <Button variant="outline" onClick={() => deliveredMutation.mutate({})} disabled={deliveredMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
                <CheckCircle className="h-4 w-4 mr-2" />
                Delivered
              </Button>
            </>
          )}

          {shipment.status === "at_port" && (
            <Button onClick={() => customsClearanceMutation.mutate({})} disabled={customsClearanceMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <FileText className="h-4 w-4 mr-2" />
              Customs Clearance
            </Button>
          )}

          {shipment.status === "customs_clearance" && (
            <Button onClick={() => deliveredMutation.mutate({})} disabled={deliveredMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <CheckCircle className="h-4 w-4 mr-2" />
              Delivered
            </Button>
          )}

          {shipment.status === "delivered" && (
            <Button onClick={() => startCostingMutation.mutate({})} disabled={startCostingMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <DollarSign className="h-4 w-4 mr-2" />
              Start Costing
            </Button>
          )}

          {shipment.status === "costing" && (
            <Button onClick={() => closeMutation.mutate({})} disabled={closeMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <CheckCircle className="h-4 w-4 mr-2" />
              Close Shipment
            </Button>
          )}

          {isPreClosed && (
            <Button
              variant="outline"
              onClick={() => setShowCancelDialog(true)}
              className="flex-1 sm:flex-none min-h-[44px] text-red-600 hover:text-red-700"
            >
              <Ban className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* ═══════ Summary Cards ═══════ */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Lines</div>
            <div className="font-mono font-medium">{lines.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Total Weight</div>
            <div className="font-mono font-medium">{formatNumber(shipment.totalWeightKg, 1)} kg</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Total Volume</div>
            <div className="font-mono font-medium">{formatNumber(shipment.totalGrossVolumeCbm || shipment.totalVolumeCbm, 3)} CBM</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Est. Cost</div>
            <div className="font-mono font-medium">{formatCents(shipment.estimatedTotalCostCents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Actual Cost</div>
            <div className="font-mono font-bold text-lg">{formatCents(shipment.actualTotalCostCents)}</div>
          </CardContent>
        </Card>
      </div>

      {/* ═══════ Tabs ═══════ */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="lines">Lines ({lines.length})</TabsTrigger>
          <TabsTrigger value="costs">Costs ({costs.length})</TabsTrigger>
          <TabsTrigger value="allocation">Allocation</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>

        {/* ══ Tab 1: Lines ══ */}
        <TabsContent value="lines" className="space-y-4">
          {isEditable && (
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" onClick={() => setShowAddFromPoDialog(true)} className="min-h-[44px]">
                <Plus className="h-4 w-4 mr-2" />
                Add from PO
              </Button>
              <Button variant="outline" onClick={() => { resetImportState(); setShowImportDialog(true); }} className="min-h-[44px]">
                <Upload className="h-4 w-4 mr-2" />
                Import Packing List
              </Button>
              <Button
                variant="outline"
                onClick={() => resolveDimensionsMutation.mutate()}
                disabled={resolveDimensionsMutation.isPending || lines.length === 0}
                className="min-h-[44px]"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${resolveDimensionsMutation.isPending ? "animate-spin" : ""}`} />
                Resolve Dimensions
              </Button>
            </div>
          )}

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {lines.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-center text-muted-foreground">
                  No lines. Add items from a PO or import a packing list.
                </CardContent>
              </Card>
            ) : (
              lines.map((line: any) => (
                <Card key={line.id}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-sm">{line.sku || "—"}</div>
                        <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                          <span>Qty: {line.qtyShipped}</span>
                          <span>{formatNumber(line.totalWeightKg, 1)} kg</span>
                          <span>{formatNumber(line.grossVolumeCbm, 4)} CBM</span>
                        </div>
                        {line.allocatedCostCents != null && (
                          <div className="text-xs mt-1">
                            Allocated: {formatCents(line.allocatedCostCents)} | Landed: {formatCents(line.landedUnitCostCents)}
                          </div>
                        )}
                      </div>
                      {isEditable && (
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
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty Shipped</TableHead>
                  <TableHead className="text-right">Weight (kg)</TableHead>
                  <TableHead className="text-right">Net Vol (CBM)</TableHead>
                  <TableHead className="text-right">Gross Vol (CBM)</TableHead>
                  <TableHead className="text-right">Cartons</TableHead>
                  <TableHead className="text-right">Pallets</TableHead>
                  <TableHead className="text-right">Allocated Cost</TableHead>
                  <TableHead className="text-right">Landed $/unit</TableHead>
                  {isEditable && <TableHead className="w-20"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={isEditable ? 11 : 10} className="text-center text-muted-foreground py-8">
                      No lines. Click "Add from PO" or "Import Packing List" to add items.
                    </TableCell>
                  </TableRow>
                ) : (
                  lines.map((line: any) => {
                    const isEditing = editingLineId === line.id;
                    return (
                      <TableRow key={line.id}>
                        <TableCell className="font-mono">{line.sku || "—"}</TableCell>
                        <TableCell className="max-w-[180px] truncate">{line.productName || "—"}</TableCell>
                        <TableCell className="text-right">{line.qtyShipped}</TableCell>
                        <TableCell className="text-right">
                          {isEditing ? (
                            <Input
                              type="number"
                              step="0.001"
                              className="w-20 h-8 text-right"
                              value={editingLineData.totalWeightKg ?? ""}
                              onChange={(e) => setEditingLineData((prev: any) => ({ ...prev, totalWeightKg: e.target.value }))}
                            />
                          ) : (
                            formatNumber(line.totalWeightKg, 1)
                          )}
                        </TableCell>
                        <TableCell className="text-right">{formatNumber(line.totalVolumeCbm, 4)}</TableCell>
                        <TableCell className="text-right">
                          {isEditing ? (
                            <Input
                              type="number"
                              step="0.0001"
                              className="w-24 h-8 text-right"
                              value={editingLineData.grossVolumeCbm ?? ""}
                              onChange={(e) => setEditingLineData((prev: any) => ({ ...prev, grossVolumeCbm: e.target.value }))}
                            />
                          ) : (
                            formatNumber(line.grossVolumeCbm, 4)
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {isEditing ? (
                            <Input
                              type="number"
                              className="w-16 h-8 text-right"
                              value={editingLineData.cartonCount ?? ""}
                              onChange={(e) => setEditingLineData((prev: any) => ({ ...prev, cartonCount: e.target.value }))}
                            />
                          ) : (
                            line.cartonCount ?? "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {isEditing ? (
                            <Input
                              type="number"
                              className="w-16 h-8 text-right"
                              value={editingLineData.palletCount ?? ""}
                              onChange={(e) => setEditingLineData((prev: any) => ({ ...prev, palletCount: e.target.value }))}
                            />
                          ) : (
                            line.palletCount ?? "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">{line.allocatedCostCents != null ? formatCents(line.allocatedCostCents) : "—"}</TableCell>
                        <TableCell className="text-right font-mono">{line.landedUnitCostCents != null ? formatCents(line.landedUnitCostCents) : "—"}</TableCell>
                        {isEditable && (
                          <TableCell>
                            <div className="flex gap-1">
                              {isEditing ? (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      const data: any = {};
                                      if (editingLineData.totalWeightKg !== undefined) data.totalWeightKg = editingLineData.totalWeightKg;
                                      if (editingLineData.grossVolumeCbm !== undefined) data.grossVolumeCbm = editingLineData.grossVolumeCbm;
                                      if (editingLineData.cartonCount !== undefined) data.cartonCount = editingLineData.cartonCount ? Number(editingLineData.cartonCount) : null;
                                      if (editingLineData.palletCount !== undefined) data.palletCount = editingLineData.palletCount ? Number(editingLineData.palletCount) : null;
                                      updateLineMutation.mutate({ lineId: line.id, data });
                                    }}
                                    disabled={updateLineMutation.isPending}
                                  >
                                    <Check className="h-4 w-4 text-green-600" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => { setEditingLineId(null); setEditingLineData({}); }}
                                  >
                                    <XCircle className="h-4 w-4 text-muted-foreground" />
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      setEditingLineId(line.id);
                                      setEditingLineData({
                                        totalWeightKg: line.totalWeightKg ?? "",
                                        grossVolumeCbm: line.grossVolumeCbm ?? "",
                                        cartonCount: line.cartonCount ?? "",
                                        palletCount: line.palletCount ?? "",
                                      });
                                    }}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => { if (confirm("Remove this line?")) deleteLineMutation.mutate(line.id); }}
                                    disabled={deleteLineMutation.isPending}
                                  >
                                    <Trash2 className="h-4 w-4 text-red-500" />
                                  </Button>
                                </>
                              )}
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ══ Tab 2: Costs ══ */}
        <TabsContent value="costs" className="space-y-4">
          {isEditable && (
            <Button variant="outline" onClick={() => setShowAddCostDialog(true)} className="min-h-[44px]">
              <Plus className="h-4 w-4 mr-2" />
              Add Cost
            </Button>
          )}

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {costs.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-center text-muted-foreground">
                  No costs recorded yet.
                </CardContent>
              </Card>
            ) : (
              <>
                {costs.map((cost: any) => (
                  <Card key={cost.id}>
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-xs capitalize">{cost.costType.replace(/_/g, " ")}</Badge>
                            <Badge variant="outline" className="text-xs">{cost.costStatus}</Badge>
                          </div>
                          {cost.description && <div className="text-sm mt-1 truncate">{cost.description}</div>}
                          <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                            <span>Est: {formatCents(cost.estimatedCents)}</span>
                            <span>Actual: {formatCents(cost.actualCents)}</span>
                          </div>
                          {cost.vendorName && <div className="text-xs text-muted-foreground mt-0.5">{cost.vendorName}</div>}
                        </div>
                        {isEditable && (
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-[44px] min-w-[44px] p-0"
                              onClick={() => {
                                setEditingCost({
                                  id: cost.id,
                                  costType: cost.costType,
                                  description: cost.description || "",
                                  estimatedCents: cost.estimatedCents || 0,
                                  actualCents: cost.actualCents || 0,
                                  allocationMethod: cost.allocationMethod || "default",
                                  costStatus: cost.costStatus || "estimated",
                                  invoiceNumber: cost.invoiceNumber || "",
                                  vendorName: cost.vendorName || "",
                                });
                                setShowEditCostDialog(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-[44px] min-w-[44px] p-0"
                              onClick={() => { if (confirm("Remove this cost?")) deleteCostMutation.mutate(cost.id); }}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {/* Mobile totals */}
                <Card>
                  <CardContent className="p-3">
                    <div className="flex justify-between text-sm font-medium">
                      <span>Total Estimated</span>
                      <span className="font-mono">{formatCents(costs.reduce((sum: number, c: any) => sum + (c.estimatedCents || 0), 0))}</span>
                    </div>
                    <div className="flex justify-between text-sm font-medium mt-1">
                      <span>Total Actual</span>
                      <span className="font-mono">{formatCents(costs.reduce((sum: number, c: any) => sum + (c.actualCents || 0), 0))}</span>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </div>

          {/* Desktop table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Estimated</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Vendor</TableHead>
                  {isEditable && <TableHead className="w-20"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {costs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={isEditable ? 9 : 8} className="text-center text-muted-foreground py-8">
                      No costs recorded yet. Click "Add Cost" to add shipment costs.
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {costs.map((cost: any) => (
                      <TableRow key={cost.id}>
                        <TableCell>
                          <Badge variant="outline" className="text-xs capitalize">{cost.costType.replace(/_/g, " ")}</Badge>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate">{cost.description || "—"}</TableCell>
                        <TableCell className="text-right font-mono">{formatCents(cost.estimatedCents)}</TableCell>
                        <TableCell className="text-right font-mono">{formatCents(cost.actualCents)}</TableCell>
                        <TableCell className="text-xs">{cost.allocationMethod?.replace(/_/g, " ") || "default"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs capitalize">{cost.costStatus}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{cost.invoiceNumber || "—"}</TableCell>
                        <TableCell className="text-sm">{cost.vendorName || "—"}</TableCell>
                        {isEditable && (
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setEditingCost({
                                    id: cost.id,
                                    costType: cost.costType,
                                    description: cost.description || "",
                                    estimatedCents: cost.estimatedCents || 0,
                                    actualCents: cost.actualCents || 0,
                                    allocationMethod: cost.allocationMethod || "default",
                                    costStatus: cost.costStatus || "estimated",
                                    invoiceNumber: cost.invoiceNumber || "",
                                    vendorName: cost.vendorName || "",
                                  });
                                  setShowEditCostDialog(true);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => { if (confirm("Remove this cost?")) deleteCostMutation.mutate(cost.id); }}
                                disabled={deleteCostMutation.isPending}
                              >
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                    {/* Summary row */}
                    <TableRow className="bg-muted/50 font-medium">
                      <TableCell colSpan={2} className="text-right">Totals</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCents(costs.reduce((sum: number, c: any) => sum + (c.estimatedCents || 0), 0))}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCents(costs.reduce((sum: number, c: any) => sum + (c.actualCents || 0), 0))}
                      </TableCell>
                      <TableCell colSpan={isEditable ? 5 : 4} />
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ══ Tab 3: Allocation ══ */}
        <TabsContent value="allocation" className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => runAllocationMutation.mutate()}
              disabled={runAllocationMutation.isPending || lines.length === 0}
              className="min-h-[44px]"
            >
              <BarChart3 className={`h-4 w-4 mr-2 ${runAllocationMutation.isPending ? "animate-spin" : ""}`} />
              {runAllocationMutation.isPending ? "Allocating..." : "Run Allocation"}
            </Button>
            {shipment.status === "costing" && (
              <Button
                onClick={() => finalizeMutation.mutate()}
                disabled={finalizeMutation.isPending}
                className="min-h-[44px]"
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                {finalizeMutation.isPending ? "Finalizing..." : "Finalize"}
              </Button>
            )}
          </div>

          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">PO $/unit</TableHead>
                  <TableHead className="text-right">Freight</TableHead>
                  <TableHead className="text-right">Duty</TableHead>
                  <TableHead className="text-right">Insurance</TableHead>
                  <TableHead className="text-right">Other</TableHead>
                  <TableHead className="text-right">Total Allocated</TableHead>
                  <TableHead className="text-right">Landed $/unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                      No lines to show allocation for. Add shipment lines first.
                    </TableCell>
                  </TableRow>
                ) : (
                  lines.map((line: any) => (
                    <TableRow key={line.id}>
                      <TableCell className="font-mono">{line.sku || "—"}</TableCell>
                      <TableCell className="text-right font-mono">{line.poUnitCostCents != null ? formatCents(line.poUnitCostCents) : "—"}</TableCell>
                      <TableCell className="text-right font-mono">{line.freightAllocatedCents != null ? formatCents(line.freightAllocatedCents) : "—"}</TableCell>
                      <TableCell className="text-right font-mono">{line.dutyAllocatedCents != null ? formatCents(line.dutyAllocatedCents) : "—"}</TableCell>
                      <TableCell className="text-right font-mono">{line.insuranceAllocatedCents != null ? formatCents(line.insuranceAllocatedCents) : "—"}</TableCell>
                      <TableCell className="text-right font-mono">{line.otherAllocatedCents != null ? formatCents(line.otherAllocatedCents) : "—"}</TableCell>
                      <TableCell className="text-right font-mono font-medium">{line.allocatedCostCents != null ? formatCents(line.allocatedCostCents) : "—"}</TableCell>
                      <TableCell className="text-right font-mono font-medium">{line.landedUnitCostCents != null ? formatCents(line.landedUnitCostCents) : "—"}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ══ Tab 4: Timeline ══ */}
        <TabsContent value="timeline" className="space-y-4">
          {statusHistory.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-center text-muted-foreground">
                No status history.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {[...statusHistory].reverse().map((h: any, i: number) => (
                <Card key={h.id || i}>
                  <CardContent className="p-3 flex items-start gap-3">
                    <div className="mt-1">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {h.fromStatus && (
                          <>
                            <Badge variant="outline" className="text-xs">
                              {STATUS_BADGES[h.fromStatus]?.label || h.fromStatus}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{"\u2192"}</span>
                          </>
                        )}
                        <Badge
                          variant={STATUS_BADGES[h.toStatus]?.variant || "secondary"}
                          className={`text-xs ${STATUS_BADGES[h.toStatus]?.color || ""}`}
                        >
                          {STATUS_BADGES[h.toStatus]?.label || h.toStatus}
                        </Badge>
                      </div>
                      {h.notes && <p className="text-sm mt-1">{h.notes}</p>}
                      <p className="text-xs text-muted-foreground mt-1">
                        {h.changedAt ? format(new Date(h.changedAt), "MMM d, yyyy h:mm a") : ""}
                        {h.changedBy && ` \u2022 ${h.changedBy}`}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ═══════ Edit Shipment Dialog ═══════ */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Shipment Details</DialogTitle>
            <DialogDescription>Update shipment information.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Carrier</Label>
                <Input
                  value={editForm.carrierName}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, carrierName: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Forwarder</Label>
                <Input
                  value={editForm.forwarderName}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, forwarderName: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Mode</Label>
                <Select value={editForm.mode || ""} onValueChange={(v) => setEditForm((prev: any) => ({ ...prev, mode: v }))}>
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder="Select mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ocean">Ocean</SelectItem>
                    <SelectItem value="air">Air</SelectItem>
                    <SelectItem value="truck">Truck</SelectItem>
                    <SelectItem value="rail">Rail</SelectItem>
                    <SelectItem value="courier">Courier</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Booking Reference</Label>
                <Input
                  value={editForm.bookingReference}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, bookingReference: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Origin Port</Label>
                <Input
                  value={editForm.originPort}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, originPort: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Destination Port</Label>
                <Input
                  value={editForm.destinationPort}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, destinationPort: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Origin Country</Label>
                <Input
                  value={editForm.originCountry}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, originCountry: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Destination Country</Label>
                <Input
                  value={editForm.destinationCountry}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, destinationCountry: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Container #</Label>
                <Input
                  value={editForm.containerNumber}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, containerNumber: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Container Size</Label>
                <Select value={editForm.containerSize || ""} onValueChange={(v) => setEditForm((prev: any) => ({ ...prev, containerSize: v }))}>
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder="Size" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="20GP">20GP</SelectItem>
                    <SelectItem value="40GP">40GP</SelectItem>
                    <SelectItem value="40HC">40HC</SelectItem>
                    <SelectItem value="45HC">45HC</SelectItem>
                    <SelectItem value="LCL">LCL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Capacity (CBM)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={editForm.containerCapacityCbm}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, containerCapacityCbm: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Seal #</Label>
                <Input
                  value={editForm.sealNumber}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, sealNumber: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>BOL #</Label>
                <Input
                  value={editForm.bolNumber}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, bolNumber: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>House BOL</Label>
                <Input
                  value={editForm.houseBol}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, houseBol: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Tracking #</Label>
                <Input
                  value={editForm.trackingNumber}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, trackingNumber: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>ETD</Label>
                <Input
                  type="date"
                  value={editForm.etd}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, etd: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>ETA</Label>
                <Input
                  type="date"
                  value={editForm.eta}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, eta: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={editForm.notes}
                onChange={(e) => setEditForm((prev: any) => ({ ...prev, notes: e.target.value }))}
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>Internal Notes</Label>
              <Textarea
                value={editForm.internalNotes}
                onChange={(e) => setEditForm((prev: any) => ({ ...prev, internalNotes: e.target.value }))}
                rows={2}
              />
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowEditDialog(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  const data: any = { ...editForm };
                  // Convert empty date strings to null
                  if (!data.etd) data.etd = null;
                  if (!data.eta) data.eta = null;
                  if (data.containerCapacityCbm === "") data.containerCapacityCbm = null;
                  updateShipmentMutation.mutate(data);
                }}
                disabled={updateShipmentMutation.isPending}
              >
                {updateShipmentMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══════ Cancel Dialog ═══════ */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              Cancel Shipment
            </DialogTitle>
            <DialogDescription>This action cannot be undone. Please provide a reason.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Why is this shipment being cancelled?"
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

      {/* ═══════ Add from PO Dialog ═══════ */}
      <Dialog open={showAddFromPoDialog} onOpenChange={(open) => {
        setShowAddFromPoDialog(open);
        if (!open) { setSelectedPoId(null); setSelectedPoLineIds([]); setPoSearch(""); }
      }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Lines from Purchase Order</DialogTitle>
            <DialogDescription>Search for a PO and select lines to add to this shipment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* PO Search */}
            <div className="space-y-2">
              <Label>Purchase Order</Label>
              <Popover open={poOpen} onOpenChange={setPoOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-between h-10 font-normal">
                    {selectedPoId
                      ? (Array.isArray(purchaseOrders) ? purchaseOrders : []).find((po: any) => po.id === selectedPoId)?.poNumber || `PO #${selectedPoId}`
                      : "Search PO number..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput placeholder="Search PO number..." value={poSearch} onValueChange={setPoSearch} />
                    <CommandList>
                      <CommandEmpty>No purchase orders found.</CommandEmpty>
                      <CommandGroup>
                        {filteredPOs.map((po: any) => (
                          <CommandItem
                            key={po.id}
                            value={String(po.id)}
                            onSelect={() => {
                              setSelectedPoId(po.id);
                              setSelectedPoLineIds([]);
                              setPoOpen(false);
                              setPoSearch("");
                            }}
                          >
                            <Check className={`mr-2 h-4 w-4 ${selectedPoId === po.id ? "opacity-100" : "opacity-0"}`} />
                            <span className="font-mono text-sm mr-2">{po.poNumber}</span>
                            <span className="text-muted-foreground text-xs">{po.vendor?.name || po.vendorName || ""}</span>
                            <Badge variant="outline" className="ml-auto text-xs">{po.status}</Badge>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            {/* PO Lines selection */}
            {selectedPoId && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Select Lines</Label>
                  {poLines.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (selectedPoLineIds.length === poLines.length) {
                          setSelectedPoLineIds([]);
                        } else {
                          setSelectedPoLineIds(poLines.map((l: any) => l.id));
                        }
                      }}
                    >
                      {selectedPoLineIds.length === poLines.length ? "Deselect All" : "Select All"}
                    </Button>
                  )}
                </div>
                {poLines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No lines found for this PO.</p>
                ) : (
                  <div className="border rounded-md divide-y max-h-60 overflow-y-auto">
                    {poLines.map((line: any) => (
                      <div
                        key={line.id}
                        className="flex items-center gap-3 p-2 hover:bg-muted/50 cursor-pointer"
                        onClick={() => {
                          setSelectedPoLineIds((prev) =>
                            prev.includes(line.id) ? prev.filter((id) => id !== line.id) : [...prev, line.id]
                          );
                        }}
                      >
                        <Checkbox
                          checked={selectedPoLineIds.includes(line.id)}
                          onCheckedChange={(checked) => {
                            setSelectedPoLineIds((prev) =>
                              checked ? [...prev, line.id] : prev.filter((id) => id !== line.id)
                            );
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm">{line.sku || "—"}</span>
                            <span className="text-sm truncate">{line.productName || ""}</span>
                            {(line.orderQty - (line.receivedQty || 0)) <= 0 && (
                              <span className="text-xs text-muted-foreground italic">fully received</span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatCents(line.unitCostCents, { unitCost: true })}/unit
                            {" · "}
                            Ordered: {line.orderQty}
                            {(line.receivedQty || 0) > 0 && ` · Received: ${line.receivedQty}`}
                            {" · "}
                            <span className={(line.orderQty - (line.receivedQty || 0)) > 0 ? "text-foreground font-medium" : "text-muted-foreground"}>
                              Open: {Math.max(0, line.orderQty - (line.receivedQty || 0))}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAddFromPoDialog(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  if (selectedPoId && selectedPoLineIds.length > 0) {
                    addFromPoMutation.mutate({ purchaseOrderId: selectedPoId, lineIds: selectedPoLineIds });
                  }
                }}
                disabled={!selectedPoId || selectedPoLineIds.length === 0 || addFromPoMutation.isPending}
              >
                {addFromPoMutation.isPending ? "Adding..." : `Add ${selectedPoLineIds.length} Line${selectedPoLineIds.length !== 1 ? "s" : ""}`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══════ Import Packing List Dialog ═══════ */}
      <Dialog open={showImportDialog} onOpenChange={(open) => { setShowImportDialog(open); if (!open) resetImportState(); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import Packing List</DialogTitle>
            <DialogDescription>
              {importStep === "upload" && "Upload a CSV file with packing list data."}
              {importStep === "map" && "Map CSV columns to shipment line fields."}
              {importStep === "preview" && "Review the data before importing."}
            </DialogDescription>
          </DialogHeader>

          {importStep === "upload" && (
            <div className="space-y-4">
              <div
                className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  {importFile ? importFile.name : "Click to select a CSV file"}
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelect(file);
                  }}
                />
              </div>
            </div>
          )}

          {importStep === "map" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">Found {importParsed.length} rows and {importHeaders.length} columns.</p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { field: "sku", label: "SKU *" },
                  { field: "qty_shipped", label: "Qty Shipped *" },
                  { field: "weight_kg", label: "Weight (kg)" },
                  { field: "length_cm", label: "Length (cm)" },
                  { field: "width_cm", label: "Width (cm)" },
                  { field: "height_cm", label: "Height (cm)" },
                  { field: "gross_volume_cbm", label: "Gross Vol (CBM)" },
                  { field: "carton_count", label: "Carton Count" },
                  { field: "pallet_count", label: "Pallet Count" },
                ].map(({ field, label }) => (
                  <div key={field} className="space-y-1">
                    <Label className="text-xs">{label}</Label>
                    <Select
                      value={importMapping[field] || ""}
                      onValueChange={(v) => setImportMapping((prev) => ({ ...prev, [field]: v }))}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="— Skip —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__skip__">— Skip —</SelectItem>
                        {importHeaders.map((h) => (
                          <SelectItem key={h} value={h}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => { setImportStep("upload"); }}>Back</Button>
                <Button
                  onClick={() => setImportStep("preview")}
                  disabled={!importMapping.sku || importMapping.sku === "__skip__" || !importMapping.qty_shipped || importMapping.qty_shipped === "__skip__"}
                >
                  Preview
                </Button>
              </div>
            </div>
          )}

          {importStep === "preview" && (
            <div className="space-y-4">
              <div className="border rounded-md overflow-x-auto max-h-60">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead className="text-right">Gross Vol</TableHead>
                      <TableHead className="text-right">Cartons</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {buildImportRows().slice(0, 20).map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">{row.sku || "—"}</TableCell>
                        <TableCell className="text-right">{row.qty_shipped || "—"}</TableCell>
                        <TableCell className="text-right">{row.weight_kg || "—"}</TableCell>
                        <TableCell className="text-right">{row.gross_volume_cbm || "—"}</TableCell>
                        <TableCell className="text-right">{row.carton_count || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {importParsed.length > 20 && (
                <p className="text-xs text-muted-foreground">Showing first 20 of {importParsed.length} rows.</p>
              )}
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setImportStep("map")}>Back</Button>
                <Button
                  onClick={() => importPackingListMutation.mutate(buildImportRows())}
                  disabled={importPackingListMutation.isPending}
                >
                  {importPackingListMutation.isPending ? "Importing..." : `Import ${importParsed.length} Rows`}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ═══════ Add Cost Dialog ═══════ */}
      <Dialog open={showAddCostDialog} onOpenChange={setShowAddCostDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Shipment Cost</DialogTitle>
            <DialogDescription>Record a cost associated with this shipment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Cost Type *</Label>
                <Select value={newCost.costType} onValueChange={(v) => setNewCost((prev) => ({ ...prev, costType: v }))}>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COST_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={newCost.costStatus} onValueChange={(v) => setNewCost((prev) => ({ ...prev, costStatus: v }))}>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COST_STATUS_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                value={newCost.description}
                onChange={(e) => setNewCost((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Cost description"
                className="h-10"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Estimated ($)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={newCost.estimatedCents ? (newCost.estimatedCents / 100).toFixed(2) : ""}
                  onChange={(e) => setNewCost((prev) => ({ ...prev, estimatedCents: Math.round(parseFloat(e.target.value || "0") * 100) }))}
                  placeholder="0.00"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Actual ($)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={newCost.actualCents ? (newCost.actualCents / 100).toFixed(2) : ""}
                  onChange={(e) => setNewCost((prev) => ({ ...prev, actualCents: Math.round(parseFloat(e.target.value || "0") * 100) }))}
                  placeholder="0.00"
                  className="h-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Allocation Method</Label>
              <Select value={newCost.allocationMethod} onValueChange={(v) => setNewCost((prev) => ({ ...prev, allocationMethod: v }))}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALLOCATION_METHOD_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Invoice #</Label>
                <Input
                  value={newCost.invoiceNumber}
                  onChange={(e) => setNewCost((prev) => ({ ...prev, invoiceNumber: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Vendor</Label>
                <Input
                  value={newCost.vendorName}
                  onChange={(e) => setNewCost((prev) => ({ ...prev, vendorName: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAddCostDialog(false)}>Cancel</Button>
              <Button
                onClick={() => addCostMutation.mutate(newCost)}
                disabled={addCostMutation.isPending}
              >
                {addCostMutation.isPending ? "Adding..." : "Add Cost"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══════ Edit Cost Dialog ═══════ */}
      <Dialog open={showEditCostDialog} onOpenChange={(open) => { setShowEditCostDialog(open); if (!open) setEditingCost(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Cost</DialogTitle>
            <DialogDescription>Update cost details.</DialogDescription>
          </DialogHeader>
          {editingCost && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Cost Type</Label>
                  <Select value={editingCost.costType} onValueChange={(v) => setEditingCost((prev: any) => ({ ...prev, costType: v }))}>
                    <SelectTrigger className="h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COST_TYPE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={editingCost.costStatus} onValueChange={(v) => setEditingCost((prev: any) => ({ ...prev, costStatus: v }))}>
                    <SelectTrigger className="h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COST_STATUS_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Description</Label>
                <Input
                  value={editingCost.description}
                  onChange={(e) => setEditingCost((prev: any) => ({ ...prev, description: e.target.value }))}
                  className="h-10"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Estimated ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editingCost.estimatedCents ? (editingCost.estimatedCents / 100).toFixed(2) : ""}
                    onChange={(e) => setEditingCost((prev: any) => ({ ...prev, estimatedCents: Math.round(parseFloat(e.target.value || "0") * 100) }))}
                    placeholder="0.00"
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Actual ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={editingCost.actualCents ? (editingCost.actualCents / 100).toFixed(2) : ""}
                    onChange={(e) => setEditingCost((prev: any) => ({ ...prev, actualCents: Math.round(parseFloat(e.target.value || "0") * 100) }))}
                    placeholder="0.00"
                    className="h-10"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Allocation Method</Label>
                <Select value={editingCost.allocationMethod || "default"} onValueChange={(v) => setEditingCost((prev: any) => ({ ...prev, allocationMethod: v }))}>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALLOCATION_METHOD_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Invoice #</Label>
                  <Input
                    value={editingCost.invoiceNumber}
                    onChange={(e) => setEditingCost((prev: any) => ({ ...prev, invoiceNumber: e.target.value }))}
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Vendor</Label>
                  <Input
                    value={editingCost.vendorName}
                    onChange={(e) => setEditingCost((prev: any) => ({ ...prev, vendorName: e.target.value }))}
                    className="h-10"
                  />
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => { setShowEditCostDialog(false); setEditingCost(null); }}>Cancel</Button>
                <Button
                  onClick={() => {
                    const { id, ...data } = editingCost;
                    updateCostMutation.mutate({ costId: id, data });
                  }}
                  disabled={updateCostMutation.isPending}
                >
                  {updateCostMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
