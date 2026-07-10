import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Wrench,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type Domain = "oms" | "wms" | "shipping" | "inventory" | "procurement";
type Severity = "critical" | "warning" | "info";

interface Action {
  id: string;
  label: string;
  kind: "navigate" | "execute";
  href?: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  unavailableReason?: string;
}

interface WorkItem {
  id: string;
  domain: Domain;
  code: string;
  severity: Severity;
  status: "open" | "in_progress" | "blocked" | "resolved";
  title: string;
  summary: string;
  detail: string | null;
  count: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  ageMinutes: number | null;
  source: string;
  affected: {
    orderNumber?: string | null;
    omsOrderId?: number | null;
    wmsOrderId?: number | null;
    shipmentId?: number | null;
    sku?: string | null;
    href?: string | null;
  };
  evidence: Record<string, unknown>;
  actions: Action[];
}

interface TowerResponse {
  generatedAt: string;
  status: "healthy" | "degraded" | "critical";
  overview: {
    funnel: { entered: number; reachedWms: number; hasShipment: number; shipped: number; trackingConfirmed: number };
    wmsBuckets: Array<{ status: string; count: number }>;
    deadLetterCauses: Array<{ code: string; cause: string; count: number }>;
    crossSystem: { wmsShippedOmsOpen: number; omsNotUpdated: number };
    sla: { breached: number };
  } | null;
  filters: { domain: string; severity: string; status: string; search: string; limit: number };
  summary: {
    open: number;
    critical: number;
    warning: number;
    info: number;
    byDomain: Record<Domain, number>;
    byCode: Array<{ code: string; domain: Domain; count: number }>;
  };
  sources: Array<{ domain: Domain; status: "ok" | "degraded" | "unavailable"; itemCount: number; error: string | null }>;
  workItems: WorkItem[];
}

interface Detail extends WorkItem {
  records: unknown[];
}

const DOMAINS: Array<{ value: "all" | Domain; label: string }> = [
  { value: "all", label: "All domains" },
  { value: "oms", label: "OMS" },
  { value: "wms", label: "WMS" },
  { value: "shipping", label: "Shipping" },
  { value: "inventory", label: "Inventory" },
  { value: "procurement", label: "Procurement" },
];

const DOMAIN_LABEL: Record<Domain, string> = {
  oms: "OMS",
  wms: "WMS",
  shipping: "Shipping",
  inventory: "Inventory",
  procurement: "Procurement",
};

function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, init).then(async (response) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  });
}

