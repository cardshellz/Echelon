import { useState, useEffect } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ArrowLeft, Info, Save, Loader2, Building2, FileText } from "lucide-react";

// ---------------------------------------------------------------------------
// Types (mirror of inventory.warehouse_settings)
// ---------------------------------------------------------------------------
interface WarehouseSettings {
  id: number;
  warehouseId: number | null;
  warehouseCode: string;
  warehouseName: string;
  isActive: number;

  // Replenishment
  replenMode: string;
  shortPickAction: string;
  autoGenerateTrigger: string;
  inlineReplenMaxUnits: number;
  inlineReplenMaxCases: number;
  urgentReplenThreshold: number;
  stockoutPriority: number;
  minMaxPriority: number;
  scheduledReplenIntervalMinutes: number;
  scheduledReplenEnabled: number;

  // Wave planning (scaffold)
  maxOrdersPerWave: number;
  maxItemsPerWave: number;
  waveAutoRelease: number;

  // Order combining
  enableOrderCombining: number;

  // Channel sync
  channelSyncEnabled: number;
  channelSyncIntervalMinutes: number;

  // Velocity / reorder
  velocityLookbackDays: number;

  // Picking workflow
  postPickStatus: string;
  pickMode: string;
  requireScanConfirm: number;
  pickingBatchSize: number;
  autoReleaseDelayMinutes: number;
}

interface Warehouse {
  id: number;
  code: string;
  name: string;
  isActive: number;
}

const IS_DEFAULT_ID = "DEFAULT";

