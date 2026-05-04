import { useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Bell,
  Boxes,
  CheckCircle2,
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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
  allDropshipListingInventoryModes,
  allDropshipListingModes,
  allDropshipListingPriceModes,
  allDropshipListingRequiredProductFields,
  buildAdminCatalogExposurePreviewUrl,
  buildAdminDogfoodReadinessUrl,
  buildAdminOmsChannelConfigUrl,
  buildAdminOmsChannelConfigureInput,
  buildAdminListingPushJobsUrl,
  buildAdminNotificationEventsUrl,
  buildAdminOrderIntakeUrl,
  buildAdminOrderOpsActionInput,
  buildAdminReturnCreateInput,
  buildAdminReturnInspectionInput,
  buildAdminReturnStatusUpdateInput,
  buildAdminReturnsUrl,
  buildAdminShippingConfigUrl,
  buildAdminTrackingPushRetryInput,
  buildAdminStoreConnectionsUrl,
  buildAdminStoreWebhookRepairInput,
  buildAdminTrackingPushesUrl,
  buildCatalogExposureRuleInput,
  buildShippingBoxInput,
  buildShippingInsurancePolicyInput,
  buildShippingMarkupPolicyInput,
  buildShippingPackageProfileInput,
  buildShippingRateTableInput,
  buildShippingZoneRuleInput,
  buildStoreListingConfigInput,
  buildStoreOrderProcessingConfigInput,
  countByKey,
  catalogExposureRecordToInput,
  catalogExposureRuleKey,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  postJson,
  putJson,
  queryErrorMessage,
  riskSeverityTone,
  type DropshipAdminCatalogExposurePreviewResponse,
  type DropshipAdminCatalogExposurePreviewRow,
  type DropshipAdminCatalogExposureRulesReplaceResponse,
  type DropshipAdminCatalogExposureRulesResponse,
  type DropshipAdminCatalogExposureRuleInput,
  type DropshipAdminListingPushJobListItem,
  type DropshipAdminListingPushJobListResponse,
  type DropshipAdminNotificationOpsListItem,
  type DropshipAdminNotificationOpsListResponse,
  type DropshipAdminOrderOpsActionResponse,
  type DropshipAdminOrderOpsIntakeListItem,
  type DropshipAdminOrderOpsListResponse,
  type DropshipAdminOrderOpsProcessResponse,
  type DropshipAdminOmsChannelConfigResponse,
  type DropshipAdminOmsChannelConfigureResponse,
  type DropshipAdminReturnCreateResponse,
  type DropshipAdminReturnInspectionResponse,
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
  type DropshipDogfoodReadinessItem,
  type DropshipDogfoodReadinessResponse,
  type DropshipDogfoodReadinessStatus,
  type DropshipOmsChannelConfigOverview,
  type DropshipOpsCount,
  type DropshipOpsRiskBucket,
  type DropshipOpsOrderIntakeStatus,
  type DropshipListingPushJobStatus,
  type DropshipNotificationOpsChannel,
  type DropshipNotificationOpsStatus,
  type DropshipReturnListItem,
  type DropshipReturnListResponse,
  type DropshipReturnDetail,
  type DropshipReturnDetailResponse,
  type DropshipReturnFaultCategory,
  type DropshipRmaInspectionOutcome,
  type DropshipRmaStatus,
  type DropshipTrackingPushStatus,
  type DropshipSeverity,
  type DropshipShippingConfigOverview,
  type DropshipListingInventoryMode,
  type DropshipListingMode,
  type DropshipListingPriceMode,
  type DropshipStoreConnectionLifecycleStatus,
  type DropshipStorePlatform,
  type DropshipStoreListingConfigResponse,
  type DropshipStoreOrderProcessingConfigResponse,
  type DropshipSystemReadinessCheck,
} from "@/lib/dropship-ops-surface";

type AuditSeverityFilter = DropshipSeverity | "all";
type DogfoodReadinessStatusFilter = DropshipDogfoodReadinessStatus | "all";
type OrderOpsStatusFilter = DropshipOpsOrderIntakeStatus | "default" | "all";
type ListingPushStatusFilter = DropshipListingPushJobStatus | "default" | "all";
type TrackingPushStatusFilter = DropshipTrackingPushStatus | "default" | "all";
type NotificationOpsStatusFilter = DropshipNotificationOpsStatus | "default" | "all";
type NotificationOpsChannelFilter = DropshipNotificationOpsChannel | "all";
type NotificationOpsCriticalFilter = "all" | "critical" | "noncritical";
type ReturnOpsStatusFilter = DropshipRmaStatus | "default" | "all";
type StoreConnectionStatusFilter = DropshipStoreConnectionLifecycleStatus | "all";
type StoreConnectionPlatformFilter = DropshipStorePlatform | "all";
type CatalogExposureScopeFilter = DropshipAdminCatalogExposureRuleInput["scopeType"];
type CatalogExposureActionFilter = DropshipAdminCatalogExposureRuleInput["action"];

