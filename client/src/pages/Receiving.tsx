import { receiptReversalSourceCapability } from "@/lib/receipt-reversal-capability";
import { SupplierReturnLink } from "@/features/purchasing/SupplierReturnLink";
import { parseReceivingImportCsv, parseReceivingImportResult, receivingImportError } from "@/lib/receiving-import";
import { ReceiptSupplierCosts } from "@/features/purchasing/ReceiptSupplierCosts";
import { ReceiptShipmentQuantityCorrection } from "@/features/purchasing/ReceiptShipmentQuantityCorrection";
import type { ReceivingImportRowInput } from "@shared/procurement/receiving-import";
import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { parseProcurementRecord } from "@/lib/procurement-navigation";
import { createReceivingNavigationSession, type ReceivingNavigationVisit } from "@/lib/receiving-navigation-session";
import { useReceiptReversal } from "@/hooks/use-receipt-reversal";
import { ReceiptReversalRecoveryNotice } from "@/components/purchasing/ReceiptReversalRecoveryNotice";
import { assertReceiptReversalLineTarget, type ReceiptReversalCommand, type ReceiptReversalRecovery } from "@/lib/receipt-reversal-command";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { parseReceiptReversalHistory } from "@/lib/receipt-reversal-history";
import { RECEIPT_REVERSAL_MAX_REASON_LENGTH } from "@shared/procurement/receipt-reversal-command";
import { parseReceivingHeaderResult, parseReceivingCloseResult, receivingIssueMessages, receivingCostOutcomeMessage } from "@/lib/receiving-outcomes";
import { ReceivingUnitControl } from "@/components/purchasing/ReceivingUnitControl";
import { ReceivingCountControl } from "@/components/purchasing/ReceivingCountControl";
import { ReceivingQuarantineRecoveryNotice } from "@/components/purchasing/ReceivingQuarantineRecoveryNotice";
import { ReceivingQuarantinePanel } from "@/components/purchasing/ReceivingQuarantinePanel";
import { hasReceivingUnitVersion, ReceivingUnitVersionError, parseReceivingUnitRefresh, parseReceivingLineMutation, receivingSelectedFactor, receivingVariantChange, receivingCompleteAllCommand, receivingCountChange, receivingAddQuantity, recordedReceivingFactor, type ReceivingUnitLine } from "@/lib/receiving-units";
import { ProcurementContext } from "@/components/procurement-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InventoryLocationCombobox } from "@/components/inventory/InventoryLocationCombobox";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { filterActionableWarehouseLocations } from "@/lib/warehouse-locations";
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

function createReceivingIdempotencyKey(prefix: string): string {
  return (
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? (crypto as any).randomUUID()
      : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  ) as string;
}

interface ReceivingLine extends ReceivingUnitLine {
  reversalCapability?: unknown;
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
  reversedQty?: number;
}

interface ReceiveValidationWarning {
  kind: string;
  severity: "warn" | "error";
  receivingLineId: number;
  purchaseOrderLineId?: number;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
}

interface ReceivingOrder {
  reversalCapability?: unknown;
  id: number;
  receiptNumber: string;
  poNumber: string | null;
  asnNumber: string | null;
  sourceType: string;
  vendorId: number | null;
  warehouseId: number | null;
  receivingLocationId: number | null;
  purchaseOrderId: number | null;
  inboundShipmentId: number | null;
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
  warehouseId: number | null;
  locationType?: string | null;
  isActive?: number | null;
}

