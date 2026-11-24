import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InventoryLocationCombobox } from "@/components/inventory/InventoryLocationCombobox";
import { filterActionableWarehouseLocations } from "@/lib/warehouse-locations";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, CheckCircle2, MapPin, Package, ScanBarcode } from "lucide-react";

export interface PutawayQueueItemDto {
  receivingLineId: number;
  receivingOrderId: number;
  receiptNumber: string;
  poNumber: string | null;
  warehouseId: number;
  productId: number | null;
  productVariantId: number;
  sku: string | null;
  barcode: string | null;
  productName: string | null;
  unitsPerVariant: number;
  netReceivedQty: number;
  alreadyPutAwayQty: number;
  remainingQty: number;
  availableOnDockQty: number;
  dockLocationId: number;
  dockLocationCode: string;
  dockLocationType: string | null;
  suggestedLocationId: number | null;
  suggestedLocationCode: string | null;
  suggestedLocationType: string | null;
  suggestionReason:
    | "primary_pick_hungry"
    | "primary_pick_slot"
    | "consolidate_reserve"
    | "empty_reserve"
    | "manual_required";
  closedDate: string | null;
}

interface PutawayWarehouseOption {
  id: number;
  code: string;
  name: string;
}

interface PutawayLocationOption {
  id: number;
  code: string;
  zone: string | null;
  name: string | null;
  warehouseId: number | null;
  locationType?: string | null;
  isActive?: number | null;
}

const SUGGESTION_LABELS: Record<PutawayQueueItemDto["suggestionReason"], string> = {
  primary_pick_hungry: "Hungry Primary Pick",
  primary_pick_slot: "Primary Pick Slot",
  consolidate_reserve: "Consolidate Reserve",
  empty_reserve: "Empty Reserve",
  manual_required: "Choose Destination",
};

