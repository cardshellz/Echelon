import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleOff,
  CircleDot,
  Clock3,
  ExternalLink,
  History,
  Inbox,
  Loader2,
  PackageCheck,
  PackagePlus,
  RadioTower,
  RefreshCw,
  Search,
  ServerCog,
  ShieldAlert,
  Truck,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { FinancialCommandOperations } from "@/components/operations/FinancialCommandOperations";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  resolveFlowReplayAction,
  type FlowReplayAction,
} from "@/lib/control-tower-flow-actions";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type Domain = "oms" | "wms" | "shipping" | "inventory" | "procurement";
type Severity = "blocker" | "high" | "medium" | "low";
type TowerView = "attention" | "in_progress" | "waiting" | "resolved";
type FlowIssueStage = "intake" | "oms_to_wms" | "wms_fulfill" | "engine_push" | "shipped" | "writeback" | "other";
type FlowIssueSeverity = "critical" | "warning" | "info";

interface QueueItem {
  id: number;
  domain: Domain;
  code: string;
  entityType: string;
  entityId: string;
  entityRef: string | null;
  title: string;
  summary: string;
  severity: Severity;
  urgency: "overdue" | "due_soon" | "normal" | "deferred";
  impactTags: string[];
  actionability: string;
  sourceStatus: string;
  triageStatus: string;
  ownerTeam: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  recommendedAction: string;
  responseDueAt: string | null;
  nextReviewAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  resolvedAt: string | null;
  occurrenceCount: number;
  recurrenceCount: number;
  worsenedCount: number;
  ageMinutes: number;
  rowVersion: number;
  sourceName: string;
}

interface IssueGroup {
  groupKey: string;
  domain: Domain;
  code: string;
  title: string;
  summary: string;
  expectedState: string;
  actualState: string;
  recommendedAction: string;
  severity: Severity;
  urgency: "overdue" | "due_soon" | "normal" | "deferred";
  triageStatus: string;
  ownerTeam: string | null;
  affectedRecords: number;
  affectedEntities: number;
  recurrenceCount: number;
  worsenedCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  responseDueAt: string | null;
  ageMinutes: number;
  representativeId: number;
  sampleEntityRefs: string[];
  sourceNames: string[];
}

interface GroupResponse {
  generatedAt: string;
  totalGroups: number;
  totalAffectedRecords: number;
  viewCounts: {
    attention: number;
    inProgress: number;
    waiting: number;
    resolved: number;
  };
  viewAffectedRecords: {
    attention: number;
    inProgress: number;
    waiting: number;
    resolved: number;
  };
  domainCounts: Record<Domain, number>;
  domainAffectedRecords: Record<Domain, number>;
  groups: IssueGroup[];
  nextCursor: string | null;
}

interface GroupDetailResponse {
  generatedAt: string;
  group: IssueGroup;
  instances: QueueItem[];
  nextCursor: string | null;
}

interface FlowWaterfallSnapshot {
  generatedAt: string;
  windowDays: number;
  funnel: {
    sourceObserved?: number;
    entered: number;
    reachedWms: number;
    hasShipment: number;
    shipped: number;
    trackingConfirmed: number;
  };
  channels: Array<{ provider: string; entered: number }>;
  channelIntake?: Array<{
    channelId: number | null;
    channelName: string;
    provider: string;
    observed: number;
    omsReceived: number;
    pending: number;
    missing: number;
    failed: number;
    lastObservedAt: string | null;
  }>;
  crossSystem: { wmsShippedOmsOpen: number; omsNotUpdated: number };
  sla: { breached: number };
  issues: FlowIssueSnapshot[];
}

interface FlowIssueSnapshot {
  code: string;
  kind: "stuck" | "contradiction" | "duplicate" | "queue_failure" | "sla";
  severity: FlowIssueSeverity;
  stage: FlowIssueStage;
  count: number;
  message: string;
  why?: string;
  remediation: string;
  replaySafe: boolean;
}

interface FlowBucketResponse {
  code: string;
  rows: Array<Record<string, unknown>>;
  replayActivity?: FlowReplayActivity[];
}

type FlowReplayOutcome = "queued" | "retrying" | "succeeded" | "failed" | "unresolved" | "unknown";

interface FlowReplayActivity {
  oms_order_id: number | string;
  order_number: string | null;
  retry_id: number;
  source_inbox_id: number | null;
  queue_status: string | null;
  outcome: FlowReplayOutcome;
  attempts: number;
  last_error: string | null;
  requested_at: string;
  updated_at: string | null;
  next_retry_at: string | null;
  wms_order_id: number | null;
  warehouse_status: string | null;
}

interface FlowReplayResponse {
  retryQueueId: number | null;
  provider?: string | null;
  topic?: string | null;
  changed?: boolean;
  action?: string;
}

interface FlowOverviewResponse {
  status: "pending" | "refreshing" | "degraded" | "failed" | "stale" | "current";
  stale: boolean;
  staleAfterMinutes: number;
  snapshot: FlowWaterfallSnapshot | null;
  lastAttempt: {
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    updatedAt: string | null;
  } | null;
}

interface Observation {
  id: number;
  observation_kind: string;
  prior_source_status: string | null;
  current_source_status: string | null;
  prior_triage_status: string | null;
  current_triage_status: string | null;
  changed_fields: Record<string, unknown>;
  evidence_summary: Record<string, unknown>;
  observed_metric: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  note: string | null;
  source_observed_at: string | null;
  created_at: string;
}

interface WorkItemDetail {
  item: QueueItem & {
    expectedState: string;
    actualState: string;
    correlationId: string | null;
    rootCauseGroupKey: string | null;
    detailLocator: {
      links?: Array<{ label: string; href: string }>;
      [key: string]: unknown;
    };
    availableActions: Array<{ code: string; kind: "navigate"; label: string; href: string }>;
    sourceUpdatedAt: string;
    technicalEvidence?: Record<string, unknown>;
  };
  observations: Observation[];
  actionAttempts: Array<Record<string, unknown>>;
  relatedItems: Array<{
    id: number;
    domain: Domain;
    code: string;
    entity_ref: string | null;
    title: string;
    severity: Severity;
    triage_status: string;
  }>;
  sourceRun: Record<string, unknown> | null;
}

interface SourceHealthResponse {
  generatedAt: string;
  staleAfterMinutes: number;
  sources: Array<{
    name: string;
    sourceNamespace: string;
    status: "healthy" | "refreshing" | "degraded" | "failed" | "stale" | "never_run" | "version_mismatch";
    projectionVersion: number;
    openItemCount: number;
    controlGapCount: number;
    ageMinutes?: number | null;
    lastRun: Record<string, unknown> | null;
  }>;
  controlGaps: Array<{
    groupKey: string;
    domain: Domain;
    code: string;
    title: string;
    summary: string;
    severity: Severity;
    affectedRecords: number;
    firstSeenAt: string;
    lastSeenAt: string;
    lastChangedAt: string;
  }>;
}

interface UserOption {
  id: string;
  username: string;
  displayName: string | null;
}

interface ShipStationUnmappedPreview {
  exceptionId: number | null;
  wmsOrderId: number;
  orderNumber: string;
  authorityShipmentId: number;
  candidateShipmentId: number | null;
  externalShipmentRef: string;
  providerShipment: {
    shipmentId: number;
    orderId: number;
    orderKey: string;
    orderNumber: string;
    trackingNumber: string;
    carrierCode: string;
    serviceCode: string;
    shipDate: string;
    voidDate: string | null;
    shipmentItems?: Array<{
      sku: string;
      name?: string;
      quantity: number;
      lineItemKey?: string | null;
    }>;
  };
  providerIdentityRepair: {
    supersededCandidateShipmentId: number;
    supersededProviderShipmentId: number;
    supersededTrackingNumber: string | null;
    supersededVoidDate: string;
    activeCandidateShipmentId: number;
    activeProviderShipmentId: number;
    activeTrackingNumber: string;
  } | null;
  originalPackageIdentityRepair: {
    wmsShipmentId: number;
    providerShipmentId: number;
    providerOrderId: number;
    providerOrderKey: string;
    currentTrackingNumber: string;
    originalTrackingNumber: string;
  } | null;
  orderItems: Array<{
    id: number;
    sku: string;
    name: string;
    quantity: number;
    fulfilledQuantity: number;
    customerShippedQuantity: number;
    remainingQuantity: number;
  }>;
  shipments: Array<{
    id: number;
    status: string;
    source: string;
    shipmentPurpose: string;
    trackingNumber: string | null;
    externalShipmentRef: string | null;
    itemCount: number;
    createdAt: string | null;
    items: Array<{
      orderItemId: number;
      sku: string;
      name: string;
      quantity: number;
    }>;
  }>;
}

interface ShipStationUnmappedTarget {
  exceptionId?: number;
  shipmentId?: number;
  label: string;
}

interface ShipStationReshipAdoptionResponse {
  changed: boolean;
  exceptionId: number;
  candidateShipmentId?: number | null;
  providerIdentityRepaired?: boolean;
  originalPackageIdentityRepaired?: boolean;
}

interface ReplacementCatalogItem {
  productVariantId: number;
  sku: string;
  name: string;
  quantity: string;
}

interface ReplacementCatalogSearchResult {
  productVariantId: number;
  sku: string;
  name: string;
}

const DOMAIN_LABEL: Record<Domain, string> = {
  oms: "OMS",
  wms: "WMS",
  shipping: "Shipping",
  inventory: "Inventory",
  procurement: "Procurement",
};

const VIEW_CONFIG: Array<{ value: TowerView; label: string; countKey: keyof GroupResponse["viewCounts"] }> = [
  { value: "attention", label: "Needs Attention", countKey: "attention" },
  { value: "in_progress", label: "In Progress", countKey: "inProgress" },
  { value: "waiting", label: "Waiting", countKey: "waiting" },
  { value: "resolved", label: "Resolved", countKey: "resolved" },
];

function useCompactDetailLayout(): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1023px)");
    const update = () => setCompact(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return compact;
}

function severityClass(severity: Severity): string {
  if (severity === "blocker") return "border-red-300 bg-red-50 text-red-800";
  if (severity === "high") return "border-orange-300 bg-orange-50 text-orange-800";
  if (severity === "medium") return "border-amber-300 bg-amber-50 text-amber-800";
  return "border-slate-300 bg-slate-50 text-slate-700";
}

function severityIcon(severity: Severity) {
  if (severity === "blocker") return <ShieldAlert className="h-4 w-4" />;
  if (severity === "high") return <AlertTriangle className="h-4 w-4" />;
  if (severity === "medium") return <AlertCircle className="h-4 w-4" />;
  return <CircleDot className="h-4 w-4" />;
}

