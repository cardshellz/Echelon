import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bell,
  Boxes,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleDollarSign,
  ClipboardList,
  FileSearch,
  History,
  MinusCircle,
  PlayCircle,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldAlert,
  Store,
  Truck,
  Wallet,
} from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  allDropshipOrderCancellationStatuses,
  buildAdminCatalogExposurePreviewUrl,
  buildAdminDogfoodReadinessUrl,
  buildAdminDogfoodLaunchStatusUrl,
  buildAdminOmsChannelConfigUrl,
  buildAdminOmsChannelDefaultSourceInput,
  buildAdminOmsChannelDefaultSourceUrl,
  buildAdminListingPushJobsUrl,
  buildAdminListingPushJobRetryInput,
  buildAdminNotificationEventsUrl,
  buildAdminNotificationRetryInput,
  buildAdminOrderIntakeUrl,
  buildAdminOrderOpsActionInput,
  buildAdminReturnCreateInput,
  buildAdminReturnInspectionInput,
  buildAdminReturnPolicyInput,
  buildAdminReturnPolicyUrl,
  buildAdminReturnStatusUpdateInput,
  buildAdminReturnsUrl,
  buildAdminShippingConfigUrl,
  buildAdminWalletConfirmedUsdcCreditInput,
  buildAdminTrackingPushRetryInput,
  buildAdminWalletManualCreditInput,
  buildAdminStoreConnectionsUrl,
  buildAdminStoreWebhookRepairInput,
  buildAdminTrackingPushesUrl,
  buildAdminWorkerSweepInput,
  buildAdminWorkerSweepRunUrl,
  buildCatalogExposureRuleFromPreviewRow,
  buildCatalogExposureRuleInput,
  buildShippingBoxInput,
  buildShippingInsurancePolicyInput,
  buildShippingMarkupPolicyInput,
  buildShippingPackageProfileInput,
  buildShippingRateTableInput,
  buildShippingZoneRuleInput,
  buildStoreConnectionDisconnectInput,
  countByKey,
  catalogExposureRecordToInput,
  catalogExposureRuleKey,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  listingPushJobRetryEligibility,
  notificationRetryEligibility,
  orderCancellationRetryEligibility,
  postJson,
  putJson,
  queryErrorMessage,
  riskSeverityTone,
  orderIntakeRetryEligibility,
  trackingPushRetryEligibility,
  type DropshipAdminCatalogExposurePreviewResponse,
  type DropshipAdminCatalogExposurePreviewRow,
  type DropshipAdminCatalogExposureRulesReplaceResponse,
  type DropshipAdminCatalogExposureRulesResponse,
  type DropshipAdminCatalogExposureRuleInput,
  type DropshipAdminListingPushJobListItem,
  type DropshipAdminListingPushJobListResponse,
  type DropshipAdminListingPushJobRetryResponse,
  type DropshipAdminNotificationOpsListItem,
  type DropshipAdminNotificationOpsListResponse,
  type DropshipAdminNotificationRetryResponse,
  type DropshipAdminOrderOpsCancellationRetryResponse,
  type DropshipAdminOrderOpsActionResponse,
  type DropshipAdminOrderOpsIntakeListItem,
  type DropshipAdminOrderOpsListResponse,
  type DropshipAdminOrderOpsProcessResponse,
  type DropshipAdminOrderOpsStoreSummary,
  type DropshipAdminOrderOpsVendorSummary,
  type DropshipAdminOrderOpsWmsSyncResponse,
  type DropshipOrderDetail,
  type DropshipOrderDetailResponse,
  type DropshipAdminOmsChannelConfigResponse,
  type DropshipAdminOmsChannelConfigureResponse,
  type DropshipOmsChannelOption,
  type DropshipAdminReturnCreateResponse,
  type DropshipAdminReturnInspectionResponse,
  type DropshipAdminReturnPolicyCreateResponse,
  type DropshipAdminReturnPolicyResponse,
  type DropshipAdminReturnStatusUpdateResponse,
  type DropshipAdminShippingConfigResponse,
  type DropshipAdminStoreConnectionListItem,
  type DropshipAdminStoreConnectionListResponse,
  type DropshipAdminStoreWebhookRepairResponse,
  type DropshipAdminOpsOverview,
  type DropshipAdminOpsOverviewResponse,
  type DropshipAuditEventRecord,
  type DropshipAuditEventSearchResponse,
  type DropshipAdminTrackingPushListItem,
  type DropshipAdminTrackingPushListResponse,
  type DropshipAdminTrackingPushRetryResponse,
  type DropshipAdminWorkerSweepName,
  type DropshipAdminWorkerSweepResponse,
  type DropshipAdminWalletConfirmedUsdcCreditResponse,
  type DropshipAdminWalletManualCreditResponse,
  type DropshipDogfoodLaunchGate,
  type DropshipDogfoodLaunchCandidate,
  type DropshipDogfoodLaunchStatusResponse,
  type DropshipDogfoodLaunchRunbookStep,
  type DropshipDogfoodReadinessItem,
  type DropshipDogfoodReadinessResponse,
  type DropshipDogfoodReadinessStatus,
  type DropshipDogfoodSmokeCandidate,
  type DropshipDogfoodSmokeResponse,
  type DropshipDogfoodSmokeStage,
  type DropshipOmsChannelConfigOverview,
  type DropshipOpsCount,
  type DropshipOpsRiskBucket,
  type DropshipOrderCancellationStatus,
  type DropshipOpsOrderIntakeStatus,
  type DropshipListingPushJobStatus,
  type DropshipNotificationOpsChannel,
  type DropshipNotificationOpsStatus,
  type DropshipReturnListItem,
  type DropshipReturnListResponse,
  type DropshipReturnDetail,
  type DropshipReturnDetailResponse,
  type DropshipReturnFaultCategory,
  type DropshipReturnPolicyConfig,
  type DropshipRmaInspectionOutcome,
  type DropshipRmaStatus,
  type DropshipTrackingPushStatus,
  type DropshipSeverity,
  type DropshipShippingConfigOverview,
  type DropshipStoreConnectionLifecycleStatus,
  type DropshipStoreConnectionDisconnectResponse,
  type DropshipStorePlatform,
  type DropshipSystemReadinessCheck,
  type DropshipWalletResponse,
} from "@/lib/dropship-ops-surface";

type AuditSeverityFilter = DropshipSeverity | "all";
type DogfoodReadinessStatusFilter = DropshipDogfoodReadinessStatus | "all";
type OrderOpsStatusFilter = DropshipOpsOrderIntakeStatus | "default" | "all";
type OrderOpsCancellationStatusFilter = DropshipOrderCancellationStatus | "all";
type ListingPushStatusFilter = DropshipListingPushJobStatus | "default" | "all";
type TrackingPushStatusFilter = DropshipTrackingPushStatus | "default" | "all";
type NotificationOpsStatusFilter = DropshipNotificationOpsStatus | "default" | "all";
type NotificationOpsChannelFilter = DropshipNotificationOpsChannel | "all";
type NotificationOpsCriticalFilter = "all" | "critical" | "noncritical";
type ReturnOpsStatusFilter = DropshipRmaStatus | "default" | "all";
type StoreConnectionStatusFilter = DropshipStoreConnectionLifecycleStatus | "all";
type StoreConnectionPlatformFilter = DropshipStorePlatform | "all";
type DropshipOpsSearchableTab = "listing-pushes" | "order-intake" | "tracking-pushes";
type OrderIntakeAdminAction = "retry" | "exception" | "process" | "retry-cancellation" | "retry-wms-sync";
type DropshipOpsTabValue =
  | "overview"
  | "dogfood"
  | "catalog"
  | "shipping"
  | "order-intake"
  | "wallet-ops"
  | "stores"
  | "listing-pushes"
  | "tracking-pushes"
  | "notifications"
  | "returns"
  | "audit";
type CatalogExposureScopeFilter = DropshipAdminCatalogExposureRuleInput["scopeType"];
type CatalogExposureActionFilter = DropshipAdminCatalogExposureRuleInput["action"];
type CatalogPreviewVisibilityFilter = "all" | "visible" | "hidden";
type CatalogPreviewStatusFilter = "active" | "inactive" | "all";

interface DropshipWarehouseOption {
  id: number;
  code: string;
  name: string;
  warehouseType: string;
  isActive: number;
  isDefault: number;
}

interface DropshipProductVariantOption {
  id: number;
  sku: string | null;
  name: string;
  productId: number;
  active?: number | null;
  isActive?: boolean;
}

interface DropshipProductOption {
  id: number;
  sku?: string | null;
  baseSku?: string | null;
  name: string;
  active?: number | null;
  status?: string | null;
}

interface DropshipProductLineOption {
  id: number;
  name: string;
  status?: string | null;
  productCount?: number | null;
}

interface DropshipProductCategoryOption {
  id: number;
  name: string;
  isActive?: boolean | null;
  productCount?: number | null;
}

interface DropshipSelectOption {
  value: string;
  label: string;
  detail?: string;
  search?: string;
}

interface CatalogRuleTargetLabels {
  productLineNamesById: Map<number, string>;
  productLabelsById: Map<number, string>;
  variantLabelsById: Map<number, string>;
  categoryLabelsByKey: Map<string, string>;
}

const NO_DEFAULT_WAREHOUSE_VALUE = "__none__";
const CATALOG_PREVIEW_PAGE_SIZE = 50;

const dropshipOpsTabValues = new Set<DropshipOpsTabValue>([
  "overview",
  "dogfood",
  "catalog",
  "shipping",
  "order-intake",
  "wallet-ops",
  "stores",
  "listing-pushes",
  "tracking-pushes",
  "notifications",
  "returns",
  "audit",
]);

interface DropshipOpsSearchSignal {
  tab: DropshipOpsSearchableTab;
  search: string;
  platform?: StoreConnectionPlatformFilter;
  nonce: number;
}

interface CatalogRuleFormState {
  scopeType: CatalogExposureScopeFilter;
  action: CatalogExposureActionFilter;
  productLineId: string;
  productId: string;
  productVariantId: string;
  category: string;
  priority: string;
  notes: string;
}

interface ReturnInspectionItemFormState {
  rmaItemId: number;
  productVariantId: number | null;
  quantity: number;
  status: string;
  finalCreditAmount: string;
  feeAmount: string;
}

interface ReturnInspectionFormState {
  rmaId: number;
  outcome: DropshipRmaInspectionOutcome;
  faultCategory: DropshipReturnFaultCategory;
  notes: string;
  items: ReturnInspectionItemFormState[];
}

interface ReturnCreateItemFormState {
  productVariantId: string;
  quantity: string;
  status: string;
  requestedCreditAmount: string;
}

interface ReturnCreateFormState {
  vendorId: string;
  rmaNumber: string;
  storeConnectionId: string;
  intakeId: string;
  omsOrderId: string;
  reasonCode: string;
  faultCategory: DropshipReturnFaultCategory | "none";
  returnWindowDays: string;
  labelSource: string;
  returnTrackingNumber: string;
  vendorNotes: string;
  items: ReturnCreateItemFormState[];
}

interface ReturnPolicyFormState {
  name: string;
  returnWindowDays: string;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string;
}

interface ShippingBoxFormState {
  code: string;
  name: string;
  lengthIn: string;
  widthIn: string;
  heightIn: string;
  tareWeightLb: string;
  maxWeightLb: string;
  isActive: boolean;
}

interface ShippingPackageProfileFormState {
  productVariantId: string;
  weightLb: string;
  lengthIn: string;
  widthIn: string;
  heightIn: string;
  shipAlone: boolean;
  defaultCarrier: string;
  defaultService: string;
  defaultBoxId: string;
  maxUnitsPerPackage: string;
  isActive: boolean;
}

interface ShippingZoneRuleFormState {
  originWarehouseId: string;
  destinationCountry: string;
  destinationRegion: string;
  postalPrefix: string;
  zone: string;
  priority: string;
  isActive: boolean;
}

interface ShippingRateTableFormState {
  carrier: string;
  service: string;
  currency: string;
  status: "draft" | "active" | "archived";
  effectiveFrom: string;
  effectiveTo: string;
  warehouseId: string;
  destinationZone: string;
  minWeightGrams: string;
  maxWeightGrams: string;
  rate: string;
}

interface ShippingMarkupPolicyFormState {
  name: string;
  markupBps: string;
  fixedMarkup: string;
  minMarkup: string;
  maxMarkup: string;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string;
}

interface ShippingInsurancePolicyFormState {
  name: string;
  feeBps: string;
  minFee: string;
  maxFee: string;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string;
}

type ShippingConfigSectionKey =
  | "overview"
  | "boxes"
  | "profiles"
  | "zones"
  | "rates"
  | "markup"
  | "insurance";

const shippingConfigSections: Array<{ key: ShippingConfigSectionKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "boxes", label: "Boxes" },
  { key: "profiles", label: "Product profiles" },
  { key: "zones", label: "Zones" },
  { key: "rates", label: "Rate tables" },
  { key: "markup", label: "Markup" },
  { key: "insurance", label: "Insurance" },
];

const emptyCatalogRuleForm: CatalogRuleFormState = {
  scopeType: "catalog",
  action: "include",
  productLineId: "",
  productId: "",
  productVariantId: "",
  category: "",
  priority: "0",
  notes: "",
};

const emptyShippingBoxForm: ShippingBoxFormState = {
  code: "",
  name: "",
  lengthIn: "",
  widthIn: "",
  heightIn: "",
  tareWeightLb: "0",
  maxWeightLb: "",
  isActive: true,
};

const emptyReturnCreateItemForm: ReturnCreateItemFormState = {
  productVariantId: "",
  quantity: "1",
  status: "requested",
  requestedCreditAmount: "",
};

const emptyReturnCreateForm: ReturnCreateFormState = {
  vendorId: "",
  rmaNumber: "",
  storeConnectionId: "",
  intakeId: "",
  omsOrderId: "",
  reasonCode: "",
  faultCategory: "none",
  returnWindowDays: "30",
  labelSource: "",
  returnTrackingNumber: "",
  vendorNotes: "",
  items: [{ ...emptyReturnCreateItemForm }],
};

const emptyReturnPolicyForm: ReturnPolicyFormState = {
  name: "",
  returnWindowDays: "30",
  isActive: true,
  effectiveFrom: "",
  effectiveTo: "",
};

function makeEmptyReturnCreateForm(): ReturnCreateFormState {
  return {
    ...emptyReturnCreateForm,
    items: [{ ...emptyReturnCreateItemForm }],
  };
}

const emptyShippingPackageProfileForm: ShippingPackageProfileFormState = {
  productVariantId: "",
  weightLb: "",
  lengthIn: "",
  widthIn: "",
  heightIn: "",
  shipAlone: false,
  defaultCarrier: "",
  defaultService: "",
  defaultBoxId: "",
  maxUnitsPerPackage: "",
  isActive: true,
};

const emptyShippingZoneRuleForm: ShippingZoneRuleFormState = {
  originWarehouseId: "",
  destinationCountry: "US",
  destinationRegion: "",
  postalPrefix: "",
  zone: "",
  priority: "0",
  isActive: true,
};

const emptyShippingRateTableForm: ShippingRateTableFormState = {
  carrier: "USPS",
  service: "Ground Advantage",
  currency: "USD",
  status: "active",
  effectiveFrom: "",
  effectiveTo: "",
  warehouseId: "",
  destinationZone: "",
  minWeightGrams: "0",
  maxWeightGrams: "",
  rate: "",
};

const emptyShippingMarkupPolicyForm: ShippingMarkupPolicyFormState = {
  name: "Default markup",
  markupBps: "0",
  fixedMarkup: "0.00",
  minMarkup: "",
  maxMarkup: "",
  isActive: true,
  effectiveFrom: "",
  effectiveTo: "",
};

const emptyShippingInsurancePolicyForm: ShippingInsurancePolicyFormState = {
  name: "Default insurance pool",
  feeBps: "200",
  minFee: "",
  maxFee: "",
  isActive: true,
  effectiveFrom: "",
  effectiveTo: "",
};

const orderOpsStatusFilters: OrderOpsStatusFilter[] = [
  "default",
  "all",
  "payment_hold",
  "retrying",
  "failed",
  "exception",
  "rejected",
  "cancelled",
  "received",
  "processing",
  "accepted",
];

const orderOpsCancellationStatusFilters: OrderOpsCancellationStatusFilter[] = [
  "all",
  ...allDropshipOrderCancellationStatuses,
];

const storeConnectionStatusFilters: StoreConnectionStatusFilter[] = [
  "all",
  "connected",
  "needs_reauth",
  "refresh_failed",
  "grace_period",
  "paused",
  "disconnected",
];

const listingPushStatusFilters: ListingPushStatusFilter[] = [
  "default",
  "all",
  "failed",
  "processing",
  "queued",
  "completed",
  "cancelled",
];

const trackingPushStatusFilters: TrackingPushStatusFilter[] = [
  "default",
  "all",
  "failed",
  "processing",
  "queued",
  "succeeded",
];

const notificationOpsStatusFilters: NotificationOpsStatusFilter[] = [
  "default",
  "all",
  "failed",
  "pending",
  "delivered",
];

const notificationOpsChannelFilters: NotificationOpsChannelFilter[] = [
  "all",
  "email",
  "in_app",
];

const notificationOpsCriticalFilters: NotificationOpsCriticalFilter[] = [
  "all",
  "critical",
  "noncritical",
];

const returnOpsStatusFilters: ReturnOpsStatusFilter[] = [
  "default",
  "all",
  "requested",
  "in_transit",
  "received",
  "inspecting",
  "approved",
  "rejected",
  "credited",
  "closed",
];

const returnOpsTerminalStatuses = new Set<DropshipRmaStatus>(["credited", "closed"]);

const returnOpsUpdateStatuses: DropshipRmaStatus[] = [
  "in_transit",
  "received",
  "inspecting",
  "closed",
];

const returnFaultCategories: DropshipReturnFaultCategory[] = [
  "card_shellz",
  "vendor",
  "customer",
  "marketplace",
  "carrier",
];

const dogfoodReadinessStatusFilters: DogfoodReadinessStatusFilter[] = [
  "all",
  "blocked",
  "warning",
  "ready",
];

const adminWorkerSweepOptions: Array<{
  worker: DropshipAdminWorkerSweepName;
  label: string;
  description: string;
}> = [
  {
    worker: "listing_push",
    label: "Listing push",
    description: "Claims pending or stale listing push jobs and sends marketplace updates.",
  },
  {
    worker: "order_processing",
    label: "Order processing",
    description: "Processes received dropship orders, payment holds, cancellations, and stale intakes.",
  },
  {
    worker: "ebay_order_intake",
    label: "eBay intake",
    description: "Polls connected eBay stores for paid marketplace orders.",
  },
];

function isDropshipOpsTabValue(value: string | null): value is DropshipOpsTabValue {
  return value !== null && dropshipOpsTabValues.has(value as DropshipOpsTabValue);
}

function parseDropshipOpsTab(searchString: string): DropshipOpsTabValue {
  const normalizedSearch = searchString.startsWith("?") ? searchString.slice(1) : searchString;
  const tab = new URLSearchParams(normalizedSearch).get("tab");
  return isDropshipOpsTabValue(tab) ? tab : "overview";
}

function buildDropshipTabHref(tab: DropshipOpsTabValue): string {
  return `/dropship?tab=${encodeURIComponent(tab)}`;
}

