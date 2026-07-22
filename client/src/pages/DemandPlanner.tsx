import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronDown,
  Edit2,
  Loader2,
  Package,
  Plus,
  Search,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

type DemandEventType = "drop" | "preorder" | "promotion" | "wholesale" | "seasonal" | "manual_forecast";
type DemandEventStatus = "planned" | "active" | "completed" | "cancelled";
type DemandConfidence = "high" | "medium" | "low";

interface DemandEventSummary {
  id: number;
  name: string;
  eventType: DemandEventType;
  startDate: string;
  endDate: string | null;
  status: DemandEventStatus;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lineCount: number;
  totalExpectedPieces: number;
}

interface DemandEventLine {
  id: number;
  demandEventId: number;
  productId: number;
  productVariantId: number | null;
  expectedPieces: number;
  confidence: DemandConfidence;
  notes: string | null;
  productName: string;
  productSku: string | null;
  variantName: string | null;
  variantSku: string | null;
}

interface DemandEventDetail extends Omit<DemandEventSummary, "lineCount" | "totalExpectedPieces"> {
  lines: DemandEventLine[];
}

interface ProductSearchResult {
  id: number;
  variantId: number;
  sku: string | null;
  title: string;
  imageUrl: string | null;
  matchedVariantSku: string | null;
}

interface ForwardDemandItem {
  productId: number;
  productName: string;
  productSku: string | null;
  totalExpectedPieces: number;
  weightedExpectedPieces: number;
  highConfidencePieces: number;
  mediumConfidencePieces: number;
  lowConfidencePieces: number;
  eventCount: number;
}

interface ForwardDemandResponse {
  enabled: boolean;
  horizonDays: number;
  confidenceWeights: Record<DemandConfidence, number>;
  items: ForwardDemandItem[];
  totalProducts: number;
}

interface DemandLineDraft {
  productId: number | null;
  productVariantId: number | null;
  sku: string;
  title: string;
  expectedPieces: string;
  confidence: DemandConfidence;
  notes: string;
}

const EVENT_TYPES: Array<{ value: DemandEventType; label: string }> = [
  { value: "drop", label: "Product Drop" },
  { value: "preorder", label: "Preorder" },
  { value: "promotion", label: "Promotion" },
  { value: "wholesale", label: "Wholesale Order" },
  { value: "seasonal", label: "Seasonal Forecast" },
  { value: "manual_forecast", label: "Manual Forecast" },
];

const CONFIDENCE_OPTIONS: Array<{ value: DemandConfidence; label: string }> = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function emptyLine(): DemandLineDraft {
  return {
    productId: null,
    productVariantId: null,
    sku: "",
    title: "",
    expectedPieces: "",
    confidence: "medium",
    notes: "",
  };
}

function typeLabel(type: DemandEventType): string {
  return EVENT_TYPES.find((option) => option.value === type)?.label ?? type;
}

function statusClass(status: DemandEventStatus): string {
  switch (status) {
    case "planned": return "border-blue-300 bg-blue-50 text-blue-800";
    case "active": return "border-green-300 bg-green-50 text-green-800";
    case "completed": return "border-zinc-300 bg-zinc-50 text-zinc-700";
    case "cancelled": return "border-red-300 bg-red-50 text-red-800";
  }
}

