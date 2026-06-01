import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Trash2, Edit2, Calendar, Package, TrendingUp,
  Check, X, ChevronDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

interface DemandEvent {
  id: number;
  name: string;
  event_type: string;
  start_date: string;
  end_date: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface DemandEventLine {
  id: number;
  demand_event_id: number;
  product_id: number;
  product_variant_id: number | null;
  expected_pieces: number;
  confidence: string;
  notes: string | null;
}

interface DemandEventWithLines extends DemandEvent {
  lines: DemandEventLine[];
}

interface ForwardDemandItem {
  productId: number;
  totalExpectedPieces: number;
  highConfidencePieces: number;
  mediumConfidencePieces: number;
  lowConfidencePieces: number;
  eventCount: number;
}

const EVENT_TYPES = [
  { value: "drop", label: "Product Drop" },
  { value: "preorder", label: "Preorder" },
  { value: "promotion", label: "Promotion" },
  { value: "wholesale", label: "Wholesale Order" },
  { value: "seasonal", label: "Seasonal Forecast" },
  { value: "manual_forecast", label: "Manual Forecast" },
];

const STATUS_OPTIONS = [
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

const CONFIDENCE_OPTIONS = [
  { value: "high", label: "High (100%)" },
  { value: "medium", label: "Medium (70%)" },
  { value: "low", label: "Low (40%)" },
];

function statusColor(status: string): string {
  switch (status) {
    case "planned": return "bg-blue-100 text-blue-800";
    case "active": return "bg-green-100 text-green-800";
    case "completed": return "bg-gray-100 text-gray-800";
    case "cancelled": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-800";
  }
}

function typeLabel(type: string): string {
  return EVENT_TYPES.find((t) => t.value === type)?.label ?? type;
}

function CreateEventDialog({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [eventType, setEventType] = useState("manual_forecast");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<{ productId: string; expectedPieces: string; confidence: string }[]>([
    { productId: "", expectedPieces: "", confidence: "medium" },
  ]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        eventType,
        startDate,
        endDate: endDate || null,
        notes: notes || null,
        lines: lines
          .filter((l) => l.productId && l.expectedPieces)
          .map((l) => ({
            productId: Number(l.productId),
            expectedPieces: Number(l.expectedPieces),
            confidence: l.confidence,
          })),
      };
      const res = await fetch("/api/demand-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create event");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Demand event created" });
      setOpen(false);
      resetForm();
      onCreated();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function resetForm() {
    setName("");
    setEventType("manual_forecast");
    setStartDate("");
    setEndDate("");
    setNotes("");
    setLines([{ productId: "", expectedPieces: "", confidence: "medium" }]);
  }

  function addLine() {
    setLines([...lines, { productId: "", expectedPieces: "", confidence: "medium" }]);
  }

  function removeLine(index: number) {
    setLines(lines.filter((_, i) => i !== index));
  }

  function updateLine(index: number, field: string, value: string) {
    const updated = [...lines];
    (updated[index] as any)[field] = value;
    setLines(updated);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" /> New Demand Event
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Demand Event</DialogTitle>
          <DialogDescription>
            Register known future demand so the purchasing engine accounts for it in reorder recommendations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Event Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Summer Sale 2026" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Start Date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label>End Date (optional)</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          <div>
            <Label>Notes</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes..." />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Product Lines</Label>
              <Button variant="outline" size="sm" onClick={addLine}>
                <Plus className="h-3 w-3 mr-1" /> Add Line
              </Button>
            </div>
            <div className="space-y-2">
              {lines.map((line, i) => (
                <div key={i} className="flex gap-2 items-end">
                  <div className="flex-1">
                    {i === 0 && <Label className="text-xs">Product ID</Label>}
                    <Input
                      type="number"
                      value={line.productId}
                      onChange={(e) => updateLine(i, "productId", e.target.value)}
                      placeholder="Product ID"
                    />
                  </div>
                  <div className="w-32">
                    {i === 0 && <Label className="text-xs">Pieces</Label>}
                    <Input
                      type="number"
                      value={line.expectedPieces}
                      onChange={(e) => updateLine(i, "expectedPieces", e.target.value)}
                      placeholder="Qty"
                    />
                  </div>
                  <div className="w-36">
                    {i === 0 && <Label className="text-xs">Confidence</Label>}
                    <Select
                      value={line.confidence}
                      onValueChange={(v) => updateLine(i, "confidence", v)}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CONFIDENCE_OPTIONS.map((c) => (
                          <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {lines.length > 1 && (
                    <Button variant="ghost" size="icon" onClick={() => removeLine(i)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!name || !startDate || createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create Event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EventCard({
  event,
  onStatusChange,
  onDelete,
}: {
  event: DemandEventWithLines;
  onStatusChange: (id: number, status: string) => void;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const totalPieces = event.lines.reduce((s, l) => s + l.expected_pieces, 0);

  return (
    <Card className="hover:shadow-sm transition-shadow">
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{event.name}</span>
                <Badge variant="outline" className="text-xs">{typeLabel(event.event_type)}</Badge>
                <Badge className={`text-xs ${statusColor(event.status)}`}>{event.status}</Badge>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {event.start_date}
                  {event.end_date && ` → ${event.end_date}`}
                </span>
                <span className="flex items-center gap-1">
                  <Package className="h-3 w-3" />
                  {totalPieces.toLocaleString()} pieces across {event.lines.length} products
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {event.status === "planned" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onStatusChange(event.id, "active")}
              >
                Activate
              </Button>
            )}
            {event.status === "active" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onStatusChange(event.id, "completed")}
              >
                Complete
              </Button>
            )}
            {["planned", "active"].includes(event.status) && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => onStatusChange(event.id, "cancelled")}
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onDelete(event.id)}
            >
              <Trash2 className="h-4 w-4 text-red-400" />
            </Button>
          </div>
        </div>

        {expanded && event.lines.length > 0 && (
          <div className="mt-3 border-t pt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b">
                  <th className="text-left py-1 font-medium">Product ID</th>
                  <th className="text-right py-1 font-medium">Expected Pieces</th>
                  <th className="text-left py-1 font-medium pl-4">Confidence</th>
                  <th className="text-right py-1 font-medium">Weighted</th>
                </tr>
              </thead>
              <tbody>
                {event.lines.map((line) => {
                  const weight = line.confidence === "high" ? 1 : line.confidence === "medium" ? 0.7 : 0.4;
                  return (
                    <tr key={line.id} className="border-b last:border-0">
                      <td className="py-1.5">{line.product_id}</td>
                      <td className="text-right py-1.5">{line.expected_pieces.toLocaleString()}</td>
                      <td className="py-1.5 pl-4">
                        <Badge variant="outline" className="text-xs">
                          {line.confidence} ({Math.round(weight * 100)}%)
                        </Badge>
                      </td>
                      <td className="text-right py-1.5">
                        {Math.ceil(line.expected_pieces * weight).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DemandPlanner() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("planned,active");

  const { data: eventsData, isLoading } = useQuery<{ events: DemandEvent[]; total: number }>({
    queryKey: ["/api/demand-events", statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/demand-events?status=${statusFilter}&limit=100`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch events");
      return res.json();
    },
  });

  const [expandedEvents, setExpandedEvents] = useState<Map<number, DemandEventWithLines>>(new Map());

  const { data: forwardDemandData } = useQuery<{ horizonDays: number; items: ForwardDemandItem[]; totalProducts: number }>({
    queryKey: ["/api/demand-events/forward-demand"],
    queryFn: async () => {
      const res = await fetch("/api/demand-events/forward-demand?horizonDays=90", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch forward demand");
      return res.json();
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await fetch(`/api/demand-events/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/demand-events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/demand-events/forward-demand"] });
      toast({ title: "Event updated" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/demand-events/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete event");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/demand-events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/demand-events/forward-demand"] });
      toast({ title: "Event deleted" });
    },
  });

  async function loadEventDetail(eventId: number) {
    if (expandedEvents.has(eventId)) return;
    const res = await fetch(`/api/demand-events/${eventId}`, { credentials: "include" });
    if (res.ok) {
      const detail = await res.json();
      setExpandedEvents((prev) => new Map(prev).set(eventId, detail));
    }
  }

  React.useEffect(() => {
    if (eventsData?.events) {
      for (const event of eventsData.events) {
        loadEventDetail(event.id);
      }
    }
  }, [eventsData?.events]);

  const events = eventsData?.events ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Demand Planner</h1>
          <p className="text-sm text-muted-foreground">
            Register known future demand events to improve purchasing recommendations
          </p>
        </div>
        <CreateEventDialog onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ["/api/demand-events"] });
          queryClient.invalidateQueries({ queryKey: ["/api/demand-events/forward-demand"] });
        }} />
      </div>

      {/* Forward Demand Summary */}
      {forwardDemandData && forwardDemandData.items.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Forward Demand Summary (90-day horizon)
            </CardTitle>
            <CardDescription>
              {forwardDemandData.totalProducts} products with planned demand events
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
              {forwardDemandData.items.slice(0, 6).map((item) => (
                <div key={item.productId} className="text-center p-2 rounded-lg bg-muted/50">
                  <p className="text-xs text-muted-foreground">Product {item.productId}</p>
                  <p className="text-lg font-bold">{item.totalExpectedPieces.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">
                    pieces / {item.eventCount} event{item.eventCount !== 1 ? "s" : ""}
                  </p>
                </div>
              ))}
            </div>
            {forwardDemandData.items.length > 6 && (
              <p className="text-xs text-muted-foreground mt-2 text-center">
                + {forwardDemandData.items.length - 6} more products
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex gap-2">
        {[
          { value: "planned,active", label: "Active & Planned" },
          { value: "planned", label: "Planned" },
          { value: "active", label: "Active" },
          { value: "completed", label: "Completed" },
          { value: "cancelled", label: "Cancelled" },
        ].map((f) => (
          <Button
            key={f.value}
            variant={statusFilter === f.value ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Events List */}
      {isLoading ? (
        <p className="text-muted-foreground">Loading events...</p>
      ) : events.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center">
            <Calendar className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground">No demand events found</p>
            <p className="text-sm text-muted-foreground mt-1">
              Create your first event to start planning future demand
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {events.map((event) => {
            const detail = expandedEvents.get(event.id);
            const withLines: DemandEventWithLines = detail ?? { ...event, lines: [] };
            return (
              <EventCard
                key={event.id}
                event={withLines}
                onStatusChange={(id, status) => statusMutation.mutate({ id, status })}
                onDelete={(id) => {
                  if (window.confirm("Delete this demand event? This cannot be undone.")) {
                    deleteMutation.mutate(id);
                  }
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
