import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Loader2, Package, PackageCheck, RefreshCw, Search } from "lucide-react";

// ===== Types (API contract: /api/shipping/packing/*) =====

interface PackingParcelItem {
  productVariantId: number;
  sku: string | null;
  name: string | null;
  quantity: number;
  isRider: boolean;
}

interface PackingParcel {
  id: number;
  parcelSequence: number;
  boxId: number | null;
  boxCode: string | null;
  boxName: string | null;
  siocProductVariantId: number | null;
  siocSku: string | null;
  estWeightGrams: number;
  billableWeightGrams: number;
  actualBoxId: number | null;
  actualWeightGrams: number | null;
  weightDeltaGrams: number | null;
  packedAt: string | null;
  packedBy: string | null;
  items: PackingParcelItem[];
}

interface PackingPlan {
  id: number;
  status: string;
  engineVersion: string;
  createdAt: string;
  parcels: PackingParcel[];
}

interface PackingOrder {
  id: number;
  orderNumber: string;
  customerName: string;
  warehouseStatus: string;
  shippingServiceLevel: string;
  itemCount: number;
  unitCount: number;
  items: { sku: string; name: string; quantity: number }[];
  plan: PackingPlan | null;
}

interface BoxOption {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
}

interface PackingQueueResponse {
  orders: PackingOrder[];
  boxes: BoxOption[];
}

// ===== Unit conversion helpers (copied from ShippingSettings.tsx — keep in sync) =====

const GRAMS_PER_POUND = 453.59237;
// Derived from the constant above — do not introduce new base constants.
const GRAMS_PER_OUNCE = GRAMS_PER_POUND / 16;

function formatMeasurementInput(value: number | null | undefined, divisor: number): string {
  if (value === null || value === undefined) return "";
  return (value / divisor).toFixed(3).replace(/\.?0+$/, "");
}

function formatWeight(grams: number | null | undefined): string {
  if (grams === null || grams === undefined) return "—";
  if (grams >= GRAMS_PER_POUND) return `${formatMeasurementInput(grams, GRAMS_PER_POUND)} lb`;
  return `${formatMeasurementInput(grams, GRAMS_PER_OUNCE)} oz`;
}

function toStoredGramsFromOz(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Actual weight must be greater than zero.");
  }
  const grams = Math.round(parsed * GRAMS_PER_OUNCE);
  if (grams <= 0) throw new Error("Actual weight is too small to store.");
  return grams;
}

/** Signed delta for display: "+1.2 oz" / "−0.4 oz". */
function formatWeightDelta(deltaGrams: number): string {
  const sign = deltaGrams > 0 ? "+" : deltaGrams < 0 ? "−" : "±";
  return `${sign}${formatWeight(Math.abs(deltaGrams)) || "0 oz"}`;
}