function formatAge(minutes: number | null): string {
  if (minutes == null) return "Age unavailable";
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m old`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h old`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function severityIcon(severity: Severity) {
  if (severity === "critical") return <XCircle className="h-4 w-4 text-red-600" />;
  if (severity === "warning") return <AlertTriangle className="h-4 w-4 text-amber-600" />;
  return <CircleAlert className="h-4 w-4 text-blue-600" />;
}

function severityClass(severity: Severity): string {
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-700";
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-blue-200 bg-blue-50 text-blue-700";
}

function statusClass(status: WorkItem["status"]): string {
  if (status === "blocked") return "border-red-200 bg-red-50 text-red-700";
  if (status === "in_progress") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stringifyValue(value: unknown): string {
  if (value == null) return "Not recorded";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function recordLabel(record: any, index: number): string {
  const order = record?.order_number ?? record?.orderNumber ?? record?.external_order_number;
  const sku = record?.sku;
  const id = record?.id ?? record?.shipment_id ?? record?.wms_order_id;
  return [order ? `Order ${order}` : null, sku ? String(sku) : null, id ? `#${id}` : null].filter(Boolean).join(" · ") || `Record ${index + 1}`;
}

export default function FlowMonitor() {
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ item: WorkItem; action: Action; record?: unknown } | null>(null);

  const query = useQuery<TowerResponse>({
    queryKey: ["operations-control-tower"],
    queryFn: () => fetchJson("/api/operations/control-tower?limit=250"),
    refetchInterval: 60_000,
  });

  const detailQuery = useQuery<Detail>({
    queryKey: ["operations-control-tower-detail", selectedId],
    queryFn: () => fetchJson(`/api/operations/control-tower/${encodeURIComponent(selectedId!)}`),
    enabled: Boolean(selectedId),
  });

  const actionMutation = useMutation({
    mutationFn: async (input: { item: WorkItem; action: Action; record?: unknown }) => fetchJson(`/api/operations/control-tower/${encodeURIComponent(input.item.id)}/actions/${encodeURIComponent(input.action.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record: input.record }),
    }),
    onSuccess: async () => {
      setPendingAction(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["operations-control-tower"] }),
        queryClient.invalidateQueries({ queryKey: ["operations-control-tower-detail", selectedId] }),
      ]);
    },
  });

  const data = query.data;
  const workItems = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (data?.workItems ?? []).filter((item) => {
      if (domain !== "all" && item.domain !== domain) return false;
      if (severity !== "all" && item.severity !== severity) return false;
      if (status !== "all" && item.status !== status) return false;
      if (!normalizedSearch) return true;
      return JSON.stringify({
        id: item.id,
        code: item.code,
        title: item.title,
        summary: item.summary,
        affected: item.affected,
      }).toLowerCase().includes(normalizedSearch);
    });
  }, [data?.workItems, domain, search, severity, status]);
  const selected = detailQuery.data;
  const domainCards = useMemo(() => DOMAINS.filter((entry): entry is { value: Domain; label: string } => entry.value !== "all"), []);

  const selectDomain = (value: Domain) => {
    setDomain(domain === value ? "all" : value);
    window.requestAnimationFrame(() => {
      document.getElementById("operations-control-tower-work-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const navigate = (href?: string) => {
    if (href) window.location.href = href;
  };

  const runAction = (item: WorkItem, action: Action, record?: unknown) => {
    if (action.kind === "navigate") {
      navigate(action.href);
      return;
    }
    if (!action.enabled) return;
    if (action.requiresConfirmation) {
      setPendingAction({ item, action, record });
    } else {
      actionMutation.mutate({ item, action, record });
    }
  };

  return (
    <div className="min-h-full space-y-6 bg-muted/20 p-4 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <ShieldAlert className="h-7 w-7 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Operations Control Tower</h1>
            {data && (
              <Badge className={cn("capitalize", data.status === "critical" ? "bg-red-600" : data.status === "degraded" ? "bg-amber-500" : "bg-emerald-600")}>
                {data.status}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">One work queue for OMS, WMS, shipping, inventory, and procurement exceptions.</p>
        </div>
        <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={cn("mr-2 h-4 w-4", query.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {query.isError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-red-800">
            <XCircle className="h-5 w-5 shrink-0" />
            <span>{query.error instanceof Error ? query.error.message : "Control Tower failed to load"}</span>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard label="Open work" value={data.summary.open} icon={<ClipboardCheck className="h-4 w-4" />} tone="neutral" />
            <SummaryCard label="Critical" value={data.summary.critical} icon={<XCircle className="h-4 w-4" />} tone="critical" />
            <SummaryCard label="Warning" value={data.summary.warning} icon={<AlertTriangle className="h-4 w-4" />} tone="warning" />
            <SummaryCard label="Informational" value={data.summary.info} icon={<CircleAlert className="h-4 w-4" />} tone="info" />
          </div>

          {data.overview && <PipelineOverview overview={data.overview} />}

          <div className="grid gap-3 md:grid-cols-5">
            {domainCards.map((entry) => {
              const source = data.sources.find((candidate) => candidate.domain === entry.value);
              const count = data.summary.byDomain[entry.value] ?? 0;
              return (
                <button
                  key={entry.value}
                  onClick={() => selectDomain(entry.value)}
                  aria-pressed={domain === entry.value}
                  aria-label={`Filter exception work queue to ${entry.label}`}
                  className={cn("rounded-lg border bg-background p-3 text-left transition-colors hover:border-primary/50", domain === entry.value && "border-primary ring-1 ring-primary")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{entry.label}</span>
                    {source?.status === "ok" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
                  </div>
                  <div className="mt-2 text-2xl font-semibold tabular-nums">{count.toLocaleString()}</div>
                   <div className="mt-1 text-xs text-muted-foreground">{domain === entry.value ? "Showing this queue" : "Click to filter queue"}</div>
                   {source?.status !== "ok" && <div className="mt-1 text-xs text-amber-700">{source?.error || "source degraded"}</div>}
                </button>
              );
            })}
          </div>

          <Card>
            <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search order, SKU, shipment, code, or message" className="pl-9" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={domain} onValueChange={setDomain}>
                  <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{DOMAINS.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={severity} onValueChange={setSeverity}>
                  <SelectTrigger className="w-[135px]"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">All severity</SelectItem><SelectItem value="critical">Critical</SelectItem><SelectItem value="warning">Warning</SelectItem><SelectItem value="info">Info</SelectItem></SelectContent>
                </Select>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="w-[135px]"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">All status</SelectItem><SelectItem value="blocked">Blocked</SelectItem><SelectItem value="open">Open</SelectItem><SelectItem value="in_progress">In progress</SelectItem></SelectContent>
                </Select>
                <Button variant="ghost" onClick={() => { setDomain("all"); setSeverity("all"); setStatus("all"); setSearch(""); }}>
                  <SlidersHorizontal className="mr-2 h-4 w-4" /> Clear
                </Button>
              </div>
            </CardContent>
          </Card>

           <Card id="operations-control-tower-work-queue">
             <CardHeader className="flex flex-row items-center justify-between gap-3">
               <div>
                 <CardTitle className="text-base">Exception work queue</CardTitle>
                 <p className="mt-1 text-xs text-muted-foreground">This is the list of unresolved operational exceptions. Domain cards above filter this list; select a row to inspect live records and available actions.</p>
               </div>
               <Badge variant="outline">{workItems.length} shown / {data.summary.open.toLocaleString()} total</Badge>
            </CardHeader>
            <CardContent className="p-0">
              {query.isLoading ? (
                <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading operational evidence...</div>
              ) : workItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 p-12 text-center"><CheckCircle2 className="h-8 w-8 text-emerald-600" /><div className="font-medium">No matching work items</div><div className="text-sm text-muted-foreground">The selected filters have no open exceptions.</div></div>
              ) : (
                <div className="divide-y">
                  {workItems.map((item) => (
                    <button key={item.id} onClick={() => setSelectedId(item.id)} className="flex w-full items-start gap-4 p-4 text-left transition-colors hover:bg-muted/40">
                      <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border", severityClass(item.severity))}>{severityIcon(item.severity)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.title}</span>
                          <Badge variant="outline" className="text-[10px]">{DOMAIN_LABEL[item.domain]}</Badge>
                          <Badge className={cn("text-[10px] capitalize", statusClass(item.status))}>{item.status.replace("_", " ")}</Badge>
                          {item.count > 1 && <Badge variant="outline" className="text-[10px]">{item.count.toLocaleString()} affected</Badge>}
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.summary}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span className="font-mono">{item.code}</span>
                          <span>{formatAge(item.ageMinutes)}</span>
                          <span>{item.source}</span>
                          {item.affected.orderNumber && <span>Order {item.affected.orderNumber}</span>}
                          {item.affected.sku && <span>SKU {item.affected.sku}</span>}
                        </div>
                      </div>
                      <ChevronRight className="mt-2 h-5 w-5 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Source monitors</CardTitle></CardHeader>
            <CardContent className="grid gap-2 md:grid-cols-5">
              {data.sources.map((source) => (
                <div key={source.domain} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2"><span className="font-medium">{DOMAIN_LABEL[source.domain]}</span><Badge className={cn("text-[10px] capitalize", source.status === "ok" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>{source.status}</Badge></div>
                  <div className="mt-2 text-xs text-muted-foreground">{source.itemCount.toLocaleString()} work items loaded</div>
                  {source.error && <div className="mt-2 break-words text-xs text-red-700">{source.error}</div>}
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="text-xs text-muted-foreground">Snapshot {formatTimestamp(data.generatedAt)} · domain sources refresh automatically every minute.</div>
        </>
      )}

      <Sheet open={Boolean(selectedId)} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader><SheetTitle>{selected?.title || "Work item detail"}</SheetTitle></SheetHeader>
          {detailQuery.isLoading ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading live evidence...</div>
          ) : detailQuery.isError ? (
            <div className="mt-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{detailQuery.error instanceof Error ? detailQuery.error.message : "Failed to load detail"}</div>
          ) : selected ? (
            <ScrollArea className="mt-5 h-[calc(100vh-7rem)] pr-4">
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className={cn("capitalize", severityClass(selected.severity))}>{selected.severity}</Badge>
                  <Badge className={cn("capitalize", statusClass(selected.status))}>{selected.status.replace("_", " ")}</Badge>
                  <Badge variant="outline" className="font-mono text-[10px]">{selected.code}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{selected.detail || selected.summary}</p>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <Fact label="Source" value={selected.source} />
                  <Fact label="Age" value={formatAge(selected.ageMinutes)} />
                  <Fact label="First seen" value={formatTimestamp(selected.firstSeenAt)} />
                  <Fact label="Last seen" value={formatTimestamp(selected.lastSeenAt)} />
                </div>

                <div className="flex flex-wrap gap-2">
                  {selected.actions.filter((action) => !(selected.domain === "oms" && action.id === "remediate")).map((action) => (
                    <Button key={action.id} variant={action.kind === "execute" ? "default" : "outline"} disabled={!action.enabled || actionMutation.isPending} title={action.enabled ? undefined : action.unavailableReason} onClick={() => runAction(selected, action)}>
                      {action.kind === "execute" ? <Wrench className="mr-2 h-4 w-4" /> : <ExternalLink className="mr-2 h-4 w-4" />}
                      {action.label}
                    </Button>
                  ))}
                </div>

                {selected.affected && <div className="rounded-md border bg-muted/30 p-3"><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Affected object</div><div className="grid gap-1 text-sm">{Object.entries(selected.affected).filter(([, value]) => value != null && value !== "").map(([key, value]) => <div key={key} className="flex gap-3"><span className="w-28 shrink-0 text-muted-foreground">{humanize(key)}</span><span className="break-all font-medium">{String(value)}</span></div>)}</div></div>}

                <Separator />
                <div>
                  <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">Live records</h3><Badge variant="outline">{selected.records.length}</Badge></div>
                  {selected.records.length === 0 ? <div className="text-sm text-muted-foreground">No records are currently returned. The issue may have self-healed since the queue was loaded.</div> : <div className="space-y-3">{selected.records.map((record, index) => <RecordCard key={index} record={record} index={index} item={selected} onAction={runAction} actionPending={actionMutation.isPending} />)}</div>}
                </div>

                <div className="rounded-md border bg-muted/20 p-3"><div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><ArrowUpRight className="h-3.5 w-3.5" /> Evidence payload</div><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{stringifyValue(selected.evidence)}</pre></div>
              </div>
            </ScrollArea>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => { if (!open && !actionMutation.isPending) setPendingAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm operational action</DialogTitle>
            <DialogDescription>{pendingAction ? `${pendingAction.action.label} for ${pendingAction.item.title}? This will call the domain's existing write path and create its normal audit/retry record.` : ""}</DialogDescription>
          </DialogHeader>
          {actionMutation.isError && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{actionMutation.error instanceof Error ? actionMutation.error.message : "Action failed"}</div>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)} disabled={actionMutation.isPending}>Cancel</Button>
            <Button onClick={() => pendingAction && actionMutation.mutate(pendingAction)} disabled={actionMutation.isPending}>{actionMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Run action</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({ label, value, icon, tone }: { label: string; value: number; icon: React.ReactNode; tone: "neutral" | Severity }) {
  return <Card className={cn(tone === "critical" && "border-red-200", tone === "warning" && "border-amber-200", tone === "info" && "border-blue-200")}><CardContent className="flex items-center justify-between p-4"><div><div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div></div><div className={cn("rounded-md p-2", tone === "critical" ? "bg-red-100 text-red-700" : tone === "warning" ? "bg-amber-100 text-amber-700" : tone === "info" ? "bg-blue-100 text-blue-700" : "bg-muted text-muted-foreground")}>{icon}</div></CardContent></Card>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border bg-background p-2"><div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 break-words text-xs font-medium">{value}</div></div>;
}

function RecordCard({ record, index, item, onAction, actionPending }: { record: unknown; index: number; item: Detail; onAction: (item: WorkItem, action: Action, record?: unknown) => void; actionPending: boolean }) {
  const object = record && typeof record === "object" ? record as Record<string, unknown> : { value: record };
  const canRemediate = item.domain === "oms" && item.actions.some((action) => action.id === "remediate" && action.enabled);
  return <div className="rounded-md border bg-background p-3"><div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs font-semibold">{recordLabel(object, index)}</span>{canRemediate && <Button size="sm" onClick={() => onAction(item, item.actions.find((action) => action.id === "remediate")!, record)} disabled={actionPending}><Wrench className="mr-2 h-3.5 w-3.5" />Remediate record</Button>}</div><div className="space-y-1">{Object.entries(object).map(([key, value]) => <div key={key} className="flex gap-3 text-xs"><span className="w-32 shrink-0 text-muted-foreground">{humanize(key)}</span><span className="min-w-0 break-words font-medium">{stringifyValue(value)}</span></div>)}</div></div>;
}

function PipelineOverview({ overview }: { overview: NonNullable<TowerResponse["overview"]> }) {
  const stages = [
    ["Entered", overview.funnel.entered],
    ["Reached WMS", overview.funnel.reachedWms],
    ["Has shipment", overview.funnel.hasShipment],
    ["Shipped", overview.funnel.shipped],
    ["Tracking confirmed", overview.funnel.trackingConfirmed],
  ] as const;
  const maxCause = Math.max(1, ...overview.deadLetterCauses.map((cause) => cause.count));
  return <Card><CardHeader><CardTitle className="text-base">Flow monitor snapshot</CardTitle><p className="text-xs text-muted-foreground">The existing OMS waterfall is surfaced here as context; exception work lives in the queue below.</p></CardHeader><CardContent className="grid gap-4 lg:grid-cols-[1.4fr_1fr_1fr]"><div><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pipeline funnel</div><div className="grid grid-cols-5 gap-2">{stages.map(([label, value]) => <div key={label} className="rounded-md border bg-muted/20 p-2"><div className="text-[10px] leading-tight text-muted-foreground">{label}</div><div className="mt-1 text-lg font-semibold tabular-nums">{value.toLocaleString()}</div></div>)}</div></div><div><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cross-system</div><div className="space-y-2 text-sm"><div className="flex justify-between gap-2"><span>WMS shipped, OMS open</span><span className="font-semibold tabular-nums">{overview.crossSystem.wmsShippedOmsOpen}</span></div><div className="flex justify-between gap-2"><span>OMS not updated</span><span className="font-semibold tabular-nums">{overview.crossSystem.omsNotUpdated}</span></div><div className="flex justify-between gap-2"><span>SLA breached</span><span className="font-semibold tabular-nums">{overview.sla.breached}</span></div></div></div><div><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dead-letter causes</div><div className="space-y-2">{overview.deadLetterCauses.slice(0, 5).map((cause) => <div key={cause.code}><div className="flex justify-between gap-2 text-xs"><span className="truncate text-muted-foreground">{cause.cause}</span><span className="font-semibold tabular-nums">{cause.count}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded bg-secondary"><div className="h-full rounded bg-red-400" style={{ width: `${Math.max(4, Math.round((cause.count / maxCause) * 100))}%` }} /></div></div>)}</div></div></CardContent></Card>;
}
