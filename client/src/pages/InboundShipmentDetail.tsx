import { InboundShipmentTracking } from "@/components/purchasing/InboundShipmentTracking";
import { parseShipmentReceiptResolution, requiresReceiptUnitReview, shipmentReceiveCoverageLabel } from "@/lib/shipment-receipt-units";
import { formatMills } from "@shared/utils/money";
import { useEffect, useMemo, useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { parseProcurementJourney, procurementRecordHref } from "@/lib/procurement-navigation";
import { ProcurementContext } from "@/components/procurement-context";
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
import { useAuth } from "@/lib/auth";
import { createShipmentCostRecoveryStore, type ShipmentCostCreateRecovery } from "@/lib/shipment-cost-create-recovery";
import {
  createShipmentCostCommandClient,
  createShipmentCostPayload,
  effectiveShipmentCostCents,
  deleteShipmentCostPayload,
  canEditShipmentCostEconomics,
  shipmentCostEditorFromRecord,
  shipmentCostFormFromCreate,
  shipmentCostNeedsRefresh,
  updateShipmentCostPayload,
  type ShipmentCostEditor,
  type ShipmentCostForm,
} from "@/lib/shipment-cost-command";
import { AddInvoiceFromCostsModal } from "@/components/shipment/AddInvoiceFromCostsModal";
import {
  ShipmentReceiptPackResolutionDialog,
  type ShipmentReceiptPackResolution,
  type ShipmentReceiptPackResolutionLine,
} from "@/components/purchasing/ShipmentReceiptPackResolutionDialog";
import { format } from "date-fns";
import { useShipmentLineActions } from "@/features/purchasing/use-shipment-line-actions";
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
  { value: "dimensions_adjustment", label: "Dimensions Adjustment" },
  { value: "duty", label: "Duty" },
  { value: "insurance", label: "Insurance" },
  { value: "brokerage", label: "Brokerage" },
  { value: "platform_fee", label: "Platform Fee" },
  { value: "port_handling", label: "Port Handling" },
  { value: "drayage", label: "Drayage" },
  { value: "warehousing", label: "Warehousing" },
  { value: "inspection", label: "Inspection" },
  { value: "other", label: "Other" },
];

const MODE_DEFAULT_ALLOCATION: Record<string, string> = {
  sea_fcl: "by_volume",
  sea_lcl: "by_volume",
  air: "by_chargeable_weight",
  ground: "by_weight",
  ltl: "by_weight",
  ftl: "by_weight",
  parcel: "by_weight",
  courier: "by_weight",
};

const ALLOCATION_METHOD_LABELS: Record<string, string> = {
  by_volume: "By Volume",
  by_weight: "By Weight",
  by_chargeable_weight: "By Chargeable Weight",
  by_value: "By Value",
  by_line_count: "By Line Count",
};

// Cost types that force a specific allocation method
const COST_TYPE_ALLOCATION_OVERRIDES: Record<string, string> = {
  duty: "by_value",
  brokerage: "by_line_count",
  inspection: "by_line_count",
  platform_fee: "by_line_count",
};

const ALLOCATION_METHOD_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "by_volume", label: "By Volume" },
  { value: "by_weight", label: "By Weight" },
  { value: "by_chargeable_weight", label: "By Chargeable Weight" },
  { value: "by_value", label: "By Value" },
  { value: "by_line_count", label: "By Line Count" },
];

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

type LandedCostPushResult = {
  updated: number;
  total: number;
  skipped?: Array<{
    lotId: number;
    productVariantId: number | null;
    reason: string;
    lineIds?: number[];
  }>;
};

type AllocationStatus = {
  status: "blocked" | "no_costs" | "needs_allocation" | "allocated_with_warnings" | "allocated";
  lineCount: number;
  costCount: number;
  allocatableCostCount: number;
  effectiveCostCents: number;
  allocatedCostCents: number;
  unallocatedCents: number;
  blockerCount: number;
  warningCount: number;
  costs: Array<{
    costId: number;
    costType: string;
    description?: string | null;
    effectiveCents: number;
    allocatedCents: number;
    allocationCount: number;
    method: string;
    methodSource: string;
    rawBasisTotal: number;
    basisTotal: number;
    usedFallback: boolean;
    status: string;
  }>;
  issues: Array<{
    severity: "blocker" | "warning";
    code: string;
    message: string;
    costId?: number;
    lineId?: number;
  }>;
};

const ALLOCATION_STATUS_LABELS: Record<AllocationStatus["status"], string> = {
  blocked: "Blocked",
  no_costs: "No Costs",
  needs_allocation: "Needs Allocation",
  allocated_with_warnings: "Allocated With Warnings",
  allocated: "Allocated",
};

const ALLOCATION_COST_STATUS_LABELS: Record<string, string> = {
  zero_amount: "Zero Amount",
  needs_allocation: "Needs Allocation",
  stale_allocation: "Stale Allocation",
  stale_allocation_basis: "Stale Basis",
  allocation_mismatch: "Mismatch",
  allocated_with_fallback: "Even Split",
  allocated: "Allocated",
};

function compareShipmentLinesByEntryOrder(a: any, b: any): number {
  const aCreatedAt = Date.parse(a?.createdAt ?? "");
  const bCreatedAt = Date.parse(b?.createdAt ?? "");
  const aHasCreatedAt = Number.isFinite(aCreatedAt);
  const bHasCreatedAt = Number.isFinite(bCreatedAt);

  if (aHasCreatedAt && bHasCreatedAt && aCreatedAt !== bCreatedAt) {
    return aCreatedAt - bCreatedAt;
  }
  if (aHasCreatedAt !== bHasCreatedAt) {
    return aHasCreatedAt ? -1 : 1;
  }

  return Number(a?.id ?? 0) - Number(b?.id ?? 0);
}

const LANDED_COST_SKIP_LABELS: Record<string, string> = {
  ambiguous_variant_landed_cost: "Ambiguous same-SKU landed cost",
  invalid_lot_variant: "Invalid lot variant",
  landed_cost_not_finalized: "Landed cost not finalized",
  no_matching_finalized_landed_cost: "No finalized landed cost match",
};

function formatLandedCostSkipReason(reason: string) {
  return LANDED_COST_SKIP_LABELS[reason] || reason.replace(/_/g, " ");
}

const PAYMENT_STATUS_BADGES: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive"; className?: string }> = {
  unlinked: { label: "—", variant: "outline" },
  unpaid: { label: "Unpaid", variant: "outline", className: "border-amber-500 text-amber-600" },
  partial: { label: "Partial", variant: "outline", className: "border-yellow-500 text-yellow-600" },
  paid: { label: "Paid", variant: "outline", className: "border-green-500 text-green-600" },
  disputed: { label: "Disputed", variant: "destructive" },
  voided: { label: "Voided", variant: "secondary" },
};

// ── Helpers ──