function ProductSkuPicker({
  line,
  onSelect,
}: {
  line: DemandLineDraft;
  onSelect: (result: ProductSearchResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [search]);

  const searchQuery = useQuery<ProductSearchResult[]>({
    queryKey: ["/api/catalog/products/search", debouncedSearch],
    queryFn: async () => {
      const response = await fetch(`/api/catalog/products/search?q=${encodeURIComponent(debouncedSearch)}&limit=25`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Product search failed");
      return response.json();
    },
    enabled: open && debouncedSearch.length >= 2,
  });

  return (
    <Popover open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setSearch("");
    }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="h-auto min-h-10 w-full justify-start px-3 py-2 text-left font-normal">
          <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
          {line.productId ? (
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs font-semibold">{line.sku || `Product ${line.productId}`}</span>
              <span className="block truncate text-xs text-muted-foreground">{line.title}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Search product name or SKU</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] max-w-[calc(100vw-2rem)] p-0" align="start">
        <div className="border-b p-2">
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Enter at least 2 characters"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {searchQuery.isFetching && (
            <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching catalog
            </div>
          )}
          {searchQuery.isError && <p className="p-4 text-sm text-red-700">Product search failed.</p>}
          {debouncedSearch.length >= 2 && !searchQuery.isFetching && (searchQuery.data?.length ?? 0) === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No products match this search.</p>
          )}
          {(searchQuery.data ?? []).map((result) => (
            <button
              key={`${result.id}:${result.variantId}`}
              type="button"
              className="flex w-full items-start gap-3 rounded px-3 py-2 text-left hover:bg-muted"
              onClick={() => {
                onSelect(result);
                setOpen(false);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs font-semibold">{result.sku || `Product ${result.id}`}</span>
                <span className="block truncate text-sm">{result.title}</span>
              </span>
              {result.id === line.productId && result.variantId === line.productVariantId && <Check className="mt-1 h-4 w-4 text-green-700" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DemandEventEditor({
  open,
  event,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  event: DemandEventDetail | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [eventType, setEventType] = useState<DemandEventType>("manual_forecast");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DemandLineDraft[]>([emptyLine()]);

  useEffect(() => {
    if (!open) return;
    setName(event?.name ?? "");
    setEventType(event?.eventType ?? "manual_forecast");
    setStartDate(event?.startDate ?? "");
    setEndDate(event?.endDate ?? "");
    setNotes(event?.notes ?? "");
    setLines(event?.lines.map((line) => ({
      productId: line.productId,
      productVariantId: line.productVariantId,
      sku: line.variantSku ?? line.productSku ?? "",
      title: line.variantName ? `${line.productName} - ${line.variantName}` : line.productName,
      expectedPieces: String(line.expectedPieces),
      confidence: line.confidence,
      notes: line.notes ?? "",
    })) ?? [emptyLine()]);
  }, [event, open]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        eventType,
        startDate,
        endDate: endDate || null,
        status: event?.status ?? "planned",
        notes: notes.trim() || null,
        lines: lines.map((line) => ({
          productId: line.productId,
          productVariantId: line.productVariantId,
          expectedPieces: Number(line.expectedPieces),
          confidence: line.confidence,
          notes: line.notes.trim() || null,
        })),
        ...(event ? { expectedUpdatedAt: event.updatedAt } : {}),
      };
      const response = await fetch(event ? `/api/demand-events/${event.id}` : "/api/demand-events", {
        method: event ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseBody?.error ?? "Demand event could not be saved");
      return responseBody as DemandEventDetail;
    },
    onSuccess: () => {
      toast({ title: event ? "Demand event updated" : "Demand event created" });
      onOpenChange(false);
      onSaved();
    },
    onError: (error: Error) => {
      toast({ title: "Demand event not saved", description: error.message, variant: "destructive" });
    },
  });

  const validLines = lines.length > 0 && lines.every((line) => (
    line.productId !== null
    && Number.isSafeInteger(Number(line.expectedPieces))
    && Number(line.expectedPieces) > 0
  ));
  const validWindow = !endDate || !startDate || endDate >= startDate;
  const canSave = Boolean(name.trim() && startDate && validLines && validWindow && !saveMutation.isPending);

  function updateLine(index: number, patch: Partial<DemandLineDraft>) {
    setLines((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, ...patch } : line));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{event ? "Edit Demand Event" : "New Demand Event"}</DialogTitle>
          <DialogDescription>
            Enter expected demand in pieces. Confidence weighting is applied by the purchasing forecast policy.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="demand-event-name">Event name</Label>
              <Input id="demand-event-name" value={name} onChange={(input) => setName(input.target.value)} placeholder="Fall wholesale commitment" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={eventType} onValueChange={(value) => setEventType(value as DemandEventType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="demand-start-date">Start date</Label>
              <Input id="demand-start-date" type="date" value={startDate} onChange={(input) => setStartDate(input.target.value)} />
            </div>
            <div>
              <Label htmlFor="demand-end-date">End date</Label>
              <Input id="demand-end-date" type="date" value={endDate} onChange={(input) => setEndDate(input.target.value)} />
              {!validWindow && <p className="mt-1 text-xs text-red-700">End date must be on or after the start date.</p>}
            </div>
          </div>

          <div>
            <Label htmlFor="demand-event-notes">Notes</Label>
            <Textarea id="demand-event-notes" value={notes} onChange={(input) => setNotes(input.target.value)} rows={2} maxLength={4000} />
          </div>

          <div className="border-t pt-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Demand lines</h3>
                <p className="text-xs text-muted-foreground">Choose the catalog SKU that creates the demand and enter the expected piece quantity.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((current) => [...current, emptyLine()])}>
                <Plus className="mr-1 h-4 w-4" /> Add line
              </Button>
            </div>

            <div className="space-y-3">
              {lines.map((line, index) => (
                <div key={index} className="grid items-end gap-3 border-b pb-3 last:border-0 sm:grid-cols-[minmax(0,1fr)_140px_150px_40px]">
                  <div>
                    <Label className="text-xs">Product / SKU</Label>
                    <ProductSkuPicker
                      line={line}
                      onSelect={(result) => updateLine(index, {
                        productId: result.id,
                        productVariantId: result.variantId,
                        sku: result.sku ?? "",
                        title: result.title,
                      })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Expected pieces</Label>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={line.expectedPieces}
                      onChange={(input) => updateLine(index, { expectedPieces: input.target.value })}
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Confidence</Label>
                    <Select value={line.confidence} onValueChange={(value) => updateLine(index, { confidence: value as DemandConfidence })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CONFIDENCE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Remove demand line"
                    disabled={lines.length === 1}
                    onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))}
                  >
                    <Trash2 className="h-4 w-4 text-red-600" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canSave} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {event ? "Save changes" : "Create event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EventRow({
  event,
  detail,
  loadingDetail,
  weights,
  onToggle,
  onEdit,
  onStatusChange,
  onDelete,
}: {
  event: DemandEventSummary;
  detail?: DemandEventDetail;
  loadingDetail: boolean;
  weights: Record<DemandConfidence, number>;
  onToggle: () => void;
  onEdit: () => void;
  onStatusChange: (status: DemandEventStatus) => void;
  onDelete: () => void;
}) {
  const expanded = detail !== undefined || loadingDetail;
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" title={expanded ? "Collapse event" : "Expand event"} onClick={onToggle}>
              <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{event.name}</span>
                <Badge variant="outline">{typeLabel(event.eventType)}</Badge>
                <Badge variant="outline" className={statusClass(event.status)}>{event.status}</Badge>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{event.startDate}{event.endDate ? ` to ${event.endDate}` : ""}</span>
                <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" />{event.totalExpectedPieces.toLocaleString()} pieces across {event.lineCount} SKU{event.lineCount === 1 ? "" : "s"}</span>
              </div>
              {event.notes && <p className="mt-2 text-xs text-muted-foreground">{event.notes}</p>}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1 pl-10 sm:pl-0">
            {(event.status === "planned" || event.status === "active") && (
              <Button variant="ghost" size="icon" title="Edit demand event" onClick={onEdit}><Edit2 className="h-4 w-4" /></Button>
            )}
            {event.status === "planned" && <Button size="sm" variant="outline" onClick={() => onStatusChange("active")}>Activate</Button>}
            {event.status === "active" && <Button size="sm" variant="outline" onClick={() => onStatusChange("completed")}>Complete</Button>}
            {(event.status === "planned" || event.status === "active") && (
              <Button variant="ghost" size="icon" title="Cancel demand event" onClick={() => onStatusChange("cancelled")}><X className="h-4 w-4" /></Button>
            )}
            <Button variant="ghost" size="icon" title="Delete demand event" onClick={onDelete}><Trash2 className="h-4 w-4 text-red-600" /></Button>
          </div>
        </div>

        {expanded && (
          <div className="mt-4 border-t pt-3">
            {loadingDetail ? (
              <div className="flex items-center justify-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading event lines</div>
            ) : detail?.lines.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="py-2 text-left font-medium">SKU</th>
                      <th className="py-2 text-left font-medium">Product</th>
                      <th className="py-2 text-right font-medium">Expected pieces</th>
                      <th className="py-2 text-right font-medium">Confidence</th>
                      <th className="py-2 text-right font-medium">Forecast pieces</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => {
                      const weight = weights[line.confidence];
                      return (
                        <tr key={line.id} className="border-b last:border-0">
                          <td className="py-2 font-mono text-xs font-semibold">{line.variantSku ?? line.productSku ?? `Product ${line.productId}`}</td>
                          <td className="py-2">{line.productName}{line.variantName ? ` - ${line.variantName}` : ""}</td>
                          <td className="py-2 text-right tabular-nums">{line.expectedPieces.toLocaleString()}</td>
                          <td className="py-2 text-right"><Badge variant="outline">{line.confidence} ({weight}%)</Badge></td>
                          <td className="py-2 text-right font-semibold tabular-nums">{Math.ceil(line.expectedPieces * weight / 100).toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="py-4 text-sm text-muted-foreground">No demand lines found.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DemandPlanner() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [statusFilter, setStatusFilter] = useState("planned,active");
  const [detailById, setDetailById] = useState<Map<number, DemandEventDetail>>(new Map());
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<number>>(new Set());
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorEvent, setEditorEvent] = useState<DemandEventDetail | null>(null);

  const eventsQuery = useQuery<{ events: DemandEventSummary[]; total: number }>({
    queryKey: ["/api/demand-events", statusFilter],
    queryFn: async () => {
      const response = await fetch(`/api/demand-events?status=${encodeURIComponent(statusFilter)}&limit=100`, { credentials: "include" });
      if (!response.ok) throw new Error("Demand events could not be loaded");
      return response.json();
    },
  });

  const forwardDemandQuery = useQuery<ForwardDemandResponse>({
    queryKey: ["/api/demand-events/forward-demand"],
    queryFn: async () => {
      const response = await fetch("/api/demand-events/forward-demand", { credentials: "include" });
      if (!response.ok) throw new Error("Forward demand summary could not be loaded");
      return response.json();
    },
  });

  function invalidateDemandPlanning() {
    setDetailById(new Map());
    queryClient.invalidateQueries({ queryKey: ["/api/demand-events"] });
    queryClient.invalidateQueries({ queryKey: ["/api/demand-events/forward-demand"] });
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/rfq-queue"] });
  }

  async function loadEventDetail(id: number, force = false): Promise<DemandEventDetail | null> {
    if (!force && detailById.has(id)) return detailById.get(id) ?? null;
    setLoadingDetailIds((current) => new Set(current).add(id));
    try {
      const response = await fetch(`/api/demand-events/${id}`, { credentials: "include" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "Demand event details could not be loaded");
      const detail = body as DemandEventDetail;
      setDetailById((current) => new Map(current).set(id, detail));
      return detail;
    } catch (error) {
      toast({ title: "Demand event not loaded", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
      return null;
    } finally {
      setLoadingDetailIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  const statusMutation = useMutation({
    mutationFn: async ({ event, status }: { event: DemandEventSummary; status: DemandEventStatus }) => {
      const response = await fetch(`/api/demand-events/${event.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status, expectedUpdatedAt: event.updatedAt }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "Demand event status could not be changed");
      return body;
    },
    onSuccess: () => {
      invalidateDemandPlanning();
      toast({ title: "Demand event status updated" });
    },
    onError: (error: Error) => toast({ title: "Status not updated", description: error.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (event: DemandEventSummary) => {
      const response = await fetch(`/api/demand-events/${event.id}?expectedUpdatedAt=${encodeURIComponent(event.updatedAt)}`, { method: "DELETE", credentials: "include" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? "Demand event could not be deleted");
      return body;
    },
    onSuccess: () => {
      invalidateDemandPlanning();
      toast({ title: "Demand event deleted" });
    },
    onError: (error: Error) => toast({ title: "Demand event not deleted", description: error.message, variant: "destructive" }),
  });

  const policy = forwardDemandQuery.data;
  const weights = policy?.confidenceWeights ?? { high: 100, medium: 70, low: 40 };

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Demand Planner</h1>
          <p className="text-sm text-muted-foreground">Maintain future demand that feeds purchase recommendations.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate("/reorder-analysis")}>Purchase recommendations</Button>
          <Button onClick={() => {
            setEditorEvent(null);
            setEditorOpen(true);
          }}><Plus className="mr-2 h-4 w-4" />New demand event</Button>
        </div>
      </div>

      {policy && !policy.enabled && (
        <div className="flex items-center gap-3 border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          Future-demand overlays are disabled in the purchasing forecast policy. Events remain stored but currently add zero pieces to recommendations.
        </div>
      )}

      {policy && policy.items.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg"><TrendingUp className="h-5 w-5" />Forecast impact</CardTitle>
                <CardDescription>{policy.totalProducts} products inside the configured {policy.horizonDays}-day horizon</CardDescription>
              </div>
              <div className="flex gap-2 text-xs">
                <Badge variant="outline">High {weights.high}%</Badge>
                <Badge variant="outline">Medium {weights.medium}%</Badge>
                <Badge variant="outline">Low {weights.low}%</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 text-left font-medium">SKU</th>
                    <th className="py-2 text-left font-medium">Product</th>
                    <th className="py-2 text-right font-medium">Raw pieces</th>
                    <th className="py-2 text-right font-medium">Forecast pieces</th>
                    <th className="py-2 text-right font-medium">Events</th>
                  </tr>
                </thead>
                <tbody>
                  {policy.items.map((item) => (
                    <tr key={item.productId} className="border-b last:border-0">
                      <td className="py-2 font-mono text-xs font-semibold">{item.productSku ?? `Product ${item.productId}`}</td>
                      <td className="py-2">{item.productName}</td>
                      <td className="py-2 text-right tabular-nums">{item.totalExpectedPieces.toLocaleString()}</td>
                      <td className="py-2 text-right font-semibold tabular-nums">{policy.enabled ? item.weightedExpectedPieces.toLocaleString() : "0"}</td>
                      <td className="py-2 text-right tabular-nums">{item.eventCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {[
          { value: "planned,active", label: "Active and planned" },
          { value: "planned", label: "Planned" },
          { value: "active", label: "Active" },
          { value: "completed", label: "Completed" },
          { value: "cancelled", label: "Cancelled" },
        ].map((filter) => (
          <Button key={filter.value} size="sm" variant={statusFilter === filter.value ? "default" : "outline"} onClick={() => setStatusFilter(filter.value)}>
            {filter.label}
          </Button>
        ))}
      </div>

      {eventsQuery.isLoading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading demand events</div>
      ) : eventsQuery.isError ? (
        <div className="border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">Demand events could not be loaded.</div>
      ) : (eventsQuery.data?.events.length ?? 0) === 0 ? (
        <div className="border py-12 text-center">
          <Calendar className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
          <p className="font-medium">No demand events in this status</p>
        </div>
      ) : (
        <div className="space-y-2">
          {(eventsQuery.data?.events ?? []).map((event) => (
            <EventRow
              key={event.id}
              event={event}
              detail={detailById.get(event.id)}
              loadingDetail={loadingDetailIds.has(event.id)}
              weights={weights}
              onToggle={() => {
                if (detailById.has(event.id)) {
                  setDetailById((current) => {
                    const next = new Map(current);
                    next.delete(event.id);
                    return next;
                  });
                } else {
                  void loadEventDetail(event.id);
                }
              }}
              onEdit={() => {
                void loadEventDetail(event.id, true).then((detail) => {
                  if (!detail) return;
                  setEditorEvent(detail);
                  setEditorOpen(true);
                });
              }}
              onStatusChange={(status) => statusMutation.mutate({ event, status })}
              onDelete={() => {
                if (window.confirm(`Delete demand event "${event.name}"? The deletion is recorded in the audit log.`)) {
                  deleteMutation.mutate(event);
                }
              }}
            />
          ))}
        </div>
      )}

      <DemandEventEditor
        open={editorOpen}
        event={editorEvent}
        onOpenChange={setEditorOpen}
        onSaved={invalidateDemandPlanning}
      />
    </div>
  );
}