function formatAge(minutes: number): string {
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1_440)}d`;
}

function formatTimestamp(value: unknown): string {
  if (!value) return "Not available";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "Not available";
  return date.toLocaleString();
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const FLOW_SEVERITY_ORDER: Record<FlowIssueSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function flowSeverityClass(severity: FlowIssueSeverity): string {
  if (severity === "critical") return "border-red-300 bg-red-50 text-red-800";
  if (severity === "warning") return "border-orange-300 bg-orange-50 text-orange-800";
  return "border-slate-300 bg-slate-50 text-slate-700";
}

function flowOrderReference(row: Record<string, unknown>): string | null {
  for (const key of ["order_number", "external_order_number", "channel_order_number"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function flowRecordTitle(row: Record<string, unknown>, index: number): string {
  const orderReference = flowOrderReference(row);
  if (orderReference) return orderReference;

  for (const [key, label] of [
    ["shipment_id", "Shipment"],
    ["inbox_id", "Inbox event"],
    ["retry_id", "Retry"],
    ["oms_order_id", "OMS order"],
    ["wms_order_id", "WMS order"],
  ] as const) {
    const value = row[key];
    if (value !== null && value !== undefined && String(value).trim()) return `${label} ${String(value)}`;
  }

  return `Evidence row ${index + 1}`;
}

function formatFlowRecordValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "Not available";
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  if (key === "at" || key.endsWith("_at")) {
    const timestamp = new Date(text);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toLocaleString();
  }
  return text;
}

function replayActivityKey(value: unknown): string | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

function replayOutcomeLabel(outcome: FlowReplayOutcome): string {
  if (outcome === "queued") return "Queued";
  if (outcome === "retrying") return "Retrying";
  if (outcome === "succeeded") return "Reached WMS";
  if (outcome === "failed") return "Replay failed";
  if (outcome === "unresolved") return "Still blocked";
  return "Status unavailable";
}

function replayOutcomeClass(outcome: FlowReplayOutcome): string {
  if (outcome === "succeeded") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (outcome === "queued") return "border-blue-300 bg-blue-50 text-blue-800";
  if (outcome === "retrying") return "border-amber-300 bg-amber-50 text-amber-800";
  if (outcome === "failed" || outcome === "unresolved") return "border-red-300 bg-red-50 text-red-800";
  return "border-slate-300 bg-slate-50 text-slate-700";
}

function replayOutcomeIcon(outcome: FlowReplayOutcome) {
  if (outcome === "succeeded") return <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />;
  if (outcome === "queued" || outcome === "retrying") {
    return <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />;
  }
  return <AlertCircle className="mr-1.5 h-3.5 w-3.5" />;
}

function replayOutcomeDescription(activity: FlowReplayActivity): string {
  if (activity.outcome === "queued") {
    return "Waiting for the retry worker to process the paid event.";
  }
  if (activity.outcome === "retrying") {
    return activity.next_retry_at
      ? `Attempt ${activity.attempts} failed. Next attempt ${formatTimestamp(activity.next_retry_at)}.`
      : `Attempt ${activity.attempts} failed and will be retried.`;
  }
  if (activity.outcome === "succeeded") {
    const warehouse = activity.wms_order_id ? `WMS order ${activity.wms_order_id}` : "A WMS order";
    const status = activity.warehouse_status ? ` is ${humanize(activity.warehouse_status).toLowerCase()}` : " was created";
    return `${warehouse}${status}.`;
  }
  if (activity.outcome === "failed") {
    return activity.last_error || "The retry exhausted its attempts without reaching WMS.";
  }
  if (activity.outcome === "unresolved") {
    return "The paid event finished processing, but the order still has no WMS order. Do not replay it again without investigating.";
  }
  return "The replay audit exists, but its queue record could not be resolved.";
}

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json();
}

function positiveFlowId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function shipStationUnmappedTarget(
  row: Record<string, unknown>,
  index: number,
): ShipStationUnmappedTarget | null {
  const exceptionId = positiveFlowId(row.exception_id);
  if (exceptionId) return { exceptionId, label: flowRecordTitle(row, index) };
  const shipmentId = positiveFlowId(row.shipment_id);
  if (shipmentId) return { shipmentId, label: flowRecordTitle(row, index) };
  return null;
}

function ShipStationReshipAdoptionDialog(props: {
  target: ShipStationUnmappedTarget | null;
  canAdjustInventory: boolean;
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [originalShipmentId, setOriginalShipmentId] = useState("");
  const [lineMappings, setLineMappings] = useState<Record<number, string>>({});
  const [manualLineSelections, setManualLineSelections] = useState<Record<number, boolean>>({});
  const [manualLineQuantities, setManualLineQuantities] = useState<Record<number, string>>({});
  const [itemMode, setItemMode] = useState<"ordered" | "catalog">("ordered");
  const [catalogSearchInput, setCatalogSearchInput] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogItems, setCatalogItems] = useState<ReplacementCatalogItem[]>([]);
  const locatorQuery = useMemo(() => {
    if (!props.target) return "";
    const params = new URLSearchParams();
    if (props.target.exceptionId) params.set("exceptionId", String(props.target.exceptionId));
    if (props.target.shipmentId) params.set("shipmentId", String(props.target.shipmentId));
    return params.toString();
  }, [props.target]);
  const previewQuery = useQuery({
    queryKey: ["shipstation-unmapped-preview", locatorQuery],
    queryFn: () => fetchJson<ShipStationUnmappedPreview>(
      `/api/oms/ops/shipstation-unmapped/preview?${locatorQuery}`,
    ),
    enabled: Boolean(props.target && locatorQuery),
    staleTime: 0,
    retry: false,
  });
  const preview = previewQuery.data;
  const catalogSearchQuery = useQuery<ReplacementCatalogSearchResult[]>({
    queryKey: ["replacement-concession-catalog", catalogSearch],
    queryFn: async () => {
      const response = await fetch(`/api/inventory/skus/search?q=${encodeURIComponent(catalogSearch)}&limit=12`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not search the catalog");
      return response.json();
    },
    enabled: Boolean(props.target && itemMode === "catalog" && catalogSearch.length >= 2),
  });
  const rawProviderItems = useMemo(
    () => preview?.providerShipment.shipmentItems ?? [],
    [preview],
  );
  const providerItems = useMemo(() => rawProviderItems.filter((item) => (
    String(item.sku ?? "").trim().length > 0 && Number.isSafeInteger(Number(item.quantity)) && Number(item.quantity) > 0
  )), [rawProviderItems]);
  const providerItemsMissing = rawProviderItems.length === 0;
  const providerEvidenceValid = (providerItemsMissing || (
    providerItems.length > 0 && providerItems.length === rawProviderItems.length
  ))
    && Boolean(preview?.providerShipment.shipDate)
    && !preview?.providerShipment.voidDate;
  const isVoidedProviderShipment = Boolean(preview?.providerShipment.voidDate);

  useEffect(() => {
    setReason("");
    setNotes("");
    setOriginalShipmentId("");
    setLineMappings({});
    setManualLineSelections({});
    setManualLineQuantities({});
    setItemMode("ordered");
    setCatalogSearchInput("");
    setCatalogSearch("");
    setCatalogItems([]);
  }, [locatorQuery]);

  useEffect(() => {
    const nextSearch = catalogSearchInput.trim();
    if (itemMode !== "catalog" || nextSearch.length < 2) {
      setCatalogSearch("");
      return;
    }
    const timeout = window.setTimeout(() => setCatalogSearch(nextSearch), 300);
    return () => window.clearTimeout(timeout);
  }, [catalogSearchInput, itemMode]);

  useEffect(() => {
    if (!preview) return;
    const defaults: Record<number, string> = {};
    providerItems.forEach((item, index) => {
      const matches = preview.orderItems.filter(
        (orderItem) => orderItem.sku.trim().toUpperCase() === item.sku.trim().toUpperCase(),
      );
      defaults[index] = matches.length === 1 ? String(matches[0].id) : "";
    });
    setLineMappings(defaults);
  }, [preview, providerItems]);

  const validOriginalShipments = useMemo(() => (preview?.shipments ?? []).filter((shipment) => (
    shipment.id !== preview?.candidateShipmentId
    && ["shipped", "returned", "lost"].includes(shipment.status)
    && shipment.shipmentPurpose === "customer_fulfillment"
    && shipment.itemCount > 0
  )), [preview]);
  const selectedOriginalShipment = useMemo(() => (
    validOriginalShipments.find((shipment) => shipment.id === positiveFlowId(originalShipmentId)) ?? null
  ), [originalShipmentId, validOriginalShipments]);

  useEffect(() => {
    if (!preview || positiveFlowId(originalShipmentId) !== null) return;
    const restoredOriginalId = preview.originalPackageIdentityRepair?.wmsShipmentId ?? null;
    const preferred = restoredOriginalId === null
      ? null
      : validOriginalShipments.find((shipment) => shipment.id === restoredOriginalId);
    if (preferred) {
      setOriginalShipmentId(String(preferred.id));
    } else if (validOriginalShipments.length === 1) {
      setOriginalShipmentId(String(validOriginalShipments[0].id));
    }
  }, [originalShipmentId, preview, validOriginalShipments]);

  const selectedOriginalTracking = selectedOriginalShipment
    ? (preview?.originalPackageIdentityRepair?.wmsShipmentId === selectedOriginalShipment.id
      ? preview.originalPackageIdentityRepair.originalTrackingNumber
      : selectedOriginalShipment.trackingNumber)
    : preview?.originalPackageIdentityRepair?.originalTrackingNumber ?? null;
  const replacementServiceLabel = preview
    ? humanize(preview.providerShipment.serviceCode || preview.providerShipment.carrierCode)
      .replace(/\bUsps\b/g, "USPS")
      .replace(/\bUps\b/g, "UPS")
    : "";

  useEffect(() => {
    if (!providerItemsMissing) return;
    const quantities: Record<number, string> = {};
    for (const item of selectedOriginalShipment?.items ?? []) {
      quantities[item.orderItemId] = String(item.quantity);
    }
    setManualLineSelections({});
    setManualLineQuantities(quantities);
  }, [providerItemsMissing, selectedOriginalShipment]);

  const providerMappingsComplete = providerItems.length > 0 && providerItems.every((item, index) => {
    const orderItemId = positiveFlowId(lineMappings[index]);
    return orderItemId !== null && preview?.orderItems.some((orderItem) => (
      orderItem.id === orderItemId
      && orderItem.sku.trim().toUpperCase() === item.sku.trim().toUpperCase()
    ));
  });
  const selectedManualItems = useMemo(() => (
    (selectedOriginalShipment?.items ?? []).filter(
      (item) => manualLineSelections[item.orderItemId] === true,
    )
  ), [manualLineSelections, selectedOriginalShipment]);
  const manualMappingsComplete = selectedManualItems.length > 0 && selectedManualItems.every((item) => {
    const quantity = Number(manualLineQuantities[item.orderItemId]);
    return Number.isSafeInteger(quantity) && quantity > 0 && quantity <= item.quantity;
  });
  const catalogMappingsComplete = catalogItems.length > 0 && catalogItems.every((item) => {
    const quantity = Number(item.quantity);
    return Number.isSafeInteger(quantity) && quantity > 0;
  });
  const catalogSearchReady = catalogSearch.length >= 2 && catalogSearch === catalogSearchInput.trim();
  const availableCatalogResults = catalogSearchReady
    ? (catalogSearchQuery.data ?? []).filter(
      (result) => !catalogItems.some((item) => item.productVariantId === result.productVariantId),
    )
    : [];
  const isCatalogConcession = providerItemsMissing && itemMode === "catalog";
  const mappingsComplete = providerItemsMissing
    ? (isCatalogConcession ? catalogMappingsComplete : manualMappingsComplete)
    : providerMappingsComplete;
  const actionValid = props.canAdjustInventory
    && providerEvidenceValid
    && mappingsComplete
    && positiveFlowId(originalShipmentId) !== null
    && (isCatalogConcession || reason.length > 0);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!props.target || !preview) throw new Error("Reship evidence is unavailable");
      const body: Record<string, unknown> = {
        ...("exceptionId" in props.target ? { exceptionId: props.target.exceptionId } : {}),
        ...("shipmentId" in props.target ? { shipmentId: props.target.shipmentId } : {}),
        originalShipmentId: Number(originalShipmentId),
        reason: isCatalogConcession ? "concession" : reason,
        notes: notes.trim() || undefined,
        lineMappings: isCatalogConcession
          ? catalogItems.map((item) => ({
            evidenceSource: "catalog",
            productVariantId: item.productVariantId,
            quantity: Number(item.quantity),
          }))
          : providerItemsMissing
          ? selectedManualItems.map((item) => ({
            evidenceSource: "original_wms",
            orderItemId: item.orderItemId,
            quantity: Number(manualLineQuantities[item.orderItemId]),
          }))
          : providerItems.map((item, providerItemIndex) => ({
            evidenceSource: "shipstation",
            providerItemIndex,
            orderItemId: Number(lineMappings[providerItemIndex]),
            quantity: Number(item.quantity),
          })),
      };
      const response = await apiRequest("POST", "/api/oms/ops/shipstation-unmapped/adopt-reship", body);
      return response.json() as Promise<ShipStationReshipAdoptionResponse>;
    },
    onSuccess: async (result) => {
      toast({
        title: isCatalogConcession ? "Different or free item recorded" : "Replacement recorded",
        description: isCatalogConcession
          ? "Inventory was deducted without changing the customer order."
          : "Inventory was deducted for the confirmed replacement items.",
      });
      await props.onCompleted();
      props.onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Could not record shipment", description: error.message, variant: "destructive" });
    },
  });

  const voidedResolutionMutation = useMutation({
    mutationFn: async () => {
      if (!props.target || !preview?.providerShipment.voidDate) {
        throw new Error("Voided ShipStation evidence is unavailable");
      }
      const body: Record<string, unknown> = {
        ...("exceptionId" in props.target ? { exceptionId: props.target.exceptionId } : {}),
        ...("shipmentId" in props.target ? { shipmentId: props.target.shipmentId } : {}),
      };
      const response = await apiRequest(
        "POST",
        "/api/oms/ops/shipstation-unmapped/resolve-voided",
        body,
      );
      return response.json();
    },
    onSuccess: async () => {
      toast({
        title: "Voided label resolved",
        description: "No shipment was recorded and no inventory was deducted.",
      });
      await props.onCompleted();
      props.onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Could not resolve voided label",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={props.target !== null} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader className="text-left">
          <DialogTitle>{isVoidedProviderShipment ? "Resolve voided label" : "Review shipment"}</DialogTitle>
          <DialogDescription>
            {isVoidedProviderShipment
              ? `${props.target?.label}: confirm the voided label requires no inventory action.`
              : `${props.target?.label}: determine whether this was a replacement shipment.`}
          </DialogDescription>
        </DialogHeader>

        {previewQuery.isLoading ? (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading shipment details...</div>
            <Skeleton className="h-20 w-full" /><Skeleton className="h-40 w-full" />
          </div>
        ) : previewQuery.isError ? (
          <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <div>{previewQuery.error instanceof Error ? previewQuery.error.message : "Evidence failed to load"}</div>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => previewQuery.refetch()}>Retry live evidence</Button>
          </div>
        ) : preview ? (
          isVoidedProviderShipment ? (
            <div className="space-y-5">
              <section className="border-y py-4">
                <div className="flex gap-3">
                  <CircleOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                  <div>
                    <div className="font-medium">ShipStation voided this label</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      This label is retained in ShipStation shipment history even when its order no longer appears in the normal order view.
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                  <div className="border-t pt-3">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Voided tracking</div>
                    <div className="mt-1 break-all font-medium">{preview.providerShipment.trackingNumber || "Tracking unavailable"}</div>
                    <div className="mt-1 text-xs text-muted-foreground">ShipStation shipment {preview.providerShipment.shipmentId}</div>
                  </div>
                  <div className="border-t pt-3">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Voided</div>
                    <div className="mt-1 font-medium">{formatTimestamp(preview.providerShipment.voidDate)}</div>
                  </div>
                </div>
              </section>

              <section className="border-y py-4">
                <div className="font-semibold">What will happen</div>
                <div className="mt-3 space-y-2 text-sm">
                  <div className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700" /><span>The original shipment and tracking remain unchanged.</span></div>
                  <div className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700" /><span>No replacement shipment is created.</span></div>
                  <div className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700" /><span>No inventory or customer fulfillment is changed.</span></div>
                </div>
              </section>
            </div>
          ) : (
          <div className="space-y-5">
            <section className="border-y py-4">
              <div className="flex gap-3">
                <PackageCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-700" />
                <div>
                  <div className="font-medium">A replacement package was shipped</div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {providerItemsMissing
                      ? "ShipStation did not list the package contents. Confirm whether ordered items or different/free items were sent."
                      : "Confirm which original package it replaces and why the replacement was sent."}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                <div className="border-t pt-3">
                  <div className="text-xs font-semibold uppercase text-muted-foreground">Original package</div>
                  <div className="mt-1 break-all font-medium">{selectedOriginalTracking || "Select below"}</div>
                  {selectedOriginalShipment && <div className="mt-1 text-xs text-muted-foreground">Shipment {selectedOriginalShipment.id}</div>}
                </div>
                <div className="border-t pt-3">
                  <div className="text-xs font-semibold uppercase text-muted-foreground">Replacement package</div>
                  <div className="mt-1 break-all font-medium">{preview.providerShipment.trackingNumber || "Tracking unavailable"}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Shipped {formatTimestamp(preview.providerShipment.shipDate)}{replacementServiceLabel ? ` via ${replacementServiceLabel}` : ""}
                  </div>
                </div>
              </div>

              <p className="mt-4 border-t pt-3 text-sm text-muted-foreground">
                Echelon will keep these as two separate packages and deduct inventory only for the items confirmed below. The customer order will remain fulfilled once.
              </p>
            </section>

            <section className="grid gap-4 border-t pt-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Which package was replaced?</Label>
                {validOriginalShipments.length === 1 && selectedOriginalShipment ? (
                  <div className="border-y py-3 text-sm">
                    <div className="break-all font-medium">{selectedOriginalTracking || humanize(selectedOriginalShipment.status)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">The only eligible original package</div>
                  </div>
                ) : (
                  <Select value={originalShipmentId} onValueChange={setOriginalShipmentId}>
                    <SelectTrigger><SelectValue placeholder="Select the original package" /></SelectTrigger>
                    <SelectContent>{validOriginalShipments.map((shipment) => {
                      const restoredTracking = preview.originalPackageIdentityRepair?.wmsShipmentId === shipment.id
                        ? preview.originalPackageIdentityRepair.originalTrackingNumber
                        : shipment.trackingNumber;
                      return <SelectItem key={shipment.id} value={String(shipment.id)}>{restoredTracking || `Shipment ${shipment.id}`}</SelectItem>;
                    })}</SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-2">
                {isCatalogConcession ? (
                  <>
                    <Label>How it will be recorded</Label>
                    <div className="border-y py-3 text-sm">
                      <div className="font-medium">Different or free item</div>
                      <div className="mt-1 text-xs text-muted-foreground">No item is added to the customer order.</div>
                    </div>
                  </>
                ) : (
                  <>
                    <Label>Why was it replaced?</Label>
                    <Select value={reason} onValueChange={setReason}>
                      <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="lost">Lost in transit</SelectItem>
                        <SelectItem value="damaged">Arrived damaged</SelectItem>
                        <SelectItem value="misdelivery">Delivered incorrectly</SelectItem>
                        <SelectItem value="carrier_replacement">Carrier-issued replacement</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>
            </section>
            {validOriginalShipments.length === 0 && <p className="text-sm text-red-800">No shipped original package is available for this replacement.</p>}

            <section className="border-t pt-4">
              <div className="font-semibold">What was sent?</div>
              {providerItemsMissing && (
                <ToggleGroup
                  type="single"
                  value={itemMode}
                  onValueChange={(value) => {
                    if (value === "ordered" || value === "catalog") setItemMode(value);
                  }}
                  variant="outline"
                  className="mt-3 grid w-full grid-cols-2"
                  aria-label="Choose the type of items sent"
                >
                  <ToggleGroupItem value="ordered" className="h-auto min-h-10 px-3 py-2 text-center text-sm">
                    Ordered items resent
                  </ToggleGroupItem>
                  <ToggleGroupItem value="catalog" className="h-auto min-h-10 px-3 py-2 text-center text-sm">
                    Different or free items
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
              <p className="mt-1 text-sm text-muted-foreground">
                {isCatalogConcession
                  ? "Select the actual catalog items and quantities that physically left inventory."
                  : providerItemsMissing
                    ? "Check each ordered item that was physically resent and confirm its quantity."
                  : "Confirm that each replacement item matches the original order item."}
              </p>
              {providerItemsMissing ? (
                isCatalogConcession ? (
                  <div className="mt-3 space-y-4">
                    <div className="relative">
                      <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        className="pl-9 pr-9"
                        value={catalogSearchInput}
                        onChange={(event) => setCatalogSearchInput(event.target.value)}
                        placeholder="Type a SKU or item name"
                        aria-label="Search catalog items"
                      />
                      {catalogSearchQuery.isFetching && <Loader2 className="absolute right-3 top-3 h-4 w-4 animate-spin text-muted-foreground" />}
                    </div>

                    {catalogSearchQuery.isError && (
                      <p className="text-sm text-red-800">{catalogSearchQuery.error instanceof Error ? catalogSearchQuery.error.message : "Could not search the catalog"}</p>
                    )}
                    {catalogSearchReady && !catalogSearchQuery.isFetching && (catalogSearchQuery.data ?? []).length === 0 && (
                      <p className="text-sm text-muted-foreground">No catalog items match "{catalogSearch}".</p>
                    )}
                    {availableCatalogResults.length > 0 && (
                      <div className="divide-y border-y">
                        {availableCatalogResults.map((result) => (
                          <div key={result.productVariantId} className="flex items-center gap-3 py-3">
                            <div className="min-w-0 flex-1 text-sm">
                              <div className="truncate font-medium">{result.name}</div>
                              <div className="mt-1 truncate text-xs text-muted-foreground">{result.sku}</div>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setCatalogItems((current) => [...current, { ...result, quantity: "1" }])}
                            >
                              <PackagePlus className="mr-2 h-4 w-4" />
                              Add
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div>
                      <div className="text-sm font-medium">Items to deduct</div>
                      {catalogItems.length === 0 ? (
                        <p className="mt-2 text-sm text-muted-foreground">Search for and add each different or free item that was sent.</p>
                      ) : (
                        <div className="mt-2 divide-y border-y">
                          {catalogItems.map((item) => (
                            <div key={item.productVariantId} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_120px_40px] sm:items-end">
                              <div className="min-w-0 text-sm">
                                <div className="truncate font-medium">{item.name}</div>
                                <div className="mt-1 truncate text-xs text-muted-foreground">{item.sku}</div>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">Quantity sent</Label>
                                <Input
                                  type="number"
                                  min={1}
                                  value={item.quantity}
                                  aria-label={`Quantity sent for ${item.sku}`}
                                  onChange={(event) => setCatalogItems((current) => current.map((currentItem) => (
                                    currentItem.productVariantId === item.productVariantId
                                      ? { ...currentItem, quantity: event.target.value }
                                      : currentItem
                                  )))}
                                />
                              </div>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                aria-label={`Remove ${item.sku}`}
                                title={`Remove ${item.sku}`}
                                onClick={() => setCatalogItems((current) => current.filter((currentItem) => currentItem.productVariantId !== item.productVariantId))}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    {selectedOriginalShipment ? (
                      <div className="divide-y border-y">
                        {selectedOriginalShipment.items.map((item) => {
                        const checked = manualLineSelections[item.orderItemId] === true;
                        return (
                          <div key={item.orderItemId} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_120px] sm:items-center">
                            <label className="flex min-w-0 cursor-pointer items-start gap-3 text-sm">
                              <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(value) => setManualLineSelections((current) => ({ ...current, [item.orderItemId]: value === true }))} />
                              <span className="min-w-0"><span className="font-medium">{item.name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{item.sku} - Up to {item.quantity}</span></span>
                            </label>
                            <div className="space-y-1">
                              <Label className="text-xs text-muted-foreground">Quantity resent</Label>
                              <Input aria-label={`Quantity resent for ${item.sku}`} type="number" min={1} max={item.quantity} disabled={!checked} value={manualLineQuantities[item.orderItemId] ?? ""} onChange={(event) => setManualLineQuantities((current) => ({ ...current, [item.orderItemId]: event.target.value }))} />
                            </div>
                          </div>
                        );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">Select the original package above to see its items.</p>
                    )}
                  </div>
                )
              ) : (
                <div className="mt-3 divide-y border-y">
                  {providerItems.map((item, index) => {
                    const matchingLines = preview.orderItems.filter(
                      (orderItem) => orderItem.sku.trim().toUpperCase() === item.sku.trim().toUpperCase(),
                    );
                    return (
                      <div key={`${item.sku}-${index}`} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(260px,1fr)] sm:items-center">
                        <div className="min-w-0 text-sm"><div className="font-medium">{item.name || item.sku}</div><div className="mt-1 truncate text-xs text-muted-foreground">{item.sku} - Quantity {item.quantity}</div></div>
                        <Select value={lineMappings[index] || ""} onValueChange={(value) => setLineMappings((current) => ({ ...current, [index]: value }))}>
                          <SelectTrigger><SelectValue placeholder="Match to original item" /></SelectTrigger>
                          <SelectContent>
                            {matchingLines.map((orderItem) => <SelectItem key={orderItem.id} value={String(orderItem.id)}>{orderItem.sku} - {orderItem.quantity} originally shipped</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              )}
              {preview.providerShipment.voidDate && <p className="mt-2 text-sm text-red-800">This package cannot be adopted because ShipStation reports it as voided.</p>}
              {!preview.providerShipment.shipDate && <p className="mt-2 text-sm text-red-800">This package cannot be adopted because ShipStation has no shipped date.</p>}
              {!providerItemsMissing && providerItems.length !== rawProviderItems.length && <p className="mt-2 text-sm text-red-800">This package cannot be adopted because one or more ShipStation package lines are invalid.</p>}
            </section>

            <section className="border-t pt-4">
              <div className="font-semibold">What will happen</div>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700" /><span>The original package stays under tracking {selectedOriginalTracking || "shown above"}.</span></div>
                <div className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700" /><span>The {isCatalogConcession ? "different or free item shipment" : "replacement"} is recorded under tracking {preview.providerShipment.trackingNumber}.</span></div>
                <div className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-green-700" /><span>{isCatalogConcession ? "Only the selected catalog quantities are deducted; no items are added to the order." : "Only the checked quantities are deducted from inventory; customer fulfillment is not increased."}</span></div>
              </div>
            </section>

            <section className="border-t pt-4">
              <div className="space-y-2">
                <Label htmlFor="shipstation-remediation-notes">Notes (optional)</Label>
                <Textarea id="shipstation-remediation-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} placeholder="Add any useful context for the audit trail." />
              </div>
            </section>
            {!props.canAdjustInventory && <p className="text-xs text-amber-800">Inventory adjustment permission is required to record this shipment.</p>}
          </div>
          )
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>Cancel</Button>
          {isVoidedProviderShipment ? (
            <Button
              disabled={!preview || voidedResolutionMutation.isPending}
              onClick={() => voidedResolutionMutation.mutate()}
            >
              {voidedResolutionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Resolve voided label
            </Button>
          ) : (
            <Button disabled={!preview || !actionValid || mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record shipment
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function buildGroupUrl(params: {
  view: TowerView;
  domain: Domain | "all";
  severity: Severity | "all";
  search: string;
  cursor: string | null;
}): string {
  const query = new URLSearchParams({
    view: params.view,
    domain: params.domain,
    severity: params.severity,
    limit: "50",
  });
  if (params.search) query.set("search", params.search);
  if (params.cursor) query.set("cursor", params.cursor);
  return `/api/operations/control-tower/v2/groups?${query.toString()}`;
}

function buildGroupDetailUrl(params: {
  groupKey: string;
  view: TowerView;
  domain: Domain | "all";
  severity: Severity | "all";
  search: string;
  cursor: string | null;
}): string {
  const query = new URLSearchParams({
    view: params.view,
    domain: params.domain,
    severity: params.severity,
    limit: "25",
  });
  if (params.search) query.set("search", params.search);
  if (params.cursor) query.set("cursor", params.cursor);
  return `/api/operations/control-tower/v2/groups/${encodeURIComponent(params.groupKey)}?${query.toString()}`;
}

function QueueSkeleton() {
  return (
    <div className="divide-y">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="grid grid-cols-[88px_minmax(0,1fr)_84px_130px] gap-3 px-4 py-3">
          <Skeleton className="h-6 w-16" />
          <div className="space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-5/6" /></div>
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-5 p-5">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-36 w-full" />
    </div>
  );
}

export default function FlowMonitor() {
  const queryClient = useQueryClient();
  const { user, hasPermission } = useAuth();
  const [view, setView] = useState<TowerView>("attention");
  const [domain, setDomain] = useState<Domain | "all">("all");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [compactDetailOpen, setCompactDetailOpen] = useState(false);
  const [showSystemHealth, setShowSystemHealth] = useState(false);
  const [technicalEvidenceRequested, setTechnicalEvidenceRequested] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeUntil, setSnoozeUntil] = useState(() => localDateTimeValue(new Date(Date.now() + 60 * 60_000)));
  const [snoozeReason, setSnoozeReason] = useState("");
  const compactDetailLayout = useCompactDetailLayout();

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const groupQuery = useInfiniteQuery({
    queryKey: ["operations-control-tower-v2", view, domain, severity, search],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchJson<GroupResponse>(buildGroupUrl({
      view,
      domain,
      severity,
      search,
      cursor: pageParam,
    })),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

  const pages = groupQuery.data?.pages ?? [];
  const groupSummary = pages[0] ?? null;
  const groups = useMemo(() => pages.flatMap((page) => page.groups), [pages]);

  useEffect(() => {
    if (selectedGroupKey !== null && groups.some((group) => group.groupKey === selectedGroupKey)) return;
    setSelectedGroupKey(groups[0]?.groupKey ?? null);
    setSelectedId(null);
  }, [groups, selectedGroupKey]);

  const groupDetailQuery = useInfiniteQuery({
    queryKey: ["operations-control-tower-v2-group", selectedGroupKey, view, domain, severity, search],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchJson<GroupDetailResponse>(buildGroupDetailUrl({
      groupKey: selectedGroupKey!,
      view,
      domain,
      severity,
      search,
      cursor: pageParam,
    })),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: selectedGroupKey !== null && selectedId === null && !showSystemHealth,
  });

  const groupDetailPages = groupDetailQuery.data?.pages ?? [];
  const selectedGroup = groupDetailPages[0]?.group
    ?? groups.find((group) => group.groupKey === selectedGroupKey)
    ?? null;
  const groupInstances = useMemo(
    () => groupDetailPages.flatMap((page) => page.instances),
    [groupDetailPages],
  );

  useEffect(() => {
    setTechnicalEvidenceRequested(false);
  }, [selectedId]);

  const detailQuery = useQuery({
    queryKey: ["operations-control-tower-v2-detail", selectedId, technicalEvidenceRequested],
    queryFn: () => fetchJson<WorkItemDetail>(
      `/api/operations/control-tower/v2/work-items/${selectedId}${technicalEvidenceRequested ? "?includeTechnical=1" : ""}`,
    ),
    enabled: selectedId !== null && !showSystemHealth,
  });

  const flowQuery = useQuery({
    queryKey: ["operations-control-tower-v2-flow-overview"],
    queryFn: () => fetchJson<FlowOverviewResponse>("/api/operations/control-tower/v2/flow-overview"),
    refetchInterval: 2 * 60_000,
  });

  const sourcesQuery = useQuery({
    queryKey: ["operations-control-tower-v2-sources"],
    queryFn: () => fetchJson<SourceHealthResponse>("/api/operations/control-tower/v2/sources"),
    refetchInterval: 60_000,
  });

  const usersQuery = useQuery({
    queryKey: ["operations-control-tower-v2-assignees"],
    queryFn: () => fetchJson<UserOption[]>("/api/operations/control-tower/v2/assignees"),
    enabled: hasPermission("operations", "assign"),
  });

  const invalidateTower = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["operations-control-tower-v2"] }),
      queryClient.invalidateQueries({ queryKey: ["operations-control-tower-v2-group"] }),
      queryClient.invalidateQueries({ queryKey: ["operations-control-tower-v2-detail"] }),
      queryClient.invalidateQueries({ queryKey: ["operations-control-tower-v2-sources"] }),
    ]);
  };

  const acknowledgeMutation = useMutation({
    mutationFn: async (item: QueueItem) => {
      const response = await apiRequest(
        "POST",
        `/api/operations/control-tower/v2/work-items/${item.id}/acknowledge`,
        { version: item.rowVersion },
      );
      return response.json();
    },
    onSuccess: invalidateTower,
  });

  const assignMutation = useMutation({
    mutationFn: async (params: { item: QueueItem; assignedUserId: string | null }) => {
      const response = await apiRequest(
        "POST",
        `/api/operations/control-tower/v2/work-items/${params.item.id}/assign`,
        {
          version: params.item.rowVersion,
          assignedUserId: params.assignedUserId,
          ownerTeam: params.item.ownerTeam,
        },
      );
      return response.json();
    },
    onSuccess: invalidateTower,
  });

  const snoozeMutation = useMutation({
    mutationFn: async (item: QueueItem) => {
      const response = await apiRequest(
        "POST",
        `/api/operations/control-tower/v2/work-items/${item.id}/snooze`,
        {
          version: item.rowVersion,
          until: new Date(snoozeUntil).toISOString(),
          reason: snoozeReason,
        },
      );
      return response.json();
    },
    onSuccess: async () => {
      setSnoozeOpen(false);
      setSnoozeReason("");
      await invalidateTower();
    },
  });

  const selected = detailQuery.data?.item ?? groupInstances.find((item) => item.id === selectedId) ?? null;
  const sourceSummary = sourcesQuery.data?.sources ?? [];
  const unhealthySources = sourceSummary.filter((source) => !["healthy", "refreshing"].includes(source.status));
  const refreshingSources = sourceSummary.filter((source) => source.status === "refreshing");
  const mutationError = acknowledgeMutation.error || assignMutation.error || snoozeMutation.error;

  const resetFilters = () => {
    setDomain("all");
    setSeverity("all");
    setSearchInput("");
    setSearch("");
  };

  const refresh = async () => {
    await Promise.all([
      groupQuery.refetch(),
      sourcesQuery.refetch(),
      flowQuery.refetch(),
      selectedId !== null ? detailQuery.refetch() : groupDetailQuery.refetch(),
    ]);
  };

  const openWorkItem = (id: number) => {
    setSelectedId(id);
    if (compactDetailLayout) setCompactDetailOpen(true);
  };

  const openGroup = (groupKey: string) => {
    setSelectedGroupKey(groupKey);
    setSelectedId(null);
    if (compactDetailLayout) setCompactDetailOpen(true);
  };

  const renderDetailPane = () => {
    if (selectedId === null && selectedGroupKey === null) {
      return (
        <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
          <Inbox className="h-8 w-8" />
          <span className="text-sm">Select an issue group</span>
        </div>
      );
    }
    if (selectedId === null) {
      if (groupDetailQuery.isLoading && !groupDetailQuery.data) return <DetailSkeleton />;
      if (groupDetailQuery.isError) {
        return (
          <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 p-8 text-center">
            <AlertTriangle className="h-8 w-8 text-red-600" />
            <div className="font-medium">Issue group failed to load</div>
            <div className="text-sm text-muted-foreground">{groupDetailQuery.error instanceof Error ? groupDetailQuery.error.message : "Unknown error"}</div>
            <Button variant="outline" onClick={() => groupDetailQuery.refetch()}>Retry</Button>
          </div>
        );
      }
      if (!selectedGroup) return null;
      return (
        <IssueGroupDetailPanel
          group={selectedGroup}
          instances={groupInstances}
          hasNextPage={groupDetailQuery.hasNextPage}
          loadingMore={groupDetailQuery.isFetchingNextPage}
          onLoadMore={() => groupDetailQuery.fetchNextPage()}
          onOpenInstance={openWorkItem}
        />
      );
    }
    if (detailQuery.isLoading && !detailQuery.data) return <DetailSkeleton />;
    if (detailQuery.isError) {
      return (
        <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle className="h-8 w-8 text-red-600" />
          <div className="font-medium">Detail failed to load</div>
          <div className="text-sm text-muted-foreground">{detailQuery.error instanceof Error ? detailQuery.error.message : "Unknown error"}</div>
          <Button variant="outline" onClick={() => detailQuery.refetch()}>Retry</Button>
        </div>
      );
    }
    if (!detailQuery.data) return null;

    return (
      <WorkItemDetailPanel
        detail={detailQuery.data}
        users={usersQuery.data ?? []}
        currentUserId={user?.id ?? null}
        canTriage={hasPermission("operations", "triage")}
        canAssign={hasPermission("operations", "assign")}
        canViewTechnical={hasPermission("operations", "view_technical")}
        technicalEvidenceRequested={technicalEvidenceRequested}
        onLoadTechnical={() => setTechnicalEvidenceRequested(true)}
        onAcknowledge={() => acknowledgeMutation.mutate(detailQuery.data!.item)}
        onAssign={(assignedUserId) => assignMutation.mutate({ item: detailQuery.data!.item, assignedUserId })}
        onSnooze={() => setSnoozeOpen(true)}
        onSelectRelated={openWorkItem}
        onBack={() => setSelectedId(null)}
        busy={acknowledgeMutation.isPending || assignMutation.isPending || snoozeMutation.isPending}
      />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b bg-background px-4 py-4 lg:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold">Operations Control Tower</h1>
              {sourcesQuery.isLoading ? (
                <Badge variant="outline">Loading sources</Badge>
              ) : unhealthySources.length === 0 && sourceSummary.length > 0 ? (
                <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
                  {refreshingSources.length > 0 ? `${refreshingSources.length} source${refreshingSources.length === 1 ? "" : "s"} refreshing` : "Sources current"}
                </Badge>
              ) : (
                <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
                  {unhealthySources.length || sourceSummary.length} source issue{(unhealthySources.length || sourceSummary.length) === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {groupSummary
                ? `${groupSummary.totalGroups.toLocaleString()} issue group${groupSummary.totalGroups === 1 ? "" : "s"} · ${groupSummary.totalAffectedRecords.toLocaleString()} affected record${groupSummary.totalAffectedRecords === 1 ? "" : "s"}`
                : "Loading operational issues"}
              {groupSummary?.generatedAt ? ` · updated ${new Date(groupSummary.generatedAt).toLocaleTimeString()}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={showSystemHealth ? "outline" : "default"}
              size="sm"
              onClick={() => setShowSystemHealth(false)}
            >
              <RadioTower className="mr-2 h-4 w-4" /> Order Flow & Issues
            </Button>
            <Button
              variant={showSystemHealth ? "default" : "outline"}
              size="sm"
              onClick={() => setShowSystemHealth(true)}
            >
              <ServerCog className="mr-2 h-4 w-4" /> System Health
            </Button>
            <Button variant="outline" size="icon" onClick={refresh} disabled={groupQuery.isFetching} title="Refresh Control Tower">
              <RefreshCw className={cn("h-4 w-4", groupQuery.isFetching && "animate-spin")} />
            </Button>
          </div>
        </div>
      </header>

      {showSystemHealth ? (
        <SystemHealthView
          data={sourcesQuery.data}
          flow={flowQuery.data}
          loading={sourcesQuery.isLoading}
          error={sourcesQuery.error}
          canTriage={hasPermission("operations", "triage")}
        />
      ) : (
        <>
          <FlowOverview
            data={flowQuery.data}
            loading={flowQuery.isLoading}
            error={flowQuery.error}
            canReplay={hasPermission("operations", "triage")}
            canAdjustInventory={hasPermission("inventory", "adjust")}
          />
          <div className="border-b px-4 lg:px-6">
            <div className="grid grid-cols-2 gap-1 py-2 sm:grid-cols-4">
              {VIEW_CONFIG.map((tab) => (
                <Button
                  key={tab.value}
                  variant="ghost"
                  size="sm"
                  onClick={() => setView(tab.value)}
                  className={cn(
                    "w-full justify-between rounded-none border-b-2 border-transparent",
                    view === tab.value && "border-primary bg-muted/60 text-foreground",
                  )}
                >
                  {tab.label}
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums">
                    {groupSummary?.viewCounts[tab.countKey] ?? 0}
                  </span>
                </Button>
              ))}
            </div>
          </div>

          <div className="border-b bg-muted/20 px-4 py-3 lg:px-6">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[240px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Search order, SKU, PO, issue, or code"
                  className="pl-9"
                />
                {searchInput && (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"
                    onClick={() => setSearchInput("")}
                    title="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <Select value={domain} onValueChange={(value) => setDomain(value as Domain | "all")}>
                <SelectTrigger className="w-[160px]"><SelectValue placeholder="All domains" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All domains</SelectItem>
                  {Object.entries(DOMAIN_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={severity} onValueChange={(value) => setSeverity(value as Severity | "all")}>
                <SelectTrigger className="w-[150px]"><SelectValue placeholder="All severities" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All severities</SelectItem>
                  <SelectItem value="blocker">Blocker</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
              {(domain !== "all" || severity !== "all" || searchInput) && (
                <Button variant="ghost" size="sm" onClick={resetFilters}>Clear</Button>
              )}
            </div>
          </div>

          {mutationError && (
            <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800 lg:px-6">
              {mutationError instanceof Error ? mutationError.message : "The work item could not be updated"}
            </div>
          )}

          <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_440px]">
            <section className="min-w-0 border-r">
              <div className="hidden grid-cols-[96px_minmax(0,1fr)_110px_86px_150px_28px] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium uppercase text-muted-foreground md:grid">
                <span>Severity</span><span>Root cause</span><span>Affected</span><span>Oldest</span><span>Owner</span><span />
              </div>
              {groupQuery.isLoading ? (
                <QueueSkeleton />
              ) : groupQuery.isError ? (
                <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
                  <AlertTriangle className="h-8 w-8 text-red-600" />
                  <div className="font-medium">Issue groups failed to load</div>
                  <div className="max-w-lg text-sm text-muted-foreground">{groupQuery.error instanceof Error ? groupQuery.error.message : "Unknown error"}</div>
                  <Button variant="outline" onClick={() => groupQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" /> Retry</Button>
                </div>
              ) : groups.length === 0 ? (
                <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 p-8 text-center">
                  <CheckCircle2 className="h-9 w-9 text-emerald-600" />
                  <div className="font-medium">No matching issue groups</div>
                  <div className="text-sm text-muted-foreground">No operational root cause matches the current view and filters.</div>
                </div>
              ) : (
                <div className="divide-y">
                  {groups.map((group) => (
                    <button
                      type="button"
                      key={group.groupKey}
                      onClick={() => openGroup(group.groupKey)}
                      className={cn(
                        "grid w-full grid-cols-[86px_minmax(0,1fr)] gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40 md:grid-cols-[96px_minmax(0,1fr)_110px_86px_150px_28px] md:gap-3",
                        selectedGroupKey === group.groupKey && selectedId === null && "bg-primary/5 ring-1 ring-inset ring-primary/30",
                      )}
                    >
                      <div>
                        <Badge variant="outline" className={cn("gap-1 text-[10px] uppercase", severityClass(group.severity))}>
                          {severityIcon(group.severity)} {group.severity}
                        </Badge>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{group.title}</span>
                          <Badge variant="outline" className="text-[10px]">{DOMAIN_LABEL[group.domain]}</Badge>
                          {group.urgency !== "normal" && (
                            <span className="text-xs font-medium text-orange-700">{humanize(group.urgency)}</span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{group.summary}</p>
                        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                          <span className="font-mono">{group.code}</span>
                          {group.sampleEntityRefs.slice(0, 2).map((entityRef) => <span className="hidden sm:inline" key={entityRef}>{entityRef}</span>)}
                        </div>
                      </div>
                      <div className="col-start-2 flex gap-3 text-sm tabular-nums md:col-start-auto md:block md:pt-1">
                        <div className="font-medium">{group.affectedRecords.toLocaleString()} record{group.affectedRecords === 1 ? "" : "s"}</div>
                        <div className="text-xs text-muted-foreground">{group.affectedEntities.toLocaleString()} entities</div>
                      </div>
                      <div className="hidden text-sm tabular-nums text-muted-foreground md:block md:pt-1">{formatAge(group.ageMinutes)}</div>
                      <div className="hidden min-w-0 text-sm md:block md:pt-1">
                        <div className="truncate">{group.ownerTeam || "Unassigned"}</div>
                      </div>
                      <ChevronRight className="hidden h-4 w-4 self-center text-muted-foreground md:block" />
                    </button>
                  ))}
                  {groupQuery.hasNextPage && (
                    <div className="p-3 text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => groupQuery.fetchNextPage()}
                        disabled={groupQuery.isFetchingNextPage}
                      >
                        {groupQuery.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Load more groups
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </section>

            <aside className="hidden min-h-[520px] bg-background lg:sticky lg:top-0 lg:block lg:max-h-[calc(100vh-64px)]">
              {renderDetailPane()}
            </aside>
          </main>

          <Sheet open={compactDetailLayout && compactDetailOpen} onOpenChange={setCompactDetailOpen}>
            <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl lg:hidden">
              <SheetTitle className="sr-only">Work item detail</SheetTitle>
              {renderDetailPane()}
            </SheetContent>
          </Sheet>
        </>
      )}

      <Dialog open={snoozeOpen} onOpenChange={setSnoozeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Snooze work item</DialogTitle>
            <DialogDescription>The item returns to Needs Attention when the review time arrives.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="control-tower-snooze-until">Review at</Label>
              <Input
                id="control-tower-snooze-until"
                type="datetime-local"
                value={snoozeUntil}
                onChange={(event) => setSnoozeUntil(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="control-tower-snooze-reason">Reason</Label>
              <Textarea
                id="control-tower-snooze-reason"
                value={snoozeReason}
                onChange={(event) => setSnoozeReason(event.target.value)}
                maxLength={500}
                placeholder="Waiting for provider response"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSnoozeOpen(false)}>Cancel</Button>
            <Button
              onClick={() => selected && snoozeMutation.mutate(selected)}
              disabled={!selected || !snoozeReason.trim() || snoozeMutation.isPending}
            >
              {snoozeMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FlowOverview(props: {
  data: FlowOverviewResponse | undefined;
  loading: boolean;
  error: Error | null;
  canReplay: boolean;
  canAdjustInventory: boolean;
}) {
  const { toast } = useToast();
  const snapshot = props.data?.snapshot ?? null;
  const [selectedStageKey, setSelectedStageKey] = useState<string | null>(null);
  const [selectedIssueCode, setSelectedIssueCode] = useState<string | null>(null);
  const [unmappedTarget, setUnmappedTarget] = useState<ShipStationUnmappedTarget | null>(null);
  const stages = useMemo(() => {
    if (!snapshot) return [];
    return [
      { key: "source", label: "Sales channel observed", count: snapshot.funnel.sourceObserved ?? snapshot.funnel.entered, icon: RadioTower, issueStages: ["intake"] as FlowIssueStage[] },
      { key: "entered", label: "OMS received", count: snapshot.funnel.entered, icon: Inbox, issueStages: [] as FlowIssueStage[] },
      { key: "wms", label: "Reached WMS", count: snapshot.funnel.reachedWms, icon: Boxes, issueStages: ["oms_to_wms"] as FlowIssueStage[] },
      { key: "shipment", label: "Shipment created", count: snapshot.funnel.hasShipment, icon: PackageCheck, issueStages: ["wms_fulfill", "engine_push"] as FlowIssueStage[] },
      { key: "shipped", label: "Shipped", count: snapshot.funnel.shipped, icon: Truck, issueStages: ["shipped"] as FlowIssueStage[] },
      { key: "confirmed", label: "Channel updated", count: snapshot.funnel.trackingConfirmed, icon: CheckCircle2, issueStages: ["writeback"] as FlowIssueStage[] },
    ].map((stage) => {
      const issues = snapshot.issues
        .filter((issue) => stage.issueStages.includes(issue.stage))
        .sort((left, right) => FLOW_SEVERITY_ORDER[left.severity] - FLOW_SEVERITY_ORDER[right.severity] || right.count - left.count);
      return {
        ...stage,
        issues,
        monitorMatches: issues.reduce((total, issue) => total + issue.count, 0),
      };
    });
  }, [snapshot]);
  const channelIntake = useMemo(() => {
    if (!snapshot) return [];
    if (snapshot.channelIntake) return snapshot.channelIntake;
    return snapshot.channels.map((channel) => ({
      channelId: null,
      channelName: humanize(channel.provider),
      provider: channel.provider,
      observed: channel.entered,
      omsReceived: channel.entered,
      pending: 0,
      missing: 0,
      failed: 0,
      lastObservedAt: null,
    }));
  }, [snapshot]);
  const selectedStage = stages.find((stage) => stage.key === selectedStageKey) ?? null;
  const selectedIssue = selectedStage?.issues.find((issue) => issue.code === selectedIssueCode) ?? null;

  useEffect(() => {
    if (!selectedStage) return;
    if (selectedStage.issues.some((issue) => issue.code === selectedIssueCode)) return;
    setSelectedIssueCode(selectedStage.issues[0]?.code ?? null);
  }, [selectedIssueCode, selectedStage]);

  const bucketQuery = useQuery({
    queryKey: ["oms-flow-bucket", selectedIssueCode, snapshot?.windowDays],
    queryFn: () => fetchJson<FlowBucketResponse>(
      `/api/oms/ops/flow-bucket/${encodeURIComponent(selectedIssueCode!)}?windowDays=${snapshot!.windowDays}`,
    ),
    enabled: selectedIssueCode !== null && selectedStage !== null && snapshot !== null,
    staleTime: 60_000,
    refetchInterval: (query) => {
      const activity = (query.state.data as FlowBucketResponse | undefined)?.replayActivity ?? [];
      return activity.some((item) => item.outcome === "queued" || item.outcome === "retrying")
        ? 5_000
        : false;
    },
  });

  const replayActivity = bucketQuery.data?.replayActivity ?? [];
  const replayActivityByOrderId = useMemo(() => {
    const indexed = new Map<string, FlowReplayActivity>();
    for (const activity of replayActivity) {
      const key = replayActivityKey(activity.oms_order_id);
      if (key) indexed.set(key, activity);
    }
    return indexed;
  }, [replayActivity]);

  const replayMutation = useMutation({
    mutationFn: async (action: FlowReplayAction) => {
      const response = await apiRequest("POST", action.endpoint, action.body);
      const result = await response.json() as FlowReplayResponse;
      return { action, result };
    },
    onSuccess: async ({ action, result }) => {
      const retryDescription = result.provider && result.topic && result.retryQueueId
        ? `${result.provider}/${result.topic} retry #${result.retryQueueId}`
        : humanize(result.action || "replay not queued");
      toast({
        title: result.changed === false
          ? result.retryQueueId ? "Replay already queued" : "Replay not needed"
          : action.successTitle,
        description: retryDescription,
      });
      await bucketQuery.refetch();
    },
    onError: (error: Error) => {
      toast({
        title: "Replay failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const openStage = (stage: (typeof stages)[number]) => {
    if (stage.issues.length === 0) return;
    setSelectedStageKey(stage.key);
    setSelectedIssueCode(stage.issues[0].code);
  };

  const closeStage = () => {
    setUnmappedTarget(null);
    setSelectedStageKey(null);
    setSelectedIssueCode(null);
  };

  return (
    <section className="border-b bg-muted/10 px-4 py-4 lg:px-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Order flow</h2>
          <p className="text-xs text-muted-foreground">
            {snapshot ? `Last ${snapshot.windowDays} days · refreshed ${formatTimestamp(snapshot.generatedAt)}` : "Waiting for the first background snapshot"}
          </p>
        </div>
        {props.data && (
          <Badge
            variant="outline"
            className={cn(
              props.data.status === "current" && "border-emerald-300 bg-emerald-50 text-emerald-800",
              props.data.status === "refreshing" && "border-blue-300 bg-blue-50 text-blue-800",
              !["current", "refreshing"].includes(props.data.status) && "border-amber-300 bg-amber-50 text-amber-800",
            )}
          >
            {humanize(props.data.status)}
          </Badge>
        )}
      </div>

      {props.loading ? (
        <div className="grid gap-2 md:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-20 w-full" />)}
        </div>
      ) : props.error ? (
        <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{props.error.message}</div>
      ) : snapshot ? (
        <>
          <div className="grid grid-cols-2 overflow-hidden border md:grid-cols-6">
            {stages.map((stage, index) => {
              const priorCount = index === 0 ? null : stages[index - 1].count;
              const gap = priorCount === null ? null : Math.max(0, priorCount - stage.count);
              const Icon = stage.icon;
              return (
                <button
                  type="button"
                  key={stage.key}
                  onClick={() => openStage(stage)}
                  disabled={stage.issues.length === 0}
                  className={cn(
                    "relative min-w-0 border-b border-r p-3 text-left even:border-r-0 md:border-b-0 md:border-r md:even:border-r md:last:border-r-0",
                    stage.issues.length > 0 && "cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
                  )}
                  aria-label={stage.issues.length > 0 ? `Review ${stage.label} exceptions` : `${stage.label}: no open exceptions`}
                >
                  <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
                    <Icon className="h-4 w-4" /> {stage.label}
                  </div>
                  <div className="mt-2 text-2xl font-semibold tabular-nums">{stage.count.toLocaleString()}</div>
                  {gap !== null && <div className="mt-1 text-xs text-orange-700">{gap.toLocaleString()} not yet advanced</div>}
                  {stage.issues.length > 0 ? (
                    <div className="mt-2 text-xs font-medium text-red-700">
                      {stage.issues.length.toLocaleString()} exception type{stage.issues.length === 1 ? "" : "s"} · {stage.monitorMatches.toLocaleString()} monitor matches
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-emerald-700">No open exceptions</div>
                  )}
                  {index < stages.length - 1 && <ArrowRight className="absolute -right-2.5 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 bg-background text-muted-foreground md:block" />}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span><strong>{snapshot.crossSystem.wmsShippedOmsOpen.toLocaleString()}</strong> shipped orders still open upstream</span>
            <span><strong>{snapshot.crossSystem.omsNotUpdated.toLocaleString()}</strong> fulfillment writebacks incomplete</span>
            <span><strong>{snapshot.sla.breached.toLocaleString()}</strong> orders past ship-by date</span>
          </div>
          <div className="mt-4 overflow-x-auto border">
            <div className="border-b bg-muted/30 px-3 py-2">
              <h3 className="text-sm font-semibold">Channel order intake</h3>
              <p className="text-xs text-muted-foreground">Physical orders reported by each sales channel compared with OMS receipts.</p>
            </div>
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b bg-muted/20 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 text-right font-medium">Source seen</th>
                  <th className="px-3 py-2 text-right font-medium">OMS received</th>
                  <th className="px-3 py-2 text-right font-medium">Awaiting</th>
                  <th className="px-3 py-2 text-right font-medium">Missing</th>
                  <th className="px-3 py-2 text-right font-medium">Failed</th>
                  <th className="px-3 py-2 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {channelIntake.map((channel) => (
                  <tr key={`${channel.provider}:${channel.channelId ?? channel.channelName}`}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{channel.channelName}</div>
                      <div className="text-xs text-muted-foreground">{humanize(channel.provider)}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{channel.observed.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{channel.omsReceived.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-amber-700">{channel.pending.toLocaleString()}</td>
                    <td className={cn("px-3 py-2 text-right tabular-nums", channel.missing > 0 && "font-semibold text-red-700")}>{channel.missing.toLocaleString()}</td>
                    <td className={cn("px-3 py-2 text-right tabular-nums", channel.failed > 0 && "font-semibold text-red-700")}>{channel.failed.toLocaleString()}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs text-muted-foreground">
                      {channel.lastObservedAt ? formatTimestamp(channel.lastObservedAt) : "Not recorded"}
                    </td>
                  </tr>
                ))}
                {channelIntake.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-5 text-center text-muted-foreground">No physical channel orders were observed in this window.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The background projector has not produced an order-flow snapshot yet.
          {props.data?.lastAttempt?.errorMessage ? ` Last attempt: ${props.data.lastAttempt.errorMessage}` : ""}
        </div>
      )}

      <Dialog open={selectedStage !== null} onOpenChange={(open) => { if (!open) closeStage(); }}>
        <DialogContent className="max-h-[92vh] overflow-hidden p-0 sm:max-w-5xl">
          <DialogHeader className="border-b px-5 py-4 text-left">
            <DialogTitle>{selectedStage?.label} exceptions</DialogTitle>
            <DialogDescription>
              {selectedStage
                ? `${selectedStage.issues.length.toLocaleString()} root cause${selectedStage.issues.length === 1 ? "" : "s"} · ${selectedStage.monitorMatches.toLocaleString()} snapshot matches in the last ${snapshot?.windowDays ?? 30} days`
                : "Order-flow exceptions"}
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 md:grid-cols-[310px_minmax(0,1fr)]">
            <ScrollArea className="max-h-52 border-b md:h-[68vh] md:max-h-none md:border-b-0 md:border-r">
              <div className="divide-y">
                {selectedStage?.issues.map((issue) => (
                  <button
                    type="button"
                    key={issue.code}
                    onClick={() => setSelectedIssueCode(issue.code)}
                    className={cn(
                      "w-full px-4 py-3 text-left hover:bg-muted/50",
                      selectedIssueCode === issue.code && "bg-primary/5 ring-1 ring-inset ring-primary/30",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <Badge variant="outline" className={cn("text-[10px] uppercase", flowSeverityClass(issue.severity))}>{issue.severity}</Badge>
                      <span className="text-sm font-semibold tabular-nums">{issue.count.toLocaleString()}</span>
                    </div>
                    <div className="mt-2 text-sm font-medium leading-snug">{issue.message}</div>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">{issue.code}</div>
                  </button>
                ))}
              </div>
            </ScrollArea>

            <ScrollArea className="h-[55vh] md:h-[68vh]">
              {selectedIssue ? (
                <div className="space-y-5 p-5">
                  <section>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={cn("text-[10px] uppercase", flowSeverityClass(selectedIssue.severity))}>{selectedIssue.severity}</Badge>
                      <Badge variant="outline">{humanize(selectedIssue.kind)}</Badge>
                      <Badge variant="secondary">{humanize(selectedIssue.remediation)}</Badge>
                    </div>
                    <h3 className="mt-3 text-lg font-semibold">{selectedIssue.message}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">{selectedIssue.why || "No operator guidance is recorded for this exception."}</p>
                    <div className="mt-3 text-xs text-muted-foreground">
                      Replay {selectedIssue.replaySafe ? "is marked safe after the underlying cause is corrected" : "requires review before it is attempted"}.
                    </div>
                  </section>

                  {replayActivity.length > 0 && (
                    <section className="border-t pt-4">
                      <div className="mb-3">
                        <div className="text-xs font-semibold uppercase text-muted-foreground">Recent replay activity</div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Queue and WMS outcomes update automatically while work is pending.
                        </p>
                      </div>
                      <div className="divide-y border-y">
                        {replayActivity.map((activity) => (
                          <div key={activity.retry_id} className="py-3">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <div className="min-w-0">
                                <div className="text-sm font-medium">
                                  {activity.order_number || `OMS order ${activity.oms_order_id}`}
                                </div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  Retry {activity.retry_id} requested {formatTimestamp(activity.requested_at)}
                                </div>
                              </div>
                              <Badge variant="outline" className={cn("w-fit", replayOutcomeClass(activity.outcome))}>
                                {replayOutcomeIcon(activity.outcome)}
                                {replayOutcomeLabel(activity.outcome)}
                              </Badge>
                            </div>
                            <p className={cn(
                              "mt-2 text-xs",
                              activity.outcome === "failed" || activity.outcome === "unresolved"
                                ? "text-red-800"
                                : "text-muted-foreground",
                            )}>
                              {replayOutcomeDescription(activity)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  <section className="border-t pt-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase text-muted-foreground">Current evidence</div>
                        <p className="mt-1 text-xs text-muted-foreground">Up to 50 current records from this exact monitor condition.</p>
                      </div>
                      <span className="text-right text-xs tabular-nums text-muted-foreground">
                        Live {bucketQuery.data?.rows.length.toLocaleString() ?? "-"} · snapshot {selectedIssue.count.toLocaleString()}
                      </span>
                    </div>

                    {bucketQuery.isLoading ? (
                      <div className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
                    ) : bucketQuery.isError ? (
                      <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                        <div>{bucketQuery.error instanceof Error ? bucketQuery.error.message : "Evidence failed to load"}</div>
                        <Button className="mt-3" size="sm" variant="outline" onClick={() => bucketQuery.refetch()}>Retry evidence query</Button>
                      </div>
                    ) : bucketQuery.data?.rows.length ? (
                      <div className="divide-y border-y">
                        {bucketQuery.data.rows.map((row, index) => {
                          const orderReference = flowOrderReference(row);
                          const replayStatus = replayActivityByOrderId.get(
                            replayActivityKey(row.oms_order_id) ?? "",
                          ) ?? null;
                          const classificationTarget = selectedIssue.code === "UNMAPPED_ENGINE_SPLIT"
                            ? shipStationUnmappedTarget(row, index)
                            : null;
                          const replayAction = props.canReplay && selectedIssue.code !== "UNMAPPED_ENGINE_SPLIT"
                            ? resolveFlowReplayAction(selectedIssue, replayStatus
                              ? {
                                  ...row,
                                  _replay_outcome: replayStatus.outcome,
                                  _replay_retry_id: replayStatus.retry_id,
                                }
                              : row)
                            : null;
                          const replayingThisRow = replayMutation.isPending
                            && replayMutation.variables?.kind === replayAction?.kind
                            && replayMutation.variables?.sourceId === replayAction?.sourceId;
                          const fields = Object.entries(row).filter(([key, value]) => (
                            value !== null
                            && value !== undefined
                            && !key.startsWith("_")
                            && !["order_number", "external_order_number", "channel_order_number"].includes(key)
                          ));
                          return (
                            <div key={`${selectedIssue.code}-${index}`} className="py-3">
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0 truncate text-sm font-medium">{flowRecordTitle(row, index)}</div>
                                <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                                  {replayStatus && (
                                    <Badge variant="outline" className={replayOutcomeClass(replayStatus.outcome)}>
                                      {replayOutcomeIcon(replayStatus.outcome)}
                                      {replayOutcomeLabel(replayStatus.outcome)}
                                    </Badge>
                                  )}
                                  {props.canReplay && classificationTarget && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setUnmappedTarget(classificationTarget)}
                                    >
                                      <PackageCheck className="mr-2 h-3.5 w-3.5" />
                                      Review shipment
                                    </Button>
                                  )}
                                  {replayAction && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={replayMutation.isPending}
                                      onClick={() => replayMutation.mutate(replayAction)}
                                    >
                                      {replayingThisRow
                                        ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                        : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
                                      {replayingThisRow ? replayAction.pendingLabel : replayAction.label}
                                    </Button>
                                  )}
                                  {orderReference && (
                                    <Button variant="ghost" size="sm" asChild>
                                      <a href={`/oms/orders?search=${encodeURIComponent(orderReference)}`}>Open order<ExternalLink className="ml-2 h-3.5 w-3.5" /></a>
                                    </Button>
                                  )}
                                </div>
                              </div>
                              <dl className="mt-2 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                                {fields.map(([key, value]) => (
                                  <div key={key} className={cn("min-w-0", ["last_error", "review_reason", "why"].includes(key) && "sm:col-span-2")}>
                                    <dt className="font-medium text-muted-foreground">{humanize(key)}</dt>
                                    <dd className="mt-0.5 break-words">{formatFlowRecordValue(key, value)}</dd>
                                  </div>
                                ))}
                              </dl>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="border bg-muted/20 p-4 text-sm text-muted-foreground">
                        No records currently match this condition. Successful replays have cleared from the live list;
                        the snapshot count updates on the next background refresh, normally within five minutes.
                      </div>
                    )}
                  </section>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Select an exception type.</div>
              )}
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
      <ShipStationReshipAdoptionDialog
        target={unmappedTarget}
        canAdjustInventory={props.canAdjustInventory}
        onClose={() => setUnmappedTarget(null)}
        onCompleted={async () => { await bucketQuery.refetch(); }}
      />
    </section>
  );
}

function IssueGroupDetailPanel(props: {
  group: IssueGroup;
  instances: QueueItem[];
  hasNextPage: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenInstance: (id: number) => void;
}) {
  return (
    <ScrollArea className="h-full lg:max-h-[calc(100vh-64px)]">
      <div className="border-b p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={cn("gap-1 text-[10px] uppercase", severityClass(props.group.severity))}>
            {severityIcon(props.group.severity)} {props.group.severity}
          </Badge>
          <Badge variant="outline">{DOMAIN_LABEL[props.group.domain]}</Badge>
          <Badge variant="secondary">{humanize(props.group.triageStatus)}</Badge>
        </div>
        <h2 className="mt-3 text-lg font-semibold leading-tight">{props.group.title}</h2>
        <div className="mt-1 font-mono text-xs text-muted-foreground">{props.group.code}</div>
        <div className="mt-4 grid grid-cols-2 gap-4 border-y py-3 text-sm">
          <div><div className="text-xs uppercase text-muted-foreground">Affected records</div><div className="mt-1 text-xl font-semibold tabular-nums">{props.group.affectedRecords.toLocaleString()}</div></div>
          <div><div className="text-xs uppercase text-muted-foreground">Affected entities</div><div className="mt-1 text-xl font-semibold tabular-nums">{props.group.affectedEntities.toLocaleString()}</div></div>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>First detected {formatTimestamp(props.group.firstSeenAt)}</span>
          <span>Last checked {formatTimestamp(props.group.lastSeenAt)}</span>
          <span>Last changed {formatTimestamp(props.group.lastChangedAt)}</span>
        </div>
      </div>

      <div className="space-y-5 p-5">
        <section className="grid gap-3">
          <div className="border-l-4 border-emerald-500 bg-emerald-50 p-3">
            <div className="text-xs font-semibold uppercase text-emerald-800">Expected</div>
            <p className="mt-1 text-sm text-emerald-950">{props.group.expectedState}</p>
          </div>
          <div className="border-l-4 border-orange-500 bg-orange-50 p-3">
            <div className="text-xs font-semibold uppercase text-orange-800">Observed pattern</div>
            <p className="mt-1 text-sm text-orange-950">{props.group.actualState}</p>
          </div>
        </section>

        <section className="border-y py-4">
          <div className="text-xs font-semibold uppercase text-muted-foreground">Next action</div>
          <p className="mt-1 text-sm">{props.group.recommendedAction}</p>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase text-muted-foreground">Affected records</div>
              <div className="mt-1 text-xs text-muted-foreground">Inspect an exact record before changing source data.</div>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{props.instances.length.toLocaleString()} loaded</span>
          </div>
          <div className="divide-y border-y">
            {props.instances.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => props.onOpenInstance(item.id)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 text-left hover:text-primary"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{item.entityRef || `${humanize(item.entityType)} ${item.entityId}`}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>{humanize(item.triageStatus)}</span>
                    <span>Changed {formatTimestamp(item.lastChangedAt)}</span>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4" />
              </button>
            ))}
          </div>
          {props.hasNextPage && (
            <Button className="mt-3 w-full" variant="outline" size="sm" onClick={props.onLoadMore} disabled={props.loadingMore}>
              {props.loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Load more affected records
            </Button>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

function WorkItemDetailPanel(props: {
  detail: WorkItemDetail;
  users: UserOption[];
  currentUserId: string | null;
  canTriage: boolean;
  canAssign: boolean;
  canViewTechnical: boolean;
  technicalEvidenceRequested: boolean;
  onLoadTechnical: () => void;
  onAcknowledge: () => void;
  onAssign: (userId: string | null) => void;
  onSnooze: () => void;
  onSelectRelated: (id: number) => void;
  onBack: () => void;
  busy: boolean;
}) {
  const { item } = props.detail;
  const primaryLink = item.availableActions.find((action) => action.kind === "navigate")
    ?? item.detailLocator.links?.[0]
    ?? null;

  return (
    <ScrollArea className="h-full lg:max-h-[calc(100vh-64px)]">
      <div className="border-b p-5">
        <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={props.onBack}>
          <ArrowRight className="mr-2 h-4 w-4 rotate-180" /> Back to root cause
        </Button>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={cn("gap-1 text-[10px] uppercase", severityClass(item.severity))}>
                {severityIcon(item.severity)} {item.severity}
              </Badge>
              <Badge variant="outline">{DOMAIN_LABEL[item.domain]}</Badge>
              <Badge variant="secondary">{humanize(item.triageStatus)}</Badge>
            </div>
            <h2 className="mt-3 text-lg font-semibold leading-tight">{item.title}</h2>
            <div className="mt-1 text-sm font-medium text-muted-foreground">
              {item.entityRef || `${humanize(item.entityType)} ${item.entityId}`}
            </div>
          </div>
          {primaryLink && (
            <Button variant="outline" size="icon" asChild title={primaryLink.label}>
              <a href={primaryLink.href}><ArrowUpRight className="h-4 w-4" /></a>
            </Button>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{formatAge(item.ageMinutes)} old</span>
          <span className="font-mono">{item.code}</span>
          <span>{item.occurrenceCount} monitor check{item.occurrenceCount === 1 ? "" : "s"}</span>
          {item.recurrenceCount > 0 && <span>{item.recurrenceCount} recurrence{item.recurrenceCount === 1 ? "" : "s"}</span>}
        </div>
      </div>

      <div className="space-y-5 p-5">
        <section className="grid gap-3">
          <div className="border-l-4 border-emerald-500 bg-emerald-50 p-3">
            <div className="text-xs font-semibold uppercase text-emerald-800">Expected</div>
            <p className="mt-1 text-sm text-emerald-950">{item.expectedState}</p>
          </div>
          <div className="border-l-4 border-orange-500 bg-orange-50 p-3">
            <div className="text-xs font-semibold uppercase text-orange-800">Actual</div>
            <p className="mt-1 text-sm text-orange-950">{item.actualState}</p>
          </div>
        </section>

        <section className="border-y py-4">
          <div className="text-xs font-semibold uppercase text-muted-foreground">Next action</div>
          <p className="mt-1 text-sm">{item.recommendedAction}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {item.triageStatus === "needs_attention"
              && props.canTriage
              && props.currentUserId
              && (!item.assignedUserId || item.assignedUserId === props.currentUserId) && (
              <Button size="sm" onClick={props.onAcknowledge} disabled={props.busy}>
                {props.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                {item.assignedUserId === props.currentUserId ? "Start work" : "Take ownership"}
              </Button>
            )}
            {item.triageStatus !== "resolved" && props.canTriage && (
              <Button size="sm" variant="outline" onClick={props.onSnooze} disabled={props.busy}>
                <Clock3 className="mr-2 h-4 w-4" /> Snooze
              </Button>
            )}
            {primaryLink && (
              <Button size="sm" variant="outline" asChild>
                <a href={primaryLink.href}>{primaryLink.label}<ExternalLink className="ml-2 h-4 w-4" /></a>
              </Button>
            )}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase text-muted-foreground">Ownership</div>
              <div className="mt-1 text-sm">{item.ownerTeam || "No team"}</div>
            </div>
            {props.canAssign && item.triageStatus !== "resolved" && (
              <Select
                value={item.assignedUserId ?? "unassigned"}
                onValueChange={(value) => props.onAssign(value === "unassigned" ? null : value)}
                disabled={props.busy}
              >
                <SelectTrigger className="w-[190px]"><UserRound className="mr-2 h-4 w-4" /><SelectValue placeholder="Assign" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {props.users.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.displayName || candidate.username}
                      {candidate.id === props.currentUserId ? " (you)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {item.assignedUserName && <div className="text-sm text-muted-foreground">Assigned to {item.assignedUserName}</div>}
          {item.nextReviewAt && <div className="mt-1 text-sm text-muted-foreground">Review {formatTimestamp(item.nextReviewAt)}</div>}
        </section>

        <section>
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
            <History className="h-4 w-4" /> Timeline
          </div>
          <div className="space-y-0">
            {props.detail.observations.map((observation, index) => (
              <div key={observation.id} className="relative grid grid-cols-[18px_minmax(0,1fr)] gap-3 pb-4">
                {index < props.detail.observations.length - 1 && <div className="absolute left-[7px] top-4 h-full w-px bg-border" />}
                <div className="relative z-10 mt-1 h-3.5 w-3.5 rounded-full border-2 border-background bg-muted-foreground" />
                <div>
                  <div className="text-sm font-medium">{humanize(observation.observation_kind)}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatTimestamp(observation.created_at)}
                    {observation.actor_name ? ` - ${observation.actor_name}` : ""}
                  </div>
                  {observation.note && <p className="mt-1 text-sm text-muted-foreground">{observation.note}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>

        {props.detail.relatedItems.length > 0 && (
          <section>
            <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Related work</div>
            <div className="divide-y border-y">
              {props.detail.relatedItems.map((related) => (
                <button
                  type="button"
                  key={related.id}
                  onClick={() => props.onSelectRelated(related.id)}
                  className="flex w-full items-center justify-between gap-3 py-2 text-left text-sm hover:text-primary"
                >
                  <span className="min-w-0 truncate">{related.entity_ref || related.title}</span>
                  <ChevronRight className="h-4 w-4 shrink-0" />
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="border-t pt-4">
          <button
            type="button"
            className="flex w-full items-center justify-between text-left text-sm font-medium"
            onClick={props.onLoadTechnical}
            disabled={!props.canViewTechnical || props.technicalEvidenceRequested}
          >
            <span>Technical evidence</span>
            <ChevronDown className={cn("h-4 w-4", props.technicalEvidenceRequested && "rotate-180")} />
          </button>
          {!props.canViewTechnical && <p className="mt-2 text-xs text-muted-foreground">Technical evidence requires additional permission.</p>}
          {props.technicalEvidenceRequested && item.technicalEvidence && (
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words border bg-muted/40 p-3 text-xs">
              {JSON.stringify(item.technicalEvidence, null, 2)}
            </pre>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

function SystemHealthView(props: {
  data: SourceHealthResponse | undefined;
  flow: FlowOverviewResponse | undefined;
  loading: boolean;
  error: Error | null;
  canTriage: boolean;
}) {
  return (
    <main className="flex-1 p-4 lg:p-6">
      <div className="mx-auto max-w-6xl">
        <FinancialCommandOperations canTriage={props.canTriage} />
        <section className="mb-7">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">System controls</h2>
              <p className="text-sm text-muted-foreground">Missing safeguards and schema controls that require engineering work, not order-by-order triage.</p>
            </div>
            {props.flow && <Badge variant="outline">Flow snapshot: {humanize(props.flow.status)}</Badge>}
          </div>
          <div className="divide-y border">
            {props.loading ? (
              <div className="space-y-3 p-4"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
            ) : props.data?.controlGaps.length ? (
              props.data.controlGaps.map((gap) => (
                <div key={gap.groupKey} className="grid gap-2 px-4 py-3 md:grid-cols-[100px_minmax(0,1fr)_120px] md:gap-4">
                  <Badge variant="outline" className={cn("h-fit w-fit gap-1 text-[10px] uppercase", severityClass(gap.severity))}>
                    {severityIcon(gap.severity)} {gap.severity}
                  </Badge>
                  <div className="min-w-0">
                    <div className="font-medium">{gap.title}</div>
                    <p className="mt-0.5 text-sm text-muted-foreground">{gap.summary}</p>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{gap.code}</div>
                  </div>
                  <div className="text-sm tabular-nums md:text-right">
                    <div className="font-medium">{gap.affectedRecords.toLocaleString()} record{gap.affectedRecords === 1 ? "" : "s"}</div>
                    <div className="text-xs text-muted-foreground">Changed {formatTimestamp(gap.lastChangedAt)}</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex items-center gap-2 px-4 py-5 text-sm text-emerald-800">
                <CheckCircle2 className="h-5 w-5" /> No projected system-control gaps.
              </div>
            )}
          </div>
        </section>

        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Projection Sources</h2>
          </div>
          {props.data && <span className="text-xs text-muted-foreground">Stale after {props.data.staleAfterMinutes}m</span>}
        </div>
        <div className="overflow-x-auto border">
          <div className="grid min-w-[900px] grid-cols-[minmax(180px,1fr)_130px_110px_90px_120px_minmax(180px,1fr)] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
            <span>Source</span><span>Status</span><span>Open records</span><span>Controls</span><span>Last run</span><span>Result</span>
          </div>
          {props.loading ? (
            <div className="space-y-3 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
          ) : props.error ? (
            <div className="p-6 text-sm text-red-700">{props.error.message}</div>
          ) : (
            <div className="min-w-[900px] divide-y">
              {props.data?.sources.map((source) => (
                <div key={source.name} className="grid grid-cols-[minmax(180px,1fr)_130px_110px_90px_120px_minmax(180px,1fr)] items-center gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0"><div className="font-medium">{humanize(source.name)}</div><div className="truncate text-xs text-muted-foreground">{source.sourceNamespace}</div></div>
                  <SourceStatusBadge status={source.status} />
                  <span className="tabular-nums">{source.openItemCount.toLocaleString()}</span>
                  <span className="tabular-nums">{source.controlGapCount.toLocaleString()}</span>
                  <span className="text-muted-foreground">{source.ageMinutes == null ? "Never" : formatAge(source.ageMinutes)}</span>
                  <div className="min-w-0 text-xs text-muted-foreground">
                    {source.lastRun ? (
                      <>
                        <div>{Number(source.lastRun.rows_scanned ?? 0).toLocaleString()} scanned, {Number(source.lastRun.rows_failed ?? 0).toLocaleString()} failed</div>
                        {source.lastRun.error_message && <div className="truncate text-red-700">{String(source.lastRun.error_message)}</div>}
                      </>
                    ) : "No projection run recorded"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function SourceStatusBadge({ status }: { status: SourceHealthResponse["sources"][number]["status"] }) {
  const healthy = status === "healthy";
  const refreshing = status === "refreshing";
  const failed = status === "failed";
  return (
    <Badge
      variant="outline"
      className={cn(
        "w-fit capitalize",
        healthy && "border-emerald-300 bg-emerald-50 text-emerald-800",
        refreshing && "border-blue-300 bg-blue-50 text-blue-800",
        failed && "border-red-300 bg-red-50 text-red-800",
        !healthy && !refreshing && !failed && "border-amber-300 bg-amber-50 text-amber-800",
      )}
    >
      {healthy ? <CheckCircle2 className="mr-1 h-3 w-3" /> : failed ? <AlertTriangle className="mr-1 h-3 w-3" /> : refreshing ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Clock3 className="mr-1 h-3 w-3" />}
      {humanize(status)}
    </Badge>
  );
}