interface ListingConfigFormState {
  storeConnectionId: number;
  listingMode: DropshipListingMode;
  inventoryMode: DropshipListingInventoryMode;
  priceMode: DropshipListingPriceMode;
  marketplaceConfigJson: string;
  requiredConfigKeys: string;
  requiredProductFields: string;
  isActive: boolean;
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

interface ShippingBoxFormState {
  code: string;
  name: string;
  lengthMm: string;
  widthMm: string;
  heightMm: string;
  tareWeightGrams: string;
  maxWeightGrams: string;
  isActive: boolean;
}

interface ShippingPackageProfileFormState {
  productVariantId: string;
  weightGrams: string;
  lengthMm: string;
  widthMm: string;
  heightMm: string;
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
  lengthMm: "",
  widthMm: "",
  heightMm: "",
  tareWeightGrams: "0",
  maxWeightGrams: "",
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

function makeEmptyReturnCreateForm(): ReturnCreateFormState {
  return {
    ...emptyReturnCreateForm,
    items: [{ ...emptyReturnCreateItemForm }],
  };
}

const emptyShippingPackageProfileForm: ShippingPackageProfileFormState = {
  productVariantId: "",
  weightGrams: "",
  lengthMm: "",
  widthMm: "",
  heightMm: "",
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

export default function Dropship() {
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
        <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mb-5 h-auto w-full justify-start overflow-x-auto rounded-none border-b bg-transparent p-0">
            <TabsTrigger
              value="overview"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Overview
            </TabsTrigger>
            <TabsTrigger
              value="dogfood"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Dogfood readiness
            </TabsTrigger>
            <TabsTrigger
              value="catalog"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Catalog exposure
            </TabsTrigger>
            <TabsTrigger
              value="shipping"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Shipping config
            </TabsTrigger>
            <TabsTrigger
              value="order-intake"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Order intake
            </TabsTrigger>
            <TabsTrigger
              value="stores"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Store connections
            </TabsTrigger>
            <TabsTrigger
              value="listing-pushes"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Listing pushes
            </TabsTrigger>
            <TabsTrigger
              value="tracking-pushes"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Tracking pushes
            </TabsTrigger>
            <TabsTrigger
              value="notifications"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Notifications
            </TabsTrigger>
            <TabsTrigger
              value="returns"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Returns
            </TabsTrigger>
            <TabsTrigger
              value="audit"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Audit events
            </TabsTrigger>
          </TabsList>

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
            <DogfoodReadinessTab />
          </TabsContent>

          <TabsContent value="catalog" className="m-0">
            <CatalogExposureTab />
          </TabsContent>

          <TabsContent value="shipping" className="m-0">
            <ShippingConfigTab />
          </TabsContent>

          <TabsContent value="order-intake" className="m-0">
            <OrderIntakeOpsTab />
          </TabsContent>

          <TabsContent value="stores" className="m-0">
            <StoreConnectionOpsTab />
          </TabsContent>

          <TabsContent value="listing-pushes" className="m-0">
            <ListingPushOpsTab />
          </TabsContent>

          <TabsContent value="tracking-pushes" className="m-0">
            <TrackingPushOpsTab />
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

function DogfoodReadinessTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<DogfoodReadinessStatusFilter>("all");
  const [platform, setPlatform] = useState<StoreConnectionPlatformFilter>("all");
  const [selectedOmsChannelId, setSelectedOmsChannelId] = useState("");
  const [omsMessage, setOmsMessage] = useState("");
  const [omsError, setOmsError] = useState("");
  const [isSavingOmsChannel, setIsSavingOmsChannel] = useState(false);
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

  const readinessQuery = useQuery<DropshipDogfoodReadinessResponse>({
    queryKey: [readinessUrl],
    queryFn: () => fetchJson<DropshipDogfoodReadinessResponse>(readinessUrl),
  });
  const omsChannelConfigUrl = buildAdminOmsChannelConfigUrl();
  const omsChannelConfigQuery = useQuery<DropshipAdminOmsChannelConfigResponse>({
    queryKey: [omsChannelConfigUrl],
    queryFn: () => fetchJson<DropshipAdminOmsChannelConfigResponse>(omsChannelConfigUrl),
  });

  const items = readinessQuery.data?.items ?? [];
  const summary = readinessQuery.data?.summary ?? [];
  const systemChecks = readinessQuery.data?.systemChecks ?? [];
  const omsConfig = omsChannelConfigQuery.data?.config ?? null;

  useEffect(() => {
    if (!omsConfig || selectedOmsChannelId) return;
    const defaultChannelId = omsConfig.currentChannelId
      ?? omsConfig.channels.find((channel) => channel.status === "active")?.channelId
      ?? null;
    if (defaultChannelId !== null) {
      setSelectedOmsChannelId(String(defaultChannelId));
    }
  }, [omsConfig, selectedOmsChannelId]);

  function applyReadinessFilters() {
    setAppliedFilters({ search, status, platform });
  }

  async function saveOmsChannel() {
    setIsSavingOmsChannel(true);
    setOmsError("");
    setOmsMessage("");
    try {
      const input = buildAdminOmsChannelConfigureInput({
        channelId: selectedOmsChannelId,
        idempotencyKey: createDropshipIdempotencyKey("admin-oms-channel"),
      });
      const response = await putJson<DropshipAdminOmsChannelConfigureResponse>(
        omsChannelConfigUrl,
        input,
      );
      setSelectedOmsChannelId(String(response.selectedChannel.channelId));
      setOmsMessage(`Internal Dropship OMS channel set to ${response.selectedChannel.name}.`);
      await Promise.all([
        omsChannelConfigQuery.refetch(),
        readinessQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setOmsError(caught instanceof Error ? caught.message : "Dropship OMS channel save failed.");
    } finally {
      setIsSavingOmsChannel(false);
    }
  }

  return (
    <div className="space-y-5">
      {(readinessQuery.error || omsChannelConfigQuery.error || omsError) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {omsError || queryErrorMessage(
              readinessQuery.error ?? omsChannelConfigQuery.error,
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

      <OmsChannelConfigPanel
        config={omsConfig}
        isLoading={omsChannelConfigQuery.isLoading || omsChannelConfigQuery.isFetching}
        isSaving={isSavingOmsChannel}
        selectedChannelId={selectedOmsChannelId}
        onSave={saveOmsChannel}
        onSelectChannel={setSelectedOmsChannelId}
      />

      <SystemReadinessPanel
        checks={systemChecks}
        isLoading={readinessQuery.isLoading || readinessQuery.isFetching}
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

function ListingPushOpsTab() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ListingPushStatusFilter>("default");
  const [platform, setPlatform] = useState<StoreConnectionPlatformFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as ListingPushStatusFilter,
    platform: "all" as StoreConnectionPlatformFilter,
  });

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

  function applyListingPushFilters() {
    setAppliedFilters({ search, status, platform });
  }

  return (
    <div className="space-y-5">
      {listingPushJobsQuery.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {queryErrorMessage(listingPushJobsQuery.error, "Unable to load dropship listing push jobs.")}
          </AlertDescription>
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
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<RefreshCw className="h-4 w-4" />} label="Matching jobs" value={String(listingPushJobsQuery.data?.total ?? 0)} />
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Visible failed jobs" value={String(jobs.filter((job) => job.status === "failed").length)} />
        <CatalogMetric icon={<Boxes className="h-4 w-4" />} label="Visible blocked items" value={String(jobs.reduce((sum, job) => sum + job.itemSummary.blocked, 0))} />
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Visible completed items" value={String(jobs.reduce((sum, job) => sum + job.itemSummary.completed, 0))} />
      </section>

      <ListingPushJobsTable
        isLoading={listingPushJobsQuery.isLoading || listingPushJobsQuery.isFetching}
        jobs={jobs}
        summary={listingPushJobsQuery.data?.summary ?? []}
        total={listingPushJobsQuery.data?.total ?? 0}
      />
    </div>
  );
}

function TrackingPushOpsTab() {
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
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Visible failed" value={String(pushes.filter((push) => push.status === "failed").length)} />
        <CatalogMetric icon={<RefreshCw className="h-4 w-4" />} label="Visible attempts" value={String(pushes.reduce((sum, push) => sum + push.attemptCount, 0))} />
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Visible succeeded" value={String(pushes.filter((push) => push.status === "succeeded").length)} />
      </section>

      <TrackingPushesTable
        isLoading={trackingPushesQuery.isLoading || trackingPushesQuery.isFetching}
        onRetry={retryTrackingPush}
        pendingRetryPushId={pendingRetryPushId}
        pushes={pushes}
        summary={trackingPushesQuery.data?.summary ?? []}
        total={trackingPushesQuery.data?.total ?? 0}
      />
    </div>
  );
}

function NotificationOpsTab() {
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

  function applyNotificationFilters() {
    setAppliedFilters({ search, status, channel, critical });
  }

  return (
    <div className="space-y-5">
      {notificationEventsQuery.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {queryErrorMessage(notificationEventsQuery.error, "Unable to load dropship notification events.")}
          </AlertDescription>
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
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<Bell className="h-4 w-4" />} label="Matching events" value={String(notificationEventsQuery.data?.total ?? 0)} />
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Visible failed" value={String(events.filter((event) => event.status === "failed").length)} />
        <CatalogMetric icon={<RefreshCw className="h-4 w-4" />} label="Visible pending" value={String(events.filter((event) => event.status === "pending").length)} />
        <CatalogMetric icon={<ShieldAlert className="h-4 w-4" />} label="Critical visible" value={String(events.filter((event) => event.critical).length)} />
      </section>

      <NotificationEventsTable
        channelSummary={notificationEventsQuery.data?.channelSummary ?? []}
        events={events}
        isLoading={notificationEventsQuery.isLoading || notificationEventsQuery.isFetching}
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
  const [creatingRma, setCreatingRma] = useState(false);
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

  const returnsQuery = useQuery<DropshipReturnListResponse>({
    queryKey: [returnsUrl],
    queryFn: () => fetchJson<DropshipReturnListResponse>(returnsUrl),
  });
  const returnDetailQuery = useQuery<DropshipReturnDetailResponse>({
    queryKey: ["dropship-admin-return-detail", selectedInspectionRmaId],
    queryFn: () => {
      if (selectedInspectionRmaId === null) throw new Error("Missing selected RMA.");
      return fetchJson<DropshipReturnDetailResponse>(`/api/dropship/admin/returns/${selectedInspectionRmaId}`);
    },
    enabled: selectedInspectionRmaId !== null,
  });

  const rmas = returnsQuery.data?.items ?? [];

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
      {(returnsQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || queryErrorMessage(returnsQuery.error, "Unable to load dropship returns.")}
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

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<RotateCcw className="h-4 w-4" />} label="Matching RMAs" value={String(returnsQuery.data?.total ?? 0)} />
        <CatalogMetric icon={<ShieldAlert className="h-4 w-4" />} label="Visible open" value={String(rmas.filter((rma) => !returnOpsTerminalStatuses.has(rma.status)).length)} />
        <CatalogMetric icon={<FileSearch className="h-4 w-4" />} label="Awaiting inspection" value={String(rmas.filter((rma) => rma.status === "received" || rma.status === "inspecting").length)} />
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Visible credited" value={String(rmas.filter((rma) => rma.status === "credited").length)} />
      </section>

      <ReturnCreatePanel
        form={createForm}
        isSaving={creatingRma}
        onAddItem={addCreateItem}
        onChange={updateCreateForm}
        onItemChange={updateCreateItem}
        onRemoveItem={removeCreateItem}
        onSubmit={createReturn}
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
  const [warehouseInputs, setWarehouseInputs] = useState<Record<number, string>>({});
  const [listingConfigForm, setListingConfigForm] = useState<ListingConfigFormState | null>(null);
  const [loadingListingConfigId, setLoadingListingConfigId] = useState<number | null>(null);
  const [savingListingConfigId, setSavingListingConfigId] = useState<number | null>(null);
  const [savingConnectionId, setSavingConnectionId] = useState<number | null>(null);
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
  const attentionCount = connections.filter((connection) => storeConnectionNeedsAttention(connection)).length;
  const listingConfigActiveCount = connections.filter((connection) => connection.listingConfig.isActive).length;
  const selectedListingConfigConnection = connections.find(
    (connection) => connection.storeConnectionId === listingConfigForm?.storeConnectionId,
  ) ?? null;

  useEffect(() => {
    setWarehouseInputs((current) => {
      const next = { ...current };
      for (const connection of connections) {
        if (next[connection.storeConnectionId] === undefined) {
          next[connection.storeConnectionId] = connection.orderProcessingConfig.defaultWarehouseId === null
            ? ""
            : String(connection.orderProcessingConfig.defaultWarehouseId);
        }
      }
      return next;
    });
  }, [connections]);

  function applyStoreFilters() {
    setAppliedFilters({ search, status, platform });
  }

  async function saveWarehouseConfig(connection: DropshipAdminStoreConnectionListItem) {
    setSavingConnectionId(connection.storeConnectionId);
    setError("");
    setMessage("");
    try {
      const input = buildStoreOrderProcessingConfigInput({
        defaultWarehouseId: warehouseInputs[connection.storeConnectionId] ?? "",
        idempotencyKey: createDropshipIdempotencyKey(`admin-store-${connection.storeConnectionId}-warehouse`),
      });
      const response = await putJson<DropshipStoreOrderProcessingConfigResponse>(
        `/api/dropship/admin/store-connections/${connection.storeConnectionId}/order-processing-config`,
        input,
      );
      setMessage(`Store connection ${response.connection.storeConnectionId} warehouse config saved.`);
      await Promise.all([
        storeConnectionsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Store connection config update failed.");
    } finally {
      setSavingConnectionId(null);
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

  async function editListingConfig(connection: DropshipAdminStoreConnectionListItem) {
    setLoadingListingConfigId(connection.storeConnectionId);
    setError("");
    setMessage("");
    try {
      const response = await fetchJson<DropshipStoreListingConfigResponse>(
        `/api/dropship/admin/store-connections/${connection.storeConnectionId}/listing-config`,
      );
      setListingConfigForm(listingConfigResponseToForm(response));
      await storeConnectionsQuery.refetch();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load listing config.");
    } finally {
      setLoadingListingConfigId(null);
    }
  }

  async function saveListingConfig() {
    if (!listingConfigForm) return;
    setSavingListingConfigId(listingConfigForm.storeConnectionId);
    setError("");
    setMessage("");
    try {
      const input = buildStoreListingConfigInput(listingConfigForm);
      const response = await putJson<DropshipStoreListingConfigResponse>(
        `/api/dropship/admin/store-connections/${listingConfigForm.storeConnectionId}/listing-config`,
        input,
      );
      setListingConfigForm(listingConfigResponseToForm(response));
      setMessage(`Store connection ${response.storeConnection.storeConnectionId} listing config saved.`);
      await Promise.all([
        storeConnectionsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/dogfood-readiness"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/ops/overview"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/admin/audit-events"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Listing config update failed.");
    } finally {
      setSavingListingConfigId(null);
    }
  }

  function updateListingConfigForm(patch: Partial<ListingConfigFormState>) {
    setListingConfigForm((current) => current ? { ...current, ...patch } : current);
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
            <h2 className="text-lg font-semibold">Store connection health</h2>
            <p className="text-sm text-muted-foreground">
              Review connected vendor stores, token health, setup checks, sync recency, and order-processing warehouse config.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Vendor, store, domain, or member"
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
        <CatalogMetric icon={<Store className="h-4 w-4" />} label="Matching connections" value={String(storeConnectionsQuery.data?.total ?? 0)} />
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Visible needing attention" value={String(attentionCount)} />
        <CatalogMetric icon={<RefreshCw className="h-4 w-4" />} label="Connected visible" value={String(connections.filter((connection) => connection.status === "connected").length)} />
        <CatalogMetric icon={<Truck className="h-4 w-4" />} label="Warehouse configured" value={String(connections.filter((connection) => connection.orderProcessingConfig.defaultWarehouseId !== null).length)} />
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Listing config active" value={String(listingConfigActiveCount)} />
      </section>

      {listingConfigForm && selectedListingConfigConnection && (
        <ListingConfigEditorPanel
          connection={selectedListingConfigConnection}
          form={listingConfigForm}
          isSaving={savingListingConfigId === listingConfigForm.storeConnectionId}
          onCancel={() => setListingConfigForm(null)}
          onChange={updateListingConfigForm}
          onSave={saveListingConfig}
        />
      )}

      <StoreConnectionsTable
        connections={connections}
        isLoading={storeConnectionsQuery.isLoading || storeConnectionsQuery.isFetching}
        loadingListingConfigId={loadingListingConfigId}
        onEditListingConfig={editListingConfig}
        onRepairShopifyWebhooks={repairShopifyWebhooks}
        savingConnectionId={savingConnectionId}
        repairingWebhookConnectionId={repairingWebhookConnectionId}
        total={storeConnectionsQuery.data?.total ?? 0}
        warehouseInputs={warehouseInputs}
        onSaveWarehouseConfig={saveWarehouseConfig}
        onWarehouseInputChange={(storeConnectionId, value) => setWarehouseInputs((current) => ({
          ...current,
          [storeConnectionId]: value,
        }))}
      />
    </div>
  );
}

function ListingConfigEditorPanel({
  connection,
  form,
  isSaving,
  onCancel,
  onChange,
  onSave,
}: {
  connection: DropshipAdminStoreConnectionListItem;
  form: ListingConfigFormState;
  isSaving: boolean;
  onCancel: () => void;
  onChange: (patch: Partial<ListingConfigFormState>) => void;
  onSave: () => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 border-b pb-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="font-semibold">Listing config</h3>
          <div className="text-sm text-muted-foreground">
            {connection.externalDisplayName || connection.shopDomain || formatStatus(connection.platform)}
            {" / "}
            {connection.vendor.businessName || connection.vendor.email || `Vendor ${connection.vendor.vendorId}`}
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="button" size="sm" className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={onSave} disabled={isSaving}>
            <Save className={isSaving ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {isSaving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-4">
        <ListingConfigSelect
          label="Listing mode"
          value={form.listingMode}
          options={allDropshipListingModes}
          onChange={(value) => onChange({ listingMode: value as DropshipListingMode })}
        />
        <ListingConfigSelect
          label="Inventory mode"
          value={form.inventoryMode}
          options={allDropshipListingInventoryModes}
          onChange={(value) => onChange({ inventoryMode: value as DropshipListingInventoryMode })}
        />
        <ListingConfigSelect
          label="Price mode"
          value={form.priceMode}
          options={allDropshipListingPriceModes}
          onChange={(value) => onChange({ priceMode: value as DropshipListingPriceMode })}
        />
        <div>
          <label className="text-sm font-medium">Status</label>
          <Select value={form.isActive ? "active" : "inactive"} onValueChange={(value) => onChange({ isActive: value === "active" })}>
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <label className="text-sm font-medium" htmlFor="dropship-listing-required-config-keys">
            Required config keys
          </label>
          <Input
            id="dropship-listing-required-config-keys"
            value={form.requiredConfigKeys}
            onChange={(event) => onChange({ requiredConfigKeys: event.target.value })}
            className="mt-2"
            placeholder="marketplaceId, categoryId"
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="dropship-listing-required-product-fields">
            Required product fields
          </label>
          <Input
            id="dropship-listing-required-product-fields"
            value={form.requiredProductFields}
            onChange={(event) => onChange({ requiredProductFields: event.target.value })}
            className="mt-2"
            placeholder={allDropshipListingRequiredProductFields.slice(0, 4).join(", ")}
          />
        </div>
      </div>

      <div className="mt-4">
        <label className="text-sm font-medium" htmlFor="dropship-listing-marketplace-config">
          Marketplace config JSON
        </label>
        <Textarea
          id="dropship-listing-marketplace-config"
          value={form.marketplaceConfigJson}
          onChange={(event) => onChange({ marketplaceConfigJson: event.target.value })}
          className="mt-2 min-h-44 font-mono text-xs"
          spellCheck={false}
        />
      </div>
    </section>
  );
}

function ListingConfigSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="mt-2">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {formatStatus(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function OrderIntakeOpsTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<OrderOpsStatusFilter>("default");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as OrderOpsStatusFilter,
  });
  const [actionReason, setActionReason] = useState("");
  const [pendingAction, setPendingAction] = useState<{
    intakeId: number;
    action: "retry" | "exception" | "process";
  } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const orderIntakeUrl = useMemo(() => buildAdminOrderIntakeUrl({
    search: appliedFilters.search,
    status: appliedFilters.status,
  }), [appliedFilters]);

  const orderIntakeQuery = useQuery<DropshipAdminOrderOpsListResponse>({
    queryKey: [orderIntakeUrl],
    queryFn: () => fetchJson<DropshipAdminOrderOpsListResponse>(orderIntakeUrl),
  });

  function applyOrderFilters() {
    setAppliedFilters({ search, status });
  }

  async function runOrderAction(
    intake: DropshipAdminOrderOpsIntakeListItem,
    action: "retry" | "exception" | "process",
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
      const response = await postJson<DropshipAdminOrderOpsActionResponse | DropshipAdminOrderOpsProcessResponse>(
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
          <div className="flex flex-col gap-2 lg:flex-row">
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

      <OrderIntakeSummary summary={orderIntakeQuery.data?.summary ?? []} total={orderIntakeQuery.data?.total ?? 0} />

      <OrderIntakeOpsTable
        isLoading={orderIntakeQuery.isLoading || orderIntakeQuery.isFetching}
        items={orderIntakeQuery.data?.items ?? []}
        pendingAction={pendingAction}
        total={orderIntakeQuery.data?.total ?? 0}
        onRunAction={runOrderAction}
      />
    </div>
  );
}

function CatalogExposureTab() {
  const [search, setSearch] = useState("");
  const [exposedOnly, setExposedOnly] = useState("false");
  const [includeInactiveCatalog, setIncludeInactiveCatalog] = useState("false");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    exposedOnly: "false",
    includeInactiveCatalog: "false",
  });
  const [draftRules, setDraftRules] = useState<DropshipAdminCatalogExposureRuleInput[]>([]);
  const [loadedRulesKey, setLoadedRulesKey] = useState("");
  const [ruleForm, setRuleForm] = useState<CatalogRuleFormState>(emptyCatalogRuleForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const previewUrl = useMemo(() => buildAdminCatalogExposurePreviewUrl({
    search: appliedFilters.search,
    exposedOnly: appliedFilters.exposedOnly === "true",
    includeInactiveCatalog: appliedFilters.includeInactiveCatalog === "true",
  }), [appliedFilters]);

  const rulesQuery = useQuery<DropshipAdminCatalogExposureRulesResponse>({
    queryKey: ["/api/dropship/admin/catalog/rules"],
    queryFn: () => fetchJson<DropshipAdminCatalogExposureRulesResponse>("/api/dropship/admin/catalog/rules"),
  });
  const previewQuery = useQuery<DropshipAdminCatalogExposurePreviewResponse>({
    queryKey: [previewUrl],
    queryFn: () => fetchJson<DropshipAdminCatalogExposurePreviewResponse>(previewUrl),
  });

  const previewRows = previewQuery.data?.rows ?? [];
  const exposedPreviewCount = previewRows.filter((row) => row.decision.exposed).length;
  const blockedPreviewCount = previewRows.length - exposedPreviewCount;

  useEffect(() => {
    if (!rulesQuery.data) return;
    const activeInputs = rulesQuery.data.rules
      .filter((rule) => rule.isActive !== false)
      .map(catalogExposureRecordToInput);
    const nextRulesKey = activeInputs
      .map((rule) => `${catalogExposureRuleKey(rule)}:${rule.priority}:${rule.notes ?? ""}`)
      .sort()
      .join("|");
    if (nextRulesKey === loadedRulesKey) return;
    setDraftRules(activeInputs);
    setLoadedRulesKey(nextRulesKey);
  }, [loadedRulesKey, rulesQuery.data]);

  function applyCatalogFilters() {
    setAppliedFilters({ search, exposedOnly, includeInactiveCatalog });
  }

  function addRuleFromForm() {
    try {
      upsertDraftRule(buildCatalogExposureRuleInput(ruleForm));
      setMessage("Catalog exposure rule added to draft.");
      setError("");
    } catch (caught) {
      setMessage("");
      setError(caught instanceof Error ? caught.message : "Catalog exposure rule is invalid.");
    }
  }

  function addVariantRule(row: DropshipAdminCatalogExposurePreviewRow, action: CatalogExposureActionFilter) {
    const rule = buildCatalogExposureRuleInput({
      scopeType: "variant",
      action,
      productVariantId: row.productVariantId,
      priority: action === "include" ? 100 : 200,
      notes: `${action === "include" ? "Include" : "Exclude"} ${row.variantSku || `variant ${row.productVariantId}`}`,
    });
    upsertDraftRule(rule);
    setMessage(`${action === "include" ? "Include" : "Exclude"} variant rule added to draft.`);
    setError("");
  }

  function upsertDraftRule(rule: DropshipAdminCatalogExposureRuleInput) {
    const ruleKey = catalogExposureRuleKey(rule);
    setDraftRules((current) => [
      ...current.filter((existing) => catalogExposureRuleKey(existing) !== ruleKey),
      rule,
    ]);
  }

  function removeDraftRule(rule: DropshipAdminCatalogExposureRuleInput) {
    const ruleKey = catalogExposureRuleKey(rule);
    setDraftRules((current) => current.filter((existing) => catalogExposureRuleKey(existing) !== ruleKey));
  }

  async function saveDraftRules() {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await putJson<DropshipAdminCatalogExposureRulesReplaceResponse>(
        "/api/dropship/admin/catalog/rules",
        {
          idempotencyKey: createDropshipIdempotencyKey("admin-catalog-exposure"),
          rules: draftRules,
        },
      );
      setMessage(`Catalog exposure rules saved as revision ${result.revisionId}.`);
      await Promise.all([rulesQuery.refetch(), previewQuery.refetch()]);
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

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<Boxes className="h-4 w-4" />} label="Active rules" value={String(rulesQuery.data?.rules.length ?? 0)} />
        <CatalogMetric icon={<FileSearch className="h-4 w-4" />} label="Draft rules" value={String(draftRules.length)} />
        <CatalogMetric icon={<CheckCircle2 className="h-4 w-4" />} label="Exposed preview rows" value={String(exposedPreviewCount)} />
        <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Blocked preview rows" value={String(blockedPreviewCount)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
        <section className="rounded-md border bg-card p-4">
          <div>
            <h2 className="text-lg font-semibold">Rule draft</h2>
            <p className="text-sm text-muted-foreground">Define the catalog Card Shellz makes available to dropship vendors.</p>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
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
                  <SelectItem value="include">Include</SelectItem>
                  <SelectItem value="exclude">Exclude</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <CatalogRuleTargetInput ruleForm={ruleForm} setRuleForm={setRuleForm} />

            <div>
              <label className="text-sm font-medium" htmlFor="dropship-catalog-rule-priority">Priority</label>
              <Input
                id="dropship-catalog-rule-priority"
                className="mt-2"
                value={ruleForm.priority}
                onChange={(event) => setRuleForm((current) => ({ ...current, priority: event.target.value }))}
              />
            </div>
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

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="gap-2" onClick={addRuleFromForm}>
              <PlusCircle className="h-4 w-4" />
              Add draft rule
            </Button>
            <Button type="button" variant="outline" onClick={() => setRuleForm(emptyCatalogRuleForm)}>
              Reset form
            </Button>
            <Button type="button" className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={saving} onClick={saveDraftRules}>
              <Save className="h-4 w-4" />
              {saving ? "Saving" : "Save rules"}
            </Button>
          </div>
        </section>

        <CatalogDraftRulesTable
          rules={draftRules}
          isLoading={rulesQuery.isLoading}
          onRemoveRule={removeDraftRule}
        />
      </div>

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
            <Select value={exposedOnly} onValueChange={setExposedOnly}>
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="false">All rows</SelectItem>
                <SelectItem value="true">Exposed only</SelectItem>
              </SelectContent>
            </Select>
            <Select value={includeInactiveCatalog} onValueChange={setIncludeInactiveCatalog}>
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="false">Active only</SelectItem>
                <SelectItem value="true">Include inactive</SelectItem>
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
          rows={previewRows}
          total={previewQuery.data?.total ?? 0}
          onAddVariantRule={addVariantRule}
        />
      </section>
    </div>
  );
}

function ShippingConfigTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [boxForm, setBoxForm] = useState<ShippingBoxFormState>(emptyShippingBoxForm);
  const [profileForm, setProfileForm] = useState<ShippingPackageProfileFormState>(emptyShippingPackageProfileForm);
  const [zoneForm, setZoneForm] = useState<ShippingZoneRuleFormState>(emptyShippingZoneRuleForm);
  const [rateForm, setRateForm] = useState<ShippingRateTableFormState>(emptyShippingRateTableForm);
  const [markupForm, setMarkupForm] = useState<ShippingMarkupPolicyFormState>(emptyShippingMarkupPolicyForm);
  const [insuranceForm, setInsuranceForm] = useState<ShippingInsurancePolicyFormState>(emptyShippingInsurancePolicyForm);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const shippingConfigUrl = useMemo(
    () => buildAdminShippingConfigUrl({ search: appliedSearch, packageProfileLimit: 75, rateTableLimit: 25 }),
    [appliedSearch],
  );
  const shippingQuery = useQuery<DropshipAdminShippingConfigResponse>({
    queryKey: [shippingConfigUrl],
    queryFn: () => fetchJson<DropshipAdminShippingConfigResponse>(shippingConfigUrl),
  });
  const config = shippingQuery.data?.config;

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

  function applySearch() {
    setAppliedSearch(search.trim());
  }

  async function saveBox() {
    await runShippingAction("box", async () => {
      await putJson("/api/dropship/admin/shipping/boxes", buildShippingBoxInput({
        ...boxForm,
        idempotencyKey: createDropshipIdempotencyKey("shipping-box"),
      }));
      setBoxForm(emptyShippingBoxForm);
      setMessage("Box saved.");
    });
  }

  async function savePackageProfile() {
    await runShippingAction("profile", async () => {
      await putJson("/api/dropship/admin/shipping/package-profiles", buildShippingPackageProfileInput({
        ...profileForm,
        idempotencyKey: createDropshipIdempotencyKey("shipping-package-profile"),
      }));
      setProfileForm(emptyShippingPackageProfileForm);
      setMessage("Package profile saved.");
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
      {(shippingQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error || queryErrorMessage(shippingQuery.error, "Unable to load dropship shipping config.")}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric icon={<Boxes className="h-4 w-4" />} label="Active boxes" value={String(activeCount(config?.boxes))} />
        <CatalogMetric icon={<Truck className="h-4 w-4" />} label="Package profiles" value={String(config?.packageProfiles.length ?? 0)} />
        <CatalogMetric icon={<FileSearch className="h-4 w-4" />} label="Zone rules" value={String(activeCount(config?.zoneRules))} />
        <CatalogMetric icon={<Wallet className="h-4 w-4" />} label="Active rate tables" value={String(activeRateTableCount(config))} />
      </section>

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">Shipping configuration</h2>
            <p className="text-sm text-muted-foreground">Manage package data, zones, cached rates, markup, and insurance pool fees used by dropship quotes.</p>
          </div>
          <Input
            className="lg:w-72"
            placeholder="Search package profiles"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applySearch}>
            <Search className="h-4 w-4" />
            Apply
          </Button>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-2">
        <ShippingBoxPanel
          form={boxForm}
          isSaving={pendingAction === "box"}
          onChange={setBoxForm}
          onSave={saveBox}
        />
        <ShippingPackageProfilePanel
          boxes={config?.boxes ?? []}
          form={profileForm}
          isSaving={pendingAction === "profile"}
          onChange={setProfileForm}
          onSave={savePackageProfile}
        />
        <ShippingZoneRulePanel
          form={zoneForm}
          isSaving={pendingAction === "zone"}
          onChange={setZoneForm}
          onSave={saveZoneRule}
        />
        <ShippingRateTablePanel
          form={rateForm}
          isSaving={pendingAction === "rate"}
          onChange={setRateForm}
          onSave={saveRateTable}
        />
        <ShippingMarkupPolicyPanel
          activePolicy={config?.activeMarkupPolicy ?? null}
          form={markupForm}
          isSaving={pendingAction === "markup"}
          onChange={setMarkupForm}
          onSave={saveMarkupPolicy}
        />
        <ShippingInsurancePolicyPanel
          activePolicy={config?.activeInsurancePolicy ?? null}
          form={insuranceForm}
          isSaving={pendingAction === "insurance"}
          onChange={setInsuranceForm}
          onSave={saveInsurancePolicy}
        />
      </div>

      <ShippingConfigTables config={config ?? null} isLoading={shippingQuery.isLoading} />
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
        <ShippingInput label="Length mm" value={form.lengthMm} onChange={(value) => onChange((current) => ({ ...current, lengthMm: value }))} />
        <ShippingInput label="Width mm" value={form.widthMm} onChange={(value) => onChange((current) => ({ ...current, widthMm: value }))} />
        <ShippingInput label="Height mm" value={form.heightMm} onChange={(value) => onChange((current) => ({ ...current, heightMm: value }))} />
        <ShippingInput label="Tare grams" value={form.tareWeightGrams} onChange={(value) => onChange((current) => ({ ...current, tareWeightGrams: value }))} />
        <ShippingInput label="Max weight grams" value={form.maxWeightGrams} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, maxWeightGrams: value }))} />
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
}: {
  boxes: DropshipShippingConfigOverview["boxes"];
  form: ShippingPackageProfileFormState;
  isSaving: boolean;
  onChange: Dispatch<SetStateAction<ShippingPackageProfileFormState>>;
  onSave: () => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <PanelHeader title="Package profiles" detail="SKU-level weight, dimensions, and default package rules." />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ShippingInput label="Variant ID" value={form.productVariantId} onChange={(value) => onChange((current) => ({ ...current, productVariantId: value }))} />
        <ShippingInput label="Weight grams" value={form.weightGrams} onChange={(value) => onChange((current) => ({ ...current, weightGrams: value }))} />
        <ShippingInput label="Length mm" value={form.lengthMm} onChange={(value) => onChange((current) => ({ ...current, lengthMm: value }))} />
        <ShippingInput label="Width mm" value={form.widthMm} onChange={(value) => onChange((current) => ({ ...current, widthMm: value }))} />
        <ShippingInput label="Height mm" value={form.heightMm} onChange={(value) => onChange((current) => ({ ...current, heightMm: value }))} />
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
        Save profile
      </Button>
    </section>
  );
}

function ShippingZoneRulePanel({
  form,
  isSaving,
  onChange,
  onSave,
}: {
  form: ShippingZoneRuleFormState;
  isSaving: boolean;
  onChange: Dispatch<SetStateAction<ShippingZoneRuleFormState>>;
  onSave: () => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <PanelHeader title="Zones" detail="Origin warehouse and destination matching for cached rate lookups." />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ShippingInput label="Origin warehouse ID" value={form.originWarehouseId} onChange={(value) => onChange((current) => ({ ...current, originWarehouseId: value }))} />
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
}: {
  form: ShippingRateTableFormState;
  isSaving: boolean;
  onChange: Dispatch<SetStateAction<ShippingRateTableFormState>>;
  onSave: () => void;
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
        <ShippingInput label="Warehouse ID" value={form.warehouseId} placeholder="Optional" onChange={(value) => onChange((current) => ({ ...current, warehouseId: value }))} />
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

function ShippingConfigTables({
  config,
  isLoading,
}: {
  config: DropshipShippingConfigOverview | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (!config) {
    return <EmptyState title="No shipping config" description="Dropship shipping configuration is not loaded." />;
  }
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <ShippingSimpleTable
        title="Boxes"
        emptyTitle="No boxes"
        headers={["Code", "Size", "Weight", "Status"]}
        rows={config.boxes.map((box) => [
          box.code,
          `${box.lengthMm} x ${box.widthMm} x ${box.heightMm} mm`,
          `${box.tareWeightGrams}g tare${box.maxWeightGrams ? ` / ${box.maxWeightGrams}g max` : ""}`,
          box.isActive ? "Active" : "Inactive",
        ])}
      />
      <ShippingSimpleTable
        title="Package profiles"
        emptyTitle="No package profiles"
        headers={["Variant", "Size", "Weight", "Status"]}
        rows={config.packageProfiles.map((profile) => [
          profile.variantSku || String(profile.productVariantId),
          `${profile.lengthMm} x ${profile.widthMm} x ${profile.heightMm} mm`,
          `${profile.weightGrams}g`,
          profile.isActive ? "Active" : "Inactive",
        ])}
      />
      <ShippingSimpleTable
        title="Zones"
        emptyTitle="No zone rules"
        headers={["Warehouse", "Destination", "Zone", "Status"]}
        rows={config.zoneRules.map((rule) => [
          String(rule.originWarehouseId),
          [rule.destinationCountry, rule.destinationRegion, rule.postalPrefix].filter(Boolean).join(" / "),
          rule.zone,
          rule.isActive ? "Active" : "Inactive",
        ])}
      />
      <ShippingSimpleTable
        title="Rate tables"
        emptyTitle="No rate tables"
        headers={["Carrier/service", "Status", "Rows", "Effective"]}
        rows={config.rateTables.map((table) => [
          `${table.carrier} ${table.service}`,
          table.status,
          String(table.rows.length),
          formatDateTime(table.effectiveFrom),
        ])}
      />
    </div>
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

function OmsChannelConfigPanel({
  config,
  isLoading,
  isSaving,
  onSave,
  onSelectChannel,
  selectedChannelId,
}: {
  config: DropshipOmsChannelConfigOverview | null;
  isLoading: boolean;
  isSaving: boolean;
  selectedChannelId: string;
  onSelectChannel: (channelId: string) => void;
  onSave: () => void;
}) {
  if (isLoading && !config) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="mt-4 h-10 w-full max-w-xl" />
      </section>
    );
  }

  const activeChannels = config?.channels.filter((channel) => channel.status === "active") ?? [];
  const markedChannels = config?.channels.filter((channel) => channel.isDropshipOmsChannel) ?? [];
  const currentChannel = config?.channels.find((channel) => channel.channelId === config.currentChannelId) ?? null;
  const selectedChannel = config?.channels.find((channel) => String(channel.channelId) === selectedChannelId) ?? null;
  const hasSelection = selectedChannelId.trim().length > 0;
  const hasAmbiguousConfig = (config?.currentChannelCount ?? 0) > 1;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Internal Dropship OMS channel</h2>
            <Badge variant="outline" className={omsChannelConfigTone(config)}>
              {omsChannelConfigLabel(config)}
            </Badge>
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {currentChannel
              ? `${currentChannel.name} is the active order-intake channel.`
              : hasAmbiguousConfig
                ? `${config?.currentChannelCount ?? 0} active channels are marked. Choose one to remove ambiguity.`
                : "No active Dropship OMS channel is marked."}
          </div>
          {markedChannels.length > 0 && (
            <div className="mt-1 text-xs text-muted-foreground">
              Marked: {markedChannels.map((channel) => `${channel.name} (${formatStatus(channel.status)})`).join(", ")}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 sm:w-80">
            <label className="text-sm font-medium">Channel</label>
            <Select value={selectedChannelId} onValueChange={onSelectChannel} disabled={activeChannels.length === 0}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Select active channel" />
              </SelectTrigger>
              <SelectContent>
                {activeChannels.map((channel) => (
                  <SelectItem key={channel.channelId} value={String(channel.channelId)}>
                    {channel.name} / {formatStatus(channel.provider)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
            disabled={!hasSelection || isSaving || activeChannels.length === 0}
            onClick={onSave}
          >
            <Save className="h-4 w-4" />
            {isSaving ? "Saving" : selectedChannel?.isDropshipOmsChannel ? "Confirm channel" : "Set channel"}
          </Button>
        </div>
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
                  </div>
                  <div className="text-xs text-muted-foreground">
                    OMS {item.metrics.dropshipOmsChannelCount === 1 ? item.metrics.dropshipOmsChannelId : `${item.metrics.dropshipOmsChannelCount} marked`}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">{formatCents(item.metrics.walletAvailableBalanceCents)}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.metrics.activeFundingMethodCount} funding method{item.metrics.activeFundingMethodCount === 1 ? "" : "s"} / Auto reload {item.metrics.autoReloadEnabled ? "on" : "off"}
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
  summary,
  total,
}: {
  isLoading: boolean;
  jobs: DropshipAdminListingPushJobListItem[];
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
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
            </TableRow>
          ))}
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
  summary,
  total,
}: {
  isLoading: boolean;
  onRetry: (push: DropshipAdminTrackingPushListItem) => void;
  pendingRetryPushId: number | null;
  pushes: DropshipAdminTrackingPushListItem[];
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
          {pushes.map((push) => (
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
                  disabled={push.status !== "failed" || !push.retryable || pendingRetryPushId !== null}
                  onClick={() => onRetry(push)}
                >
                  <RotateCcw className={pendingRetryPushId === push.pushId ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                  Retry
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function NotificationEventsTable({
  channelSummary,
  events,
  isLoading,
  summary,
  total,
}: {
  channelSummary: DropshipAdminNotificationOpsListResponse["channelSummary"];
  events: DropshipAdminNotificationOpsListItem[];
  isLoading: boolean;
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
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
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function ReturnCreatePanel({
  form,
  isSaving,
  onAddItem,
  onChange,
  onItemChange,
  onRemoveItem,
  onSubmit,
}: {
  form: ReturnCreateFormState;
  isSaving: boolean;
  onAddItem: () => void;
  onChange: (patch: Partial<ReturnCreateFormState>) => void;
  onItemChange: (index: number, patch: Partial<ReturnCreateItemFormState>) => void;
  onRemoveItem: (index: number) => void;
  onSubmit: () => void;
}) {
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
          <AdminReturnInput
            label="Vendor ID"
            value={form.vendorId}
            disabled={isSaving}
            onChange={(value) => onChange({ vendorId: value })}
          />
          <AdminReturnInput
            label="RMA number"
            value={form.rmaNumber}
            disabled={isSaving}
            onChange={(value) => onChange({ rmaNumber: value })}
          />
          <AdminReturnInput
            label="Store connection ID"
            value={form.storeConnectionId}
            placeholder="Optional"
            disabled={isSaving}
            onChange={(value) => onChange({ storeConnectionId: value })}
          />
          <AdminReturnInput
            label="Intake ID"
            value={form.intakeId}
            placeholder="Optional"
            disabled={isSaving}
            onChange={(value) => onChange({ intakeId: value })}
          />
          <AdminReturnInput
            label="OMS order ID"
            value={form.omsOrderId}
            placeholder="Optional"
            disabled={isSaving}
            onChange={(value) => onChange({ omsOrderId: value })}
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
                      <Input
                        value={item.productVariantId}
                        placeholder="Optional"
                        disabled={isSaving}
                        onChange={(event) => onItemChange(index, { productVariantId: event.target.value })}
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
  isLoading,
  loadingListingConfigId,
  onEditListingConfig,
  onRepairShopifyWebhooks,
  onSaveWarehouseConfig,
  onWarehouseInputChange,
  repairingWebhookConnectionId,
  savingConnectionId,
  total,
  warehouseInputs,
}: {
  connections: DropshipAdminStoreConnectionListItem[];
  isLoading: boolean;
  loadingListingConfigId: number | null;
  onEditListingConfig: (connection: DropshipAdminStoreConnectionListItem) => void;
  onRepairShopifyWebhooks: (connection: DropshipAdminStoreConnectionListItem) => void;
  onSaveWarehouseConfig: (connection: DropshipAdminStoreConnectionListItem) => void;
  onWarehouseInputChange: (storeConnectionId: number, value: string) => void;
  repairingWebhookConnectionId: number | null;
  savingConnectionId: number | null;
  total: number;
  warehouseInputs: Record<number, string>;
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
            <TableHead>Vendor</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>Sync</TableHead>
            <TableHead>Setup checks</TableHead>
            <TableHead className="w-[230px]">Listing config</TableHead>
            <TableHead className="w-[260px]">Default warehouse</TableHead>
            <TableHead className="w-[190px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => {
            const canRepairShopifyWebhooks = connection.platform === "shopify" && connection.status === "connected";
            return (
              <TableRow key={connection.storeConnectionId}>
                <TableCell>
                  <div className="font-medium">
                    {connection.externalDisplayName || connection.shopDomain || formatStatus(connection.platform)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatStatus(connection.platform)} connection {connection.storeConnectionId}
                  </div>
                  {connection.externalAccountId && (
                    <div className="max-w-[220px] truncate text-xs text-muted-foreground">{connection.externalAccountId}</div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="font-medium">{connection.vendor.businessName || connection.vendor.email || `Vendor ${connection.vendor.vendorId}`}</div>
                  <div className="text-xs text-muted-foreground">{connection.vendor.memberId}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={storeConnectionStatusTone(connection.status)}>
                    {formatStatus(connection.status)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">Setup {formatStatus(connection.setupStatus)}</div>
                  {connection.disconnectReason && (
                    <div className="mt-1 max-w-[200px] truncate text-xs text-muted-foreground">{connection.disconnectReason}</div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="outline" className={connection.hasAccessToken ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}>
                      Access
                    </Badge>
                    <Badge variant="outline" className={connection.hasRefreshToken ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-zinc-200 bg-zinc-50 text-zinc-600"}>
                      Refresh
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">Expires {formatDateTime(connection.tokenExpiresAt)}</div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">Orders {formatDateTime(connection.lastOrderSyncAt)}</div>
                  <div className="text-xs text-muted-foreground">Inventory {formatDateTime(connection.lastInventorySyncAt)}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={connection.setupCheckSummary.errorCount > 0
                    ? "border-rose-200 bg-rose-50 text-rose-800"
                    : connection.setupCheckSummary.warningCount > 0
                      ? "border-amber-200 bg-amber-50 text-amber-900"
                      : "border-zinc-200 bg-zinc-50 text-zinc-700"}
                  >
                    {connection.setupCheckSummary.openCount} open
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {connection.setupCheckSummary.errorCount} error / {connection.setupCheckSummary.warningCount} warning
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={listingConfigSummaryTone(connection)}>
                    {listingConfigSummaryLabel(connection)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {connection.listingConfig.listingMode ? formatStatus(connection.listingConfig.listingMode) : "No mode"}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 h-9 gap-2"
                    disabled={loadingListingConfigId !== null}
                    onClick={() => onEditListingConfig(connection)}
                  >
                    <FileSearch className={loadingListingConfigId === connection.storeConnectionId ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    {loadingListingConfigId === connection.storeConnectionId ? "Loading" : "Edit"}
                  </Button>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={warehouseInputs[connection.storeConnectionId] ?? ""}
                      onChange={(event) => onWarehouseInputChange(connection.storeConnectionId, event.target.value)}
                      placeholder="Warehouse ID"
                      className="h-9"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-2"
                      disabled={savingConnectionId !== null}
                      onClick={() => onSaveWarehouseConfig(connection)}
                    >
                      <Save className="h-4 w-4" />
                      {savingConnectionId === connection.storeConnectionId ? "Saving" : "Save"}
                    </Button>
                  </div>
                </TableCell>
                <TableCell>
                  {canRepairShopifyWebhooks ? (
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
                  ) : (
                    <span className="text-sm text-muted-foreground">Unavailable</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function OrderIntakeSummary({
  summary,
  total,
}: {
  summary: DropshipAdminOrderOpsListResponse["summary"];
  total: number;
}) {
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <CatalogMetric icon={<ClipboardList className="h-4 w-4" />} label="Matching intakes" value={String(total)} />
      <CatalogMetric icon={<Wallet className="h-4 w-4" />} label="Payment holds" value={String(orderStatusCount(summary, "payment_hold"))} />
      <CatalogMetric icon={<RefreshCw className="h-4 w-4" />} label="Retrying" value={String(orderStatusCount(summary, "retrying"))} />
      <CatalogMetric icon={<AlertCircle className="h-4 w-4" />} label="Failed or exception" value={String(orderStatusCount(summary, "failed") + orderStatusCount(summary, "exception"))} />
    </section>
  );
}

function OrderIntakeOpsTable({
  isLoading,
  items,
  onRunAction,
  pendingAction,
  total,
}: {
  isLoading: boolean;
  items: DropshipAdminOrderOpsIntakeListItem[];
  onRunAction: (intake: DropshipAdminOrderOpsIntakeListItem, action: "retry" | "exception" | "process") => void;
  pendingAction: { intakeId: number; action: "retry" | "exception" | "process" } | null;
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
            <TableHead className="w-[280px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((intake) => (
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
                <div className="flex flex-col gap-2 sm:flex-row">
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
                    disabled={pendingAction !== null}
                    onClick={() => onRunAction(intake, "retry")}
                  >
                    <RefreshCw className={pendingAction?.intakeId === intake.intakeId && pendingAction.action === "retry" ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
                    Retry
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
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function CatalogRuleTargetInput({
  ruleForm,
  setRuleForm,
}: {
  ruleForm: CatalogRuleFormState;
  setRuleForm: Dispatch<SetStateAction<CatalogRuleFormState>>;
}) {
  const config = catalogRuleTargetInputConfig(ruleForm.scopeType);
  if (!config) return null;

  return (
    <div>
      <label className="text-sm font-medium" htmlFor={`dropship-catalog-rule-${config.key}`}>
        {config.label}
      </label>
      <Input
        id={`dropship-catalog-rule-${config.key}`}
        className="mt-2"
        value={ruleForm[config.key]}
        onChange={(event) => setRuleForm((current) => ({ ...current, [config.key]: event.target.value }))}
        placeholder={config.placeholder}
      />
    </div>
  );
}

function CatalogDraftRulesTable({
  isLoading,
  onRemoveRule,
  rules,
}: {
  isLoading: boolean;
  onRemoveRule: (rule: DropshipAdminCatalogExposureRuleInput) => void;
  rules: DropshipAdminCatalogExposureRuleInput[];
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Draft rule set</h2>
          <p className="text-sm text-muted-foreground">Saving replaces the active admin exposure rule set.</p>
        </div>
        <Badge variant="outline">{rules.length} draft</Badge>
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
            <EmptyTitle>No draft rules</EmptyTitle>
            <EmptyDescription>No catalog is exposed until at least one include rule is saved.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mt-4 rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rule</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-[92px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={catalogExposureRuleKey(rule)}>
                  <TableCell>
                    <Badge variant="outline" className={catalogExposureActionTone(rule.action)}>
                      {formatStatus(rule.action)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{formatStatus(rule.scopeType)}</div>
                    <div className="text-xs text-muted-foreground">{catalogRuleTargetLabel(rule)}</div>
                  </TableCell>
                  <TableCell className="font-mono">{rule.priority}</TableCell>
                  <TableCell className="max-w-[260px] truncate text-sm text-muted-foreground">{rule.notes || "None"}</TableCell>
                  <TableCell>
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
  onAddVariantRule,
  rows,
  total,
}: {
  isLoading: boolean;
  onAddVariantRule: (row: DropshipAdminCatalogExposurePreviewRow, action: CatalogExposureActionFilter) => void;
  rows: DropshipAdminCatalogExposurePreviewRow[];
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

  return (
    <div className="mt-4 rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm text-muted-foreground">
        <span>{total} row{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Catalog row</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Decision</TableHead>
            <TableHead className="w-[220px]">Draft variant rule</TableHead>
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
                  {row.decision.exposed ? "Exposed" : "Blocked"}
                </Badge>
                <div className="mt-1 text-xs text-muted-foreground">{formatStatus(row.decision.reason)}</div>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2"
                    onClick={() => onAddVariantRule(row, "include")}
                  >
                    <PlusCircle className="h-4 w-4" />
                    Include
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2"
                    onClick={() => onAddVariantRule(row, "exclude")}
                  >
                    <MinusCircle className="h-4 w-4" />
                    Exclude
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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

function catalogRuleTargetInputConfig(scopeType: CatalogExposureScopeFilter): {
  key: "productLineId" | "productId" | "productVariantId" | "category";
  label: string;
  placeholder: string;
} | null {
  if (scopeType === "product_line") {
    return { key: "productLineId", label: "Product line ID", placeholder: "123" };
  }
  if (scopeType === "product") {
    return { key: "productId", label: "Product ID", placeholder: "123" };
  }
  if (scopeType === "variant") {
    return { key: "productVariantId", label: "Variant ID", placeholder: "123" };
  }
  if (scopeType === "category") {
    return { key: "category", label: "Category", placeholder: "Sealed wax" };
  }
  return null;
}

function catalogRuleTargetLabel(rule: DropshipAdminCatalogExposureRuleInput): string {
  if (rule.scopeType === "catalog") return "Entire active catalog";
  if (rule.scopeType === "product_line") return `Product line ${rule.productLineId}`;
  if (rule.scopeType === "product") return `Product ${rule.productId}`;
  if (rule.scopeType === "variant") return `Variant ${rule.productVariantId}`;
  return rule.category || "Category";
}

function catalogExposureActionTone(action: CatalogExposureActionFilter): string {
  if (action === "include") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function orderOpsStatusLabel(status: OrderOpsStatusFilter): string {
  if (status === "default") return "Needs attention";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function orderActionMessage(
  response: DropshipAdminOrderOpsActionResponse | DropshipAdminOrderOpsProcessResponse,
  action: "retry" | "exception" | "process",
): string {
  if (action === "process" && "outcome" in response) {
    const suffix = response.failureCode ? ` (${formatStatus(response.failureCode)})` : "";
    return `Order intake ${response.intakeId} processing returned ${formatStatus(response.outcome)}${suffix}.`;
  }
  if ("previousStatus" in response) {
    return `Order intake ${response.intakeId} moved from ${formatStatus(response.previousStatus)} to ${formatStatus(response.status)}.`;
  }
  return `Order intake ${response.intakeId} action completed.`;
}

function orderIntakeCanProcessNow(status: DropshipOpsOrderIntakeStatus): boolean {
  return status === "received" || status === "retrying" || status === "payment_hold";
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

function storeConnectionNeedsAttention(connection: DropshipAdminStoreConnectionListItem): boolean {
  return connection.status !== "connected"
    || connection.setupStatus !== "ready"
    || connection.setupCheckSummary.errorCount > 0
    || connection.setupCheckSummary.warningCount > 0
    || !connection.hasAccessToken
    || !connection.listingConfig.isConfigured
    || !connection.listingConfig.isActive;
}

function listingConfigResponseToForm(response: DropshipStoreListingConfigResponse): ListingConfigFormState {
  return {
    storeConnectionId: response.storeConnection.storeConnectionId,
    listingMode: response.config.listingMode,
    inventoryMode: response.config.inventoryMode,
    priceMode: response.config.priceMode,
    marketplaceConfigJson: JSON.stringify(response.config.marketplaceConfig ?? {}, null, 2),
    requiredConfigKeys: response.config.requiredConfigKeys.join(", "),
    requiredProductFields: response.config.requiredProductFields.join(", "),
    isActive: response.config.isActive,
  };
}

function listingConfigSummaryLabel(connection: DropshipAdminStoreConnectionListItem): string {
  if (!connection.listingConfig.isConfigured) return "Missing";
  if (!connection.listingConfig.isActive) return "Inactive";
  return "Active";
}

function listingConfigSummaryTone(connection: DropshipAdminStoreConnectionListItem): string {
  if (!connection.listingConfig.isConfigured || !connection.listingConfig.isActive) {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
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
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
