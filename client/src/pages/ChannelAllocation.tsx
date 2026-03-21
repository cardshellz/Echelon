import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import {
  Loader2,
  Search,
  Warehouse,
  Layers,
  Plus,
  Trash2,
  Pencil,
  X,
  Copy,
  Ban,
  CheckCircle2,
  HelpCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ============================================
// Types
// ============================================

interface Channel {
  id: number;
  name: string;
  provider: string;
  status: string;
}

interface WarehouseInfo {
  id: number;
  code: string;
  name: string;
  warehouseType: string;
  isActive: number;
}

interface WarehouseAssignment {
  id: number;
  channelId: number;
  warehouseId: number;
  priority: number;
  enabled: boolean;
  warehouseName: string | null;
  warehouseCode: string | null;
  warehouseType: string | null;
  channelName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AllocationRule {
  id: number;
  channelId: number | null;
  productId: number | null;
  productVariantId: number | null;
  mode: "mirror" | "share" | "fixed";
  sharePct: number | null;
  fixedQty: number | null;
  floorAtp: number;
  ceilingQty: number | null;
  eligible: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  channelName: string | null;
  productName: string | null;
  variantName: string | null;
  variantSku: string | null;
}

// ============================================
// API helpers
// ============================================

async function apiFetch(url: string, opts?: RequestInit) {
  const res = await fetch(url, { credentials: "include", ...opts });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json();
}

function apiPost(url: string, body: any) {
  return apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function apiPut(url: string, body: any) {
  return apiFetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function apiDelete(url: string) {
  return apiFetch(url, { method: "DELETE" });
}

// ============================================
// Info tip component
function InfoTip({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <HelpCircle className="inline h-3.5 w-3.5 ml-1 text-muted-foreground cursor-help" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-sm">
          <p>{text}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Mode display helpers
// ============================================

function modeIndicator(mode: string, eligible: boolean) {
  if (!eligible) return { icon: "🔴", label: "Blocked", color: "text-red-500" };
  switch (mode) {
    case "mirror": return { icon: "🟢", label: "Mirror", color: "text-green-600" };
    case "share": return { icon: "🔵", label: "Share %", color: "text-blue-600" };
    case "fixed": return { icon: "🟡", label: "Fixed", color: "text-amber-600" };
    default: return { icon: "⚪", label: mode, color: "text-muted-foreground" };
  }
}

function ruleDescription(rule: AllocationRule): string {
  if (!rule.eligible) return "Blocked — ineligible";
  switch (rule.mode) {
    case "mirror": return "Mirror (100%)";
    case "share": return `Share ${rule.sharePct ?? 0}%`;
    case "fixed": return `Fixed ${rule.fixedQty ?? 0} units`;
    default: return rule.mode;
  }
}

function ruleScope(rule: AllocationRule): string {
  if (rule.productVariantId) return "variant";
  if (rule.productId) return "product";
  return "channel default";
}

// ============================================
// Section A: Warehouse Assignments
// ============================================

function WarehouseAssignmentsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: allChannels = [] } = useQuery<Channel[]>({
    queryKey: ["/api/channels"],
    queryFn: () => apiFetch("/api/channels"),
  });

  const { data: allWarehouses = [] } = useQuery<WarehouseInfo[]>({
    queryKey: ["/api/warehouses"],
    queryFn: () => apiFetch("/api/warehouses"),
  });

  const { data: assignments = [], isLoading } = useQuery<WarehouseAssignment[]>({
    queryKey: ["/api/channel-warehouse-assignments"],
    queryFn: () => apiFetch("/api/channel-warehouse-assignments"),
  });

  const activeChannels = useMemo(() =>
    allChannels.filter((c) => c.status === "active"),
    [allChannels]
  );

  // Only show operations/3pl warehouses, not pure storage
  const fulfillmentWarehouses = useMemo(() =>
    allWarehouses.filter((w) => w.isActive && w.warehouseType !== "bulk_storage"),
    [allWarehouses]
  );

  const storageWarehouses = useMemo(() =>
    allWarehouses.filter((w) => w.isActive && w.warehouseType === "bulk_storage"),
    [allWarehouses]
  );

  // Build assignment lookup: "channelId:warehouseId" -> assignment
  const assignmentMap = useMemo(() => {
    const map = new Map<string, WarehouseAssignment>();
    for (const a of assignments) {
      map.set(`${a.channelId}:${a.warehouseId}`, a);
    }
    return map;
  }, [assignments]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/channel-warehouse-assignments"] });

  const createMutation = useMutation({
    mutationFn: (data: { channelId: number; warehouseId: number }) =>
      apiPost("/api/channel-warehouse-assignments", { ...data, priority: 0, enabled: true }),
    onSuccess: () => { invalidate(); toast({ title: "Assignment created" }); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/channel-warehouse-assignments/${id}`),
    onSuccess: () => { invalidate(); toast({ title: "Assignment removed" }); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number; priority?: number; enabled?: boolean }) =>
      apiPut(`/api/channel-warehouse-assignments/${id}`, data),
    onSuccess: () => { invalidate(); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const handleToggle = (channelId: number, warehouseId: number) => {
    const key = `${channelId}:${warehouseId}`;
    const existing = assignmentMap.get(key);
    if (existing) {
      deleteMutation.mutate(existing.id);
    } else {
      createMutation.mutate({ channelId, warehouseId });
    }
  };

  const handlePriorityChange = (assignmentId: number, priority: number) => {
    updateMutation.mutate({ id: assignmentId, priority });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (activeChannels.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Warehouse className="h-10 w-10 mx-auto mb-3 opacity-30" />
        <p>No active channels. Set up channels first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[200px]">Warehouse</TableHead>
              <TableHead className="min-w-[100px]">Type</TableHead>
              {activeChannels.map((ch) => (
                <TableHead key={ch.id} className="text-center min-w-[140px]">{ch.name}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {fulfillmentWarehouses.map((wh) => (
              <TableRow key={wh.id}>
                <TableCell className="font-medium">
                  <div>
                    <span className="font-mono text-xs text-muted-foreground mr-2">{wh.code}</span>
                    {wh.name}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs capitalize">{wh.warehouseType.replace(/_/g, " ")}</Badge>
                </TableCell>
                {activeChannels.map((ch) => {
                  const key = `${ch.id}:${wh.id}`;
                  const assignment = assignmentMap.get(key);
                  return (
                    <TableCell key={ch.id} className="text-center">
                      <div className="flex flex-col items-center gap-1.5">
                        <Checkbox
                          checked={!!assignment}
                          onCheckedChange={() => handleToggle(ch.id, wh.id)}
                        />
                        {assignment && (
                          <Input
                            type="number"
                            min={0}
                            className="h-7 w-16 text-xs text-center"
                            value={assignment.priority}
                            onChange={(e) => handlePriorityChange(assignment.id, parseInt(e.target.value) || 0)}
                            title="Priority (higher = preferred)"
                          />
                        )}
                      </div>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
            {storageWarehouses.length > 0 && (
              <>
                <TableRow>
                  <TableCell colSpan={2 + activeChannels.length} className="bg-muted/30 text-xs text-muted-foreground font-medium py-2">
                    Storage Warehouses (not assignable for fulfillment)
                  </TableCell>
                </TableRow>
                {storageWarehouses.map((wh) => (
                  <TableRow key={wh.id} className="opacity-50">
                    <TableCell>
                      <span className="font-mono text-xs text-muted-foreground mr-2">{wh.code}</span>
                      {wh.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">Storage</Badge>
                    </TableCell>
                    {activeChannels.map((ch) => (
                      <TableCell key={ch.id} className="text-center text-muted-foreground text-xs">—</TableCell>
                    ))}
                  </TableRow>
                ))}
              </>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        Priority: higher number = preferred fulfillment source. If no warehouses are assigned to a channel, all fulfillment warehouses are used.
      </p>
    </div>
  );
}

// ============================================
// Section B: Allocation Rules
// ============================================

// Rule edit/create dialog
function RuleDialog({
  rule,
  channels,
  onClose,
}: {
  rule?: AllocationRule;
  channels: Channel[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEdit = !!rule;

  const [channelId, setChannelId] = useState<number | null>(rule?.channelId !== undefined ? rule.channelId : (channels[0]?.id ?? 0));
  const [mode, setMode] = useState<"mirror" | "share" | "fixed">(rule?.mode ?? "mirror");
  const [sharePct, setSharePct] = useState(String(rule?.sharePct ?? 100));
  const [fixedQty, setFixedQty] = useState(String(rule?.fixedQty ?? 0));
  const [floorAtp, setFloorAtp] = useState(String(rule?.floorAtp ?? 0));
  const [ceilingQty, setCeilingQty] = useState(rule?.ceilingQty != null ? String(rule.ceilingQty) : "");
  const [eligible, setEligible] = useState(rule?.eligible ?? true);
  const [notes, setNotes] = useState(rule?.notes ?? "");

  // SKU typeahead state
  const [skuSearch, setSkuSearch] = useState(rule?.variantSku ?? rule?.productName ?? "");
  const [selectedProductId, setSelectedProductId] = useState<number | null>(rule?.productId ?? null);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(rule?.productVariantId ?? null);
  const [selectedLabel, setSelectedLabel] = useState(
    rule?.variantSku ? `${rule.variantSku} — ${rule.productName ?? ""}${rule.variantName ? ` (${rule.variantName})` : ""}` : ""
  );
  const [showSkuResults, setShowSkuResults] = useState(false);
  const debouncedSkuSearch = useDebounce(skuSearch, 300);

  const { data: skuResults = [] } = useQuery<{ variantId: number; productId: number; sku: string; variantName: string; productName: string }[]>({
    queryKey: ["/api/channel-allocation/search", debouncedSkuSearch],
    queryFn: () => fetch(`/api/channel-allocation/search?q=${encodeURIComponent(debouncedSkuSearch)}`).then(r => r.json()),
    enabled: debouncedSkuSearch.length >= 2 && showSkuResults,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation-rules"] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        channelId,
        productId: selectedProductId,
        productVariantId: selectedVariantId,
        mode,
        sharePct: mode === "share" ? parseInt(sharePct) : null,
        fixedQty: mode === "fixed" ? parseInt(fixedQty) : null,
        floorAtp: parseInt(floorAtp) || 0,
        ceilingQty: ceilingQty ? parseInt(ceilingQty) : null,
        eligible,
        notes: notes || null,
      };

      if (isEdit) {
        return apiPut(`/api/channel-allocation-rules/${rule!.id}`, body);
      } else {
        return apiPost("/api/channel-allocation-rules", body);
      }
    },
    onSuccess: () => {
      invalidate();
      toast({ title: isEdit ? "Rule updated" : "Rule created" });
      onClose();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <DialogContent className="sm:max-w-[540px] overflow-y-auto max-h-[90vh]">
      <DialogHeader>
        <DialogTitle>{isEdit ? "Edit" : "Create"} Allocation Rule</DialogTitle>
        <p className="text-sm text-muted-foreground">
          {isEdit ? "Modify how inventory is allocated." : "Set how much inventory a channel can see for a product or variant."}
        </p>
      </DialogHeader>

      <div className="space-y-5 py-1">
        {/* ── Target: Channel + SKU ── */}
        <Card className="border-dashed">
          <CardContent className="pt-4 pb-3 space-y-3">
            {!isEdit && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Channel</Label>
                <Select value={channelId === null ? "all" : String(channelId)} onValueChange={(v) => setChannelId(v === "all" ? null : parseInt(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">🌐 All Channels</SelectItem>
                    {channels.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5 relative">
              <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Product / Variant
                <InfoTip text="Leave blank for a channel-wide default. Type a SKU to target a specific variant. Most specific rule wins." />
              </Label>
              {selectedLabel && !isEdit ? (
                <div className="flex items-start gap-2 border rounded-lg px-3 py-2.5 bg-muted/40">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono font-medium">{selectedLabel.split(" — ")[0]}</p>
                    <p className="text-xs text-muted-foreground truncate">{selectedLabel.split(" — ").slice(1).join(" — ")}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 shrink-0 mt-0.5"
                    onClick={() => {
                      setSelectedProductId(null);
                      setSelectedVariantId(null);
                      setSelectedLabel("");
                      setSkuSearch("");
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : isEdit ? (
                <div className="border rounded-lg px-3 py-2.5 bg-muted/30">
                  {selectedLabel ? (
                    <>
                      <p className="text-sm font-mono font-medium">{selectedLabel.split(" — ")[0]}</p>
                      <p className="text-xs text-muted-foreground">{selectedLabel.split(" — ").slice(1).join(" — ")}</p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Channel default (all products)</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by SKU or product name..."
                      value={skuSearch}
                      onChange={(e) => {
                        setSkuSearch(e.target.value);
                        setShowSkuResults(true);
                      }}
                      onFocus={() => setShowSkuResults(true)}
                      onBlur={() => setTimeout(() => setShowSkuResults(false), 200)}
                      className="pl-9"
                      autoComplete="off"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">Leave blank to set a channel-wide default rule.</p>
                  {showSkuResults && skuResults.length > 0 && (
                    <div className="absolute z-50 left-4 right-4 mt-1 bg-popover border rounded-lg shadow-lg max-h-52 overflow-y-auto">
                      {skuResults.map((r) => (
                        <button
                          key={r.variantId}
                          className="w-full text-left px-3 py-2.5 hover:bg-accent border-b last:border-0 transition-colors"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setSelectedProductId(r.productId);
                            setSelectedVariantId(r.variantId);
                            setSelectedLabel(`${r.sku} — ${r.productName}${r.variantName ? ` (${r.variantName})` : ""}`);
                            setSkuSearch("");
                            setShowSkuResults(false);
                          }}
                        >
                          <span className="font-mono text-sm font-medium block">{r.sku}</span>
                          <span className="text-xs text-muted-foreground">{r.productName}{r.variantName ? ` · ${r.variantName}` : ""}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Eligibility ── */}
        <div className="flex items-center justify-between rounded-lg border px-4 py-3">
          <div>
            <Label className="text-sm font-medium">Eligible for this channel</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              {eligible ? "Product can be sold on this channel" : "Blocked — inventory will show as 0"}
            </p>
          </div>
          <Switch checked={eligible} onCheckedChange={setEligible} />
        </div>

        {eligible && (
          <>
            {/* ── Allocation Mode ── */}
            <div className="space-y-2.5">
              <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Allocation Mode
                <InfoTip text="How much inventory this channel can see. Each channel gets an independent view." />
              </Label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { key: "mirror" as const, emoji: "🟢", label: "Mirror", desc: "100% of stock" },
                  { key: "share" as const, emoji: "🔵", label: "Share %", desc: "X% of stock" },
                  { key: "fixed" as const, emoji: "🟡", label: "Fixed", desc: "Set quantity" },
                ] as const).map((m) => (
                  <button
                    key={m.key}
                    onClick={() => setMode(m.key)}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-lg border-2 p-3 transition-all text-center",
                      mode === m.key
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-muted hover:border-muted-foreground/30 hover:bg-muted/50"
                    )}
                  >
                    <span className="text-lg">{m.emoji}</span>
                    <span className="text-sm font-medium">{m.label}</span>
                    <span className="text-[10px] text-muted-foreground leading-tight">{m.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* ── Mode-specific input ── */}
            {mode === "share" && (
              <div className="space-y-1.5">
                <Label className="text-sm">
                  Share Percentage
                  <InfoTip text="What % of available stock this channel sees. 100% = same as Mirror. 50% = half your stock." />
                </Label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={sharePct}
                    onChange={(e) => setSharePct(e.target.value)}
                    className="w-24"
                    autoComplete="off"
                  />
                  <span className="text-sm text-muted-foreground">% of available inventory</span>
                </div>
              </div>
            )}

            {mode === "fixed" && (
              <div className="space-y-1.5">
                <Label className="text-sm">
                  Fixed Quantity
                  <InfoTip text="Exact base units to show. If actual stock is lower, the lower number is used." />
                </Label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min={0}
                    value={fixedQty}
                    onChange={(e) => setFixedQty(e.target.value)}
                    className="w-24"
                    autoComplete="off"
                  />
                  <span className="text-sm text-muted-foreground">base units</span>
                </div>
              </div>
            )}

            {/* ── Guardrails ── */}
            <div className="space-y-2">
              <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Guardrails</Label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-sm">
                    Floor ATP
                    <InfoTip text="If stock drops below this, push 0. Prevents selling the last few units." />
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    value={floorAtp}
                    onChange={(e) => setFloorAtp(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">
                    Ceiling
                    <InfoTip text="Never show more than this, even if stock is higher." />
                  </Label>
                  <Input
                    type="number"
                    min={0}
                    placeholder="No limit"
                    value={ceilingQty}
                    onChange={(e) => setCeilingQty(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── Notes ── */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</Label>
          <Textarea
            placeholder="Why this rule exists..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="h-16 resize-none"
          />
        </div>
      </div>

      <DialogFooter className="gap-2 sm:gap-0">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          {isEdit ? "Save Changes" : "Create Rule"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function AllocationRulesSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterChannelId, setFilterChannelId] = useState<number | null>(null);
  const [editingRule, setEditingRule] = useState<AllocationRule | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const debouncedSearch = useDebounce(search, 250);

  const { data: allChannels = [] } = useQuery<Channel[]>({
    queryKey: ["/api/channels"],
    queryFn: () => apiFetch("/api/channels"),
  });

  const activeChannels = useMemo(() =>
    allChannels.filter((c) => c.status === "active"),
    [allChannels]
  );

  const queryUrl = filterChannelId
    ? `/api/channel-allocation-rules?channelId=${filterChannelId}`
    : "/api/channel-allocation-rules";

  const { data: rules = [], isLoading } = useQuery<AllocationRule[]>({
    queryKey: ["/api/channel-allocation-rules", filterChannelId],
    queryFn: () => apiFetch(queryUrl),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/channel-allocation-rules/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation-rules"] });
      toast({ title: "Rule deleted" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  // Separate channel defaults from overrides
  const channelDefaults = useMemo(() =>
    rules.filter((r) => r.productId === null && r.productVariantId === null),
    [rules]
  );

  const overrides = useMemo(() => {
    let items = rules.filter((r) => r.productId !== null || r.productVariantId !== null);
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      items = items.filter((r) =>
        (r.productName || "").toLowerCase().includes(q) ||
        (r.variantName || "").toLowerCase().includes(q) ||
        (r.variantSku || "").toLowerCase().includes(q)
      );
    }
    return items;
  }, [rules, debouncedSearch]);

  // Build a set of channelIds that have defaults
  const channelsWithDefaults = useMemo(() =>
    new Set(channelDefaults.map((r) => r.channelId)),
    [channelDefaults]
  );

  return (
    <div className="space-y-6">
      {/* Channel Default Cards */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">
            Channel Defaults
            <InfoTip text="The base rule for each channel. Applies to all products unless overridden at the product or variant level below. Most setups only need this — set Mirror for full visibility, or Share % to hold back stock." />
          </h3>
          <p className="text-xs text-muted-foreground">
            Base allocation rule per channel. Product and variant overrides below take precedence.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Global "All Channels" default card */}
          {(() => {
            const globalDefault = channelDefaults.find((r) => r.channelId === null);
            const m = globalDefault
              ? modeIndicator(globalDefault.mode, globalDefault.eligible)
              : modeIndicator("mirror", true);

            return (
              <Card className={cn(
                "border-2 border-dashed border-blue-200 dark:border-blue-800 transition-colors",
                globalDefault && !globalDefault.eligible && "border-red-300 dark:border-red-800"
              )}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="font-medium">🌐 All Channels</p>
                      <p className="text-xs text-muted-foreground">Global default</p>
                    </div>
                    <span className="text-2xl">{m.icon}</span>
                  </div>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Mode</span>
                      <span className={cn("font-medium", m.color)}>
                        {globalDefault ? ruleDescription(globalDefault) : "Mirror (100%) — implicit"}
                      </span>
                    </div>
                    {globalDefault && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Floor</span>
                          <span>{globalDefault.floorAtp || "None"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Ceiling</span>
                          <span>{globalDefault.ceilingQty ?? "None"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Eligible</span>
                          <span>{globalDefault.eligible ? "✅ Yes" : "❌ No"}</span>
                        </div>
                        {globalDefault.notes && (
                          <p className="text-xs text-muted-foreground mt-1 italic">{globalDefault.notes}</p>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex gap-2 mt-3">
                    {globalDefault ? (
                      <>
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button variant="outline" size="sm" className="flex-1" onClick={() => setEditingRule(globalDefault)}>
                              <Pencil className="h-3 w-3 mr-1" /> Edit
                            </Button>
                          </DialogTrigger>
                          {editingRule?.id === globalDefault.id && (
                            <RuleDialog
                              rule={editingRule}
                              channels={activeChannels}
                              onClose={() => setEditingRule(null)}
                            />
                          )}
                        </Dialog>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-500 hover:text-red-600"
                          onClick={() => deleteMutation.mutate(globalDefault.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </>
                    ) : (
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="outline" size="sm" className="w-full" onClick={() => {
                            setShowCreate(true);
                            setEditingRule({ channelId: null, mode: "mirror", eligible: true } as any);
                          }}>
                            <Plus className="h-3 w-3 mr-1" /> Set Global Default
                          </Button>
                        </DialogTrigger>
                        {showCreate && editingRule?.channelId === null && !editingRule?.id && (
                          <RuleDialog
                            channels={activeChannels}
                            onClose={() => { setShowCreate(false); setEditingRule(null); }}
                          />
                        )}
                      </Dialog>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })()}
          {activeChannels.map((ch) => {
            const defaultRule = channelDefaults.find((r) => r.channelId === ch.id);
            const m = defaultRule
              ? modeIndicator(defaultRule.mode, defaultRule.eligible)
              : modeIndicator("mirror", true);

            return (
              <Card key={ch.id} className={cn(
                "transition-colors",
                defaultRule && !defaultRule.eligible && "border-red-300 dark:border-red-800"
              )}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="font-medium">{ch.name}</p>
                      <p className="text-xs text-muted-foreground">{ch.provider}</p>
                    </div>
                    <span className="text-2xl">{m.icon}</span>
                  </div>
                  <div className="space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Mode</span>
                      <span className={cn("font-medium", m.color)}>
                        {defaultRule ? ruleDescription(defaultRule) : "Mirror (100%) — implicit"}
                      </span>
                    </div>
                    {defaultRule && (
                      <>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Floor</span>
                          <span>{defaultRule.floorAtp || "None"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Ceiling</span>
                          <span>{defaultRule.ceilingQty ?? "None"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Eligible</span>
                          <span>{defaultRule.eligible ? "✅ Yes" : "❌ No"}</span>
                        </div>
                        {defaultRule.notes && (
                          <p className="text-xs text-muted-foreground mt-1 italic">{defaultRule.notes}</p>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex gap-2 mt-3">
                    {defaultRule ? (
                      <>
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button variant="outline" size="sm" className="flex-1" onClick={() => setEditingRule(defaultRule)}>
                              <Pencil className="h-3 w-3 mr-1" /> Edit
                            </Button>
                          </DialogTrigger>
                          {editingRule?.id === defaultRule.id && (
                            <RuleDialog
                              rule={editingRule}
                              channels={activeChannels}
                              onClose={() => setEditingRule(null)}
                            />
                          )}
                        </Dialog>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-500 hover:text-red-600"
                          onClick={() => deleteMutation.mutate(defaultRule.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </>
                    ) : (
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="outline" size="sm" className="w-full" onClick={() => {
                            setShowCreate(true);
                            setEditingRule({ channelId: ch.id, mode: "mirror", eligible: true } as any);
                          }}>
                            <Plus className="h-3 w-3 mr-1" /> Set Default
                          </Button>
                        </DialogTrigger>
                        {showCreate && editingRule?.channelId === ch.id && !editingRule?.id && (
                          <RuleDialog
                            channels={activeChannels}
                            onClose={() => { setShowCreate(false); setEditingRule(null); }}
                          />
                        )}
                      </Dialog>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <Separator />

      {/* Product/Variant Overrides */}
      <div>
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
          <div>
            <h3 className="text-lg font-semibold">
              Product & Variant Overrides
              <InfoTip text="Override the channel default for specific products or variants. Example: block cases from Shopify CA, or cap a hot item to 10 units on eBay. The most specific rule wins — a variant rule beats a product rule, which beats the channel default." />
            </h3>
            <p className="text-xs text-muted-foreground">
              Most specific wins: variant override &gt; product override &gt; channel default.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 md:w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search product, variant, SKU..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
                autoComplete="off"
              />
              {search && (
                <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <Select
              value={filterChannelId ? String(filterChannelId) : "all"}
              onValueChange={(v) => setFilterChannelId(v === "all" ? null : parseInt(v))}
            >
              <SelectTrigger className="w-[180px] h-9">
                <SelectValue placeholder="All Channels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Channels</SelectItem>
                {activeChannels.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Dialog open={showCreate && !editingRule?.id && !editingRule?.channelId} onOpenChange={(o) => { if (!o) { setShowCreate(false); setEditingRule(null); } }}>
              <DialogTrigger asChild>
                <Button size="sm" onClick={() => { setShowCreate(true); setEditingRule(null); }}>
                  <Plus className="h-4 w-4 mr-1" /> Add Override
                </Button>
              </DialogTrigger>
              {showCreate && !editingRule?.id && !editingRule?.channelId && (
                <RuleDialog
                  channels={activeChannels}
                  onClose={() => { setShowCreate(false); setEditingRule(null); }}
                />
              )}
            </Dialog>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : overrides.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Layers className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p>{debouncedSearch ? "No overrides match your search." : "No product or variant overrides yet."}</p>
            <p className="text-xs mt-1">All products use channel defaults above.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[120px]">Channel</TableHead>
                  <TableHead className="min-w-[80px]">Scope</TableHead>
                  <TableHead className="min-w-[180px]">Product / Variant</TableHead>
                  <TableHead className="min-w-[100px]">Mode</TableHead>
                  <TableHead className="text-right min-w-[80px]">Value</TableHead>
                  <TableHead className="text-right min-w-[60px]">Floor</TableHead>
                  <TableHead className="text-right min-w-[60px]">Ceiling</TableHead>
                  <TableHead className="min-w-[70px]">Eligible</TableHead>
                  <TableHead className="min-w-[150px]">Notes</TableHead>
                  <TableHead className="w-[80px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overrides.map((rule) => {
                  const m = modeIndicator(rule.mode, rule.eligible);
                  const scope = ruleScope(rule);
                  return (
                    <TableRow key={rule.id} className={cn(!rule.eligible && "bg-red-50/50 dark:bg-red-950/10")}>
                      <TableCell className="font-medium text-sm">
                        {rule.channelId === null ? (
                          <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300">
                            🌐 All Channels
                          </Badge>
                        ) : rule.channelName}
                      </TableCell>
                      <TableCell>
                        <Badge variant={scope === "variant" ? "default" : "secondary"} className="text-xs">
                          {scope}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-0.5">
                          {rule.productName && (
                            <p className="text-sm truncate max-w-[200px]">{rule.productName}</p>
                          )}
                          {rule.variantSku && (
                            <p className="text-xs text-muted-foreground font-mono">{rule.variantSku}</p>
                          )}
                          {rule.variantName && (
                            <p className="text-xs text-muted-foreground">{rule.variantName}</p>
                          )}
                          {!rule.productName && !rule.variantName && (
                            <span className="text-xs text-muted-foreground">
                              {rule.productId ? `Product #${rule.productId}` : ""}{" "}
                              {rule.productVariantId ? `Variant #${rule.productVariantId}` : ""}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className={cn("text-sm font-medium", m.color)}>
                          {m.icon} {m.label}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">
                        {rule.mode === "share" && rule.sharePct != null && `${rule.sharePct}%`}
                        {rule.mode === "fixed" && rule.fixedQty != null && rule.fixedQty.toLocaleString()}
                        {rule.mode === "mirror" && "100%"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{rule.floorAtp || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{rule.ceilingQty ?? "—"}</TableCell>
                      <TableCell>
                        {rule.eligible ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <Ban className="h-4 w-4 text-red-500" />
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground truncate max-w-[150px]">
                        {rule.notes || "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setEditingRule(rule)}>
                                <Pencil className="h-3 w-3" />
                              </Button>
                            </DialogTrigger>
                            {editingRule?.id === rule.id && (
                              <RuleDialog
                                rule={editingRule}
                                channels={activeChannels}
                                onClose={() => setEditingRule(null)}
                              />
                            )}
                          </Dialog>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                            onClick={() => deleteMutation.mutate(rule.id)}
                            disabled={deleteMutation.isPending}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Main Component
// ============================================

export default function ChannelAllocation() {
  return (
    <div className="space-y-4 p-2 md:p-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Channel Allocation</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure warehouse assignments and allocation rules for the parallel inventory model.
        </p>
      </div>

      <Tabs defaultValue="warehouses" className="w-full">
        <TabsList>
          <TabsTrigger value="warehouses" className="gap-2">
            <Warehouse className="h-4 w-4" />
            Warehouse Assignments
          </TabsTrigger>
          <TabsTrigger value="rules" className="gap-2">
            <Layers className="h-4 w-4" />
            Allocation Rules
          </TabsTrigger>
        </TabsList>

        <TabsContent value="warehouses" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Warehouse → Channel Assignments</CardTitle>
              <CardDescription>
                Controls which warehouses feed inventory to each sales channel. A channel only sees stock from its assigned warehouses. If no warehouses are assigned, all fulfillment warehouses are used as a fallback.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <WarehouseAssignmentsSection />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="mt-4">
          <AllocationRulesSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