// Small tooltip hint helper
function HintIcon({ text }: { text: string }) {
  return (
    <TooltipProvider>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <Info className="w-3.5 h-3.5 text-muted-foreground inline-block ml-1 cursor-help" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs">{text}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function WarehouseSettingsPage() {
  const params = useParams<{ id: string }>();
  const routeId = params.id;
  const isDefault = routeId === IS_DEFAULT_ID;
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Load the right row: DEFAULT looks up by code, warehouse looks up by warehouseId
  const { data: rows, isLoading } = useQuery<WarehouseSettings[]>({
    queryKey: ["/api/warehouse-settings"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/warehouse-settings");
      return res.json();
    },
  });

  const { data: allWarehouses } = useQuery<Warehouse[]>({
    queryKey: ["/api/warehouses"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/warehouses");
      return res.json();
    },
  });

  // Find current row
  const current = (rows ?? []).find((r) =>
    isDefault
      ? r.warehouseCode === "DEFAULT" && r.warehouseId == null
      : String(r.warehouseId) === routeId,
  );
  const warehouseMeta = !isDefault
    ? (allWarehouses ?? []).find((w) => String(w.id) === routeId)
    : null;

  // Local form state (so we can edit before saving)
  const [form, setForm] = useState<Partial<WarehouseSettings> | null>(null);

  useEffect(() => {
    if (current) setForm({ ...current });
    else if (!isLoading && rows && !isDefault && warehouseMeta) {
      // No row yet for this warehouse — seed from DEFAULT template
      const def = rows.find((r) => r.warehouseCode === "DEFAULT" && r.warehouseId == null);
      if (def) {
        setForm({
          ...def,
          id: undefined as any,
          warehouseId: Number(routeId),
          warehouseCode: warehouseMeta.code,
          warehouseName: warehouseMeta.name,
        });
      }
    }
  }, [current, isLoading, rows, isDefault, routeId, warehouseMeta]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error("No form data");
      if (current?.id) {
        // update
        const res = await apiRequest("PATCH", `/api/warehouse-settings/${current.id}`, form);
        return res.json();
      } else {
        // create (first-time for a warehouse; inherits DEFAULT's values from the seed above)
        const res = await apiRequest("POST", `/api/warehouse-settings`, form);
        return res.json();
      }
    },
    onSuccess: () => {
      toast({ title: "Settings saved", description: "Changes applied successfully." });
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse-settings"] });
    },
    onError: (err: any) => {
      toast({
        title: "Save failed",
        description: String(err?.message ?? err),
        variant: "destructive",
      });
    },
  });

  if (isLoading || !form) {
    return (
      <div className="container mx-auto p-6 flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const titleLabel = isDefault
    ? "Default Settings Template"
    : warehouseMeta?.name || `Warehouse #${routeId}`;
  const titleSub = isDefault
    ? "Values here are the fallback for every warehouse without an explicit override."
    : `Overrides for ${warehouseMeta?.code ?? ""}. Missing values inherit from the Default Template.`;

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/warehouse" data-testid="btn-back-warehouses">
              <ArrowLeft className="w-4 h-4 mr-1" /> Back to Warehouses
            </Link>
          </Button>
          <div>
            <h1 className="text-xl md:text-2xl font-semibold flex items-center gap-2">
              {isDefault ? <FileText className="w-6 h-6" /> : <Building2 className="w-6 h-6" />}
              {titleLabel}
              {isDefault && (
                <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400">
                  Template
                </Badge>
              )}
            </h1>
            <p className="text-xs md:text-sm text-muted-foreground mt-1">{titleSub}</p>
          </div>
        </div>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          data-testid="btn-save-settings"
        >
          {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      <Tabs defaultValue="picking" className="w-full">
        <TabsList className="w-full overflow-x-auto justify-start">
          <TabsTrigger value="picking">Picking</TabsTrigger>
          <TabsTrigger value="replen">Replenishment</TabsTrigger>
          <TabsTrigger value="combining">Order Combining</TabsTrigger>
          <TabsTrigger value="sync">Channel Sync</TabsTrigger>
          <TabsTrigger value="velocity">Velocity</TabsTrigger>
          <TabsTrigger value="waves">Waves</TabsTrigger>
        </TabsList>

        {/* ================ PICKING ================ */}
        <TabsContent value="picking">
          <Card>
            <CardHeader>
              <CardTitle>Picking workflow</CardTitle>
              <CardDescription>Controls for the pick queue, batch behavior, and scan confirmation.</CardDescription>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-6">
              <div>
                <Label>
                  Post-pick status
                  <HintIcon text="Status orders are set to after a successful pick. Usually 'ready_to_ship' so shipping can claim them." />
                </Label>
                <Select
                  value={form.postPickStatus ?? "ready_to_ship"}
                  onValueChange={(v) => setForm({ ...form, postPickStatus: v })}
                >
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ready_to_ship">Ready to Ship</SelectItem>
                    <SelectItem value="packed">Packed</SelectItem>
                    <SelectItem value="pick_complete">Pick Complete</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>
                  Pick mode
                  <HintIcon text="How pickers work: single_order = claim one order at a time; batch = multiple orders per trip; wave = wave planning (coming soon)." />
                </Label>
                <Select
                  value={form.pickMode ?? "single_order"}
                  onValueChange={(v) => setForm({ ...form, pickMode: v })}
                >
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single_order">Single Order</SelectItem>
                    <SelectItem value="batch">Batch</SelectItem>
                    <SelectItem value="wave">Wave (coming soon)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={form.requireScanConfirm === 1}
                  onCheckedChange={(checked) => setForm({ ...form, requireScanConfirm: checked ? 1 : 0 })}
                />
                <div>
                  <Label>
                    Require scan confirmation
                    <HintIcon text="When on, pickers must scan the item's barcode to confirm each pick. Catches wrong-SKU mistakes but adds seconds to every pick." />
                  </Label>
                  <p className="text-xs text-muted-foreground">Force barcode scan on every pick. Safer but slower.</p>
                </div>
              </div>
              <div>
                <Label>
                  Picking batch size
                  <HintIcon text="Max orders assigned to a single picker batch. Higher = fewer trips to pack; lower = more nimble with rush orders." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={form.pickingBatchSize ?? 20}
                  onChange={(e) => setForm({ ...form, pickingBatchSize: parseInt(e.target.value) || 20 })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>
                  Auto-release delay (minutes)
                  <HintIcon text="If a picker claims an order but doesn't complete it, it's auto-released back to the queue after this many minutes." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={form.autoReleaseDelayMinutes ?? 30}
                  onChange={(e) => setForm({ ...form, autoReleaseDelayMinutes: parseInt(e.target.value) || 30 })}
                  className="mt-1"
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================ REPLENISHMENT ================ */}
        <TabsContent value="replen">
          <Card>
            <CardHeader>
              <CardTitle>Replenishment</CardTitle>
              <CardDescription>How bulk-to-pick-bin replenishment tasks are generated and executed.</CardDescription>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-6">
              <div>
                <Label>
                  Replenishment mode
                  <HintIcon text="inline = execute immediately; queue = task list for warehouse staff; hybrid = inline for small qty, queue for large." />
                </Label>
                <Select
                  value={form.replenMode ?? "queue"}
                  onValueChange={(v) => setForm({ ...form, replenMode: v })}
                >
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inline">Inline (auto-execute)</SelectItem>
                    <SelectItem value="queue">Queue (manual)</SelectItem>
                    <SelectItem value="hybrid">Hybrid</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>
                  Short pick action
                  <HintIcon text="What to do when a pick comes up short of requested qty." />
                </Label>
                <Select
                  value={form.shortPickAction ?? "partial_pick"}
                  onValueChange={(v) => setForm({ ...form, shortPickAction: v })}
                >
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="partial_pick">Partial Pick</SelectItem>
                    <SelectItem value="reject">Reject & Notify</SelectItem>
                    <SelectItem value="short_and_continue">Short & Continue</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>
                  Auto-generate trigger
                  <HintIcon text="When should replenishment tasks be generated automatically?" />
                </Label>
                <Select
                  value={form.autoGenerateTrigger ?? "manual_only"}
                  onValueChange={(v) => setForm({ ...form, autoGenerateTrigger: v })}
                >
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual_only">Manual Only</SelectItem>
                    <SelectItem value="on_short_pick">On Short Pick</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="on_both">On Short Pick + Scheduled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>
                  Inline replen max units
                  <HintIcon text="Hybrid-mode threshold measured in individual pieces. Tasks for this many units or fewer run inline (auto-execute); larger ones queue for a human." />
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={form.inlineReplenMaxUnits ?? 50}
                  onChange={(e) => setForm({ ...form, inlineReplenMaxUnits: parseInt(e.target.value) || 0 })}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  In hybrid mode, tasks under this threshold run inline; above, they queue.
                </p>
              </div>
              <div>
                <Label>
                  Inline replen max cases
                  <HintIcon text="Hybrid-mode threshold measured in cases. Same idea as max units, but for replens measured by case count. Whichever limit is crossed first pushes the task to the queue." />
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={form.inlineReplenMaxCases ?? 2}
                  onChange={(e) => setForm({ ...form, inlineReplenMaxCases: parseInt(e.target.value) || 0 })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>
                  Urgent replen threshold (units)
                  <HintIcon text="When on-hand drops to this many units or below, the replen is marked URGENT and jumps above normal tasks. Set to 0 to disable (only stockouts trigger urgency). Try 5–10 for proactive escalation." />
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={form.urgentReplenThreshold ?? 0}
                  onChange={(e) => setForm({ ...form, urgentReplenThreshold: parseInt(e.target.value) || 0 })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>
                  Stockout priority
                  <HintIcon text="Priority number assigned to replen tasks triggered by an empty pick bin. Lower = higher priority. Default 1 puts these at the top of the queue so active picks don't stay blocked." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={form.stockoutPriority ?? 1}
                  onChange={(e) => setForm({ ...form, stockoutPriority: parseInt(e.target.value) || 1 })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>
                  Min/max priority
                  <HintIcon text="Priority number for routine replens (bin fell below its min level, but isn't empty). Default 5 sits below stockouts (1) and urgent (3) so workers clear critical stuff first." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={form.minMaxPriority ?? 5}
                  onChange={(e) => setForm({ ...form, minMaxPriority: parseInt(e.target.value) || 5 })}
                  className="mt-1"
                />
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={form.scheduledReplenEnabled === 1}
                  onCheckedChange={(checked) => setForm({ ...form, scheduledReplenEnabled: checked ? 1 : 0 })}
                />
                <div>
                  <Label>
                    Scheduled replen enabled
                    <HintIcon text="When on, a background job pre-scans the warehouse on the interval below and queues upcoming replens before they become urgent. When off, replens are purely reactive (only on pick failure or manual trigger)." />
                  </Label>
                  <p className="text-xs text-muted-foreground">Run the scheduled replen job on the interval below.</p>
                </div>
              </div>
              <div>
                <Label>
                  Scheduled replen interval (minutes)
                  <HintIcon text="How often the scheduled replen scanner runs. 30 is balanced; lower values catch issues faster but put more load on the DB." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={form.scheduledReplenIntervalMinutes ?? 30}
                  onChange={(e) => setForm({ ...form, scheduledReplenIntervalMinutes: parseInt(e.target.value) || 30 })}
                  className="mt-1"
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================ ORDER COMBINING ================ */}
        <TabsContent value="combining">
          <Card>
            <CardHeader>
              <CardTitle>Order Combining</CardTitle>
              <CardDescription>
                Combine multiple orders to the same shipping address into a single pick/ship group.
                Warehouse-scoped — orders from different warehouses never combine.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Switch
                  checked={form.enableOrderCombining === 1}
                  onCheckedChange={(checked) => setForm({ ...form, enableOrderCombining: checked ? 1 : 0 })}
                />
                <div>
                  <Label>
                    Enable order combining for this warehouse
                    <HintIcon text="When on, multiple orders shipping to the same address get grouped into a single pick/ship bundle. Saves picker trips and shipping cost on customers who order twice in quick succession." />
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    When off, orders in this warehouse never combine even if they share an address.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================ CHANNEL SYNC ================ */}
        <TabsContent value="sync">
          <Card>
            <CardHeader>
              <CardTitle>Channel Sync</CardTitle>
              <CardDescription>Inventory push to connected sales channels (Shopify, eBay, etc).</CardDescription>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-6">
              <div className="flex items-center gap-3">
                <Switch
                  checked={form.channelSyncEnabled === 1}
                  onCheckedChange={(checked) => setForm({ ...form, channelSyncEnabled: checked ? 1 : 0 })}
                />
                <div>
                  <Label>
                    Channel sync enabled
                    <HintIcon text="Master switch for inventory push from this warehouse to Shopify/eBay/etc. Turn off to stop pushing entirely (useful during bulk edits or troubleshooting). Pull from channels still works." />
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Master kill-switch. When off, inventory stops pushing to this warehouse's channels.
                  </p>
                </div>
              </div>
              <div>
                <Label>
                  Channel sync interval (minutes)
                  <HintIcon text="Target interval for full inventory-level pushes. The actual orchestrator runs at the app level; this is currently informational until per-warehouse scheduling is wired up." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={form.channelSyncIntervalMinutes ?? 15}
                  onChange={(e) => setForm({ ...form, channelSyncIntervalMinutes: parseInt(e.target.value) || 15 })}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  How often inventory levels are pushed. Currently informational; orchestrator interval is
                  managed at the app level.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================ VELOCITY ================ */}
        <TabsContent value="velocity">
          <Card>
            <CardHeader>
              <CardTitle>Velocity / Reorder Analysis</CardTitle>
              <CardDescription>Tuning for sales velocity calculation used by purchasing.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>
                  Velocity lookback window (days)
                  <HintIcon text="How many days of sales history are used to compute average daily usage. 7=reactive, 30=smooth, 14=balanced." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={form.velocityLookbackDays ?? 14}
                  onChange={(e) => setForm({ ...form, velocityLookbackDays: parseInt(e.target.value) || 14 })}
                  className="mt-1 max-w-xs"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Used by the reorder analysis & action queue to compute days-of-supply and reorder points.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================ WAVES (scaffold) ================ */}
        <TabsContent value="waves">
          <Card className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                Wave Planning
                <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400 ml-2">
                  Coming Soon
                </Badge>
              </CardTitle>
              <CardDescription>
                Pick wave configuration is scaffolded but not yet consumed by the picker service.
                Fields save to the DB so they're ready when wave management ships.
                See <code>docs/FUTURE_WORK.md</code> for the implementation plan.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-6">
              <div>
                <Label>
                  Max orders per wave
                  <HintIcon text="Upper bound on how many orders a single pick wave can contain. Larger waves = more parallelism for pickers but higher stakes if anything goes wrong." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={form.maxOrdersPerWave ?? 50}
                  onChange={(e) => setForm({ ...form, maxOrdersPerWave: parseInt(e.target.value) || 50 })}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>
                  Max items per wave
                  <HintIcon text="Upper bound on total line items across all orders in a single wave. Prevents one massive order from monopolizing a wave." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  value={form.maxItemsPerWave ?? 500}
                  onChange={(e) => setForm({ ...form, maxItemsPerWave: parseInt(e.target.value) || 500 })}
                  className="mt-1"
                />
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={form.waveAutoRelease === 1}
                  onCheckedChange={(checked) => setForm({ ...form, waveAutoRelease: checked ? 1 : 0 })}
                />
                <div>
                  <Label>
                    Wave auto-release
                    <HintIcon text="When a wave hits either capacity limit, automatically transition it to 'released' so pickers can start work immediately. Off means a human has to manually release each wave." />
                  </Label>
                  <p className="text-xs text-muted-foreground">When a wave hits capacity, auto-release to pickers.</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
