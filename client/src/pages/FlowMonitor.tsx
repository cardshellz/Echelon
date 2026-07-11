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
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  ExternalLink,
  History,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  ServerCog,
  ShieldAlert,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type Domain = "oms" | "wms" | "shipping" | "inventory" | "procurement";
type Severity = "blocker" | "high" | "medium" | "low";
type TowerView = "attention" | "in_progress" | "waiting" | "resolved";

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

interface QueueResponse {
  generatedAt: string;
  total: number;
  viewCounts: {
    attention: number;
    inProgress: number;
    waiting: number;
    resolved: number;
  };
  domainCounts: Record<Domain, number>;
  items: QueueItem[];
  nextCursor: string | null;
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
    status: "healthy" | "degraded" | "failed" | "stale" | "never_run" | "version_mismatch";
    projectionVersion: number;
    openItemCount: number;
    ageMinutes?: number | null;
    lastRun: Record<string, unknown> | null;
  }>;
}

interface UserOption {
  id: string;
  username: string;
  displayName: string | null;
}

const DOMAIN_LABEL: Record<Domain, string> = {
  oms: "OMS",
  wms: "WMS",
  shipping: "Shipping",
  inventory: "Inventory",
  procurement: "Procurement",
};

const VIEW_CONFIG: Array<{ value: TowerView; label: string; countKey: keyof QueueResponse["viewCounts"] }> = [
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

function buildQueueUrl(params: {
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
  return `/api/operations/control-tower/v2/work-items?${query.toString()}`;
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

  const queueQuery = useInfiniteQuery({
    queryKey: ["operations-control-tower-v2", view, domain, severity, search],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchJson<QueueResponse>(buildQueueUrl({
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

  const pages = queueQuery.data?.pages ?? [];
  const queueSummary = pages[0] ?? null;
  const items = useMemo(() => pages.flatMap((page) => page.items), [pages]);

  useEffect(() => {
    if (selectedId !== null && items.some((item) => item.id === selectedId)) return;
    setSelectedId(items[0]?.id ?? null);
  }, [items, selectedId]);

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

  const selected = detailQuery.data?.item ?? items.find((item) => item.id === selectedId) ?? null;
  const sourceSummary = sourcesQuery.data?.sources ?? [];
  const unhealthySources = sourceSummary.filter((source) => source.status !== "healthy");
  const mutationError = acknowledgeMutation.error || assignMutation.error || snoozeMutation.error;

  const resetFilters = () => {
    setDomain("all");
    setSeverity("all");
    setSearchInput("");
    setSearch("");
  };

  const refresh = async () => {
    await Promise.all([queueQuery.refetch(), sourcesQuery.refetch(), detailQuery.refetch()]);
  };

  const openWorkItem = (id: number) => {
    setSelectedId(id);
    if (compactDetailLayout) setCompactDetailOpen(true);
  };

  const renderDetailPane = () => {
    if (selectedId === null) {
      return (
        <div className="flex h-full min-h-[420px] flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
          <Inbox className="h-8 w-8" />
          <span className="text-sm">Select a work item</span>
        </div>
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
                <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">Sources current</Badge>
              ) : (
                <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
                  {unhealthySources.length || sourceSummary.length} source issue{(unhealthySources.length || sourceSummary.length) === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {queueSummary ? `${queueSummary.total.toLocaleString()} matching work item${queueSummary.total === 1 ? "" : "s"}` : "Loading work queue"}
              {queueSummary?.generatedAt ? ` - updated ${new Date(queueSummary.generatedAt).toLocaleTimeString()}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={showSystemHealth ? "outline" : "default"}
              size="sm"
              onClick={() => setShowSystemHealth(false)}
            >
              <Inbox className="mr-2 h-4 w-4" /> Work Queue
            </Button>
            <Button
              variant={showSystemHealth ? "default" : "outline"}
              size="sm"
              onClick={() => setShowSystemHealth(true)}
            >
              <ServerCog className="mr-2 h-4 w-4" /> System Health
            </Button>
            <Button variant="outline" size="icon" onClick={refresh} disabled={queueQuery.isFetching} title="Refresh Control Tower">
              <RefreshCw className={cn("h-4 w-4", queueQuery.isFetching && "animate-spin")} />
            </Button>
          </div>
        </div>
      </header>

      {showSystemHealth ? (
        <SystemHealthView data={sourcesQuery.data} loading={sourcesQuery.isLoading} error={sourcesQuery.error} />
      ) : (
        <>
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
                    {queueSummary?.viewCounts[tab.countKey] ?? 0}
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
              <div className="hidden grid-cols-[96px_minmax(0,1fr)_86px_150px_28px] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium uppercase text-muted-foreground md:grid">
                <span>Severity</span><span>Issue</span><span>Age</span><span>Owner</span><span />
              </div>
              {queueQuery.isLoading ? (
                <QueueSkeleton />
              ) : queueQuery.isError ? (
                <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
                  <AlertTriangle className="h-8 w-8 text-red-600" />
                  <div className="font-medium">Work queue failed to load</div>
                  <div className="max-w-lg text-sm text-muted-foreground">{queueQuery.error instanceof Error ? queueQuery.error.message : "Unknown error"}</div>
                  <Button variant="outline" onClick={() => queueQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" /> Retry</Button>
                </div>
              ) : items.length === 0 ? (
                <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 p-8 text-center">
                  <CheckCircle2 className="h-9 w-9 text-emerald-600" />
                  <div className="font-medium">No matching work items</div>
                  <div className="text-sm text-muted-foreground">No projected exception matches the current view and filters.</div>
                </div>
              ) : (
                <div className="divide-y">
                  {items.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() => openWorkItem(item.id)}
                      className={cn(
                        "grid w-full gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40 md:grid-cols-[96px_minmax(0,1fr)_86px_150px_28px] md:gap-3",
                        selectedId === item.id && "bg-primary/5 ring-1 ring-inset ring-primary/30",
                      )}
                    >
                      <div>
                        <Badge variant="outline" className={cn("gap-1 text-[10px] uppercase", severityClass(item.severity))}>
                          {severityIcon(item.severity)} {item.severity}
                        </Badge>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{item.title}</span>
                          <Badge variant="outline" className="text-[10px]">{DOMAIN_LABEL[item.domain]}</Badge>
                          {item.urgency !== "normal" && (
                            <span className="text-xs font-medium text-orange-700">{humanize(item.urgency)}</span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">{item.summary}</p>
                        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">{item.entityRef || `${humanize(item.entityType)} ${item.entityId}`}</span>
                          <span className="font-mono">{item.code}</span>
                          {item.occurrenceCount > 1 && <span>{item.occurrenceCount} observations</span>}
                          {item.recurrenceCount > 0 && <span>{item.recurrenceCount} recurrence{item.recurrenceCount === 1 ? "" : "s"}</span>}
                        </div>
                      </div>
                      <div className="text-sm tabular-nums text-muted-foreground md:pt-1">{formatAge(item.ageMinutes)}</div>
                      <div className="min-w-0 text-sm md:pt-1">
                        <div className="truncate">{item.assignedUserName || item.ownerTeam || "Unassigned"}</div>
                        {item.assignedUserName && item.ownerTeam && <div className="truncate text-xs text-muted-foreground">{item.ownerTeam}</div>}
                      </div>
                      <ChevronRight className="hidden h-4 w-4 self-center text-muted-foreground md:block" />
                    </button>
                  ))}
                  {queueQuery.hasNextPage && (
                    <div className="p-3 text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => queueQuery.fetchNextPage()}
                        disabled={queueQuery.isFetchingNextPage}
                      >
                        {queueQuery.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Load more
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
  busy: boolean;
}) {
  const { item } = props.detail;
  const primaryLink = item.availableActions.find((action) => action.kind === "navigate")
    ?? item.detailLocator.links?.[0]
    ?? null;

  return (
    <ScrollArea className="h-full lg:max-h-[calc(100vh-64px)]">
      <div className="border-b p-5">
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
          <span>{item.occurrenceCount} observation{item.occurrenceCount === 1 ? "" : "s"}</span>
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
  loading: boolean;
  error: Error | null;
}) {
  return (
    <main className="flex-1 p-4 lg:p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Projection Sources</h2>
          </div>
          {props.data && <span className="text-xs text-muted-foreground">Stale after {props.data.staleAfterMinutes}m</span>}
        </div>
        <div className="overflow-x-auto border">
          <div className="grid min-w-[820px] grid-cols-[minmax(180px,1fr)_130px_110px_120px_minmax(180px,1fr)] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
            <span>Source</span><span>Status</span><span>Open</span><span>Last run</span><span>Result</span>
          </div>
          {props.loading ? (
            <div className="space-y-3 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
          ) : props.error ? (
            <div className="p-6 text-sm text-red-700">{props.error.message}</div>
          ) : (
            <div className="min-w-[820px] divide-y">
              {props.data?.sources.map((source) => (
                <div key={source.name} className="grid grid-cols-[minmax(180px,1fr)_130px_110px_120px_minmax(180px,1fr)] items-center gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0"><div className="font-medium">{humanize(source.name)}</div><div className="truncate text-xs text-muted-foreground">{source.sourceNamespace}</div></div>
                  <SourceStatusBadge status={source.status} />
                  <span className="tabular-nums">{source.openItemCount.toLocaleString()}</span>
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
  const failed = status === "failed";
  return (
    <Badge
      variant="outline"
      className={cn(
        "w-fit capitalize",
        healthy && "border-emerald-300 bg-emerald-50 text-emerald-800",
        failed && "border-red-300 bg-red-50 text-red-800",
        !healthy && !failed && "border-amber-300 bg-amber-50 text-amber-800",
      )}
    >
      {healthy ? <CheckCircle2 className="mr-1 h-3 w-3" /> : failed ? <AlertTriangle className="mr-1 h-3 w-3" /> : <Clock3 className="mr-1 h-3 w-3" />}
      {humanize(status)}
    </Badge>
  );
}
