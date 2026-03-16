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
  channelId: number;
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

  const [channelId, setChannelId] = useState(rule?.channelId ?? (channels[0]?.id ?? 0));
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
    <DialogContent className="max-w-xl w-[95vw] overflow-y-auto max-h-[85vh]">
      <DialogHeader>
        <DialogTitle>{isEdit ? "Edit" : "Create"} Allocation Rule</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        {!isEdit && (
          <div className="space-y-2">
            <Label>Channel</Label>
            <Select value={String(channelId)} onValueChange={(v) => setChannelId(parseInt(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {channels.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1 relative">
          <Label className="text-xs">
            Product / Variant
            <InfoTip text="Leave blank to create a channel-wide default rule. Type a SKU to target a specific variant. The most specific rule wins." />
          </Label>
          {selectedLabel && !isEdit ? (
            <div className="flex items-center gap-2 border rounded-md px-3 py-2 bg-muted/50">
              <span className="text-sm flex-1 truncate">{selectedLabel}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                onClick={() => {
                  setSelectedProductId(null);
                  setSelectedVariantId(null);
                  setSelectedLabel("");
                  setSkuSearch("");
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : isEdit ? (
            <div className="text-sm text-muted-foreground border rounded-md px-3 py-2 bg-muted/30">
              {selectedLabel || "Channel default (all products)"}
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search SKU or product name... (blank = channel default)"
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
              {showSkuResults && skuResults.length > 0 && (
                <div className="absolute z-50 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
                  {skuResults.map((r) => (
                    <button
                      key={r.variantId}
                      className="w-full text-left px-3 py-2 hover:bg-accent text-sm flex justify-between items-center"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setSelectedProductId(r.productId);
                        setSelectedVariantId(r.variantId);
                        setSelectedLabel(`${r.sku} — ${r.productName}${r.variantName ? ` (${r.variantName})` : ""}`);
                        setSkuSearch("");
                        setShowSkuResults(false);
                      }}
                    >
                      <span className="font-mono text-xs">{r.sku}</span>
                      <span className="text-muted-foreground text-xs truncate ml-2">{r.productName}{r.variantName ? ` · ${r.variantName}` : ""}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between">
          <Label>
            Eligible for this channel
            <InfoTip text="When off, this product/variant is completely blocked from selling on this channel. Inventory will show as 0." />
          </Label>
          <Switch checked={eligible} onCheckedChange={setEligible} />
        </div>

        {eligible && (
          <>
            <div className="space-y-2">
              <Label>
                Allocation Mode
                <InfoTip text="Controls how much of your available inventory this channel can see. Each channel gets its own independent view — no channel 'takes' inventory from another." />
              </Label>
              <div className="grid grid-cols-3 gap-2">
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={mode === "mirror" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setMode("mirror")}
                      >
                        🟢 Mirror
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs text-sm">
                      <p>Channel sees 100% of available inventory. If you have 500 units, the channel shows 500. First order from any channel gets it.</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={mode === "share" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setMode("share")}
                      >
                        🔵 Share %
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs text-sm">
                      <p>Channel sees X% of available inventory. Use to hold back stock — e.g., 80% means 400 shown when you have 500.</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={mode === "fixed" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setMode("fixed")}
                      >
                        🟡 Fixed
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-xs text-sm">
                      <p>Channel shows a fixed number regardless of actual stock. Use to cap listings — e.g., "only ever show 10 on eBay."</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>

            {mode === "share" && (
              <div className="space-y-1">
                <Label>
                  Share Percentage
                  <InfoTip text="What percentage of total available inventory this channel can see. 100% = same as Mirror. 50% = channel sees half your stock." />
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={sharePct}
                  onChange={(e) => setSharePct(e.target.value)}
                  autoComplete="off"
                />
              </div>
            )}

            {mode === "fixed" && (
              <div className="space-y-1">
                <Label>
                  Fixed Quantity (base units)
                  <InfoTip text="The exact number of base units to show on this channel. If actual stock is lower, the lower number is used." />
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={fixedQty}
                  onChange={(e) => setFixedQty(e.target.value)}
                  autoComplete="off"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">
                  Floor ATP
                  <InfoTip text="If total stock drops below this number, push 0 to this channel. Prevents selling the last few units — e.g., 'stop selling on eBay when below 20 units.'" />
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={floorAtp}
                  onChange={(e) => setFloorAtp(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  Ceiling
                  <InfoTip text="Never show more than this many units, even if stock is higher. Use to control perception — e.g., 'cap TikTok at 100 even though we have 5,000.'" />
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
          </>
        )}

        <div className="space-y-1">
          <Label className="text-xs">Notes</Label>
          <Textarea
            placeholder="Optional notes..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="h-16"
          />
        </div>
      </div>
      <DialogFooter>
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
                      <TableCell className="font-medium text-sm">{rule.channelName}</TableCell>
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
