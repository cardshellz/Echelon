import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Users,
  DollarSign,
  TrendingDown,
  AlertTriangle,
  CreditCard,
  Play,
  Pause,
  XCircle,
  ArrowUpDown,
  CheckCircle2,
  Clock,
  Search,
  Settings,
  Activity,
  RotateCcw,
  ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

const API = "/api/subscriptions";
const MEMBERSHIP_API = "/api/membership";

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    active: "bg-green-100 text-green-800",
    current: "bg-green-100 text-green-800",
    cancelled: "bg-red-100 text-red-800",
    past_due: "bg-yellow-100 text-yellow-800",
    paused: "bg-blue-100 text-blue-800",
    success: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
    pending: "bg-yellow-100 text-yellow-800",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${variants[status] || "bg-gray-100 text-gray-800"}`}>
      {status}
    </span>
  );
}

// ─── Dashboard Tab ──────────────────────────────────────────────────

function DashboardTab() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [recentEvents, setRecentEvents] = useState<any[]>([]);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, eventsRes] = await Promise.all([
        fetch(`${API}/dashboard`).then(r => r.json()),
        fetch(`${API}/events/list?limit=10`).then(r => r.json()),
      ]);
      setStats(statsRes);
      setRecentEvents(eventsRes);
    } catch (err) {
      console.error("Failed to load dashboard", err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  if (loading) return <div className="p-8 text-center text-muted-foreground">Loading dashboard...</div>;
  if (!stats) return <div className="p-8 text-center text-muted-foreground">Failed to load</div>;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <Users className="h-4 w-4" /> Active Subscribers
            </div>
            <div className="text-2xl font-bold">{stats.totalActive}</div>
            <div className="text-xs text-muted-foreground mt-1">
              {stats.totalActiveStandard} Standard · {stats.totalActiveGold} Gold
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <DollarSign className="h-4 w-4" /> Monthly Recurring
            </div>
            <div className="text-2xl font-bold">{formatCents(stats.mrr)}</div>
            <div className="text-xs text-muted-foreground mt-1">MRR</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <TrendingDown className="h-4 w-4" /> 30-Day Churn
            </div>
            <div className="text-2xl font-bold">{stats.churnRate30}%</div>
            <div className="text-xs text-muted-foreground mt-1">
              90-day: {stats.churnRate90}%
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <AlertTriangle className="h-4 w-4" /> Past Due
            </div>
            <div className="text-2xl font-bold text-yellow-600">{stats.pastDueCount}</div>
            <div className="text-xs text-muted-foreground mt-1">
              +{stats.newThisMonth} new · -{stats.cancelledThisMonth} cancelled this month
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Events */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent Subscription Events</CardTitle>
        </CardHeader>
        <CardContent>
          {recentEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events yet</p>
          ) : (
            <div className="space-y-2">
              {recentEvents.map((event: any) => (
                <div key={event.id} className="flex items-center justify-between text-sm border-b pb-2 last:border-0">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={event.event_type} />
                    <span className="text-muted-foreground">{event.notes || event.event_type}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDateTime(event.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Subscriber List Tab ────────────────────────────────────────────

function SubscriberListTab({ onSelectSubscription }: { onSelectSubscription: (id: number) => void }) {
  const [subs, setSubs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [tierFilter, setTierFilter] = useState("all");
  const [page, setPage] = useState(0);
  const limit = 25;

  const loadSubs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (tierFilter !== "all") params.set("tier", tierFilter);
    if (search) params.set("search", search);
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));

    try {
      const res = await fetch(`${API}/list?${params}`).then(r => r.json());
      setSubs(res.rows);
      setTotal(res.total);
    } catch (err) {
      console.error("Failed to load subscribers", err);
    }
    setLoading(false);
  }, [statusFilter, tierFilter, search, page]);

  useEffect(() => { loadSubs(); }, [loadSubs]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(0); }}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
          </SelectContent>
        </Select>
        <Select value={tierFilter} onValueChange={v => { setTierFilter(v); setPage(0); }}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Tiers</SelectItem>
            <SelectItem value="standard">Standard</SelectItem>
            <SelectItem value="gold">Gold</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={loadSubs}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead className="hidden sm:table-cell">Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Billing</TableHead>
              <TableHead className="hidden md:table-cell">Next Billing</TableHead>
              <TableHead className="hidden lg:table-cell">Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            ) : subs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No subscribers found</TableCell>
              </TableRow>
            ) : subs.map(sub => (
              <TableRow
                key={sub.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onSelectSubscription(sub.id)}
              >
                <TableCell>
                  <div className="font-medium text-sm">{sub.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {sub.first_name} {sub.last_name}
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <div className="text-sm">{sub.plan_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {sub.price_cents ? formatCents(sub.price_cents) : "—"}/{sub.billing_interval === "year" ? "yr" : "mo"}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={sub.status} />
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <StatusBadge status={sub.billing_status} />
                  {sub.failed_billing_attempts > 0 && (
                    <span className="text-xs text-red-500 ml-1">({sub.failed_billing_attempts} fails)</span>
                  )}
                </TableCell>
                <TableCell className="hidden md:table-cell text-sm">
                  {formatDate(sub.next_billing_date)}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                  {formatDate(sub.started_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={(page + 1) * limit >= total} onClick={() => setPage(p => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Subscription Detail ────────────────────────────────────────────

function SubscriptionDetail({ subscriptionId, onBack }: { subscriptionId: number; onBack: () => void }) {
  const [detail, setDetail] = useState<any>(null);
  const [billingLogs, setBillingLogs] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showPlanDialog, setShowPlanDialog] = useState(false);
  const [plans, setPlans] = useState<any[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const { toast } = useToast();

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/${subscriptionId}`).then(r => r.json());
      setDetail(res.subscription);
      setBillingLogs(res.billingLogs || []);
      setEvents(res.events || []);
    } catch (err) {
      console.error("Failed to load detail", err);
    }
    setLoading(false);
  }, [subscriptionId]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const handleCancel = async () => {
    try {
      await fetch(`${API}/${subscriptionId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason || "Admin cancelled" }),
      });
      toast({ title: "Subscription cancelled" });
      setShowCancelDialog(false);
      loadDetail();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleRetryBilling = async () => {
    try {
      const res = await fetch(`${API}/${subscriptionId}/retry-billing`, { method: "POST" }).then(r => r.json());
      if (res.success) {
        toast({ title: "Billing retry initiated" });
      } else {
        toast({ title: "Retry failed", description: res.error, variant: "destructive" });
      }
      loadDetail();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handlePause = async (paused: boolean) => {
    try {
      await fetch(`${API}/${subscriptionId}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      toast({ title: paused ? "Subscription paused" : "Subscription unpaused" });
      loadDetail();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleChangePlan = async () => {
    if (!selectedPlanId) return;
    try {
      await fetch(`${API}/${subscriptionId}/change-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: selectedPlanId }),
      });
      toast({ title: "Plan changed" });
      setShowPlanDialog(false);
      loadDetail();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const loadPlans = async () => {
    try {
      const res = await fetch(`${API}/plans/list`).then(r => r.json());
      setPlans(res.plans || []);
    } catch (err) {
      console.error("Failed to load plans", err);
    }
  };

  if (loading) return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  if (!detail) return <div className="p-8 text-center text-muted-foreground">Not found</div>;

  const isActive = detail.status === "active";
  const isPaused = detail.status === "paused";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h3 className="text-lg font-semibold">{detail.email}</h3>
          <p className="text-sm text-muted-foreground">
            {detail.first_name} {detail.last_name} · Subscription #{detail.id}
          </p>
        </div>
        <StatusBadge status={detail.status} />
      </div>

      {/* Info + Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Subscription Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Plan</span><span className="font-medium">{detail.plan_name}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Tier</span><Badge variant="outline">{detail.tier}</Badge></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Price</span><span>{detail.price_cents ? formatCents(detail.price_cents) : "—"}/{detail.billing_interval === "year" ? "yr" : "mo"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Billing Status</span><StatusBadge status={detail.billing_status} /></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Next Billing</span><span>{formatDate(detail.next_billing_date)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Started</span><span>{formatDate(detail.started_at)}</span></div>
            {detail.cancelled_at && (
              <div className="flex justify-between"><span className="text-muted-foreground">Cancelled</span><span>{formatDate(detail.cancelled_at)}</span></div>
            )}
            {detail.includes_dropship && (
              <div className="flex justify-between"><span className="text-muted-foreground">Dropship</span><Badge className="bg-purple-100 text-purple-800">Included</Badge></div>
            )}
            {detail.shopify_subscription_contract_id && (
              <div className="flex justify-between"><span className="text-muted-foreground">Shopify Contract</span><span className="font-mono text-xs">{detail.shopify_subscription_contract_id}</span></div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {isActive && (
              <>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={handleRetryBilling}
                >
                  <RotateCcw className="h-4 w-4 mr-2" /> Retry Billing
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => handlePause(true)}
                >
                  <Pause className="h-4 w-4 mr-2" /> Pause Subscription
                </Button>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => { loadPlans(); setShowPlanDialog(true); }}
                >
                  <ArrowUpDown className="h-4 w-4 mr-2" /> Change Plan
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start"
                  onClick={() => setShowCancelDialog(true)}
                >
                  <XCircle className="h-4 w-4 mr-2" /> Cancel Subscription
                </Button>
              </>
            )}
            {isPaused && (
              <>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => handlePause(false)}
                >
                  <Play className="h-4 w-4 mr-2" /> Resume Subscription
                </Button>
                <Button
                  variant="destructive"
                  className="w-full justify-start"
                  onClick={() => setShowCancelDialog(true)}
                >
                  <XCircle className="h-4 w-4 mr-2" /> Cancel Subscription
                </Button>
              </>
            )}
            {detail.status === "cancelled" && (
              <p className="text-sm text-muted-foreground">
                This subscription is cancelled.
                {detail.cancellation_reason && <span className="block mt-1">Reason: {detail.cancellation_reason}</span>}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Billing History */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Billing History</CardTitle>
        </CardHeader>
        <CardContent>
          {billingLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No billing attempts</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell">Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {billingLogs.map((log: any) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-sm">{formatDateTime(log.created_at)}</TableCell>
                      <TableCell className="text-sm">{formatCents(log.amount_cents)}</TableCell>
                      <TableCell><StatusBadge status={log.status} /></TableCell>
                      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">{log.error_message || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Event Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Event Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events</p>
          ) : (
            <div className="space-y-3">
              {events.map((event: any) => (
                <div key={event.id} className="flex items-start gap-3 text-sm">
                  <div className="mt-0.5">
                    {event.event_type === "created" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
                    {event.event_type === "renewed" && <CreditCard className="h-4 w-4 text-green-500" />}
                    {event.event_type === "cancelled" && <XCircle className="h-4 w-4 text-red-500" />}
                    {event.event_type === "failed" && <AlertTriangle className="h-4 w-4 text-yellow-500" />}
                    {event.event_type === "paused" && <Pause className="h-4 w-4 text-blue-500" />}
                    {event.event_type === "reactivated" && <Play className="h-4 w-4 text-green-500" />}
                    {event.event_type === "plan_changed" && <ArrowUpDown className="h-4 w-4 text-purple-500" />}
                    {!["created", "renewed", "cancelled", "failed", "paused", "reactivated", "plan_changed"].includes(event.event_type) && (
                      <Activity className="h-4 w-4 text-gray-400" />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="font-medium">{event.event_type}</div>
                    {event.notes && <div className="text-muted-foreground text-xs">{event.notes}</div>}
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {formatDateTime(event.created_at)} · via {event.event_source}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cancel Dialog */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Subscription</DialogTitle>
            <DialogDescription>
              This will cancel the member's subscription and remove their Shellz Club benefits.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Cancellation reason (optional)"
            value={cancelReason}
            onChange={e => setCancelReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>Keep Active</Button>
            <Button variant="destructive" onClick={handleCancel}>Confirm Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change Plan Dialog */}
      <Dialog open={showPlanDialog} onOpenChange={setShowPlanDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Plan</DialogTitle>
            <DialogDescription>
              Select a new plan for this subscriber. Takes effect on next billing cycle.
            </DialogDescription>
          </DialogHeader>
          <Select value={selectedPlanId ? String(selectedPlanId) : ""} onValueChange={v => setSelectedPlanId(parseInt(v))}>
            <SelectTrigger>
              <SelectValue placeholder="Select plan" />
            </SelectTrigger>
            <SelectContent>
              {plans.filter(p => p.is_active && p.id !== detail.plan_id).map((p: any) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name} — {p.price_cents ? formatCents(p.price_cents) : "—"}/{p.billing_interval === "year" ? "yr" : "mo"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPlanDialog(false)}>Cancel</Button>
            <Button onClick={handleChangePlan} disabled={!selectedPlanId}>Change Plan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Plans Tab ──────────────────────────────────────────────────────

function PlansTab() {
  const [plans, setPlans] = useState<any[]>([]);
  const [sellingPlanMap, setSellingPlanMap] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [setupLoading, setSetupLoading] = useState(false);
  const { toast } = useToast();

  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/plans/list`).then(r => r.json());
      setPlans(res.plans || []);
      setSellingPlanMap(res.sellingPlanMap || []);
    } catch (err) {
      console.error("Failed to load plans", err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  const handleSetupSellingPlans = async () => {
    setSetupLoading(true);
    try {
      const res = await fetch(`${MEMBERSHIP_API}/setup-selling-plans`, { method: "POST" }).then(r => r.json());
      if (res.error) {
        toast({ title: "Error", description: res.error, variant: "destructive" });
      } else {
        toast({ title: "Selling plans created", description: `Group: ${res.sellingPlanGroupGid}` });
        loadPlans();
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
    setSetupLoading(false);
  };

  const handleRegisterWebhooks = async () => {
    try {
      const res = await fetch(`${MEMBERSHIP_API}/register-webhooks`, { method: "POST" }).then(r => r.json());
      toast({ title: "Webhooks registered", description: `Registered: ${(res.registered || []).join(", ")}` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  if (loading) return <div className="p-8 text-center text-muted-foreground">Loading plans...</div>;

  return (
    <div className="space-y-6">
      {/* Setup Actions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Shopify Setup</CardTitle>
          <CardDescription>Create selling plans and register webhooks with Shopify</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col sm:flex-row gap-2">
          <Button onClick={handleSetupSellingPlans} disabled={setupLoading}>
            <Settings className="h-4 w-4 mr-2" />
            {setupLoading ? "Creating..." : "Setup Selling Plans"}
          </Button>
          <Button variant="outline" onClick={handleRegisterWebhooks}>
            Register Webhooks
          </Button>
        </CardContent>
      </Card>

      {/* Plans Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Plans</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Interval</TableHead>
                  <TableHead className="hidden sm:table-cell">Dropship</TableHead>
                  <TableHead className="hidden md:table-cell">Shopify ID</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((plan: any) => (
                  <TableRow key={plan.id}>
                    <TableCell className="font-medium text-sm">{plan.name}</TableCell>
                    <TableCell><Badge variant="outline">{plan.tier || "—"}</Badge></TableCell>
                    <TableCell className="text-sm">{plan.price_cents ? formatCents(plan.price_cents) : "—"}</TableCell>
                    <TableCell className="text-sm">{plan.billing_interval || "—"}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {plan.includes_dropship ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : "—"}
                    </TableCell>
                    <TableCell className="hidden md:table-cell font-mono text-xs">
                      {plan.shopify_selling_plan_gid ? "✓ Synced" : "—"}
                    </TableCell>
                    <TableCell>
                      {plan.is_active ? (
                        <Badge className="bg-green-100 text-green-800">Active</Badge>
                      ) : (
                        <Badge className="bg-gray-100 text-gray-800">Inactive</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Selling Plan Map */}
      {sellingPlanMap.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Shopify Selling Plan Mapping</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan Name</TableHead>
                    <TableHead>Interval</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead className="hidden sm:table-cell">Shopify GID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sellingPlanMap.map((sp: any) => (
                    <TableRow key={sp.id}>
                      <TableCell className="text-sm">{sp.plan_name}</TableCell>
                      <TableCell className="text-sm">{sp.billing_interval}</TableCell>
                      <TableCell className="text-sm">{formatCents(sp.price_cents)}</TableCell>
                      <TableCell className="hidden sm:table-cell font-mono text-xs">{sp.shopify_selling_plan_gid}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Billing Log Tab ────────────────────────────────────────────────

function BillingLogTab() {
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const limit = 25;
  const { toast } = useToast();

  const loadLogs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));

    try {
      const res = await fetch(`${API}/billing/log?${params}`).then(r => r.json());
      setLogs(res.rows || []);
      setTotal(res.total || 0);
    } catch (err) {
      console.error("Failed to load billing logs", err);
    }
    setLoading(false);
  }, [statusFilter, page]);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  const handleManualRun = async () => {
    try {
      const res = await fetch(`${API}/billing/run`, { method: "POST" }).then(r => r.json());
      toast({
        title: "Billing run complete",
        description: `Processed: ${res.processed}, Succeeded: ${res.succeeded}, Failed: ${res.failed}`,
      });
      loadLogs();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2">
        <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(0); }}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={handleManualRun}>
          <Play className="h-4 w-4 mr-2" /> Run Billing Now
        </Button>
        <Button variant="outline" size="icon" onClick={loadLogs}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Member</TableHead>
              <TableHead className="hidden sm:table-cell">Plan</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            ) : logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No billing logs</TableCell>
              </TableRow>
            ) : logs.map((log: any) => (
              <TableRow key={log.id}>
                <TableCell className="text-sm">{formatDateTime(log.created_at)}</TableCell>
                <TableCell className="text-sm">{log.member_email || "—"}</TableCell>
                <TableCell className="hidden sm:table-cell text-sm">{log.plan_name || "—"}</TableCell>
                <TableCell className="text-sm">{formatCents(log.amount_cents)}</TableCell>
                <TableCell><StatusBadge status={log.status} /></TableCell>
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground max-w-[200px] truncate">
                  {log.error_message || "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {total > limit && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button>
            <Button variant="outline" size="sm" disabled={(page + 1) * limit >= total} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export default function Subscriptions() {
  const [selectedSubscription, setSelectedSubscription] = useState<number | null>(null);

  if (selectedSubscription) {
    return (
      <div className="p-4 md:p-6 max-w-6xl mx-auto">
        <SubscriptionDetail
          subscriptionId={selectedSubscription}
          onBack={() => setSelectedSubscription(null)}
        />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Subscriptions</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Shellz Club membership management — billing, plans, and subscriber lifecycle
        </p>
      </div>

      <Tabs defaultValue="dashboard" className="space-y-4">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="dashboard" className="flex items-center gap-1">
            <Activity className="h-3.5 w-3.5" /> Dashboard
          </TabsTrigger>
          <TabsTrigger value="subscribers" className="flex items-center gap-1">
            <Users className="h-3.5 w-3.5" /> Subscribers
          </TabsTrigger>
          <TabsTrigger value="plans" className="flex items-center gap-1">
            <Settings className="h-3.5 w-3.5" /> Plans
          </TabsTrigger>
          <TabsTrigger value="billing" className="flex items-center gap-1">
            <CreditCard className="h-3.5 w-3.5" /> Billing Log
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard">
          <DashboardTab />
        </TabsContent>
        <TabsContent value="subscribers">
          <SubscriberListTab onSelectSubscription={setSelectedSubscription} />
        </TabsContent>
        <TabsContent value="plans">
          <PlansTab />
        </TabsContent>
        <TabsContent value="billing">
          <BillingLogTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
