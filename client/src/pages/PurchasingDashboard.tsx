import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  LayoutDashboard,
  Filter,
  Plus,
  ShoppingCart,
  FileText,
  Truck,
  Package,
  BarChart3,
  AlertTriangle,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  Zap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { ExclusionRulesModal } from "@/components/purchasing/ExclusionRulesModal";

interface DashboardData {
  stockouts: number;
  orderNow: number;
  draftPoCount: number;
  inTransitCount: number;
  openPoValueCents: number;
  noVendorCount: number;
  stockoutItems: Array<{ productId: number; sku: string; productName: string; totalOnHand: number }>;
  draftPos: Array<{ id: number; poNumber: string; vendorName: string; lineCount: number; totalCents: number | null; source: string }>;
  inFlightPos: Array<{ id: number; poNumber: string; vendorName: string; status: string; lineCount: number; receivedLineCount: number; totalCents: number | null; expectedDeliveryDate: string | null }>;
  noVendorItems: Array<{ productId: number; sku: string; productName: string; totalOnHand: number }>;
  orderNowItems: Array<{ productId: number; sku: string; productName: string; daysOfSupply: number; suggestedOrderQty: number; orderUomLabel: string; preferredVendorId: number | null }>;
  healthBreakdown: { stockout: number; order_now: number; order_soon: number; on_order: number; ok: number; no_movement: number; total: number };
  spend: { totalReceivedCents: number; openPoValueCents: number; avgPoCents: number; topSupplierName: string | null; topSupplierCents: number; activeSupplierCount: number };
  lastAutoDraftRun: {
    runAt: string;
    status: string;
    itemsAnalyzed: number;
    posCreated: number;
    posUpdated: number;
    linesAdded: number;
    skippedNoVendor: number;
    skippedExcluded: number;
  } | null;
}

function formatCents(cents: number): string {
  if (cents >= 100000) return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatRelativeTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  sent: { label: "Sent", className: "bg-blue-50 text-blue-700 border-blue-200" },
  acknowledged: { label: "Acknowledged", className: "bg-purple-50 text-purple-700 border-purple-200" },
  partially_received: { label: "Partial", className: "bg-orange-50 text-orange-700 border-orange-200" },
  draft: { label: "Draft", className: "bg-amber-50 text-amber-700 border-amber-200" },
};

