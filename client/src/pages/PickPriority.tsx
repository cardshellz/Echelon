// PickPriority.tsx \u2014 admin page that consolidates pick-queue priority inputs.
//
// Three editable sections:
//   1. Shipping Service Level base scores (standard / expedited / overnight)
//   2. Plan Priority Modifiers (one row per membership.plans row)
//   3. SLA default fallback days
//
// A live preview at the top shows the resulting composite sort_rank string
// for a sample order, computed client-side using the same H-B-PPPP-SSSSSS-AAAAAAAAAA
// format as server/modules/orders/sort-rank.ts. Useful for reasoning about
// how changes to each input move an order up or down the queue.
//
// Save All issues a single PATCH containing only the dirty fields.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpDown, Save, RotateCcw, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types (mirror server payload)
// ---------------------------------------------------------------------------

type ShippingLevel = "standard" | "expedited" | "overnight";

interface PlanRow {
  id: string;
  name: string;
  tierLevel: number | null;
  priorityModifier: number;
  primaryColor: string | null;
  isActive: boolean;
}

interface PickPriorityPayload {
  shippingBase: Record<ShippingLevel, number>;
  slaDefaultDays: number;
  plans: PlanRow[];
}

interface PatchBody {
  shippingBase?: Partial<Record<ShippingLevel, number>>;
  slaDefaultDays?: number;
  planModifiers?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Client-side sort_rank preview (must match server/modules/orders/sort-rank.ts)
// ---------------------------------------------------------------------------

const BUMP_THRESHOLD = 9999;
const SLA_WIDTH = 6;
const SLA_MAX = 999999;
const AGE_WIDTH = 10;
const AGE_MAX = 9999999999;

function pad(value: number, width: number): string {
  const s = String(Math.max(0, Math.floor(value)));
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

function computeSortRankPreview(params: {
  priority: number;
  onHold: boolean;
  slaDueAt: Date | null;
  orderPlacedAt: Date;
}): string {
  const now = new Date();
  const priority = Math.max(0, Math.min(BUMP_THRESHOLD, Math.floor(params.priority)));
  const isHeld = params.onHold;
  const isBumped = priority >= BUMP_THRESHOLD;

  const H = isHeld ? "0" : "1";
  const B = isBumped ? "1" : "0";
  const P = pad(priority, 4);

  let slaComponent = 0;
  if (params.slaDueAt) {
    const minutesUntilSla = Math.round((params.slaDueAt.getTime() - now.getTime()) / 60000);
    slaComponent = Math.max(0, SLA_MAX - Math.max(0, minutesUntilSla));
  }
  const S = pad(Math.min(SLA_MAX, slaComponent), SLA_WIDTH);

  const unixSeconds = Math.floor(params.orderPlacedAt.getTime() / 1000);
  const ageComponent = Math.max(0, AGE_MAX - unixSeconds);
  const A = pad(Math.min(AGE_MAX, ageComponent), AGE_WIDTH);

  return `${H}-${B}-${P}-${S}-${A}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PickPriority() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isError, error } = useQuery<PickPriorityPayload>({
    queryKey: ["/api/admin/pick-priority"],
  });

  // Local draft state \u2014 initialized from server payload on load, then diffed
  // at save time to build a minimal PATCH body.
  const [draft, setDraft] = useState<PickPriorityPayload | null>(null);

  // Sync server -> draft on first load / after save
  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  const mutate = useMutation({
    mutationFn: async (body: PatchBody) => {
      const res = await apiRequest("PATCH", "/api/admin/pick-priority", body);
      return (await res.json()) as PickPriorityPayload;
    },
    onSuccess: (fresh) => {
      qc.setQueryData(["/api/admin/pick-priority"], fresh);
      setDraft(fresh);
      toast({ title: "Saved", description: "Pick priority settings updated." });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading pick priority settings\u2026</div>;
  }
  if (isError || !data) {
    return (
      <div className="p-6">
        <div className="text-red-600">Failed to load settings: {(error as Error)?.message ?? "unknown error"}</div>
      </div>
    );
  }
  if (!draft) {
    return <div className="p-6 text-muted-foreground">Initializing\u2026</div>;
  }

  // Dirty-detection helpers
  const dirtyShipping = (Object.keys(draft.shippingBase) as ShippingLevel[])
    .filter((k) => draft.shippingBase[k] !== data.shippingBase[k]);
  const dirtySla = draft.slaDefaultDays !== data.slaDefaultDays;
  const dirtyPlans = draft.plans.filter((p) => {
    const orig = data.plans.find((d) => d.id === p.id);
    return orig && orig.priorityModifier !== p.priorityModifier;
  });
  const hasChanges = dirtyShipping.length > 0 || dirtySla || dirtyPlans.length > 0;

  const handleSaveAll = () => {
    const body: PatchBody = {};
    if (dirtyShipping.length > 0) {
      body.shippingBase = {};
      for (const k of dirtyShipping) body.shippingBase[k] = draft.shippingBase[k];
    }
    if (dirtySla) body.slaDefaultDays = draft.slaDefaultDays;
    if (dirtyPlans.length > 0) {
      body.planModifiers = {};
      for (const p of dirtyPlans) body.planModifiers[p.id] = p.priorityModifier;
    }
    mutate.mutate(body);
  };

  const handleReset = () => setDraft(data);

  // ---- Live preview ----------------------------------------------------
  // Sample: a "standard" order from the top-tier plan placed 2 hours ago
  // with SLA due in 24h, not on hold, not bumped.
  const topPlan = [...draft.plans]
    .filter((p) => p.isActive)
    .sort((a, b) => (a.tierLevel ?? 9999) - (b.tierLevel ?? 9999))[0]
    ?? draft.plans[0];
  const previewModifier = topPlan?.priorityModifier ?? 0;
  const previewPriority = draft.shippingBase.standard + previewModifier;
  const previewSlaDue = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const previewPlacedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const previewRank = computeSortRankPreview({
    priority: previewPriority,
    onHold: false,
    slaDueAt: previewSlaDue,
    orderPlacedAt: previewPlacedAt,
  });

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ArrowUpDown className="h-6 w-6" />
            Pick Priority
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Controls how orders are ranked in the pick queue. Changes apply to new orders as they sync to WMS.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset} disabled={!hasChanges || mutate.isPending}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
          <Button onClick={handleSaveAll} disabled={!hasChanges || mutate.isPending}>
            <Save className="h-4 w-4 mr-2" />
            {mutate.isPending ? "Saving\u2026" : "Save All"}
          </Button>
        </div>
      </div>

      {/* Live preview */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Info className="h-4 w-4" />
            Live preview
          </CardTitle>
          <CardDescription>
            Sample order: standard shipping, {topPlan?.name ?? "no plan"} member, placed 2h ago, SLA due in 24h.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="font-mono text-sm break-all bg-muted/50 px-3 py-2 rounded-md">
            {previewRank}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-muted-foreground">
            <div>Priority: <span className="font-mono text-foreground">{previewPriority}</span></div>
            <div>Base: <span className="font-mono text-foreground">{draft.shippingBase.standard}</span></div>
            <div>Modifier: <span className="font-mono text-foreground">{previewModifier}</span></div>
            <div>SLA: <span className="font-mono text-foreground">{draft.slaDefaultDays}d fallback</span></div>
          </div>
        </CardContent>
      </Card>

      {/* Shipping Service Levels */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Shipping service levels</CardTitle>
          <CardDescription>
            Base score added to every order's priority, keyed by normalized service level.
            Higher = picked sooner. Range 0\u20139999.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {(["standard", "expedited", "overnight"] as const).map((level) => (
            <div key={level} className="space-y-1.5">
              <Label htmlFor={`ship-${level}`} className="capitalize">{level}</Label>
              <Input
                id={`ship-${level}`}
                type="number"
                min={0}
                max={9999}
                step={10}
                value={draft.shippingBase[level]}
                onChange={(e) => setDraft({
                  ...draft,
                  shippingBase: {
                    ...draft.shippingBase,
                    [level]: clampInt(e.target.value, 0, 9999, draft.shippingBase[level]),
                  },
                })}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Plan Priority Modifiers */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Plan priority modifiers</CardTitle>
          <CardDescription>
            Added to the shipping base when the order's customer is on the matching membership plan. Range 0\u2013500.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead className="w-24">Tier</TableHead>
                  <TableHead className="w-32">Status</TableHead>
                  <TableHead className="w-40">Modifier</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {draft.plans.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-6">
                      No membership plans found.
                    </TableCell>
                  </TableRow>
                ) : draft.plans.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell className="font-medium text-sm">
                      <span
                        className="inline-flex items-center gap-2"
                        style={plan.primaryColor ? { color: plan.primaryColor } : undefined}
                      >
                        {plan.primaryColor && (
                          <span
                            className="inline-block w-2.5 h-2.5 rounded-full border border-black/10"
                            style={{ backgroundColor: plan.primaryColor }}
                          />
                        )}
                        {plan.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {plan.tierLevel != null ? <Badge variant="outline">{plan.tierLevel}</Badge> : "\u2014"}
                    </TableCell>
                    <TableCell>
                      {plan.isActive ? (
                        <Badge className="bg-green-100 text-green-800">Active</Badge>
                      ) : (
                        <Badge className="bg-gray-100 text-gray-800">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        max={500}
                        step={1}
                        value={plan.priorityModifier}
                        onChange={(e) => {
                          const v = clampInt(e.target.value, 0, 500, plan.priorityModifier);
                          setDraft({
                            ...draft,
                            plans: draft.plans.map((p) => p.id === plan.id ? { ...p, priorityModifier: v } : p),
                          });
                        }}
                        className="w-28"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* SLA Defaults */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">SLA defaults</CardTitle>
          <CardDescription>
            Fallback SLA (business days) used when a channel has no partner profile and the order has no platform ship-by date.
            Range 0\u201330 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 max-w-xs">
            <Label htmlFor="sla-default">Default SLA days</Label>
            <Input
              id="sla-default"
              type="number"
              min={0}
              max={30}
              step={1}
              value={draft.slaDefaultDays}
              onChange={(e) => setDraft({
                ...draft,
                slaDefaultDays: clampInt(e.target.value, 0, 30, draft.slaDefaultDays),
              })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Reference */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">sort_rank reference</CardTitle>
          <CardDescription>How the composite string is assembled. Sort DESC = pick queue order.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="text-xs font-mono bg-muted/50 p-3 rounded-md overflow-x-auto whitespace-pre">
{`H           1 = not held, 0 = held (bottom)
B           1 = bumped (priority \u2265 9999), 0 = normal
PPPP        shipping_base + plan_modifier (0\u20139999)
SSSSSS      SLA urgency (higher = more urgent)
AAAAAAAAAA  inverse unix seconds of order_placed_at (older = higher)

Format: H-B-PPPP-SSSSSS-AAAAAAAAAA
Sort DESC on this string = pick queue order.`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