function formatCents(cents: number | null | undefined, opts?: { unitCost?: boolean }): string {
  if (!cents && cents !== 0) return "$0.00";
  const n = Number(cents) / 100;
  if (opts?.unitCost && n > 0 && n !== parseFloat(n.toFixed(2))) {
    // Has sub-cent precision: show all significant decimals, no rounding
    return `$${String(n)}`;
  }
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSignedCents(cents: number | null | undefined): string {
  const n = Number(cents || 0);
  if (n < 0) return `-${formatCents(Math.abs(n))}`;
  return formatCents(n);
}

function formatMillsPerUnit(mills: number | null | undefined): string {
  if (mills === null || mills === undefined) return "—";
  return `${formatMills(mills)}/unit`;
}

function formatMillsOrDash(mills: number | null | undefined): string {
  if (mills === null || mills === undefined) return "—";
  return formatMills(mills);
}

function AllocationAmountCell({
  cents,
  millsPerUnit,
  strong = false,
}: {
  cents: number | string | null | undefined;
  millsPerUnit?: number | null;
  strong?: boolean;
}) {
  if (cents === null || cents === undefined) return <>—</>;
  return (
    <div className={`font-mono ${strong ? "font-medium" : ""}`}>
      <div>{formatCents(Number(cents))}</div>
      <div className="text-xs font-normal text-muted-foreground">{formatMillsPerUnit(millsPerUnit)}</div>
    </div>
  );
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
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();
  const searchStr = useSearch();
  const procurementNavigation = useProcurementNavigation();
  const shipmentId = procurementNavigation.record?.kind === "shipment" ? procurementNavigation.record.id : null;
  const navigationIdentity = procurementNavigation.record
    ? procurementRecordHref(procurementNavigation.record, parseProcurementJourney(searchStr))
    : location;
  const navigationVisit = useRef({ identity: navigationIdentity, generation: 0, mounted: true });
  if (navigationVisit.current.identity !== navigationIdentity) {
    navigationVisit.current = {
      identity: navigationIdentity,
      generation: navigationVisit.current.generation + 1,
      mounted: navigationVisit.current.mounted,
    };
  }
  useEffect(() => {
    navigationVisit.current.mounted = true;
    return () => { navigationVisit.current.mounted = false; };
  }, []);

  const captureNavigation = () => {
    const generation = navigationVisit.current.generation;
    return {
      childHref: procurementNavigation.childHref,
      isCurrent: () => navigationVisit.current.mounted && navigationVisit.current.generation === generation,
    };
  };
  type NavigationSnapshot = ReturnType<typeof captureNavigation>;
  const shipmentDetailQueryKey = [`/api/inbound-shipments/${shipmentId}`] as const;
  const shipmentAllocationStatusQueryKey = [`/api/inbound-shipments/${shipmentId}/allocation-status`] as const;

  const activeTab = procurementNavigation.tab;
  const setActiveTab = procurementNavigation.setTab;

  // Dialog states
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);


  const [showAddCostDialog, setShowAddCostDialog] = useState(false);
  const [showEditCostDialog, setShowEditCostDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [lastLandedCostPush, setLastLandedCostPush] = useState<LandedCostPushResult | null>(null);
  const [shipmentReceiptPackResolution, setShipmentReceiptPackResolution] = useState<ShipmentReceiptPackResolution | null>(null);
  const [pendingShipmentReceipt, setPendingShipmentReceipt] = useState<{ shipmentId: number; purchaseOrderId: number } | null>(null);
  const [checkingShipmentReceiptPacks, setCheckingShipmentReceiptPacks] = useState(false);
  const [creatingShipmentReceipt, setCreatingShipmentReceipt] = useState(false);
  // Multi-PO shipments: per-PO receive picker (replaces the old "open the PO
  // detail and receive there" dead-end toast).
  const [poPickerOpen, setPoPickerOpen] = useState(false);
  const { data: shipmentPoReceiveOptions, isLoading: loadingShipmentPoReceiveOptions } = useQuery<any>({
    queryKey: [`/api/inbound-shipments/${shipmentId}/po-receive-options`],
    enabled: poPickerOpen && !!shipmentId,
  });
  const resumeShipmentReceiptHandled = useRef<string | null>(null);

  // Edit shipment form
  const [editForm, setEditForm] = useState<any>({});

  // Add cost form
  const [newCost, setNewCost] = useState<ShipmentCostForm>({
    costType: "freight",
    description: "",
    amount: "",
    allocationMethod: "default",
    vendorName: "",
    vendorId: null as number | null,
    performedByName: "",
    costDate: "",
  });
  const [costVendorOpen, setCostVendorOpen] = useState(false);
  const [costVendorSearch, setCostVendorSearch] = useState("");

  // Edit cost form
  const [editingCost, setEditingCost] = useState<ShipmentCostEditor | null>(null);
  const [costEditConflict, setCostEditConflict] = useState(false);
  const [reloadingCost, setReloadingCost] = useState(false);
  const [costCreateRecovery, setCostCreateRecovery] = useState<ShipmentCostCreateRecovery | null>(null);
  const [costCreateRecoveryError, setCostCreateRecoveryError] = useState<string | null>(null);
  const costRecoveryStore = useMemo(() => user?.id
    ? createShipmentCostRecoveryStore(() => window.sessionStorage, user.id) : null, [user?.id]);
  const costCommands = useMemo(() => createShipmentCostCommandClient(
    () => `shipment-cost-${crypto.randomUUID()}`, costRecoveryStore ?? undefined,
  ), [costRecoveryStore]);
  const [editCostVendorOpen, setEditCostVendorOpen] = useState(false);
  const [editCostVendorSearch, setEditCostVendorSearch] = useState("");

  const refreshCreateRecovery = () => {
    if (!shipmentId || !costRecoveryStore) return;
    try {
      const recovery = costRecoveryStore.read(shipmentId);
      setCostCreateRecovery(recovery);
      setCostCreateRecoveryError(null);
      if (recovery) {
        setNewCost(shipmentCostFormFromCreate(recovery.body));
        setShowAddCostDialog(true);
      }
    } catch (error) {
      setCostCreateRecoveryError(error instanceof Error ? error.message : "Saved cost commands could not be read.");
    }
  };
  useEffect(() => {
    // A cost draft/version belongs to one shipment. Recovery never executes a command.
    setShowAddCostDialog(false);
    setShowEditCostDialog(false);
    setEditingCost(null);
    setCostEditConflict(false);
    setReloadingCost(false);
    setCostCreateRecovery(null);
    setCostCreateRecoveryError(null);
    setNewCost({ costType: "freight", description: "", amount: "", allocationMethod: "default", vendorName: "", vendorId: null, performedByName: "", costDate: "" });
    refreshCreateRecovery();
  }, [shipmentId, costRecoveryStore]);
  // Add Invoice modal (multi-step: vendor picker → invoice preview)
  const [showAddInvoiceModal, setShowAddInvoiceModal] = useState(false);

  // Quick-add vendor
  const [showNewVendorDialog, setShowNewVendorDialog] = useState(false);
  const [newVendor, setNewVendor] = useState({ code: "", name: "", contactName: "", email: "", phone: "", address: "", notes: "" });

  // ── Queries ──

  const {
    data: shipment,
    isLoading,
    error: shipmentError,
    refetch: refetchShipment,
  } = useQuery<any>({
    queryKey: shipmentDetailQueryKey,
    enabled: !!shipmentId,
  });

  const { data: allocationStatus } = useQuery<AllocationStatus>({
    queryKey: shipmentAllocationStatusQueryKey,
    // Loaded whenever the shipment is open so the missing-dimensions banner + fix modal
    // (and the close-blocked auto-open) always have allocation data, regardless of tab.
    enabled: !!shipmentId,
  });

  const { data: vendorsData } = useQuery<any[]>({
    queryKey: ["/api/vendors"],
    enabled: showAddCostDialog || !!editingCost,
  });
  const { data: invoicesData } = useQuery<any>({
    queryKey: [`/api/inbound-shipments/${shipmentId}/invoices`],
    enabled: !!shipmentId,
  });

  const lines = useMemo(
    () => (Array.isArray(shipment?.lines) ? [...shipment.lines].sort(compareShipmentLinesByEntryOrder) : []),
    [shipment?.lines],
  );
  const linkedPurchaseOrderIds = useMemo(
    () => [...new Set<number>(
      [shipment?.purchaseOrderId, ...lines.map((line: any) => line.purchaseOrderId)]
        .map(Number)
        .filter((id): id is number => Number.isSafeInteger(id) && id > 0),
    )],
    [shipment?.purchaseOrderId, lines],
  );
  const costs = shipment?.costs ?? [];
  const paymentStatus = shipment?.paymentStatus ?? null;
  const statusHistory = shipment?.statusHistory ?? [];


  const lineAllocatedTotalCents = lines.reduce(
    (sum: number, line: any) => sum + Number(line.allocatedCostCents || 0),
    0,
  );
  const allocatableCostTotalCents = allocationStatus?.effectiveCostCents ?? costs.reduce(
    (sum: number, cost: any) => sum + Number(cost.actualCents ?? cost.estimatedCents ?? 0),
    0,
  );
  const allocationChecksumDeltaCents = allocatableCostTotalCents - lineAllocatedTotalCents;

  const isEditable = !["closed", "cancelled"].includes(shipment?.status || "");
  const lineActions = useShipmentLineActions({ shipmentId, navigationIdentity, lines, editable: isEditable });
  const isPreClosed = !["closed", "cancelled"].includes(shipment?.status || "");

  // Container utilization
  const containerCapacityCbm = Number(shipment?.containerCapacityCbm || 0);
  const totalGrossVolumeCbm = Number(shipment?.totalGrossVolumeCbm || 0);
  const utilization = containerCapacityCbm > 0 ? (totalGrossVolumeCbm / containerCapacityCbm * 100) : null;

  // ── Mutations ──

  // A shipment links to its PO only through its lines, and the PO page reads its shipment
  // list (and receipts) from SEPARATE /api/purchase-orders/:id/* queries. Global staleTime is
  // Infinity ("fetch once, cache forever"), so unless we explicitly invalidate those keys, the
  // PO's Receive picker keeps showing a stale shipment status (e.g. "draft" after we delivered).
  const invalidatePoViews = () =>
    queryClient.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/purchase-orders/"),
    });
  const refreshActiveQuery = async (queryKey: readonly [string]) => {
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.refetchQueries({ queryKey, type: "active" });
  };
  const refreshShipmentCostingViews = async () => {
    const results = await Promise.allSettled([
      refreshActiveQuery(shipmentDetailQueryKey),
      refreshActiveQuery(shipmentAllocationStatusQueryKey),
    ]);
    const failedRefreshes = results.filter((result) => result.status === "rejected");
    if (failedRefreshes.length > 0) {
      console.error("Failed to refresh shipment costing views after mutation", {
        shipmentId,
        failedRefreshes: failedRefreshes.map((result) => String((result as PromiseRejectedResult).reason)),
      });
    }
  };

  async function fetchShipmentReceiptPackResolution(params: { shipmentId: number; purchaseOrderId: number }) {
    const query = new URLSearchParams({ purchaseOrderId: String(params.purchaseOrderId) });
    const res = await fetch(`/api/inbound-shipments/${params.shipmentId}/receipt-pack-resolution?${query.toString()}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || "Failed to check shipment receipt packs");
    return parseShipmentReceiptResolution(body, params);
  }

  async function createReceiptForShipment(
    params: { shipmentId: number; purchaseOrderId: number },
    navigation: NavigationSnapshot = captureNavigation(),
  ) {
    if (navigation.isCurrent()) setCreatingShipmentReceipt(true);
    try {
      const idempotencyKey = (
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `shipment-receipt-${params.shipmentId}-${params.purchaseOrderId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      ) as string;
      const res = await fetch(`/api/inbound-shipments/${params.shipmentId}/create-receipt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ purchaseOrderId: params.purchaseOrderId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Failed to create receipt");
      toast({ title: "Receipt created", description: `${body.receiptNumber} created from shipment` });
      invalidatePoViews();
      if (!navigation.isCurrent()) return;
      setShipmentReceiptPackResolution(null);
      setPendingShipmentReceipt(null);
      navigate(navigation.childHref(`/receiving?open=${body.id}`));
    } catch (err: any) {
      if (!navigation.isCurrent()) return;
      const openedBlocker = await openShipmentReceiptPackBlocker(params);
      if (openedBlocker) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      if (navigation.isCurrent()) setCreatingShipmentReceipt(false);
    }
  }

  async function openShipmentReceiptPackBlocker(params: { shipmentId: number; purchaseOrderId: number } | undefined | null): Promise<boolean> {
    if (!params) return false;
    const navigation = captureNavigation();
    setCheckingShipmentReceiptPacks(true);
    setPendingShipmentReceipt(params);
    try {
      const resolution = await fetchShipmentReceiptPackResolution(params);
      if (!navigation.isCurrent()) return false;
      if (requiresReceiptUnitReview(resolution)) {
        setShipmentReceiptPackResolution(resolution);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (navigation.isCurrent()) setCheckingShipmentReceiptPacks(false);
    }
  }

  async function checkAndCreateReceiptForShipment(
    params: { shipmentId: number; purchaseOrderId: number },
    navigation: NavigationSnapshot = captureNavigation(),
  ) {
    if (navigation.isCurrent()) {
      setCheckingShipmentReceiptPacks(true);
      setPendingShipmentReceipt(params);
    }
    try {
      const resolution = await fetchShipmentReceiptPackResolution(params);
      if (requiresReceiptUnitReview(resolution)) {
        if (navigation.isCurrent()) setShipmentReceiptPackResolution(resolution);
        return;
      }
      await createReceiptForShipment(params, navigation);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      if (navigation.isCurrent()) setCheckingShipmentReceiptPacks(false);
    }
  }

  async function refreshShipmentReceiptPackResolution() {
    if (!pendingShipmentReceipt) return;
    const navigation = captureNavigation();
    setCheckingShipmentReceiptPacks(true);
    try {
      const resolution = await fetchShipmentReceiptPackResolution(pendingShipmentReceipt);
      if (!navigation.isCurrent()) return;
      setShipmentReceiptPackResolution(resolution);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      if (navigation.isCurrent()) setCheckingShipmentReceiptPacks(false);
    }
  }

  function createPendingShipmentReceipt() {
    if (!pendingShipmentReceipt) return;
    createReceiptForShipment(pendingShipmentReceipt);
  }

  function openReceiptVariantSetup(line?: ShipmentReceiptPackResolutionLine) {
    const context = pendingShipmentReceipt ?? (shipmentReceiptPackResolution
      ? {
          shipmentId: shipmentReceiptPackResolution.shipmentId,
          purchaseOrderId: shipmentReceiptPackResolution.purchaseOrderId,
        }
      : null);
    // Keep the purchase journey and selected tab through catalog setup.
    const returnParams = new URLSearchParams(searchStr);
    if (context) {
      returnParams.set("resumeShipmentReceipt", "1");
      returnParams.set("purchaseOrderId", String(context.purchaseOrderId));
    }
    const returnTo = `/shipments/${shipmentId ?? ""}${returnParams.size ? `?${returnParams.toString()}` : ""}`;
    const setupParams = new URLSearchParams({
      receiptSetup: "1",
      returnTo,
    });
    // Open the source product for explicit receive-variant setup; the catalog
    // URL currently cannot seed a one-piece UOM without defaulting to a case.
    if (line?.sku) setupParams.set("shipmentSku", line.sku);

    if (line?.productId) {
      navigate(`/products/${line.productId}?${setupParams.toString()}`);
      return;
    }

    navigate(`/catalog/variants?${setupParams.toString()}`);
  }

  useEffect(() => {
    if (!shipmentId) return;
    const searchParams = new URLSearchParams(searchStr);
    if (searchParams.get("resumeShipmentReceipt") !== "1") return;

    const purchaseOrderId = parsePositiveInt(searchParams.get("purchaseOrderId"));
    searchParams.delete("resumeShipmentReceipt");
    searchParams.delete("purchaseOrderId");
    const returnHref = `/shipments/${shipmentId}${searchParams.size ? `?${searchParams.toString()}` : ""}`;
    if (!purchaseOrderId) {
      toast({
        title: "Cannot resume receipt",
        description: "The return link is missing the PO context.",
        variant: "destructive",
      });
      navigate(returnHref, { replace: true });
      return;
    }

    const resumeKey = `${shipmentId}:${purchaseOrderId}`;
    if (resumeShipmentReceiptHandled.current === resumeKey) return;
    resumeShipmentReceiptHandled.current = resumeKey;
    navigate(returnHref, { replace: true });
    void checkAndCreateReceiptForShipment({ shipmentId, purchaseOrderId });
  }, [shipmentId, searchStr]);

  function createTransitionMutation(endpoint: string) {
    return useMutation({
      mutationFn: async (body: any = {}) => {
        const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/${endpoint}`, body || undefined);
        return res.json();
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/inbound-shipments/${shipmentId}`] });
        queryClient.invalidateQueries({ queryKey: ["/api/inbound-shipments"] });
        invalidatePoViews();
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
      invalidatePoViews();
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
    onSuccess: async () => {
      await refreshShipmentCostingViews();
      queryClient.invalidateQueries({ queryKey: ["/api/inbound-shipments"] });
      invalidatePoViews();
      setShowEditDialog(false);
      toast({ title: "Updated", description: "Shipment details updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Cost commands retain the submitted version and key until the outcome is known.
  const refreshCostCommandViews = async (originatingShipmentId: number): Promise<boolean> => {
    try {
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return typeof key === "string" && (
            key === "/api/inbound-shipments"
            || key === `/api/inbound-shipments/${originatingShipmentId}`
            || key.startsWith(`/api/inbound-shipments/${originatingShipmentId}/`)
            || key.startsWith("/api/purchase-orders/")
          );
        },
      }, { throwOnError: true });
      return true;
    } catch (error) {
      console.error("Shipment cost command views could not be refreshed", { shipmentId: originatingShipmentId, error });
      return false;
    }
  };
  const openCostEditor = (cost: unknown) => {
    try {
      setEditingCost(shipmentCostEditorFromRecord(cost, shipmentId ?? undefined));
      setCostEditConflict(false);
      setShowEditCostDialog(true);
    } catch (error) {
      toast({ title: "Cannot edit cost", description: error instanceof Error ? error.message : "Refresh cost details and try again.", variant: "destructive" });
    }
  };
  const reloadCostEditor = async () => {
    if (!shipmentId || !editingCost) return;
    const origin = captureNavigation();
    const costId = editingCost.id;
    setReloadingCost(true);
    try {
      const response = await apiRequest("GET", `/api/inbound-shipments/${shipmentId}/costs`);
      const records: unknown = await response.json();
      if (!Array.isArray(records)) throw new Error("The latest cost details could not be verified.");
      const cost = records.find((record: unknown) => typeof record === "object" && record !== null && "id" in record && record.id === costId);
      const editor = shipmentCostEditorFromRecord(cost, shipmentId ?? undefined);
      if (origin.isCurrent()) {
        setEditingCost(editor);
        setCostEditConflict(false);
      }
    } catch (error) {
      if (origin.isCurrent()) toast({ title: "Cannot reload cost", description: error instanceof Error ? error.message : "Refresh the shipment and try again.", variant: "destructive" });
    } finally {
      if (origin.isCurrent()) setReloadingCost(false);
    }
  };
  const costCommandError = async (error: Error, originatingShipmentId: number, context: NavigationSnapshot | undefined, editing = false) => {
    const conflict = shipmentCostNeedsRefresh(error);
    if (conflict && context?.isCurrent() && editing) setCostEditConflict(true);
    if (context?.isCurrent()) {
      toast({
        title: conflict ? "Cost changed — review latest details" : "Cost command failed",
        description: conflict
          ? editing ? "Your draft is preserved. Load the latest cost before saving again." : `${error.message} The shipment is being refreshed.`
          : error.message,
        variant: "destructive",
      });
    }
    if (conflict) await refreshCostCommandViews(originatingShipmentId);
  };
  const addCostMutation = useMutation({
    mutationFn: async ({ originatingShipmentId, form, recoveryBody }: { originatingShipmentId: number; form: ShipmentCostForm; recoveryBody?: ReturnType<typeof createShipmentCostPayload> }) => {
      if (!costRecoveryStore) throw new Error("Sign in before creating a shipment cost.");
      await costCommands.execute({ method: "POST", shipmentId: originatingShipmentId, body: recoveryBody ?? createShipmentCostPayload(form) });
    },
    onMutate: () => captureNavigation(),
    onSuccess: async (_data, variables, context) => {
      const refreshed = await refreshCostCommandViews(variables.originatingShipmentId);
      if (!context?.isCurrent()) return;
      setShowAddCostDialog(false);
      setCostCreateRecovery(null);
      setNewCost({ costType: "freight", description: "", amount: "", allocationMethod: "default", vendorName: "", vendorId: null, performedByName: "", costDate: "" });
      setCostVendorSearch("");
      toast({ title: "Cost added", description: refreshed ? undefined : "The cost was saved, but the view could not refresh. Refresh the shipment to see current details." });
    },
    onError: (error: Error, variables, context) => {
      if (context?.isCurrent()) refreshCreateRecovery();
      return costCommandError(error, variables.originatingShipmentId, context);
    },
  });
  const updateCostMutation = useMutation({
    mutationFn: async ({ originatingShipmentId, editor }: { originatingShipmentId: number; editor: ShipmentCostEditor }) => {
      if (editor.inboundShipmentId !== originatingShipmentId) throw new Error("This edit belongs to a different shipment. Reopen its cost details.");
      await costCommands.execute({ method: "PATCH", shipmentId: originatingShipmentId, costId: editor.id, body: updateShipmentCostPayload(editor) });
    },
    onMutate: () => captureNavigation(),
    onSuccess: async (_data, variables, context) => {
      const refreshed = await refreshCostCommandViews(variables.originatingShipmentId);
      if (!context?.isCurrent()) return;
      setShowEditCostDialog(false);
      setEditingCost(null);
      setCostEditConflict(false);
      toast({ title: "Cost updated", description: refreshed ? undefined : "The cost was saved, but the view could not refresh. Refresh the shipment to see current details." });
    },
    onError: (error: Error, variables, context) => costCommandError(error, variables.originatingShipmentId, context, true),
  });
  const deleteCostMutation = useMutation({
    mutationFn: async ({ originatingShipmentId, cost }: { originatingShipmentId: number; cost: { id: number } }) => {
      await costCommands.execute({ method: "DELETE", shipmentId: originatingShipmentId, costId: cost.id, body: deleteShipmentCostPayload(cost, originatingShipmentId) });
    },
    onMutate: () => captureNavigation(),
    onSuccess: async (_data, variables, context) => {
      const refreshed = await refreshCostCommandViews(variables.originatingShipmentId);
      if (context?.isCurrent()) toast({ title: "Cost removed", description: refreshed ? undefined : "The cost was removed, but the view could not refresh. Refresh the shipment to see current details." });
    },
    onError: (error: Error, variables, context) => costCommandError(error, variables.originatingShipmentId, context),
  });
  const costCommandPending = addCostMutation.isPending || updateCostMutation.isPending || deleteCostMutation.isPending;
  useEffect(() => {
    if (!costCreateRecovery && !addCostMutation.isPending) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [costCreateRecovery, addCostMutation.isPending]);


  const createVendorMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/vendors", data);
      return res.json();
    },
    onSuccess: (vendor: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendors"] });
      setShowNewVendorDialog(false);
      setNewVendor({ code: "", name: "", contactName: "", email: "", phone: "", address: "", notes: "" });
      // Auto-select the new vendor in whichever dropdown is active
      if (showAddCostDialog) {
        setNewCost((prev) => ({ ...prev, vendorId: vendor.id, vendorName: vendor.name }));
      } else if (editingCost) {
        setEditingCost((prev: any) => ({ ...prev, vendorId: vendor.id, vendorName: vendor.name }));
      }
      toast({ title: "Vendor created", description: vendor.name });
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
    onSuccess: async () => {
      await refreshShipmentCostingViews();
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
    onSuccess: async () => {
      await refreshShipmentCostingViews();
      toast({ title: "Finalized", description: "Landed costs finalized and snapshotted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const pushCostsToLotsMutation = useMutation({
    mutationFn: async (): Promise<LandedCostPushResult> => {
      const res = await apiRequest("POST", `/api/inbound-shipments/${shipmentId}/push-costs-to-lots`);
      return res.json();
    },
    onSuccess: async (result) => {
      setLastLandedCostPush(result);
      await refreshShipmentCostingViews();
      const skippedCount = result.skipped?.length ?? 0;
      toast({
        title: skippedCount > 0 ? "Landed cost push needs review" : "Landed costs pushed",
        description:
          skippedCount > 0
            ? `${result.updated} lot${result.updated === 1 ? "" : "s"} updated, ${skippedCount} skipped`
            : `${result.updated} lot${result.updated === 1 ? "" : "s"} updated`,
        variant: skippedCount > 0 ? "destructive" : "default",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ── Loading / Not Found ──

  if (isLoading) {
    return (
      <div className="p-2 md:p-6 space-y-4">
        <ProcurementContext navigation={procurementNavigation} />
        <Button variant="ghost" size="sm" asChild>
          <Link href={procurementNavigation.backHref("/shipments")}>
            {procurementNavigation.backLabel ?? "Back to shipments"}
          </Link>
        </Button>
        <div className="flex items-center justify-center min-h-[50vh]" role="status" aria-label="Loading shipment">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </div>
    );
  }

  if (shipmentError && !shipment) {
    const message = shipmentError instanceof Error
      ? shipmentError.message
      : "The shipment request failed.";
    const notFound = message.startsWith("404:");
    return (
      <div className="p-6 min-h-[50vh] flex items-center justify-center">
        <div className="max-w-lg text-center space-y-3">
          <ProcurementContext navigation={procurementNavigation} />
          <AlertTriangle className="h-8 w-8 mx-auto text-destructive" />
          <p className="font-medium">
            {notFound ? "Shipment not found." : "Unable to load shipment."}
          </p>
          {!notFound && <p className="text-sm text-muted-foreground break-words">{message}</p>}
          <div className="flex justify-center gap-2">
            {!notFound && (
              <Button variant="outline" onClick={() => void refetchShipment()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            )}
            <Button variant="link" asChild>
              <Link href={procurementNavigation.backHref("/shipments")}>
                {procurementNavigation.backLabel ?? "Back to shipments"}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!shipment) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Shipment not found.</p>
        <ProcurementContext navigation={procurementNavigation} />
        <Button variant="link" asChild>
          <Link href={procurementNavigation.backHref("/shipments")}>
            {procurementNavigation.backLabel ?? "Back to shipments"}
          </Link>
        </Button>
      </div>
    );
  }

  // ── Render ──

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      <ProcurementContext navigation={procurementNavigation} />
      {/* ═══════ Header ═══════ */}
      <div className="flex flex-col sm:flex-row items-start gap-4">
        <Button variant="ghost" size="sm" asChild className="min-h-[44px]">
          <Link href={procurementNavigation.backHref("/shipments")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            {procurementNavigation.backLabel ?? "Back to shipments"}
          </Link>
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

          {linkedPurchaseOrderIds.length > 0 && (
            <div className="flex items-center gap-2 mt-1 text-sm flex-wrap">
              <span className="text-muted-foreground">Purchase orders:</span>
              {linkedPurchaseOrderIds.map((purchaseOrderId) => (
                <Link
                  key={purchaseOrderId}
                  href={procurementNavigation.childHref(`/purchase-orders/${purchaseOrderId}?tab=shipments`)}
                  className="text-primary hover:underline"
                >
                  PO #{purchaseOrderId}
                </Link>
              ))}
            </div>
          )}

          {/* Shipper / Carrier / Container / BOL */}
          <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground flex-wrap">
            {shipment.shipperName && <span>Shipper: {shipment.shipperName}</span>}
            {shipment.forwarderName && <span>Fwd: {shipment.forwarderName}</span>}
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
                  shipperName: shipment.shipperName || "",
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
                  grossWeightKg: shipment.grossWeightKg || "",
                  totalGrossVolumeCbm: shipment.totalGrossVolumeCbm || "",
                  palletCount: shipment.palletCount ?? "",
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
              <CheckCircle className="h-4 w-4 mr-2" />
              Confirm
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

          {/* Create Receipt from shipment lines — available once delivered */}
          {["delivered", "costing", "closed"].includes(shipment.status) && lines.length > 0 && (
            <Button
              variant="outline"
              onClick={async () => {
                const positiveLines = lines.filter((sl: any) => Number(sl.qtyShipped) > 0);
                const unlinkedLineCount = positiveLines.filter((sl: any) => !sl.purchaseOrderId || !sl.purchaseOrderLineId).length;
                if (positiveLines.length === 0) {
                  toast({ title: "No receivable lines", description: "Shipment has no positive-quantity lines to receive.", variant: "destructive" });
                  return;
                }
                if (unlinkedLineCount > 0) {
                  toast({ title: "PO links required", description: `${unlinkedLineCount} positive shipment line(s) are missing PO links. Link every line before creating a receipt from the shipment page.`, variant: "destructive" });
                  return;
                }
                // Shipment-level creation is only safe when all lines belong to one PO.
                const poIds = [...new Set(positiveLines.map((sl: any) => Number(sl.purchaseOrderId)).filter((id: number) => Number.isInteger(id) && id > 0))];
                if (poIds.length === 0) {
                  toast({ title: "No PO linked", description: "Link shipment lines to a PO first.", variant: "destructive" });
                  return;
                }
                if (poIds.length > 1) {
                  // Multi-PO shipment: let the operator pick which PO to
                  // receive next (one receiving order per shipment+PO).
                  setPoPickerOpen(true);
                  return;
                }
                await checkAndCreateReceiptForShipment({ shipmentId: shipment.id, purchaseOrderId: poIds[0] });
              }}
              disabled={checkingShipmentReceiptPacks || creatingShipmentReceipt}
              className="flex-1 sm:flex-none min-h-[44px]"
            >
              <Truck className="h-4 w-4 mr-2" />
              {checkingShipmentReceiptPacks ? "Checking..." : creatingShipmentReceipt ? "Creating..." : "Create Receipt"}
            </Button>
          )}

          {shipment.status === "delivered" && (
            <Button onClick={() => startCostingMutation.mutate({})} disabled={startCostingMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <DollarSign className="h-4 w-4 mr-2" />
              Start Costing
            </Button>
          )}

          {shipment.status === "costing" && (
            <Button
              onClick={() => closeMutation.mutate({}, { onError: (e: any) => { if (/dimension/i.test(e?.message || "")) lineActions.openDimensions(); } })}
              disabled={closeMutation.isPending}
              className="flex-1 sm:flex-none min-h-[44px]"
            >
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
            <div className="text-xs text-muted-foreground">Lines / Cartons</div>
            <div className="font-mono font-medium">{lines.length} / {shipment.totalCartons ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Net Weight / CBM</div>
            <div className="font-mono font-medium">{formatNumber(shipment.totalWeightKg, 1)} kg</div>
            <div className="font-mono text-xs text-muted-foreground">{formatNumber(shipment.totalVolumeCbm, 4)} CBM</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Gross (BOL)</div>
            <div className="font-mono font-medium">{shipment.grossWeightKg ? `${formatNumber(shipment.grossWeightKg, 1)} kg` : "—"}</div>
            <div className="font-mono text-xs text-muted-foreground">
              {shipment.totalGrossVolumeCbm ? `${formatNumber(shipment.totalGrossVolumeCbm, 3)} CBM` : "—"}
              {shipment.palletCount ? ` · ${shipment.palletCount} plt` : ""}
            </div>
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
      {lineActions.recoveryBanner}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="lines">Lines ({lines.length})</TabsTrigger>
          <TabsTrigger value="costs">Costs ({costs.length})</TabsTrigger>
          <TabsTrigger value="allocation">Allocation</TabsTrigger>
          <TabsTrigger value="invoices">Invoices ({invoicesData?.summary?.invoiceCount ?? 0})</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="tracking">Tracking</TabsTrigger>
        </TabsList>

        {/* ══ Tab 1: Lines ══ */}
        <TabsContent value="lines" className="space-y-4">
          {(() => {
            const dimIssues = (allocationStatus?.issues ?? []).filter((i) => i.code === "missing_dimensions");
            if (dimIssues.length === 0) return null;
            return (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-red-600" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-red-800">Missing dimensions — this shipment can't be closed</div>
                    <ul className="mt-1 list-disc pl-4 text-red-700 space-y-0.5">
                      {dimIssues.map((issue, i) => (
                        <li key={i}>{issue.message}</li>
                      ))}
                    </ul>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={lineActions.openDimensions} disabled={!isEditable || lineActions.busy}>
                        Enter dimensions
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-300"
                        onClick={() => lineActions.resolve()}
                        disabled={!isEditable || lineActions.busy || lines.length === 0}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${lineActions.busy ? "animate-spin" : ""}`} />
                        Resolve from product data
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          {isEditable && (
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" onClick={lineActions.openAdd} className="min-h-[44px]">
                <Plus className="h-4 w-4 mr-2" />
                Add from PO
              </Button>
              <Button variant="outline" onClick={lineActions.openImport} className="min-h-[44px]">
                <Upload className="h-4 w-4 mr-2" />
                Import Packing List
              </Button>
              <Button
                variant="outline"
                onClick={() => lineActions.resolve()}
                disabled={!isEditable || lineActions.busy || lines.length === 0}
                className="min-h-[44px]"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${lineActions.busy ? "animate-spin" : ""}`} />
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
              lines.map((line: any) => {
                const upc = line.unitsPerVariant ?? 1;
                return (
                  <Card key={line.id} className={isEditable ? "cursor-pointer hover:border-primary/50 transition-colors" : ""} onClick={() => isEditable && lineActions.openEditor(line)}>
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-sm">{line.sku || "—"}</div>
                          {line.productName && <div className="text-xs text-muted-foreground truncate">{line.productName}</div>}
                          <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                            {upc > 1 && <span>{line.cartonCount ?? "—"} cases</span>}
                            <span>{line.qtyShipped} pcs</span>
                            <span>{formatNumber(line.totalWeightKg, 1)} kg</span>
                            <span>{formatNumber(line.totalVolumeCbm, 4)} CBM</span>
                          </div>
                          {line.allocatedCostCents != null && (
                            <div className="text-xs mt-1">
                              Allocated: {formatCents(line.allocatedCostCents)} ({formatMillsPerUnit(line.totalAllocatedMillsPerUnit)}) | Landed: {formatMillsOrDash(line.landedUnitCostMills)}
                            </div>
                          )}
                        </div>
                        {isEditable && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-[44px] min-w-[44px] p-0"
                            aria-label="Remove shipment line" disabled={lineActions.busy}
                            onClick={(e) => { e.stopPropagation(); lineActions.remove(line); }}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>

          {/* Desktop table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Cases</TableHead>
                  <TableHead className="text-right">Pieces</TableHead>
                  <TableHead className="text-right">Wt/Carton</TableHead>
                  <TableHead className="text-right">Net Weight</TableHead>
                  <TableHead className="text-right">Net CBM</TableHead>
                  <TableHead className="text-right">Alloc. Cost</TableHead>
                  <TableHead className="text-right">Landed $/unit</TableHead>
                  {isEditable && <TableHead className="w-20"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={isEditable ? 10 : 9} className="text-center text-muted-foreground py-8">
                      No lines. Click "Add from PO" or "Import Packing List" to add items.
                    </TableCell>
                  </TableRow>
                ) : (
                  lines.map((line: any) => {
                    const upc = line.unitsPerVariant ?? 1;
                    return (
                      <TableRow key={line.id}>
                        <TableCell className="font-mono">{line.sku || "—"}</TableCell>
                        <TableCell className="max-w-[180px] truncate">{line.productName || line.sku || "—"}</TableCell>
                        <TableCell className="text-right">{line.cartonCount ? line.cartonCount : "—"}</TableCell>
                        <TableCell className="text-right">{line.qtyShipped}</TableCell>
                        <TableCell className="text-right">{formatNumber(line.weightKg, 2)}</TableCell>
                        <TableCell className="text-right">{formatNumber(line.totalWeightKg, 1)}</TableCell>
                        <TableCell className="text-right">{formatNumber(line.totalVolumeCbm, 4)}</TableCell>
                        <TableCell className="text-right">
                          <AllocationAmountCell cents={line.allocatedCostCents} millsPerUnit={line.totalAllocatedMillsPerUnit} />
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatMillsOrDash(line.landedUnitCostMills)}</TableCell>
                        {isEditable && (
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label="Edit shipment line"
                                onClick={() => lineActions.openEditor(line)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label="Remove shipment line"
                                onClick={() => { lineActions.remove(line); }}
                                disabled={lineActions.busy}
                              >
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
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
          {lines.length > 0 && (
            <div className="grid gap-3 rounded-md border bg-muted/20 p-3 text-sm md:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">Allocatable cost total</div>
                <div className="font-mono font-medium">{formatCents(allocatableCostTotalCents)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Allocated to lines</div>
                <div className="font-mono font-medium">{formatCents(lineAllocatedTotalCents)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Checksum delta</div>
                <div className={`font-mono font-medium ${allocationChecksumDeltaCents === 0 ? "" : "text-destructive"}`}>
                  {formatSignedCents(allocationChecksumDeltaCents)}
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ══ Tab 2: Costs ══ */}
        <TabsContent value="costs" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {isEditable && (
              <Button variant="outline" onClick={() => setShowAddCostDialog(true)} disabled={!!costCreateRecoveryError} className="min-h-[44px]">
                <Plus className="h-4 w-4 mr-2" />
                Add Cost
              </Button>
            )}
            {costs.length > 0 && costs.some((c: any) => !c.vendorInvoiceId && c.vendorId) && (
              <Button variant="outline" onClick={() => setShowAddInvoiceModal(true)} className="min-h-[44px]">
                <FileText className="h-4 w-4 mr-2" />
                Add Invoice
              </Button>
            )}
          </div>

          {costCreateRecovery && (
            <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <p className="font-medium">Cost creation needs review</p>
              <p>The original request is retained. Review its result or retry it before creating another cost.</p>
              <Button type="button" variant="outline" className="mt-2" onClick={() => setShowAddCostDialog(true)}>Review pending cost</Button>
            </div>
          )}

          {costCreateRecoveryError && (
            <div role="alert" className="rounded-md border border-destructive p-3 text-sm">
              <p>{costCreateRecoveryError}</p>
              <Button type="button" variant="outline" onClick={refreshCreateRecovery} className="mt-2">Check saved command</Button>
            </div>
          )}

          {/* Payment summary bar */}
          {paymentStatus?.summary && costs.length > 0 && (
            <div className="flex flex-wrap gap-4 text-sm px-1">
              <span>Total: <strong className="font-mono">{formatCents(paymentStatus.summary.totalCents)}</strong></span>
              <span>Linked: <strong className="font-mono">{formatCents(paymentStatus.summary.linkedCents)}</strong></span>
              <span className="text-green-600">Paid: <strong className="font-mono">{formatCents(paymentStatus.summary.paidCents)}</strong></span>
              <span className="text-amber-600">Outstanding: <strong className="font-mono">{formatCents(paymentStatus.summary.outstandingCents)}</strong></span>
            </div>
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
                            {cost.invoiceDate && <span className="text-xs text-muted-foreground">{format(new Date(cost.invoiceDate), "MMM d, yyyy")}</span>}
                          </div>
                          {cost.description && <div className="text-sm mt-1 truncate">{cost.description}</div>}
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-sm font-mono">{formatCents(effectiveShipmentCostCents(cost))}</span>
                            {cost.vendorName && <span className="text-xs text-muted-foreground">Pay to: {cost.vendorName}</span>}
                            {cost.performedByName && <span className="text-xs text-muted-foreground">By: {cost.performedByName}</span>}
                            {(() => {
                              const status = cost.derivedStatus as "unbilled" | "invoiced" | "paid";
                              const badgeMap: Record<string, { label: string; variant: "default" | "secondary" | "outline"; className?: string }> = {
                                unbilled: { label: "Unbilled", variant: "outline", className: "text-muted-foreground" },
                                invoiced: { label: "Invoiced", variant: "outline", className: "border-blue-500 text-blue-600" },
                                paid: { label: "Paid", variant: "outline", className: "border-green-500 text-green-600" },
                              };
                              const badge = badgeMap[status] || badgeMap.unbilled;
                              return <Badge variant={badge.variant} className={`text-xs ${badge.className || ""}`}>{badge.label}</Badge>;
                            })()}
                          </div>
                          {cost.linkedInvoice && (
                            <Link href={procurementNavigation.childHref(`/ap-invoices/${cost.linkedInvoice.id}`)} className="text-xs text-blue-600 hover:underline mt-1 block">
                              {cost.linkedInvoice.invoiceNumber}
                            </Link>
                          )}
                        </div>
                        {isEditable && (
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-[44px] min-w-[44px] p-0"
                              aria-label="Edit cost" onClick={() => openCostEditor(cost)} disabled={costCommandPending}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            {canEditShipmentCostEconomics(cost) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="min-h-[44px] min-w-[44px] p-0"
                              disabled={costCommandPending} aria-label="Remove cost" onClick={() => { if (confirm("Remove this cost?")) deleteCostMutation.mutate({ originatingShipmentId: shipmentId!, cost }); }}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                            )}
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
                      <span>Total</span>
                      <span className="font-mono">{formatCents(costs.reduce((sum: number, c: any) => sum + (effectiveShipmentCostCents(c) ?? 0), 0))}</span>
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
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Pay To</TableHead>
                  <TableHead>Performed By</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
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
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {cost.invoiceDate ? format(new Date(cost.invoiceDate), "MMM d, yyyy") : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs capitalize">{cost.costType.replace(/_/g, " ")}</Badge>
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate">{cost.description || "—"}</TableCell>
                        <TableCell className="text-right font-mono">{formatCents(effectiveShipmentCostCents(cost))}</TableCell>
                        <TableCell className="text-sm">
                          {cost.vendorName || "—"}
                          {cost.linkedInvoice && (
                            <span className="ml-1 text-muted-foreground" title="Cannot change vendor on invoiced cost row">🔒</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{cost.performedByName || "—"}</TableCell>
                        <TableCell>
                          {cost.linkedInvoice ? (
                            <Link
                              href={procurementNavigation.childHref(`/ap-invoices/${cost.linkedInvoice.id}`)}
                              className="text-xs text-blue-600 hover:underline font-mono"
                            >
                              {cost.linkedInvoice.invoiceNumber}
                            </Link>
                          ) : cost.vendorId ? (
                            <span className="text-xs text-muted-foreground">Unbilled</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Set vendor first</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {cost.allocationMethod
                            ? ALLOCATION_METHOD_LABELS[cost.allocationMethod] || cost.allocationMethod.replace(/_/g, " ")
                            : `Default (${ALLOCATION_METHOD_LABELS[MODE_DEFAULT_ALLOCATION[shipment?.mode] || "by_volume"] || "By Volume"})`}
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const status = cost.derivedStatus as "unbilled" | "invoiced" | "paid";
                            const badgeMap: Record<string, { label: string; variant: "default" | "secondary" | "outline"; className?: string }> = {
                              unbilled: { label: "Unbilled", variant: "outline", className: "text-muted-foreground" },
                              invoiced: { label: "Invoiced", variant: "outline", className: "border-blue-500 text-blue-600" },
                              paid: { label: "Paid", variant: "outline", className: "border-green-500 text-green-600" },
                            };
                            const badge = badgeMap[status] || badgeMap.unbilled;
                            return <Badge variant={badge.variant} className={`text-xs ${badge.className || ""}`}>{badge.label}</Badge>;
                          })()}
                        </TableCell>
                        {isEditable && (
                          <TableCell>
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label="Edit cost" onClick={() => openCostEditor(cost)} disabled={costCommandPending}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            {canEditShipmentCostEconomics(cost) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label="Remove cost" onClick={() => { if (confirm("Remove this cost?")) deleteCostMutation.mutate({ originatingShipmentId: shipmentId!, cost }); }}
                                disabled={costCommandPending}
                              >
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            )}
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                    {/* Summary row */}
                    <TableRow className="bg-muted/50 font-medium">
                      <TableCell colSpan={3} className="text-right">Total</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatCents(costs.reduce((sum: number, c: any) => sum + (effectiveShipmentCostCents(c) ?? 0), 0))}
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
          <p className="text-sm text-muted-foreground">
            Costs allocate automatically when you add or edit a cost, and finalize + push to inventory
            automatically when the shipment is closed. This tab is the read-only result.
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
              Advanced — manually re-run (rarely needed)
            </summary>
            <div className="flex gap-2 flex-wrap mt-2">
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
              {["costing", "closed"].includes(shipment.status) && (
                <Button
                  variant="outline"
                  onClick={() => pushCostsToLotsMutation.mutate()}
                  disabled={pushCostsToLotsMutation.isPending}
                  className="min-h-[44px]"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${pushCostsToLotsMutation.isPending ? "animate-spin" : ""}`} />
                  {pushCostsToLotsMutation.isPending ? "Pushing..." : "Push Costs to Lots"}
                </Button>
              )}
            </div>
          </details>

          {allocationStatus && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle className="text-base">Allocation Status</CardTitle>
                  <Badge
                    variant={allocationStatus.blockerCount > 0 ? "destructive" : allocationStatus.warningCount > 0 ? "outline" : "secondary"}
                    className={allocationStatus.warningCount > 0 && allocationStatus.blockerCount === 0 ? "border-amber-500 text-amber-700" : undefined}
                  >
                    {ALLOCATION_STATUS_LABELS[allocationStatus.status]}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <div className="text-xs text-muted-foreground">Lines</div>
                    <div className="font-mono text-sm">{allocationStatus.lineCount}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Allocatable Costs</div>
                    <div className="font-mono text-sm">{allocationStatus.allocatableCostCount}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Effective Cost</div>
                    <div className="font-mono text-sm">{formatCents(allocationStatus.effectiveCostCents)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Unallocated Delta</div>
                    <div className={`font-mono text-sm ${allocationStatus.unallocatedCents === 0 ? "" : "text-amber-700"}`}>
                      {formatCents(allocationStatus.unallocatedCents)}
                    </div>
                  </div>
                </div>

                {allocationStatus.issues.length > 0 && (
                  <div className="space-y-2">
                    {allocationStatus.issues.map((issue) => (
                      <div key={`${issue.code}-${issue.costId ?? issue.lineId ?? "shipment"}`} className="flex flex-wrap items-center gap-2 text-sm">
                        <AlertTriangle className={`h-4 w-4 ${issue.severity === "blocker" ? "text-destructive" : "text-amber-600"}`} />
                        <Badge variant={issue.severity === "blocker" ? "destructive" : "outline"}>{issue.severity}</Badge>
                        <span>{issue.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {allocationStatus.costs.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cost</TableHead>
                        <TableHead>Method</TableHead>
                        <TableHead className="text-right">Effective</TableHead>
                        <TableHead className="text-right">Allocated</TableHead>
                        <TableHead className="text-right">Basis</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {allocationStatus.costs.map((cost) => (
                        <TableRow key={cost.costId}>
                          <TableCell>
                            <div className="font-medium">{cost.costType.replace(/_/g, " ")}</div>
                            {cost.description && <div className="text-xs text-muted-foreground">{cost.description}</div>}
                          </TableCell>
                          <TableCell className="text-sm">
                            {ALLOCATION_METHOD_LABELS[cost.method] || cost.method.replace(/_/g, " ")}
                            <div className="text-xs text-muted-foreground">{cost.methodSource.replace(/_/g, " ")}</div>
                          </TableCell>
                          <TableCell className="text-right font-mono">{formatCents(cost.effectiveCents)}</TableCell>
                          <TableCell className="text-right font-mono">{formatCents(cost.allocatedCents)}</TableCell>
                          <TableCell className="text-right font-mono">
                            {Number(cost.basisTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={["needs_allocation", "stale_allocation", "stale_allocation_basis", "allocation_mismatch"].includes(cost.status) ? "destructive" : cost.status === "allocated_with_fallback" ? "outline" : "secondary"}
                              className={cost.status === "allocated_with_fallback" ? "border-amber-500 text-amber-700" : undefined}
                            >
                              {ALLOCATION_COST_STATUS_LABELS[cost.status] || cost.status.replace(/_/g, " ")}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}

          {lastLandedCostPush && (
            <Card className={lastLandedCostPush.skipped?.length ? "border-amber-300 bg-amber-50/60 dark:bg-amber-950/10" : "border-green-300 bg-green-50/60 dark:bg-green-950/10"}>
              <CardContent className="p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant={lastLandedCostPush.skipped?.length ? "outline" : "secondary"}>
                    {lastLandedCostPush.updated} updated
                  </Badge>
                  <Badge variant={lastLandedCostPush.skipped?.length ? "destructive" : "outline"}>
                    {lastLandedCostPush.skipped?.length ?? 0} skipped
                  </Badge>
                  <span className="text-muted-foreground">{lastLandedCostPush.total} provisional lots checked</span>
                </div>
                {lastLandedCostPush.skipped && lastLandedCostPush.skipped.length > 0 && (
                  <div className="space-y-2">
                    {lastLandedCostPush.skipped.map((item) => (
                      <div key={`${item.lotId}-${item.reason}`} className="flex flex-wrap items-center gap-2 text-sm">
                        <AlertTriangle className="h-4 w-4 text-amber-600" />
                        <span className="font-medium">Lot {item.lotId}</span>
                        <span>{formatLandedCostSkipReason(item.reason)}</span>
                        {item.lineIds && item.lineIds.length > 0 && (
                          <span className="text-muted-foreground">Lines {item.lineIds.join(", ")}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">PO $/unit</TableHead>
                  <TableHead className="text-right">Freight</TableHead>
                  <TableHead className="text-right">Duty/Customs</TableHead>
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
                      <TableCell className="text-right font-mono">{formatMillsOrDash(line.poUnitCostMills)}</TableCell>
                      <TableCell className="text-right"><AllocationAmountCell cents={line.freightAllocatedCents} millsPerUnit={line.freightAllocatedMillsPerUnit} /></TableCell>
                      <TableCell className="text-right"><AllocationAmountCell cents={line.dutyAllocatedCents} millsPerUnit={line.dutyAllocatedMillsPerUnit} /></TableCell>
                      <TableCell className="text-right"><AllocationAmountCell cents={line.insuranceAllocatedCents} millsPerUnit={line.insuranceAllocatedMillsPerUnit} /></TableCell>
                      <TableCell className="text-right"><AllocationAmountCell cents={line.otherAllocatedCents} millsPerUnit={line.otherAllocatedMillsPerUnit} /></TableCell>
                      <TableCell className="text-right"><AllocationAmountCell cents={line.allocatedCostCents} millsPerUnit={line.totalAllocatedMillsPerUnit} strong /></TableCell>
                      <TableCell className="text-right font-mono font-medium">{formatMillsOrDash(line.landedUnitCostMills)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ══ Tab 4: Invoices ══ */}
        <TabsContent value="invoices" className="space-y-4">
          {/* Summary bar */}
          {invoicesData?.summary && (
            <div className="flex flex-wrap gap-6 text-sm px-1">
              <span>Total Invoiced: <strong className="font-mono">{formatCents(invoicesData.summary.totalInvoicedCents)}</strong></span>
              <span>Total Paid: <strong className="font-mono">{formatCents(invoicesData.summary.totalPaidCents)}</strong></span>
              <span className={invoicesData.summary.outstandingCents > 0 ? "text-amber-600" : "text-green-600"}>Outstanding: <strong className="font-mono">{formatCents(invoicesData.summary.outstandingCents)}</strong></span>
            </div>
          )}

          {!invoicesData?.invoices?.length ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <FileText className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No invoices linked to this shipment yet.</p>
                <p className="text-xs mt-1">Add invoices from the AP Invoices page and link them to this shipment.</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice Date</TableHead>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Vendor</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoicesData.invoices.map((inv: any) => (
                      <TableRow key={inv.id} className={inv.status === "voided" ? "opacity-40" : ""}>
                        <TableCell className="text-sm">
                          {inv.invoiceDate ? format(new Date(inv.invoiceDate), "MMM d, yyyy") : "—"}
                        </TableCell>
                        <TableCell className={`font-mono font-medium ${inv.status === "voided" ? "line-through" : ""}`}>{inv.invoiceNumber}</TableCell>
                        <TableCell className="text-sm">{inv.vendorName || "—"}</TableCell>
                        <TableCell className="text-right font-mono">{formatCents(inv.invoicedAmountCents)}</TableCell>
                        <TableCell className="text-right font-mono">
                          {inv.paidAmountCents > 0 ? formatCents(inv.paidAmountCents) : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">{inv.status?.replace(/_/g, " ")}</Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            asChild
                          >
                            <Link href={procurementNavigation.childHref(`/ap-invoices/${inv.id}`)}>View</Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Carrier observations are separate from the operational timeline. */}
        <TabsContent value="tracking" className="space-y-4">
          <InboundShipmentTracking key={shipment.id} shipmentId={shipment.id} shipmentStatus={shipment.status} containerNumber={shipment.containerNumber} trackingNumber={shipment.trackingNumber} bolNumber={shipment.bolNumber} bookingReference={shipment.bookingReference} />
        </TabsContent>

        {/* ══ Tab 5: Timeline ══ */}
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
            <div className="space-y-2">
              <Label>Shipper (Origin Supplier)</Label>
              <Input
                value={editForm.shipperName}
                onChange={(e) => setEditForm((prev: any) => ({ ...prev, shipperName: e.target.value }))}
                placeholder="e.g. factory name"
                className="h-10"
              />
            </div>

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

            {/* Gross totals from BOL */}
            <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Gross Totals (from BOL)</h4>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Gross Weight (kg)</Label>
                <Input
                  type="number"
                  step="0.001"
                  value={editForm.grossWeightKg}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, grossWeightKg: e.target.value }))}
                  className="h-10"
                  placeholder="0.000"
                />
              </div>
              <div className="space-y-2">
                <Label>Gross Volume (CBM)</Label>
                <Input
                  type="number"
                  step="0.001"
                  value={editForm.totalGrossVolumeCbm}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, totalGrossVolumeCbm: e.target.value }))}
                  className="h-10"
                  placeholder="0.000"
                />
              </div>
              <div className="space-y-2">
                <Label>Pallets</Label>
                <Input
                  type="number"
                  min="0"
                  value={editForm.palletCount}
                  onChange={(e) => setEditForm((prev: any) => ({ ...prev, palletCount: e.target.value }))}
                  className="h-10"
                  placeholder="0"
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
                  // Convert empty strings to null
                  if (!data.etd) data.etd = null;
                  if (!data.eta) data.eta = null;
                  if (data.containerCapacityCbm === "") data.containerCapacityCbm = null;
                  if (data.grossWeightKg === "") data.grossWeightKg = null;
                  if (data.totalGrossVolumeCbm === "") data.totalGrossVolumeCbm = null;
                  if (data.palletCount === "") data.palletCount = null;
                  else data.palletCount = Number(data.palletCount);
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

      {/* ═══════ Add Cost Dialog ═══════ */}
      <Dialog open={showAddCostDialog} onOpenChange={(open) => { if (!addCostMutation.isPending) setShowAddCostDialog(open); }}>
        <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Shipment Cost</DialogTitle>
            <DialogDescription>Record a cost associated with this shipment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {costCreateRecovery && <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">This cost may already be saved. Retry sends the original request and key to confirm the result. Its details stay locked until that result is known.</p>}
            <fieldset disabled={addCostMutation.isPending || !!costCreateRecovery} className="min-w-0 space-y-4">
            <div className="space-y-2">
              <Label>Cost Type *</Label>
              <Select value={newCost.costType} onValueChange={(v) => setNewCost((prev) => ({
                ...prev,
                costType: v,
                allocationMethod: COST_TYPE_ALLOCATION_OVERRIDES[v] || "default",
              }))}>
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

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Date</Label>
                <Input
                  type="date"
                  value={newCost.costDate}
                  onChange={(e) => setNewCost((prev) => ({ ...prev, costDate: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Service Provider</Label>
                <Popover open={costVendorOpen} onOpenChange={setCostVendorOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" className="w-full justify-between h-10 font-normal">
                      {newCost.vendorName || "Select vendor..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput placeholder="Search vendors..." value={costVendorSearch} onValueChange={setCostVendorSearch} />
                      <CommandList>
                        <CommandEmpty>No vendors found</CommandEmpty>
                        <CommandGroup>
                          {(vendorsData ?? [])
                            .filter((v: any) => !costVendorSearch || v.name?.toLowerCase().includes(costVendorSearch.toLowerCase()))
                            .slice(0, 50)
                            .map((v: any) => (
                              <CommandItem
                                key={v.id}
                                onSelect={() => {
                                  setNewCost((prev) => ({ ...prev, vendorId: v.id, vendorName: v.name }));
                                  setCostVendorOpen(false);
                                  setCostVendorSearch("");
                                }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${newCost.vendorId === v.id ? "opacity-100" : "opacity-0"}`} />
                                {v.name}
                              </CommandItem>
                            ))}
                        </CommandGroup>
                        <CommandGroup>
                          <CommandItem onSelect={() => { setCostVendorOpen(false); setShowNewVendorDialog(true); }} className="text-primary">
                            <Plus className="mr-2 h-4 w-4" />
                            Add New Vendor
                          </CommandItem>
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Performed By</Label>
              <Input
                value={newCost.performedByName}
                onChange={(e) => setNewCost((prev) => ({ ...prev, performedByName: e.target.value }))}
                placeholder="Service performer (e.g. ExFreight Zeta)"
                className="h-10"
              />
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
                <Label>Amount ($) *</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={newCost.amount}
                  onChange={(e) => setNewCost((prev) => ({ ...prev, amount: e.target.value }))}
                  placeholder="0.00"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Allocation Method</Label>
                <Select value={newCost.allocationMethod} onValueChange={(v) => setNewCost((prev) => ({ ...prev, allocationMethod: v }))}>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALLOCATION_METHOD_OPTIONS.map((opt) => {
                      const label = opt.value === "default"
                        ? `Default (${ALLOCATION_METHOD_LABELS[MODE_DEFAULT_ALLOCATION[shipment?.mode] || "by_volume"] || "By Volume"})`
                        : opt.label;
                      return <SelectItem key={opt.value} value={opt.value}>{label}</SelectItem>;
                    })}
                  </SelectContent>
                </Select>
              </div>
            </div>

            </fieldset>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" disabled={addCostMutation.isPending} onClick={() => setShowAddCostDialog(false)}>{costCreateRecovery ? "Close" : "Cancel"}</Button>
              <Button
                onClick={() => addCostMutation.mutate({ originatingShipmentId: shipmentId!, form: newCost, recoveryBody: costCreateRecovery?.body })}
                disabled={addCostMutation.isPending}
              >
                {addCostMutation.isPending ? "Saving..." : costCreateRecovery ? "Retry cost" : "Add Cost"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══════ Edit Cost Dialog ═══════ */}
      <Dialog open={showEditCostDialog} onOpenChange={(open) => { if (!updateCostMutation.isPending && !reloadingCost) { setShowEditCostDialog(open); if (!open) { setEditingCost(null); setCostEditConflict(false); } } }}>
        <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Cost</DialogTitle>
            <DialogDescription>Update cost details.</DialogDescription>
            {editingCost?.economicFieldsLocked && <p className="text-sm text-muted-foreground">This cost is controlled by an invoice or requires currency review. Only its description and performer can be edited here.</p>}
          </DialogHeader>
          {editingCost && (
            <fieldset disabled={updateCostMutation.isPending || reloadingCost} className="min-w-0 space-y-4">
              {costEditConflict && (
                <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <p>Your draft is preserved. Loading the latest cost replaces this draft so you can review the current details before editing again.</p>
                  <Button type="button" variant="outline" className="mt-2" disabled={reloadingCost} onClick={reloadCostEditor}>
                    {reloadingCost ? "Loading..." : "Load latest cost"}
                  </Button>
                </div>
              )}
              <div className="space-y-2">
                <Label>Cost Type</Label>
                <Select disabled={editingCost.economicFieldsLocked} value={editingCost.costType} onValueChange={(v) => setEditingCost((prev: any) => ({
                  ...prev,
                  costType: v,
                  allocationMethod: COST_TYPE_ALLOCATION_OVERRIDES[v] || prev.allocationMethod,
                }))}>
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

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Date</Label>
                  <Input
                    type="date"
                    disabled={editingCost.economicFieldsLocked} value={editingCost.costDate}
                    onChange={(e) => setEditingCost((prev: any) => ({ ...prev, costDate: e.target.value }))}
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Service Provider</Label>
                  <Popover open={editCostVendorOpen} onOpenChange={setEditCostVendorOpen}>
                    <PopoverTrigger asChild>
                      <Button disabled={editingCost.economicFieldsLocked} variant="outline" role="combobox" className="w-full justify-between h-10 font-normal">
                        {editingCost.vendorName || "Select vendor..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                      <Command shouldFilter={false}>
                        <CommandInput placeholder="Search vendors..." value={editCostVendorSearch} onValueChange={setEditCostVendorSearch} />
                        <CommandList>
                          <CommandEmpty>No vendors found</CommandEmpty>
                          <CommandGroup>
                            {(vendorsData ?? [])
                              .filter((v: any) => !editCostVendorSearch || v.name?.toLowerCase().includes(editCostVendorSearch.toLowerCase()))
                              .slice(0, 50)
                              .map((v: any) => (
                                <CommandItem
                                  key={v.id}
                                  onSelect={() => {
                                    setEditingCost((prev: any) => ({ ...prev, vendorId: v.id, vendorName: v.name }));
                                    setEditCostVendorOpen(false);
                                    setEditCostVendorSearch("");
                                  }}
                                >
                                  <Check className={`mr-2 h-4 w-4 ${editingCost.vendorId === v.id ? "opacity-100" : "opacity-0"}`} />
                                  {v.name}
                                </CommandItem>
                              ))}
                          </CommandGroup>
                          <CommandGroup>
                            <CommandItem onSelect={() => { setEditCostVendorOpen(false); setShowNewVendorDialog(true); }} className="text-primary">
                              <Plus className="mr-2 h-4 w-4" />
                              Add New Vendor
                            </CommandItem>
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Performed By</Label>
                <Input
                  value={editingCost.performedByName || ""}
                  onChange={(e) => setEditingCost((prev: any) => ({ ...prev, performedByName: e.target.value }))}
                  placeholder="Service performer (e.g. ExFreight Zeta)"
                  className="h-10"
                />
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
                  <Label>Amount ($) *</Label>
                  <Input
                    type="number"
                    step="0.01"
                    disabled={editingCost.economicFieldsLocked} value={editingCost.amount}
                    onChange={(e) => setEditingCost((prev: any) => ({ ...prev, amount: e.target.value }))}
                    placeholder="0.00"
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Allocation Method</Label>
                  <Select disabled={editingCost.economicFieldsLocked} value={editingCost.allocationMethod || "default"} onValueChange={(v) => setEditingCost((prev: any) => ({ ...prev, allocationMethod: v }))}>
                    <SelectTrigger className="h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ALLOCATION_METHOD_OPTIONS.map((opt) => {
                        const label = opt.value === "default"
                          ? `Default (${ALLOCATION_METHOD_LABELS[MODE_DEFAULT_ALLOCATION[shipment?.mode] || "by_volume"] || "By Volume"})`
                          : opt.label;
                        return <SelectItem key={opt.value} value={opt.value}>{label}</SelectItem>;
                      })}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" disabled={updateCostMutation.isPending || reloadingCost} onClick={() => { setShowEditCostDialog(false); setEditingCost(null); setCostEditConflict(false); }}>Cancel</Button>
                <Button
                  onClick={() => updateCostMutation.mutate({ originatingShipmentId: shipmentId!, editor: editingCost })}
                  disabled={updateCostMutation.isPending || costEditConflict || reloadingCost}
                >
                  {updateCostMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </fieldset>
          )}
        </DialogContent>
      </Dialog>

      {/* ═══════ Add Invoice Modal (vendor picker → invoice preview) ═══════ */}
      <AddInvoiceFromCostsModal
        open={showAddInvoiceModal}
        onOpenChange={setShowAddInvoiceModal}
        shipmentId={shipmentId!}
      />

      {/* ═══════ Quick Add Vendor Dialog ═══════ */}
      <Dialog open={showNewVendorDialog} onOpenChange={setShowNewVendorDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add New Vendor</DialogTitle>
            <DialogDescription>Create a vendor to use for this shipment cost or invoice.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Code *</Label>
                <Input
                  value={newVendor.code}
                  onChange={(e) => setNewVendor((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))}
                  placeholder="e.g. MAERSK"
                  className="h-10 font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input
                  value={newVendor.name}
                  onChange={(e) => setNewVendor((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Vendor name"
                  className="h-10"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Contact Name</Label>
                <Input
                  value={newVendor.contactName}
                  onChange={(e) => setNewVendor((prev) => ({ ...prev, contactName: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={newVendor.email}
                  onChange={(e) => setNewVendor((prev) => ({ ...prev, email: e.target.value }))}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  value={newVendor.phone}
                  onChange={(e) => setNewVendor((prev) => ({ ...prev, phone: e.target.value }))}
                  className="h-10"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Address</Label>
              <Input
                value={newVendor.address}
                onChange={(e) => setNewVendor((prev) => ({ ...prev, address: e.target.value }))}
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={newVendor.notes}
                onChange={(e) => setNewVendor((prev) => ({ ...prev, notes: e.target.value }))}
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
                {createVendorMutation.isPending ? "Creating..." : "Create Vendor"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {lineActions.dialogs}
      <ShipmentReceiptPackResolutionDialog
        open={!!shipmentReceiptPackResolution}
        onOpenChange={(open) => {
          if (!open) setShipmentReceiptPackResolution(null);
        }}
        resolution={shipmentReceiptPackResolution}
        creating={creatingShipmentReceipt}
        refreshing={checkingShipmentReceiptPacks}
        onCreateReceipt={createPendingShipmentReceipt}
        onRefresh={refreshShipmentReceiptPackResolution}
        onOpenCatalog={openReceiptVariantSetup}
      />

      {/* Multi-PO shipment: pick which PO to receive next. Each PO gets its own
          receiving order against this shipment; receive them one at a time. */}
      <Dialog open={poPickerOpen} onOpenChange={setPoPickerOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Receive shipment — choose a PO</DialogTitle>
            <DialogDescription>
              This shipment has lines from multiple purchase orders. Each PO is received
              as its own receipt; receive them one after another.
            </DialogDescription>
          </DialogHeader>
          {loadingShipmentPoReceiveOptions ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Loading PO breakdown…</div>
          ) : (
            <div className="space-y-3">
              {(shipmentPoReceiveOptions?.purchaseOrders ?? []).map((option: any) => {
                const { fullyReceived, text: coverageLabel } = shipmentReceiveCoverageLabel(option);
                return (
                  <div key={option.purchaseOrderId} className="flex items-center justify-between gap-3 rounded-md border p-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{option.poNumber ?? `PO #${option.purchaseOrderId}`}</div>
                      <div className="text-sm text-muted-foreground">
                        {option.lineCount} line{option.lineCount === 1 ? "" : "s"} ·{" "}
                        {coverageLabel}
                      </div>
                      {!fullyReceived && option.reason && (
                        <div className="text-xs text-muted-foreground mt-1">{option.reason}</div>
                      )}
                    </div>
                    {fullyReceived ? (
                      <Badge variant="outline" className="text-green-600 border-green-300 shrink-0">
                        <CheckCircle className="h-3 w-3 mr-1" /> Received
                      </Badge>
                    ) : option.action === "open_existing_receipt" && option.existingReceiptId ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => {
                          setPoPickerOpen(false);
                          navigate(procurementNavigation.childHref(`/receiving?open=${option.existingReceiptId}`));
                        }}
                      >
                        Open receipt
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="shrink-0"
                        disabled={!option.receivable || checkingShipmentReceiptPacks || creatingShipmentReceipt}
                        onClick={async () => {
                          setPoPickerOpen(false);
                          await checkAndCreateReceiptForShipment({
                            shipmentId: option.shipmentId,
                            purchaseOrderId: option.purchaseOrderId,
                          });
                        }}
                      >
                        <Truck className="h-4 w-4 mr-1" /> Receive
                      </Button>
                    )}
                  </div>
                );
              })}
              {(shipmentPoReceiveOptions?.unlinkedLineCount ?? 0) > 0 && (
                <div className="text-xs text-destructive">
                  {shipmentPoReceiveOptions.unlinkedLineCount} positive line(s) have no PO link and are not receivable
                  from this shipment. Link them to a PO first.
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