/** Compact plan summary for the queue list: "M x2 + SIOC SLV-100 x1". */
function planSummary(plan: PackingPlan): string {
  const counts = new Map<string, number>();
  for (const parcel of plan.parcels) {
    const label = parcel.boxCode ?? (parcel.siocSku ? `SIOC ${parcel.siocSku}` : "?");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label} x${count}`).join(" + ");
}

// ===== Fetch helpers (same conventions as ShippingSettings.tsx) =====

const QUEUE_URL = "/api/shipping/packing/queue";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.error?.code || `Request failed (${res.status})`);
  }
  return res.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error?.message || errBody?.error?.code || `Request failed (${res.status})`);
  }
  return res.json();
}

// ===== Page =====

export default function Packing() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [search, setSearch] = useState("");

  const queueQuery = useQuery<PackingQueueResponse>({
    queryKey: [QUEUE_URL],
    queryFn: () => fetchJson<PackingQueueResponse>(QUEUE_URL),
  });

  const invalidateQueue = () => queryClient.invalidateQueries({ queryKey: [QUEUE_URL] });

  const generatePlanMutation = useMutation({
    mutationFn: (wmsOrderId: number) =>
      postJson<{ plan: unknown; instruction: string | null }>(
        `/api/shipping/packing/orders/${wmsOrderId}/generate-plan`,
        {},
      ),
    onSuccess: () => {
      toast({ title: "Pack plan generated" });
      invalidateQueue();
    },
    onError: (error: Error) => {
      toast({ title: "Could not generate plan", description: error.message, variant: "destructive" });
    },
  });

  const orders = queueQuery.data?.orders ?? [];
  const boxes = queueQuery.data?.boxes ?? [];

  const filteredOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return orders;
    return orders.filter((o) =>
      o.orderNumber.toLowerCase().includes(term)
      || o.customerName.toLowerCase().includes(term),
    );
  }, [orders, search]);

  const selectedOrder = filteredOrders.find((o) => o.id === selectedOrderId)
    ?? orders.find((o) => o.id === selectedOrderId)
    ?? null;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <PackageCheck className="h-6 w-6" />
            Packing
          </h1>
          <p className="text-sm text-muted-foreground">
            Confirm the actual box and weight per parcel — every confirmation tunes the cartonizer.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => invalidateQueue()} disabled={queueQuery.isFetching}>
          {queueQuery.isFetching
            ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            : <RefreshCw className="h-4 w-4 mr-2" />}
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        {/* Queue list */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Queue ({filteredOrders.length})</CardTitle>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search order # or customer"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {queueQuery.isLoading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading queue…
              </div>
            ) : queueQuery.isError ? (
              <p className="p-4 text-sm text-destructive">
                Failed to load queue: {(queueQuery.error as Error).message}
              </p>
            ) : filteredOrders.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No orders ready for packing.</p>
            ) : (
              <ul className="divide-y max-h-[70vh] overflow-y-auto">
                {filteredOrders.map((order) => (
                  <li key={order.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedOrderId(order.id)}
                      className={`w-full text-left px-4 py-3 hover:bg-muted/50 ${selectedOrderId === order.id ? "bg-muted" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{order.orderNumber}</span>
                        <PlanStatusBadge plan={order.plan} />
                      </div>
                      <div className="text-sm text-muted-foreground flex items-center justify-between gap-2">
                        <span className="truncate">{order.customerName}</span>
                        <span className="shrink-0">{order.unitCount} unit{order.unitCount === 1 ? "" : "s"}</span>
                      </div>
                      {order.plan && (
                        <div className="text-xs text-muted-foreground mt-1 font-mono">
                          BOX: {planSummary(order.plan)}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Detail panel */}
        {selectedOrder ? (
          <OrderDetail
            key={selectedOrder.id}
            order={selectedOrder}
            boxes={boxes}
            onGeneratePlan={() => generatePlanMutation.mutate(selectedOrder.id)}
            generating={generatePlanMutation.isPending}
            onConfirmed={invalidateQueue}
          />
        ) : (
          <Card className="flex items-center justify-center min-h-[240px]">
            <CardContent className="text-center text-muted-foreground py-10">
              <Package className="h-8 w-8 mx-auto mb-2" />
              Select an order from the queue to see its pack plan.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function PlanStatusBadge({ plan }: { plan: PackingPlan | null }) {
  if (!plan) return <Badge variant="outline">no plan</Badge>;
  if (plan.status === "packed") return <Badge className="bg-green-600 hover:bg-green-600">packed</Badge>;
  const confirmed = plan.parcels.filter((p) => p.packedAt).length;
  if (confirmed > 0) {
    return <Badge variant="secondary">{confirmed}/{plan.parcels.length} confirmed</Badge>;
  }
  return <Badge variant="secondary">plan ready</Badge>;
}

// ===== Order detail =====

function OrderDetail({
  order,
  boxes,
  onGeneratePlan,
  generating,
  onConfirmed,
}: {
  order: PackingOrder;
  boxes: BoxOption[];
  onGeneratePlan: () => void;
  generating: boolean;
  onConfirmed: () => void;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-lg">{order.orderNumber}</CardTitle>
              <CardDescription>
                {order.customerName} · {order.shippingServiceLevel} · {order.warehouseStatus}
              </CardDescription>
            </div>
            <PlanStatusBadge plan={order.plan} />
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm font-medium mb-1">Items</p>
          <ul className="text-sm text-muted-foreground space-y-0.5">
            {order.items.map((item, idx) => (
              <li key={`${item.sku}-${idx}`} className="flex justify-between gap-2">
                <span className="truncate">
                  <span className="font-mono">{item.sku}</span> — {item.name}
                </span>
                <span className="shrink-0">×{item.quantity}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {order.plan ? (
        order.plan.parcels.map((parcel) => (
          <ParcelCard
            key={parcel.id}
            planId={order.plan!.id}
            parcel={parcel}
            parcelCount={order.plan!.parcels.length}
            boxes={boxes}
            onConfirmed={onConfirmed}
          />
        ))
      ) : (
        <Card>
          <CardContent className="py-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              No pack plan exists for this order yet.
            </p>
            <Button onClick={onGeneratePlan} disabled={generating}>
              {generating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Generate plan
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ===== Parcel confirmation card =====

function ParcelCard({
  planId,
  parcel,
  parcelCount,
  boxes,
  onConfirmed,
}: {
  planId: number;
  parcel: PackingParcel;
  parcelCount: number;
  boxes: BoxOption[];
  onConfirmed: () => void;
}) {
  const { toast } = useToast();
  const isSioc = parcel.siocProductVariantId != null;
  const predictedLabel = isSioc
    ? `SIOC ${parcel.siocSku ?? `variant ${parcel.siocProductVariantId}`}`
    : `${parcel.boxCode ?? "?"}${parcel.boxName ? ` — ${parcel.boxName}` : ""}`;

  // Default the actual box to the prediction; SIOC parcels have no box to pick.
  const [actualBoxId, setActualBoxId] = useState<string>(
    parcel.actualBoxId != null ? String(parcel.actualBoxId)
      : parcel.boxId != null ? String(parcel.boxId)
      : "none",
  );
  const [actualWeightOz, setActualWeightOz] = useState<string>(
    formatMeasurementInput(parcel.actualWeightGrams, GRAMS_PER_OUNCE),
  );

  const confirmMutation = useMutation({
    mutationFn: (body: { actualBoxId: number | null; actualWeightGrams: number | null }) =>
      postJson(`/api/shipping/packing/plans/${planId}/parcels/${parcel.id}/confirm`, body),
    onSuccess: () => {
      toast({ title: `Parcel ${parcel.parcelSequence} confirmed` });
      onConfirmed();
    },
    onError: (error: Error) => {
      toast({ title: "Confirmation failed", description: error.message, variant: "destructive" });
    },
  });

  const handleConfirm = () => {
    try {
      const weightGrams = toStoredGramsFromOz(actualWeightOz);
      confirmMutation.mutate({
        actualBoxId: actualBoxId === "none" ? null : Number(actualBoxId),
        actualWeightGrams: weightGrams,
      });
    } catch (error) {
      toast({ title: "Invalid input", description: (error as Error).message, variant: "destructive" });
    }
  };

  const confirmed = parcel.packedAt != null;
  const boxMismatch = confirmed && !isSioc && parcel.actualBoxId != null && parcel.actualBoxId !== parcel.boxId;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            Parcel {parcel.parcelSequence}{parcelCount > 1 ? ` of ${parcelCount}` : ""}
          </CardTitle>
          {confirmed && (
            <Badge className="bg-green-600 hover:bg-green-600">
              <CheckCircle2 className="h-3 w-3 mr-1" /> confirmed
            </Badge>
          )}
        </div>
        <CardDescription>
          Predicted: <span className="font-mono">{predictedLabel}</span> · est {formatWeight(parcel.estWeightGrams)}
          {parcel.billableWeightGrams !== parcel.estWeightGrams && (
            <> · billable {formatWeight(parcel.billableWeightGrams)}</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {parcel.items.length > 0 && (
          <ul className="text-sm text-muted-foreground space-y-0.5">
            {parcel.items.map((item) => (
              <li key={item.productVariantId} className="flex justify-between gap-2">
                <span className="truncate">
                  <span className="font-mono">{item.sku ?? item.productVariantId}</span>
                  {item.name ? ` — ${item.name}` : ""}
                  {item.isRider && <Badge variant="outline" className="ml-2">rider</Badge>}
                </span>
                <span className="shrink-0">×{item.quantity}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] items-end">
          <div className="space-y-1">
            <Label>Actual box</Label>
            <Select value={actualBoxId} onValueChange={setActualBoxId}>
              <SelectTrigger>
                <SelectValue placeholder="Select box" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{isSioc ? "Own container (SIOC)" : "No box recorded"}</SelectItem>
                {boxes.map((box) => (
                  <SelectItem key={box.id} value={String(box.id)}>
                    {box.code} — {box.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Actual weight (oz)</Label>
            <Input
              inputMode="decimal"
              placeholder={formatMeasurementInput(parcel.estWeightGrams, GRAMS_PER_OUNCE)}
              value={actualWeightOz}
              onChange={(e) => setActualWeightOz(e.target.value)}
            />
          </div>
          <Button onClick={handleConfirm} disabled={confirmMutation.isPending}>
            {confirmMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirmed ? "Re-confirm" : "Confirm"}
          </Button>
        </div>

        {confirmed && (
          <div className="text-sm space-y-1 rounded-md border p-2 bg-muted/40">
            <p>
              Box:{" "}
              {isSioc && parcel.actualBoxId == null ? (
                <span>own container (as predicted)</span>
              ) : boxMismatch ? (
                <span className="text-amber-600 font-medium">
                  used {boxes.find((b) => b.id === parcel.actualBoxId)?.code ?? `#${parcel.actualBoxId}`} — predicted {parcel.boxCode ?? "—"}
                </span>
              ) : parcel.actualBoxId != null ? (
                <span className="text-green-700">as predicted ({parcel.boxCode})</span>
              ) : (
                <span className="text-muted-foreground">not recorded</span>
              )}
            </p>
            <p>
              Weight:{" "}
              {parcel.actualWeightGrams != null ? (
                <>
                  {formatWeight(parcel.actualWeightGrams)}{" "}
                  {parcel.weightDeltaGrams != null && (
                    <span className={Math.abs(parcel.weightDeltaGrams) > parcel.estWeightGrams * 0.1 ? "text-amber-600" : "text-muted-foreground"}>
                      ({formatWeightDelta(parcel.weightDeltaGrams)} vs est)
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">not recorded</span>
              )}
            </p>
            {parcel.packedBy && (
              <p className="text-xs text-muted-foreground">Confirmed by {parcel.packedBy}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