export function PutawayQueuePanel({
  warehouses,
  locations,
  canPutaway,
  onOpenReceipt,
}: {
  warehouses: PutawayWarehouseOption[];
  locations: PutawayLocationOption[];
  canPutaway: boolean;
  onOpenReceipt?: (receivingOrderId: number) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [scanInput, setScanInput] = useState("");
  const [selectedLineId, setSelectedLineId] = useState<number | null>(null);
  const [destOverrides, setDestOverrides] = useState<Record<number, number | null>>({});
  const [qtyOverrides, setQtyOverrides] = useState<Record<number, string>>({});
  const [busyLineIds, setBusyLineIds] = useState<Record<number, boolean>>({});

  const queueQuery = useQuery<PutawayQueueItemDto[]>({
    queryKey: ["/api/receiving/putaway-queue", warehouseFilter],
    queryFn: async () => {
      const qs = warehouseFilter !== "all" ? `?warehouseId=${encodeURIComponent(warehouseFilter)}` : "";
      const res = await fetch(`/api/receiving/putaway-queue${qs}`);
      if (!res.ok) throw new Error("Failed to load putaway queue");
      return res.json();
    },
  });

  const items = queueQuery.data ?? [];

  const putawayMutation = useMutation({
    mutationFn: async (vars: {
      receivingLineId: number;
      toLocationId: number;
      qty?: number;
      method: "manual" | "scan";
      reconcileAlreadyMoved?: boolean;
    }) => {
      setBusyLineIds((prev) => ({ ...prev, [vars.receivingLineId]: true }));
      try {
        const res = await fetch(`/api/receiving/lines/${vars.receivingLineId}/putaway`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toLocationId: vars.toLocationId,
            qty: vars.qty,
            method: vars.method,
            reconcileAlreadyMoved: vars.reconcileAlreadyMoved,
          }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(body?.error || "Failed to execute putaway");
        }
        return body as {
          movedQty: number;
          remainingQty: number;
          putawayComplete: number;
          toLocationCode?: string;
        };
      } finally {
        setBusyLineIds((prev) => {
          const next = { ...prev };
          delete next[vars.receivingLineId];
          return next;
        });
      }
    },
    onSuccess: (result, vars) => {
      setQtyOverrides((prev) => {
        const next = { ...prev };
        delete next[vars.receivingLineId];
        return next;
      });
      if (result.putawayComplete === 1) {
        setDestOverrides((prev) => {
          const next = { ...prev };
          delete next[vars.receivingLineId];
          return next;
        });
        if (selectedLineId === vars.receivingLineId) {
          setSelectedLineId(null);
        }
      }
      toast({
        title: result.putawayComplete === 1 ? "Putaway completed" : "Partial putaway moved",
        description:
          result.putawayComplete === 1
            ? `Moved ${result.movedQty} unit(s) to ${result.toLocationCode || "bin"} — ATP & replen updated.`
            : `Moved ${result.movedQty} unit(s) to ${result.toLocationCode || "bin"} (${result.remainingQty} remaining on dock).`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/receiving/putaway-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Putaway failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  function eligiblePutawayDestinations(item: PutawayQueueItemDto): PutawayLocationOption[] {
    return filterActionableWarehouseLocations(locations, { warehouseId: item.warehouseId }).filter(
      (loc) =>
        loc.id !== item.dockLocationId &&
        loc.locationType !== "receiving" &&
        loc.locationType !== "quarantine" &&
        loc.locationType !== "3pl_virtual",
    );
  }

  function effectiveDestinationId(item: PutawayQueueItemDto): number | null {
    if (item.receivingLineId in destOverrides) {
      return destOverrides[item.receivingLineId];
    }
    return item.suggestedLocationId;
  }

  function handleExecuteRow(
    item: PutawayQueueItemDto,
    method: "manual" | "scan",
    overrideLocationId?: number,
    reconcileAlreadyMoved = false,
  ) {
    const toLocationId = overrideLocationId ?? effectiveDestinationId(item);
    if (!toLocationId) {
      toast({
        title: "Destination required",
        description: "Choose or scan a Pick or Reserve bin before completing putaway.",
        variant: "destructive",
      });
      return;
    }
    const rawQty = qtyOverrides[item.receivingLineId];
    const parsedQty = rawQty !== undefined && rawQty.trim() !== "" ? Number(rawQty) : item.remainingQty;
    if (!reconcileAlreadyMoved && (!Number.isInteger(parsedQty) || parsedQty <= 0)) {
      toast({
        title: "Invalid quantity",
        description: "Enter a whole putaway quantity greater than zero.",
        variant: "destructive",
      });
      return;
    }
    putawayMutation.mutate({
      receivingLineId: item.receivingLineId,
      toLocationId,
      qty: reconcileAlreadyMoved ? undefined : parsedQty,
      method,
      reconcileAlreadyMoved,
    });
  }

  function handleScanSubmit(raw: string) {
    const token = raw.trim();
    if (!token) return;
    setScanInput("");
    const upper = token.toUpperCase();

    // 1. If a line is currently selected, check whether the scanned token matches an eligible destination bin
    const activeItem = items.find((it) => it.receivingLineId === selectedLineId);
    if (activeItem) {
      const destBin = eligiblePutawayDestinations(activeItem).find(
        (loc) => loc.code.toUpperCase() === upper,
      );
      if (destBin) {
        setDestOverrides((prev) => ({ ...prev, [activeItem.receivingLineId]: destBin.id }));
        handleExecuteRow(activeItem, "scan", destBin.id, activeItem.availableOnDockQty === 0);
        return;
      }
    }

    // 2. Match against pending dock items by barcode or SKU
    const matchedItem = items.find(
      (it) =>
        (it.barcode && it.barcode.toUpperCase() === upper) ||
        (it.sku && it.sku.toUpperCase() === upper),
    );
    if (matchedItem) {
      setSelectedLineId(matchedItem.receivingLineId);
      const el = document.querySelector(`[data-testid="putaway-row-${matchedItem.receivingLineId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      toast({
        title: `Selected ${matchedItem.sku || matchedItem.productName}`,
        description: matchedItem.suggestedLocationCode
          ? `Suggested bin: ${matchedItem.suggestedLocationCode}. Scan bin barcode or tap Put Away.`
          : "Scan or choose a destination bin to complete putaway.",
      });
      return;
    }

    // 3. If only 1 item is in queue, check if user scanned a destination bin directly
    if (items.length === 1) {
      const sole = items[0];
      const destBin = eligiblePutawayDestinations(sole).find((loc) => loc.code.toUpperCase() === upper);
      if (destBin) {
        setDestOverrides((prev) => ({ ...prev, [sole.receivingLineId]: destBin.id }));
        handleExecuteRow(sole, "scan", destBin.id, sole.availableOnDockQty === 0);
        return;
      }
    }

    toast({
      title: "Scan not matched",
      description: `No pending dock item or destination bin matched "${token}".`,
      variant: "destructive",
    });
  }

  return (
    <div className="space-y-4" data-testid="putaway-queue-panel">
      <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center justify-between">
        <div className="flex items-center gap-2">
          <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
            <SelectTrigger className="w-48 h-10" data-testid="select-putaway-warehouse">
              <SelectValue placeholder="All Warehouses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Warehouses</SelectItem>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={String(w.id)}>
                  {w.name} ({w.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge variant="secondary" className="text-xs">
            {items.length} awaiting putaway
          </Badge>
        </div>

        <form
          className="flex flex-1 max-w-md items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleScanSubmit(scanInput);
          }}
        >
          <div className="relative flex-1">
            <ScanBarcode className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              placeholder="Optional: scan SKU/barcode, then scan destination bin..."
              className="pl-9 h-10 text-sm"
              autoComplete="off"
              disabled={!canPutaway}
              data-testid="input-putaway-scan"
            />
          </div>
          <Button type="submit" variant="outline" className="h-10" disabled={!canPutaway || !scanInput.trim()}>
            Scan
          </Button>
        </form>
      </div>

      {queueQuery.isPending && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            Loading directed putaway queue…
          </CardContent>
        </Card>
      )}

      {queueQuery.isSuccess && items.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto" />
            <p className="font-medium">Receiving dock is clear</p>
            <p className="text-xs text-muted-foreground">
              All closed receipt lines have been put away into Pick or Reserve bins.
            </p>
          </CardContent>
        </Card>
      )}

      {items.length > 0 && (
        <div className="space-y-3">
          {items.map((item) => {
            const isSelected = selectedLineId === item.receivingLineId;
            const isBusy = !!busyLineIds[item.receivingLineId];
            const destId = effectiveDestinationId(item);
            const destOptions = eligiblePutawayDestinations(item);
            const qtyVal = qtyOverrides[item.receivingLineId] ?? String(Math.min(item.remainingQty, Math.max(1, item.availableOnDockQty || item.remainingQty)));
            const alreadyMovedOffDock = item.availableOnDockQty === 0;

            return (
              <Card
                key={item.receivingLineId}
                data-testid={`putaway-row-${item.receivingLineId}`}
                onClick={() => setSelectedLineId(item.receivingLineId)}
                className={isSelected ? "ring-2 ring-primary border-primary" : ""}
              >
                <CardHeader className="p-3 pb-2 flex flex-row items-start justify-between gap-2 space-y-0">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-sm font-semibold">
                        {item.productName || item.sku || `Variant #${item.productVariantId}`}
                      </CardTitle>
                      <Badge variant="outline" className="font-mono text-xs">
                        {item.sku || `VAR-${item.productVariantId}`}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        {item.unitsPerVariant > 1 ? `Pack of ${item.unitsPerVariant}` : "Each"}
                      </Badge>
                    </div>
                    <CardDescription className="text-xs mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {onOpenReceipt ? (
                        <button
                          type="button"
                          className="text-primary underline font-mono"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenReceipt(item.receivingOrderId);
                          }}
                        >
                          {item.receiptNumber}
                        </button>
                      ) : (
                        <span className="font-mono">{item.receiptNumber}</span>
                      )}
                      {item.poNumber && <span>PO {item.poNumber}</span>}
                      <span className="inline-flex items-center gap-1 font-medium text-foreground">
                        <Package className="h-3.5 w-3.5" />
                        From {item.dockLocationCode}: {item.remainingQty} remaining
                      </span>
                    </CardDescription>
                  </div>
                  <Badge
                    variant={item.suggestionReason === "primary_pick_hungry" ? "default" : "outline"}
                    className="shrink-0 text-xs"
                  >
                    <MapPin className="h-3 w-3 mr-1" />
                    {SUGGESTION_LABELS[item.suggestionReason]}
                    {item.suggestedLocationCode ? `: ${item.suggestedLocationCode}` : ""}
                  </Badge>
                </CardHeader>
                <CardContent className="p-3 pt-1">
                  <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_120px_auto] gap-2 items-end">
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                        Destination Bin (Pick / Reserve)
                      </label>
                      <InventoryLocationCombobox
                        locations={destOptions}
                        value={destId}
                        onValueChange={(val) =>
                          setDestOverrides((prev) => ({ ...prev, [item.receivingLineId]: val }))
                        }
                        ariaLabel={`Putaway destination for line ${item.receivingLineId}`}
                        disabled={!canPutaway || isBusy}
                        placeholder="Choose Pick or Reserve bin..."
                        searchPlaceholder="Search bins..."
                        emptyMessage="No eligible Pick or Reserve bins found."
                        allowClear
                        triggerClassName="min-h-11 w-full"
                        contentClassName="w-72 max-w-[calc(100vw-2rem)]"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground block mb-1">
                        Putaway Qty
                      </label>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={item.remainingQty}
                        value={qtyVal}
                        disabled={!canPutaway || isBusy || alreadyMovedOffDock}
                        onChange={(e) =>
                          setQtyOverrides((prev) => ({ ...prev, [item.receivingLineId]: e.target.value }))
                        }
                        aria-label={`Putaway quantity for line ${item.receivingLineId}`}
                        className="min-h-11 tabular-nums"
                      />
                    </div>
                    <div className="flex gap-2">
                      {alreadyMovedOffDock ? (
                        <Button
                          className="min-h-11 w-full md:w-auto"
                          variant="outline"
                          disabled={!canPutaway || isBusy || !destId}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleExecuteRow(item, "manual", undefined, true);
                          }}
                          data-testid={`btn-reconcile-putaway-${item.receivingLineId}`}
                        >
                          {isBusy ? "Saving…" : "Mark Put Away (Moved)"}
                        </Button>
                      ) : (
                        <Button
                          className="min-h-11 w-full md:w-auto"
                          disabled={!canPutaway || isBusy || !destId}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleExecuteRow(item, "manual");
                          }}
                          data-testid={`btn-execute-putaway-${item.receivingLineId}`}
                        >
                          <ArrowRight className="h-4 w-4 mr-1.5" />
                          {isBusy
                            ? "Moving…"
                            : `Put Away${
                                destId
                                  ? ` → ${destOptions.find((l) => l.id === destId)?.code ?? "Bin"}`
                                  : ""
                              }`}
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
