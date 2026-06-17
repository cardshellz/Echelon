import React, { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  RotateCw,
  Store,
  Globe,
  ShoppingCart,
  AlertTriangle,
  ArrowRight,
  Radio,
  CheckCircle2,
  Copy,
  ListTree,
  GitCompare,
  Clock,
  Search,
  XCircle,
  Circle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types (mirror server/modules/oms/flow-waterfall.service.ts → FlowWaterfall)
// ---------------------------------------------------------------------------
type FunnelStageKey =
  | "intake" | "oms_to_wms" | "wms_fulfill" | "engine_push" | "shipped" | "writeback" | "other";

type RemediationClass =
  | "REQUEUE" | "REPLAY_AFTER_STOCK" | "REPLAY_AFTER_FIX"
  | "MANUAL_REVIEW" | "INVESTIGATE" | "CODE_FIX" | "PURGE_OBSOLETE";

const REMEDIATION_LABEL: Record<RemediationClass, string> = {
  REQUEUE: "Re-run it",
  REPLAY_AFTER_STOCK: "Receive stock, then re-run",
  REPLAY_AFTER_FIX: "Fix, then re-run",
  MANUAL_REVIEW: "Needs review",
  INVESTIGATE: "Investigate",
  CODE_FIX: "Needs a code fix",
  PURGE_OBSOLETE: "Safe to drop",
};

interface FlowIssue {
  code: string;
  kind?: "stuck" | "contradiction" | "duplicate" | "queue_failure" | "sla";
  severity: "critical" | "warning" | "info";
  count: number;
  message: string;
  why?: string;
  remediation?: RemediationClass;
  replaySafe?: boolean;
  sample: any[];
  stage: FunnelStageKey;
}

interface FlowWaterfall {
  generatedAt: string;
  windowDays: number;
  funnel: { entered: number; reachedWms: number; hasShipment: number; shipped: number; trackingConfirmed: number };
  channels: Array<{ provider: string; entered: number }>;
  volumePerDay: Array<{ day: string; orders: number }>;
  wmsBuckets: Array<{ status: string; count: number }>;
  eventSpine: Array<{ eventType: string; count: number }>;
  intakeModel: Array<{ provider: string; model: string; cadenceSeconds: number; note: string }>;
  duplicates: { omsToPicking: number; overShippedItems: number; unmappedEngineSplits: number; blockedDupOrders: number; sample: any[] };
  deadLetterCauses: Array<{ code?: string; cause: string; count: number }>;
  crossSystem: { wmsShippedOmsOpen: number; omsNotUpdated: number; sample: any[] };
  sla: { breached: number; sample: any[] };
  issues: FlowIssue[];
  health: { generatedAt: string; status: "healthy" | "degraded" | "critical"; counts: { critical: number; warning: number; info: number } };
}

interface FlowTraceShipment { id: number; status: string | null; engineOrderRef: string | null; carrier?: string | null; trackingNumber?: string | null }
interface FlowTraceStage { key: string; label: string; status: "done" | "current" | "failed" | "pending" | "skipped"; detail?: string }
interface FlowTrace {
  found: boolean;
  query: string;
  oms: { id: number; externalOrderNumber: string | null; externalOrderId: string | null; channel: string | null; status: string | null; createdAt: string | null; shippedAt: string | null } | null;
  shipments: FlowTraceShipment[];
  timeline: Array<{ id: string; source: string; status: string; label: string; createdAt: string | null }>;
  stages: FlowTraceStage[];
  diverged: { stage: string; reason: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");

const CODE_LABEL: Record<string, string> = {
  WEBHOOK_INBOX_FAILED: "inbox failed",
  WEBHOOK_INBOX_STALE_PROCESSING: "stuck processing",
  WEBHOOK_RETRY_DEAD: "dead-lettered",
  WEBHOOK_RETRY_STALE_DUE: "retry overdue",
  WEBHOOK_RETRY_DUE: "retry due",
  OMS_PAID_WITHOUT_WMS: "paid, no WMS",
  WMS_READY_WITHOUT_SHIPMENT: "ready, no shipment",
  WMS_PENDING_ITEM_WITHOUT_SHIPMENT: "item, no shipment",
  SHIPMENT_REQUIRES_REVIEW: "requires review",
  SHIPMENT_ON_HOLD: "on hold",
  SHIPMENT_NOT_PUSHED_TO_SHIPSTATION: "not pushed",
  SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED: "tracking not confirmed",
  // promoted divergences / contradictions
  OMS_DOUBLE_PICKING: "picked twice",
  ORDER_FULFILLED_OMS_NOT_UPDATED: "WMS done, OMS open",
  SLA_BREACHED: "past ship-by",
  UNMAPPED_ENGINE_SPLIT: "split unmatched",
  BLOCKED_DUP_INGEST: "dup blocked",
  ITEM_OVER_SHIPPED: "over-shipped",
  WMS_SHIPPED_OMS_OPEN: "shipped, order open",
  SHIPPED_SHIPMENT_CANCELLED: "shipped but cancelled",
  ORDER_CANCELLED_WITH_SHIPPED_UNITS: "cancelled but shipped",
  SHIPMENT_SHIPPED_AT_WRONG_STATUS: "ship date, wrong status",
  ORDER_SHIPPED_BUT_LINE_SHORT: "shipped, item short",
  // dead-letter reason buckets
  SHIPNOTIFY_NO_INVENTORY: "no stock to deduct",
  SHIPNOTIFY_UNSPECIFIED: "ship fail (no detail)",
  SHIPNOTIFY_UNMAPPED_LINEITEM: "items didn't match",
  SHIPNOTIFY_SHIPMENT_NOT_FOUND: "shipment not found",
  SHOPIFY_PUSH_NO_POSITIVE_QTY: "push: empty shipment",
  SHOPIFY_PUSH_SKU_NOT_ON_FO: "push: item not on order",
  OMS_WMS_SYNC_NO_ORDER: "hand-off: no WMS order",
  SHIPSTATION_COUNTRY_CODE: "bad country code",
  PUSH_NEGATIVE_TOTAL: "negative total",
  PUSH_TOTAL_MISMATCH: "total mismatch",
  DB_CONNECT_TIMEOUT: "db timeout",
  INTERNAL_API_500: "internal 500",
  NO_MESSAGE: "no error message",
  UNCLASSIFIED: "unclassified ⚠",
};
const shortLabel = (code: string) =>
  CODE_LABEL[code] ?? code.toLowerCase().replace(/_/g, " ").replace(/^(webhook|oms|wms|shipment)\s/, "");

const channelIcon = (provider: string) => {
  const p = provider.toLowerCase();
  if (p.includes("ebay")) return <Globe className="h-4 w-4 text-blue-500" />;
  if (p.includes("shopify")) return <ShoppingCart className="h-4 w-4 text-green-500" />;
  return <Store className="h-4 w-4 text-muted-foreground" />;
};

const cadenceLabel = (seconds: number) =>
  seconds % 60 === 0 ? `every ${seconds / 60} min` : `every ${seconds}s`;

// Lookback presets. 30d is the cheap default; larger ranges are opt-in and scan
// more (the endpoint is hard-capped by a statement_timeout, so they can't run away).
const WINDOWS = [30, 60, 90, 180, 365];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function FlowMonitor() {
  const [windowDays, setWindowDays] = useState(30);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<FlowWaterfall>({
    queryKey: ["/api/oms/ops/flow-waterfall?windowDays=" + windowDays],
    placeholderData: (prev) => prev,
  });
  const [selected, setSelected] = useState<FlowIssue | null>(null);
  // Which reason-categories are expanded in the drill-down (rolled-up by default).
  const [expandedReasons, setExpandedReasons] = useState<Set<string>>(new Set());
  const [refInput, setRefInput] = useState("");
  const [submittedRef, setSubmittedRef] = useState("");
  const trace = useQuery<FlowTrace>({
    queryKey: ["/api/oms/ops/flow-trace", encodeURIComponent(submittedRef)],
    enabled: submittedRef.length > 0,
  });
  // On-demand drill-down rows for whichever exception bucket is open.
  const bucket = useQuery<{ code: string; rows: any[] }>({
    queryKey: ["/api/oms/ops/flow-bucket/" + (selected?.code ?? "_") + "?windowDays=" + windowDays],
    enabled: !!selected,
  });
  const traceRef = useRef<HTMLDivElement>(null);

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-4 md:p-6">
        <Card className="border-red-300">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4" /> Failed to load flow data: {(error as Error)?.message ?? "unknown error"}
          </CardContent>
        </Card>
      </div>
    );
  }

  const d = data;
  const byCode: Record<string, number> = Object.fromEntries(d.issues.map((i) => [i.code, i.count]));
  const deadLetter = d.issues.filter((i) => i.kind === "queue_failure").reduce((a, i) => a + i.count, 0) + (byCode.WEBHOOK_INBOX_FAILED ?? 0);
  const trackingRisk = byCode.SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED ?? 0;
  const perDay = Math.round(d.funnel.entered / Math.max(1, d.windowDays));
  const maxVol = Math.max(1, ...d.volumePerDay.map((v) => v.orders));

  const leaksFor = (stage: FunnelStageKey) => d.issues.filter((i) => i.stage === stage);
  const otherIssues = leaksFor("other");

  const STAGES: Array<{ n: number; name: string; desc: string; reached: number; reachedLabel: string; stage?: FunnelStageKey; parity?: boolean }> = [
    { n: 1, name: "Channel order placed", desc: "Order created on a sales channel (source of truth)", reached: d.funnel.entered, reachedLabel: "placed", parity: true },
    { n: 2, name: "Ingested → OMS", desc: "Webhook received, persisted to inbox, OMS order created", reached: d.funnel.entered, reachedLabel: "ingested", stage: "intake" },
    { n: 3, name: "Accepted & reached WMS", desc: "OMS validated → WMS order + lines + reservation", reached: d.funnel.reachedWms, reachedLabel: "reached WMS", stage: "oms_to_wms" },
    { n: 4, name: "Picked & packed", desc: "Picked, packed, outbound shipment row created", reached: d.funnel.hasShipment, reachedLabel: "shipment created", stage: "wms_fulfill" },
    { n: 5, name: "Pushed to ShipStation", desc: "Shipment pushed to the shipping engine (engine-agnostic)", reached: d.funnel.shipped, reachedLabel: "downstream", stage: "engine_push" },
    { n: 6, name: "Shipped & confirmed", desc: "SHIP_NOTIFY recorded; inventory ledgered", reached: d.funnel.shipped, reachedLabel: "shipped", stage: "shipped" },
    { n: 7, name: "Written back to channel", desc: "Fulfillment + tracking pushed to Shopify / eBay", reached: d.funnel.trackingConfirmed, reachedLabel: "tracking confirmed", stage: "writeback" },
  ];

  const KPI = ({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "red" | "green" }) => (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <p className={cn("mt-1 text-2xl font-bold", tone === "red" && "text-red-600", tone === "green" && "text-emerald-600")}>{value}</p>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );

  const Stat = ({ label, value, sub, warn, good }: { label: string; value: number; sub?: string; warn?: boolean; good?: boolean }) => (
    <div className="flex items-center justify-between border-b py-1.5 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-semibold tabular-nums", value > 0 && warn && "text-red-600", value === 0 && good && "text-emerald-600")}>
        {fmt(value)}{sub && <span className="ml-1 text-xs font-normal text-muted-foreground">{sub}</span>}
      </span>
    </div>
  );

  const maxCause = Math.max(1, ...d.deadLetterCauses.map((c) => c.count));

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Order Flow Monitor</h1>
          <p className="text-sm text-muted-foreground">
            Channel → OMS → WMS → shipping engine. Where orders fall off the happy path, drillable to the webhook.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center rounded-md border bg-card p-0.5 text-xs" title="Lookback window — 30d is the cheap default; larger ranges scan more and are opt-in">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWindowDays(w)}
                className={cn(
                  "rounded px-2 py-1 font-medium transition",
                  windowDays === w ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {w >= 365 ? "1yr" : `${w}d`}
              </button>
            ))}
          </div>
          {isFetching && <RotateCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <Badge variant="outline" className="font-normal text-muted-foreground">read-only</Badge>
          <Badge variant={d.health.status === "healthy" ? "outline" : "destructive"} className="capitalize">{d.health.status}</Badge>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refetch()} disabled={isFetching}>
            <RotateCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Refresh
          </Button>
        </div>
      </div>

      {/* Per-order trace */}
      <Card ref={traceRef}>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Search className="h-4 w-4 text-muted-foreground" />Find an order — full flow trace</CardTitle></CardHeader>
        <CardContent>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSubmittedRef(refInput.trim()); }}>
            <input value={refInput} onChange={(e) => setRefInput(e.target.value)} placeholder="order number, e.g. #58409"
              className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm" />
            <Button type="submit" size="sm" className="gap-1.5"><Search className="h-3.5 w-3.5" />Trace</Button>
          </form>

          {submittedRef && trace.isLoading && <div className="mt-3 text-sm text-muted-foreground">Tracing {submittedRef}…</div>}
          {submittedRef && trace.data && !trace.data.found && <div className="mt-3 text-sm text-muted-foreground">No order matching “{submittedRef}”.</div>}

          {trace.data?.found && trace.data.oms && (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono-sku text-base font-semibold">{trace.data.oms.externalOrderNumber}</span>
                <Badge variant="outline" className="capitalize">{trace.data.oms.channel}</Badge>
                <Badge variant={trace.data.oms.status === "shipped" ? "outline" : "destructive"} className="capitalize">{trace.data.oms.status}</Badge>
                <span className="text-xs text-muted-foreground">internal id {trace.data.oms.id}</span>
              </div>

              {trace.data.diverged ? (
                <div className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-800"><b>Diverged at {trace.data.diverged.stage}:</b> {trace.data.diverged.reason}</div>
              ) : (
                <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" />No divergence — this order completed the happy path.</div>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                {trace.data.stages.map((s) => (
                  <div key={s.key} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                    {s.status === "done" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      : s.status === "failed" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                      : s.status === "current" ? <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                    <div><div className="font-medium">{s.label}</div>{s.detail && <div className="text-xs text-muted-foreground">{s.detail}</div>}</div>
                  </div>
                ))}
              </div>

              {trace.data.shipments.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{trace.data.shipments.length} shipment{trace.data.shipments.length > 1 ? "s" : ""} · distinct tracking = not duplicates</div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {trace.data.shipments.slice(0, 8).map((s) => (
                      <div key={s.id} className="flex items-center justify-between rounded border bg-muted/30 px-2 py-1 text-xs">
                        <span className="font-mono-sku">shp {s.id}</span>
                        <span className="text-muted-foreground">{s.carrier ? `${s.carrier} ${s.trackingNumber}` : s.status}</span>
                      </div>
                    ))}
                  </div>
                  {trace.data.shipments.length > 8 && <div className="mt-1 text-xs text-muted-foreground">+{trace.data.shipments.length - 8} more</div>}
                </div>
              )}

              {trace.data.timeline.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Webhook / event timeline</div>
                  <div className="space-y-1">
                    {trace.data.timeline.slice(0, 6).map((t) => (
                      <div key={t.id} className={cn("flex items-center justify-between rounded border-l-2 bg-muted/20 px-2 py-1 text-xs",
                        t.source === "alert" || /fail|dead/.test(t.status) ? "border-l-red-400"
                          : t.source === "reconciliation" ? "border-l-amber-400"
                          : t.source === "webhook_inbox" ? "border-l-blue-400"
                          : t.source === "webhook_retry" ? "border-l-purple-400" : "border-l-border")}>
                        <span className="font-mono-sku">{t.label}</span>
                        <span className="text-muted-foreground">{t.status}{t.createdAt ? ` · ${new Date(t.createdAt).toLocaleDateString()}` : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <KPI label="Throughput" value={fmt(d.funnel.entered)} sub={`≈ ${perDay}/day · ${d.windowDays}d`} />
        <KPI label="Reached carrier" value={fmt(d.funnel.shipped)} sub={`shipped of ${fmt(d.funnel.entered)}`} tone="green" />
        <KPI label="Dead-letter backlog" value={fmt(deadLetter)} sub="retry-dead + inbox-failed" tone={deadLetter > 0 ? "red" : undefined} />
        <KPI label="Tracking at risk" value={fmt(trackingRisk)} sub="shipped, not confirmed" tone={trackingRisk > 0 ? "red" : undefined} />
        <KPI label="OMS → WMS" value={byCode.OMS_PAID_WITHOUT_WMS ? `${byCode.OMS_PAID_WITHOUT_WMS} stuck` : "OK"} sub="paid-without-WMS" tone={byCode.OMS_PAID_WITHOUT_WMS ? "red" : "green"} />
      </div>

      {otherIssues.length > 0 && (
        <Card className="border-amber-300">
          <CardContent className="flex flex-wrap items-center gap-2 py-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <span className="font-medium">Pipeline workers need attention:</span>
            {otherIssues.map((i) => (
              <Badge key={i.code} variant="outline" className="cursor-pointer" onClick={() => setSelected(i)}>{i.code}</Badge>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Waterfall */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-base">Pipeline waterfall</CardTitle>
              <span className="text-xs text-muted-foreground">bar = {d.windowDays}-day throughput · chips = open exceptions</span>
            </div>
          </CardHeader>
          <CardContent>
            {STAGES.map((s, idx) => {
              const leaks = s.stage ? leaksFor(s.stage) : [];
              const pct = Math.max(2, Math.round((s.reached / Math.max(1, d.funnel.entered)) * 100));
              const bad = leaks.some((l) => l.severity === "critical");
              return (
                <div key={s.n} className="flex gap-3 border-b py-3 last:border-0">
                  <div className="flex flex-col items-center">
                    <div className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold",
                      bad ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700",
                    )}>{s.n}</div>
                    {idx < STAGES.length - 1 && <div className="my-1 w-px flex-1 bg-border" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">{s.name}</div>
                        <div className="text-xs text-muted-foreground">{s.desc}</div>
                      </div>
                      <div className="whitespace-nowrap text-xs text-muted-foreground">
                        <span className="font-semibold text-foreground">{fmt(s.reached)}</span> {s.reachedLabel}
                      </div>
                    </div>
                    <div className="my-2 h-2 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-gradient-to-r from-primary to-emerald-500" style={{ width: `${pct}%` }} />
                    </div>
                    {s.parity ? (
                      <div className="rounded-md border border-blue-200 bg-blue-50/70 p-2.5">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-blue-800">
                          <Radio className="h-3.5 w-3.5" /> Channel ↔ OMS intake — reconciled against the channel
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {d.intakeModel.map((m) => (
                            <span key={m.provider} className="inline-flex flex-col rounded-md border bg-card px-2 py-1 text-[11px]">
                              <span className="font-medium capitalize">{m.provider} · {m.model.replace("-", " ")}</span>
                              <span className="text-muted-foreground">{cadenceLabel(m.cadenceSeconds)}</span>
                            </span>
                          ))}
                        </div>
                        <div className="mt-1.5 text-[11px] text-muted-foreground">
                          Shopify is webhook-primary — a dropped order is caught by the 15-min sweep. eBay polls every 5 min, so it self-reconciles.
                        </div>
                      </div>
                    ) : leaks.length === 0 ? (
                      <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                        <CheckCircle2 className="h-3.5 w-3.5" /> no drop-off here
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {leaks.map((l) => (
                          <button
                            key={l.code}
                            onClick={() => setSelected(l)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition hover:shadow-sm",
                              l.severity === "critical" ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-800",
                            )}
                          >
                            <span className="font-semibold tabular-nums">{fmt(l.count)}</span>
                            <span>{shortLabel(l.code)}</span>
                            <ArrowRight className="h-3 w-3 opacity-50" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Side rail */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Channels</CardTitle></CardHeader>
            <CardContent className="pt-0">
              {d.channels.map((c) => (
                <div key={c.provider} className="flex items-center justify-between border-b py-2 text-sm last:border-0">
                  <span className="flex items-center gap-2 capitalize">{channelIcon(c.provider)}{c.provider}</span>
                  <span className="font-semibold tabular-nums">{fmt(c.entered)}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Daily volume</CardTitle></CardHeader>
            <CardContent className="pt-0">
              <div className="flex h-16 items-end gap-1">
                {d.volumePerDay.map((v) => (
                  <div key={v.day} title={`${v.day}: ${v.orders}`} className="flex-1 rounded-t bg-primary/70 hover:bg-primary"
                    style={{ height: `${Math.max(6, Math.round((v.orders / maxVol) * 100))}%` }} />
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Live WMS buckets <span className="font-normal text-muted-foreground">· {d.windowDays}d</span></CardTitle></CardHeader>
            <CardContent className="pt-0">
              {d.wmsBuckets.map((w) => (
                <div key={w.status} className="flex items-center justify-between border-b py-1.5 text-sm last:border-0">
                  <span className="text-muted-foreground">{w.status}</span>
                  <span className="font-semibold tabular-nums">{fmt(w.count)}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Event spine</CardTitle></CardHeader>
            <CardContent className="pt-0">
              {d.eventSpine.slice(0, 8).map((e) => (
                <div key={e.eventType} className="flex items-center justify-between border-b py-1.5 text-xs last:border-0">
                  <span className="font-mono-sku text-muted-foreground">{e.eventType}</span>
                  <span className="font-semibold tabular-nums">{fmt(e.count)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Divergence checks */}
      <div>
        <h2 className="mb-3 text-sm font-semibold">Divergence checks <span className="font-normal text-muted-foreground">· last {d.windowDays} days</span></h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Copy className="h-4 w-4 text-muted-foreground" />Duplicates · over-processing</CardTitle></CardHeader>
            <CardContent className="pt-0 text-sm">
              <Stat label="OMS → duplicate picking" value={d.duplicates.omsToPicking} warn good />
              <Stat label="Over-shipped items (any engine)" value={d.duplicates.overShippedItems} warn good />
              <Stat label="Unmapped engine splits" value={d.duplicates.unmappedEngineSplits} warn />
              <Stat label="Blocked dup-order attempts" value={d.duplicates.blockedDupOrders} />
              <div className="mt-2 text-xs text-muted-foreground">Over-ship = Σ shipped qty &gt; ordered, per item — engine-agnostic. Splits and combines pass.</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><ListTree className="h-4 w-4 text-muted-foreground" />Dead-letter root causes</CardTitle></CardHeader>
            <CardContent className="pt-0">
              {d.deadLetterCauses.slice(0, 6).map((rc) => (
                <div key={rc.cause} className="py-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-muted-foreground">{rc.cause}</span>
                    <span className="shrink-0 font-semibold tabular-nums">{fmt(rc.count)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-secondary"><div className="h-full rounded bg-red-400" style={{ width: `${Math.round((rc.count / maxCause) * 100)}%` }} /></div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><GitCompare className="h-4 w-4 text-muted-foreground" />Cross-system mismatch</CardTitle></CardHeader>
            <CardContent className="pt-0 text-sm">
              <Stat label="WMS shipped, OMS open" value={d.crossSystem.wmsShippedOmsOpen} good />
              <Stat label="WMS done, OMS not updated" value={d.crossSystem.omsNotUpdated} warn />
              <div className="mt-2 text-xs text-muted-foreground">Reconcilers keep OMS / WMS / ShipStation in sync — this catches drift early.</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Clock className="h-4 w-4 text-muted-foreground" />SLA · late shipments</CardTitle></CardHeader>
            <CardContent className="pt-0 text-sm">
              <Stat label="Past ship-by, not shipped" value={d.sla.breached} warn />
              <div className="mt-2 space-y-1">
                {d.sla.sample.slice(0, 4).map((r: any, i: number) => (
                  <div key={i} className="flex justify-between text-xs text-muted-foreground">
                    <span className="font-mono-sku">{String(r.order_number)}</span>
                    <span>{String(r.warehouse_status)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Read-only. Throughput is last {d.windowDays} days; exception counts are open-now. Snapshot {new Date(d.generatedAt).toLocaleString()}.
      </p>

      {/* Drill-down sheet */}
      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) { setSelected(null); setExpandedReasons(new Set()); } }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <div className="space-y-4">
              <div>
                <SheetTitle className="text-base">{selected.message}</SheetTitle>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge variant={selected.severity === "critical" ? "destructive" : "outline"} className="capitalize">{selected.severity}</Badge>
                  <Badge variant="outline">{fmt(selected.count)} open</Badge>
                  {selected.remediation && (
                    <Badge className="border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-50">
                      {REMEDIATION_LABEL[selected.remediation]}{selected.replaySafe ? " · replay-safe" : ""}
                    </Badge>
                  )}
                  <Badge variant="outline" className="font-mono-sku">{selected.code}</Badge>
                </div>
                {selected.why && (
                  <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/60 p-2.5">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700">What it means · what to do</div>
                    <p className="text-xs leading-relaxed text-amber-900">{selected.why}</p>
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Affected rows · live
                  {bucket.isFetching && <RotateCw className="h-3 w-3 animate-spin" />}
                </div>
                {bucket.isLoading ? (
                  <div className="text-sm text-muted-foreground">Loading rows…</div>
                ) : (bucket.data?.rows?.length ?? 0) === 0 ? (
                  <div className="text-sm text-muted-foreground">No matching rows right now.</div>
                ) : (() => {
                  const rows = bucket.data!.rows as any[];
                  // Roll up by whatever reason/category field a bucket carries, so EVERY
                  // multi-reason drill-down shows categories first and expands to the orders
                  // (requires_review -> review_reason, dead-letters -> reason_code,
                  // shipped-but-cancelled -> voided_reason, on-hold -> on_hold_reason).
                  const REASON_FIELDS = ["review_reason", "reason_code", "voided_reason", "on_hold_reason"];
                  const reasonKey = rows.length ? (REASON_FIELDS.find((f) => f in rows[0]) ?? null) : null;

                  const renderRow = (row: any, i: number) => {
                    const ordNum = row.order_number ?? row.orderNumber;
                    return (
                      <div key={i} className="rounded-md border bg-muted/40 p-2 text-xs">
                        {ordNum != null && String(ordNum).length > 0 && (
                          <button
                            onClick={() => { setSubmittedRef(String(ordNum)); setRefInput(String(ordNum)); setSelected(null); setTimeout(() => traceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60); }}
                            className="mb-1 inline-flex items-center gap-1 font-mono-sku font-semibold text-primary hover:underline"
                          >
                            <Search className="h-3 w-3" />trace {String(ordNum)}
                          </button>
                        )}
                        {Object.entries(row).filter(([k]) => k !== reasonKey).map(([k, v]) => (
                          <div key={k} className="flex gap-2 py-0.5">
                            <span className="w-32 shrink-0 text-muted-foreground">{k}</span>
                            <span className={cn("min-w-0 break-words", /error/i.test(k) ? "font-mono-sku text-red-600" : "font-medium")}>{v === null ? "—" : String(v)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  };

                  if (!reasonKey) {
                    return <div className="space-y-2">{rows.map(renderRow)}</div>;
                  }

                  const groups = new Map<string, any[]>();
                  for (const r of rows) {
                    const key = String(r[reasonKey] ?? "(none)");
                    if (!groups.has(key)) groups.set(key, []);
                    groups.get(key)!.push(r);
                  }
                  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

                  return (
                    <div className="space-y-2">
                      {sorted.map(([reason, gr]) => {
                        const open = expandedReasons.has(reason);
                        return (
                          <div key={reason} className="overflow-hidden rounded-md border">
                            <button
                              onClick={() => setExpandedReasons((prev) => {
                                const n = new Set(prev);
                                if (n.has(reason)) n.delete(reason); else n.add(reason);
                                return n;
                              })}
                              className="flex w-full items-center justify-between gap-2 bg-muted/40 px-2.5 py-2 text-left text-xs font-medium hover:bg-muted/70"
                            >
                              <span className="inline-flex min-w-0 items-center gap-1.5">
                                {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                                <span className="truncate">{reason}</span>
                              </span>
                              <Badge variant="outline" className="shrink-0 tabular-nums">{gr.length}</Badge>
                            </button>
                            {open && <div className="space-y-2 border-t p-2">{gr.map(renderRow)}</div>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                Observe-only in v1. The existing replay / requeue / remediate endpoints can be wired here as one-click actions later.
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