function LocationTypeahead({
  locations,
  value,
  onChange,
  disabled = false,
  ariaLabel = "Inventory location",
}: {
  locations: WarehouseLocation[];
  value: number | null;
  onChange: (locationId: number | null) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <InventoryLocationCombobox
      locations={filterActionableWarehouseLocations(locations)}
      value={value}
      onValueChange={onChange}
      ariaLabel={ariaLabel}
      disabled={disabled}
      placeholder="Select..."
      searchPlaceholder="Search locations..."
      emptyMessage="No matching locations found."
      allowClear
      triggerClassName="h-10 min-h-11 w-28"
      contentClassName="min-w-72"
    />
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
  const [location, navigate] = useLocation();
  const searchStr = useSearch();
  const procurementNavigation = useProcurementNavigation();
  const receiptRecord = parseProcurementRecord(location, searchStr);
  const requestedReceiptId = receiptRecord?.kind === "receipt" ? receiptRecord.id : null;
  const invalidReceiptId = new URLSearchParams(searchStr).has("open") && requestedReceiptId === null;
  // Requests finish after navigation, but UI results belong to one committed
  // visit. A fresh visit to the same URL must not accept an older response.
  const [receiptNavigationSession] = useState(createReceivingNavigationSession);
  useLayoutEffect(() => {
    receiptNavigationSession.enter(`${location}?${searchStr}`);
    return () => receiptNavigationSession.leave();
  }, [location, searchStr, receiptNavigationSession]);
  const captureReceiptNavigation = receiptNavigationSession.capture;
  const isCurrentReceiptNavigation = receiptNavigationSession.isCurrent;
  
  const [activeTab, setActiveTab] = useState("receipts");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showNewReceiptDialog, setShowNewReceiptDialog] = useState(false);
  const [showNewVendorDialog, setShowNewVendorDialog] = useState(false);
  const [selectedReceipt, setSelectedReceipt] = useState<ReceivingOrder | null>(null);
  const [receiptSettingsError, setReceiptSettingsError] = useState<string | null>(null);
  const [closeIssues, setCloseIssues] = useState<string[]>([]);
  const [quarantineCommandPending, setQuarantineCommandPending] = useState(false);
  const [quarantineAcceptAll, setQuarantineAcceptAll] = useState<{ allowed: boolean; reason: string | null }>({ allowed: false, reason: "Loading quarantine custody." });
  const [showReceiptDetail, setShowReceiptDetail] = useState(false);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptLoadError, setReceiptLoadError] = useState<string | null>(null);
  const [receiptLoadAttempt, setReceiptLoadAttempt] = useState(0);
  const refreshReceiptAfterQuarantine = useCallback(async () => {
    if (requestedReceiptId === null) throw new Error("The receipt is no longer open.");
    const context = captureReceiptNavigation();
    const response = await fetch(`/api/receiving/${requestedReceiptId}`);
    if (!response.ok) throw new Error("The saved change needs receipt readback. Reload the receipt to verify its current values.");
    const current: unknown = await response.json();
    parseReceivingHeaderResult(current, requestedReceiptId);
    if (!current || typeof current !== "object" || !("lines" in current) || !Array.isArray(current.lines) ||
        !("status" in current) || typeof current.status !== "string" || !("receiptNumber" in current) || typeof current.receiptNumber !== "string" ||
        current.lines.some((line: ReceivingLine) => line.receivingOrderId !== requestedReceiptId || !hasReceivingUnitVersion(line))) {
      throw new Error("The receipt readback was incomplete. Reload the receipt before further changes.");
    }
    if (!isCurrentReceiptNavigation(context)) return;
    setSelectedReceipt(current as ReceivingOrder);
    setCountDrafts({}); setUnitErrors({}); setReceiptSettingsError(null);
    void queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
  }, [requestedReceiptId, captureReceiptNavigation, isCurrentReceiptNavigation, queryClient]);
  const [showCSVImport, setShowCSVImport] = useState(false);
  // A draft belongs to its receipt. Keep it when navigating back without
  // presenting another receipt's counts as the current import.
  const [receiptCsvDrafts, setReceiptCsvDrafts] = useState<Record<number, string>>({});
  const csvText = requestedReceiptId === null ? "" : receiptCsvDrafts[requestedReceiptId] ?? "";
  const setCsvText = (text: string): void => {
    if (requestedReceiptId === null) return;
    setReceiptCsvDrafts((drafts) => ({ ...drafts, [requestedReceiptId]: text }));
  };
  const [csvImportError, setCsvImportError] = useState<string | null>(null);
  const [csvFileReadPending, setCsvFileReadPending] = useState(false);
  const [importResults, setImportResults] = useState<{ errors: string[]; warnings: string[]; created: number; updated: number } | null>(null);
  const [showImportResults, setShowImportResults] = useState(false);
  const [showAddLineDialog, setShowAddLineDialog] = useState(false);
  // Resolution UI state
  const [resolvingLine, setResolvingLine] = useState<ReceivingLine | null>(null);
  const [countDrafts, setCountDrafts] = useState<Record<number, { value: string; line: ReceivingLine }>>({});
  const [unitErrors, setUnitErrors] = useState<Record<number, { message: string; needsRefresh: boolean }>>({});
  const [reloadingUnits, setReloadingUnits] = useState(false);
  const [legacyResolveVariant, setLegacyResolveVariant] = useState<number | null>(null);
  const [showResolveDialog, setShowResolveDialog] = useState(false);
  const [resolveMode, setResolveMode] = useState<'sku' | 'location'>('sku');
  const [resolveSkuSearch, setResolveSkuSearch] = useState("");
  const [resolveSkuResults, setResolveSkuResults] = useState<{sku: string; name: string; productVariantId: number; unitsPerVariant?: number}[]>([]);
  const resolveSkuTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [newLine, setNewLine] = useState({
    sku: "",
    productName: "",
    expectedQty: "1",
    putawayLocationId: "",
    productId: null as number | null,
    productVariantId: null as number | null,
    expectedUnitsPerVariant: null as number | null,
  });
  const [addLineError, setAddLineError] = useState<string | null>(null);
  const [skuSearch, setSkuSearch] = useState("");
  const [skuResults, setSkuResults] = useState<{sku: string; name: string; productId: number | null; productVariantId: number; unitsPerVariant: number}[]>([]);
  const [showSkuDropdown, setShowSkuDropdown] = useState(false);
  const [skuSearchTimeout, setSkuSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  
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

  const { data: variants = [] } = useQuery<{ id: number; sku: string; name: string; productId: number; unitsPerVariant: number }[]>({
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
    onMutate: captureReceiptNavigation,
    mutationFn: async (data: typeof newReceipt) => {
      // If PO source type with a selected PO, use the create-receipt-from-PO endpoint
      if (data.sourceType === "po" && selectedPoId) {
        const idempotencyKey = createReceivingIdempotencyKey(`po-receipt-${selectedPoId}`);
        const res = await fetch(`/api/purchase-orders/${selectedPoId}/create-receipt`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
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
    onSuccess: (receipt, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      if (!isCurrentReceiptNavigation(context)) return;
      setShowNewReceiptDialog(false);
      setNewReceipt({ sourceType: "blind", vendorId: "", warehouseId: "", poNumber: "", notes: "" });
      setSelectedPoId(null);
      setPoSearch("");
      toast({ title: "Receipt created", description: `Receipt ${receipt.receiptNumber} created` });
      navigate(procurementNavigation.childHref(`/receiving?open=${receipt.id}`));
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to create receipt", variant: "destructive" });
    },
  });

  const discardReceiptMutation = useMutation({
    onMutate: captureReceiptNavigation,
    mutationFn: async (id: number) => {
      if (quarantineCommandPending) throw new Error("Confirm the saved quarantine command before discarding this receipt.");
      const res = await fetch(`/api/receiving-orders/${id}/discard`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Discard failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (_result, discardedId, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      if (!isCurrentReceiptNavigation(context)) return;
      toast({ title: "Receipt discarded" });
      if (selectedReceipt?.id !== discardedId) return;
      setSelectedReceipt(null);
      setShowReceiptDetail(false);
      navigate(procurementNavigation.backHref(
        selectedReceipt?.purchaseOrderId
          ? `/purchase-orders/${selectedReceipt.purchaseOrderId}`
          : "/receiving",
      ));
    },
    onError: (error: Error) => {
      // Surface 409 reason verbatim — do not hide it (spec: "don't pretend it succeeded")
      toast({ title: "Cannot discard receipt", description: error.message, variant: "destructive" });
    },
  });

  // ── Receipt reversal (Spec D) ────────────────────────────────────────────
  const [reverseTarget, setReverseTarget] = useState<{
    scope: "line" | "order";
    lineId?: number;
    lineLabel?: string;
    maxQty?: number;
  } | null>(null);
  const [reverseQty, setReverseQty] = useState<string>("");
  const [reverseReason, setReverseReason] = useState("");
  const [reverseAllowNegative, setReverseAllowNegative] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const reversal = useReceiptReversal();

  const reversalsQuery = useQuery({
    queryKey: ["/api/procurement/receiving-orders", selectedReceipt?.id, "reversals"],
    queryFn: async ({ signal }) => {
      const id = selectedReceipt!.id;
      const res = await fetch(`/api/procurement/receiving-orders/${id}/reversals`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Receipt reversal history could not be loaded. Retry to review the recorded corrections.");
      return parseReceiptReversalHistory(await res.json(), id);
    },
    enabled: !!selectedReceipt && selectedReceipt.status === "closed",
  });

  const validationWarningsQuery = useQuery({
    queryKey: ["/api/procurement/receiving-orders", selectedReceipt?.id, "validation-warnings"],
    queryFn: async () => {
      const res = await fetch(`/api/procurement/receiving-orders/${selectedReceipt!.id}/validation-warnings`);
      if (!res.ok) throw new Error("Failed to fetch validation warnings");
      return (await res.json()) as ReceiveValidationWarning[];
    },
    enabled: !!selectedReceipt && selectedReceipt.status !== "closed" && selectedReceipt.status !== "cancelled",
    refetchInterval: 15000,
  });

  type ReversalSubmission = {
    command: ReceiptReversalCommand;
    pinned?: ReceiptReversalRecovery;
    receiptVisit: ReceivingNavigationVisit;
    operatorVisit: ReturnType<typeof reversal.captureVisit>;
  };
  const isCurrentReversal = (submission: ReversalSubmission) =>
    isCurrentReceiptNavigation(submission.receiptVisit) && submission.operatorVisit.isCurrent();
  const reverseMutation = useMutation({
    retry: false,
    // An offline click must retain the command now, not queue a hidden mutation
    // that can dispatch later from another receipt or operator context.
    networkMode: "always",
    mutationFn: async (submission: ReversalSubmission) => {
      if (!isCurrentReversal(submission)) throw new Error("The receipt or operator changed. Review the current request before reversing.");
      if (quarantineCommandPending) throw new Error("Confirm the saved quarantine command before reversing this receipt.");
      return reversal.execute(submission.command, submission.pinned);
    },
    onSuccess: (result, submission) => {
      if (!isCurrentReversal(submission)) return;
      setReverseError(null);
      if (requestedReceiptId === result.receivingOrderId) {
        void reversalsQuery.refetch();
        setReceiptLoadAttempt((attempt) => attempt + 1);
      }
      setReverseTarget(null);
      setReverseQty("");
      setReverseReason("");
      setReverseAllowNegative(false);
      toast({ title: "Receipt reversal confirmed", description: `Receipt #${result.receivingOrderId}: the saved reversal result was verified.` });
    },
    onError: (error: Error, submission) => {
      if (isCurrentReversal(submission)) setReverseError(error.message);
    },
    onSettled: () => {
      // A lost reply may follow a committed inventory/AP correction. Refresh all
      // related read models without using those reads to discard recovery identity.
      void invalidatePurchaseCosts(queryClient);
      void queryClient.invalidateQueries({ queryKey: ["/api/procurement/receiving-orders"] });
    },
  });
  const receiptReversalCapability = receiptReversalSourceCapability(selectedReceipt?.reversalCapability);
  const targetReversalCapability = reverseTarget?.scope === "line" ? receiptReversalSourceCapability(selectedReceipt?.lines?.find(line => line.id === reverseTarget.lineId)?.reversalCapability) : receiptReversalCapability;
  const reversalBlocked = (reverseTarget !== null && !targetReversalCapability.allowed) || !reversal.ready || !reversal.allowed || !!reversal.error || !!reversal.recovery || reverseMutation.isPending || reversalsQuery.isPending || reversalsQuery.isError;
  function submitReversal(command: ReceiptReversalCommand, pinned?: ReceiptReversalRecovery) {
    if (reverseMutation.isPending) return;
    setReverseError(null);
    reverseMutation.mutate({ command, pinned, receiptVisit: captureReceiptNavigation(), operatorVisit: reversal.captureVisit() });
  }
  const reversalRecovery = <ReceiptReversalRecoveryNotice saved={reversal.recovery} storageError={reversal.error}
    error={reverseError} pending={reverseMutation.isPending || quarantineCommandPending} allowed={reversal.allowed}
    onRetry={(saved) => submitReversal(saved.body, saved)} onRead={reversal.refresh} />;

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
    onMutate: captureReceiptNavigation,
    mutationFn: async (id: number) => {
      if (quarantineCommandPending) throw new Error("Confirm the saved quarantine command before starting this receipt.");
      const res = await fetch(`/api/receiving/${id}/open`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to open receipt");
      return res.json();
    },
    onSuccess: (data, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (!isCurrentReceiptNavigation(context)) return;
      setSelectedReceipt(data);
      toast({ title: "Receipt opened for receiving" });
    },
  });

  // Over-receipt confirmation (shipment receipts) + multi-PO shipment chaining.
  const [overReceiptPrompt, setOverReceiptPrompt] = useState<{
    id: number;
    overLines: Array<{ sku: string | null; expectedQty: number; receivedQty: number }>;
  } | null>(null);
  const [nextPoPrompt, setNextPoPrompt] = useState<{
    shipmentId: number;
    shipmentNumber: string | null;
    option: any;
    returnHref: string;
  } | null>(null);

  const closeReceiptMutation = useMutation({
    onMutate: captureReceiptNavigation,
    mutationFn: async ({ id, allowOverReceipt = false }: { id: number; allowOverReceipt?: boolean }) => {
      assertReceiptSettingsConfirmed();
      const res = await fetch(`/api/receiving/${id}/close`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": createReceivingIdempotencyKey(`receiving-close-${id}`),
        },
        body: JSON.stringify({ allowOverReceipt }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.issues) {
          const err = new Error(body.error) as Error & { issues: any[] };
          err.issues = body.issues;
          throw err;
        }
        if (body?.code === "SHIPMENT_OVER_RECEIPT_CONFIRMATION_REQUIRED") {
          const err = new Error(body.error) as Error & { code: string; overLines: any[]; receivingOrderId: number };
          err.code = body.code;
          err.overLines = body.overLines ?? [];
          err.receivingOrderId = id;
          throw err;
        }
        throw new Error(body?.error || "Failed to close receipt");
      }
      return parseReceivingCloseResult(await res.json(), id);
    },
    onSuccess: (result, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      if (!isCurrentReceiptNavigation(context)) return;
      setCloseIssues([]);
      const costMessage = receivingCostOutcomeMessage(result.costReconciliation);
      toast({
        title: costMessage ? "Inventory received — costs unfinished" : "Receipt closed — inventory updated",
        description: costMessage ?? `${result.unitsReceived} units received across ${result.linesProcessed} lines`
      });
      setShowReceiptDetail(false);
      const closedPoId = selectedReceipt?.purchaseOrderId;
      const chainShipmentId = selectedReceipt?.inboundShipmentId;
      const returnHref = procurementNavigation.backHref(
        closedPoId ? `/purchase-orders/${closedPoId}` : "/receiving",
      );
      // Multi-PO shipment chaining: if this receipt came from a shipment that
      // still has unreceived PO lines, offer the next PO instead of bouncing
      // back to the PO page and orphaning the rest of the truck.
      if (chainShipmentId) {
        void (async () => {
          try {
            const res = await fetch(`/api/inbound-shipments/${chainShipmentId}/po-receive-options`);
            const summary = res.ok ? await res.json() : null;
            if (!isCurrentReceiptNavigation(context)) return;
            const next = (summary?.purchaseOrders ?? []).find(
              (o: any) => o.receivable && o.action === "create_receipt" && o.remainingBaseQty > 0,
            );
            if (next) {
              setNextPoPrompt({ shipmentId: chainShipmentId, shipmentNumber: summary?.shipmentNumber ?? null, option: next, returnHref });
              return;
            }
          } catch {
            // fall through to the default navigation
          }
          if (isCurrentReceiptNavigation(context)) navigate(returnHref);
        })();
        return;
      }
      navigate(returnHref);
    },
    onError: (error: any, _variables, context) => {
      if (!isCurrentReceiptNavigation(context)) return;
      if (error.code === "SHIPMENT_OVER_RECEIPT_CONFIRMATION_REQUIRED") {
        setOverReceiptPrompt({ id: error.receivingOrderId, overLines: error.overLines ?? [] });
        return;
      }
      if (error.issues) {
        const messages = receivingIssueMessages(error.issues);
        setCloseIssues(messages.length ? messages : [error.message]);
        toast({
          title: "Cannot close receipt",
          description: messages[0] || error.message,
          variant: "destructive",
        });
      } else {
        setCloseIssues([error.message || "The close outcome could not be verified. Load the latest receipt before retrying."]);
        toast({ title: "Failed to close receipt", description: error.message, variant: "destructive" });
      }
    },
  });

  const receiveNextPoMutation = useMutation({
    onMutate: captureReceiptNavigation,
    mutationFn: async ({ shipmentId, purchaseOrderId }: { shipmentId: number; purchaseOrderId: number }) => {
      const res = await fetch(`/api/inbound-shipments/${shipmentId}/create-receipt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": createReceivingIdempotencyKey(`shipment-receipt-${shipmentId}-${purchaseOrderId}`),
        },
        body: JSON.stringify({ purchaseOrderId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Failed to create receipt");
      return body;
    },
    onSuccess: (receipt, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (!isCurrentReceiptNavigation(context)) return;
      setNextPoPrompt(null);
      toast({ title: "Receipt created", description: `${receipt.receiptNumber} created — continue receiving` });
      navigate(procurementNavigation.childHref(
        `/receiving?open=${receipt.id}`,
        { replaceCurrent: true },
      ));
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message || "Failed to create receipt", variant: "destructive" });
    },
  });

  const bulkImportMutation = useMutation({
    onMutate: captureReceiptNavigation,
    mutationFn: async ({ orderId, lines }: { orderId: number; lines: ReceivingImportRowInput[] }) => {
      assertReceiptSettingsConfirmed();
      const res = await fetch(`/api/receiving/${orderId}/lines/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw receivingImportError(body);
      return parseReceivingImportResult(body);
    },
    onSuccess: (result, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (!isCurrentReceiptNavigation(context)) return;
      setShowCSVImport(false);
      setCsvImportError(null);
      if (!result.errors?.length) setCsvText("");
      
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
      } else {
        toast({ 
          title: "Import complete", 
          description: `${totalProcessed} lines processed (${linesMsg})` 
        });
      }
    },
    onError: (error: Error, _variables, context) => {
      if (!isCurrentReceiptNavigation(context)) return;
      // The persistent dialog owns import recovery. A duplicate toast can
      // cover its Import button and prevent the corrected retry.
      setCsvImportError(error.message);
    },
  });

  const addLineMutation = useMutation({
    onMutate: captureReceiptNavigation,
    mutationFn: async ({ orderId, line }: { orderId: number; line: any }) => {
      assertReceiptSettingsConfirmed();
      const res = await fetch(`/api/receiving/${orderId}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(line),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw Object.assign(new Error(data?.error || "Failed to add line"), { status: res.status });
      }
      return res.json();
    },
    onSuccess: (updatedOrder, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (!isCurrentReceiptNavigation(context)) return;
      if (updatedOrder && selectedReceipt) {
        setSelectedReceipt(updatedOrder);
      }
      setShowAddLineDialog(false);
      setAddLineError(null);
      setNewLine({
        sku: "",
        productName: "",
        expectedQty: "1",
        putawayLocationId: "",
        productId: null,
        productVariantId: null,
        expectedUnitsPerVariant: null,
      });
      setSkuSearch("");
      setSkuResults([]);
      toast({ title: "Line added successfully" });
    },
    onError: (error: Error & { status?: number }, _variables, context) => {
      if (!isCurrentReceiptNavigation(context)) return;
      const message = error.status === 409 ? error.message + " Refresh and reselect the SKU, then review the count before adding it." : error.message;
      if (error.status === 409) {
        setNewLine((current) => ({ ...current, expectedUnitsPerVariant: null }));
        setSkuResults([]); setShowSkuDropdown(false);
      }
      setAddLineError(message);
      toast({ title: "Failed to add line", description: message, variant: "destructive" });
    },
  });

  const updateLineMutation = useMutation({
    onMutate: captureReceiptNavigation,
    retry: false,
    mutationFn: async ({ lineId, updates }: { lineId: number; updates: Record<string, unknown> }) => {
      assertReceiptSettingsConfirmed();
      const expectedReceiptId = selectedReceipt?.id;
      if (!expectedReceiptId || !selectedReceipt?.lines?.some((line) => line.id === lineId)) throw new Error("The receipt line is no longer selected. Load the latest receipt.");
      const res = await fetch("/api/receiving/lines/" + lineId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const detail = body && typeof body === "object" && "error" in body ? String(body.error) : "Failed to update line";
        throw Object.assign(new Error(detail), { status: res.status });
      }
      return parseReceivingLineMutation(body, { id: lineId, receivingOrderId: expectedReceiptId, updates }) as ReceivingLine;
    },
    onSuccess: (updatedLine, variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (!isCurrentReceiptNavigation(context)) return;
      setSelectedReceipt((current) => current?.id === updatedLine.receivingOrderId ? {
        ...current, lines: current.lines?.map((line) => line.id === updatedLine.id ? updatedLine : line),
      } : current);
      setResolvingLine((current) => current?.id === updatedLine.id ? updatedLine : current);
      setUnitErrors((current) => { const next = { ...current }; delete next[updatedLine.id]; return next; });
      if ("receivedQty" in variables.updates) {
        setCountDrafts((current) => { const next = { ...current }; delete next[updatedLine.id]; return next; });
      }
      if ("productVariantId" in variables.updates) {
        setLegacyResolveVariant(null);
        setShowResolveDialog(false);
        toast({ title: "Receive unit confirmed", description: variables.updates.confirmLegacyUnit ? "The existing counts now have an explicitly confirmed unit." : "Expected, received and damaged piece totals were preserved." });
      } else if ("receivedQty" in variables.updates) {
        toast({ title: "Count saved", description: updatedLine.status === "overage" ? "The received count exceeds the expected quantity. Review the difference before closing." : undefined });
      }
    },
    onError: (cause: Error & { status?: number }, variables, context) => {
      if (!isCurrentReceiptNavigation(context)) return;
      // A lost response may follow a committed update. Preserve the draft and
      // require a source read; never silently rebase it onto a newer unit.
      const needsRefresh = cause.status === undefined || cause.status >= 500 || cause.status === 409 || cause.status === 404;
      setUnitErrors((current) => ({ ...current, [variables.lineId]: { message: cause.message, needsRefresh } }));
      toast({ title: "Line change needs review", description: cause.message, variant: "destructive" });
    },
  });

  function reportUnitError(lineId: number, cause: unknown, needsRefresh = false) {
    const message = cause instanceof Error ? cause.message : "The receive unit could not be changed.";
    setUnitErrors((current) => ({ ...current, [lineId]: { message, needsRefresh: needsRefresh || cause instanceof ReceivingUnitVersionError } }));
    toast({ title: "Line change needs review", description: message, variant: "destructive" });
  }

  function assertReceiptSettingsConfirmed() {
    if (quarantineCommandPending) throw new Error("Confirm the saved quarantine command before changing this receipt.");
    if (updateReceiptMutation.isPending || receiptSettingsError) {
      throw new Error("Receipt settings are not confirmed. Wait for the save or load the latest receipt before changing a line.");
    }
  }

  function applyVariant(line: ReceivingLine, variantId: number, confirmLegacyUnit = false, expectedUnitsPerVariant?: number) {
    if (quarantineCommandPending || updateReceiptMutation.isPending || receiptSettingsError || updateLineMutation.isPending || completeAllMutation.isPending || reloadingUnits || unitErrors[line.id]?.needsRefresh) return;
    try {
      if (countDrafts[line.id]) throw new Error("Save or discard the received-count draft before changing its unit.");
      const updates = receivingVariantChange(line, variantId, confirmLegacyUnit, expectedUnitsPerVariant);
      updateLineMutation.mutate({ lineId: line.id, updates });
    } catch (cause) { reportUnitError(line.id, cause); }
  }

  function setReceivedDraft(line: ReceivingLine, value: string) {
    if (quarantineCommandPending) return;
    setCountDrafts((current) => {
      const next = { ...current };
      // An explicit zero is a draft too; saving never fills expectedQty.
      next[line.id] = { value, line: current[line.id]?.line ?? { ...line } };
      return next;
    });
  }

  function saveReceivedCount(line: ReceivingLine) {
    if (quarantineCommandPending || updateReceiptMutation.isPending || receiptSettingsError || updateLineMutation.isPending || completeAllMutation.isPending || reloadingUnits || unitErrors[line.id]?.needsRefresh) return;
    try {
      const draft = countDrafts[line.id];
      updateLineMutation.mutate({ lineId: line.id, updates: receivingCountChange(draft?.line ?? line, draft?.value) });
    } catch (cause) { reportUnitError(line.id, cause); }
  }

  async function reloadReceiptUnits(lineId: number) {
    if (!selectedReceipt || quarantineCommandPending || updateLineMutation.isPending || reloadingUnits) return;
    const id = selectedReceipt.id;
    const context = captureReceiptNavigation();
    setReloadingUnits(true);
    try {
      const [res, catalogResponse] = await Promise.all([fetch("/api/receiving/" + id), fetch("/api/product-variants")]);
      if (!res.ok || !catalogResponse.ok) throw new Error("Latest receipt and catalog units could not be loaded. Your count draft is still preserved.");
      const [receipt, catalog]: [unknown, unknown] = await Promise.all([res.json(), catalogResponse.json()]);
      if (!Array.isArray(catalog)) throw new Error("The latest catalog units could not be verified. Your count draft is still preserved.");
      const current = parseReceivingUnitRefresh(receipt, { receiptId: id, lineId });
      if (!isCurrentReceiptNavigation(context)) return;
      queryClient.setQueryData(["/api/product-variants"], catalog);
      setSelectedReceipt(current);
      setCountDrafts((drafts) => { const next = { ...drafts }; delete next[lineId]; return next; });
      setUnitErrors((errors) => { const next = { ...errors }; delete next[lineId]; return next; });
      setResolvingLine((line) => line?.id === lineId ? current.lines.find((item) => item.id === lineId) ?? null : line);
      setLegacyResolveVariant(null);
    } catch (cause) {
      if (isCurrentReceiptNavigation(context)) reportUnitError(lineId, cause, true);
    } finally { if (isCurrentReceiptNavigation(context)) setReloadingUnits(false); }
  }

  function renderReceivedCount(line: ReceivingLine, layout: "mobile" | "desktop") {
    if (selectedReceipt?.status !== "open" && selectedReceipt?.status !== "receiving") {
      return selectedReceipt?.status === "draft"
        ? <span className="text-xs text-muted-foreground italic">Press Start to count</span>
        : <span>{line.receivedQty}</span>;
    }
    const draft = countDrafts[line.id];
    return <ReceivingCountControl
      lineId={line.id}
      value={draft?.value ?? String(line.receivedQty)}
      hasDraft={!!draft}
      showSave={line.status !== "complete" || !!draft}
      // A stale or ambiguous response must not leave a green confirmation on
      // the previous count after its draft is discarded; verify the source first.
      confirmed={line.status === "complete" && !draft && hasReceivingUnitVersion(line) && recordedReceivingFactor(line) !== null && !unitErrors[line.id]}
      disabled={quarantineCommandPending || updateReceiptMutation.isPending || !!receiptSettingsError || updateLineMutation.isPending || completeAllMutation.isPending || reloadingUnits || recordedReceivingFactor(line) === null || !!unitErrors[line.id]?.needsRefresh}
      discardDisabled={updateLineMutation.isPending}
      compact={layout === "desktop"}
      saveTestId={layout === "desktop" ? `btn-complete-line-${line.id}` : `btn-complete-line-mobile-${line.id}`}
      onChange={(value) => setReceivedDraft(line, value)}
      onSave={() => saveReceivedCount(line)}
      onDiscard={() => setCountDrafts((current) => {
        const next = { ...current };
        delete next[line.id];
        return next;
      })}
    />;
  }

  function renderUnitControl(line: ReceivingLine) {
    const mutable = !!selectedReceipt && !["closed", "cancelled"].includes(selectedReceipt.status);
    // Older or incomplete command responses need a source read, not a guessed version.
    const error = unitErrors[line.id] ?? (mutable && !hasReceivingUnitVersion(line) ? new ReceivingUnitVersionError() : null);
    return <div className="space-y-2">
      <ReceivingUnitControl
        line={line}
        variants={variants}
        mutable={mutable}
        pending={quarantineCommandPending || updateReceiptMutation.isPending || !!receiptSettingsError || updateLineMutation.isPending || completeAllMutation.isPending || reloadingUnits || !!countDrafts[line.id] || !!unitErrors[line.id]?.needsRefresh}
        onChange={(variantId, confirm, factor) => applyVariant(line, variantId, confirm, factor)}
      />
      {selectedReceipt?.status === "closed" && selectedReceipt.inboundShipmentId && <ReceiptShipmentQuantityCorrection receiptLineId={line.id}
        onSaved={() => { void refreshReceiptAfterQuarantine().catch((error: Error) => {
          setReceiptSettingsError(error.message);
        }); }}/>}
      {error && <div role="alert" className="rounded border border-destructive/40 p-2 text-xs text-destructive">
        <p>{error.message}</p>
        {error.needsRefresh && <Button size="sm" variant="outline" className="mt-2 h-auto min-h-10 whitespace-normal" disabled={quarantineCommandPending || reloadingUnits || updateLineMutation.isPending} onClick={() => void reloadReceiptUnits(line.id)}>Load latest line and discard count draft</Button>}
      </div>}
    </div>;
  }
  const updateReceiptMutation = useMutation({
    onMutate: captureReceiptNavigation,
    mutationFn: async ({ id, updates }: { id: number; updates: Record<string, any> }) => {
      assertReceiptSettingsConfirmed();
      const res = await fetch(`/api/receiving/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const error = body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error : "Failed to update receipt. Load the latest receipt before continuing.";
        const issues = body && typeof body === "object" && "issues" in body ? receivingIssueMessages(body.issues) : [];
        throw new Error(issues.length ? `${error} ${issues.join(" ")}` : error);
      }
      return parseReceivingHeaderResult(body, id);
    },
    onSuccess: (result, variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (!isCurrentReceiptNavigation(context)) return;
      setReceiptSettingsError(null);
      setCloseIssues([]);
      setSelectedReceipt((current) => current?.id === result.id ? { ...current, ...result } : current);
      // A default can fill unassigned lines atomically. Reload the returned
      // source evidence instead of fabricating new line versions in the UI.
      if (variables.updates.applyDefaultToUnassigned === true) setReceiptLoadAttempt((attempt) => attempt + 1);
    },
    onError: (error: Error, _variables, context) => {
      if (!isCurrentReceiptNavigation(context)) return;
      setReceiptSettingsError(error.message);
      toast({ title: "Receipt settings were not confirmed", description: error.message, variant: "destructive" });
    },
  });

  const completeAllMutation = useMutation({
    onMutate: captureReceiptNavigation,
    retry: false,
    mutationFn: async ({ orderId, lines }: { orderId: number; lines: ReceivingLine[] }) => {
      assertReceiptSettingsConfirmed();
      if (!quarantineAcceptAll.allowed) throw new Error(quarantineAcceptAll.reason || "Review quarantine custody before accepting all quantities.");
      const body = receivingCompleteAllCommand(lines);
      const res = await fetch("/api/receiving/" + orderId + "/complete-all", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Counts could not be completed. Load the latest receipt before continuing.");
      if (data?.order?.id !== orderId || !Array.isArray(data.order.lines)) throw new Error("The saved counts could not be verified. Load the latest receipt before continuing.");
      return data;
    },
    onSuccess: (data, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      if (!isCurrentReceiptNavigation(context)) return;
      setSelectedReceipt(data.order);
      toast({ title: "Counts saved", description: "Positive entered counts were preserved. Review any partial quantities before closing." });
    },
    onError: (cause: Error, variables, context) => {
      if (!isCurrentReceiptNavigation(context)) return;
      setUnitErrors((current) => Object.fromEntries([...Object.entries(current), ...variables.lines.map((line) => [line.id, { message: cause.message, needsRefresh: true }])]));
      toast({ title: "Counts need review", description: cause.message, variant: "destructive" });
    },
  });

  // Catalog creation does not reinterpret receipt quantities or link siblings.
  const createVariantMutation = useMutation({
    onMutate: captureReceiptNavigation,
    mutationFn: async (lineId: number) => {
      assertReceiptSettingsConfirmed();
      const res = await fetch("/api/receiving/lines/" + lineId + "/create-variant", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to create variant");
      if (data?.line?.id !== lineId || !Number.isInteger(data?.variant?.id) || !Number.isInteger(data?.variant?.unitsPerVariant) || data.variant.unitsPerVariant <= 0 || typeof data.variant.name !== "string" || data.requiresUnitConfirmation !== true) {
        throw new Error("The catalog result could not be verified. Search the catalog before trying again.");
      }
      return data;
    },
    onSuccess: (data, _variables, context) => {
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      if (!isCurrentReceiptNavigation(context)) return;
      setResolvingLine(data.line);
      setLegacyResolveVariant(data.variant.id);
      setResolveSkuResults([{ productVariantId: data.variant.id, sku: data.variant.sku, name: data.variant.name, unitsPerVariant: data.variant.unitsPerVariant }]);
      toast({ title: "Catalog variant created", description: "Review its receive unit below to link this line. Existing counts have not changed." });
    },
    onError: (error: Error, _variables, context) => {
      if (isCurrentReceiptNavigation(context)) toast({ title: "Failed to create variant", description: error.message, variant: "destructive" });
    },
  });

  // Location eligibility remains workflow-owned; the shared combobox owns search and scrolling.
  const warehouseFilteredLocations = filterActionableWarehouseLocations(locations, {
    warehouseId: selectedReceipt?.warehouseId ?? null,
  });

  // Debounced SKU search for add line dialog
  const handleSkuSearch = (query: string) => {
    setSkuSearch(query);
    if (query !== newLine.sku) setNewLine((current) => ({ ...current, sku: "", productName: "", productId: null, productVariantId: null, expectedUnitsPerVariant: null }));
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

  const handleCSVImport = () => {
    if (bulkImportMutation.isPending || csvFileReadPending) return;
    if (!selectedReceipt) {
      setCsvImportError("No receipt selected. Open the intended receipt before importing.");
      return;
    }
    setCsvImportError(null);
    const result = parseReceivingImportCsv(csvText);
    if (result.error) {
      setCsvImportError(result.error);
      return;
    }
    if (!result.lines || result.lines.length === 0) {
      setCsvImportError("No valid lines found in CSV. Add at least one data row before importing.");
      return;
    }
    bulkImportMutation.mutate({ orderId: selectedReceipt.id, lines: result.lines });
  };

  // Unit review and local count drafts must be resolved before inventory posting.
  const handlePreCloseValidation = () => {
    if (!selectedReceipt?.lines) return;
    closeReceiptMutation.mutate({ id: selectedReceipt.id });
  };

  // Compute issue counts for the current receipt
  const receiveUnitsNeedReview = selectedReceipt?.lines?.some((line) => {
    const factor = recordedReceivingFactor(line);
    const catalog = variants.find((variant) => variant.id === line.productVariantId);
    return factor === null || !hasReceivingUnitVersion(line) || !line.productVariantId || !!catalog && catalog.unitsPerVariant !== factor;
  }) ?? false;
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
    setLegacyResolveVariant(null);
    setResolvingLine(line);
    setResolveMode(mode);
    const sku = line.sku || "";
    setResolveSkuSearch(sku);
    setResolveSkuResults([]);
    setShowResolveDialog(true);
    if (mode === 'sku' && sku.length >= 2) {
      fetch(`/api/inventory/skus/search?q=${encodeURIComponent(sku)}&limit=10`)
        .then(res => res.ok ? res.json() : [])
        .then(data => setResolveSkuResults(data))
        .catch(() => {});
    }
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

  const receiptHref = (id: number) => procurementNavigation.childHref(`/receiving?open=${id}`);

  const loadReceiptDetail = (receipt: ReceivingOrder) => {
    navigate(receiptHref(receipt.id));
  };

  const closeReceiptDetail = () => {
    navigate(procurementNavigation.backHref("/receiving"));
  };

  useEffect(() => {
    // A browser history change must not carry a pending editor into a different
    // receipt. Persisted receive quantities remain owned by the server.
    setCountDrafts({});
    setUnitErrors({});
    setReloadingUnits(false);
    setAddLineError(null);
    setLegacyResolveVariant(null);
    setShowCSVImport(false);
    setCsvImportError(null);
    setCsvFileReadPending(false);
    setShowImportResults(false);
    setImportResults(null);
    setShowAddLineDialog(false);
    setShowResolveDialog(false);
    setReverseTarget(null);
    setReverseError(null);
    setOverReceiptPrompt(null);
    setNextPoPrompt(null);
    setReceiptSettingsError(null);
    setCloseIssues([]);
    setQuarantineCommandPending(false);
    setQuarantineAcceptAll({ allowed: false, reason: "Loading quarantine custody." });
  }, [requestedReceiptId, invalidReceiptId, location, searchStr]);

  // The address identifies the open receipt, including after reload or browser
  // Back. Fetch it directly: list filters and empty lists must not block a link.
  useEffect(() => {
    const controller = new AbortController();
    setSelectedReceipt(null);
    setReceiptLoadError(null);
    setReceiptLoading(false);
    setShowReceiptDetail(requestedReceiptId !== null || invalidReceiptId);

    if (invalidReceiptId) {
      setReceiptLoadError("This receipt link has an invalid receipt ID.");
      return () => controller.abort();
    }
    if (requestedReceiptId === null) return () => controller.abort();

    setReceiptLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/receiving/${requestedReceiptId}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("This receipt was discarded or no longer exists.");
          }
          if (response.status === 401 || response.status === 403) {
            throw new Error("You do not have access to this receipt. Sign in with an authorized account and retry.");
          }
          throw new Error(`Could not load this receipt (HTTP ${response.status}). Please retry.`);
        }
        const receipt: unknown = await response.json();
        // A mismatched or incomplete response must never expose actions for a
        // different receipt. Existing command handlers receive a complete detail.
        if (
          !receipt || typeof receipt !== "object" ||
          !("id" in receipt) || receipt.id !== requestedReceiptId ||
          !("receiptNumber" in receipt) || typeof receipt.receiptNumber !== "string" ||
          !("status" in receipt) || typeof receipt.status !== "string" ||
          !("lines" in receipt) || !Array.isArray(receipt.lines)
        ) {
          throw new Error("The receipt response was incomplete. Please retry.");
        }
        if (!controller.signal.aborted) {
          setSelectedReceipt(receipt as ReceivingOrder);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setReceiptLoadError(
            error instanceof Error
              ? error.message
              : "Could not load this receipt. Check your connection and retry.",
          );
        }
      } finally {
        if (!controller.signal.aborted) setReceiptLoading(false);
      }
    })();

    // Rapid record changes must not let an older response replace the receipt
    // named in the current address.
    return () => controller.abort();
  }, [requestedReceiptId, invalidReceiptId, receiptLoadAttempt]);

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      <ProcurementContext navigation={procurementNavigation} />
      {!showReceiptDetail && !reverseTarget && reversalRecovery}
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
                          <Link href={receiptHref(receipt.id)} onClick={(event) => event.stopPropagation()} className="font-mono font-medium text-sm text-primary underline">
                            {receipt.receiptNumber}
                          </Link>
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
                          <span>Receive counts (mixed units): {receipt.receivedTotalUnits ?? "—"}/{receipt.expectedTotalUnits ?? "—"}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {format(new Date(receipt.createdAt), "MMM d, yyyy h:mm a")}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button asChild variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0">
                          <Link href={receiptHref(receipt.id)} onClick={(event) => event.stopPropagation()} aria-label={`Open receipt ${receipt.receiptNumber}`}>
                            <FileText className="h-4 w-4" />
                          </Link>
                        </Button>
                        {receipt.status === "draft" && (
                          <Button 
                            variant="ghost" 
                            size="sm"
                            className="min-h-[44px] min-w-[44px] p-0"
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              if (confirm(`Discard unused draft ${receipt.receiptNumber}?`)) {
                                discardReceiptMutation.mutate(receipt.id);
                              }
                            }}
                            disabled={quarantineCommandPending || discardReceiptMutation.isPending}
                            aria-label={`Discard draft ${receipt.receiptNumber}`}
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
                      <TableCell className="font-mono font-medium">
                        <Link href={receiptHref(receipt.id)} onClick={(event) => event.stopPropagation()} className="text-primary underline">
                          {receipt.receiptNumber}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{receipt.sourceType}</Badge>
                      </TableCell>
                      <TableCell>{receipt.vendor?.name || "-"}</TableCell>
                      <TableCell>{receipt.poNumber || "-"}</TableCell>
                      <TableCell>
                        {receipt.receivedLineCount || 0} / {receipt.expectedLineCount || 0}
                      </TableCell>
                      <TableCell>
                        {receipt.receivedTotalUnits ?? "—"} / {receipt.expectedTotalUnits ?? "—"}<div className="text-xs text-muted-foreground">Receive counts; may mix pack sizes</div>
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
                          <Button asChild variant="ghost" size="sm">
                            <Link href={receiptHref(receipt.id)} onClick={(event) => event.stopPropagation()} aria-label={`Open receipt ${receipt.receiptNumber}`}>
                              <FileText className="h-4 w-4" />
                            </Link>
                          </Button>
                          {receipt.status === "draft" && (
                            <Button 
                              variant="ghost" 
                              size="sm" 
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                if (confirm(`Discard unused draft ${receipt.receiptNumber}?`)) {
                                  discardReceiptMutation.mutate(receipt.id);
                                }
                              }}
                              disabled={quarantineCommandPending || discardReceiptMutation.isPending}
                              aria-label={`Discard draft ${receipt.receiptNumber}`}
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
            
            <div>
              <Label className="text-sm">Warehouse <span className="text-red-500">*</span></Label>
              <Select value={newReceipt.warehouseId} onValueChange={(v) => setNewReceipt({ ...newReceipt, warehouseId: v })}>
                <SelectTrigger className="h-11" data-testid="select-warehouse">
                  <SelectValue placeholder="Select warehouse..." />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id.toString()}>{w.name} ({w.code})</SelectItem>
                  ))}
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
                disabled={createReceiptMutation.isPending || !newReceipt.warehouseId}
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
      <Dialog open={showReceiptDetail} onOpenChange={(open) => { if (!open) closeReceiptDetail(); }}>
        <DialogContent className="min-w-0 max-w-4xl max-h-[90vh] overflow-y-auto overflow-x-hidden p-4 [&>*]:min-w-0">
          <div className="pr-6">
            <Button asChild variant="ghost" size="sm">
              <Link href={procurementNavigation.backHref("/receiving")}>
                {procurementNavigation.backLabel || "Back to receiving"}
              </Link>
            </Button>
          </div>
          <ProcurementContext navigation={procurementNavigation} />
          {!reverseTarget && reversalRecovery}
          {!selectedReceipt && (
            <>
              <DialogHeader>
                <DialogTitle>{receiptLoadError ? "Receipt unavailable" : "Loading receipt"}</DialogTitle>
                <DialogDescription>
                  {requestedReceiptId !== null ? `Receipt #${requestedReceiptId}` : "Receipt details"}
                </DialogDescription>
              </DialogHeader>
              {requestedReceiptId !== null && <ReceivingQuarantineRecoveryNotice key={requestedReceiptId} receiptId={requestedReceiptId} />}
              {receiptLoading && <p role="status" className="text-sm text-muted-foreground">Loading receipt details…</p>}
              {receiptLoadError && (
                <div className="space-y-3">
                  <p role="alert" className="text-sm text-destructive">{receiptLoadError}</p>
                  <div className="flex flex-wrap gap-2">
                    {!invalidReceiptId && (
                      <Button variant="outline" onClick={() => setReceiptLoadAttempt((attempt) => attempt + 1)}>Retry</Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
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
                       <span>PO: <Link href={procurementNavigation.childHref(`/purchase-orders/${selectedReceipt.purchaseOrderId}`)} className="text-primary underline">{selectedReceipt.poNumber || `#${selectedReceipt.purchaseOrderId}`}</Link></span>
                     ) : `PO: ${selectedReceipt.poNumber}`
                   ) : selectedReceipt.sourceType}
                  {selectedReceipt.vendor && ` • ${selectedReceipt.vendor.name}`}
                </DialogDescription>
              </DialogHeader>
              <nav aria-label="Receipt related records" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {selectedReceipt.status === "closed" && <SupplierReturnLink vendorId={selectedReceipt.vendorId ?? undefined} receivingOrderId={selectedReceipt.id} purchaseOrderId={selectedReceipt.purchaseOrderId ?? undefined} />}
                {selectedReceipt.purchaseOrderId && (
                  <Link href={procurementNavigation.childHref(`/purchase-orders/${selectedReceipt.purchaseOrderId}`)} className="text-primary underline">
                    Purchase order {selectedReceipt.poNumber || `#${selectedReceipt.purchaseOrderId}`}
                  </Link>
                )}
                {selectedReceipt.inboundShipmentId && (
                  <Link href={procurementNavigation.childHref(`/shipments/${selectedReceipt.inboundShipmentId}`)} className="text-primary underline">
                    Shipment #{selectedReceipt.inboundShipmentId}
                  </Link>
                )}
              </nav>

              <div className="space-y-4">
                {/* Action buttons */}
                <div className="flex gap-2 flex-wrap">
                  {selectedReceipt.status === "draft" && (
                    <>
                      {/* CSV bulk-entry builds the line list for blind/manual
                          receipts; a PO receipt is already populated from the PO,
                          so hide it here to keep the common flow clean. */}
                      {selectedReceipt.sourceType !== "po" && (
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
                            onClick={() => { setCsvImportError(null); setShowCSVImport(true); }}
                            data-testid="btn-import-csv"
                            disabled={quarantineCommandPending}
                          >
                            <Upload className="h-4 w-4 mr-1 md:mr-2" />
                            <span className="hidden sm:inline">Import</span> CSV
                          </Button>
                        </>
                      )}
                      <Button 
                        className="min-h-[44px] text-xs md:text-sm flex-1 sm:flex-none"
                        onClick={() => openReceiptMutation.mutate(selectedReceipt.id)}
                        disabled={quarantineCommandPending || openReceiptMutation.isPending}
                        data-testid="btn-open-receipt"
                      >
                        <Play className="h-4 w-4 mr-1 md:mr-2" />
                        Start
                      </Button>
                      {/* Discard draft — only when no lines have been received */}
                      {(selectedReceipt.lines && selectedReceipt.lines.every(l => (l.receivedQty ?? 0) === 0 && (l.damagedQty ?? 0) === 0 && (l.putawayComplete ?? 0) === 0)) && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              className="min-h-[44px] text-xs md:text-sm text-destructive hover:text-destructive hover:bg-destructive/10"
                              disabled={quarantineCommandPending || discardReceiptMutation.isPending}
                              data-testid="btn-discard-receipt"
                            >
                              <X className="h-4 w-4 mr-1 md:mr-2" />
                              Discard
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Discard this receipt?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Receipt <strong>{selectedReceipt.receiptNumber}</strong> will be permanently
                                deleted. No inventory changes have been made yet. This cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Keep receipt</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => discardReceiptMutation.mutate(selectedReceipt.id)}
                              >
                                {discardReceiptMutation.isPending ? "Discarding..." : "Yes, discard"}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </>
                  )}
                  {(selectedReceipt.status === "open" || selectedReceipt.status === "receiving") && (
                    <>
                      <Button 
                        variant="outline"
                        className="min-h-[44px] text-xs md:text-sm flex-1 sm:flex-none"
                        onClick={() => completeAllMutation.mutate({ orderId: selectedReceipt.id, lines: selectedReceipt.lines ?? [] })}
                        disabled={quarantineCommandPending || !quarantineAcceptAll.allowed || updateReceiptMutation.isPending || !!receiptSettingsError || completeAllMutation.isPending || updateLineMutation.isPending || reloadingUnits || Object.keys(countDrafts).length > 0 || Object.keys(unitErrors).length > 0 || !selectedReceipt.lines?.length || selectedReceipt.lines.some((line) => recordedReceivingFactor(line) === null || !hasReceivingUnitVersion(line))}
                        data-testid="btn-complete-all"
                      >
                        <CheckCircle className="h-4 w-4 mr-1 md:mr-2" />
                        Accept All Quantities
                      </Button>
                      <Button
                        className="min-h-[44px] text-xs md:text-sm flex-1 sm:flex-none"
                        onClick={handlePreCloseValidation}
                        disabled={quarantineCommandPending || updateReceiptMutation.isPending || !!receiptSettingsError || closeReceiptMutation.isPending || updateLineMutation.isPending || completeAllMutation.isPending || reloadingUnits || Object.keys(countDrafts).length > 0 || Object.keys(unitErrors).length > 0 || receiveUnitsNeedReview}
                        data-testid="btn-close-receipt"
                      >
                        <CheckCircle className="h-4 w-4 mr-1 md:mr-2" />
                        Finalize &amp; Update Inventory
                      </Button>
                    </>
                  )}
                  {selectedReceipt.status === "closed" && (
                    <Button
                      variant="outline"
                      className="min-h-[44px] text-xs md:text-sm flex-1 sm:flex-none text-destructive border-destructive/40 hover:bg-destructive/10"
                      onClick={() => {
                        setReverseError(null);
                        setReverseTarget({ scope: "order" });
                        setReverseQty("");
                        setReverseReason("");
                        setReverseAllowNegative(false);
                      }}
                      data-testid="btn-reverse-order"
                      disabled={quarantineCommandPending || reversalBlocked || !receiptReversalCapability.allowed}
                    >
                      <X className="h-4 w-4 mr-1 md:mr-2" />
                      Reverse Entire Receipt
                    </Button>
                  )}
                </div>

                {selectedReceipt.status === "closed" && !receiptReversalCapability.allowed && <div className="space-y-2 text-sm"><p>{receiptReversalCapability.reason}</p><Button variant="outline" size="sm" onClick={() => setReceiptLoadAttempt(attempt => attempt + 1)}>Reload receipt return history</Button></div>}
                {selectedReceipt.status === "closed" && !reversal.allowed && <p className="text-sm text-muted-foreground">Purchasing approval permission is required to reverse a receipt.</p>}
                {!quarantineAcceptAll.allowed && quarantineAcceptAll.reason && (selectedReceipt.status === "open" || selectedReceipt.status === "receiving") && <p className="text-sm text-muted-foreground">Accept all: {quarantineAcceptAll.reason}</p>}

                {selectedReceipt.status !== "closed" && (receiveUnitsNeedReview || Object.keys(countDrafts).length > 0 || Object.keys(unitErrors).length > 0) && (
                  <div className="space-y-2 rounded border border-amber-400/50 p-3 text-sm text-amber-800 dark:text-amber-200">
                    {Object.keys(countDrafts).length > 0 && <p>You have unsaved received counts. Use Confirm count beside each Received field, or press Enter in the field, before finalizing.</p>}
                    {(receiveUnitsNeedReview || Object.keys(unitErrors).length > 0) && <p>Confirm receive units and resolve line errors before finalizing. Load the latest receipt when a line requires refresh.</p>}
                  </div>
                )}

                {/* Receive-time validation warnings (Spec D, Part 2) — advisory,
                    never blocking. Shown inline before close. */}
                {selectedReceipt.status !== "closed" &&
                  selectedReceipt.status !== "cancelled" &&
                  (validationWarningsQuery.data?.length ?? 0) > 0 && (
                  <div className="p-3 rounded-lg border bg-amber-50 border-amber-200 text-amber-900 text-sm space-y-1" data-testid="receive-validation-warnings">
                    <div className="font-semibold flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      {validationWarningsQuery.data!.length} receive warning{validationWarningsQuery.data!.length !== 1 ? "s" : ""}
                    </div>
                    <ul className="list-disc pl-6 space-y-0.5">
                      {validationWarningsQuery.data!.map((w, i) => (
                        <li key={`${w.kind}-${w.receivingLineId}-${i}`} className={w.severity === "error" ? "text-red-700 font-medium" : ""}>
                          <span className="font-medium">{w.title}</span> — {w.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Source banner — where these goods (and their cost) come from */}
                {selectedReceipt.sourceType === "shipment" && selectedReceipt.status !== "closed" && (
                  <div className="flex items-start gap-2 p-3 rounded-lg border bg-blue-50 border-blue-200 text-blue-800 text-sm">
                    <Package className="h-4 w-4 mt-0.5 shrink-0 text-blue-600" />
                    <span>Receiving against an <strong>inbound shipment</strong>. Review freight and total costs from the linked shipment.</span>
                  </div>
                )}
                {selectedReceipt.sourceType === "po" && selectedReceipt.status !== "closed" && (
                  <div className="flex items-start gap-2 p-3 rounded-lg border bg-muted/40 text-muted-foreground text-sm">
                    <FileText className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>Receiving against <strong>PO {selectedReceipt.poNumber}</strong> directly — no inbound‑shipment freight applies on this receipt.</span>
                  </div>
                )}

                {(receiptSettingsError || closeIssues.length > 0) && (
                  <div role="alert" className="space-y-2 rounded border border-destructive/40 p-3 text-sm text-destructive">
                    {receiptSettingsError && <p>{receiptSettingsError}</p>}
                    {closeIssues.length > 0 && <><p className="font-medium">The last close attempt needs review.</p><ul className="list-disc pl-5">{closeIssues.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul></>}
                    <Button variant="outline" size="sm" disabled={quarantineCommandPending || updateReceiptMutation.isPending || updateLineMutation.isPending || closeReceiptMutation.isPending} onClick={() => {
                      setCountDrafts({});
                      setUnitErrors({});
                      setReceiptSettingsError(null);
                      setCloseIssues([]);
                      setReceiptLoadAttempt((attempt) => attempt + 1);
                    }}>Load latest receipt and discard unsaved counts</Button>
                  </div>
                )}

                {/* Warehouse & Default Location */}
                {selectedReceipt.status !== "closed" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 bg-muted/30 border rounded-lg">
                    <div>
                      <label className="text-[11px] font-semibold text-muted-foreground block mb-1">Receiving Warehouse</label>
                      <Select
                        value={selectedReceipt.warehouseId?.toString() || ""}
                        disabled={quarantineCommandPending || updateReceiptMutation.isPending || addLineMutation.isPending || bulkImportMutation.isPending || updateLineMutation.isPending || closeReceiptMutation.isPending || !!receiptSettingsError}
                        onValueChange={(v) => {
                          const warehouseId = parseInt(v);
                          updateReceiptMutation.mutate({
                            id: selectedReceipt.id,
                            updates: { warehouseId, receivingLocationId: null },
                          });
                        }}
                      >
                        <SelectTrigger className="h-9 text-xs" aria-label="Receiving warehouse">
                          <SelectValue placeholder="Select warehouse..." />
                        </SelectTrigger>
                        <SelectContent>
                          {warehouses.map((w) => (
                            <SelectItem key={w.id} value={w.id.toString()}>{w.name} ({w.code})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold text-muted-foreground block mb-1">Default Receiving Location</label>
                      <LocationTypeahead
                        locations={selectedReceipt.warehouseId ? locations.filter(l => l.warehouseId === selectedReceipt.warehouseId) : locations}
                        value={selectedReceipt.receivingLocationId ?? null}
                        ariaLabel="Default receiving location"
                        disabled={quarantineCommandPending || updateReceiptMutation.isPending || addLineMutation.isPending || bulkImportMutation.isPending || updateLineMutation.isPending || closeReceiptMutation.isPending || !!receiptSettingsError || Object.keys(countDrafts).length > 0}
                        onChange={(locationId) => {
                          updateReceiptMutation.mutate({
                            id: selectedReceipt.id,
                            updates: { receivingLocationId: locationId, ...(locationId === null ? {} : { applyDefaultToUnassigned: true }) },
                          });
                        }}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">Fills lines without a location. Existing line locations are preserved. Save any count drafts first.</p>
                    </div>
                  </div>
                )}

                {/* Lines section */}
                <Card className="min-w-0 max-w-full">
                  <CardHeader className="p-3 md:pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-sm md:text-base">Lines ({selectedReceipt.lines?.length || 0})</CardTitle>
                    {selectedReceipt.status !== "closed" && (
                      <Button 
                        variant="outline" 
                        size="sm"
                        className="min-h-[44px]"
                        onClick={() => setShowAddLineDialog(true)}
                        disabled={quarantineCommandPending || updateReceiptMutation.isPending || !!receiptSettingsError || closeReceiptMutation.isPending}
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
                  <CardContent className="min-w-0 max-w-full p-0">
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
                              {renderUnitControl(line)}
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div>
                                  <Label className="text-xs text-muted-foreground">Expected receive units</Label>
                                  <div className="font-medium">{line.expectedQty}</div>
                                </div>
                                <div>
                                  <Label className="text-xs text-muted-foreground">Received</Label>
                                  {renderReceivedCount(line, "mobile")}
                                </div>
                              </div>
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex-1">
                                  <Label className="text-xs text-muted-foreground">Location</Label>
                                  <div className="mt-1">
                                    {(selectedReceipt.status === "open" || selectedReceipt.status === "receiving") ? (
                                      <>
                                      <LocationTypeahead
                                        locations={selectedReceipt?.warehouseId ? locations.filter(l => l.warehouseId === selectedReceipt.warehouseId) : locations}
                                        value={line.putawayLocationId}
                                        onChange={(locationId) => updateLineMutation.mutate({
                                          lineId: line.id,
                                          updates: { putawayLocationId: locationId }
                                        })}
                                        disabled={quarantineCommandPending || updateReceiptMutation.isPending || updateLineMutation.isPending || closeReceiptMutation.isPending || !!receiptSettingsError}
                                      />
                                      {selectedReceipt.receivingLocationId && !line.putawayLocationId && (
                                        <button
                                          className="text-[10px] text-primary mt-1 hover:underline"
                                          disabled={quarantineCommandPending || updateReceiptMutation.isPending || updateLineMutation.isPending || closeReceiptMutation.isPending || !!receiptSettingsError}
                                          onClick={() => updateLineMutation.mutate({
                                            lineId: line.id,
                                            updates: { putawayLocationId: selectedReceipt.receivingLocationId }
                                          })}
                                        >
                                          Use default ({locations.find(l => l.id === selectedReceipt.receivingLocationId)?.code})
                                        </button>
                                      )}
                                    </>
                                    ) : (
                                      <span className="text-sm">
                                        {line.putawayLocationId
                                          ? locations.find(l => l.id === line.putawayLocationId)?.code || "Set"
                                          : (selectedReceipt.status === "closed" ? "Via CSV" : "—")
                                        }
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {selectedReceipt.status === "closed" &&
                                  ((line.receivedQty ?? 0) - (line.reversedQty ?? 0)) > 0 && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="min-h-[44px] text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={() => {
                                      const remaining = (line.receivedQty ?? 0) - (line.reversedQty ?? 0);
                                      setReverseError(null);
                                      setReverseTarget({
                                        scope: "line",
                                        lineId: line.id,
                                        lineLabel: line.sku || `Line #${line.id}`,
                                        maxQty: remaining,
                                      });
                                      setReverseQty(String(remaining));
                                      setReverseReason("");
                                      setReverseAllowNegative(false);
                                    }}
                                    data-testid={`btn-reverse-line-mobile-${line.id}`}
                                    disabled={quarantineCommandPending || reversalBlocked || !receiptReversalSourceCapability(line.reversalCapability).allowed}
                                  >
                                    <X className="h-4 w-4 mr-1" />
                                    Reverse
                                  </Button>
                                )}
                                {selectedReceipt.status === "closed" && !receiptReversalSourceCapability(line.reversalCapability).allowed && <p className="text-xs text-muted-foreground">{receiptReversalSourceCapability(line.reversalCapability).reason}</p>}
                                {selectedReceipt.status === "closed" && (line.reversedQty ?? 0) > 0 && (
                                  <span className="text-xs text-destructive font-medium">−{line.reversedQty} reversed</span>
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
                          <TableHead>Receive in</TableHead>
                          <TableHead>Expected</TableHead>
                          <TableHead>Received</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead>Status</TableHead>
                          {selectedReceipt.status === "closed" && <TableHead>Reversed</TableHead>}
                          {selectedReceipt.status === "closed" && <TableHead></TableHead>}
                          {selectedReceipt.status !== "closed" && <TableHead>Issues</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedLines.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={selectedReceipt.status === "closed" ? 9 : 8} className="text-center text-muted-foreground py-8">
                              No lines yet. Import CSV or add lines manually.
                            </TableCell>
                          </TableRow>
                        ) : (
                          sortedLines.map((line) => (
                            <TableRow key={line.id}>
                              <TableCell className="font-mono whitespace-nowrap">{line.sku || "-"}</TableCell>
                              <TableCell>{line.productName || "-"}</TableCell>
                              <TableCell className="min-w-64">{renderUnitControl(line)}</TableCell>
                              <TableCell className="whitespace-nowrap"><b>{line.expectedQty}</b> receive units</TableCell>
                              <TableCell>
                                {renderReceivedCount(line, "desktop")}
                              </TableCell>
                              <TableCell>
                                {(selectedReceipt.status === "open" || selectedReceipt.status === "receiving") ? (
                                  <LocationTypeahead
                                    locations={selectedReceipt.warehouseId ? locations.filter(l => l.warehouseId === selectedReceipt.warehouseId) : locations}
                                    value={line.putawayLocationId}
                                    onChange={(locationId) => updateLineMutation.mutate({
                                      lineId: line.id,
                                      updates: { putawayLocationId: locationId }
                                    })}
                                    disabled={quarantineCommandPending || updateReceiptMutation.isPending || updateLineMutation.isPending || closeReceiptMutation.isPending || !!receiptSettingsError}
                                  />
                                ) : (
                                  <span className="text-sm text-muted-foreground">
                                    {line.putawayLocationId
                                      ? locations.find(l => l.id === line.putawayLocationId)?.code || "Set"
                                      : (selectedReceipt.status === "closed" ? "Via CSV" : "—")
                                    }
                                  </span>
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
                              {selectedReceipt.status === "closed" && (
                                <TableCell>
                                  {(line.reversedQty ?? 0) > 0 ? (
                                    <span className="text-xs text-destructive font-medium" data-testid={`reversed-qty-${line.id}`}>
                                      −{line.reversedQty} reversed
                                    </span>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                              )}
                              {selectedReceipt.status === "closed" && (
                                <TableCell>
                                  {((line.receivedQty ?? 0) - (line.reversedQty ?? 0)) > 0 && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="min-h-[44px] text-destructive hover:text-destructive hover:bg-destructive/10"
                                      onClick={() => {
                                        const remaining = (line.receivedQty ?? 0) - (line.reversedQty ?? 0);
                                        setReverseError(null);
                                        setReverseTarget({
                                          scope: "line",
                                          lineId: line.id,
                                          lineLabel: line.sku || `Line #${line.id}`,
                                          maxQty: remaining,
                                        });
                                        setReverseQty(String(remaining));
                                        setReverseReason("");
                                        setReverseAllowNegative(false);
                                      }}
                                      data-testid={`btn-reverse-line-${line.id}`}
                                      disabled={quarantineCommandPending || reversalBlocked || !receiptReversalSourceCapability(line.reversalCapability).allowed}
                                    >
                                      <X className="h-4 w-4 mr-1" />
                                      Reverse
                                    </Button>
                                  )}
                                  {!receiptReversalSourceCapability(line.reversalCapability).allowed && <p className="text-xs text-muted-foreground">{receiptReversalSourceCapability(line.reversalCapability).reason}</p>}
                                </TableCell>
                              )}
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
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                {selectedReceipt.status === "closed" && <ReceiptSupplierCosts
                  key={selectedReceipt.id}
                  receiptId={selectedReceipt.id}
                  purchaseOrderId={selectedReceipt.purchaseOrderId ?? null}
                  shipmentId={selectedReceipt.inboundShipmentId ?? null}
                  navigation={procurementNavigation}
                />}
                <ReceivingQuarantinePanel
                  key={`${selectedReceipt.id}:${location}?${searchStr}`}
                  receipt={selectedReceipt}
                  locations={locations}
                  disabled={!!reversal.recovery || !!reversal.error || updateReceiptMutation.isPending || updateLineMutation.isPending || closeReceiptMutation.isPending || completeAllMutation.isPending || addLineMutation.isPending || bulkImportMutation.isPending || reverseMutation.isPending || openReceiptMutation.isPending || discardReceiptMutation.isPending || reloadingUnits || !!receiptSettingsError || Object.keys(countDrafts).length > 0 || Object.keys(unitErrors).length > 0}
                  onCommandPendingChange={setQuarantineCommandPending}
                  onAcceptAllCapabilityChange={setQuarantineAcceptAll}
                  onReceiptChanged={refreshReceiptAfterQuarantine}
                />

                {/* Reversal history (Spec D) — closed receipts only. */}
                {selectedReceipt.status === "closed" && (
                  <Card>
                    <CardHeader className="p-3 md:pb-2">
                      <CardTitle className="text-sm md:text-base">Reversal History</CardTitle>
                      <CardDescription className="text-xs">
                        Compensating corrections applied to this posted receipt. The original received quantities remain recorded.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-3 pt-0">
                      {reversalsQuery.isPending && <p role="status" className="text-sm">Loading receipt reversal history…</p>}
                      {reversalsQuery.isError && <div role="alert" className="space-y-2 text-sm">
                        <p className="text-destructive">{reversalsQuery.error instanceof Error ? reversalsQuery.error.message : "Receipt reversal history could not be loaded."}</p>
                        <Button type="button" variant="outline" disabled={reversalsQuery.isFetching} onClick={() => void reversalsQuery.refetch()}>Retry receipt reversal history</Button>
                      </div>}
                      {reversalsQuery.isSuccess && reversalsQuery.data.length === 0 && <p className="text-sm text-muted-foreground">No receipt reversals recorded.</p>}
                      <div className="space-y-2" data-testid="reversal-history">
                        {(reversalsQuery.isSuccess ? reversalsQuery.data : []).map((rev) => {
                          const line = selectedReceipt.lines?.find((l) => l.id === rev.receivingLineId);
                          return (
                            <div key={rev.id} className="flex items-start gap-2 p-2 rounded border bg-destructive/5 border-destructive/20 text-sm">
                              <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                              <div className="flex-1">
                                <div>
                                  <span className="font-medium">−{rev.qty}</span>{" "}
                                  {line?.sku ?? `line #${rev.receivingLineId}`}
                                  {rev.baseUnitsReversed !== null && rev.baseUnitsReversed !== rev.qty && (
                                    <span className="text-muted-foreground"> ({rev.baseUnitsReversed} pieces)</span>
                                  )}
                                  {rev.reversalScope === "order" && (
                                    <Badge variant="outline" className="ml-2 text-[10px]">order reversal</Badge>
                                  )}
                                  {rev.allowNegative && (
                                    <Badge variant="destructive" className="ml-2 text-[10px]">negative override</Badge>
                                  )}
                                  {rev.apReconciliationReopened && (
                                    <Badge variant="outline" className="ml-2 text-[10px]">AP re-opened</Badge>
                                  )}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {rev.reason} — {rev.createdBy ?? "system"},{" "}
                                  {rev.createdAt ? format(new Date(rev.createdAt), "MMM d, yyyy h:mm a") : ""}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Reversal modal (Spec D) — qty defaults to remaining reversible; reason
          required; shows exactly what will be decremented before confirming. */}
      <Dialog open={!!reverseTarget} onOpenChange={(open) => { if (!open) setReverseTarget(null); }}>
        <DialogContent className="max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto min-w-0 p-4">
          <DialogHeader>
            <DialogTitle>
              {reverseTarget?.scope === "order" ? "Reverse entire receipt" : `Reverse ${reverseTarget?.lineLabel ?? "line"}`}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Posts a compensating reversal: inventory lots are decremented at their original cost and the
              linked PO line's received quantity is reduced. The original receipt quantities remain recorded.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {reversalRecovery}
            {reverseTarget?.scope === "line" && (
              <div>
                <Label htmlFor="reverse-qty" className="text-xs">Quantity to reverse (max {reverseTarget.maxQty})</Label>
                <Input
                  id="reverse-qty"
                  type="number"
                  min={1}
                  max={reverseTarget.maxQty}
                  value={reverseQty}
                  onChange={(e) => setReverseQty(e.target.value)}
                  className="h-10"
                  disabled={reversalBlocked}
                  data-testid="input-reverse-qty"
                />
              </div>
            )}
            {reverseTarget?.scope === "order" && (
              <div className="text-sm text-muted-foreground">
                Every line with remaining reversible quantity will be reversed in full.
              </div>
            )}
            <div>
              <Label htmlFor="reverse-reason" className="text-xs">Reason (required)</Label>
              <Textarea
                id="reverse-reason"
                value={reverseReason}
                onChange={(e) => setReverseReason(e.target.value)}
                placeholder="e.g. Case variant misconfigured as base unit — rebooking as cases"
                className="min-h-[80px]"
                maxLength={RECEIPT_REVERSAL_MAX_REASON_LENGTH}
                disabled={reversalBlocked}
                data-testid="input-reverse-reason"
              />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={reverseAllowNegative}
                onChange={(e) => setReverseAllowNegative(e.target.checked)}
                className="mt-1"
                disabled={reversalBlocked}
                data-testid="input-reverse-allow-negative"
              />
              <span>
                Allow negative inventory override{" "}
                <span className="text-xs text-muted-foreground">
                  (audited; inventory safeguards may block this override)
                </span>
              </span>
            </label>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setReverseTarget(null)} data-testid="btn-reverse-cancel">
                {reversal.recovery ? "Close" : "Cancel"}
              </Button>
              <Button
                variant="destructive"
                disabled={
                  quarantineCommandPending ||
                  reversalBlocked ||
                  reverseReason.trim().length === 0 ||
                  (reverseTarget?.scope === "line" &&
                    (!Number.isInteger(Number(reverseQty)) ||
                      Number(reverseQty) <= 0 ||
                      Number(reverseQty) > (reverseTarget.maxQty ?? 0)))
                }
                onClick={() => {
                  if (!reverseTarget || !selectedReceipt || reversalBlocked) return;
                  try {
                    if (reverseTarget.scope === "line") assertReceiptReversalLineTarget(selectedReceipt.id, reverseTarget.lineId!, selectedReceipt.lines ?? []);
                    const payload = { reason: reverseReason.trim(), allowNegative: reverseAllowNegative };
                    submitReversal(reverseTarget.scope === "line"
                      ? { action: "line", receivingOrderId: selectedReceipt.id, targetId: reverseTarget.lineId!, payload: { ...payload, qty: Number(reverseQty) } }
                      : { action: "order", receivingOrderId: selectedReceipt.id, targetId: selectedReceipt.id, payload });
                  } catch (error) { setReverseError(error instanceof Error ? error.message : "The reversal target could not be verified."); }
                }}
                data-testid="btn-reverse-confirm"
              >
                {reverseMutation.isPending ? "Reversing..." : "Confirm reversal"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* CSV Import Dialog */}
      <Dialog open={showCSVImport} onOpenChange={(open) => {
        // Keep pending results visible; browser navigation still ends this
        // receipt visit and the existing visit guard rejects late callbacks.
        if (!bulkImportMutation.isPending) setShowCSVImport(open);
      }}>
        <DialogContent className="max-w-md md:max-w-2xl max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Import from CSV</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              Paste CSV data with columns: sku, qty, location (optional). Qty and damaged_qty are total counts of the selected SKU variant, replacing a single matching receipt line. Use one row per SKU/location. Separate physical lines must be edited individually. unit_cost is the cost per piece, not per case.
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
                    disabled={bulkImportMutation.isPending || csvFileReadPending}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const context = captureReceiptNavigation();
                        const reader = new FileReader();
                        setCsvFileReadPending(true);
                        reader.onload = (event) => {
                          if (!isCurrentReceiptNavigation(context)) return;
                          setCsvFileReadPending(false);
                          setCsvText(event.target?.result as string || "");
                        };
                        const reportFileReadError = () => {
                          if (!isCurrentReceiptNavigation(context)) return;
                          setCsvFileReadPending(false);
                          setCsvImportError("The CSV file could not be read. Choose the file again or paste its contents.");
                        };
                        reader.onerror = reportFileReadError;
                        try { reader.readAsText(file); } catch { reportFileReadError(); }
                      }
                    }}
                    data-testid="input-csv-file"
                  />
                </label>
              </div>
            </div>

            <div className="text-center text-xs text-muted-foreground">— or paste directly —</div>
            
            {csvImportError && <div role="alert" className="whitespace-pre-wrap rounded border border-destructive p-3 text-sm text-destructive" data-testid="csv-import-error">{csvImportError}</div>}
            {csvFileReadPending && <p role="status" className="text-sm text-muted-foreground">Reading CSV file.</p>}
            {bulkImportMutation.isPending && <p role="status" className="text-sm text-muted-foreground">Importing. Keep this dialog open until the result is confirmed.</p>}
            <Textarea 
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              disabled={bulkImportMutation.isPending || csvFileReadPending}
              placeholder="Paste your CSV data here..."
              className="min-h-[150px] md:min-h-[200px] font-mono text-xs md:text-sm"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-testid="textarea-csv"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" className="min-h-[44px]" disabled={bulkImportMutation.isPending} onClick={() => setShowCSVImport(false)}>Cancel</Button>
              <Button 
                className="min-h-[44px]"
                onClick={handleCSVImport}
                disabled={quarantineCommandPending || updateReceiptMutation.isPending || !!receiptSettingsError || closeReceiptMutation.isPending || bulkImportMutation.isPending || csvFileReadPending || !csvText.trim()}
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
      <Dialog open={showAddLineDialog} onOpenChange={(open) => { setShowAddLineDialog(open); if (!open) setAddLineError(null); }}>
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
                            expectedUnitsPerVariant: item.unitsPerVariant,
                          });
                          setAddLineError(null);
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
                  <div>{newLine.expectedUnitsPerVariant ? "Each count is one receive unit containing " + newLine.expectedUnitsPerVariant + " pieces." : "Refresh and reselect this SKU before adding a line."}</div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-sm">{selectedReceipt?.sourceType === "blind" ? "Quantity in selected receive units" : "Expected quantity in selected receive units"}</Label>
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
                  For initial inventory loads, this counts the selected SKU variant. The receipt will also show its base-piece total.
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-sm">Put-away Location <span className="text-red-500">*</span></Label>
              <InventoryLocationCombobox
                locations={warehouseFilteredLocations}
                value={newLine.putawayLocationId ? Number(newLine.putawayLocationId) : null}
                onValueChange={(locationId) => setNewLine({
                  ...newLine,
                  putawayLocationId: locationId === null ? "" : String(locationId),
                })}
                ariaLabel="Put-away location"
                placeholder="Select put-away location"
                searchPlaceholder="Search put-away locations..."
                emptyMessage="No matching put-away locations found."
                triggerClassName="h-11"
              />
            </div>

            {addLineError && <div role="alert" className="rounded border border-destructive/40 p-3 text-sm text-destructive">
              {addLineError}
              <Button variant="outline" className="mt-2" disabled={addLineMutation.isPending} onClick={() => handleSkuSearch(skuSearch)}>Refresh selected SKU</Button>
            </div>}
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" className="min-h-[44px]" onClick={() => {
                setShowAddLineDialog(false);
                setSkuSearch("");
                setSkuResults([]);
                setNewLine({
                  sku: "",
                  productName: "",
                  expectedQty: "1",
                  putawayLocationId: "",
                  productId: null,
                  productVariantId: null,
                  expectedUnitsPerVariant: null,
                });
              }}>
                Cancel
              </Button>
              <Button 
                className="min-h-[44px]"
                onClick={() => {
                  if (!selectedReceipt || !newLine.sku) return;
                  let qty: number;
                  try { qty = receivingAddQuantity(newLine.expectedQty); if (newLine.productVariantId !== null) receivingSelectedFactor(newLine.expectedUnitsPerVariant); }
                  catch (cause) { toast({ title: "Invalid quantity", description: cause instanceof Error ? cause.message : "Enter a positive whole quantity.", variant: "destructive" }); return; }
                  const isBlind = selectedReceipt.sourceType === "blind";
                  addLineMutation.mutate({
                    orderId: selectedReceipt.id,
                    line: {
                      sku: newLine.sku,
                      productName: newLine.productName,
                      expectedQty: qty,
                      receivedQty: isBlind ? qty : 0,
                      putawayLocationId: newLine.putawayLocationId ? parseInt(newLine.putawayLocationId) : null,
                      productId: newLine.productId,
                      productVariantId: newLine.productVariantId,
                      ...(newLine.productVariantId !== null ? { expectedUnitsPerVariant: newLine.expectedUnitsPerVariant } : {}),
                    },
                  });
                }}
                disabled={quarantineCommandPending || updateReceiptMutation.isPending || !!receiptSettingsError || closeReceiptMutation.isPending || !newLine.sku || !newLine.putawayLocationId || newLine.productVariantId !== null && !newLine.expectedUnitsPerVariant || addLineMutation.isPending}
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
              Saved rows: {(importResults?.created || 0) + (importResults?.updated || 0)}. Rows not imported: {importResults?.errors.length || 0}.
              {importResults?.errors.length ? " Review the failed rows before importing again. A unique SKU/location replaces its total count on retry; it does not add the count again." : ""}
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
            {!!importResults?.errors.length && !!csvText.trim() && <Button variant="outline" className="min-h-[44px]" onClick={() => {
              setShowImportResults(false);
              setCsvImportError(null);
              setShowCSVImport(true);
            }} data-testid="btn-review-import-csv">Review CSV</Button>}
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
                        setLegacyResolveVariant(r.productVariantId);
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

              {legacyResolveVariant !== null && (() => {
                const candidate = variants.find((variant) => variant.id === legacyResolveVariant);
                const result = resolveSkuResults.find((variant) => variant.productVariantId === legacyResolveVariant);
                const label = candidate ? candidate.name + " (" + candidate.unitsPerVariant + " pieces)" : result ? result.name + (result.unitsPerVariant ? " (" + result.unitsPerVariant + " pieces)" : "") : "the selected variant";
                const legacy = recordedReceivingFactor(resolvingLine) === null;
                return <div className="rounded border border-amber-400/50 p-3 text-sm space-y-2">
                  <p>{legacy ? "The count basis was not recorded. Confirm these existing counts only if the source document proves their unit. Counts will stay unchanged." : "The server will preserve expected, received and damaged piece totals, or reject a conversion that is not exact."}</p>
                  <p>Expected {resolvingLine.expectedQty}; received {resolvingLine.receivedQty}; damaged {resolvingLine.damagedQty}.</p>
                  <Button className="h-auto min-h-10 whitespace-normal" disabled={quarantineCommandPending || updateLineMutation.isPending || completeAllMutation.isPending || reloadingUnits || !!unitErrors[resolvingLine.id]?.needsRefresh} onClick={() => applyVariant(resolvingLine, legacyResolveVariant, legacy, candidate?.unitsPerVariant ?? result?.unitsPerVariant)}>
                    {legacy ? "Confirm these counts are in " : "Apply receive variant: "}{label}
                  </Button>
                </div>;
              })()}
              {unitErrors[resolvingLine.id] && <div role="alert" className="text-sm text-destructive">
                {unitErrors[resolvingLine.id].message}
                {unitErrors[resolvingLine.id].needsRefresh && <Button variant="outline" className="mt-2 h-auto whitespace-normal" disabled={reloadingUnits} onClick={() => void reloadReceiptUnits(resolvingLine.id)}>Load latest line and discard count draft</Button>}
              </div>}

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
                        Creates the catalog product and variant only. Confirm the receive unit separately before linking this line.
                      </p>
                      <Button
                        className="w-full min-h-[44px]"
                        onClick={() => createVariantMutation.mutate(resolvingLine.id)}
                        disabled={quarantineCommandPending || createVariantMutation.isPending}
                      >
                        {createVariantMutation.isPending ? (
                          <><span className="animate-spin mr-2">⏳</span> Creating...</>
                        ) : (
                          <><Plus className="h-4 w-4 mr-2" /> Create catalog variant</>
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
              <InventoryLocationCombobox
                locations={warehouseFilteredLocations}
                value={resolvingLine.putawayLocationId}
                onValueChange={(locationId) => {
                  if (locationId === null) return;
                  const location = warehouseFilteredLocations.find((candidate) => candidate.id === locationId);
                  updateLineMutation.mutate({
                    lineId: resolvingLine.id,
                    updates: { putawayLocationId: locationId },
                  });
                  setShowResolveDialog(false);
                  toast({
                    title: "Location set",
                    description: `${resolvingLine.sku} → ${location?.code ?? locationId}`,
                  });
                }}
                ariaLabel={`Put-away location for ${resolvingLine.sku}`}
                placeholder="Select put-away location"
                searchPlaceholder="Search put-away locations..."
                emptyMessage="No matching put-away locations found."
                triggerClassName="h-11"
                contentClassName="min-w-80"
              />
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

      {/* Over-receipt confirmation: shipment receipts refuse to close with more
          than the shipment expects unless the operator explicitly confirms. */}
      <AlertDialog open={!!overReceiptPrompt} onOpenChange={(open) => { if (!open) setOverReceiptPrompt(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Received more than this shipment expects</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  The overage may belong to another PO on this shipment — or the PO quantity itself
                  is wrong. Double-check before closing:
                </p>
                <ul className="list-disc pl-5 text-sm">
                  {(overReceiptPrompt?.overLines ?? []).map((l, idx) => (
                    <li key={idx}>
                      <span className="font-mono">{l.sku ?? "(no SKU)"}</span>: expected {l.expectedQty.toLocaleString()},
                      entered {l.receivedQty.toLocaleString()} (+{(l.receivedQty - l.expectedQty).toLocaleString()})
                    </li>
                  ))}
                </ul>
                <p className="text-sm">
                  Closing anyway books the full entered quantity to this PO and flags a quantity-over exception.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back and fix quantities</AlertDialogCancel>
            <AlertDialogAction
              disabled={quarantineCommandPending}
              onClick={() => {
                const id = overReceiptPrompt?.id;
                setOverReceiptPrompt(null);
                if (id) closeReceiptMutation.mutate({ id, allowOverReceipt: true });
              }}
            >
              Close anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Multi-PO shipment chaining: after closing one PO's receipt, offer the
          next PO with unreceived lines on the same shipment. */}
      <AlertDialog open={!!nextPoPrompt} onOpenChange={(open) => {
        if (receiveNextPoMutation.isPending) return;
        if (!open && nextPoPrompt) {
          navigate(nextPoPrompt.returnHref);
          setNextPoPrompt(null);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Shipment has more to receive</AlertDialogTitle>
            <AlertDialogDescription>
              {nextPoPrompt?.shipmentNumber ? `Shipment ${nextPoPrompt.shipmentNumber}` : "This shipment"} still has{" "}
              {Number(nextPoPrompt?.option?.remainingBaseQty ?? 0).toLocaleString()} unreceived unit(s) across{" "}
              {nextPoPrompt?.option?.lineCount ?? 0} line(s) on{" "}
              {nextPoPrompt?.option?.poNumber ?? `PO #${nextPoPrompt?.option?.purchaseOrderId}`}. Receive it now?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={receiveNextPoMutation.isPending}>Later</AlertDialogCancel>
            <AlertDialogAction
              disabled={receiveNextPoMutation.isPending}
              onClick={(event) => {
                // Keep this prompt mounted until the request resolves. The
                // cancel/escape route remains the original purchase context.
                event.preventDefault();
                if (!nextPoPrompt) return;
                receiveNextPoMutation.mutate({
                  shipmentId: nextPoPrompt.shipmentId,
                  purchaseOrderId: nextPoPrompt.option.purchaseOrderId,
                });
              }}
            >
              {receiveNextPoMutation.isPending ? "Creating…" : "Receive next PO"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