export default function Dropship() {
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const locationTab = useMemo(() => parseDropshipOpsTab(searchString), [searchString]);
  const [activeTab, setActiveTab] = useState<DropshipOpsTabValue>(locationTab);
  const [opsSearchSignal, setOpsSearchSignal] = useState<DropshipOpsSearchSignal | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditSeverity, setAuditSeverity] = useState<AuditSeverityFilter>("all");
  const [appliedAuditFilters, setAppliedAuditFilters] = useState({
    search: "",
    severity: "all" as AuditSeverityFilter,
  });

  const auditUrl = useMemo(() => {
    const params = new URLSearchParams({ page: "1", limit: "25" });
    if (appliedAuditFilters.search.trim()) params.set("search", appliedAuditFilters.search.trim());
    if (appliedAuditFilters.severity !== "all") params.set("severity", appliedAuditFilters.severity);
    return `/api/dropship/admin/audit-events?${params.toString()}`;
  }, [appliedAuditFilters]);

  const overviewQuery = useQuery<DropshipAdminOpsOverviewResponse>({
    queryKey: ["/api/dropship/admin/ops/overview"],
    queryFn: () => fetchJson<DropshipAdminOpsOverviewResponse>("/api/dropship/admin/ops/overview"),
  });
  const auditQuery = useQuery<DropshipAuditEventSearchResponse>({
    queryKey: [auditUrl],
    queryFn: () => fetchJson<DropshipAuditEventSearchResponse>(auditUrl),
  });

  const overview = overviewQuery.data?.overview;

  useEffect(() => {
    setActiveTab(locationTab);
  }, [locationTab]);

  function applyAuditFilters() {
    setAppliedAuditFilters({
      search: auditSearch,
      severity: auditSeverity,
    });
  }

  function refreshAll() {
    void overviewQuery.refetch();
    void auditQuery.refetch();
  }

  function openSmokeOpsSearch(input: Omit<DropshipOpsSearchSignal, "nonce">) {
    setOpsSearchSignal({ ...input, nonce: Date.now() });
    setActiveTab(input.tab);
    navigate(buildDropshipTabHref(input.tab));
  }

  function selectTab(value: string) {
    const nextTab = isDropshipOpsTabValue(value) ? value : "overview";
    setActiveTab(nextTab);
    navigate(buildDropshipTabHref(nextTab));
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b bg-card px-4 py-5 md:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-normal" data-testid="text-page-title">
              <ShieldAlert className="h-6 w-6 text-[#C060E0]" />
              Dropship Ops
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Monitor .ops setup blockers, store health, order intake exceptions, listing pushes, tracking pushes, returns, notifications, and audit history.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {overview && (
              <Badge variant="outline" className="h-9 px-3">
                Updated {formatDateTime(overview.generatedAt)}
              </Badge>
            )}
            <Button
              variant="outline"
              className="h-9 gap-2"
              disabled={overviewQuery.isFetching || auditQuery.isFetching}
              onClick={refreshAll}
            >
              <RefreshCw className={overviewQuery.isFetching || auditQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Refresh
            </Button>
          </div>
        </div>

        {(overviewQuery.error || auditQuery.error) && (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {errorMessage(overviewQuery.error ?? auditQuery.error)}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 md:p-6">
        <Tabs value={activeTab} onValueChange={selectTab} className="flex min-h-0 flex-1 flex-col">
          <TabsContent value="overview" className="m-0 space-y-5">
            {overviewQuery.isLoading ? (
              <OverviewSkeleton />
            ) : overview ? (
              <OverviewTab overview={overview} />
            ) : (
              <EmptyState title="No ops data" description="The dropship ops overview did not return any data." />
            )}
          </TabsContent>

          <TabsContent value="dogfood" className="m-0">
            <DogfoodReadinessTab onOpenSmokeOpsSearch={openSmokeOpsSearch} />
          </TabsContent>

          <TabsContent value="catalog" className="m-0">
            <CatalogExposureTab />
          </TabsContent>

          <TabsContent value="shipping" className="m-0">
            <ShippingConfigTab />
          </TabsContent>

          <TabsContent value="order-intake" className="m-0">
            <OrderIntakeOpsTab searchSignal={opsSearchSignal?.tab === "order-intake" ? opsSearchSignal : null} />
          </TabsContent>

          <TabsContent value="wallet-ops" className="m-0">
            <WalletOpsTab />
          </TabsContent>

          <TabsContent value="stores" className="m-0">
            <StoreConnectionOpsTab />
          </TabsContent>

          <TabsContent value="listing-pushes" className="m-0">
            <ListingPushOpsTab searchSignal={opsSearchSignal?.tab === "listing-pushes" ? opsSearchSignal : null} />
          </TabsContent>

          <TabsContent value="tracking-pushes" className="m-0">
            <TrackingPushOpsTab searchSignal={opsSearchSignal?.tab === "tracking-pushes" ? opsSearchSignal : null} />
          </TabsContent>

          <TabsContent value="notifications" className="m-0">
            <NotificationOpsTab />
          </TabsContent>

          <TabsContent value="returns" className="m-0">
            <ReturnOpsTab />
          </TabsContent>

          <TabsContent value="audit" className="m-0 space-y-4">
            <div className="rounded-md border bg-card p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <div className="min-w-0 flex-1">
                  <label className="text-sm font-medium" htmlFor="dropship-audit-search">
                    Search
                  </label>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="dropship-audit-search"
                        value={auditSearch}
                        onChange={(event) => setAuditSearch(event.target.value)}
                        className="pl-9"
                        placeholder="Event type, entity, or actor"
                      />
                    </div>
                  </div>
                </div>
                <div className="w-full lg:w-48">
                  <label className="text-sm font-medium">Severity</label>
                  <Select value={auditSeverity} onValueChange={(value) => setAuditSeverity(value as AuditSeverityFilter)}>
                    <SelectTrigger className="mt-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All severities</SelectItem>
                      <SelectItem value="info">Info</SelectItem>
                      <SelectItem value="warning">Warning</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyAuditFilters}>
                  <FileSearch className="h-4 w-4" />
                  Apply
                </Button>
              </div>
            </div>

            <AuditEventsTable
              events={auditQuery.data?.items ?? []}
              isLoading={auditQuery.isLoading || auditQuery.isFetching}
              total={auditQuery.data?.total ?? 0}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function DogfoodReadinessTab({
  onOpenSmokeOpsSearch,
}: {
  onOpenSmokeOpsSearch: (input: Omit<DropshipOpsSearchSignal, "nonce">) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<DogfoodReadinessStatusFilter>("all");
  const [platform, setPlatform] = useState<StoreConnectionPlatformFilter>("all");
  const [omsMessage, setOmsMessage] = useState("");
  const [omsError, setOmsError] = useState("");
  const [isSavingOmsChannel, setIsSavingOmsChannel] = useState(false);
  const [workerBatchSize, setWorkerBatchSize] = useState("10");
  const [workerReason, setWorkerReason] = useState("Dogfood manual sweep");
  const [pendingWorkerSweep, setPendingWorkerSweep] = useState<DropshipAdminWorkerSweepName | null>(null);
  const [workerSweepMessage, setWorkerSweepMessage] = useState("");
  const [workerSweepError, setWorkerSweepError] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "all" as DogfoodReadinessStatusFilter,
    platform: "all" as StoreConnectionPlatformFilter,
  });

  const readinessUrl = useMemo(() => buildAdminDogfoodReadinessUrl({
    search: appliedFilters.search,
    status: appliedFilters.status,
    platform: appliedFilters.platform,
  }), [appliedFilters]);
  const launchStatusUrl = useMemo(() => buildAdminDogfoodLaunchStatusUrl({
    search: appliedFilters.search,
    platform: appliedFilters.platform,
  }), [appliedFilters]);

  const readinessQuery = useQuery<DropshipDogfoodReadinessResponse>({
    queryKey: [readinessUrl],
    queryFn: () => fetchJson<DropshipDogfoodReadinessResponse>(readinessUrl),
  });
  const launchStatusQuery = useQuery<DropshipDogfoodLaunchStatusResponse>({
    queryKey: [launchStatusUrl],
    queryFn: () => fetchJson<DropshipDogfoodLaunchStatusResponse>(launchStatusUrl),
  });
  const omsChannelConfigUrl = buildAdminOmsChannelConfigUrl();
  const omsChannelConfigQuery = useQuery<DropshipAdminOmsChannelConfigResponse>({
    queryKey: [omsChannelConfigUrl],
    queryFn: () => fetchJson<DropshipAdminOmsChannelConfigResponse>(omsChannelConfigUrl),
  });

  const items = readinessQuery.data?.items ?? [];
  const summary = readinessQuery.data?.summary ?? [];
  const launchStatus = launchStatusQuery.data ?? null;
  const systemChecks = readinessQuery.data?.systemChecks ?? launchStatus?.readiness.systemChecks ?? [];
  const launchGate = launchStatus?.launchGate ?? readinessQuery.data?.launchGate ?? null;
  const omsConfig = omsChannelConfigQuery.data?.config ?? null;

  function applyReadinessFilters() {
    setAppliedFilters({ search, status, platform });
  }

  async function ensureOmsSource() {
    setIsSavingOmsChannel(true);
    setOmsError("");
    setOmsMessage("");
    try {
      const input = buildAdminOmsChannelDefaultSourceInput({
        idempotencyKey: createDropshipIdempotencyKey("admin-oms-source"),
      });
      const response = await postJson<DropshipAdminOmsChannelConfigureResponse>(
        buildAdminOmsChannelDefaultSourceUrl(),
        input,
      );
      setOmsMessage(`Internal dropship channel initialized as ${dropshipOmsSourceLabel(response.selectedChannel)}.`);
      await Promise.all([
        omsChannelConfigQuery.refetch(),
        readinessQuery.refetch(),
        launchStatusQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setOmsError(caught instanceof Error ? caught.message : "Internal dropship channel setup failed.");
    } finally {
      setIsSavingOmsChannel(false);
    }
  }

  async function runWorkerSweep(worker: DropshipAdminWorkerSweepName) {
    setPendingWorkerSweep(worker);
    setWorkerSweepError("");
    setWorkerSweepMessage("");
    try {
      const input = buildAdminWorkerSweepInput({
        idempotencyKey: createDropshipIdempotencyKey(`admin-worker-sweep-${worker}`),
        batchSize: workerBatchSize,
        reason: workerReason,
      });
      const response = await postJson<DropshipAdminWorkerSweepResponse>(
        buildAdminWorkerSweepRunUrl(worker),
        input,
      );
      setWorkerSweepMessage(workerSweepMessageForResponse(response));
      await Promise.all([
        readinessQuery.refetch(),
        launchStatusQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setWorkerSweepError(caught instanceof Error ? caught.message : "Dropship worker sweep failed.");
    } finally {
      setPendingWorkerSweep(null);
    }
  }

  return (
    <div className="space-y-5">
      {(readinessQuery.error || launchStatusQuery.error || omsChannelConfigQuery.error || omsError || workerSweepError) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {omsError || workerSweepError || queryErrorMessage(
              readinessQuery.error ?? launchStatusQuery.error ?? omsChannelConfigQuery.error,
              "Unable to load dropship dogfood readiness.",
            )}
          </AlertDescription>
        </Alert>
      )}
      {omsMessage && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{omsMessage}</AlertDescription>
        </Alert>
      )}
      {workerSweepMessage && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{workerSweepMessage}</AlertDescription>
        </Alert>
      )}

      <OmsChannelConfigPanel
        config={omsConfig}
        isLoading={omsChannelConfigQuery.isLoading || omsChannelConfigQuery.isFetching}
        isSaving={isSavingOmsChannel}
        onEnsureDefaultSource={ensureOmsSource}
      />

      <SystemReadinessPanel
        checks={systemChecks}
        isLoading={readinessQuery.isLoading || readinessQuery.isFetching}
      />

      <WorkerSweepPanel
        batchSize={workerBatchSize}
        pendingWorker={pendingWorkerSweep}
        reason={workerReason}
        onBatchSizeChange={setWorkerBatchSize}
        onReasonChange={setWorkerReason}
        onRunSweep={runWorkerSweep}
      />

      <DogfoodLaunchGatePanel
        gate={launchGate}
        isLoading={launchStatusQuery.isLoading || launchStatusQuery.isFetching}
        launchCandidates={launchStatus?.launchCandidates ?? []}
        message={launchStatus?.message}
        runbookSteps={launchStatus?.runbookSteps}
        status={launchStatus?.status}
      />

      <DogfoodSmokePanel
        smoke={launchStatus?.smoke ?? null}
        isLoading={launchStatusQuery.isLoading || launchStatusQuery.isFetching}
        onOpenSmokeOpsSearch={onOpenSmokeOpsSearch}
      />

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Dogfood readiness</h2>
            <p className="text-sm text-muted-foreground">
              Validate each vendor/store against the minimum internal launch checklist before running live orders.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Vendor, member, store, or domain"
              />
            </div>
            <Select value={platform} onValueChange={(value) => setPlatform(value as StoreConnectionPlatformFilter)}>
              <SelectTrigger className="lg:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All platforms</SelectItem>
                <SelectItem value="ebay">eBay</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as DogfoodReadinessStatusFilter)}>
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dogfoodReadinessStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === "all" ? "All statuses" : formatStatus(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyReadinessFilters}>
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Ready" value={String(readinessSummaryCount(summary, "ready"))} />
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Blocked" value={String(readinessSummaryCount(summary, "blocked"))} />
        <CatalogMetric icon={<ShieldAlert className="h-4 w-4" />} label="Warnings" value={String(readinessSummaryCount(summary, "warning"))} />
        <CatalogMetric icon={<Store className="h-4 w-4" />} label="Matching rows" value={String(readinessQuery.data?.total ?? 0)} />
      </section>

      <DogfoodReadinessTable
        isLoading={readinessQuery.isLoading || readinessQuery.isFetching}
        items={items}
        total={readinessQuery.data?.total ?? 0}
      />
    </div>
  );
}

function ListingPushOpsTab({
  searchSignal,
}: {
  searchSignal: DropshipOpsSearchSignal | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ListingPushStatusFilter>("default");
  const [platform, setPlatform] = useState<StoreConnectionPlatformFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as ListingPushStatusFilter,
    platform: "all" as StoreConnectionPlatformFilter,
  });
  const [retryReason, setRetryReason] = useState("");
  const [pendingRetryJobId, setPendingRetryJobId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const listingPushJobsUrl = useMemo(() => buildAdminListingPushJobsUrl({
    search: appliedFilters.search,
    status: appliedFilters.status,
    platform: appliedFilters.platform,
  }), [appliedFilters]);

  const listingPushJobsQuery = useQuery<DropshipAdminListingPushJobListResponse>({
    queryKey: [listingPushJobsUrl],
    queryFn: () => fetchJson<DropshipAdminListingPushJobListResponse>(listingPushJobsUrl),
  });

  const jobs = listingPushJobsQuery.data?.items ?? [];
  const listingPushRetryNow = useMemo(() => new Date(), [listingPushJobsQuery.dataUpdatedAt]);
  const recoverableJobCount = jobs.filter((job) =>
    listingPushJobRetryEligibility(job, listingPushRetryNow).canRetry
  ).length;

  useEffect(() => {
    if (!searchSignal) return;
    setSearch(searchSignal.search);
    setPlatform(searchSignal.platform ?? "all");
    setStatus("all");
    setAppliedFilters({
      search: searchSignal.search,
      status: "all",
      platform: searchSignal.platform ?? "all",
    });
  }, [searchSignal]);

  function applyListingPushFilters() {
    setAppliedFilters({ search, status, platform });
  }

  async function retryListingPushJob(job: DropshipAdminListingPushJobListItem) {
    setPendingRetryJobId(job.jobId);
    setError("");
    setMessage("");
    try {
      const input = buildAdminListingPushJobRetryInput({
        idempotencyKey: createDropshipIdempotencyKey(`admin-listing-job-retry-${job.jobId}`),
        reason: retryReason,
      });
      const response = await postJson<DropshipAdminListingPushJobRetryResponse>(
        `/api/dropship/admin/listing-push-jobs/${job.jobId}/retry`,
        input,
      );
      const itemLabel = response.requeuedItemCount === 1 ? "item" : "items";
      setMessage(
        `Listing push job ${response.jobId} moved from ${formatStatus(response.previousStatus)} `
        + `to ${formatStatus(response.status)} with ${response.requeuedItemCount} ${itemLabel} requeued.`,
      );
      setRetryReason("");
      await Promise.all([
        listingPushJobsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dropship listing push job retry failed.");
    } finally {
      setPendingRetryJobId(null);
    }
  }

  return (
    <div className="space-y-5">
      {(listingPushJobsQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || queryErrorMessage(listingPushJobsQuery.error, "Unable to load dropship listing push jobs.")}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Listing push operations</h2>
            <p className="text-sm text-muted-foreground">
              Review bulk listing push jobs, marketplace failures, blocked items, and vendor store context.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Job, vendor, store, error, or hash"
              />
            </div>
            <Select value={platform} onValueChange={(value) => setPlatform(value as StoreConnectionPlatformFilter)}>
              <SelectTrigger className="lg:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All platforms</SelectItem>
                <SelectItem value="ebay">eBay</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as ListingPushStatusFilter)}>
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {listingPushStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {listingPushStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyListingPushFilters}>
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
        <div className="mt-4 max-w-3xl">
          <label className="text-sm font-medium" htmlFor="dropship-listing-job-retry-reason">
            Retry reason
          </label>
          <Input
            id="dropship-listing-job-retry-reason"
            value={retryReason}
            onChange={(event) => setRetryReason(event.target.value)}
            placeholder="Optional retry audit note"
            className="mt-2"
            maxLength={1000}
          />
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<RefreshCw className="h-4 w-4" />} label="Matching jobs" value={String(listingPushJobsQuery.data?.total ?? 0)} />
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Visible recoverable" value={String(recoverableJobCount)} />
        <CatalogMetric icon={<Boxes className="h-4 w-4" />} label="Visible blocked items" value={String(jobs.reduce((sum, job) => sum + job.itemSummary.blocked, 0))} />
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Visible completed items" value={String(jobs.reduce((sum, job) => sum + job.itemSummary.completed, 0))} />
      </section>

      <ListingPushJobsTable
        isLoading={listingPushJobsQuery.isLoading || listingPushJobsQuery.isFetching}
        jobs={jobs}
        onRetry={retryListingPushJob}
        pendingRetryJobId={pendingRetryJobId}
        retryEligibilityNow={listingPushRetryNow}
        summary={listingPushJobsQuery.data?.summary ?? []}
        total={listingPushJobsQuery.data?.total ?? 0}
      />
    </div>
  );
}

function TrackingPushOpsTab({
  searchSignal,
}: {
  searchSignal: DropshipOpsSearchSignal | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TrackingPushStatusFilter>("default");
  const [platform, setPlatform] = useState<StoreConnectionPlatformFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as TrackingPushStatusFilter,
    platform: "all" as StoreConnectionPlatformFilter,
  });
  const [retryReason, setRetryReason] = useState("");
  const [pendingRetryPushId, setPendingRetryPushId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const trackingPushesUrl = useMemo(() => buildAdminTrackingPushesUrl({
    search: appliedFilters.search,
    status: appliedFilters.status,
    platform: appliedFilters.platform,
  }), [appliedFilters]);

  const trackingPushesQuery = useQuery<DropshipAdminTrackingPushListResponse>({
    queryKey: [trackingPushesUrl],
    queryFn: () => fetchJson<DropshipAdminTrackingPushListResponse>(trackingPushesUrl),
  });

  const pushes = trackingPushesQuery.data?.items ?? [];
  const trackingPushRetryNow = useMemo(() => new Date(), [trackingPushesQuery.dataUpdatedAt]);
  const recoverablePushCount = pushes.filter((push) =>
    trackingPushRetryEligibility(push, trackingPushRetryNow).canRetry
  ).length;

  useEffect(() => {
    if (!searchSignal) return;
    setSearch(searchSignal.search);
    setPlatform(searchSignal.platform ?? "all");
    setStatus("all");
    setAppliedFilters({
      search: searchSignal.search,
      status: "all",
      platform: searchSignal.platform ?? "all",
    });
  }, [searchSignal]);

  function applyTrackingPushFilters() {
    setAppliedFilters({ search, status, platform });
  }

  async function retryTrackingPush(push: DropshipAdminTrackingPushListItem) {
    setPendingRetryPushId(push.pushId);
    setError("");
    setMessage("");
    try {
      const input = buildAdminTrackingPushRetryInput({
        idempotencyKey: createDropshipIdempotencyKey(`admin-tracking-retry-${push.pushId}`),
        reason: retryReason,
      });
      const response = await postJson<DropshipAdminTrackingPushRetryResponse>(
        `/api/dropship/admin/tracking-pushes/${push.pushId}/retry`,
        input,
      );
      setMessage(`Tracking push ${response.pushId} retry returned ${formatStatus(response.status)}.`);
      setRetryReason("");
      await Promise.all([
        trackingPushesQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dropship tracking push retry failed.");
    } finally {
      setPendingRetryPushId(null);
    }
  }

  return (
    <div className="space-y-5">
      {(trackingPushesQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || queryErrorMessage(trackingPushesQuery.error, "Unable to load dropship tracking pushes.")}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Tracking push operations</h2>
            <p className="text-sm text-muted-foreground">
              Review marketplace tracking notifications, fulfillment ids, failed pushes, and retry context.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Order, tracking, carrier, vendor, or error"
              />
            </div>
            <Select value={platform} onValueChange={(value) => setPlatform(value as StoreConnectionPlatformFilter)}>
              <SelectTrigger className="lg:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All platforms</SelectItem>
                <SelectItem value="ebay">eBay</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as TrackingPushStatusFilter)}>
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {trackingPushStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {trackingPushStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyTrackingPushFilters}>
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
        <div className="mt-4 max-w-3xl">
          <label className="text-sm font-medium" htmlFor="dropship-tracking-retry-reason">
            Retry reason
          </label>
          <Input
            id="dropship-tracking-retry-reason"
            value={retryReason}
            onChange={(event) => setRetryReason(event.target.value)}
            placeholder="Optional retry audit note"
            className="mt-2"
            maxLength={1000}
          />
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<Truck className="h-4 w-4" />} label="Matching pushes" value={String(trackingPushesQuery.data?.total ?? 0)} />
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Visible recoverable" value={String(recoverablePushCount)} />
        <CatalogMetric icon={<RefreshCw className="h-4 w-4" />} label="Visible attempts" value={String(pushes.reduce((sum, push) => sum + push.attemptCount, 0))} />
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Visible succeeded" value={String(pushes.filter((push) => push.status === "succeeded").length)} />
      </section>

      <TrackingPushesTable
        isLoading={trackingPushesQuery.isLoading || trackingPushesQuery.isFetching}
        onRetry={retryTrackingPush}
        pendingRetryPushId={pendingRetryPushId}
        pushes={pushes}
        retryEligibilityNow={trackingPushRetryNow}
        summary={trackingPushesQuery.data?.summary ?? []}
        total={trackingPushesQuery.data?.total ?? 0}
      />
    </div>
  );
}

function NotificationOpsTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<NotificationOpsStatusFilter>("default");
  const [channel, setChannel] = useState<NotificationOpsChannelFilter>("all");
  const [critical, setCritical] = useState<NotificationOpsCriticalFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as NotificationOpsStatusFilter,
    channel: "all" as NotificationOpsChannelFilter,
    critical: "all" as NotificationOpsCriticalFilter,
  });
  const [retryReason, setRetryReason] = useState("");
  const [pendingRetryEventId, setPendingRetryEventId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const notificationEventsUrl = useMemo(() => buildAdminNotificationEventsUrl({
    search: appliedFilters.search,
    status: appliedFilters.status,
    channel: appliedFilters.channel,
    critical: appliedFilters.critical,
  }), [appliedFilters]);

  const notificationEventsQuery = useQuery<DropshipAdminNotificationOpsListResponse>({
    queryKey: [notificationEventsUrl],
    queryFn: () => fetchJson<DropshipAdminNotificationOpsListResponse>(notificationEventsUrl),
  });

  const events = notificationEventsQuery.data?.items ?? [];
  const recoverableEventCount = events.filter((event) => notificationRetryEligibility(event).canRetry).length;

  function applyNotificationFilters() {
    setAppliedFilters({ search, status, channel, critical });
  }

  async function retryNotificationEvent(event: DropshipAdminNotificationOpsListItem) {
    setPendingRetryEventId(event.notificationEventId);
    setError("");
    setMessage("");
    try {
      const input = buildAdminNotificationRetryInput({
        idempotencyKey: createDropshipIdempotencyKey(`admin-notification-retry-${event.notificationEventId}`),
        reason: retryReason,
      });
      const response = await postJson<DropshipAdminNotificationRetryResponse>(
        `/api/dropship/admin/notifications/${event.notificationEventId}/retry`,
        input,
      );
      setMessage(`Notification ${response.notificationEventId} retry returned ${formatStatus(response.status)}.`);
      setRetryReason("");
      await Promise.all([
        notificationEventsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dropship notification retry failed.");
    } finally {
      setPendingRetryEventId(null);
    }
  }

  return (
    <div className="space-y-5">
      {(notificationEventsQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || queryErrorMessage(notificationEventsQuery.error, "Unable to load dropship notification events.")}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Notification operations</h2>
            <p className="text-sm text-muted-foreground">
              Review vendor notification delivery, unread critical notices, and failed message events.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Event, title, vendor, email, or hash"
              />
            </div>
            <Select value={channel} onValueChange={(value) => setChannel(value as NotificationOpsChannelFilter)}>
              <SelectTrigger className="lg:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {notificationOpsChannelFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {notificationOpsChannelLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={critical} onValueChange={(value) => setCritical(value as NotificationOpsCriticalFilter)}>
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {notificationOpsCriticalFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {notificationOpsCriticalLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as NotificationOpsStatusFilter)}>
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {notificationOpsStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {notificationOpsStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyNotificationFilters}>
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
        <div className="mt-4">
          <label htmlFor="dropship-notification-retry-reason" className="text-sm font-medium">
            Retry audit note
          </label>
          <Input
            id="dropship-notification-retry-reason"
            value={retryReason}
            onChange={(event) => setRetryReason(event.target.value)}
            placeholder="Optional retry audit note"
            className="mt-2"
            maxLength={1000}
          />
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<Bell className="h-4 w-4" />} label="Matching events" value={String(notificationEventsQuery.data?.total ?? 0)} />
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Visible recoverable" value={String(recoverableEventCount)} />
        <CatalogMetric icon={<RefreshCw className="h-4 w-4" />} label="Visible pending" value={String(events.filter((event) => event.status === "pending").length)} />
        <CatalogMetric icon={<ShieldAlert className="h-4 w-4" />} label="Critical visible" value={String(events.filter((event) => event.critical).length)} />
      </section>

      <NotificationEventsTable
        channelSummary={notificationEventsQuery.data?.channelSummary ?? []}
        events={events}
        isLoading={notificationEventsQuery.isLoading || notificationEventsQuery.isFetching}
        onRetry={retryNotificationEvent}
        pendingRetryEventId={pendingRetryEventId}
        summary={notificationEventsQuery.data?.summary ?? []}
        total={notificationEventsQuery.data?.total ?? 0}
      />
    </div>
  );
}

function ReturnOpsTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ReturnOpsStatusFilter>("default");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as ReturnOpsStatusFilter,
  });
  const [createForm, setCreateForm] = useState<ReturnCreateFormState>(() => makeEmptyReturnCreateForm());
  const [policyForm, setPolicyForm] = useState<ReturnPolicyFormState>(emptyReturnPolicyForm);
  const [creatingRma, setCreatingRma] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [statusInputs, setStatusInputs] = useState<Record<number, DropshipRmaStatus>>({});
  const [statusNotes, setStatusNotes] = useState<Record<number, string>>({});
  const [pendingRmaId, setPendingRmaId] = useState<number | null>(null);
  const [selectedInspectionRmaId, setSelectedInspectionRmaId] = useState<number | null>(null);
  const [inspectionForm, setInspectionForm] = useState<ReturnInspectionFormState | null>(null);
  const [inspectionPendingRmaId, setInspectionPendingRmaId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const returnsUrl = useMemo(() => buildAdminReturnsUrl({
    search: appliedFilters.search,
    status: appliedFilters.status,
  }), [appliedFilters]);
  const returnPolicyUrl = useMemo(() => buildAdminReturnPolicyUrl(), []);
  const returnVendorOptionsUrl = useMemo(() => buildAdminDogfoodReadinessUrl({
    search: "",
    status: "all",
    platform: "all",
    limit: 250,
  }), []);
  const returnStoreConnectionsUrl = useMemo(() => buildAdminStoreConnectionsUrl({
    search: "",
    status: "all",
    platform: "all",
    limit: 250,
  }), []);
  const returnOrderIntakeUrl = useMemo(() => buildAdminOrderIntakeUrl({
    search: "",
    status: "all",
    limit: 250,
  }), []);

  const returnsQuery = useQuery<DropshipReturnListResponse>({
    queryKey: [returnsUrl],
    queryFn: () => fetchJson<DropshipReturnListResponse>(returnsUrl),
  });
  const returnPolicyQuery = useQuery<DropshipAdminReturnPolicyResponse>({
    queryKey: [returnPolicyUrl],
    queryFn: () => fetchJson<DropshipAdminReturnPolicyResponse>(returnPolicyUrl),
  });
  const returnDetailQuery = useQuery<DropshipReturnDetailResponse>({
    queryKey: ["dropship-admin-return-detail", selectedInspectionRmaId],
    queryFn: () => {
      if (selectedInspectionRmaId === null) throw new Error("Missing selected RMA.");
      return fetchJson<DropshipReturnDetailResponse>(`/api/dropship/admin/returns/${selectedInspectionRmaId}`);
    },
    enabled: selectedInspectionRmaId !== null,
  });
  const returnVendorOptionsQuery = useQuery<DropshipDogfoodReadinessResponse>({
    queryKey: [returnVendorOptionsUrl, "return-vendors"],
    queryFn: () => fetchJson<DropshipDogfoodReadinessResponse>(returnVendorOptionsUrl),
  });
  const returnStoreConnectionsQuery = useQuery<DropshipAdminStoreConnectionListResponse>({
    queryKey: [returnStoreConnectionsUrl, "return-store-connections"],
    queryFn: () => fetchJson<DropshipAdminStoreConnectionListResponse>(returnStoreConnectionsUrl),
  });
  const returnOrderIntakesQuery = useQuery<DropshipAdminOrderOpsListResponse>({
    queryKey: [returnOrderIntakeUrl, "return-order-intakes"],
    queryFn: () => fetchJson<DropshipAdminOrderOpsListResponse>(returnOrderIntakeUrl),
  });
  const returnVariantsQuery = useQuery<DropshipProductVariantOption[]>({
    queryKey: ["/api/product-variants", "return-options"],
    queryFn: () => fetchJson<DropshipProductVariantOption[]>("/api/product-variants"),
  });

  const rmas = returnsQuery.data?.items ?? [];
  const activeReturnPolicy = returnPolicyQuery.data?.policy ?? null;
  const returnVendorOptions = useMemo(
    () => buildVendorSelectOptions(returnVendorOptionsQuery.data?.items ?? []),
    [returnVendorOptionsQuery.data?.items],
  );
  const returnStoreConnections = useMemo(
    () => returnStoreConnectionsQuery.data?.items ?? [],
    [returnStoreConnectionsQuery.data?.items],
  );
  const returnOrderIntakes = useMemo(
    () => returnOrderIntakesQuery.data?.items ?? [],
    [returnOrderIntakesQuery.data?.items],
  );
  const returnVariantOptions = useMemo(
    () => (returnVariantsQuery.data ?? [])
      .filter((variant) => variant.isActive !== false && variant.active !== 0)
      .sort((first, second) => {
        const skuCompare = (first.sku ?? "").localeCompare(second.sku ?? "");
        if (skuCompare !== 0) return skuCompare;
        const nameCompare = first.name.localeCompare(second.name);
        return nameCompare !== 0 ? nameCompare : first.id - second.id;
      }),
    [returnVariantsQuery.data],
  );

  useEffect(() => {
    const rma = returnDetailQuery.data?.rma;
    if (!rma) return;
    setInspectionForm((current) => {
      if (current?.rmaId === rma.rmaId) return current;
      return buildReturnInspectionFormState(rma);
    });
  }, [returnDetailQuery.data?.rma]);

  function applyReturnFilters() {
    setAppliedFilters({ search, status });
  }

  function updateCreateForm(patch: Partial<ReturnCreateFormState>) {
    setCreateForm((current) => ({ ...current, ...patch }));
  }

  function updateReturnPolicyForm(patch: Partial<ReturnPolicyFormState>) {
    setPolicyForm((current) => ({ ...current, ...patch }));
  }

  function updateCreateItem(index: number, patch: Partial<ReturnCreateItemFormState>) {
    setCreateForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }));
  }

  function addCreateItem() {
    setCreateForm((current) => ({
      ...current,
      items: [...current.items, { ...emptyReturnCreateItemForm }],
    }));
  }

  function removeCreateItem(index: number) {
    setCreateForm((current) => ({
      ...current,
      items: current.items.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function updatePendingStatus(rmaId: number, nextStatus: DropshipRmaStatus) {
    setStatusInputs((current) => ({ ...current, [rmaId]: nextStatus }));
  }

  function updateStatusNote(rmaId: number, note: string) {
    setStatusNotes((current) => ({ ...current, [rmaId]: note }));
  }

  function selectInspectionRma(rma: DropshipReturnListItem) {
    setSelectedInspectionRmaId(rma.rmaId);
    setInspectionForm(null);
    setError("");
    setMessage("");
  }

  function clearInspectionSelection() {
    setSelectedInspectionRmaId(null);
    setInspectionForm(null);
  }

  function updateInspectionForm(patch: Partial<ReturnInspectionFormState>) {
    setInspectionForm((current) => current ? { ...current, ...patch } : current);
  }

  function updateInspectionItem(
    rmaItemId: number,
    patch: Partial<Pick<ReturnInspectionItemFormState, "status" | "finalCreditAmount" | "feeAmount">>,
  ) {
    setInspectionForm((current) => {
      if (!current) return current;
      return {
        ...current,
        items: current.items.map((item) => item.rmaItemId === rmaItemId ? { ...item, ...patch } : item),
      };
    });
  }

  async function saveReturnStatus(rma: DropshipReturnListItem) {
    const nextStatus = statusInputs[rma.rmaId];
    if (!nextStatus || nextStatus === rma.status) return;
    setPendingRmaId(rma.rmaId);
    setError("");
    setMessage("");
    try {
      const input = buildAdminReturnStatusUpdateInput({
        idempotencyKey: createDropshipIdempotencyKey(`admin-return-status-${rma.rmaId}`),
        status: nextStatus,
        notes: statusNotes[rma.rmaId] ?? "",
      });
      const response = await postJson<DropshipAdminReturnStatusUpdateResponse>(
        `/api/dropship/admin/returns/${rma.rmaId}/status`,
        input,
      );
      setMessage(`RMA ${response.rma.rmaNumber} moved to ${formatStatus(response.rma.status)}.`);
      setStatusNotes((current) => ({ ...current, [rma.rmaId]: "" }));
      setStatusInputs((current) => {
        const next = { ...current };
        delete next[rma.rmaId];
        return next;
      });
      await Promise.all([
        returnsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dropship return status update failed.");
    } finally {
      setPendingRmaId(null);
    }
  }

  async function createReturn() {
    setCreatingRma(true);
    setError("");
    setMessage("");
    try {
      const input = buildAdminReturnCreateInput({
        ...createForm,
        idempotencyKey: createDropshipIdempotencyKey(`admin-return-create-${createForm.vendorId || "vendor"}`),
      });
      const response = await postJson<DropshipAdminReturnCreateResponse>("/api/dropship/admin/returns", input);
      setMessage(`RMA ${response.rma.rmaNumber} created for vendor ${response.rma.vendorId}.`);
      setCreateForm(makeEmptyReturnCreateForm());
      await Promise.all([
        returnsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dropship return creation failed.");
    } finally {
      setCreatingRma(false);
    }
  }

  async function saveReturnPolicy() {
    setSavingPolicy(true);
    setError("");
    setMessage("");
    try {
      const response = await postJson<DropshipAdminReturnPolicyCreateResponse>(
        "/api/dropship/admin/returns/policies",
        buildAdminReturnPolicyInput({
          ...policyForm,
          idempotencyKey: createDropshipIdempotencyKey(`admin-return-policy-${policyForm.returnWindowDays || "window"}`),
        }),
      );
      setMessage(`Return policy ${response.policy.name} set to ${response.policy.returnWindowDays} days.`);
      setPolicyForm(emptyReturnPolicyForm);
      await Promise.all([
        returnPolicyQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dropship return policy save failed.");
    } finally {
      setSavingPolicy(false);
    }
  }

  async function saveReturnInspection() {
    if (!inspectionForm) return;
    const rma = returnDetailQuery.data?.rma;
    if (!rma || rma.rmaId !== inspectionForm.rmaId) return;
    setInspectionPendingRmaId(inspectionForm.rmaId);
    setError("");
    setMessage("");
    try {
      const input = buildAdminReturnInspectionInput({
        idempotencyKey: createDropshipIdempotencyKey(`admin-return-inspection-${inspectionForm.rmaId}`),
        outcome: inspectionForm.outcome,
        faultCategory: inspectionForm.faultCategory,
        notes: inspectionForm.notes,
        items: inspectionForm.items.map((item) => ({
          rmaItemId: item.rmaItemId,
          status: item.status,
          finalCreditAmount: item.finalCreditAmount,
          feeAmount: item.feeAmount,
        })),
      });
      const response = await postJson<DropshipAdminReturnInspectionResponse>(
        `/api/dropship/admin/returns/${inspectionForm.rmaId}/inspection`,
        input,
      );
      setMessage(
        `RMA ${response.rma.rmaNumber} inspected: ${formatStatus(response.inspection.outcome)} with ${formatCents(response.inspection.creditCents)} credit and ${formatCents(response.inspection.feeCents)} fee.`,
      );
      setInspectionForm(buildReturnInspectionFormState(response.rma));
      await Promise.all([
        returnsQuery.refetch(),
        returnDetailQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dropship return inspection failed.");
    } finally {
      setInspectionPendingRmaId(null);
    }
  }

  return (
    <div className="space-y-5">
      {(returnsQuery.error || returnPolicyQuery.error || returnVendorOptionsQuery.error || returnStoreConnectionsQuery.error || returnOrderIntakesQuery.error || returnVariantsQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error
              || (returnsQuery.error
                ? queryErrorMessage(returnsQuery.error, "Unable to load dropship returns.")
                : queryErrorMessage(
                  returnPolicyQuery.error
                    ?? returnVendorOptionsQuery.error
                    ?? returnStoreConnectionsQuery.error
                    ?? returnOrderIntakesQuery.error
                    ?? returnVariantsQuery.error,
                  "Unable to load dropship return setup data.",
                ))}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Return operations</h2>
            <p className="text-sm text-muted-foreground">
              Review RMAs, return tracking, fault assignment, inspection progress, and final credit state.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="RMA, order, tracking, or vendor"
              />
            </div>
            <Select value={status} onValueChange={(value) => setStatus(value as ReturnOpsStatusFilter)}>
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {returnOpsStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {returnOpsStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyReturnFilters}>
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <CatalogMetric icon={<RotateCcw className="h-4 w-4" />} label="Matching RMAs" value={String(returnsQuery.data?.total ?? 0)} />
        <CatalogMetric icon={<ShieldAlert className="h-4 w-4" />} label="Visible open" value={String(rmas.filter((rma) => !returnOpsTerminalStatuses.has(rma.status)).length)} />
        <CatalogMetric icon={<FileSearch className="h-4 w-4" />} label="Awaiting inspection" value={String(rmas.filter((rma) => rma.status === "received" || rma.status === "inspecting").length)} />
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Visible credited" value={String(rmas.filter((rma) => rma.status === "credited").length)} />
        <CatalogMetric icon={<History className="h-4 w-4" />} label="Return window" value={activeReturnPolicy ? `${activeReturnPolicy.returnWindowDays}d` : "Not set"} />
      </section>

      <ReturnPolicyPanel
        activePolicy={activeReturnPolicy}
        form={policyForm}
        isLoading={returnPolicyQuery.isLoading || returnPolicyQuery.isFetching}
        isSaving={savingPolicy}
        onChange={updateReturnPolicyForm}
        onSave={saveReturnPolicy}
      />

      <ReturnCreatePanel
        form={createForm}
        isSaving={creatingRma}
        intakes={returnOrderIntakes}
        intakesLoading={returnOrderIntakesQuery.isLoading || returnOrderIntakesQuery.isFetching}
        onAddItem={addCreateItem}
        onChange={updateCreateForm}
        onItemChange={updateCreateItem}
        onRemoveItem={removeCreateItem}
        onSubmit={createReturn}
        storeConnections={returnStoreConnections}
        storeConnectionsLoading={returnStoreConnectionsQuery.isLoading || returnStoreConnectionsQuery.isFetching}
        variants={returnVariantOptions}
        variantsLoading={returnVariantsQuery.isLoading || returnVariantsQuery.isFetching}
        vendorOptions={returnVendorOptions}
        vendorsLoading={returnVendorOptionsQuery.isLoading || returnVendorOptionsQuery.isFetching}
      />

      <ReturnOpsTable
        isLoading={returnsQuery.isLoading || returnsQuery.isFetching}
        onInspect={selectInspectionRma}
        onStatusChange={updatePendingStatus}
        onStatusNoteChange={updateStatusNote}
        onStatusSave={saveReturnStatus}
        pendingRmaId={pendingRmaId}
        rmas={rmas}
        statusInputs={statusInputs}
        statusNotes={statusNotes}
        total={returnsQuery.data?.total ?? 0}
      />

      <ReturnInspectionPanel
        error={returnDetailQuery.error}
        form={inspectionForm}
        isLoading={returnDetailQuery.isLoading || returnDetailQuery.isFetching}
        onCancel={clearInspectionSelection}
        onFormChange={updateInspectionForm}
        onItemChange={updateInspectionItem}
        onSave={saveReturnInspection}
        pendingRmaId={inspectionPendingRmaId}
        rma={returnDetailQuery.data?.rma ?? null}
        selectedRmaId={selectedInspectionRmaId}
      />
    </div>
  );
}

function StoreConnectionOpsTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StoreConnectionStatusFilter>("all");
  const [platform, setPlatform] = useState<StoreConnectionPlatformFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "all" as StoreConnectionStatusFilter,
    platform: "all" as StoreConnectionPlatformFilter,
  });
  const [disableTarget, setDisableTarget] = useState<DropshipAdminStoreConnectionListItem | null>(null);
  const [disableReason, setDisableReason] = useState("Disabled by Card Shellz admin.");
  const [disablingConnectionId, setDisablingConnectionId] = useState<number | null>(null);
  const [repairingWebhookConnectionId, setRepairingWebhookConnectionId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const storeConnectionsUrl = useMemo(() => buildAdminStoreConnectionsUrl({
    search: appliedFilters.search,
    status: appliedFilters.status,
    platform: appliedFilters.platform,
  }), [appliedFilters]);

  const storeConnectionsQuery = useQuery<DropshipAdminStoreConnectionListResponse>({
    queryKey: [storeConnectionsUrl],
    queryFn: () => fetchJson<DropshipAdminStoreConnectionListResponse>(storeConnectionsUrl),
  });

  const connections = useMemo(
    () => storeConnectionsQuery.data?.items ?? [],
    [storeConnectionsQuery.data?.items],
  );
  const summary = useMemo(() => buildStoreConnectionSummary(connections), [connections]);

  function applyStoreFilters() {
    setAppliedFilters({ search, status, platform });
  }

  function openDisableStoreDialog(connection: DropshipAdminStoreConnectionListItem) {
    setDisableTarget(connection);
    setDisableReason(`Disabled by Card Shellz admin for ${storeConnectionDisplayName(connection)}.`);
    setError("");
    setMessage("");
  }

  async function confirmDisableStoreConnection() {
    if (!disableTarget) return;
    setDisablingConnectionId(disableTarget.storeConnectionId);
    setError("");
    setMessage("");
    try {
      await postJson<DropshipStoreConnectionDisconnectResponse>(
        `/api/dropship/admin/store-connections/${disableTarget.storeConnectionId}/disconnect`,
        buildStoreConnectionDisconnectInput({
          reason: disableReason,
          idempotencyKey: createDropshipIdempotencyKey(`admin-store-${disableTarget.storeConnectionId}-disconnect`),
        }),
      );
      setMessage(`${storeConnectionDisplayName(disableTarget)} was disabled. Intake and listing pushes are paused during the disconnect grace period.`);
      setDisableTarget(null);
      await Promise.all([
        storeConnectionsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Store disable request failed.");
    } finally {
      setDisablingConnectionId(null);
    }
  }

  async function repairShopifyWebhooks(connection: DropshipAdminStoreConnectionListItem) {
    setRepairingWebhookConnectionId(connection.storeConnectionId);
    setError("");
    setMessage("");
    try {
      const response = await postJson<DropshipAdminStoreWebhookRepairResponse>(
        `/api/dropship/admin/store-connections/${connection.storeConnectionId}/shopify-webhooks/repair`,
        buildAdminStoreWebhookRepairInput({
          idempotencyKey: createDropshipIdempotencyKey(`admin-store-${connection.storeConnectionId}-shopify-webhooks-repair`),
        }),
      );
      setMessage(`Shopify webhooks repaired for ${response.result.shopDomain}.`);
      await Promise.all([
        storeConnectionsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Shopify webhook repair failed.");
    } finally {
      setRepairingWebhookConnectionId(null);
    }
  }

  return (
    <div className="space-y-5">
      {(storeConnectionsQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || queryErrorMessage(storeConnectionsQuery.error, "Unable to load dropship store connections.")}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Customer store connections</h2>
            <p className="text-sm text-muted-foreground">
              Monitor connected dropship stores, owner identity, setup progress, sync recency, and operator actions.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Store, owner, email, or domain"
              />
            </div>
            <Select value={platform} onValueChange={(value) => setPlatform(value as StoreConnectionPlatformFilter)}>
              <SelectTrigger className="lg:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All platforms</SelectItem>
                <SelectItem value="ebay">eBay</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as StoreConnectionStatusFilter)}>
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {storeConnectionStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === "all" ? "All statuses" : formatStatus(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyStoreFilters}>
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <CatalogMetric icon={<Store className="h-4 w-4" />} label="Matching stores" value={String(storeConnectionsQuery.data?.total ?? 0)} />
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Ready for dogfood" value={String(summary.ready)} />
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Setup incomplete" value={String(summary.setupIncomplete)} />
        <CatalogMetric icon={<ShieldAlert className="h-4 w-4" />} label="Auth attention" value={String(summary.authAttention)} />
        <CatalogMetric icon={<MinusCircle className="h-4 w-4" />} label="Disabled" value={String(summary.disabled)} />
      </section>

      <StoreConnectionsTable
        connections={connections}
        isLoading={storeConnectionsQuery.isLoading || storeConnectionsQuery.isFetching}
        onDisableStoreConnection={openDisableStoreDialog}
        onRepairShopifyWebhooks={repairShopifyWebhooks}
        disablingConnectionId={disablingConnectionId}
        repairingWebhookConnectionId={repairingWebhookConnectionId}
        total={storeConnectionsQuery.data?.total ?? 0}
      />

      <Dialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open && disablingConnectionId === null) {
            setDisableTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable store connection</DialogTitle>
            <DialogDescription>
              This moves the store into disconnect grace, clears marketplace tokens, and pauses dropship intake and listing pushes for this store.
            </DialogDescription>
          </DialogHeader>
          {disableTarget && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="font-medium">{storeConnectionDisplayName(disableTarget)}</div>
                <div className="text-sm text-muted-foreground">
                  {formatStatus(disableTarget.platform)} / {storeConnectionOwnerLabel(disableTarget)}
                </div>
              </div>
              <div>
                <label className="text-sm font-medium" htmlFor="dropship-store-disable-reason">
                  Reason
                </label>
                <Textarea
                  id="dropship-store-disable-reason"
                  value={disableReason}
                  onChange={(event) => setDisableReason(event.target.value)}
                  className="mt-2 min-h-28"
                  maxLength={500}
                />
                <div className="mt-1 text-xs text-muted-foreground">
                  This reason is saved to audit history and included in the vendor notification.
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={disablingConnectionId !== null}
              onClick={() => setDisableTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={disablingConnectionId !== null || disableReason.trim().length === 0}
              onClick={confirmDisableStoreConnection}
            >
              {disablingConnectionId !== null ? "Disabling" : "Disable store"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OrderIntakeOpsTab({
  searchSignal,
}: {
  searchSignal: DropshipOpsSearchSignal | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<OrderOpsStatusFilter>("default");
  const [cancellationStatus, setCancellationStatus] = useState<OrderOpsCancellationStatusFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as OrderOpsStatusFilter,
    cancellationStatus: "all" as OrderOpsCancellationStatusFilter,
  });
  const [actionReason, setActionReason] = useState("");
  const [pendingAction, setPendingAction] = useState<{
    intakeId: number;
    action: OrderIntakeAdminAction;
  } | null>(null);
  const [selectedIntakeId, setSelectedIntakeId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const orderIntakeUrl = useMemo(() => buildAdminOrderIntakeUrl({
    search: appliedFilters.search,
    status: appliedFilters.status,
    cancellationStatus: appliedFilters.cancellationStatus,
  }), [appliedFilters]);

  const orderIntakeQuery = useQuery<DropshipAdminOrderOpsListResponse>({
    queryKey: [orderIntakeUrl],
    queryFn: () => fetchJson<DropshipAdminOrderOpsListResponse>(orderIntakeUrl),
  });
  const orderDetailQuery = useQuery<DropshipOrderDetailResponse>({
    queryKey: ["dropship-admin-order-detail", selectedIntakeId],
    queryFn: () => {
      if (selectedIntakeId === null) throw new Error("Missing selected intake.");
      return fetchJson<DropshipOrderDetailResponse>(`/api/dropship/admin/order-intake/${selectedIntakeId}`);
    },
    enabled: selectedIntakeId !== null,
  });
  const orderIntakes = orderIntakeQuery.data?.items ?? [];
  const orderRetryEligibilityNow = useMemo(() => new Date(), [orderIntakeQuery.dataUpdatedAt]);

  useEffect(() => {
    if (!searchSignal) return;
    setSearch(searchSignal.search);
    setStatus("all");
    setCancellationStatus("all");
    setAppliedFilters({
      search: searchSignal.search,
      status: "all",
      cancellationStatus: "all",
    });
  }, [searchSignal]);

  function applyOrderFilters() {
    setAppliedFilters({ search, status, cancellationStatus });
  }

  async function runOrderAction(
    intake: DropshipAdminOrderOpsIntakeListItem,
    action: OrderIntakeAdminAction,
  ) {
    setPendingAction({ intakeId: intake.intakeId, action });
    setError("");
    setMessage("");
    try {
      const input = buildAdminOrderOpsActionInput({
        idempotencyKey: createDropshipIdempotencyKey(`admin-order-${action}-${intake.intakeId}`),
        reason: actionReason,
        requireReason: action === "exception",
      });
      const response = await postJson<
        DropshipAdminOrderOpsActionResponse
        | DropshipAdminOrderOpsCancellationRetryResponse
        | DropshipAdminOrderOpsProcessResponse
        | DropshipAdminOrderOpsWmsSyncResponse
      >(
        `/api/dropship/admin/order-intake/${intake.intakeId}/${action}`,
        input,
      );
      setMessage(orderActionMessage(response, action));
      setActionReason("");
      await Promise.all([
        orderIntakeQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dropship order intake action failed.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-5">
      {(orderIntakeQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || queryErrorMessage(orderIntakeQuery.error, "Unable to load dropship order intake exceptions.")}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Order intake exceptions</h2>
            <p className="text-sm text-muted-foreground">
              Review marketplace intake rows, retry recoverable failures, and mark unresolved rows as ops exceptions.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Order, vendor, store, or customer"
              />
            </div>
            <Select value={status} onValueChange={(value) => setStatus(value as OrderOpsStatusFilter)}>
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {orderOpsStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {orderOpsStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={cancellationStatus}
              onValueChange={(value) => setCancellationStatus(value as OrderOpsCancellationStatusFilter)}
            >
              <SelectTrigger className="lg:w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {orderOpsCancellationStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {orderOpsCancellationStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyOrderFilters}>
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_0.45fr]">
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-order-ops-reason">Action reason</label>
            <Input
              id="dropship-order-ops-reason"
              className="mt-2"
              value={actionReason}
              onChange={(event) => setActionReason(event.target.value)}
              placeholder="Required for exception; optional for retry"
              maxLength={1000}
            />
          </div>
          <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Actions are idempotent and audited. Process runs quote, wallet, reservation, and OMS creation now; retry queues failed rows; exception marks manual resolution.
          </div>
        </div>
      </section>

      <OrderIntakeSummary
        cancellationSummary={orderIntakeQuery.data?.cancellationSummary ?? []}
        summary={orderIntakeQuery.data?.summary ?? []}
        total={orderIntakeQuery.data?.total ?? 0}
      />

      <OrderIntakeOpsTable
        isLoading={orderIntakeQuery.isLoading || orderIntakeQuery.isFetching}
        items={orderIntakes}
        selectedIntakeId={selectedIntakeId}
        pendingAction={pendingAction}
        retryEligibilityNow={orderRetryEligibilityNow}
        total={orderIntakeQuery.data?.total ?? 0}
        onSelectDetail={(intake) => setSelectedIntakeId(intake.intakeId)}
        onRunAction={runOrderAction}
      />
      <OrderIntakeDetailPanel
        error={orderDetailQuery.error}
        isLoading={orderDetailQuery.isLoading || orderDetailQuery.isFetching}
        onClose={() => setSelectedIntakeId(null)}
        order={orderDetailQuery.data?.order ?? null}
        selectedIntakeId={selectedIntakeId}
      />
    </div>
  );
}

function WalletOpsTab() {
  const queryClient = useQueryClient();
  const [vendorId, setVendorId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [usdcVendorId, setUsdcVendorId] = useState("");
  const [usdcFundingMethodId, setUsdcFundingMethodId] = useState("");
  const [usdcDollarAmount, setUsdcDollarAmount] = useState("");
  const [usdcAmount, setUsdcAmount] = useState("");
  const [usdcTransactionHash, setUsdcTransactionHash] = useState("");
  const [usdcFromAddress, setUsdcFromAddress] = useState("");
  const [usdcToAddress, setUsdcToAddress] = useState("");
  const [usdcConfirmations, setUsdcConfirmations] = useState("12");
  const [manualCreditIdempotencyKey, setManualCreditIdempotencyKey] = useState(() =>
    createDropshipIdempotencyKey("admin-wallet-credit")
  );
  const [usdcCreditIdempotencyKey, setUsdcCreditIdempotencyKey] = useState(() =>
    createDropshipIdempotencyKey("admin-usdc-credit")
  );
  const [pendingAction, setPendingAction] = useState<"manual" | "usdc" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pending = pendingAction !== null;
  const walletVendorOptionsUrl = useMemo(() => buildAdminDogfoodReadinessUrl({
    search: "",
    status: "all",
    platform: "all",
    limit: 250,
  }), []);
  const walletVendorOptionsQuery = useQuery<DropshipDogfoodReadinessResponse>({
    queryKey: [walletVendorOptionsUrl, "wallet-vendors"],
    queryFn: () => fetchJson<DropshipDogfoodReadinessResponse>(walletVendorOptionsUrl),
  });
  const selectedUsdcVendorId = usdcVendorId.trim();
  const usdcWalletQuery = useQuery<DropshipWalletResponse>({
    queryKey: ["/api/dropship/admin/wallet/vendors", selectedUsdcVendorId],
    queryFn: () => fetchJson<DropshipWalletResponse>(`/api/dropship/admin/wallet/vendors/${selectedUsdcVendorId}`),
    enabled: /^[1-9]\d*$/.test(selectedUsdcVendorId),
  });
  const vendorSelectOptions = useMemo(
    () => buildVendorSelectOptions(walletVendorOptionsQuery.data?.items ?? []),
    [walletVendorOptionsQuery.data?.items],
  );
  const usdcFundingMethodOptions = useMemo(
    () => (usdcWalletQuery.data?.wallet.fundingMethods ?? [])
      .filter((method) => method.rail === "usdc_base")
      .sort((first, second) => {
        if (first.isDefault !== second.isDefault) return Number(second.isDefault) - Number(first.isDefault);
        if (first.status !== second.status) return first.status.localeCompare(second.status);
        return first.fundingMethodId - second.fundingMethodId;
      })
      .map((method) => ({
        value: String(method.fundingMethodId),
        label: method.displayLabel || formatStatus(method.rail),
        detail: [
          `ID ${method.fundingMethodId}`,
          formatStatus(method.status),
          method.isDefault ? "default" : "",
          method.usdcWalletAddress ? truncateMiddle(method.usdcWalletAddress, 16) : "",
        ].filter(Boolean).join(" / "),
      })),
    [usdcWalletQuery.data?.wallet.fundingMethods],
  );

  function resetManualCreditIdempotencyKey() {
    setManualCreditIdempotencyKey(createDropshipIdempotencyKey("admin-wallet-credit"));
  }

  function resetUsdcCreditIdempotencyKey() {
    setUsdcCreditIdempotencyKey(createDropshipIdempotencyKey("admin-usdc-credit"));
  }

  async function creditWallet() {
    setPendingAction("manual");
    setError("");
    setMessage("");
    try {
      const input = buildAdminWalletManualCreditInput({
        vendorId,
        amount,
        reason,
        idempotencyKey: manualCreditIdempotencyKey,
      });
      const response = await postJson<DropshipAdminWalletManualCreditResponse>(
        "/api/dropship/admin/wallet/manual-credit",
        input,
      );
      setMessage(response.idempotentReplay
        ? `Vendor ${response.account.vendorId} wallet credit already recorded for ${formatCents(response.ledgerEntry.amountCents)}.`
        : `Vendor ${response.account.vendorId} wallet credited ${formatCents(response.ledgerEntry.amountCents)}.`);
      setAmount("");
      setReason("");
      resetManualCreditIdempotencyKey();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Manual wallet credit failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function creditConfirmedUsdc() {
    setPendingAction("usdc");
    setError("");
    setMessage("");
    try {
      const input = buildAdminWalletConfirmedUsdcCreditInput({
        vendorId: usdcVendorId,
        fundingMethodId: usdcFundingMethodId,
        amount: usdcDollarAmount,
        usdcAmount,
        transactionHash: usdcTransactionHash,
        fromAddress: usdcFromAddress,
        toAddress: usdcToAddress,
        confirmations: usdcConfirmations,
        idempotencyKey: usdcCreditIdempotencyKey,
      });
      const response = await postJson<DropshipAdminWalletConfirmedUsdcCreditResponse>(
        "/api/dropship/admin/wallet/usdc/confirmed-credit",
        input,
      );
      setMessage(response.idempotentReplay
        ? `Vendor ${response.account.vendorId} USDC transfer already credited for ${formatCents(response.ledgerEntry.amountCents)}.`
        : `Vendor ${response.account.vendorId} USDC transfer credited ${formatCents(response.ledgerEntry.amountCents)}.`);
      setUsdcDollarAmount("");
      setUsdcAmount("");
      setUsdcTransactionHash("");
      setUsdcFromAddress("");
      setUsdcToAddress("");
      setUsdcConfirmations("12");
      resetUsdcCreditIdempotencyKey();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "USDC wallet credit failed.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-5">
      {(walletVendorOptionsQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || queryErrorMessage(walletVendorOptionsQuery.error, "Unable to load dropship vendors.")}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Manual wallet credit</h2>
            <p className="text-sm text-muted-foreground">Admin-only settled funding credit for dogfood and operational correction.</p>
          </div>
          <Wallet className="h-5 w-5 text-muted-foreground" />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[0.45fr_0.45fr_1.1fr_auto] lg:items-end">
          <SearchableOptionPicker
            label="Vendor"
            value={vendorId}
            onChange={(value) => {
              setVendorId(value);
              resetManualCreditIdempotencyKey();
            }}
            options={vendorSelectOptions}
            isLoading={walletVendorOptionsQuery.isLoading || walletVendorOptionsQuery.isFetching}
            placeholder="Select vendor"
            searchPlaceholder="Search vendor, email, or member..."
            emptyText="No dropship vendors found."
          />
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-wallet-credit-amount">
              Amount
            </label>
            <Input
              id="dropship-wallet-credit-amount"
              className="mt-2"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                resetManualCreditIdempotencyKey();
              }}
              inputMode="decimal"
              placeholder="250.00"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-wallet-credit-reason">
              Reason
            </label>
            <Textarea
              id="dropship-wallet-credit-reason"
              className="mt-2 min-h-10"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                resetManualCreditIdempotencyKey();
              }}
              maxLength={1000}
              placeholder="Dogfood wallet seed"
            />
          </div>
          <Button
            className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
            disabled={pending}
            onClick={creditWallet}
          >
            <Wallet className={pendingAction === "manual" ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
            Credit
          </Button>
        </div>
      </section>

      <section className="rounded-md border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Confirmed USDC transfer</h2>
            <p className="text-sm text-muted-foreground">Admin-only settled credit for a verified Base transaction. Wallet ledger and USDC ledger are recorded atomically.</p>
          </div>
          <CircleDollarSign className="h-5 w-5 text-muted-foreground" />
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-4">
          <SearchableOptionPicker
            label="Vendor"
            value={usdcVendorId}
            onChange={(value) => {
              setUsdcVendorId(value);
              setUsdcFundingMethodId("");
              resetUsdcCreditIdempotencyKey();
            }}
            options={vendorSelectOptions}
            isLoading={walletVendorOptionsQuery.isLoading || walletVendorOptionsQuery.isFetching}
            placeholder="Select vendor"
            searchPlaceholder="Search vendor, email, or member..."
            emptyText="No dropship vendors found."
          />
          <div>
            <label className="text-sm font-medium">Funding method</label>
            <Select
              value={usdcFundingMethodId || NO_DEFAULT_WAREHOUSE_VALUE}
              onValueChange={(value) => {
                setUsdcFundingMethodId(value === NO_DEFAULT_WAREHOUSE_VALUE ? "" : value);
                resetUsdcCreditIdempotencyKey();
              }}
              disabled={!selectedUsdcVendorId || usdcWalletQuery.isLoading || usdcWalletQuery.isFetching}
            >
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Select funding method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEFAULT_WAREHOUSE_VALUE}>No funding method</SelectItem>
                {usdcFundingMethodOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label} - {option.detail}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {usdcWalletQuery.error && (
              <p className="mt-1 text-xs text-rose-700">
                {queryErrorMessage(usdcWalletQuery.error, "Unable to load vendor wallet.")}
              </p>
            )}
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-usdc-dollar-amount">
              Wallet credit
            </label>
            <Input
              id="dropship-usdc-dollar-amount"
              className="mt-2"
              value={usdcDollarAmount}
              onChange={(event) => {
                setUsdcDollarAmount(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              inputMode="decimal"
              placeholder="125.50"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-usdc-amount">
              USDC amount
            </label>
            <Input
              id="dropship-usdc-amount"
              className="mt-2"
              value={usdcAmount}
              onChange={(event) => {
                setUsdcAmount(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              inputMode="decimal"
              placeholder="125.50"
            />
          </div>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr_1fr_0.4fr]">
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-usdc-transaction">
              Transaction hash
            </label>
            <Input
              id="dropship-usdc-transaction"
              className="mt-2 font-mono text-xs"
              value={usdcTransactionHash}
              onChange={(event) => {
                setUsdcTransactionHash(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              placeholder="0x..."
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-usdc-from">
              From address
            </label>
            <Input
              id="dropship-usdc-from"
              className="mt-2 font-mono text-xs"
              value={usdcFromAddress}
              onChange={(event) => {
                setUsdcFromAddress(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              placeholder="Optional"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-usdc-to">
              To address
            </label>
            <Input
              id="dropship-usdc-to"
              className="mt-2 font-mono text-xs"
              value={usdcToAddress}
              onChange={(event) => {
                setUsdcToAddress(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              placeholder="0x..."
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="dropship-usdc-confirmations">
              Confirmations
            </label>
            <Input
              id="dropship-usdc-confirmations"
              className="mt-2"
              value={usdcConfirmations}
              onChange={(event) => {
                setUsdcConfirmations(event.target.value);
                resetUsdcCreditIdempotencyKey();
              }}
              inputMode="numeric"
              placeholder="12"
            />
          </div>
        </div>

        <Button
          className="mt-4 h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
          disabled={pending}
          onClick={creditConfirmedUsdc}
        >
          <CircleDollarSign className={pendingAction === "usdc" ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
          Credit USDC
        </Button>
      </section>
    </div>
  );
}

function CatalogExposureTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [visibilityFilter, setVisibilityFilter] = useState<CatalogPreviewVisibilityFilter>("all");
  const [catalogStatusFilter, setCatalogStatusFilter] = useState<CatalogPreviewStatusFilter>("active");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    visibility: "all" as CatalogPreviewVisibilityFilter,
    catalogStatus: "active" as CatalogPreviewStatusFilter,
  });
  const [previewPage, setPreviewPage] = useState(1);
  const [draftRules, setDraftRules] = useState<DropshipAdminCatalogExposureRuleInput[]>([]);
  const [loadedRulesKey, setLoadedRulesKey] = useState("");
  const [ruleForm, setRuleForm] = useState<CatalogRuleFormState>(emptyCatalogRuleForm);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const previewUrl = useMemo(() => buildAdminCatalogExposurePreviewUrl({
    search: appliedFilters.search,
    visibility: appliedFilters.visibility,
    catalogStatus: appliedFilters.catalogStatus,
    page: previewPage,
    limit: CATALOG_PREVIEW_PAGE_SIZE,
  }), [appliedFilters, previewPage]);

  const rulesQuery = useQuery<DropshipAdminCatalogExposureRulesResponse>({
    queryKey: ["/api/dropship/admin/catalog/rules"],
    queryFn: () => fetchJson<DropshipAdminCatalogExposureRulesResponse>("/api/dropship/admin/catalog/rules"),
  });
  const previewQuery = useQuery<DropshipAdminCatalogExposurePreviewResponse>({
    queryKey: [previewUrl],
    queryFn: () => fetchJson<DropshipAdminCatalogExposurePreviewResponse>(previewUrl),
  });
  const productLinesQuery = useQuery<DropshipProductLineOption[]>({
    queryKey: ["/api/product-lines", "active"],
    queryFn: () => fetchJson<DropshipProductLineOption[]>("/api/product-lines?status=active"),
  });
  const categoriesQuery = useQuery<DropshipProductCategoryOption[]>({
    queryKey: ["/api/product-categories"],
    queryFn: () => fetchJson<DropshipProductCategoryOption[]>("/api/product-categories"),
  });
  const productsQuery = useQuery<DropshipProductOption[]>({
    queryKey: ["/api/products", "active-options"],
    queryFn: () => fetchJson<DropshipProductOption[]>("/api/products"),
  });
  const variantsQuery = useQuery<DropshipProductVariantOption[]>({
    queryKey: ["/api/product-variants", "active-options"],
    queryFn: () => fetchJson<DropshipProductVariantOption[]>("/api/product-variants"),
  });

  const previewRows = previewQuery.data?.rows ?? [];
  const previewTotal = previewQuery.data?.total ?? 0;
  const previewLimit = previewQuery.data?.limit ?? CATALOG_PREVIEW_PAGE_SIZE;
  const previewTotalPages = Math.max(1, Math.ceil(previewTotal / previewLimit));
  const activeRuleInputs = useMemo(
    () => normalizeCatalogRuleOrder((rulesQuery.data?.rules ?? [])
      .filter((rule) => rule.isActive !== false)
      .map(catalogExposureRecordToInput)),
    [rulesQuery.data?.rules],
  );
  const activeRulesKey = useMemo(() => catalogExposureRulesStateKey(activeRuleInputs), [activeRuleInputs]);
  const draftRulesKey = useMemo(() => catalogExposureRulesStateKey(draftRules), [draftRules]);
  const hasUnsavedExposureChanges = draftRulesKey !== activeRulesKey;
  const unsavedExposureRuleCount = hasUnsavedExposureChanges ? draftRules.length : 0;
  const productLineOptions = useMemo(
    () => (productLinesQuery.data ?? [])
      .filter((line) => line.status === undefined || line.status === null || line.status === "active")
      .sort((first, second) => first.name.localeCompare(second.name)),
    [productLinesQuery.data],
  );
  const categoryOptions = useMemo(
    () => (categoriesQuery.data ?? [])
      .filter((category) => category.isActive !== false)
      .sort((first, second) => first.name.localeCompare(second.name)),
    [categoriesQuery.data],
  );
  const productOptions = useMemo(
    () => (productsQuery.data ?? [])
      .filter((product) => product.status ? product.status === "active" : product.active !== 0)
      .sort((first, second) => {
        const firstSku = first.sku ?? first.baseSku ?? "";
        const secondSku = second.sku ?? second.baseSku ?? "";
        const skuCompare = firstSku.localeCompare(secondSku);
        return skuCompare !== 0 ? skuCompare : first.name.localeCompare(second.name);
      }),
    [productsQuery.data],
  );
  const variantOptions = useMemo(
    () => (variantsQuery.data ?? [])
      .filter((variant) => variant.isActive !== false && variant.active !== 0)
      .sort((first, second) => {
        const skuCompare = (first.sku ?? "").localeCompare(second.sku ?? "");
        if (skuCompare !== 0) return skuCompare;
        const nameCompare = first.name.localeCompare(second.name);
        return nameCompare !== 0 ? nameCompare : first.id - second.id;
      }),
    [variantsQuery.data],
  );
  const catalogRuleTargetLabels = useMemo<CatalogRuleTargetLabels>(() => ({
    productLineNamesById: new Map(productLineOptions.map((line) => [line.id, line.name])),
    productLabelsById: new Map(productOptions.map((product) => [
      product.id,
      [product.sku ?? product.baseSku, product.name].filter(Boolean).join(" - ") || `Product ${product.id}`,
    ])),
    variantLabelsById: new Map(variantOptions.map((variant) => [
      variant.id,
      [variant.sku, variant.name].filter(Boolean).join(" - ") || `Variant ${variant.id}`,
    ])),
    categoryLabelsByKey: new Map(categoryOptions.map((category) => [
      normalizeCatalogRuleLabelKey(category.name),
      category.name,
    ])),
  }), [categoryOptions, productLineOptions, productOptions, variantOptions]);

  useEffect(() => {
    if (!rulesQuery.data) return;
    if (activeRulesKey === loadedRulesKey) return;
    setDraftRules(activeRuleInputs);
    setLoadedRulesKey(activeRulesKey);
  }, [activeRuleInputs, activeRulesKey, loadedRulesKey, rulesQuery.data]);

  useEffect(() => {
    if (!previewQuery.data || previewPage <= previewTotalPages) return;
    setPreviewPage(previewTotalPages);
  }, [previewPage, previewQuery.data, previewTotalPages]);

  function applyCatalogFilters() {
    setAppliedFilters({
      search,
      visibility: visibilityFilter,
      catalogStatus: catalogStatusFilter,
    });
    setPreviewPage(1);
  }

  function applyVisibilityFilter(value: CatalogPreviewVisibilityFilter) {
    setVisibilityFilter(value);
    setAppliedFilters((current) => ({ ...current, visibility: value }));
    setPreviewPage(1);
  }

  function applyCatalogStatusFilter(value: CatalogPreviewStatusFilter) {
    setCatalogStatusFilter(value);
    setAppliedFilters((current) => ({ ...current, catalogStatus: value }));
    setPreviewPage(1);
  }

  function addRuleFromForm() {
    try {
      const rule = buildCatalogExposureRuleInput({
        ...ruleForm,
        priority: draftRules.length,
      });
      upsertDraftRule(rule);
      setRuleDialogOpen(false);
      setRuleForm(emptyCatalogRuleForm);
      setMessage(`${catalogExposureActionLabel(rule.action)} ${catalogRuleTargetLabel(rule, catalogRuleTargetLabels)} added to unsaved changes.`);
      setError("");
    } catch (caught) {
      setMessage("");
      setError(caught instanceof Error ? caught.message : "Catalog exposure rule is invalid.");
    }
  }

  function addCatalogWideRule(action: CatalogExposureActionFilter) {
    const rule = buildCatalogExposureRuleInput({
      scopeType: "catalog",
      action,
      priority: draftRules.length,
      notes: `${catalogExposureActionLabel(action)} entire active catalog`,
      metadata: {
        source: "admin_catalog_quick_action",
      },
    });
    upsertDraftRule(rule);
    setMessage(`${catalogExposureActionLabel(action)} entire active catalog added to unsaved changes.`);
    setError("");
  }

  function clearDraftRules() {
    setDraftRules(activeRuleInputs);
    setMessage("Unsaved exposure changes reverted.");
    setError("");
  }

  function addPreviewRule(
    row: DropshipAdminCatalogExposurePreviewRow,
    action: CatalogExposureActionFilter,
  ) {
    try {
      const rule = buildCatalogExposureRuleFromPreviewRow({
        row,
        scopeType: "variant",
        action,
      });
      upsertDraftRule({
        ...rule,
        priority: draftRules.length,
        notes: rule.notes
          ?.replace(/^Include /, "Expose ")
          .replace(/^Exclude /, "Hide ") ?? rule.notes,
      });
      setMessage(`${catalogExposureActionLabel(action)} variant rule added to unsaved changes.`);
      setError("");
    } catch (caught) {
      setMessage("");
      setError(caught instanceof Error ? caught.message : "Catalog exposure rule is invalid.");
    }
  }

  function upsertDraftRule(rule: DropshipAdminCatalogExposureRuleInput) {
    const targetKey = catalogExposureRuleTargetKey(rule);
    setDraftRules((current) => {
      const existingIndex = current.findIndex((existing) => catalogExposureRuleTargetKey(existing) === targetKey);
      if (existingIndex < 0) {
        return normalizeCatalogRuleOrder([...current, rule]);
      }
      return normalizeCatalogRuleOrder(current.map((existing, index) => (index === existingIndex ? rule : existing)));
    });
  }

  function catalogExposureRuleTargetKey(rule: DropshipAdminCatalogExposureRuleInput): string {
    return [
      rule.scopeType,
      rule.productVariantId ?? "",
      rule.productId ?? "",
      rule.category ?? "",
      rule.productLineId ?? "",
    ].join("|");
  }

  function removeDraftRule(rule: DropshipAdminCatalogExposureRuleInput) {
    const ruleKey = catalogExposureRuleKey(rule);
    setDraftRules((current) => normalizeCatalogRuleOrder(
      current.filter((existing) => catalogExposureRuleKey(existing) !== ruleKey),
    ));
  }

  function moveDraftRule(rule: DropshipAdminCatalogExposureRuleInput, direction: -1 | 1) {
    const ruleKey = catalogExposureRuleKey(rule);
    setDraftRules((current) => {
      const currentIndex = current.findIndex((existing) => catalogExposureRuleKey(existing) === ruleKey);
      const nextIndex = currentIndex + direction;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[currentIndex], next[nextIndex]] = [next[nextIndex], next[currentIndex]];
      return normalizeCatalogRuleOrder(next);
    });
  }

  async function saveDraftRules() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const orderedRules = normalizeCatalogRuleOrder(draftRules);
      const orderedRulesKey = catalogExposureRulesStateKey(orderedRules);
      const result = await putJson<DropshipAdminCatalogExposureRulesReplaceResponse>(
        "/api/dropship/admin/catalog/rules",
        {
          idempotencyKey: createDropshipIdempotencyKey("admin-catalog-exposure"),
          rules: orderedRules,
        },
      );
      setDraftRules(orderedRules);
      setLoadedRulesKey(orderedRulesKey);
      setMessage(`Catalog exposure rules published as revision ${result.revisionId}.`);
      await Promise.all([
        rulesQuery.refetch(),
        previewQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Catalog exposure save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {(rulesQuery.error || previewQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error
              || queryErrorMessage(rulesQuery.error ?? previewQuery.error, "Dropship catalog exposure request failed.")}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <CatalogMetric icon={<Boxes className="h-4 w-4" />} label="Active rules" value={String(activeRuleInputs.length)} />
        <CatalogMetric icon={<FileSearch className="h-4 w-4" />} label="Unsaved changes" value={String(unsavedExposureRuleCount)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
        <section className="rounded-md border bg-card p-4">
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">Catalog exposure</h2>
              <p className="text-sm text-muted-foreground">
                Publish the catalog vendors can see. Rules run top to bottom, and later matching rules override earlier ones.
              </p>
            </div>
            <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              Common setup: expose the entire active catalog first, then add hide rules below it for exceptions.
            </div>
            <div className="grid gap-2">
              <Button type="button" className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={() => addCatalogWideRule("include")}>
                <PlusCircle className="h-4 w-4" />
                Expose entire active catalog
              </Button>
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => {
                  setRuleForm(emptyCatalogRuleForm);
                  setRuleDialogOpen(true);
                }}
              >
                <PlusCircle className="h-4 w-4" />
                Add exposure rule
              </Button>
            </div>
          </div>
        </section>

        <CatalogDraftRulesTable
          hasUnsavedChanges={hasUnsavedExposureChanges}
          targetLabels={catalogRuleTargetLabels}
          rules={draftRules}
          isLoading={rulesQuery.isLoading}
          isSaving={saving}
          onClearRules={clearDraftRules}
          onMoveRule={moveDraftRule}
          onRemoveRule={removeDraftRule}
          onSaveRules={saveDraftRules}
        />
      </div>

      <CatalogRuleDialog
        open={ruleDialogOpen}
        onOpenChange={setRuleDialogOpen}
        onSubmit={addRuleFromForm}
        categoryOptions={categoryOptions}
        isLoadingCategories={categoriesQuery.isLoading || categoriesQuery.isFetching}
        isLoadingProductLines={productLinesQuery.isLoading || productLinesQuery.isFetching}
        isLoadingProducts={productsQuery.isLoading || productsQuery.isFetching}
        isLoadingVariants={variantsQuery.isLoading || variantsQuery.isFetching}
        productLineOptions={productLineOptions}
        productOptions={productOptions}
        ruleForm={ruleForm}
        setRuleForm={setRuleForm}
        variantOptions={variantOptions}
      />

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Catalog preview</h2>
            <p className="text-sm text-muted-foreground">Verify current exposure decisions before vendors select products.</p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Search SKU, product, or variant"
              />
            </div>
            <Select
              value={visibilityFilter}
              onValueChange={(value) => applyVisibilityFilter(value as CatalogPreviewVisibilityFilter)}
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All visibility</SelectItem>
                <SelectItem value="visible">Visible only</SelectItem>
                <SelectItem value="hidden">Hidden only</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={catalogStatusFilter}
              onValueChange={(value) => applyCatalogStatusFilter(value as CatalogPreviewStatusFilter)}
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active only</SelectItem>
                <SelectItem value="inactive">Inactive only</SelectItem>
                <SelectItem value="all">Both</SelectItem>
              </SelectContent>
            </Select>
            <Button className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyCatalogFilters}>
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>

        <CatalogPreviewTable
          isLoading={previewQuery.isLoading || previewQuery.isFetching}
          limit={previewLimit}
          page={previewQuery.data?.page ?? previewPage}
          rows={previewRows}
          total={previewTotal}
          totalPages={previewTotalPages}
          onAddPreviewRule={addPreviewRule}
          onPageChange={setPreviewPage}
        />
      </section>
    </div>
  );
}

function ShippingConfigTab() {
  const queryClient = useQueryClient();
  const [boxForm, setBoxForm] = useState<ShippingBoxFormState>(emptyShippingBoxForm);
  const [profileForm, setProfileForm] = useState<ShippingPackageProfileFormState>(emptyShippingPackageProfileForm);
  const [zoneForm, setZoneForm] = useState<ShippingZoneRuleFormState>(emptyShippingZoneRuleForm);
  const [rateForm, setRateForm] = useState<ShippingRateTableFormState>(emptyShippingRateTableForm);
  const [markupForm, setMarkupForm] = useState<ShippingMarkupPolicyFormState>(emptyShippingMarkupPolicyForm);
  const [insuranceForm, setInsuranceForm] = useState<ShippingInsurancePolicyFormState>(emptyShippingInsurancePolicyForm);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<ShippingConfigSectionKey>("overview");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const shippingConfigUrl = useMemo(
    () => buildAdminShippingConfigUrl({ packageProfileLimit: 250, rateTableLimit: 100 }),
    [],
  );
  const shippingQuery = useQuery<DropshipAdminShippingConfigResponse>({
    queryKey: [shippingConfigUrl],
    queryFn: () => fetchJson<DropshipAdminShippingConfigResponse>(shippingConfigUrl),
  });
  const variantsQuery = useQuery<DropshipProductVariantOption[]>({
    queryKey: ["/api/product-variants"],
    queryFn: () => fetchJson<DropshipProductVariantOption[]>("/api/product-variants"),
  });
  const warehousesQuery = useQuery<DropshipWarehouseOption[]>({
    queryKey: ["/api/warehouses"],
    queryFn: () => fetchJson<DropshipWarehouseOption[]>("/api/warehouses"),
  });
  const config = shippingQuery.data?.config;
  const productVariantOptions = useMemo(
    () => (variantsQuery.data ?? [])
      .filter((variant) => variant.isActive !== false && variant.active !== 0)
      .sort((first, second) => {
        const skuCompare = (first.sku ?? "").localeCompare(second.sku ?? "");
        if (skuCompare !== 0) return skuCompare;
        const nameCompare = first.name.localeCompare(second.name);
        return nameCompare !== 0 ? nameCompare : first.id - second.id;
      }),
    [variantsQuery.data],
  );
  const warehouseOptions = useMemo(
    () => (warehousesQuery.data ?? [])
      .filter((warehouse) => warehouse.isActive === 1 && warehouse.warehouseType !== "bulk_storage")
      .sort((first, second) => {
        if (first.isDefault !== second.isDefault) return second.isDefault - first.isDefault;
        return first.name.localeCompare(second.name);
      }),
    [warehousesQuery.data],
  );

  async function runShippingAction(action: string, task: () => Promise<void>) {
    setPendingAction(action);
    setError("");
    setMessage("");
    try {
      await task();
      await Promise.all([
        shippingQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Shipping config save failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function saveBox() {
    await runShippingAction("box", async () => {
      await putJson("/api/dropship/admin/shipping/boxes", buildShippingBoxInput({
        code: boxForm.code,
        name: boxForm.name,
        lengthMm: inchesToMillimetersString(boxForm.lengthIn, "length"),
        widthMm: inchesToMillimetersString(boxForm.widthIn, "width"),
        heightMm: inchesToMillimetersString(boxForm.heightIn, "height"),
        tareWeightGrams: poundsToGramsString(boxForm.tareWeightLb, "tare weight"),
        maxWeightGrams: boxForm.maxWeightLb.trim() ? poundsToGramsString(boxForm.maxWeightLb, "max weight") : "",
        isActive: boxForm.isActive,
        idempotencyKey: createDropshipIdempotencyKey("shipping-box"),
      }));
      setBoxForm(emptyShippingBoxForm);
      setMessage("Box saved.");
    });
  }

  async function savePackageProfile() {
    await runShippingAction("profile", async () => {
      await putJson("/api/dropship/admin/shipping/package-profiles", buildShippingPackageProfileInput({
        productVariantId: profileForm.productVariantId,
        weightGrams: poundsToGramsString(profileForm.weightLb, "weight"),
        lengthMm: inchesToMillimetersString(profileForm.lengthIn, "length"),
        widthMm: inchesToMillimetersString(profileForm.widthIn, "width"),
        heightMm: inchesToMillimetersString(profileForm.heightIn, "height"),
        shipAlone: profileForm.shipAlone,
        defaultCarrier: profileForm.defaultCarrier,
        defaultService: profileForm.defaultService,
        defaultBoxId: profileForm.defaultBoxId,
        maxUnitsPerPackage: profileForm.maxUnitsPerPackage,
        isActive: profileForm.isActive,
        idempotencyKey: createDropshipIdempotencyKey("shipping-package-profile"),
      }));
      setProfileForm(emptyShippingPackageProfileForm);
      setMessage("Product shipping profile saved.");
    });
  }

  async function saveZoneRule() {
    await runShippingAction("zone", async () => {
      await putJson("/api/dropship/admin/shipping/zone-rules", buildShippingZoneRuleInput({
        ...zoneForm,
        idempotencyKey: createDropshipIdempotencyKey("shipping-zone-rule"),
      }));
      setZoneForm(emptyShippingZoneRuleForm);
      setMessage("Zone rule saved.");
    });
  }

  async function saveRateTable() {
    await runShippingAction("rate", async () => {
      await postJson("/api/dropship/admin/shipping/rate-tables", buildShippingRateTableInput({
        ...rateForm,
        idempotencyKey: createDropshipIdempotencyKey("shipping-rate-table"),
      }));
      setRateForm(emptyShippingRateTableForm);
      setMessage("Rate table created.");
    });
  }

  async function saveMarkupPolicy() {
    await runShippingAction("markup", async () => {
      await postJson("/api/dropship/admin/shipping/markup-policies", buildShippingMarkupPolicyInput({
        ...markupForm,
        idempotencyKey: createDropshipIdempotencyKey("shipping-markup-policy"),
      }));
      setMarkupForm(emptyShippingMarkupPolicyForm);
      setMessage("Shipping markup policy created.");
    });
  }

  async function saveInsurancePolicy() {
    await runShippingAction("insurance", async () => {
      await postJson("/api/dropship/admin/shipping/insurance-policies", buildShippingInsurancePolicyInput({
        ...insuranceForm,
        idempotencyKey: createDropshipIdempotencyKey("shipping-insurance-policy"),
      }));
      setInsuranceForm(emptyShippingInsurancePolicyForm);
      setMessage("Insurance pool policy created.");
    });
  }

  return (
    <div className="space-y-5">
      {(shippingQuery.error || warehousesQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || queryErrorMessage(shippingQuery.error ?? warehousesQuery.error, "Unable to load dropship shipping config.")}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <Tabs
        value={activeSection}
        onValueChange={(value) => setActiveSection(value as ShippingConfigSectionKey)}
        className="space-y-5"
      >
        <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-md border bg-muted/50 p-1">
          {shippingConfigSections.map((section) => (
            <TabsTrigger key={section.key} value={section.key} className="shrink-0 px-4 py-2">
              {section.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="m-0 space-y-5">
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <CatalogMetric icon={<Boxes className="h-4 w-4" />} label="Active boxes" value={String(activeCount(config?.boxes))} />
            <CatalogMetric icon={<Truck className="h-4 w-4" />} label="Product profiles" value={String(config?.packageProfiles.length ?? 0)} />
            <CatalogMetric icon={<FileSearch className="h-4 w-4" />} label="Zone rules" value={String(activeCount(config?.zoneRules))} />
            <CatalogMetric icon={<Wallet className="h-4 w-4" />} label="Active rate tables" value={String(activeRateTableCount(config))} />
          </section>
          <ShippingConfigOverviewDashboard config={config ?? null} isLoading={shippingQuery.isLoading} />
        </TabsContent>

        <TabsContent value="boxes" className="m-0">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <ShippingBoxPanel
              form={boxForm}
              isSaving={pendingAction === "box"}
              onChange={setBoxForm}
              onSave={saveBox}
            />
            <ShippingBoxesTable config={config ?? null} isLoading={shippingQuery.isLoading} />
          </div>
        </TabsContent>

        <TabsContent value="profiles" className="m-0">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <ShippingPackageProfilePanel
              boxes={config?.boxes ?? []}
              form={profileForm}
              isSaving={pendingAction === "profile"}
              onChange={setProfileForm}
              onSave={savePackageProfile}
              variants={productVariantOptions}
              variantsLoading={variantsQuery.isLoading}
            />
            <ShippingProductProfilesTable config={config ?? null} isLoading={shippingQuery.isLoading} />
          </div>
        </TabsContent>

        <TabsContent value="zones" className="m-0">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <ShippingZoneRulePanel
              form={zoneForm}
              isSaving={pendingAction === "zone"}
              onChange={setZoneForm}
              onSave={saveZoneRule}
              warehouses={warehouseOptions}
              warehousesLoading={warehousesQuery.isLoading || warehousesQuery.isFetching}
            />
            <ShippingZonesTable config={config ?? null} isLoading={shippingQuery.isLoading} />
          </div>
        </TabsContent>

        <TabsContent value="rates" className="m-0">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <ShippingRateTablePanel
              form={rateForm}
              isSaving={pendingAction === "rate"}
              onChange={setRateForm}
              onSave={saveRateTable}
              warehouses={warehouseOptions}
              warehousesLoading={warehousesQuery.isLoading || warehousesQuery.isFetching}
            />
            <ShippingRateTablesTable config={config ?? null} isLoading={shippingQuery.isLoading} />
          </div>
        </TabsContent>

        <TabsContent value="markup" className="m-0">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <ShippingMarkupPolicyPanel
              activePolicy={config?.activeMarkupPolicy ?? null}
              form={markupForm}
              isSaving={pendingAction === "markup"}
              onChange={setMarkupForm}
              onSave={saveMarkupPolicy}
            />
            <ShippingMarkupPolicyTable activePolicy={config?.activeMarkupPolicy ?? null} isLoading={shippingQuery.isLoading} />
          </div>
        </TabsContent>

        <TabsContent value="insurance" className="m-0">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <ShippingInsurancePolicyPanel
              activePolicy={config?.activeInsurancePolicy ?? null}
              form={insuranceForm}
              isSaving={pendingAction === "insurance"}
              onChange={setInsuranceForm}
              onSave={saveInsurancePolicy}
            />
            <ShippingInsurancePolicyTable activePolicy={config?.activeInsurancePolicy ?? null} isLoading={shippingQuery.isLoading} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ShippingBoxPanel({
  form,
  isSaving,
  onChange,
  onSave,
}: {
  form: ShippingBoxFormState;
  isSaving: boolean;
  onChange: Dispatch<SetStateAction<ShippingBoxFormState>>;
  onSave: () => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <PanelHeader title="Boxes and mailers" detail="Required before any package can be cartonized." />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ShippingInput label="Code" value={form.code} onChange={(value) => onChange((current) => ({ ...current, code: value }))} />
        <ShippingInput label="Name" value={form.name} onChange={(value) => onChange((current) => ({ ...current, name: value }))} />
        <ShippingInput label="Length in" value={form.lengthIn} onChange={(value) => onChange((current) => ({ ...current, lengthIn: value }))} />
        <ShippingInput label="Width in" value={form.widthIn} onChange={(value) => onChange((current) => ({ ...current, widthIn: value }))} />
        <ShippingInput label="Height in" value={form.heightIn} onChange={(value) => onChange((current) => ({ ...current, heightIn: value }))} />
        <ShippingInput label="Tare weight lb" value={form.tareWeightLb} onChange={(value) => onChange((current) => ({ ...current, tareWeightLb: value }))} />
        <ShippingInput label="Max weight lb" value={form.maxWeightLb} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, maxWeightLb: value }))} />
        <ShippingActiveSelect value={form.isActive} onChange={(isActive) => onChange((current) => ({ ...current, isActive }))} />
      </div>
      <Button className="mt-4 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={isSaving} onClick={onSave}>
        <Save className="h-4 w-4" />
        Save box
      </Button>
    </section>
  );
}

function ShippingPackageProfilePanel({
  boxes,
  form,
  isSaving,
  onChange,
  onSave,
  variants,
  variantsLoading,
}: {
  boxes: DropshipShippingConfigOverview["boxes"];
  form: ShippingPackageProfileFormState;
  isSaving: boolean;
  onChange: Dispatch<SetStateAction<ShippingPackageProfileFormState>>;
  onSave: () => void;
  variants: DropshipProductVariantOption[];
  variantsLoading: boolean;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <PanelHeader title="Product shipping profiles" detail="SKU-level shipping dimensions, weight, and package rules." />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ProductVariantSkuPicker
          isLoading={variantsLoading}
          onChange={(value) => onChange((current) => ({ ...current, productVariantId: value }))}
          value={form.productVariantId}
          variants={variants}
        />
        <ShippingInput label="Weight lb" value={form.weightLb} onChange={(value) => onChange((current) => ({ ...current, weightLb: value }))} />
        <ShippingInput label="Length in" value={form.lengthIn} onChange={(value) => onChange((current) => ({ ...current, lengthIn: value }))} />
        <ShippingInput label="Width in" value={form.widthIn} onChange={(value) => onChange((current) => ({ ...current, widthIn: value }))} />
        <ShippingInput label="Height in" value={form.heightIn} onChange={(value) => onChange((current) => ({ ...current, heightIn: value }))} />
        <ShippingInput label="Max units/package" value={form.maxUnitsPerPackage} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, maxUnitsPerPackage: value }))} />
        <ShippingInput label="Default carrier" value={form.defaultCarrier} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, defaultCarrier: value }))} />
        <ShippingInput label="Default service" value={form.defaultService} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, defaultService: value }))} />
        <div>
          <label className="text-sm font-medium">Default box</label>
          <Select value={form.defaultBoxId || "none"} onValueChange={(value) => onChange((current) => ({ ...current, defaultBoxId: value === "none" ? "" : value }))}>
            <SelectTrigger className="mt-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No default box</SelectItem>
              {boxes.map((box) => (
                <SelectItem key={box.boxId} value={String(box.boxId)}>
                  {box.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <ShippingActiveSelect value={form.isActive} onChange={(isActive) => onChange((current) => ({ ...current, isActive }))} />
        <div>
          <label className="text-sm font-medium">Ship alone</label>
          <Select value={form.shipAlone ? "yes" : "no"} onValueChange={(value) => onChange((current) => ({ ...current, shipAlone: value === "yes" }))}>
            <SelectTrigger className="mt-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="no">No</SelectItem>
              <SelectItem value="yes">Yes</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button className="mt-4 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={isSaving} onClick={onSave}>
        <Save className="h-4 w-4" />
        Save product profile
      </Button>
    </section>
  );
}

function SearchableOptionPicker({
  clearLabel = "Clear selection",
  clearable = false,
  disabled = false,
  emptyText,
  isLoading,
  label,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  value,
}: {
  clearLabel?: string;
  clearable?: boolean;
  disabled?: boolean;
  emptyText: string;
  isLoading: boolean;
  label: string;
  onChange: (value: string) => void;
  options: DropshipSelectOption[];
  placeholder: string;
  searchPlaceholder: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value) ?? null;

  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className="mt-2 h-10 w-full justify-between"
            disabled={disabled}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className={selectedOption || value ? "truncate" : "truncate text-muted-foreground"}>
              {isLoading
                ? "Loading..."
                : selectedOption
                  ? selectedOption.label
                  : value
                    ? `Selected ID ${value} (not found)`
                    : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[360px] p-0">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {clearable && value && (
                  <CommandItem
                    onSelect={() => {
                      onChange("");
                      setOpen(false);
                    }}
                    value="__clear_selection__"
                  >
                    <MinusCircle className="mr-2 h-4 w-4" />
                    {clearLabel}
                  </CommandItem>
                )}
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    onSelect={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    value={option.search ?? `${option.label} ${option.detail ?? ""} ${option.value}`}
                  >
                    <Check className={`mr-2 h-4 w-4 ${option.value === value ? "opacity-100" : "opacity-0"}`} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{option.label}</div>
                      {option.detail && (
                        <div className="truncate text-xs text-muted-foreground">{option.detail}</div>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ProductVariantSkuPicker({
  clearable = false,
  disabled = false,
  isLoading,
  label = "SKU",
  onChange,
  placeholder = "Select SKU",
  value,
  variants,
}: {
  clearable?: boolean;
  disabled?: boolean;
  isLoading: boolean;
  label?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
  variants: DropshipProductVariantOption[];
}) {
  const [open, setOpen] = useState(false);
  const selectedVariant = variants.find((variant) => String(variant.id) === value) ?? null;

  return (
    <div>
      {label && <label className="text-sm font-medium">{label}</label>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className={`${label ? "mt-2 " : ""}h-10 w-full justify-between`}
            disabled={disabled}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className={selectedVariant ? "truncate" : "truncate text-muted-foreground"}>
              {isLoading ? "Loading SKUs..." : selectedVariant ? formatVariantOption(selectedVariant) : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[360px] p-0">
          <Command>
            <CommandInput placeholder="Search SKU or name..." />
            <CommandList>
              <CommandEmpty>No SKU found.</CommandEmpty>
              <CommandGroup>
                {clearable && value && (
                  <CommandItem
                    onSelect={() => {
                      onChange("");
                      setOpen(false);
                    }}
                    value="__clear_variant__"
                  >
                    <MinusCircle className="mr-2 h-4 w-4" />
                    Clear SKU
                  </CommandItem>
                )}
                {variants.map((variant) => (
                  <CommandItem
                    key={variant.id}
                    onSelect={() => {
                      onChange(String(variant.id));
                      setOpen(false);
                    }}
                    value={variantOptionSearchValue(variant)}
                  >
                    <Check className={`mr-2 h-4 w-4 ${String(variant.id) === value ? "opacity-100" : "opacity-0"}`} />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{variant.sku || `Variant ${variant.id}`}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {variant.name} - ID {variant.id}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function ShippingZoneRulePanel({
  form,
  isSaving,
  onChange,
  onSave,
  warehouses,
  warehousesLoading,
}: {
  form: ShippingZoneRuleFormState;
  isSaving: boolean;
  onChange: Dispatch<SetStateAction<ShippingZoneRuleFormState>>;
  onSave: () => void;
  warehouses: DropshipWarehouseOption[];
  warehousesLoading: boolean;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <PanelHeader title="Zones" detail="Origin warehouse and destination matching for cached rate lookups." />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <WarehouseSelect
          label="Origin warehouse"
          value={form.originWarehouseId}
          onChange={(value) => onChange((current) => ({ ...current, originWarehouseId: value }))}
          warehouses={warehouses}
          warehousesLoading={warehousesLoading}
        />
        <ShippingInput label="Country" value={form.destinationCountry} onChange={(value) => onChange((current) => ({ ...current, destinationCountry: value }))} />
        <ShippingInput label="Region" value={form.destinationRegion} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, destinationRegion: value }))} />
        <ShippingInput label="Postal prefix" value={form.postalPrefix} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, postalPrefix: value }))} />
        <ShippingInput label="Zone" value={form.zone} onChange={(value) => onChange((current) => ({ ...current, zone: value }))} />
        <ShippingInput label="Priority" value={form.priority} onChange={(value) => onChange((current) => ({ ...current, priority: value }))} />
        <ShippingActiveSelect value={form.isActive} onChange={(isActive) => onChange((current) => ({ ...current, isActive }))} />
      </div>
      <Button className="mt-4 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={isSaving} onClick={onSave}>
        <Save className="h-4 w-4" />
        Save zone
      </Button>
    </section>
  );
}

function ShippingRateTablePanel({
  form,
  isSaving,
  onChange,
  onSave,
  warehouses,
  warehousesLoading,
}: {
  form: ShippingRateTableFormState;
  isSaving: boolean;
  onChange: Dispatch<SetStateAction<ShippingRateTableFormState>>;
  onSave: () => void;
  warehouses: DropshipWarehouseOption[];
  warehousesLoading: boolean;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <PanelHeader title="Rate table" detail="Create a cached rate table with an initial weight band." />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ShippingInput label="Carrier" value={form.carrier} onChange={(value) => onChange((current) => ({ ...current, carrier: value }))} />
        <ShippingInput label="Service" value={form.service} onChange={(value) => onChange((current) => ({ ...current, service: value }))} />
        <ShippingInput label="Currency" value={form.currency} onChange={(value) => onChange((current) => ({ ...current, currency: value }))} />
        <div>
          <label className="text-sm font-medium">Status</label>
          <Select value={form.status} onValueChange={(value) => onChange((current) => ({ ...current, status: value as ShippingRateTableFormState["status"] }))}>
            <SelectTrigger className="mt-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ShippingInput label="Effective from" value={form.effectiveFrom} placeholder="Optional ISO date" onChange={(value) => onChange((current) => ({ ...current, effectiveFrom: value }))} />
        <ShippingInput label="Effective to" value={form.effectiveTo} placeholder="Optional ISO date" onChange={(value) => onChange((current) => ({ ...current, effectiveTo: value }))} />
        <WarehouseSelect
          label="Warehouse"
          optional
          value={form.warehouseId}
          onChange={(value) => onChange((current) => ({ ...current, warehouseId: value }))}
          warehouses={warehouses}
          warehousesLoading={warehousesLoading}
        />
        <ShippingInput label="Destination zone" value={form.destinationZone} onChange={(value) => onChange((current) => ({ ...current, destinationZone: value }))} />
        <ShippingInput label="Min grams" value={form.minWeightGrams} onChange={(value) => onChange((current) => ({ ...current, minWeightGrams: value }))} />
        <ShippingInput label="Max grams" value={form.maxWeightGrams} onChange={(value) => onChange((current) => ({ ...current, maxWeightGrams: value }))} />
        <ShippingInput label="Rate" value={form.rate} placeholder="5.25" onChange={(value) => onChange((current) => ({ ...current, rate: value }))} />
      </div>
      <Button className="mt-4 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={isSaving} onClick={onSave}>
        <Save className="h-4 w-4" />
        Create rate table
      </Button>
    </section>
  );
}

function ShippingMarkupPolicyPanel({
  activePolicy,
  form,
  isSaving,
  onChange,
  onSave,
}: {
  activePolicy: DropshipShippingConfigOverview["activeMarkupPolicy"];
  form: ShippingMarkupPolicyFormState;
  isSaving: boolean;
  onChange: Dispatch<SetStateAction<ShippingMarkupPolicyFormState>>;
  onSave: () => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <PanelHeader title="Markup policy" detail={activePolicy ? `Current: ${activePolicy.markupBps} bps + ${formatCents(activePolicy.fixedMarkupCents)}` : "No active markup policy."} />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ShippingInput label="Name" value={form.name} onChange={(value) => onChange((current) => ({ ...current, name: value }))} />
        <ShippingInput label="Markup bps" value={form.markupBps} onChange={(value) => onChange((current) => ({ ...current, markupBps: value }))} />
        <ShippingInput label="Fixed markup" value={form.fixedMarkup} onChange={(value) => onChange((current) => ({ ...current, fixedMarkup: value }))} />
        <ShippingInput label="Min markup" value={form.minMarkup} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, minMarkup: value }))} />
        <ShippingInput label="Max markup" value={form.maxMarkup} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, maxMarkup: value }))} />
        <ShippingActiveSelect value={form.isActive} onChange={(isActive) => onChange((current) => ({ ...current, isActive }))} />
      </div>
      <Button className="mt-4 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={isSaving} onClick={onSave}>
        <Save className="h-4 w-4" />
        Create markup policy
      </Button>
    </section>
  );
}

function ShippingInsurancePolicyPanel({
  activePolicy,
  form,
  isSaving,
  onChange,
  onSave,
}: {
  activePolicy: DropshipShippingConfigOverview["activeInsurancePolicy"];
  form: ShippingInsurancePolicyFormState;
  isSaving: boolean;
  onChange: Dispatch<SetStateAction<ShippingInsurancePolicyFormState>>;
  onSave: () => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <PanelHeader title="Insurance pool" detail={activePolicy ? `Current: ${activePolicy.feeBps} bps` : "No active insurance pool policy."} />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ShippingInput label="Name" value={form.name} onChange={(value) => onChange((current) => ({ ...current, name: value }))} />
        <ShippingInput label="Fee bps" value={form.feeBps} onChange={(value) => onChange((current) => ({ ...current, feeBps: value }))} />
        <ShippingInput label="Min fee" value={form.minFee} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, minFee: value }))} />
        <ShippingInput label="Max fee" value={form.maxFee} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, maxFee: value }))} />
        <ShippingActiveSelect value={form.isActive} onChange={(isActive) => onChange((current) => ({ ...current, isActive }))} />
      </div>
      <Button className="mt-4 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={isSaving} onClick={onSave}>
        <Save className="h-4 w-4" />
        Create insurance policy
      </Button>
    </section>
  );
}

function ShippingConfigOverviewDashboard({
  config,
  isLoading,
}: {
  config: DropshipShippingConfigOverview | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="mt-4 h-52 w-full" />
      </section>
    );
  }
  if (!config) {
    return <EmptyState title="No shipping config" description="Dropship shipping configuration is not loaded." />;
  }

  const rows = [
    {
      section: "Boxes",
      configured: `${activeCount(config.boxes)} active / ${config.boxes.length} loaded`,
      ready: activeCount(config.boxes) > 0,
      detail: "Physical boxes and mailers available for package selection.",
    },
    {
      section: "Product shipping profiles",
      configured: `${activeCount(config.packageProfiles)} active / ${config.packageProfiles.length} loaded`,
      ready: activeCount(config.packageProfiles) > 0,
      detail: "SKU-level dimensions and package behavior used before quoting.",
    },
    {
      section: "Zones",
      configured: `${activeCount(config.zoneRules)} active / ${config.zoneRules.length} loaded`,
      ready: activeCount(config.zoneRules) > 0,
      detail: "Warehouse and destination matching rules for rate lookup.",
    },
    {
      section: "Rate tables",
      configured: `${activeRateTableCount(config)} active / ${config.rateTables.length} loaded`,
      ready: activeRateTableCount(config) > 0,
      detail: "Cached carrier/service rates used when a quote is requested.",
    },
    {
      section: "Markup",
      configured: config.activeMarkupPolicy ? config.activeMarkupPolicy.name : "No active policy",
      ready: Boolean(config.activeMarkupPolicy),
      detail: "Shipping charge markup applied after base rate lookup.",
    },
    {
      section: "Insurance pool",
      configured: config.activeInsurancePolicy ? config.activeInsurancePolicy.name : "No active policy",
      ready: Boolean(config.activeInsurancePolicy),
      detail: "Configurable fee funding carrier-fault reimbursements.",
    },
  ];

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Shipping configuration dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Current shipping quote inputs loaded from the admin shipping config API.
          </p>
        </div>
        <Badge variant="outline">Generated {formatDateTime(config.generatedAt)}</Badge>
      </div>
      <div className="mt-4 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Area</TableHead>
              <TableHead>Configured</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Purpose</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.section}>
                <TableCell className="font-medium">{row.section}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{row.configured}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={row.ready
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-amber-200 bg-amber-50 text-amber-800"}
                  >
                    {row.ready ? "Ready" : "Missing"}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{row.detail}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function ShippingBoxesTable({
  config,
  isLoading,
}: {
  config: DropshipShippingConfigOverview | null;
  isLoading: boolean;
}) {
  if (isLoading) return <ShippingTableSkeleton />;
  if (!config) return <EmptyState title="No boxes" description="Dropship shipping boxes are not loaded." />;
  return (
    <ShippingSimpleTable
      title="Boxes and mailers"
      emptyTitle="No boxes"
      headers={["Code", "Size", "Weight", "Status"]}
      rows={config.boxes.map((box) => [
        box.code,
        `${formatMmAsInches(box.lengthMm)} x ${formatMmAsInches(box.widthMm)} x ${formatMmAsInches(box.heightMm)} in`,
        `${formatGramsAsPounds(box.tareWeightGrams)} lb tare${box.maxWeightGrams ? ` / ${formatGramsAsPounds(box.maxWeightGrams)} lb max` : ""}`,
        box.isActive ? "Active" : "Inactive",
      ])}
    />
  );
}

function ShippingProductProfilesTable({
  config,
  isLoading,
}: {
  config: DropshipShippingConfigOverview | null;
  isLoading: boolean;
}) {
  if (isLoading) return <ShippingTableSkeleton />;
  if (!config) return <EmptyState title="No product profiles" description="Dropship product shipping profiles are not loaded." />;
  return (
    <ShippingSimpleTable
      title="Product shipping profiles"
      emptyTitle="No product shipping profiles"
      headers={["SKU", "Size", "Weight", "Defaults", "Status"]}
      rows={config.packageProfiles.map((profile) => [
        profile.variantSku || String(profile.productVariantId),
        `${formatMmAsInches(profile.lengthMm)} x ${formatMmAsInches(profile.widthMm)} x ${formatMmAsInches(profile.heightMm)} in`,
        `${formatGramsAsPounds(profile.weightGrams)} lb`,
        [
          profile.defaultCarrier,
          profile.defaultService,
          profile.defaultBoxId ? `Box ${profile.defaultBoxId}` : null,
          profile.shipAlone ? "Ships alone" : null,
        ].filter(Boolean).join(" / ") || "None",
        profile.isActive ? "Active" : "Inactive",
      ])}
    />
  );
}

function ShippingZonesTable({
  config,
  isLoading,
}: {
  config: DropshipShippingConfigOverview | null;
  isLoading: boolean;
}) {
  if (isLoading) return <ShippingTableSkeleton />;
  if (!config) return <EmptyState title="No zones" description="Dropship shipping zones are not loaded." />;
  return (
    <ShippingSimpleTable
      title="Zones"
      emptyTitle="No zone rules"
      headers={["Warehouse", "Destination", "Zone", "Priority", "Status"]}
      rows={config.zoneRules.map((rule) => [
        String(rule.originWarehouseId),
        [rule.destinationCountry, rule.destinationRegion, rule.postalPrefix].filter(Boolean).join(" / "),
        rule.zone,
        String(rule.priority),
        rule.isActive ? "Active" : "Inactive",
      ])}
    />
  );
}

function ShippingRateTablesTable({
  config,
  isLoading,
}: {
  config: DropshipShippingConfigOverview | null;
  isLoading: boolean;
}) {
  if (isLoading) return <ShippingTableSkeleton />;
  if (!config) return <EmptyState title="No rate tables" description="Dropship rate tables are not loaded." />;
  return (
    <ShippingSimpleTable
      title="Rate tables"
      emptyTitle="No rate tables"
      headers={["Carrier/service", "Status", "Rows", "Effective", "Expires"]}
      rows={config.rateTables.map((table) => [
        `${table.carrier} ${table.service}`,
        table.status,
        String(table.rows.length),
        formatDateTime(table.effectiveFrom),
        table.effectiveTo ? formatDateTime(table.effectiveTo) : "Open",
      ])}
    />
  );
}

function ShippingMarkupPolicyTable({
  activePolicy,
  isLoading,
}: {
  activePolicy: DropshipShippingConfigOverview["activeMarkupPolicy"];
  isLoading: boolean;
}) {
  if (isLoading) return <ShippingTableSkeleton />;
  return (
    <ShippingSimpleTable
      title="Active markup policy"
      emptyTitle="No active markup policy"
      headers={["Name", "Variable", "Fixed", "Range", "Effective"]}
      rows={activePolicy ? [[
        activePolicy.name,
        `${activePolicy.markupBps} bps`,
        formatCents(activePolicy.fixedMarkupCents),
        formatShippingMoneyRange(activePolicy.minMarkupCents, activePolicy.maxMarkupCents),
        formatDateTime(activePolicy.effectiveFrom),
      ]] : []}
    />
  );
}

function ShippingInsurancePolicyTable({
  activePolicy,
  isLoading,
}: {
  activePolicy: DropshipShippingConfigOverview["activeInsurancePolicy"];
  isLoading: boolean;
}) {
  if (isLoading) return <ShippingTableSkeleton />;
  return (
    <ShippingSimpleTable
      title="Active insurance pool policy"
      emptyTitle="No active insurance pool policy"
      headers={["Name", "Fee", "Range", "Effective"]}
      rows={activePolicy ? [[
        activePolicy.name,
        `${activePolicy.feeBps} bps`,
        formatShippingMoneyRange(activePolicy.minFeeCents, activePolicy.maxFeeCents),
        formatDateTime(activePolicy.effectiveFrom),
      ]] : []}
    />
  );
}

function ShippingTableSkeleton() {
  return (
    <section className="rounded-md border bg-card p-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="mt-4 h-44 w-full" />
    </section>
  );
}

function ShippingSimpleTable({
  emptyTitle,
  headers,
  rows,
  title,
}: {
  emptyTitle: string;
  headers: string[];
  rows: string[][];
  title: string;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Badge variant="outline">{rows.length}</Badge>
      </div>
      {rows.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {headers.map((header) => <TableHead key={header}>{header}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={`${title}-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <TableCell key={`${title}-${rowIndex}-${cellIndex}`} className={cellIndex === 0 ? "font-medium" : "text-sm text-muted-foreground"}>
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function PanelHeader({ detail, title }: { detail: string; title: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function WarehouseSelect({
  label,
  onChange,
  optional = false,
  value,
  warehouses,
  warehousesLoading,
}: {
  label: string;
  onChange: (value: string) => void;
  optional?: boolean;
  value: string;
  warehouses: DropshipWarehouseOption[];
  warehousesLoading: boolean;
}) {
  const selectedWarehouseKnown = value === "" || warehouses.some((warehouse) => String(warehouse.id) === value);

  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Select
        value={value || NO_DEFAULT_WAREHOUSE_VALUE}
        onValueChange={(nextValue) => onChange(nextValue === NO_DEFAULT_WAREHOUSE_VALUE ? "" : nextValue)}
        disabled={warehousesLoading}
      >
        <SelectTrigger className="mt-2">
          <SelectValue placeholder={warehousesLoading ? "Loading warehouses..." : "Select warehouse"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEFAULT_WAREHOUSE_VALUE}>
            {optional ? "Any warehouse" : "Select warehouse"}
          </SelectItem>
          {!selectedWarehouseKnown && (
            <SelectItem value={value}>Warehouse ID {value} (not found)</SelectItem>
          )}
          {warehouses.map((warehouse) => (
            <SelectItem key={warehouse.id} value={String(warehouse.id)}>
              {formatWarehouseOption(warehouse)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ShippingInput({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Input
        className="mt-2"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ShippingActiveSelect({
  onChange,
  value,
}: {
  onChange: (value: boolean) => void;
  value: boolean;
}) {
  return (
    <div>
      <label className="text-sm font-medium">Status</label>
      <Select value={value ? "active" : "inactive"} onValueChange={(nextValue) => onChange(nextValue === "active")}>
        <SelectTrigger className="mt-2">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="inactive">Inactive</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function activeCount(items: Array<{ isActive: boolean }> | undefined): number {
  return items?.filter((item) => item.isActive).length ?? 0;
}

function activeRateTableCount(config: DropshipShippingConfigOverview | undefined): number {
  return config?.rateTables.filter((table) => table.status === "active").length ?? 0;
}

function formatShippingMoneyRange(minCents: number | null, maxCents: number | null): string {
  if (minCents === null && maxCents === null) return "No min/max";
  if (minCents !== null && maxCents !== null) return `${formatCents(minCents)} - ${formatCents(maxCents)}`;
  if (minCents !== null) return `Min ${formatCents(minCents)}`;
  return `Max ${formatCents(maxCents ?? 0)}`;
}

function dropshipOmsSourceLabel(channel: DropshipOmsChannelOption): string {
  if (channel.type === "internal" && channel.provider === "manual") {
    return channel.name;
  }
  const provider = formatStatus(channel.provider);
  return channel.name.trim().toLowerCase() === provider.trim().toLowerCase()
    ? channel.name
    : `${channel.name} (${provider})`;
}

function OmsChannelConfigPanel({
  config,
  isLoading,
  isSaving,
  onEnsureDefaultSource,
}: {
  config: DropshipOmsChannelConfigOverview | null;
  isLoading: boolean;
  isSaving: boolean;
  onEnsureDefaultSource: () => void;
}) {
  if (isLoading && !config) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="mt-4 h-10 w-full max-w-xl" />
      </section>
    );
  }

  const internalDropshipChannels = config?.channels.filter((channel) => channel.isInternalDropshipChannel) ?? [];
  const legacyMarkedChannels = config?.channels.filter((channel) => (
    channel.isDropshipOmsChannel && !channel.isInternalDropshipChannel
  )) ?? [];
  const currentChannel = config?.channels.find((channel) => channel.channelId === config.currentChannelId) ?? null;
  const hasAmbiguousConfig = (config?.currentChannelCount ?? 0) > 1;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Internal dropship channel</h2>
            <Badge variant="outline" className={omsChannelConfigTone(config)}>
              {omsChannelConfigLabel(config)}
            </Badge>
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {currentChannel
              ? `${dropshipOmsSourceLabel(currentChannel)} is the static internal Echelon channel used to tag dropship intake rows.`
              : hasAmbiguousConfig
                ? `${config?.currentChannelCount ?? 0} active internal dropship channels exist. This needs a data cleanup.`
                : "The static internal dropship channel is missing."}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Vendor eBay and Shopify stores connect separately under Store Connections. This source only tags accepted dropship orders inside Echelon.
          </div>
          {internalDropshipChannels.length > 0 && (
            <div className="mt-1 text-xs text-muted-foreground">
              Internal channel: {internalDropshipChannels.map((channel) => `${dropshipOmsSourceLabel(channel)} (${formatStatus(channel.status)})`).join(", ")}
            </div>
          )}
          {legacyMarkedChannels.length > 0 && (
            <div className="mt-1 text-xs text-muted-foreground">
              Legacy markers: {legacyMarkedChannels.map((channel) => `${dropshipOmsSourceLabel(channel)} (${formatStatus(channel.status)})`).join(", ")}
            </div>
          )}
        </div>
        {(!currentChannel || hasAmbiguousConfig) && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Button
              className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              disabled={isSaving}
              onClick={onEnsureDefaultSource}
            >
              <Save className="h-4 w-4" />
              {isSaving ? "Saving" : "Initialize channel"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function SystemReadinessPanel({
  checks,
  isLoading,
}: {
  checks: DropshipSystemReadinessCheck[];
  isLoading: boolean;
}) {
  if (isLoading && checks.length === 0) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-56" />
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
      </section>
    );
  }

  if (checks.length === 0) {
    return null;
  }

  const blockedCount = checks.filter((check) => check.status === "blocked").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">System prerequisites</h2>
          <p className="text-sm text-muted-foreground">
            {blockedCount} blocked / {warningCount} warning
          </p>
        </div>
        <Badge variant="outline" className={systemReadinessTone(blockedCount, warningCount)}>
          {blockedCount > 0 ? "Blocked" : warningCount > 0 ? "Warning" : "Ready"}
        </Badge>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {checks.map((check) => (
          <div key={check.key} className="rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{check.label}</div>
                <div className="mt-1 text-sm text-muted-foreground">{check.message}</div>
              </div>
              <Badge variant="outline" className={dogfoodReadinessStatusTone(check.status)}>
                {formatStatus(check.status)}
              </Badge>
            </div>
            {check.status !== "ready" && (
              <div className="mt-2 text-xs text-muted-foreground">
                Env: {check.requiredEnv.join(", ")}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkerSweepPanel({
  batchSize,
  pendingWorker,
  reason,
  onBatchSizeChange,
  onReasonChange,
  onRunSweep,
}: {
  batchSize: string;
  pendingWorker: DropshipAdminWorkerSweepName | null;
  reason: string;
  onBatchSizeChange: Dispatch<SetStateAction<string>>;
  onReasonChange: Dispatch<SetStateAction<string>>;
  onRunSweep: (worker: DropshipAdminWorkerSweepName) => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Manual worker sweeps</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Run the same dropship worker paths used by schedulers without waiting for the next interval.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[120px_minmax(220px,1fr)] xl:w-[520px]">
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Batch</span>
            <Input
              inputMode="numeric"
              value={batchSize}
              onChange={(event) => onBatchSizeChange(event.target.value)}
              placeholder="10"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Reason</span>
            <Input
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder="Dogfood manual sweep"
            />
          </label>
        </div>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {adminWorkerSweepOptions.map((option) => {
          const isPending = pendingWorker === option.worker;
          return (
            <div key={option.worker} className="flex min-h-36 flex-col justify-between rounded-md border p-3">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium">{option.label}</div>
                  <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-zinc-700">
                    {option.worker}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{option.description}</p>
              </div>
              <Button
                className="mt-4 gap-2"
                disabled={pendingWorker !== null}
                variant="outline"
                onClick={() => onRunSweep(option.worker)}
              >
                {isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                {isPending ? "Running" : "Run sweep"}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DogfoodLaunchGatePanel({
  gate,
  isLoading,
  launchCandidates,
  message,
  runbookSteps,
  status,
}: {
  gate: DropshipDogfoodLaunchGate | null;
  isLoading: boolean;
  launchCandidates?: DropshipDogfoodLaunchCandidate[];
  message?: string;
  runbookSteps?: DropshipDogfoodLaunchRunbookStep[];
  status?: DropshipDogfoodReadinessStatus;
}) {
  if (isLoading && !gate) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-48" />
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      </section>
    );
  }

  if (!gate) {
    return null;
  }

  const displayStatus = status ?? gate.status;
  const displayMessage = message ?? gate.message;
  const steps = runbookSteps ?? gate.runbookSteps;
  const candidates = launchCandidates ?? [];

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Dogfood launch gate</h2>
            <Badge variant="outline" className={dogfoodReadinessStatusTone(displayStatus)}>
              {formatStatus(displayStatus)}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{displayMessage}</p>
        </div>
        <div className="grid w-full gap-2 sm:grid-cols-2 lg:w-auto lg:min-w-[520px] lg:grid-cols-4">
          <LaunchGateMetric label="Ready" value={gate.readyVendorStoreCount} />
          <LaunchGateMetric label="System blocked" value={gate.systemBlockedCount} />
          <LaunchGateMetric label="Rows blocked" value={gate.blockedVendorStoreCount} />
          <LaunchGateMetric label="Warnings" value={gate.warningCount} />
        </div>
      </div>
      {gate.firstBlockers.length > 0 && (
        <div className="mt-4 grid gap-2 lg:grid-cols-2">
          {gate.firstBlockers.slice(0, 4).map((blocker, index) => (
            <div key={`${blocker.scope}:${blocker.key}:${blocker.vendorId ?? "system"}:${index}`} className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{blocker.label}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{blocker.message}</div>
                </div>
                <Badge variant="outline" className="shrink-0 border-zinc-200 bg-zinc-50 text-zinc-700">
                  {blocker.scope === "system" ? "System" : `Vendor ${blocker.vendorId}`}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
      {candidates.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-normal text-muted-foreground">Ready dogfood candidates</h3>
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-800">
              {candidates.length} ready
            </Badge>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {candidates.slice(0, 4).map((candidate) => (
              <DogfoodLaunchCandidateCard
                key={`${candidate.vendor.vendorId}:${candidate.storeConnection.storeConnectionId}`}
                candidate={candidate}
              />
            ))}
          </div>
        </div>
      )}
      {steps.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-normal text-muted-foreground">Launch runbook</h3>
            <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-zinc-700">
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </Badge>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {steps.map((step, index) => (
              <LaunchRunbookStepCard key={step.key} step={step} index={index} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function DogfoodLaunchCandidateCard({
  candidate,
}: {
  candidate: DropshipDogfoodLaunchCandidate;
}) {
  const storeName = candidate.storeConnection.externalDisplayName
    || candidate.storeConnection.shopDomain
    || `${formatStatus(candidate.storeConnection.platform)} store ${candidate.storeConnection.storeConnectionId}`;
  const references = [
    candidate.smokeReferences.latestListingId ? `Listing ${candidate.smokeReferences.latestListingId}` : null,
    candidate.smokeReferences.latestIntakeId ? `Intake ${candidate.smokeReferences.latestIntakeId}` : null,
    candidate.smokeReferences.latestOmsOrderId ? `OMS ${candidate.smokeReferences.latestOmsOrderId}` : null,
    candidate.smokeReferences.latestWmsShipmentId ? `Shipment ${candidate.smokeReferences.latestWmsShipmentId}` : null,
    candidate.smokeReferences.latestTrackingPushId ? `Tracking ${candidate.smokeReferences.latestTrackingPushId}` : null,
  ].filter((reference): reference is string => Boolean(reference));

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">
            {candidate.vendor.businessName || candidate.vendor.email || `Vendor ${candidate.vendor.vendorId}`}
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">{storeName}</div>
        </div>
        <Badge variant="outline" className="shrink-0 border-emerald-200 bg-emerald-50 text-emerald-800">
          Ready
        </Badge>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        Latest smoke {candidate.lastSmokeActivityAt ? formatDateTime(candidate.lastSmokeActivityAt) : "missing"}
      </div>
      {references.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {references.map((reference) => (
            <Badge key={reference} variant="outline" className="border-zinc-200 bg-zinc-50 text-zinc-700">
              {reference}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function LaunchRunbookStepCard({
  step,
  index,
}: {
  step: DropshipDogfoodLaunchRunbookStep;
  index: number;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-zinc-700">
              {index + 1}
            </Badge>
            <div className="font-medium">{step.label}</div>
          </div>
          <div className="mt-1 text-sm text-muted-foreground">{step.message}</div>
        </div>
        <Badge variant="outline" className={dogfoodReadinessStatusTone(step.status)}>
          {formatStatus(step.status)}
        </Badge>
      </div>
      <div className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-sm">{step.action}</div>
      {step.evidence.length > 0 && (
        <div className="mt-3 space-y-1">
          {step.evidence.slice(0, 3).map((entry, entryIndex) => (
            <div key={`${step.key}:evidence:${entryIndex}`} className="truncate text-xs text-muted-foreground">
              {entry}
            </div>
          ))}
          {step.evidence.length > 3 && (
            <div className="text-xs text-muted-foreground">+{step.evidence.length - 3} more</div>
          )}
        </div>
      )}
    </div>
  );
}

function LaunchGateMetric({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function DogfoodSmokePanel({
  smoke,
  isLoading,
  onOpenSmokeOpsSearch,
}: {
  smoke: DropshipDogfoodSmokeResponse | null;
  isLoading: boolean;
  onOpenSmokeOpsSearch: (input: Omit<DropshipOpsSearchSignal, "nonce">) => void;
}) {
  if (isLoading && !smoke) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-56" />
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      </section>
    );
  }

  if (!smoke) return null;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Dogfood smoke evidence</h2>
          <p className="mt-1 text-sm text-muted-foreground">{smoke.message}</p>
        </div>
        <div className="grid w-full gap-2 sm:grid-cols-3 lg:w-auto lg:min-w-[420px]">
          <LaunchGateMetric label="Ready" value={smoke.readyCandidateCount} />
          <LaunchGateMetric label="Incomplete" value={smoke.warningCandidateCount} />
          <LaunchGateMetric label="Blocked" value={smoke.blockedCandidateCount} />
        </div>
      </div>
      {smoke.candidates.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No store connections match the current smoke filters.
        </div>
      ) : (
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {smoke.candidates.map((candidate) => (
            <DogfoodSmokeCandidateCard
              key={`${candidate.vendor.vendorId}:${candidate.storeConnection.storeConnectionId}`}
              candidate={candidate}
              onOpenSmokeOpsSearch={onOpenSmokeOpsSearch}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DogfoodSmokeCandidateCard({
  candidate,
  onOpenSmokeOpsSearch,
}: {
  candidate: DropshipDogfoodSmokeCandidate;
  onOpenSmokeOpsSearch: (input: Omit<DropshipOpsSearchSignal, "nonce">) => void;
}) {
  const storeName = candidate.storeConnection.externalDisplayName
    || candidate.storeConnection.shopDomain
    || `${formatStatus(candidate.storeConnection.platform)} store ${candidate.storeConnection.storeConnectionId}`;
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{candidate.vendor.businessName || candidate.vendor.email || `Vendor ${candidate.vendor.vendorId}`}</div>
          <div className="mt-1 truncate text-sm text-muted-foreground">
            {storeName} / {candidate.lastActivityAt ? formatDateTime(candidate.lastActivityAt) : "No activity"}
          </div>
        </div>
        <Badge variant="outline" className={dogfoodReadinessStatusTone(candidate.status)}>
          {formatStatus(candidate.status)}
        </Badge>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {candidate.stages.map((stage) => (
          <DogfoodSmokeStageCard
            key={stage.key}
            candidate={candidate}
            stage={stage}
            onOpenSmokeOpsSearch={onOpenSmokeOpsSearch}
          />
        ))}
      </div>
    </div>
  );
}

function DogfoodSmokeStageCard({
  candidate,
  stage,
  onOpenSmokeOpsSearch,
}: {
  candidate: DropshipDogfoodSmokeCandidate;
  stage: DropshipDogfoodSmokeStage;
  onOpenSmokeOpsSearch: (input: Omit<DropshipOpsSearchSignal, "nonce">) => void;
}) {
  const action = buildSmokeStageAction(candidate, stage);
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{stage.label}</div>
          <div className="mt-1 text-xs text-muted-foreground">{stage.message}</div>
        </div>
        <Badge variant="outline" className={dogfoodReadinessStatusTone(stage.status)}>
          {formatStatus(stage.status)}
        </Badge>
      </div>
      {stage.evidence.length > 0 && (
        <div className="mt-2 space-y-1">
          {stage.evidence.slice(0, 2).map((entry, index) => (
            <div key={`${stage.key}:${index}`} className="truncate text-xs text-muted-foreground">
              {entry}
            </div>
          ))}
        </div>
      )}
      {action && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 h-8 gap-2"
          onClick={() => onOpenSmokeOpsSearch(action)}
        >
          <FileSearch className="h-3.5 w-3.5" />
          {actionLabelForTab(action.tab)}
        </Button>
      )}
    </div>
  );
}

function buildSmokeStageAction(
  candidate: DropshipDogfoodSmokeCandidate,
  stage: DropshipDogfoodSmokeStage,
): Omit<DropshipOpsSearchSignal, "nonce"> | null {
  const platform = candidate.storeConnection.platform === "ebay" || candidate.storeConnection.platform === "shopify"
    ? candidate.storeConnection.platform
    : "all";
  if (stage.key === "listing") {
    return {
      tab: "listing-pushes",
      platform,
      search: smokeSearchValue([
        candidate.references.latestListingJobId,
        candidate.references.latestListingId,
        candidate.storeConnection.externalDisplayName,
        candidate.storeConnection.shopDomain,
        candidate.vendor.email,
      ]),
    };
  }
  if (stage.key === "order_intake" || stage.key === "fulfillment") {
    return {
      tab: "order-intake",
      search: smokeSearchValue([
        candidate.references.latestIntakeId,
        candidate.references.latestOmsOrderId,
        candidate.storeConnection.externalDisplayName,
        candidate.storeConnection.shopDomain,
        candidate.vendor.email,
      ]),
    };
  }
  if (stage.key === "tracking") {
    return {
      tab: "tracking-pushes",
      platform,
      search: smokeSearchValue([
        candidate.references.latestTrackingPushId,
        candidate.references.latestWmsShipmentId,
        candidate.references.latestOmsOrderId,
        candidate.storeConnection.externalDisplayName,
        candidate.storeConnection.shopDomain,
        candidate.vendor.email,
      ]),
    };
  }
  return null;
}

function smokeSearchValue(values: Array<string | number | null | undefined>): string {
  const value = values.find((entry) => {
    if (typeof entry === "number") return Number.isSafeInteger(entry) && entry > 0;
    return Boolean(entry?.trim());
  });
  return typeof value === "number" ? String(value) : value?.trim() ?? "";
}

function actionLabelForTab(tab: DropshipOpsSearchableTab): string {
  if (tab === "listing-pushes") return "Open listings";
  if (tab === "tracking-pushes") return "Open tracking";
  return "Open intake";
}

function DogfoodReadinessTable({
  isLoading,
  items,
  total,
}: {
  isLoading: boolean;
  items: DropshipDogfoodReadinessItem[];
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (items.length === 0) {
    return <EmptyState title="No readiness rows" description="No dropship vendor/store rows match the current filters." />;
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-lg font-semibold">Launch checklist</h2>
          <p className="text-sm text-muted-foreground">{total} matching row{total === 1 ? "" : "s"}</p>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Vendor/store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Blocking checks</TableHead>
            <TableHead>Catalog</TableHead>
            <TableHead>Shipping</TableHead>
            <TableHead>Wallet</TableHead>
            <TableHead className="w-[145px]">Store updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const blockingChecks = item.checks.filter((check) => check.status === "blocked");
            const warningChecks = item.checks.filter((check) => check.status === "warning");
            return (
              <TableRow key={`${item.vendor.vendorId}:${item.storeConnection.storeConnectionId ?? "none"}`}>
                <TableCell>
                  <div className="font-medium">{item.vendor.businessName || item.vendor.email || `Vendor ${item.vendor.vendorId}`}</div>
                  <div className="text-xs text-muted-foreground">
                    {[item.storeConnection.externalDisplayName, item.storeConnection.shopDomain, item.storeConnection.platform ? formatStatus(item.storeConnection.platform) : null]
                      .filter(Boolean)
                      .join(" / ") || item.vendor.memberId}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={dogfoodReadinessStatusTone(item.readinessStatus)}>
                    {formatStatus(item.readinessStatus)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.blockerCount} blocker{item.blockerCount === 1 ? "" : "s"} / {item.warningCount} warning{item.warningCount === 1 ? "" : "s"}
                  </div>
                </TableCell>
                <TableCell>
                  {blockingChecks.length > 0 ? (
                    <div className="space-y-1">
                      {blockingChecks.slice(0, 3).map((check) => (
                        <div key={check.key} className="max-w-[360px] truncate text-sm">
                          <span className="font-medium">{check.label}:</span>{" "}
                          <span className="text-muted-foreground">{check.message}</span>
                        </div>
                      ))}
                      {blockingChecks.length > 3 && (
                        <div className="text-xs text-muted-foreground">+{blockingChecks.length - 3} more blocker(s)</div>
                      )}
                    </div>
                  ) : warningChecks.length > 0 ? (
                    <div className="space-y-1">
                      {warningChecks.slice(0, 2).map((check) => (
                        <div key={check.key} className="max-w-[360px] truncate text-sm text-muted-foreground">
                          {check.label}: {check.message}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">All required checks ready</div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    Admin include: <span className="font-mono">{item.metrics.adminCatalogIncludeRuleCount}</span>
                  </div>
                  <div className="text-sm">
                    Vendor include: <span className="font-mono">{item.metrics.vendorSelectionIncludeRuleCount}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Warehouse {item.metrics.defaultWarehouseId ?? "missing"} / Listing config {item.metrics.listingConfigActive ? "active" : "not ready"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    Profiles: <span className="font-mono">{item.metrics.selectedPackageProfileCount}</span>
                    {" / "}
                    <span className={item.metrics.selectedVariantMissingPackageProfileCount > 0 ? "font-mono text-rose-700" : "font-mono"}>
                      {item.metrics.selectedVariantMissingPackageProfileCount}
                    </span>
                    {" missing"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Boxes {item.metrics.activeShippingBoxCount} / Zones {item.metrics.activeShippingZoneRuleCount} / Rate rows {item.metrics.activeShippingRateRowCount}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Markup {item.metrics.activeShippingMarkupPolicyCount} / Insurance {item.metrics.activeShippingInsurancePolicyCount}
                    {" / "}
                    Returns {item.metrics.activeReturnPolicyCount}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    OMS {item.metrics.dropshipOmsChannelCount === 1 ? item.metrics.dropshipOmsChannelId : `${item.metrics.dropshipOmsChannelCount} marked`}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">{formatCents(item.metrics.walletAvailableBalanceCents)}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.metrics.activeFundingMethodCount} funding method{item.metrics.activeFundingMethodCount === 1 ? "" : "s"} / {item.metrics.activeStripeFundingMethodCount} Stripe-ready / {item.metrics.activeUsdcBaseFundingMethodCount} USDC-ready
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Auto reload {item.metrics.autoReloadEnabled ? "on" : "off"} / funding {item.metrics.autoReloadFundingMethodReady ? "ready" : "not ready"}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(item.storeConnection.updatedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function ListingPushJobsTable({
  isLoading,
  jobs,
  onRetry,
  pendingRetryJobId,
  retryEligibilityNow,
  summary,
  total,
}: {
  isLoading: boolean;
  jobs: DropshipAdminListingPushJobListItem[];
  onRetry: (job: DropshipAdminListingPushJobListItem) => void;
  pendingRetryJobId: number | null;
  retryEligibilityNow: Date;
  summary: DropshipAdminListingPushJobListResponse["summary"];
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (jobs.length === 0) {
    return <EmptyState title="No listing push jobs" description="No dropship listing push jobs match the current filters." />;
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Listing push jobs</h2>
          <p className="text-sm text-muted-foreground">{total} matching job{total === 1 ? "" : "s"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary.map((entry) => (
            <Badge key={entry.status} variant="outline" className={listingPushStatusTone(entry.status)}>
              {formatStatus(entry.status)} {entry.count}
            </Badge>
          ))}
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">Job</TableHead>
            <TableHead>Vendor/store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Latest issue</TableHead>
            <TableHead className="w-[145px]">Updated</TableHead>
            <TableHead className="w-[120px] text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => {
            const retryEligibility = listingPushJobRetryEligibility(job, retryEligibilityNow);
            const retryLabel = retryEligibility.reason === "stale_processing" ? "Recover" : "Retry";
            return (
              <TableRow key={job.jobId}>
                <TableCell>
                  <div className="font-mono text-sm">#{job.jobId}</div>
                  <div className="text-xs text-muted-foreground">{formatStatus(job.jobType)}</div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{job.vendor.businessName || job.vendor.email || `Vendor ${job.vendor.vendorId}`}</div>
                  <div className="text-xs text-muted-foreground">
                    {[job.storeConnection.externalDisplayName, job.storeConnection.shopDomain, formatStatus(job.platform)]
                      .filter(Boolean)
                      .join(" / ")}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={listingPushStatusTone(job.status)}>
                    {formatStatus(job.status)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {job.completedAt ? `Completed ${formatDateTime(job.completedAt)}` : `Created ${formatDateTime(job.createdAt)}`}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{job.itemSummary.total} total</div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      job.itemSummary.completed ? `${job.itemSummary.completed} done` : null,
                      job.itemSummary.failed ? `${job.itemSummary.failed} failed` : null,
                      job.itemSummary.blocked ? `${job.itemSummary.blocked} blocked` : null,
                      job.itemSummary.processing ? `${job.itemSummary.processing} processing` : null,
                      job.itemSummary.queued ? `${job.itemSummary.queued} queued` : null,
                    ].filter(Boolean).join(" / ") || "No item counts"}
                  </div>
                </TableCell>
                <TableCell>
                  {job.latestItemError ? (
                    <>
                      <div className="font-medium">{job.latestItemError.errorCode || formatStatus(job.latestItemError.status)}</div>
                      <div className="max-w-[360px] truncate text-xs text-muted-foreground">
                        {job.latestItemError.errorMessage || `Variant ${job.latestItemError.productVariantId}`}
                      </div>
                    </>
                  ) : job.errorMessage ? (
                    <div className="max-w-[360px] truncate text-sm text-muted-foreground">{job.errorMessage}</div>
                  ) : (
                    <div className="text-sm text-muted-foreground">None</div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(job.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    disabled={!retryEligibility.canRetry || pendingRetryJobId !== null}
                    onClick={() => onRetry(job)}
                  >
                    <RotateCcw className={pendingRetryJobId === job.jobId ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    {retryLabel}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function TrackingPushesTable({
  isLoading,
  onRetry,
  pendingRetryPushId,
  pushes,
  retryEligibilityNow,
  summary,
  total,
}: {
  isLoading: boolean;
  onRetry: (push: DropshipAdminTrackingPushListItem) => void;
  pendingRetryPushId: number | null;
  pushes: DropshipAdminTrackingPushListItem[];
  retryEligibilityNow: Date;
  summary: DropshipAdminTrackingPushListResponse["summary"];
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (pushes.length === 0) {
    return <EmptyState title="No tracking pushes" description="No dropship tracking pushes match the current filters." />;
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Tracking pushes</h2>
          <p className="text-sm text-muted-foreground">{total} matching push{total === 1 ? "" : "es"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary.map((entry) => (
            <Badge key={entry.status} variant="outline" className={trackingPushStatusTone(entry.status)}>
              {formatStatus(entry.status)} {entry.count}
            </Badge>
          ))}
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">Push</TableHead>
            <TableHead>Order</TableHead>
            <TableHead>Vendor/store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Tracking</TableHead>
            <TableHead>Latest issue</TableHead>
            <TableHead className="w-[145px]">Updated</TableHead>
            <TableHead className="w-[120px] text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pushes.map((push) => {
            const retryEligibility = trackingPushRetryEligibility(push, retryEligibilityNow);
            const retryLabel = retryEligibility.reason === "stale_processing" ? "Recover" : "Retry";
            return (
              <TableRow key={push.pushId}>
                <TableCell>
                  <div className="font-mono text-sm">#{push.pushId}</div>
                  <div className="text-xs text-muted-foreground">Try {push.attemptCount}</div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{push.externalOrderNumber || push.externalOrderId}</div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      `OMS ${push.omsOrderId}`,
                      push.wmsShipmentId ? `Shipment ${push.wmsShipmentId}` : null,
                      `Intake ${push.intakeId}`,
                    ].filter(Boolean).join(" / ")}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{push.vendor.businessName || push.vendor.email || `Vendor ${push.vendor.vendorId}`}</div>
                  <div className="text-xs text-muted-foreground">
                    {[push.storeConnection.externalDisplayName, push.storeConnection.shopDomain, formatStatus(push.platform)]
                      .filter(Boolean)
                      .join(" / ")}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={trackingPushStatusTone(push.status)}>
                    {formatStatus(push.status)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {push.completedAt ? `Completed ${formatDateTime(push.completedAt)}` : `Shipped ${formatDateTime(push.shippedAt)}`}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{push.carrier}</div>
                  <div className="max-w-[220px] truncate text-xs text-muted-foreground">{push.trackingNumber}</div>
                  {push.externalFulfillmentId && (
                    <div className="max-w-[220px] truncate text-xs text-muted-foreground">Fulfillment {push.externalFulfillmentId}</div>
                  )}
                </TableCell>
                <TableCell>
                  {push.lastErrorCode || push.lastErrorMessage ? (
                    <>
                      <div className="font-medium">{push.lastErrorCode || "Tracking push failed"}</div>
                      <div className="max-w-[320px] truncate text-xs text-muted-foreground">
                        {push.lastErrorMessage || "No error message recorded"}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground">None</div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(push.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    disabled={!retryEligibility.canRetry || pendingRetryPushId !== null}
                    onClick={() => onRetry(push)}
                  >
                    <RotateCcw className={pendingRetryPushId === push.pushId ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    {retryLabel}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function NotificationEventsTable({
  channelSummary,
  events,
  isLoading,
  onRetry,
  pendingRetryEventId,
  summary,
  total,
}: {
  channelSummary: DropshipAdminNotificationOpsListResponse["channelSummary"];
  events: DropshipAdminNotificationOpsListItem[];
  isLoading: boolean;
  onRetry: (event: DropshipAdminNotificationOpsListItem) => void;
  pendingRetryEventId: number | null;
  summary: DropshipAdminNotificationOpsListResponse["summary"];
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (events.length === 0) {
    return <EmptyState title="No notification events" description="No dropship notification events match the current filters." />;
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Notification events</h2>
          <p className="text-sm text-muted-foreground">{total} matching event{total === 1 ? "" : "s"}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary.map((entry) => (
            <Badge key={entry.status} variant="outline" className={notificationOpsStatusTone(entry.status)}>
              {formatStatus(entry.status)} {entry.count}
            </Badge>
          ))}
          {channelSummary.map((entry) => (
            <Badge key={entry.channel} variant="outline" className="border-zinc-200 bg-zinc-50 text-zinc-700">
              {formatStatus(entry.channel)} {entry.count}
            </Badge>
          ))}
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[115px]">Event</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Delivery</TableHead>
            <TableHead className="w-[145px]">Created</TableHead>
            <TableHead className="w-[120px] text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => {
            const retryEligibility = notificationRetryEligibility(event);
            return (
              <TableRow key={event.notificationEventId}>
                <TableCell>
                  <div className="font-mono text-sm">#{event.notificationEventId}</div>
                  <div className="max-w-[180px] truncate text-xs text-muted-foreground">{formatStatus(event.eventType)}</div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{event.vendor.businessName || event.vendor.email || `Vendor ${event.vendor.vendorId}`}</div>
                  <div className="text-xs text-muted-foreground">
                    {[event.vendor.email, event.vendor.memberId].filter(Boolean).join(" / ") || formatStatus(event.vendor.status)}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={notificationOpsStatusTone(event.status)}>
                    {formatStatus(event.status)}
                  </Badge>
                  {event.critical && (
                    <Badge variant="outline" className="ml-2 border-rose-200 bg-rose-50 text-rose-800">
                      Critical
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="font-medium">{formatStatus(event.channel)}</div>
                  <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                    {event.requestHash || event.idempotencyKey || "No request hash"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="max-w-[360px] truncate font-medium">{event.title}</div>
                  <div className="max-w-[360px] truncate text-xs text-muted-foreground">
                    {event.message || "No message body"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    {event.deliveredAt ? `Delivered ${formatDateTime(event.deliveredAt)}` : "Not delivered"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {event.readAt ? `Read ${formatDateTime(event.readAt)}` : "Unread or not tracked"}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(event.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    disabled={!retryEligibility.canRetry || pendingRetryEventId !== null}
                    onClick={() => onRetry(event)}
                  >
                    <RotateCcw className={pendingRetryEventId === event.notificationEventId ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    Retry
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function ReturnPolicyPanel({
  activePolicy,
  form,
  isLoading,
  isSaving,
  onChange,
  onSave,
}: {
  activePolicy: DropshipReturnPolicyConfig | null;
  form: ReturnPolicyFormState;
  isLoading: boolean;
  isSaving: boolean;
  onChange: (patch: Partial<ReturnPolicyFormState>) => void;
  onSave: () => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Return policy</h2>
            {activePolicy && (
              <Badge variant="outline" className={activePolicy.isActive ? "border-emerald-200 bg-emerald-50 text-emerald-900" : ""}>
                {activePolicy.isActive ? "Active" : "Inactive"}
              </Badge>
            )}
          </div>
          {isLoading ? (
            <Skeleton className="mt-2 h-4 w-72" />
          ) : (
            <p className="text-sm text-muted-foreground">
              {activePolicy
                ? `${activePolicy.name}: ${activePolicy.returnWindowDays} days from accepted order. Effective ${formatDateTime(activePolicy.effectiveFrom)}.`
                : "No active policy. Vendor RMA submission is blocked until a policy is configured."}
            </p>
          )}
        </div>
        <Button
          type="button"
          className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
          disabled={isSaving}
          onClick={onSave}
        >
          <Save className={isSaving ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Create policy
        </Button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <AdminReturnInput
          label="Policy name"
          value={form.name}
          disabled={isSaving}
          onChange={(value) => onChange({ name: value })}
        />
        <AdminReturnInput
          label="Window days"
          value={form.returnWindowDays}
          disabled={isSaving}
          onChange={(value) => onChange({ returnWindowDays: value })}
        />
        <AdminReturnInput
          label="Effective from"
          value={form.effectiveFrom}
          placeholder="Optional ISO date"
          disabled={isSaving}
          onChange={(value) => onChange({ effectiveFrom: value })}
        />
        <AdminReturnInput
          label="Effective to"
          value={form.effectiveTo}
          placeholder="Optional ISO date"
          disabled={isSaving}
          onChange={(value) => onChange({ effectiveTo: value })}
        />
        <div>
          <label className="text-sm font-medium">Status</label>
          <Select
            value={form.isActive ? "active" : "inactive"}
            onValueChange={(value) => onChange({ isActive: value === "active" })}
            disabled={isSaving}
          >
            <SelectTrigger className="mt-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>
  );
}

function ReturnCreatePanel({
  form,
  intakes,
  intakesLoading,
  isSaving,
  onAddItem,
  onChange,
  onItemChange,
  onRemoveItem,
  onSubmit,
  storeConnections,
  storeConnectionsLoading,
  variants,
  variantsLoading,
  vendorOptions,
  vendorsLoading,
}: {
  form: ReturnCreateFormState;
  intakes: DropshipAdminOrderOpsIntakeListItem[];
  intakesLoading: boolean;
  isSaving: boolean;
  onAddItem: () => void;
  onChange: (patch: Partial<ReturnCreateFormState>) => void;
  onItemChange: (index: number, patch: Partial<ReturnCreateItemFormState>) => void;
  onRemoveItem: (index: number) => void;
  onSubmit: () => void;
  storeConnections: DropshipAdminStoreConnectionListItem[];
  storeConnectionsLoading: boolean;
  variants: DropshipProductVariantOption[];
  variantsLoading: boolean;
  vendorOptions: DropshipSelectOption[];
  vendorsLoading: boolean;
}) {
  const storeConnectionOptions = storeConnections.map(storeConnectionSelectOption);
  const intakeOptions = intakes.map(orderIntakeSelectOption);
  const omsOrderOptions = buildOmsOrderSelectOptions(intakes);

  function selectStoreConnection(storeConnectionId: string) {
    const connection = storeConnections.find((candidate) => String(candidate.storeConnectionId) === storeConnectionId);
    onChange({
      storeConnectionId,
      ...(connection ? { vendorId: String(connection.vendor.vendorId) } : {}),
    });
  }

  function selectIntake(intakeId: string) {
    const intake = intakes.find((candidate) => String(candidate.intakeId) === intakeId);
    onChange({
      intakeId,
      ...(intake ? {
        vendorId: String(intake.vendor.vendorId),
        storeConnectionId: String(intake.storeConnection.storeConnectionId),
        omsOrderId: intake.omsOrderId === null ? "" : String(intake.omsOrderId),
      } : {}),
    });
  }

  function selectOmsOrder(omsOrderId: string) {
    const intake = intakes.find((candidate) => candidate.omsOrderId !== null && String(candidate.omsOrderId) === omsOrderId);
    onChange({
      omsOrderId,
      ...(intake ? {
        vendorId: String(intake.vendor.vendorId),
        storeConnectionId: String(intake.storeConnection.storeConnectionId),
        intakeId: String(intake.intakeId),
      } : {}),
    });
  }

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Create RMA</h2>
          <p className="text-sm text-muted-foreground">Open a dropship return against a vendor, store, intake, or OMS order.</p>
        </div>
        <Button
          type="button"
          className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
          disabled={isSaving}
          onClick={onSubmit}
        >
          <PlusCircle className={isSaving ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          Create RMA
        </Button>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <div className="grid gap-3 md:grid-cols-2">
          <SearchableOptionPicker
            label="Vendor"
            value={form.vendorId}
            disabled={isSaving}
            options={vendorOptions}
            isLoading={vendorsLoading}
            placeholder="Select vendor"
            searchPlaceholder="Search vendor, email, or member..."
            emptyText="No dropship vendors found."
            onChange={(value) => onChange({ vendorId: value })}
          />
          <AdminReturnInput
            label="RMA number"
            value={form.rmaNumber}
            disabled={isSaving}
            onChange={(value) => onChange({ rmaNumber: value })}
          />
          <SearchableOptionPicker
            label="Store connection"
            value={form.storeConnectionId}
            disabled={isSaving}
            clearable
            clearLabel="No store connection"
            options={storeConnectionOptions}
            isLoading={storeConnectionsLoading}
            placeholder="Optional"
            searchPlaceholder="Search store, vendor, or email..."
            emptyText="No store connections found."
            onChange={selectStoreConnection}
          />
          <SearchableOptionPicker
            label="Order intake"
            value={form.intakeId}
            disabled={isSaving}
            clearable
            clearLabel="No intake"
            options={intakeOptions}
            isLoading={intakesLoading}
            placeholder="Optional"
            searchPlaceholder="Search order, intake, vendor, or store..."
            emptyText="No order intakes found."
            onChange={selectIntake}
          />
          <SearchableOptionPicker
            label="OMS order"
            value={form.omsOrderId}
            disabled={isSaving}
            clearable
            clearLabel="No OMS order"
            options={omsOrderOptions}
            isLoading={intakesLoading}
            placeholder="Optional"
            searchPlaceholder="Search OMS order, intake, or marketplace order..."
            emptyText="No OMS orders found."
            onChange={selectOmsOrder}
          />
          <AdminReturnInput
            label="Return window days"
            value={form.returnWindowDays}
            disabled={isSaving}
            onChange={(value) => onChange({ returnWindowDays: value })}
          />
          <AdminReturnInput
            label="Reason code"
            value={form.reasonCode}
            placeholder="Optional"
            disabled={isSaving}
            onChange={(value) => onChange({ reasonCode: value })}
          />
          <div>
            <label className="text-sm font-medium">Fault category</label>
            <Select
              value={form.faultCategory}
              onValueChange={(value) => onChange({ faultCategory: value as DropshipReturnFaultCategory | "none" })}
              disabled={isSaving}
            >
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Pending</SelectItem>
                {returnFaultCategories.map((category) => (
                  <SelectItem key={category} value={category}>{formatStatus(category)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AdminReturnInput
            label="Label source"
            value={form.labelSource}
            placeholder="marketplace, vendor, ops"
            disabled={isSaving}
            onChange={(value) => onChange({ labelSource: value })}
          />
          <AdminReturnInput
            label="Tracking number"
            value={form.returnTrackingNumber}
            placeholder="Optional"
            disabled={isSaving}
            onChange={(value) => onChange({ returnTrackingNumber: value })}
          />
          <div className="md:col-span-2">
            <label className="text-sm font-medium" htmlFor="dropship-return-create-notes">Vendor notes</label>
            <Textarea
              id="dropship-return-create-notes"
              className="mt-2 min-h-24"
              maxLength={5000}
              value={form.vendorNotes}
              onChange={(event) => onChange({ vendorNotes: event.target.value })}
              disabled={isSaving}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Return items</div>
            <Button type="button" variant="outline" size="sm" className="gap-2" disabled={isSaving} onClick={onAddItem}>
              <PlusCircle className="h-4 w-4" />
              Add item
            </Button>
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead className="w-[90px]">Qty</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Requested credit</TableHead>
                  <TableHead className="w-[84px]">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {form.items.map((item, index) => (
                  <TableRow key={index}>
                    <TableCell>
                      <ProductVariantSkuPicker
                        clearable
                        disabled={isSaving}
                        isLoading={variantsLoading}
                        label=""
                        placeholder="Optional SKU"
                        variants={variants}
                        value={item.productVariantId}
                        onChange={(value) => onItemChange(index, { productVariantId: value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.quantity}
                        disabled={isSaving}
                        onChange={(event) => onItemChange(index, { quantity: event.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.status}
                        maxLength={40}
                        disabled={isSaving}
                        onChange={(event) => onItemChange(index, { status: event.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.requestedCreditAmount}
                        placeholder="Optional"
                        disabled={isSaving}
                        onChange={(event) => onItemChange(index, { requestedCreditAmount: event.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isSaving || form.items.length === 1}
                        onClick={() => onRemoveItem(index)}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </section>
  );
}

function AdminReturnInput({
  disabled = false,
  label,
  onChange,
  placeholder,
  value,
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Input
        className="mt-2"
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ReturnInspectionPanel({
  error,
  form,
  isLoading,
  onCancel,
  onFormChange,
  onItemChange,
  onSave,
  pendingRmaId,
  rma,
  selectedRmaId,
}: {
  error: unknown;
  form: ReturnInspectionFormState | null;
  isLoading: boolean;
  onCancel: () => void;
  onFormChange: (patch: Partial<ReturnInspectionFormState>) => void;
  onItemChange: (
    rmaItemId: number,
    patch: Partial<Pick<ReturnInspectionItemFormState, "status" | "finalCreditAmount" | "feeAmount">>,
  ) => void;
  onSave: () => void;
  pendingRmaId: number | null;
  rma: DropshipReturnDetail | null;
  selectedRmaId: number | null;
}) {
  if (selectedRmaId === null) return null;

  if (isLoading) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-8 w-56" />
        <div className="mt-4 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{queryErrorMessage(error, "Unable to load RMA inspection detail.")}</AlertDescription>
      </Alert>
    );
  }

  if (!rma || !form) return null;

  const existingInspection = rma.inspections[0] ?? null;
  const totals = returnInspectionFormTotals(form);
  const pending = pendingRmaId === rma.rmaId;
  const saveDisabled = pending || existingInspection !== null || totals.hasInvalidAmount;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Inspection for {rma.rmaNumber}</h2>
          <p className="text-sm text-muted-foreground">
            {rma.vendorName || rma.vendorEmail || `Vendor ${rma.vendorId}`} / {rma.platform ? formatStatus(rma.platform) : "No platform"} / {rma.returnTrackingNumber || "No return tracking"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className={returnOpsStatusTone(rma.status)}>{formatStatus(rma.status)}</Badge>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Close</Button>
        </div>
      </div>

      {existingInspection && (
        <Alert className="mt-4 border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>
            Inspection {existingInspection.rmaInspectionId} was finalized as {formatStatus(existingInspection.outcome)} with {formatCents(existingInspection.creditCents)} credit and {formatCents(existingInspection.feeCents)} fee.
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Outcome</label>
            <Select
              value={form.outcome}
              onValueChange={(value) => onFormChange({ outcome: value as DropshipRmaInspectionOutcome })}
              disabled={existingInspection !== null || pending}
            >
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-sm font-medium">Fault category</label>
            <Select
              value={form.faultCategory}
              onValueChange={(value) => onFormChange({ faultCategory: value as DropshipReturnFaultCategory })}
              disabled={existingInspection !== null || pending}
            >
              <SelectTrigger className="mt-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {returnFaultCategories.map((category) => (
                  <SelectItem key={category} value={category}>{formatStatus(category)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">Computed wallet movement</div>
            <div className="mt-2 grid gap-1 text-sm text-muted-foreground">
              <div className="flex justify-between gap-3">
                <span>Credit</span>
                <span className="font-mono text-foreground">
                  {totals.hasInvalidAmount ? "Invalid" : formatCents(totals.creditCents)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span>Fee</span>
                <span className="font-mono text-foreground">
                  {totals.hasInvalidAmount ? "Invalid" : formatCents(totals.feeCents)}
                </span>
              </div>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium" htmlFor="dropship-return-inspection-notes">Inspection notes</label>
            <Textarea
              id="dropship-return-inspection-notes"
              className="mt-2 min-h-28"
              maxLength={5000}
              value={form.notes}
              onChange={(event) => onFormChange({ notes: event.target.value })}
              disabled={existingInspection !== null || pending}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Fee</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {form.items.map((item) => (
                  <TableRow key={item.rmaItemId}>
                    <TableCell>
                      <div className="font-medium">RMA item {item.rmaItemId}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.productVariantId ? `Variant ${item.productVariantId}` : "Variant not linked"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.status}
                        onChange={(event) => onItemChange(item.rmaItemId, { status: event.target.value })}
                        maxLength={40}
                        disabled={existingInspection !== null || pending}
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono">{item.quantity}</TableCell>
                    <TableCell>
                      <Input
                        value={item.finalCreditAmount}
                        onChange={(event) => onItemChange(item.rmaItemId, { finalCreditAmount: event.target.value })}
                        className="text-right font-mono"
                        disabled={existingInspection !== null || pending}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={item.feeAmount}
                        onChange={(event) => onItemChange(item.rmaItemId, { feeAmount: event.target.value })}
                        className="text-right font-mono"
                        disabled={existingInspection !== null || pending}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {rma.items.length === 0 && (
            <p className="text-sm text-muted-foreground">This RMA has no item rows attached.</p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Close
            </Button>
            <Button
              type="button"
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              disabled={saveDisabled}
              onClick={onSave}
            >
              <CheckCircle2 className={pending ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Finalize inspection
            </Button>
          </div>

          {totals.hasInvalidAmount && (
            <p className="text-right text-sm text-destructive">Credit and fee inputs must be valid dollar amounts.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function ReturnOpsTable({
  isLoading,
  onInspect,
  onStatusChange,
  onStatusNoteChange,
  onStatusSave,
  pendingRmaId,
  rmas,
  statusInputs,
  statusNotes,
  total,
}: {
  isLoading: boolean;
  onInspect: (rma: DropshipReturnListItem) => void;
  onStatusChange: (rmaId: number, status: DropshipRmaStatus) => void;
  onStatusNoteChange: (rmaId: number, note: string) => void;
  onStatusSave: (rma: DropshipReturnListItem) => void;
  pendingRmaId: number | null;
  rmas: DropshipReturnListItem[];
  statusInputs: Record<number, DropshipRmaStatus>;
  statusNotes: Record<number, string>;
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (rmas.length === 0) {
    return <EmptyState title="No returns" description="No dropship RMAs match the current filters." />;
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-lg font-semibold">Returns</h2>
          <p className="text-sm text-muted-foreground">{total} matching RMA{total === 1 ? "" : "s"}</p>
        </div>
        <RotateCcw className="h-5 w-5 text-muted-foreground" />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">RMA</TableHead>
            <TableHead>Vendor/order</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Fault</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Tracking</TableHead>
            <TableHead>Milestones</TableHead>
            <TableHead className="w-[145px]">Updated</TableHead>
            <TableHead className="w-[120px]">Inspection</TableHead>
            <TableHead className="w-[310px]">Status update</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rmas.map((rma) => {
            const nextStatus = statusInputs[rma.rmaId] ?? rma.status;
            const statusActionDisabled = pendingRmaId !== null
              || nextStatus === rma.status
              || rma.status === "credited";
            return (
              <TableRow key={rma.rmaId}>
                <TableCell>
                  <div className="font-mono text-sm">{rma.rmaNumber}</div>
                  <div className="text-xs text-muted-foreground">Window {rma.returnWindowDays}d</div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{rma.vendorName || rma.vendorEmail || `Vendor ${rma.vendorId}`}</div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      rma.platform ? formatStatus(rma.platform) : null,
                      rma.intakeId ? `Intake ${rma.intakeId}` : null,
                      rma.omsOrderId ? `OMS ${rma.omsOrderId}` : null,
                    ].filter(Boolean).join(" / ") || "No linked order"}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={returnOpsStatusTone(rma.status)}>
                    {formatStatus(rma.status)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {returnOpsTerminalStatuses.has(rma.status) ? "Terminal" : "Open"}
                  </div>
                </TableCell>
                <TableCell>
                  <div>{rma.faultCategory ? formatStatus(rma.faultCategory) : "Pending"}</div>
                  <div className="text-xs text-muted-foreground">{rma.reasonCode ? formatStatus(rma.reasonCode) : "No reason"}</div>
                </TableCell>
                <TableCell>
                  <div className="font-mono">{rma.itemCount} lines</div>
                  <div className="text-xs text-muted-foreground">{rma.totalQuantity} units</div>
                </TableCell>
                <TableCell>
                  <div className="max-w-[220px] truncate font-mono text-xs">{rma.returnTrackingNumber || "None"}</div>
                  <div className="text-xs text-muted-foreground">
                    {rma.returnTrackingNumber ? "Tracking recorded" : "No return tracking"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-xs text-muted-foreground">
                    {rma.receivedAt ? `Received ${formatDateTime(rma.receivedAt)}` : "Not received"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {rma.inspectedAt ? `Inspected ${formatDateTime(rma.inspectedAt)}` : "Not inspected"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {rma.creditedAt ? `Credited ${formatDateTime(rma.creditedAt)}` : "Not credited"}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(rma.updatedAt)}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={() => onInspect(rma)}
                  >
                    <FileSearch className="h-4 w-4" />
                    Inspect
                  </Button>
                </TableCell>
                <TableCell>
                  <div className="grid gap-2">
                    <Select
                      value={nextStatus}
                      onValueChange={(value) => onStatusChange(rma.rmaId, value as DropshipRmaStatus)}
                      disabled={rma.status === "credited"}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {returnOpsUpdateStatuses.map((option) => (
                          <SelectItem key={option} value={option}>
                            {formatStatus(option)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Input
                        value={statusNotes[rma.rmaId] ?? ""}
                        onChange={(event) => onStatusNoteChange(rma.rmaId, event.target.value)}
                        placeholder="Optional audit note"
                        maxLength={5000}
                        disabled={rma.status === "credited"}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-2"
                        disabled={statusActionDisabled}
                        onClick={() => onStatusSave(rma)}
                      >
                        <Save className={pendingRmaId === rma.rmaId ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                        Save
                      </Button>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function StoreConnectionsTable({
  connections,
  disablingConnectionId,
  isLoading,
  onDisableStoreConnection,
  onRepairShopifyWebhooks,
  repairingWebhookConnectionId,
  total,
}: {
  connections: DropshipAdminStoreConnectionListItem[];
  disablingConnectionId: number | null;
  isLoading: boolean;
  onDisableStoreConnection: (connection: DropshipAdminStoreConnectionListItem) => void;
  onRepairShopifyWebhooks: (connection: DropshipAdminStoreConnectionListItem) => void;
  repairingWebhookConnectionId: number | null;
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (connections.length === 0) {
    return (
      <Empty className="rounded-md border border-dashed p-8">
        <EmptyMedia variant="icon"><Store /></EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No store connections</EmptyTitle>
          <EmptyDescription>No dropship store connections match the current filters.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3 text-sm text-muted-foreground">
        <span>{total} store connection{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Store</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="min-w-[360px]">Config journey</TableHead>
            <TableHead>Last activity</TableHead>
            <TableHead className="w-[210px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => {
            const disabled = storeConnectionIsDisabled(connection);
            const canRepairShopifyWebhooks = connection.platform === "shopify" && connection.status === "connected";
            const ownerDetail = storeConnectionOwnerDetail(connection);
            return (
              <TableRow key={connection.storeConnectionId}>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <div className="font-medium">{storeConnectionDisplayName(connection)}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-zinc-700">
                        {formatStatus(connection.platform)}
                      </Badge>
                      {connection.shopDomain && (
                        <span className="max-w-[220px] truncate text-xs text-muted-foreground">{connection.shopDomain}</span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{storeConnectionOwnerLabel(connection)}</div>
                  {ownerDetail && <div className="text-xs text-muted-foreground">{ownerDetail}</div>}
                  <div className="mt-1 text-xs text-muted-foreground">
                    Entitlement {formatStatus(connection.vendor.entitlementStatus)}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={storeConnectionStatusTone(connection.status)}>
                    {formatStatus(connection.status)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {connection.launchReady ? "Ready for dogfood" : disabled ? "Disabled from program flow" : "Setup not complete"}
                  </div>
                  {connection.disconnectReason && (
                    <div className="mt-1 max-w-[200px] truncate text-xs text-muted-foreground">{connection.disconnectReason}</div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="grid gap-2 md:grid-cols-2">
                    {buildStoreConnectionJourney(connection).map((item) => (
                      <StoreConnectionJourneyPill key={item.key} item={item} />
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">Orders {formatDateTime(connection.lastOrderSyncAt)}</div>
                  <div className="text-xs text-muted-foreground">Inventory {formatDateTime(connection.lastInventorySyncAt)}</div>
                  <div className="text-xs text-muted-foreground">Any sync {formatDateTime(connection.lastSyncAt)}</div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-2">
                    {canRepairShopifyWebhooks && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 gap-2"
                        disabled={repairingWebhookConnectionId !== null}
                        onClick={() => onRepairShopifyWebhooks(connection)}
                      >
                        <RefreshCw className={repairingWebhookConnectionId === connection.storeConnectionId ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                        {repairingWebhookConnectionId === connection.storeConnectionId ? "Repairing" : "Repair webhooks"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-2 border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                      disabled={disabled || disablingConnectionId !== null}
                      onClick={() => onDisableStoreConnection(connection)}
                    >
                      <ShieldAlert className={disablingConnectionId === connection.storeConnectionId ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                      {disabled ? "Disabled" : disablingConnectionId === connection.storeConnectionId ? "Disabling" : "Disable store"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function StoreConnectionJourneyPill({ item }: { item: StoreConnectionJourneyItem }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${storeConnectionJourneyTone(item.state)}`}>
      <div className="text-xs font-medium uppercase tracking-wide">{item.label}</div>
      <div className="text-sm font-semibold">{item.value}</div>
      {item.detail && <div className="text-xs opacity-80">{item.detail}</div>}
    </div>
  );
}

function OrderIntakeSummary({
  cancellationSummary,
  summary,
  total,
}: {
  cancellationSummary: DropshipAdminOrderOpsListResponse["cancellationSummary"];
  summary: DropshipAdminOrderOpsListResponse["summary"];
  total: number;
}) {
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <CatalogMetric icon={<ClipboardList className="h-4 w-4" />} label="Matching intakes" value={String(total)} />
      <CatalogMetric icon={<Wallet className="h-4 w-4" />} label="Payment holds" value={String(orderStatusCount(summary, "payment_hold"))} />
      <CatalogMetric icon={<RefreshCw className="h-4 w-4" />} label="Retrying" value={String(orderStatusCount(summary, "retrying"))} />
      <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Failed or exception" value={String(orderStatusCount(summary, "failed") + orderStatusCount(summary, "exception"))} />
      <CatalogMetric
        icon={<RotateCcw className="h-4 w-4" />}
        label="Cancel failures"
        value={String(orderCancellationStatusCount(cancellationSummary, "marketplace_cancellation_failed"))}
      />
    </section>
  );
}

function OrderIntakeOpsTable({
  isLoading,
  items,
  onSelectDetail,
  onRunAction,
  pendingAction,
  retryEligibilityNow,
  selectedIntakeId,
  total,
}: {
  isLoading: boolean;
  items: DropshipAdminOrderOpsIntakeListItem[];
  onSelectDetail: (intake: DropshipAdminOrderOpsIntakeListItem) => void;
  onRunAction: (
    intake: DropshipAdminOrderOpsIntakeListItem,
    action: OrderIntakeAdminAction,
  ) => void;
  pendingAction: { intakeId: number; action: OrderIntakeAdminAction } | null;
  retryEligibilityNow: Date;
  selectedIntakeId: number | null;
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Empty className="rounded-md border border-dashed p-8">
        <EmptyMedia variant="icon"><ClipboardList /></EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No order intake rows</EmptyTitle>
          <EmptyDescription>No dropship order intake rows match the current filters.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3 text-sm text-muted-foreground">
        <span>{total} intake row{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Vendor / store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Ship to</TableHead>
            <TableHead>Latest audit</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="w-[360px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((intake) => {
            const retryEligibility = orderIntakeRetryEligibility(intake, retryEligibilityNow);
            const cancellationRetryEligibility = orderCancellationRetryEligibility(intake);
            const retryLabel = retryEligibility.reason === "stale_processing" ? "Recover" : "Retry";
            const canRetryWmsSync = orderIntakeCanRetryWmsSync(intake);
            return (
              <TableRow key={intake.intakeId}>
                <TableCell>
                  <div className="font-medium">{intake.externalOrderNumber || intake.externalOrderId}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatStatus(intake.platform)} intake {intake.intakeId}
                  </div>
                  {intake.omsOrderId && (
                    <div className="text-xs text-muted-foreground">OMS {intake.omsOrderId}</div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="font-medium">{intake.vendor.businessName || intake.vendor.email || `Vendor ${intake.vendor.vendorId}`}</div>
                  <div className="text-xs text-muted-foreground">
                    {intake.storeConnection.externalDisplayName || intake.storeConnection.shopDomain || formatStatus(intake.storeConnection.platform)}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={orderIntakeStatusTone(intake.status)}>
                    {formatStatus(intake.status)}
                  </Badge>
                  {intake.rejectionReason && (
                    <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">{intake.rejectionReason}</div>
                  )}
                  {intake.paymentHoldExpiresAt && (
                    <div className="mt-1 text-xs text-muted-foreground">Hold expires {formatDateTime(intake.paymentHoldExpiresAt)}</div>
                  )}
                  {intake.cancellationStatus && (
                    <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">
                      Cancel {formatStatus(intake.cancellationStatus)}
                    </div>
                  )}
                </TableCell>
                <TableCell>{orderShipToLabel(intake)}</TableCell>
                <TableCell>
                  {intake.latestAuditEvent ? (
                    <>
                      <div className="font-medium">{formatStatus(intake.latestAuditEvent.eventType)}</div>
                      <div className="text-xs text-muted-foreground">{formatDateTime(intake.latestAuditEvent.createdAt)}</div>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">None</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDateTime(intake.updatedAt)}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Button
                      type="button"
                      variant={selectedIntakeId === intake.intakeId ? "default" : "outline"}
                      size="sm"
                      className={selectedIntakeId === intake.intakeId ? "h-8 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" : "h-8 gap-2"}
                      disabled={pendingAction !== null}
                      onClick={() => onSelectDetail(intake)}
                    >
                      <FileSearch className="h-4 w-4" />
                      Detail
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={pendingAction !== null || !orderIntakeCanProcessNow(intake.status)}
                      onClick={() => onRunAction(intake, "process")}
                    >
                      <PlayCircle className={pendingAction?.intakeId === intake.intakeId && pendingAction.action === "process" ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                      Process
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={pendingAction !== null || !retryEligibility.canRetry}
                      onClick={() => onRunAction(intake, "retry")}
                    >
                      <RefreshCw className={pendingAction?.intakeId === intake.intakeId && pendingAction.action === "retry" ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                      {retryLabel}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={pendingAction !== null || !cancellationRetryEligibility.canRetry}
                      onClick={() => onRunAction(intake, "retry-cancellation")}
                    >
                      <RotateCcw className={pendingAction?.intakeId === intake.intakeId && pendingAction.action === "retry-cancellation" ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                      Retry cancel
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={pendingAction !== null || !canRetryWmsSync}
                      onClick={() => onRunAction(intake, "retry-wms-sync")}
                    >
                      <Truck className={pendingAction?.intakeId === intake.intakeId && pendingAction.action === "retry-wms-sync" ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                      Sync WMS
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={pendingAction !== null}
                      onClick={() => onRunAction(intake, "exception")}
                    >
                      <AlertCircle className="h-4 w-4" />
                      Exception
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function OrderIntakeDetailPanel({
  error,
  isLoading,
  onClose,
  order,
  selectedIntakeId,
}: {
  error: unknown;
  isLoading: boolean;
  onClose: () => void;
  order: DropshipOrderDetail | null;
  selectedIntakeId: number | null;
}) {
  if (selectedIntakeId === null) return null;

  if (isLoading) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-7 w-64" />
        <div className="mt-4 grid gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
        <Skeleton className="mt-4 h-40 w-full" />
      </section>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>{queryErrorMessage(error, "Unable to load dropship order detail.")}</AlertDescription>
      </Alert>
    );
  }

  if (!order) return null;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">
              {order.externalOrderNumber || order.externalOrderId}
            </h2>
            <Badge variant="outline" className={orderIntakeStatusTone(order.status as DropshipOpsOrderIntakeStatus)}>
              {formatStatus(order.status)}
            </Badge>
            {order.cancellationStatus && (
              <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-900">
                {formatStatus(order.cancellationStatus)}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatStatus(order.platform)} intake {order.intakeId} / {order.vendor.businessName || order.vendor.email || `Vendor ${order.vendor.vendorId}`} / {order.storeConnection.externalDisplayName || order.storeConnection.shopDomain || `Store ${order.storeConnection.storeConnectionId}`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<ClipboardList className="h-4 w-4" />} label="Lines / units" value={`${order.lineCount} / ${order.totalQuantity}`} />
        <CatalogMetric icon={<CircleDollarSign className="h-4 w-4" />} label="Grand total" value={formatOptionalCents(order.totals?.grandTotalCents)} />
        <CatalogMetric icon={<Truck className="h-4 w-4" />} label="Tracking pushes" value={String(order.trackingPushes.length)} />
        <CatalogMetric icon={<Wallet className="h-4 w-4" />} label="Wallet debit" value={formatOptionalCents(order.walletLedgerEntry?.amountCents)} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            <h3 className="font-semibold">Order lines</h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.lines.map((line) => (
                <TableRow key={`${line.lineIndex}:${line.externalLineItemId ?? line.sku ?? "line"}`}>
                  <TableCell>
                    <div className="font-medium">{line.title || `Line ${line.lineIndex + 1}`}</div>
                    <div className="text-xs text-muted-foreground">
                      {line.productVariantId ? `Variant ${line.productVariantId}` : "Variant not linked"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-sm">{line.sku || "None"}</div>
                    <div className="max-w-[180px] truncate text-xs text-muted-foreground">
                      {line.externalListingId || line.externalOfferId || line.externalLineItemId || "No marketplace line id"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">{line.quantity}</TableCell>
                  <TableCell className="text-right font-mono">{formatOptionalCents(line.unitRetailPriceCents)}</TableCell>
                  <TableCell className="text-right font-mono">{formatOptionalCents(line.lineRetailTotalCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="space-y-4">
          <div className="rounded-md border p-4">
            <h3 className="font-semibold">Money and quote</h3>
            <div className="mt-3 grid gap-2 text-sm">
              <DetailMoneyRow label="Retail subtotal" value={order.totals?.retailSubtotalCents} />
              <DetailMoneyRow label="Marketplace shipping" value={order.totals?.shippingPaidCents} />
              <DetailMoneyRow label="Wholesale subtotal" value={order.economicsSnapshot?.wholesaleSubtotalCents} />
              <DetailMoneyRow label="Shipping charged" value={order.economicsSnapshot?.shippingCents ?? order.shippingQuoteSnapshot?.totalShippingCents} />
              <DetailMoneyRow label="Insurance pool" value={order.economicsSnapshot?.insurancePoolCents ?? order.shippingQuoteSnapshot?.insurancePoolCents} />
              <DetailMoneyRow label="Fees" value={order.economicsSnapshot?.feesCents} />
              <DetailMoneyRow label="Total debit" value={order.economicsSnapshot?.totalDebitCents ?? order.walletLedgerEntry?.amountCents} />
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              {order.shippingQuoteSnapshot
                ? `Quote ${order.shippingQuoteSnapshot.quoteSnapshotId} / warehouse ${order.shippingQuoteSnapshot.warehouseId} / ${order.shippingQuoteSnapshot.packageCount} package(s)`
                : "No shipping quote snapshot"}
            </div>
          </div>

          <div className="rounded-md border p-4">
            <h3 className="font-semibold">State</h3>
            <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
              <div>OMS order: <span className="font-mono text-foreground">{order.omsOrderId ?? "None"}</span></div>
              <div>Received: <span className="text-foreground">{formatDateTime(order.receivedAt)}</span></div>
              <div>Accepted: <span className="text-foreground">{formatDateTime(order.acceptedAt)}</span></div>
              <div>Payment hold: <span className="text-foreground">{formatDateTime(order.paymentHoldExpiresAt)}</span></div>
              {order.rejectionReason && (
                <div className="text-rose-700">Rejection: {order.rejectionReason}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            <h3 className="font-semibold">Tracking pushes</h3>
          </div>
          {order.trackingPushes.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No tracking pushes recorded.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tracking</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Shipment</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.trackingPushes.map((push) => (
                  <TableRow key={push.pushId}>
                    <TableCell>
                      <div className="font-mono text-sm">{push.trackingNumber}</div>
                      <div className="text-xs text-muted-foreground">{push.carrier} / {formatStatus(push.platform)}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={trackingPushStatusTone(push.status)}>
                        {formatStatus(push.status)}
                      </Badge>
                      {push.lastErrorMessage && (
                        <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">{push.lastErrorMessage}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-sm">{push.wmsShipmentId ?? "None"}</div>
                      <div className="text-xs text-muted-foreground">{push.externalFulfillmentId || "No marketplace fulfillment"}</div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(push.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            <h3 className="font-semibold">Audit trail</h3>
          </div>
          {order.auditEvents.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No audit events recorded.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Payload</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.auditEvents.slice(0, 8).map((event, index) => (
                  <TableRow key={`${event.eventType}:${event.createdAt}:${index}`}>
                    <TableCell>
                      <Badge variant="outline" className={riskSeverityTone(event.severity)}>
                        {formatStatus(event.eventType)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{formatStatus(event.actorType)}</div>
                      <div className="max-w-[160px] truncate text-xs text-muted-foreground">{event.actorId || "System"}</div>
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                      {compactJsonPayload(event.payload)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </section>
  );
}

function DetailMoneyRow({
  label,
  value,
}: {
  label: string;
  value: number | null | undefined;
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{formatOptionalCents(value)}</span>
    </div>
  );
}

function formatOptionalCents(value: number | null | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value) ? formatCents(value) : "None";
}

function compactJsonPayload(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  if (!text || text === "{}") return "{}";
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function CatalogRuleTargetInput({
  categoryOptions,
  isLoadingCategories,
  isLoadingProductLines,
  isLoadingProducts,
  isLoadingVariants,
  productLineOptions,
  productOptions,
  ruleForm,
  setRuleForm,
  variantOptions,
}: {
  categoryOptions: DropshipProductCategoryOption[];
  isLoadingCategories: boolean;
  isLoadingProductLines: boolean;
  isLoadingProducts: boolean;
  isLoadingVariants: boolean;
  productLineOptions: DropshipProductLineOption[];
  productOptions: DropshipProductOption[];
  ruleForm: CatalogRuleFormState;
  setRuleForm: Dispatch<SetStateAction<CatalogRuleFormState>>;
  variantOptions: DropshipProductVariantOption[];
}) {
  if (ruleForm.scopeType === "catalog") return null;

  if (ruleForm.scopeType === "product_line") {
    return (
      <SearchableOptionPicker
        label="Product line"
        value={ruleForm.productLineId}
        onChange={(value) => setRuleForm((current) => ({ ...current, productLineId: value }))}
        options={productLineOptions.map((line) => ({
          value: String(line.id),
          label: line.name,
          detail: typeof line.productCount === "number" ? `${line.productCount} product${line.productCount === 1 ? "" : "s"}` : undefined,
          search: `${line.name} ${line.id}`,
        }))}
        isLoading={isLoadingProductLines}
        placeholder="Select product line"
        searchPlaceholder="Search product lines..."
        emptyText="No product lines found."
      />
    );
  }

  if (ruleForm.scopeType === "product") {
    return (
      <SearchableOptionPicker
        label="Product"
        value={ruleForm.productId}
        onChange={(value) => setRuleForm((current) => ({ ...current, productId: value }))}
        options={productOptions.map((product) => {
          const sku = product.sku ?? product.baseSku ?? "";
          return {
            value: String(product.id),
            label: product.name,
            detail: sku || undefined,
            search: `${product.name} ${sku} ${product.id}`,
          };
        })}
        isLoading={isLoadingProducts}
        placeholder="Select product"
        searchPlaceholder="Search product or SKU..."
        emptyText="No products found."
      />
    );
  }

  if (ruleForm.scopeType === "variant") {
    return (
      <ProductVariantSkuPicker
        isLoading={isLoadingVariants}
        label="SKU / variant"
        onChange={(value) => setRuleForm((current) => ({ ...current, productVariantId: value }))}
        value={ruleForm.productVariantId}
        variants={variantOptions}
      />
    );
  }

  return (
    <SearchableOptionPicker
      label="Category"
      value={ruleForm.category}
      onChange={(value) => setRuleForm((current) => ({ ...current, category: value }))}
      options={categoryOptions.map((category) => ({
        value: category.name,
        label: category.name,
        detail: typeof category.productCount === "number" ? `${category.productCount} product${category.productCount === 1 ? "" : "s"}` : undefined,
        search: `${category.name} ${category.id}`,
      }))}
      isLoading={isLoadingCategories}
      placeholder="Select category"
      searchPlaceholder="Search categories..."
      emptyText="No categories found."
    />
  );
}

function CatalogRuleDialog({
  categoryOptions,
  isLoadingCategories,
  isLoadingProductLines,
  isLoadingProducts,
  isLoadingVariants,
  onOpenChange,
  onSubmit,
  open,
  productLineOptions,
  productOptions,
  ruleForm,
  setRuleForm,
  variantOptions,
}: {
  categoryOptions: DropshipProductCategoryOption[];
  isLoadingCategories: boolean;
  isLoadingProductLines: boolean;
  isLoadingProducts: boolean;
  isLoadingVariants: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  open: boolean;
  productLineOptions: DropshipProductLineOption[];
  productOptions: DropshipProductOption[];
  ruleForm: CatalogRuleFormState;
  setRuleForm: Dispatch<SetStateAction<CatalogRuleFormState>>;
  variantOptions: DropshipProductVariantOption[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add exposure rule</DialogTitle>
            <DialogDescription>
              Add a broad rule or an exception. Place exceptions lower in the run order when they should override broader rules.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium">Scope</label>
              <Select
                value={ruleForm.scopeType}
                onValueChange={(value) => setRuleForm((current) => ({
                  ...current,
                  scopeType: value as CatalogExposureScopeFilter,
                }))}
              >
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="catalog">Entire catalog</SelectItem>
                  <SelectItem value="product_line">Product line</SelectItem>
                  <SelectItem value="category">Category</SelectItem>
                  <SelectItem value="product">Product</SelectItem>
                  <SelectItem value="variant">Variant</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Action</label>
              <Select
                value={ruleForm.action}
                onValueChange={(value) => setRuleForm((current) => ({
                  ...current,
                  action: value as CatalogExposureActionFilter,
                }))}
              >
                <SelectTrigger className="mt-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="include">Expose</SelectItem>
                  <SelectItem value="exclude">Hide</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <CatalogRuleTargetInput
              categoryOptions={categoryOptions}
              isLoadingCategories={isLoadingCategories}
              isLoadingProductLines={isLoadingProductLines}
              isLoadingProducts={isLoadingProducts}
              isLoadingVariants={isLoadingVariants}
              productLineOptions={productLineOptions}
              productOptions={productOptions}
              ruleForm={ruleForm}
              setRuleForm={setRuleForm}
              variantOptions={variantOptions}
            />

            <div className="md:col-span-2">
              <label className="text-sm font-medium" htmlFor="dropship-catalog-rule-notes">Notes</label>
              <Input
                id="dropship-catalog-rule-notes"
                className="mt-2"
                value={ruleForm.notes}
                onChange={(event) => setRuleForm((current) => ({ ...current, notes: event.target.value }))}
                placeholder="Optional admin note"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]">
              <PlusCircle className="h-4 w-4" />
              Add exposure rule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CatalogDraftRulesTable({
  hasUnsavedChanges,
  isLoading,
  isSaving,
  onClearRules,
  onMoveRule,
  onRemoveRule,
  onSaveRules,
  rules,
  targetLabels,
}: {
  hasUnsavedChanges: boolean;
  isLoading: boolean;
  isSaving: boolean;
  onClearRules: () => void;
  onMoveRule: (rule: DropshipAdminCatalogExposureRuleInput, direction: -1 | 1) => void;
  onRemoveRule: (rule: DropshipAdminCatalogExposureRuleInput) => void;
  onSaveRules: () => void;
  rules: DropshipAdminCatalogExposureRuleInput[];
  targetLabels: CatalogRuleTargetLabels;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Exposure rule set</h2>
          <p className="text-sm text-muted-foreground">
            {hasUnsavedChanges
              ? "Unpublished changes are staged. Publishing replaces the active admin exposure rules."
              : "Published rules are loaded. Editing this set creates unpublished changes."}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Badge variant="outline">
            {hasUnsavedChanges ? `${rules.length} unsaved` : "Published"}
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            disabled={isSaving || !hasUnsavedChanges}
            onClick={onClearRules}
          >
            <MinusCircle className="h-4 w-4" />
            Clear changes
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
            disabled={isSaving || !hasUnsavedChanges || rules.length === 0}
            onClick={onSaveRules}
          >
            <Save className="h-4 w-4" />
            {isSaving ? "Publishing" : "Publish"}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : rules.length === 0 ? (
        <Empty className="mt-4 rounded-md border border-dashed p-8">
          <EmptyMedia variant="icon"><Boxes /></EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No exposure rules</EmptyTitle>
            <EmptyDescription>
              Add an exposure rule before publishing. No catalog is visible without at least one expose rule.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mt-4 rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[96px]">Run order</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-[168px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule, index) => (
                <TableRow key={catalogExposureRuleKey(rule)}>
                  <TableCell className="font-mono text-sm">#{index + 1}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={catalogExposureActionTone(rule.action)}>
                      {catalogExposureActionLabel(rule.action)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{formatStatus(rule.scopeType)}</div>
                    <div className="text-xs text-muted-foreground">{catalogRuleTargetLabel(rule, targetLabels)}</div>
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate text-sm text-muted-foreground">{rule.notes || "None"}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={index === 0}
                        title="Move up"
                        onClick={() => onMoveRule(rule, -1)}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={index === rules.length - 1}
                        title="Move down"
                        onClick={() => onMoveRule(rule, 1)}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 gap-2"
                        onClick={() => onRemoveRule(rule)}
                      >
                        <MinusCircle className="h-4 w-4" />
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function CatalogPreviewTable({
  isLoading,
  limit,
  onAddPreviewRule,
  onPageChange,
  page,
  rows,
  total,
  totalPages,
}: {
  isLoading: boolean;
  limit: number;
  onAddPreviewRule: (
    row: DropshipAdminCatalogExposurePreviewRow,
    action: CatalogExposureActionFilter,
  ) => void;
  onPageChange: (page: number) => void;
  page: number;
  rows: DropshipAdminCatalogExposurePreviewRow[];
  total: number;
  totalPages: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <Empty className="mt-4 rounded-md border border-dashed p-8">
        <EmptyMedia variant="icon"><FileSearch /></EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No catalog rows</EmptyTitle>
          <EmptyDescription>No catalog preview rows match the current filters.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const firstRow = total === 0 ? 0 : ((page - 1) * limit) + 1;
  const lastRow = Math.min(total, firstRow + rows.length - 1);

  return (
    <div className="mt-4 rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm text-muted-foreground">
        <span>
          Showing {firstRow}-{lastRow} of {total} row{total === 1 ? "" : "s"}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Catalog row</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Vendor visibility</TableHead>
            <TableHead className="w-[180px] text-right">Exposure change</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.productVariantId}>
              <TableCell>
                <div className="font-medium">{row.productName}</div>
                <div className="text-xs text-muted-foreground">
                  {[row.productSku, row.variantSku, row.variantName].filter(Boolean).join(" / ") || `Variant ${row.productVariantId}`}
                </div>
              </TableCell>
              <TableCell>
                <div>{row.category || "None"}</div>
                <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                  {row.productLineNames.length ? row.productLineNames.join(", ") : "No product line"}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={row.productIsActive && row.variantIsActive
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-900"}
                >
                  {row.productIsActive && row.variantIsActive ? "Active" : "Inactive"}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={row.decision.exposed
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-zinc-200 bg-zinc-50 text-zinc-700"}
                >
                  {row.decision.exposed ? "Visible" : "Hidden"}
                </Badge>
                <div className="mt-1 text-xs text-muted-foreground">{catalogVisibilityReasonLabel(row.decision.reason)}</div>
              </TableCell>
              <TableCell>
                <CatalogPreviewQuickRules row={row} onAddPreviewRule={onAddPreviewRule} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex flex-col gap-3 border-t px-3 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>Page {page} of {totalPages}</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-2"
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function CatalogPreviewQuickRules({
  onAddPreviewRule,
  row,
}: {
  onAddPreviewRule: (
    row: DropshipAdminCatalogExposurePreviewRow,
    action: CatalogExposureActionFilter,
  ) => void;
  row: DropshipAdminCatalogExposurePreviewRow;
}) {
  const action: CatalogExposureActionFilter = row.decision.exposed ? "exclude" : "include";
  const label = row.decision.exposed ? "Hide" : "Expose";
  const Icon = row.decision.exposed ? MinusCircle : PlusCircle;
  return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto h-8 gap-2"
        onClick={() => onAddPreviewRule(row, action)}
      >
        <Icon className="h-4 w-4" />
        {label}
      </Button>
  );
}

function CatalogMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-3 text-2xl font-bold">{value}</div>
    </div>
  );
}

function catalogRuleTargetLabel(
  rule: DropshipAdminCatalogExposureRuleInput,
  labels: CatalogRuleTargetLabels,
): string {
  if (rule.scopeType === "catalog") return "Entire active catalog";
  if (rule.scopeType === "product_line") {
    return targetNameLabel("Product line", rule.productLineId, labels.productLineNamesById);
  }
  if (rule.scopeType === "product") {
    return targetNameLabel("Product", rule.productId, labels.productLabelsById);
  }
  if (rule.scopeType === "variant") {
    return targetNameLabel("Variant", rule.productVariantId, labels.variantLabelsById);
  }
  if (rule.scopeType === "category") {
    const category = rule.category?.trim();
    if (!category) return "Category not selected";
    return labels.categoryLabelsByKey.get(normalizeCatalogRuleLabelKey(category)) ?? category;
  }
  return "Unknown target";
}

function targetNameLabel(prefix: string, id: number | null | undefined, namesById: Map<number, string>): string {
  if (typeof id !== "number") return `${prefix} not selected`;
  const name = namesById.get(id);
  return name ? `${prefix}: ${name}` : `${prefix} #${id}`;
}

function normalizeCatalogRuleLabelKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeCatalogRuleOrder(
  rules: DropshipAdminCatalogExposureRuleInput[],
): DropshipAdminCatalogExposureRuleInput[] {
  return rules.map((rule, index) => ({
    ...rule,
    priority: index,
  }));
}

function catalogExposureRulesStateKey(rules: DropshipAdminCatalogExposureRuleInput[]): string {
  return rules
    .map((rule, index) => `${index}:${catalogExposureRuleKey(rule)}:${rule.priority}:${rule.notes ?? ""}`)
    .join("|");
}

function catalogExposureActionLabel(action: CatalogExposureActionFilter): string {
  return action === "include" ? "Expose" : "Hide";
}

function catalogExposureActionTone(action: CatalogExposureActionFilter): string {
  if (action === "include") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function catalogVisibilityReasonLabel(reason: string): string {
  if (reason === "exposed") return "Allowed by exposure rule";
  if (reason === "excluded_by_admin_rule") return "Hidden by exposure rule";
  if (reason === "inactive_product_or_variant") return "Inactive product or variant";
  if (reason === "missing_include_rule") return "No exposure rule";
  return formatStatus(reason);
}

function orderOpsStatusLabel(status: OrderOpsStatusFilter): string {
  if (status === "default") return "Needs attention";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function orderOpsCancellationStatusLabel(status: OrderOpsCancellationStatusFilter): string {
  if (status === "all") return "All cancellation states";
  return formatStatus(status);
}

function orderActionMessage(
  response:
    | DropshipAdminOrderOpsActionResponse
    | DropshipAdminOrderOpsCancellationRetryResponse
    | DropshipAdminOrderOpsProcessResponse
    | DropshipAdminOrderOpsWmsSyncResponse,
  action: OrderIntakeAdminAction,
): string {
  if (action === "retry-wms-sync" && "retryQueued" in response) {
    if (response.outcome === "synced") {
      const wmsOrderLabel = response.wmsOrderId ? ` WMS order ${response.wmsOrderId}` : " WMS";
      return `Order intake ${response.intakeId} synced to${wmsOrderLabel}.`;
    }
    const suffix = response.failureMessage ? `: ${response.failureMessage}` : ".";
    return `Order intake ${response.intakeId} WMS sync retry queued${suffix}`;
  }
  if (action === "process" && "failureCode" in response) {
    const suffix = response.failureCode ? ` (${formatStatus(response.failureCode)})` : "";
    return `Order intake ${response.intakeId} processing returned ${formatStatus(response.outcome)}${suffix}.`;
  }
  if (action === "retry-cancellation" && "cancellationStatus" in response) {
    return `Order intake ${response.intakeId} marketplace cancellation moved from ${formatStatus(response.previousCancellationStatus || "none")} to ${formatStatus(response.cancellationStatus || "none")}.`;
  }
  if ("previousStatus" in response) {
    return `Order intake ${response.intakeId} moved from ${formatStatus(response.previousStatus)} to ${formatStatus(response.status)}.`;
  }
  return `Order intake ${response.intakeId} action completed.`;
}

function orderIntakeCanProcessNow(status: DropshipOpsOrderIntakeStatus): boolean {
  return status === "received" || status === "retrying" || status === "payment_hold";
}

function orderIntakeCanRetryWmsSync(intake: DropshipAdminOrderOpsIntakeListItem): boolean {
  return intake.status === "accepted" && intake.omsOrderId !== null;
}

function readinessSummaryCount(
  summary: DropshipDogfoodReadinessResponse["summary"],
  status: DropshipDogfoodReadinessStatus,
): number {
  return summary.find((entry) => entry.status === status)?.count ?? 0;
}

function listingPushStatusLabel(status: ListingPushStatusFilter): string {
  if (status === "default") return "Needs attention";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function trackingPushStatusLabel(status: TrackingPushStatusFilter): string {
  if (status === "default") return "Needs attention";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function notificationOpsStatusLabel(status: NotificationOpsStatusFilter): string {
  if (status === "default") return "Needs attention";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function notificationOpsChannelLabel(channel: NotificationOpsChannelFilter): string {
  if (channel === "all") return "All channels";
  return formatStatus(channel);
}

function notificationOpsCriticalLabel(critical: NotificationOpsCriticalFilter): string {
  if (critical === "critical") return "Critical only";
  if (critical === "noncritical") return "Non-critical only";
  return "All criticality";
}

function returnOpsStatusLabel(status: ReturnOpsStatusFilter): string {
  if (status === "default") return "Open returns";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function orderStatusCount(
  summary: DropshipAdminOrderOpsListResponse["summary"],
  status: DropshipOpsOrderIntakeStatus,
): number {
  return summary.find((entry) => entry.status === status)?.count ?? 0;
}

function orderCancellationStatusCount(
  summary: DropshipAdminOrderOpsListResponse["cancellationSummary"],
  status: DropshipOrderCancellationStatus,
): number {
  return summary.find((entry) => entry.cancellationStatus === status)?.count ?? 0;
}

function orderShipToLabel(intake: DropshipAdminOrderOpsIntakeListItem): string {
  const shipTo = intake.shipTo;
  if (!shipTo) return "None";
  const locality = [shipTo.city, shipTo.region, shipTo.postalCode].filter(Boolean).join(", ");
  return locality || shipTo.country || shipTo.name || "Available";
}

function buildReturnInspectionFormState(rma: DropshipReturnDetail): ReturnInspectionFormState {
  return {
    rmaId: rma.rmaId,
    outcome: rma.status === "rejected" ? "rejected" : "approved",
    faultCategory: rma.faultCategory ?? "card_shellz",
    notes: rma.inspections[0]?.notes ?? "",
    items: rma.items.map((item) => {
      const finalCreditCents = item.finalCreditCents ?? item.requestedCreditCents ?? 0;
      const feeCents = item.feeCents ?? 0;
      return {
        rmaItemId: item.rmaItemId,
        productVariantId: item.productVariantId,
        quantity: item.quantity,
        status: item.finalCreditCents !== null || item.feeCents !== null ? item.status : "approved",
        finalCreditAmount: centsToDollarInput(finalCreditCents),
        feeAmount: centsToDollarInput(feeCents),
      };
    }),
  };
}

function returnInspectionFormTotals(form: ReturnInspectionFormState): {
  creditCents: number;
  feeCents: number;
  hasInvalidAmount: boolean;
} {
  return form.items.reduce<{
    creditCents: number;
    feeCents: number;
    hasInvalidAmount: boolean;
  }>((totals, item) => {
    const creditCents = parseDollarInputForDisplay(item.finalCreditAmount);
    const feeCents = parseDollarInputForDisplay(item.feeAmount);
    return {
      creditCents: totals.creditCents + (creditCents ?? 0),
      feeCents: totals.feeCents + (feeCents ?? 0),
      hasInvalidAmount: totals.hasInvalidAmount || creditCents === null || feeCents === null,
    };
  }, { creditCents: 0, feeCents: 0, hasInvalidAmount: false });
}

function parseDollarInputForDisplay(value: string): number | null {
  const normalized = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!normalized) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [dollars, cents = ""] = normalized.split(".");
  const result = (Number(dollars) * 100) + Number(cents.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}

function centsToDollarInput(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "0.00";
  const dollars = Math.trunc(value / 100);
  const cents = value % 100;
  return `${dollars}.${String(cents).padStart(2, "0")}`;
}

function orderIntakeStatusTone(status: DropshipOpsOrderIntakeStatus): string {
  if (status === "accepted" || status === "processing") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "payment_hold" || status === "retrying" || status === "received") {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "failed" || status === "exception" || status === "rejected" || status === "cancelled") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function dogfoodReadinessStatusTone(status: DropshipDogfoodReadinessStatus): string {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function workerSweepMessageForResponse(response: DropshipAdminWorkerSweepResponse): string {
  const metrics = Object.entries(response.metrics)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${formatStatus(key)} ${value}`);
  const suffix = metrics.length > 0 ? `: ${metrics.join(" / ")}.` : ".";
  return `${workerSweepLabel(response.worker)} sweep completed${suffix}`;
}

function workerSweepLabel(worker: DropshipAdminWorkerSweepName): string {
  return adminWorkerSweepOptions.find((option) => option.worker === worker)?.label ?? formatStatus(worker);
}

function omsChannelConfigLabel(config: DropshipOmsChannelConfigOverview | null): string {
  if (!config) return "Loading";
  if (config.currentChannelCount === 1) return "Ready";
  if (config.currentChannelCount > 1) return "Ambiguous";
  return "Missing";
}

function omsChannelConfigTone(config: DropshipOmsChannelConfigOverview | null): string {
  if (!config) return "border-zinc-200 bg-zinc-50 text-zinc-700";
  if (config.currentChannelCount === 1) return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (config.currentChannelCount > 1) return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function systemReadinessTone(blockedCount: number, warningCount: number): string {
  if (blockedCount > 0) return "border-rose-200 bg-rose-50 text-rose-800";
  if (warningCount > 0) return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
}

function listingPushStatusTone(status: DropshipListingPushJobStatus): string {
  if (status === "completed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "queued" || status === "processing") {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "failed") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function trackingPushStatusTone(status: DropshipTrackingPushStatus): string {
  if (status === "succeeded") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "queued" || status === "processing") {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "failed") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function notificationOpsStatusTone(status: DropshipNotificationOpsStatus): string {
  if (status === "delivered") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "pending") {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "failed") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function returnOpsStatusTone(status: DropshipRmaStatus): string {
  if (status === "credited" || status === "closed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "approved" || status === "received" || status === "inspecting") {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "rejected") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

type StoreConnectionJourneyState = "ready" | "warning" | "blocked" | "disabled";

interface StoreConnectionJourneyItem {
  key: string;
  label: string;
  value: string;
  detail?: string;
  state: StoreConnectionJourneyState;
}

function buildStoreConnectionSummary(connections: DropshipAdminStoreConnectionListItem[]): {
  ready: number;
  setupIncomplete: number;
  authAttention: number;
  disabled: number;
} {
  return {
    ready: connections.filter((connection) => connection.launchReady).length,
    setupIncomplete: connections.filter((connection) => !connection.launchReady && !storeConnectionIsDisabled(connection)).length,
    authAttention: connections.filter((connection) => !storeConnectionIsDisabled(connection) && storeConnectionNeedsAuthAttention(connection)).length,
    disabled: connections.filter((connection) => storeConnectionIsDisabled(connection)).length,
  };
}

function storeConnectionIsDisabled(connection: DropshipAdminStoreConnectionListItem): boolean {
  return connection.status === "grace_period"
    || connection.status === "paused"
    || connection.status === "disconnected";
}

function storeConnectionNeedsAuthAttention(connection: DropshipAdminStoreConnectionListItem): boolean {
  return connection.status === "needs_reauth"
    || connection.status === "refresh_failed"
    || !connection.hasAccessToken
    || (connection.platform === "ebay" && !connection.hasRefreshToken);
}

function buildStoreConnectionJourney(connection: DropshipAdminStoreConnectionListItem): StoreConnectionJourneyItem[] {
  return [
    buildStoreConnectionAuthJourney(connection),
    buildStoreConnectionSetupJourney(connection),
    buildStoreConnectionWarehouseJourney(connection),
    buildStoreConnectionListingJourney(connection),
  ];
}

function buildStoreConnectionAuthJourney(connection: DropshipAdminStoreConnectionListItem): StoreConnectionJourneyItem {
  if (storeConnectionIsDisabled(connection)) {
    return { key: "auth", label: "Auth", value: "Disabled", detail: "Authorization removed", state: "disabled" };
  }
  if (connection.status === "needs_reauth" || connection.status === "refresh_failed") {
    return { key: "auth", label: "Auth", value: "Reconnect", detail: formatStatus(connection.status), state: "blocked" };
  }
  if (!connection.hasAccessToken) {
    return { key: "auth", label: "Auth", value: "Missing", detail: "Reconnect required", state: "blocked" };
  }
  if (connection.platform === "ebay" && !connection.hasRefreshToken) {
    return { key: "auth", label: "Auth", value: "Missing", detail: "Reconnect required", state: "blocked" };
  }
  return { key: "auth", label: "Auth", value: "Authorized", state: "ready" };
}

function buildStoreConnectionSetupJourney(connection: DropshipAdminStoreConnectionListItem): StoreConnectionJourneyItem {
  if (connection.setupCheckSummary.errorCount > 0) {
    return {
      key: "setup",
      label: "Setup",
      value: `${connection.setupCheckSummary.errorCount} blocker${connection.setupCheckSummary.errorCount === 1 ? "" : "s"}`,
      detail: `${connection.setupCheckSummary.openCount} open check${connection.setupCheckSummary.openCount === 1 ? "" : "s"}`,
      state: "blocked",
    };
  }
  if (connection.setupCheckSummary.warningCount > 0) {
    return {
      key: "setup",
      label: "Setup",
      value: `${connection.setupCheckSummary.warningCount} warning${connection.setupCheckSummary.warningCount === 1 ? "" : "s"}`,
      detail: `${connection.setupCheckSummary.openCount} open check${connection.setupCheckSummary.openCount === 1 ? "" : "s"}`,
      state: "warning",
    };
  }
  if (connection.setupStatus === "ready") {
    return { key: "setup", label: "Setup", value: "Ready", state: "ready" };
  }
  return { key: "setup", label: "Setup", value: formatStatus(connection.setupStatus), state: "warning" };
}

function buildStoreConnectionWarehouseJourney(connection: DropshipAdminStoreConnectionListItem): StoreConnectionJourneyItem {
  if (connection.orderProcessingConfig.defaultWarehouseId !== null) {
    return { key: "warehouse", label: "Warehouse", value: "Set", state: "ready" };
  }
  return { key: "warehouse", label: "Warehouse", value: "Missing", detail: "Order routing not assigned", state: "blocked" };
}

function buildStoreConnectionListingJourney(connection: DropshipAdminStoreConnectionListItem): StoreConnectionJourneyItem {
  if (!connection.listingConfig.isConfigured) {
    return { key: "listing", label: "Listing", value: "Missing", detail: "Push policy not configured", state: "blocked" };
  }
  if (!connection.listingConfig.isActive) {
    return { key: "listing", label: "Listing", value: "Inactive", detail: "Pushes disabled", state: "warning" };
  }
  return { key: "listing", label: "Listing", value: "Ready", state: "ready" };
}

function storeConnectionJourneyTone(state: StoreConnectionJourneyState): string {
  if (state === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (state === "warning") return "border-amber-200 bg-amber-50 text-amber-950";
  if (state === "blocked") return "border-rose-200 bg-rose-50 text-rose-900";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function formatWarehouseOption(warehouse: DropshipWarehouseOption): string {
  const defaultSuffix = warehouse.isDefault === 1 ? " default" : "";
  return `${warehouse.name} (${warehouse.code}) - ID ${warehouse.id}${defaultSuffix}`;
}

function buildVendorSelectOptions(items: DropshipDogfoodReadinessItem[]): DropshipSelectOption[] {
  const vendors = new Map<number, DropshipDogfoodReadinessItem["vendor"]>();
  for (const item of items) {
    vendors.set(item.vendor.vendorId, item.vendor);
  }
  return Array.from(vendors.values())
    .sort((first, second) => vendorDisplayName(first).localeCompare(vendorDisplayName(second)))
    .map((vendor) => ({
      value: String(vendor.vendorId),
      label: vendorDisplayName(vendor),
      detail: [
        vendor.email,
        vendor.memberId,
        formatStatus(vendor.status),
        formatStatus(vendor.entitlementStatus),
      ].filter(Boolean).join(" / "),
      search: [
        vendor.vendorId,
        vendor.businessName,
        vendor.email,
        vendor.memberId,
        vendor.status,
        vendor.entitlementStatus,
      ].filter(Boolean).join(" "),
    }));
}

function vendorDisplayName(vendor: DropshipDogfoodReadinessItem["vendor"] | DropshipAdminOrderOpsVendorSummary): string {
  return vendor.businessName || vendor.email || `Vendor ${vendor.vendorId}`;
}

function storeConnectionDisplayName(connection: DropshipAdminStoreConnectionListItem | DropshipAdminOrderOpsStoreSummary): string {
  return connection.externalDisplayName
    || connection.shopDomain
    || `${formatStatus(connection.platform)} store`;
}

function storeConnectionOwnerLabel(connection: DropshipAdminStoreConnectionListItem): string {
  return connection.vendor.businessName || connection.vendor.email || `Vendor ${connection.vendor.vendorId}`;
}

function storeConnectionOwnerDetail(connection: DropshipAdminStoreConnectionListItem): string {
  if (connection.vendor.businessName && connection.vendor.email) {
    return connection.vendor.email;
  }
  return "";
}

function storeConnectionSelectOption(connection: DropshipAdminStoreConnectionListItem): DropshipSelectOption {
  const storeLabel = storeConnectionDisplayName(connection);
  const vendorLabel = vendorDisplayName(connection.vendor);
  return {
    value: String(connection.storeConnectionId),
    label: storeLabel,
    detail: [
      vendorLabel,
      formatStatus(connection.platform),
      formatStatus(connection.status),
      `ID ${connection.storeConnectionId}`,
    ].join(" / "),
    search: [
      connection.storeConnectionId,
      storeLabel,
      connection.externalAccountId,
      connection.shopDomain,
      connection.platform,
      connection.status,
      vendorLabel,
      connection.vendor.email,
      connection.vendor.memberId,
      connection.vendor.vendorId,
    ].filter(Boolean).join(" "),
  };
}

function orderIntakeSelectOption(intake: DropshipAdminOrderOpsIntakeListItem): DropshipSelectOption {
  const orderLabel = intake.externalOrderNumber || intake.externalOrderId || `Intake ${intake.intakeId}`;
  const storeLabel = storeConnectionDisplayName(intake.storeConnection);
  const vendorLabel = vendorDisplayName(intake.vendor);
  return {
    value: String(intake.intakeId),
    label: orderLabel,
    detail: [
      `Intake ${intake.intakeId}`,
      vendorLabel,
      storeLabel,
      intake.omsOrderId === null ? "" : `OMS ${intake.omsOrderId}`,
      formatStatus(intake.status),
    ].filter(Boolean).join(" / "),
    search: [
      intake.intakeId,
      intake.omsOrderId,
      intake.externalOrderId,
      intake.externalOrderNumber,
      intake.platform,
      intake.status,
      vendorLabel,
      intake.vendor.email,
      intake.vendor.memberId,
      storeLabel,
      intake.storeConnection.storeConnectionId,
    ].filter(Boolean).join(" "),
  };
}

function buildOmsOrderSelectOptions(intakes: DropshipAdminOrderOpsIntakeListItem[]): DropshipSelectOption[] {
  const options = new Map<number, DropshipSelectOption>();
  for (const intake of intakes) {
    if (intake.omsOrderId === null) continue;
    const intakeOption = orderIntakeSelectOption(intake);
    options.set(intake.omsOrderId, {
      value: String(intake.omsOrderId),
      label: `OMS order ${intake.omsOrderId}`,
      detail: intakeOption.detail,
      search: `${intake.omsOrderId} ${intakeOption.search}`,
    });
  }
  return Array.from(options.values()).sort((first, second) => Number(second.value) - Number(first.value));
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sideLength = Math.max(3, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, sideLength)}...${value.slice(-sideLength)}`;
}

function formatVariantOption(variant: DropshipProductVariantOption): string {
  return `${variant.sku || `Variant ${variant.id}`} - ${variant.name}`;
}

function variantOptionSearchValue(variant: DropshipProductVariantOption): string {
  return `${variant.sku ?? ""} ${variant.name} ${variant.id}`;
}

function inchesToMillimetersString(value: string, field: string): string {
  const parsed = parsePositiveDecimal(value, field);
  return String(Math.max(1, Math.round(parsed * 25.4)));
}

function poundsToGramsString(value: string, field: string): string {
  const parsed = parseNonNegativeDecimal(value, field);
  return String(Math.round(parsed * 453.59237));
}

function parsePositiveDecimal(value: string, field: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return parsed;
}

function parseNonNegativeDecimal(value: string, field: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be zero or greater.`);
  }
  return parsed;
}

function formatMmAsInches(value: number): string {
  return formatMeasurement(value / 25.4);
}

function formatGramsAsPounds(value: number): string {
  return formatMeasurement(value / 453.59237);
}

function formatMeasurement(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function storeConnectionStatusTone(status: DropshipStoreConnectionLifecycleStatus): string {
  if (status === "connected") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "needs_reauth" || status === "refresh_failed" || status === "grace_period") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  if (status === "paused") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function OverviewTab({ overview }: { overview: DropshipAdminOpsOverview }) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <MetricTile
          icon={<Store className="h-4 w-4" />}
          label="Store connections needing attention"
          value={String(riskCount(overview.riskBuckets, "store_connections_attention"))}
        />
        <MetricTile
          icon={<Wallet className="h-4 w-4" />}
          label="Payment holds"
          value={String(riskCount(overview.riskBuckets, "payment_holds"))}
        />
        <MetricTile
          icon={<Truck className="h-4 w-4" />}
          label="Tracking push failures"
          value={String(riskCount(overview.riskBuckets, "tracking_push_failures"))}
        />
        <MetricTile
          icon={<Bell className="h-4 w-4" />}
          label="Notification failures"
          value={String(riskCount(overview.riskBuckets, "notification_delivery_failures"))}
        />
        <MetricTile
          icon={<RotateCcw className="h-4 w-4" />}
          label="Cancellation failures"
          value={String(riskCount(overview.riskBuckets, "marketplace_cancellation_failures"))}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
        <section className="rounded-md border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Risk buckets</h2>
              <p className="text-sm text-muted-foreground">Launch-critical blockers and exceptions</p>
            </div>
            <Badge variant="outline">
              {overview.riskBuckets.reduce((sum, bucket) => sum + bucket.count, 0)} open
            </Badge>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {overview.riskBuckets.map((bucket) => (
              <RiskBucketCard key={bucket.key} bucket={bucket} />
            ))}
          </div>
        </section>

        <section className="rounded-md border bg-card p-4">
          <div>
            <h2 className="text-lg font-semibold">Status counts</h2>
            <p className="text-sm text-muted-foreground">Current state by dropship subsystem</p>
          </div>
          <div className="mt-4 grid gap-3">
            <StatusCountGroup title="Vendors" counts={overview.vendorStatusCounts} icon={<ShieldAlert className="h-4 w-4" />} />
            <StatusCountGroup title="Store connections" counts={overview.storeConnectionStatusCounts} icon={<Store className="h-4 w-4" />} />
            <StatusCountGroup title="Order intake" counts={overview.orderIntakeStatusCounts} icon={<ClipboardList className="h-4 w-4" />} />
            <StatusCountGroup title="Marketplace cancellations" counts={overview.orderCancellationStatusCounts} icon={<RotateCcw className="h-4 w-4" />} />
            <StatusCountGroup title="Listing push jobs" counts={overview.listingPushJobStatusCounts} icon={<RefreshCw className="h-4 w-4" />} />
            <StatusCountGroup title="Tracking pushes" counts={overview.trackingPushStatusCounts} icon={<Truck className="h-4 w-4" />} />
            <StatusCountGroup title="Returns" counts={overview.rmaStatusCounts} icon={<RotateCcw className="h-4 w-4" />} />
            <StatusCountGroup title="Notifications" counts={overview.notificationStatusCounts} icon={<Bell className="h-4 w-4" />} />
          </div>
        </section>
      </div>

      <section className="rounded-md border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Recent audit events</h2>
            <p className="text-sm text-muted-foreground">Latest dropship operational trail</p>
          </div>
          <History className="h-5 w-5 text-muted-foreground" />
        </div>
        <AuditEventsTable events={overview.recentAuditEvents} isLoading={false} total={overview.recentAuditEvents.length} compact />
      </section>
    </>
  );
}

function MetricTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-3 text-2xl font-bold">{value}</div>
    </div>
  );
}

function RiskBucketCard({ bucket }: { bucket: DropshipOpsRiskBucket }) {
  return (
    <div className="rounded-md border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{bucket.label}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{formatStatus(bucket.severity)} severity</p>
        </div>
        <Badge variant="outline" className={riskSeverityTone(bucket.severity)}>
          {bucket.count}
        </Badge>
      </div>
    </div>
  );
}

function StatusCountGroup({
  counts,
  icon,
  title,
}: {
  counts: DropshipOpsCount[];
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </div>
      {counts.length === 0 ? (
        <div className="text-sm text-muted-foreground">No rows</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {counts.map((count) => (
            <Badge key={count.key} variant="outline" className="gap-2">
              {formatStatus(count.key)}
              <span className="font-mono">{count.count}</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function AuditEventsTable({
  compact = false,
  events,
  isLoading,
  total,
}: {
  compact?: boolean;
  events: DropshipAuditEventRecord[];
  isLoading: boolean;
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (events.length === 0) {
    return <EmptyState title="No audit events" description="No matching dropship audit events were found." />;
  }

  return (
    <div className="mt-4 rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm text-muted-foreground">
        <span>{total} event{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[145px]">Time</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Vendor</TableHead>
            {!compact && <TableHead>Entity</TableHead>}
            <TableHead>Severity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.auditEventId}>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {formatDateTime(event.createdAt)}
              </TableCell>
              <TableCell>
                <div className="font-medium">{formatStatus(event.eventType)}</div>
                <div className="text-xs text-muted-foreground">{event.actorType}{event.actorId ? `: ${event.actorId}` : ""}</div>
              </TableCell>
              <TableCell>
                <div className="font-medium">{event.vendorBusinessName || event.vendorEmail || "System"}</div>
                {event.storeDisplayName && <div className="text-xs text-muted-foreground">{event.storeDisplayName}</div>}
              </TableCell>
              {!compact && (
                <TableCell>
                  <div className="font-medium">{formatStatus(event.entityType)}</div>
                  <div className="max-w-[220px] truncate text-xs text-muted-foreground">{event.entityId || "None"}</div>
                </TableCell>
              )}
              <TableCell>
                <Badge variant="outline" className={riskSeverityTone(event.severity)}>
                  {formatStatus(event.severity)}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function EmptyState({ description, title }: { description: string; title: string }) {
  return (
    <Empty className="mt-4 rounded-md border border-dashed">
      <EmptyMedia variant="icon">
        <FileSearch />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

function riskCount(buckets: DropshipOpsRiskBucket[], key: string): number {
  return countByKey(
    buckets.map((bucket) => ({ key: bucket.key, count: bucket.count })),
    key,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Dropship ops request failed.";
}