export default function PurchasingDashboard() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [exclusionModalOpen, setExclusionModalOpen] = useState(false);

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/purchasing/dashboard"],
    refetchInterval: 5 * 60 * 1000,
  });

  // Feature flag: when new PO editor is enabled, draft "Review" buttons
  // should open the inline editor (/edit) instead of the old detail page.
  const { data: procurementSettings } = useQuery<{ useNewPoEditor?: boolean }>({
    queryKey: ["/api/settings/procurement"],
    staleTime: 60_000,
  });
  const useNewPoEditor = procurementSettings?.useNewPoEditor === true;

  const runAutoDraftMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/purchasing/auto-draft/run", { method: "POST" });
      if (!res.ok) throw new Error("Failed to trigger auto-draft");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Auto-draft started", description: "Refresh in a minute to see results." });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] }), 15000);
    },
    onError: (err: Error) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  const sentOrAcked = data.inFlightPos.filter((po) => ["sent", "acknowledged"].includes(po.status));
  const partialOrIncoming = data.inFlightPos.filter((po) => ["partially_received"].includes(po.status));

  // Build delivery timeline (next 7 days)
  const timelineDays: Array<{ label: string; pos: typeof data.inFlightPos }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];
    const label = i === 0
      ? `Today · ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
      : i === 1
      ? `Tomorrow · ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
      : d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const dayPOs = data.inFlightPos.filter((po) => {
      if (!po.expectedDeliveryDate) return false;
      return po.expectedDeliveryDate.split("T")[0] === dateStr;
    });
    timelineDays.push({ label, pos: dayPOs });
  }

  const health = data.healthBreakdown;

  return (
    <div className="flex flex-col h-full">
      {/* Topbar */}
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10 px-4 py-3 md:px-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-lg md:text-xl font-bold tracking-tight flex items-center gap-2">
              <LayoutDashboard className="h-5 w-5" />
              Purchasing Dashboard
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">Procurement Command Center · {today}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setExclusionModalOpen(true)}>
              <Filter className="h-3.5 w-3.5 mr-1.5" />
              Exclusions
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/reorder-analysis")}>
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
              Reorder Analysis
            </Button>
            <Button size="sm" onClick={() => navigate("/purchase-orders")}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New PO
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5">
        {/* Alert Banner */}
        {(data.lastAutoDraftRun && (data.draftPoCount > 0 || data.lastAutoDraftRun.skippedNoVendor > 0)) && (
          <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 flex items-center gap-4 text-sm">
            <span className="text-lg flex-shrink-0">🤖</span>
            <div className="flex-1">
              <strong className="text-amber-700">Nightly Auto-Draft Ready</strong>
              <p className="text-muted-foreground text-xs mt-0.5">
                Job ran {data.lastAutoDraftRun ? formatRelativeTime(data.lastAutoDraftRun.runAt) : "N/A"} ·{" "}
                {data.lastAutoDraftRun.posCreated} POs created with {data.lastAutoDraftRun.linesAdded} items
                {data.lastAutoDraftRun.skippedNoVendor > 0 && (
                  <> · ⚠️ {data.lastAutoDraftRun.skippedNoVendor} items skipped — no preferred vendor</>
                )}
              </p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <Button variant="outline" size="sm" className="bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100" onClick={() => navigate("/purchase-orders?status=draft")}>
                Review Drafts →
              </Button>
              <Button variant="ghost" size="sm" onClick={() => navigate("/reorder-analysis")}>View Skipped</Button>
            </div>
          </div>
        )}

        {/* KPI Cards */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Inventory Status · {health.total} Active SKUs</span>
            <a className="text-xs text-primary cursor-pointer hover:underline" onClick={() => navigate("/reorder-analysis")}>View full analysis →</a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            <Card className="border-t-2 border-t-red-500 cursor-pointer hover:shadow-sm" onClick={() => navigate("/reorder-analysis?status=stockout")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-red-500">{data.stockouts}</div>
                <div className="text-xs text-muted-foreground">Stockouts</div>
                <div className="text-[10px] text-muted-foreground mt-1">No open PO ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-orange-500 cursor-pointer hover:shadow-sm" onClick={() => navigate("/reorder-analysis?status=order_now")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-orange-500">{data.orderNow}</div>
                <div className="text-xs text-muted-foreground">Order Now</div>
                <div className="text-[10px] text-muted-foreground mt-1">Below reorder pt ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-amber-500 cursor-pointer hover:shadow-sm" onClick={() => navigate("/purchase-orders?status=draft")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-amber-600">{data.draftPoCount}</div>
                <div className="text-xs text-muted-foreground">Draft POs</div>
                <div className="text-[10px] text-muted-foreground mt-1">Awaiting review ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-blue-500 cursor-pointer hover:shadow-sm" onClick={() => navigate("/purchase-orders?status=sent")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-blue-500">{data.inTransitCount}</div>
                <div className="text-xs text-muted-foreground">In Transit</div>
                <div className="text-[10px] text-muted-foreground mt-1">Sent / acked ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-green-600 cursor-pointer hover:shadow-sm" onClick={() => navigate("/purchase-orders")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-green-700">{formatCents(data.openPoValueCents)}</div>
                <div className="text-xs text-muted-foreground">Open PO Value</div>
                <div className="text-[10px] text-muted-foreground mt-1">All open POs ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-slate-400 cursor-pointer hover:shadow-sm">
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-muted-foreground">{data.noVendorCount}</div>
                <div className="text-xs text-muted-foreground">No Vendor</div>
                <div className="text-[10px] text-muted-foreground mt-1">Fix assignments ↗</div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Workflow Steps */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Today's Workflow</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {/* Step 1: Review & Send Drafts */}
            <Card className={data.draftPoCount > 0 ? "border-t-2 border-t-orange-500" : ""}>
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${data.draftPoCount > 0 ? "bg-orange-500 text-white" : "bg-muted text-muted-foreground border"}`}>1</div>
                <h3 className="text-xs font-semibold">Review &amp; Send Drafts</h3>
                <span className="text-[10px] text-muted-foreground ml-auto">{data.draftPoCount} ready</span>
              </div>
              <CardContent className="p-3 space-y-2">
                {data.draftPos.slice(0, 3).map((po) => (
                  <div key={po.id} className="flex items-center gap-2 p-2 bg-muted/50 border rounded-md text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-[11px] text-primary font-semibold">{po.poNumber}</div>
                      <div className="text-xs font-medium mt-0.5">{po.vendorName}</div>
                      <div className="text-[10px] text-muted-foreground">{po.lineCount} items · {po.source === "auto_draft" ? "Auto-draft" : "Manual"}</div>
                    </div>
                    {po.totalCents != null && po.totalCents > 0 && (
                      <div className="text-right flex-shrink-0">
                        <div className="text-sm font-bold">{formatCents(po.totalCents)}</div>
                        <div className="text-[10px] text-muted-foreground">estimated</div>
                      </div>
                    )}
                    <Button size="sm" variant="outline" className="text-[11px] h-7 bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100 flex-shrink-0" onClick={() => navigate(useNewPoEditor ? `/purchase-orders/${po.id}/edit` : `/purchase-orders/${po.id}`)}>
                      Review
                    </Button>
                  </div>
                ))}
                {data.draftPos.length > 3 && (
                  <div className="text-[10px] text-muted-foreground">+{data.draftPos.length - 3} more</div>
                )}

                {data.stockoutItems.length > 0 && (
                  <>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground pt-1">Stockouts — manual PO needed</div>
                    {data.stockoutItems.map((item) => (
                      <div key={item.productId} className="flex items-center gap-2 p-1.5 bg-red-50 border border-red-200 rounded-md">
                        <span className="font-mono text-[10px] text-red-600 font-semibold w-[120px] flex-shrink-0 truncate">{item.sku}</span>
                        <span className="text-xs flex-1 truncate">{item.productName}</span>
                        <span className="text-[10px] text-red-600 font-bold flex-shrink-0">0 pcs</span>
                        <Button size="sm" variant="outline" className="text-[10px] h-6 px-2 bg-red-50 border-red-300 text-red-600 hover:bg-red-100 flex-shrink-0" onClick={() => navigate(`/purchase-orders`)}>
                          + Create PO
                        </Button>
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Step 2: Awaiting Shipment */}
            <Card>
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-muted text-muted-foreground border">2</div>
                <h3 className="text-xs font-semibold">Awaiting Shipment</h3>
                <span className="text-[10px] text-muted-foreground ml-auto">{sentOrAcked.length} POs</span>
              </div>
              <CardContent className="p-3 space-y-2">
                {sentOrAcked.map((po) => {
                  const badge = STATUS_BADGE[po.status] || STATUS_BADGE.draft;
                  return (
                    <div key={po.id} className="bg-muted/50 border rounded-md p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] text-primary font-semibold">{po.poNumber}</span>
                        <Badge variant="outline" className={`text-[10px] ${badge.className}`}>{badge.label}</Badge>
                      </div>
                      <div className="text-sm font-semibold mt-1">{po.vendorName}</div>
                      <div className="flex gap-3 mt-1 text-[11px] text-muted-foreground">
                        <span>{po.lineCount} items</span>
                        {po.totalCents != null && <span>{formatCents(po.totalCents)}</span>}
                      </div>
                      {po.expectedDeliveryDate && (
                        <div className="text-[11px] mt-1.5 flex items-center gap-1">
                          <span className="text-muted-foreground">ETA</span>
                          <span className="font-medium">{formatDate(po.expectedDeliveryDate)}</span>
                        </div>
                      )}
                      <div className="h-[3px] bg-border rounded mt-2">
                        <div className="h-full rounded bg-blue-500" style={{ width: "0%" }} />
                      </div>
                    </div>
                  );
                })}
                {sentOrAcked.length === 0 && (
                  <div className="text-xs text-muted-foreground text-center py-4">No POs awaiting shipment</div>
                )}
              </CardContent>
            </Card>

            {/* Step 3: Receive Stock */}
            <Card>
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-muted text-muted-foreground border">3</div>
                <h3 className="text-xs font-semibold">Receive Stock</h3>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {data.inFlightPos.length} arriving soon
                </span>
              </div>
              <CardContent className="p-3 space-y-2">
                {data.inFlightPos.slice(0, 3).map((po) => {
                  const badge = STATUS_BADGE[po.status] || STATUS_BADGE.draft;
                  const pct = po.lineCount > 0 ? Math.round((po.receivedLineCount / po.lineCount) * 100) : 0;
                  return (
                    <div key={po.id} className="bg-muted/50 border rounded-md p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] text-primary font-semibold">{po.poNumber}</span>
                        <Badge variant="outline" className={`text-[10px] ${badge.className}`}>{badge.label}</Badge>
                      </div>
                      <div className="text-sm font-semibold mt-1">{po.vendorName}</div>
                      <div className="flex gap-3 mt-1 text-[11px] text-muted-foreground">
                        <span>{po.receivedLineCount} of {po.lineCount} lines</span>
                        {po.totalCents != null && <span>{formatCents(po.totalCents)}</span>}
                      </div>
                      {po.expectedDeliveryDate && (
                        <div className="text-[11px] mt-1.5 flex items-center gap-1">
                          <span className="text-muted-foreground">{po.status === "partially_received" ? "Remainder ETA" : "ETA"}</span>
                          <span className="font-medium">{formatDate(po.expectedDeliveryDate)}</span>
                        </div>
                      )}
                      <div className="h-[3px] bg-border rounded mt-2">
                        <div className={`h-full rounded ${pct > 0 ? "bg-orange-500" : "bg-blue-500"}`} style={{ width: `${Math.max(pct, pct > 0 ? 5 : 0)}%` }} />
                      </div>
                    </div>
                  );
                })}
                <Button variant="outline" size="sm" className="w-full text-xs justify-center bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100" onClick={() => navigate("/receiving")}>
                  <Truck className="h-3 w-3 mr-1.5" />
                  Open Receiving
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Two Column: Action Queue + Timeline */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3">
          {/* Left: Action Queue */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Full Action Queue</span>
              <a className="text-xs text-primary cursor-pointer hover:underline" onClick={() => navigate("/reorder-analysis")}>Reorder Analysis →</a>
            </div>
            <Card className="overflow-hidden">
              {/* Order Now */}
              <div className="border-b p-4">
                <div className="flex items-center gap-2 mb-3">
                  <h4 className="text-xs font-semibold">Order Now — Below Reorder Point</h4>
                  <Badge variant="outline" className="text-[10px] bg-orange-50 text-orange-600 border-orange-200">{data.orderNowItems.length}</Badge>
                </div>
                <div className="space-y-1.5">
                  {data.orderNowItems.slice(0, 6).map((item) => (
                    <div key={item.productId} className="flex items-center gap-2 p-1.5 border rounded-md text-sm">
                      <span className="font-mono text-[11px] text-primary w-[140px] flex-shrink-0 truncate">{item.sku}</span>
                      <span className="text-xs flex-1 truncate">{item.productName}</span>
                      <span className={`text-[11px] font-bold w-9 text-right flex-shrink-0 ${item.daysOfSupply < 7 ? "text-red-500" : item.daysOfSupply < 14 ? "text-orange-500" : ""}`}>{item.daysOfSupply}d</span>
                      <Button size="sm" variant="outline" className="text-[10px] h-6 px-2 bg-orange-50 border-orange-200 text-orange-600 hover:bg-orange-100 flex-shrink-0" onClick={() => navigate("/purchase-orders")}>
                        + PO
                      </Button>
                    </div>
                  ))}
                </div>
                {data.orderNowItems.length > 6 && (
                  <div className="pt-2">
                    <Button variant="ghost" size="sm" className="text-[10px] text-muted-foreground h-6" onClick={() => navigate("/reorder-analysis?status=order_now")}>
                      + {data.orderNowItems.length - 6} more items
                    </Button>
                  </div>
                )}
              </div>

              {/* No Vendor */}
              <div className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <h4 className="text-xs font-semibold">No Preferred Vendor Assigned</h4>
                  <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground">{data.noVendorItems.length}</Badge>
                </div>
                <div className="space-y-1.5">
                  {data.noVendorItems.map((item) => (
                    <div key={item.productId} className="flex items-center gap-2 p-1.5 border rounded-md">
                      <span className="font-mono text-[11px] text-muted-foreground w-[140px] flex-shrink-0 truncate">{item.sku}</span>
                      <span className="text-xs flex-1">{item.productName}</span>
                      <span className="text-[11px] text-muted-foreground flex-shrink-0">{item.totalOnHand} remaining</span>
                      <Button variant="ghost" size="sm" className="text-[10px] h-6 px-2 flex-shrink-0 ml-auto" onClick={() => navigate("/suppliers")}>
                        Assign →
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          {/* Right: Delivery Timeline */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Delivery Timeline</span>
              <a className="text-xs text-primary cursor-pointer hover:underline" onClick={() => navigate("/purchase-orders")}>All POs →</a>
            </div>
            <Card>
              <CardContent className="p-3 space-y-3">
                {timelineDays.map((day, i) => (
                  <div key={i}>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{day.label}</div>
                    {day.pos.length > 0 ? (
                      day.pos.map((po) => (
                        <div key={po.id} className={`flex items-center gap-2 p-2 bg-muted/50 rounded-md border-l-[3px] ${i <= 1 ? "border-l-orange-500" : "border-l-blue-500"}`}>
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-[10px] text-primary">{po.poNumber}</div>
                            <div className="text-xs truncate">{po.vendorName}</div>
                          </div>
                          <span className="text-[10px] text-muted-foreground flex-shrink-0">{po.lineCount} items</span>
                          {(i <= 1) && (
                            <Button size="sm" variant="outline" className="text-[10px] h-6 px-2 bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100 flex-shrink-0" onClick={() => navigate("/receiving")}>
                              Receive
                            </Button>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="text-xs text-muted-foreground/60 py-1 px-2">No deliveries expected</div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Metrics Row */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Metrics</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {/* Inventory Health */}
            <Card className="p-4">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Inventory Health · {health.total} SKUs</h4>
              <div className="space-y-2">
                {[
                  { label: "Stockout", count: health.stockout, color: "bg-red-500", textColor: "text-red-500" },
                  { label: "Order Now", count: health.order_now, color: "bg-orange-500", textColor: "text-orange-500" },
                  { label: "Order Soon", count: health.order_soon, color: "bg-amber-500", textColor: "text-amber-600" },
                  { label: "OK", count: health.ok, color: "bg-green-500", textColor: "text-green-600" },
                  { label: "No Movement", count: health.no_movement, color: "bg-slate-400", textColor: "text-slate-400" },
                ].map((row) => (
                  <div key={row.label} className="flex items-center gap-2">
                    <span className={`text-xs w-[90px] flex-shrink-0 ${row.textColor}`}>● {row.label}</span>
                    <div className="flex-1 h-[5px] bg-border rounded">
                      <div className={`h-full rounded ${row.color}`} style={{ width: `${health.total > 0 ? (row.count / health.total) * 100 : 0}%` }} />
                    </div>
                    <span className={`text-xs font-semibold w-7 text-right ${row.textColor}`}>{row.count}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Spend */}
            <Card className="p-4">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Spend · Last 30 Days</h4>
              <div className="space-y-2">
                {[
                  { label: "Total received", value: formatCents(data.spend.totalReceivedCents) },
                  { label: "Open PO value", value: formatCents(data.spend.openPoValueCents) },
                  { label: "Avg per PO", value: formatCents(data.spend.avgPoCents) },
                  { label: "Top supplier", value: data.spend.topSupplierName ? `${data.spend.topSupplierName} · ${formatCents(data.spend.topSupplierCents)}` : "—" },
                  { label: "Active suppliers", value: `${data.spend.activeSupplierCount} this month` },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between py-1 border-b last:border-0 text-xs">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="font-semibold">{row.value}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Auto-Draft */}
            <Card className="p-4">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Nightly Auto-Draft</h4>
              {data.lastAutoDraftRun ? (
                <>
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-2 h-2 rounded-full ${data.lastAutoDraftRun.status === "success" ? "bg-green-500 shadow-[0_0_0_3px_rgba(34,197,94,0.2)]" : "bg-red-500"}`} />
                    <span className="text-xs">
                      Last run: {formatRelativeTime(data.lastAutoDraftRun.runAt)} · {data.lastAutoDraftRun.status === "success" ? "Success" : "Error"}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {[
                      { label: "Items analyzed", value: data.lastAutoDraftRun.itemsAnalyzed },
                      { label: "POs created/updated", value: `${data.lastAutoDraftRun.posCreated}/${data.lastAutoDraftRun.posUpdated}` },
                      { label: "Skipped (no vendor)", value: data.lastAutoDraftRun.skippedNoVendor, warn: true },
                      { label: "Excluded SKUs", value: data.lastAutoDraftRun.skippedExcluded },
                      { label: "Next run", value: "Tonight 2:00am" },
                    ].map((row) => (
                      <div key={row.label} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{row.label}</span>
                        <span className={`font-semibold ${row.warn ? "text-amber-600" : ""}`}>{row.value}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-xs text-muted-foreground">Never run</div>
              )}
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-3 text-xs justify-center"
                onClick={() => runAutoDraftMutation.mutate()}
                disabled={runAutoDraftMutation.isPending}
              >
                <Zap className="h-3 w-3 mr-1.5" />
                {runAutoDraftMutation.isPending ? "Running..." : "Run Auto-Draft Now"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full mt-1 text-[11px] justify-center text-muted-foreground"
                onClick={() => setExclusionModalOpen(true)}
              >
                ⚙️ Manage Exclusions
              </Button>
            </Card>
          </div>
        </div>
      </div>

      <ExclusionRulesModal open={exclusionModalOpen} onOpenChange={setExclusionModalOpen} />
    </div>
  );
}
