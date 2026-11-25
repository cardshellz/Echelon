import { useState, useEffect, useMemo } from "react";
import { useInventoryCommand } from "@/lib/inventory-command";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowRight, ArrowLeftRight, Undo2, Check, ChevronLeft, ChevronRight, Search, Package, MapPin, ScanLine, Loader2, X, AlertTriangle, Boxes } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";
import { playSoundWithHaptic } from "@/lib/sounds";
import { filterActionableWarehouseLocations } from "@/lib/warehouse-locations";
import { InterwarehouseTransferQueue } from "@/components/inventory/InterwarehouseTransferQueue";
import InlineCaseBreakDialog from "@/components/operations/InlineCaseBreakDialog";

interface Transfer {
  id: number;
  fromLocation: string;
  toLocation: string;
  sku: string;
  productName: string;
  quantity: number;
  userId: string;
  createdAt: string;
  canUndo: boolean;
}

interface WarehouseLocation {
  id: number;
  code: string;
  zone?: string;
  locationType?: string;
  warehouseId?: number;
  isActive?: number;
  name?: string | null;
}

interface Warehouse {
  id: number;
  code: string;
  name: string;
}

interface SkuResult {
  sku: string;
  name: string;
  variantId: number;
  barcode?: string | null;
  productId?: number | null;
  unitsPerVariant?: number;
  available: number;
  onHand?: number;
  reserved?: number;
  locationId?: number;
  location?: string;
  primaryPickLocationId?: number | null;
  primaryPickLocationCode?: string | null;
  breakTargetVariantId?: number | null;
  breakTargetSku?: string | null;
  breakOutputQty?: number | null;
}

function stockSummary(stock: { available: number; onHand?: number; reserved?: number }): string {
  return stock.onHand == null || stock.reserved == null ? `${stock.available} available`
    : `${stock.onHand} on hand · ${stock.reserved} reserved · ${stock.available} available`;
}
function suggestedTransferQuantity(stock: { available: number; onHand?: number }): number {
  return stock.available > 0 ? stock.available : Math.min(1,stock.onHand ?? 0);
}

type MobileStep = "source" | "sku" | "quantity" | "destination" | "confirm";

export default function Transfers() {
  const inventoryCommand = useInventoryCommand();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isMobile, setIsMobile] = useState(false);
  
  // Desktop form state
  const [fromLocationId, setFromLocationId] = useState<number | null>(null);
  const [toLocationId, setToLocationId] = useState<number | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [selectedSkuLabel, setSelectedSkuLabel] = useState("");
  const [selectedSkuAvailable, setSelectedSkuAvailable] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [skuFilter, setSkuFilter] = useState("");
  // When a transfer is blocked because the source bin holds reserved stock,
  // we stash the original request + context here to drive a confirm dialog that
  // re-fires the transfer with moveReserved: true.
  const [reservationPrompt, setReservationPrompt] = useState<
    | {
        payload: { fromLocationId: number; toLocationId: number; variantId: number; quantity: number; notes?: string };
        needed: number;
        onHandAtSource: number;
        availableAtSource: number;
        reservedAtSource: number;
        sourceCode: string;
        destCode: string;
      }
    | null
  >(null);
  const [locationSearch, setLocationSearch] = useState("");
  const [destLocationSearch, setDestLocationSearch] = useState("");
  
  // SKU Lookup modal state
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupSearch, setLookupSearch] = useState("");
  const [transferTab, setTransferTab] = useState<"move" | "case_break">("move");
  const [caseBreakOpen, setCaseBreakOpen] = useState(false);
  
  // Mobile wizard state
  const [mobileStep, setMobileStep] = useState<MobileStep>("source");
  const [sourceLocationCode, setSourceLocationCode] = useState("");
  const [destLocationCode, setDestLocationCode] = useState("");
  const [selectedSku, setSelectedSku] = useState<SkuResult | null>(null);
  const [mobileQuantity, setMobileQuantity] = useState("");
  
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const { data: transfers = [], isLoading: transfersLoading } = useQuery<Transfer[]>({
    queryKey: ["/api/inventory/transfers"],
    refetchInterval: 10000
  });

  const { data: locations = [] } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/warehouse/locations"]
  });

  const actionableLocations = useMemo(
    () => filterActionableWarehouseLocations(locations),
    [locations],
  );

  // Cycle count context (passed via URL params when coming from cycle count Transfer button)
  const [cycleCountCtx, setCycleCountCtx] = useState<{ ccId: number; ccItemId: number } | null>(null);

  // Pre-fill from URL query params (e.g. from cycle count Transfer button)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromCode = params.get("from");
    const qty = params.get("qty");
    const ccId = params.get("ccId");
    const ccItemId = params.get("ccItemId");
    if (!fromCode || actionableLocations.length === 0) return;

    const loc = actionableLocations.find(l => l.code === fromCode);
    if (!loc) return;

    // Store cycle count context before clearing URL
    if (ccId && ccItemId) {
      setCycleCountCtx({ ccId: parseInt(ccId), ccItemId: parseInt(ccItemId) });
    }

    // Only apply once — clear the URL params after applying
    window.history.replaceState({}, "", window.location.pathname);

    if (isMobile) {
      setSourceLocationCode(fromCode);
      setFromLocationId(loc.id);
      if (qty) setMobileQuantity(qty);
      setMobileStep("sku");
    } else {
      setFromLocationId(loc.id);
      setLocationSearch(fromCode);
      if (qty) setQuantity(qty);
    }
  }, [actionableLocations, isMobile]);

  const { data: warehouses = [] } = useQuery<Warehouse[]>({
    queryKey: ["/api/warehouses"]
  });

  const warehouseMap = new Map(warehouses.map(w => [w.id, w.code]));
  const selectedFromLocation = locations.find((location) => location.id === fromLocationId);
  const selectedToLocation = locations.find((location) => location.id === toLocationId);
  const isCrossWarehouse = selectedFromLocation?.warehouseId != null
    && selectedToLocation?.warehouseId != null
    && selectedFromLocation.warehouseId !== selectedToLocation.warehouseId;
  const normalizedSourceCode = sourceLocationCode.trim().toUpperCase();
  const sourceExactMatches = actionableLocations.filter(
    (location) => location.code.trim().toUpperCase() === normalizedSourceCode,
  );
  const sourceSelectionMatchesInput = !!selectedFromLocation
    && selectedFromLocation.code.trim().toUpperCase() === normalizedSourceCode;
  const destinationCandidates = actionableLocations.filter((location) => location.id !== fromLocationId);
  const normalizedDestinationCode = destLocationCode.trim().toUpperCase();
  const destinationExactMatches = destinationCandidates.filter(
    (location) => location.code.trim().toUpperCase() === normalizedDestinationCode,
  );
  const destinationSelectionMatchesInput = !!selectedToLocation
    && selectedToLocation.id !== fromLocationId
    && selectedToLocation.code.trim().toUpperCase() === normalizedDestinationCode;
  
  const serverSkuQuery = skuFilter.trim().length >= 2 ? skuFilter.trim() : "";
  const { data: skusAtLocation = [] } = useQuery<SkuResult[]>({
    queryKey: ["/api/inventory/skus/search", "location", fromLocationId, serverSkuQuery],
    queryFn: async () => {
      if (!fromLocationId) return [];
      const qs = new URLSearchParams({ locationId: String(fromLocationId), limit: "500" });
      if (serverSkuQuery) qs.set("q", serverSkuQuery);
      const res = await fetch(`/api/inventory/skus/search?${qs.toString()}`);
      return res.json();
    },
    enabled: !!fromLocationId
  });

  useEffect(() => {
    if (skusAtLocation && skusAtLocation.length === 1 && !variantId && !skuFilter.trim()) {
      const result = skusAtLocation[0];
      setSelectedSkuLabel(result.sku);
      setVariantId(result.variantId);
      setSelectedSkuAvailable(result.available);
      if (!quantity) {
        setQuantity(String(suggestedTransferQuantity(result)));
      }
    }
  }, [skusAtLocation, variantId, quantity, skuFilter]);
  const currentSelectedStock = skusAtLocation.find(row => row.variantId === variantId) ?? selectedSku ?? undefined;
  const activePrimaryPickLocationId =
    currentSelectedStock?.primaryPickLocationId && currentSelectedStock.primaryPickLocationId !== fromLocationId
      ? currentSelectedStock.primaryPickLocationId
      : null;
  const activePrimaryPickLocationCode =
    activePrimaryPickLocationId
      ? currentSelectedStock?.primaryPickLocationCode ?? locations.find(l => l.id === activePrimaryPickLocationId)?.code ?? null
      : null;
  const canBreakSelectedSku = Boolean(
    fromLocationId &&
    currentSelectedStock &&
    Number(currentSelectedStock.unitsPerVariant ?? 1) > 1 &&
    currentSelectedStock.breakTargetVariantId &&
    currentSelectedStock.breakTargetSku &&
    Number(currentSelectedStock.breakOutputQty ?? 0) > 0,
  );
  useEffect(() => {
    if (currentSelectedStock && currentSelectedStock.variantId === variantId) {
      setSelectedSkuAvailable(currentSelectedStock.available);
      setSelectedSku(previous => previous?.variantId === currentSelectedStock.variantId ? currentSelectedStock : previous);
    }
  }, [currentSelectedStock, variantId]);
  
  const { data: lookupResults = [] } = useQuery<Array<{
    sku: string;
    name: string;
    variantId: number;
    barcode?: string | null;
    location: string;
    zone: string | null;
    locationType: string | null;
    available: number;
    onHand?: number;
    reserved?: number;
    locationId: number;
    warehouseCode: string | null;
  }>>({
    queryKey: ["/api/inventory/sku-locations", lookupSearch],
    queryFn: async () => {
      if (!lookupSearch || lookupSearch.length < 2) return [];
      const res = await fetch(`/api/inventory/sku-locations?q=${encodeURIComponent(lookupSearch)}`);
      return res.json();
    },
    enabled: lookupOpen && lookupSearch.length >= 2
  });
  
  const transferMutation = useMutation({
    mutationFn: async (data: { fromLocationId: number; toLocationId: number; variantId: number; quantity: number; notes?: string; moveReserved?: boolean }) => {
      const source = locations.find((location) => location.id === data.fromLocationId);
      const destination = locations.find((location) => location.id === data.toLocationId);
      const crossWarehouse = source?.warehouseId != null && destination?.warehouseId != null
        && source.warehouseId !== destination.warehouseId;
      return inventoryCommand(crossWarehouse
        ? "/api/inventory/interwarehouse-transfers"
        : "/api/inventory/transfer", data);
    },
    onSuccess: async (transferResult: any) => {
      playSoundWithHaptic("success", "classic", true);
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/transfers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/levels"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/skus/search"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/sku-locations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/by-bin"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/interwarehouse-transfers"] });

      // If this transfer came from a cycle count, sync the expected qty
      if (cycleCountCtx) {
        try {
          const res = await fetch(`/api/cycle-counts/${cycleCountCtx.ccId}/items/${cycleCountCtx.ccItemId}/sync-expected`, {
            method: "POST",
            credentials: "include",
          });
          const result = await res.json();
          if (result.autoResolved) {
            toast({ title: "Transfer Complete & Cycle Count Resolved", description: "Variance resolved — expected now matches counted." });
          } else {
            toast({ title: "Transfer Complete & Cycle Count Updated", description: `Expected qty updated. Remaining variance: ${result.newVarianceQty}` });
          }
          setCycleCountCtx(null);
        } catch {
          toast({ title: "Transfer Complete", description: "Inventory moved, but failed to update cycle count. Sync manually." });
        }
      } else if (transferResult?.transferNumber) {
        toast({
          title: "Warehouse Transfer Dispatched",
          description: `${transferResult.transferNumber} is in transit. Destination stock will update only when it is received.`,
        });
      } else if (transferResult?.reservedMoved > 0) {
        toast({
          title: "Transfer Complete",
          description:
            `Inventory moved. ${transferResult.reservedMoved} reserved unit(s) followed the stock` +
            (transferResult.orderItemsRepointed > 0
              ? `; ${transferResult.orderItemsRepointed} pending order line(s) re-pointed to the new bin.`
              : "."),
        });
      } else {
        toast({ title: "Transfer Complete", description: "Inventory moved successfully" });
      }
      resetForm();
    },
    onError: (error: any, variables) => {
      queryClient.invalidateQueries({queryKey:["/api/inventory/skus/search"]});
      // Reserved stock blocks the transfer: offer to move the reservation too
      // (Option A) instead of dead-ending. Re-fires with moveReserved: true.
      const context = error?.context ?? error?.responseBody?.context;
      const source = locations.find((location) => location.id === variables.fromLocationId);
      const destination = locations.find((location) => location.id === variables.toLocationId);
      const crossWarehouseRequest = source?.warehouseId != null && destination?.warehouseId != null
        && source.warehouseId !== destination.warehouseId;
      if (error?.code === "TRANSFER_BLOCKED_BY_RESERVATION" && context) {
        if (crossWarehouseRequest) {
          toast({
            title: "Reserved stock cannot be dispatched",
            description: `Only ${context.availableAtSource ?? 0} unreserved unit(s) are available at the source. Release or reallocate the open-order reservation before shipping more to another warehouse.`,
            variant: "destructive",
          });
          return;
        }
        setReservationPrompt({ payload: variables, ...context });
        return;
      }
      // Fallback: if a cached client bundle routes through apiRequest's
      // throwIfResNotOk, the error message is "409: {json}" — parse it.
      if (error?.message?.includes("TRANSFER_BLOCKED_BY_RESERVATION")) {
        try {
          const body = JSON.parse(error.message.replace(/^\d+:\s*/, ""));
          if (body.context) {
            if (crossWarehouseRequest) {
              toast({
                title: "Reserved stock cannot be dispatched",
                description: `Only ${body.context.availableAtSource ?? 0} unreserved unit(s) are available at the source. Release or reallocate the open-order reservation before shipping more to another warehouse.`,
                variant: "destructive",
              });
              return;
            }
            setReservationPrompt({ payload: variables, ...body.context });
            return;
          }
        } catch { /* fall through to generic toast */ }
      }
      playSoundWithHaptic("error", "classic", true);
      toast({ title: "Transfer Failed", description: error.message, variant: "destructive" });
    }
  });

  const undoMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/inventory/transfer/${id}/undo`, {});
      return res.json();
    },
    onSuccess: () => {
      playSoundWithHaptic("success", "classic", true);
      toast({ title: "Transfer Undone", description: "Inventory restored to original location" });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/transfers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/levels"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/skus/search"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/sku-locations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/by-bin"] });
    },
    onError: (error: Error) => {
      toast({ title: "Undo Failed", description: error.message, variant: "destructive" });
    }
  });
  
  const resetForm = () => {
    setFromLocationId(null);
    setToLocationId(null);
    setVariantId(null);
    setSelectedSkuLabel("");
    setSelectedSkuAvailable(null);
    setQuantity("");
    setNotes("");
    setSkuFilter("");
    setLocationSearch("");
    setDestLocationSearch("");
    setMobileStep("source");
    setSourceLocationCode("");
    setDestLocationCode("");
    setSelectedSku(null);
    setMobileQuantity("");
  };
  
  const filteredLocations = filterActionableWarehouseLocations(locations, { search: locationSearch });
  
  const filteredDestLocations = filterActionableWarehouseLocations(locations, {
    search: destLocationSearch,
    excludeId: fromLocationId,
  });
  
  const handleDesktopSubmit = () => {
    if (!fromLocationId || !toLocationId || !variantId || !quantity) {
      toast({ title: "Missing Fields", description: "Please fill all required fields", variant: "destructive" });
      return;
    }
    transferMutation.mutate({
      fromLocationId,
      toLocationId,
      variantId,
      quantity: parseInt(quantity),
      notes: notes || undefined
    });
  };
  
  const handleMobileSubmit = () => {
    const sourceLoc = actionableLocations.find(l => l.id === fromLocationId && l.code.trim().toUpperCase() === normalizedSourceCode);
    const destLoc = actionableLocations.find(l => l.id === toLocationId && l.code.trim().toUpperCase() === normalizedDestinationCode);
    const parsedQuantity = Number(mobileQuantity);
    
    if (!sourceLoc || !destLoc || sourceLoc.id === destLoc.id || !selectedSku || !Number.isSafeInteger(parsedQuantity) || parsedQuantity <= 0) {
      toast({ title: "Transfer needs attention", description: "Re-select the source, destination, SKU, and quantity before submitting.", variant: "destructive" });
      return;
    }
    
    transferMutation.mutate({
      fromLocationId: sourceLoc.id,
      toLocationId: destLoc.id,
      variantId: selectedSku.variantId,
      quantity: parsedQuantity
    });
  };
  
  // One confirmation contract for both desktop and the mobile transfer wizard.
  const reservationDialog = (
    <Dialog open={!!reservationPrompt} onOpenChange={(open) => { if (!open) setReservationPrompt(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Reserved stock at {reservationPrompt?.sourceCode}
          </DialogTitle>
        </DialogHeader>
        {reservationPrompt && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              You're moving <span className="font-semibold">{reservationPrompt.needed}</span> unit(s) from{" "}
              <span className="font-semibold">{reservationPrompt.sourceCode}</span> to{" "}
              <span className="font-semibold">{reservationPrompt.destCode}</span>, but only{" "}
              <span className="font-semibold">{reservationPrompt.availableAtSource}</span> are free —{" "}
              <span className="font-semibold">{reservationPrompt.reservedAtSource}</span> are reserved for open orders.
            </p>
            <p className="text-sm text-muted-foreground">
              Move the reserved stock too? Complete unpicked order lines and their reservations will move to{" "}
              <span className="font-semibold">{reservationPrompt.destCode}</span>. Orders already being picked at this bin
              must be finished or cancelled first.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                onClick={() => setReservationPrompt(null)}
                disabled={transferMutation.isPending}
                data-testid="button-cancel-move-reserved"
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const payload = reservationPrompt.payload;
                  setReservationPrompt(null);
                  transferMutation.mutate({ ...payload, moveReserved: true });
                }}
                disabled={transferMutation.isPending}
                data-testid="button-confirm-move-reserved"
              >
                {transferMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <ArrowRight className="h-4 w-4 mr-2" />
                )}
                Move reserved too
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );

  const caseBreakModal = (
    <InlineCaseBreakDialog
      open={caseBreakOpen}
      onOpenChange={setCaseBreakOpen}
      defaultFromLocationId={fromLocationId ?? undefined}
      defaultFromLocationCode={selectedFromLocation?.code ?? sourceLocationCode}
      sourceVariantId={currentSelectedStock?.variantId ?? variantId ?? undefined}
      sourceSku={currentSelectedStock?.sku ?? selectedSkuLabel}
      pickVariantId={currentSelectedStock?.breakTargetVariantId ?? undefined}
      pickSku={currentSelectedStock?.breakTargetSku ?? undefined}
      conversionInputQty={1}
      conversionOutputQty={currentSelectedStock?.breakOutputQty ?? 0}
    />
  );

  const lookupDialog = (
    <Dialog open={lookupOpen} onOpenChange={(open) => { setLookupOpen(open); if (!open) setLookupSearch(""); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            SKU / Barcode Lookup
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={lookupSearch}
              onChange={(e) => setLookupSearch(e.target.value)}
              placeholder="Search or scan SKU, barcode, or name..."
              className="pl-10"
              autoFocus
              data-testid="input-lookup-search"
            />
          </div>

          {lookupSearch.length >= 2 && lookupResults.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No inventory found for this SKU</p>
          )}

          {lookupResults.length > 0 && (
            <div className="border rounded-md max-h-80 overflow-y-auto">
              <div className="grid grid-cols-[auto_1fr_auto_auto] gap-2 px-3 py-2 bg-slate-50 border-b text-xs font-medium text-muted-foreground sticky top-0">
                <span>WH</span>
                <span>Location</span>
                <span>Type</span>
                <span className="text-right">Stock</span>
              </div>
              {(() => {
                const grouped = lookupResults.reduce((acc, r) => {
                  if (!acc[r.sku]) acc[r.sku] = { name: r.name, locations: [] };
                  acc[r.sku].locations.push(r);
                  return acc;
                }, {} as Record<string, { name: string; locations: typeof lookupResults }>);

                return Object.entries(grouped).map(([sku, data]) => (
                  <div key={sku}>
                    <div className="px-3 py-2 bg-slate-50/50 border-b">
                      <div className="font-medium text-sm font-mono">{sku}</div>
                      <div className="text-xs text-muted-foreground truncate">{data.name}</div>
                      <div className="text-xs font-medium text-blue-600">
                        Available: {data.locations.reduce((sum, l) => sum + Number(l.available), 0)} units across {data.locations.length} location{data.locations.length !== 1 ? "s" : ""}
                      </div>
                    </div>
                    {data.locations.map((loc) => (
                      <button
                        key={`${sku}-${loc.locationId}`}
                        type="button"
                        onClick={() => {
                          const qtyStr = String(suggestedTransferQuantity({ available: Number(loc.available), onHand: loc.onHand != null ? Number(loc.onHand) : undefined }));
                          setFromLocationId(Number(loc.locationId));
                          setLocationSearch(loc.location);
                          setSourceLocationCode(loc.location.toUpperCase());
                          setVariantId(Number(loc.variantId));
                          setSelectedSkuLabel(sku);
                          setSelectedSkuAvailable(Number(loc.available));
                          setSelectedSku({
                            sku,
                            name: loc.name,
                            variantId: Number(loc.variantId),
                            available: Number(loc.available),
                            onHand: loc.onHand != null ? Number(loc.onHand) : undefined,
                            reserved: loc.reserved != null ? Number(loc.reserved) : undefined,
                            locationId: Number(loc.locationId),
                            location: loc.location,
                          });
                          setQuantity(qtyStr);
                          setMobileQuantity(qtyStr);
                          if (isMobile) setMobileStep("quantity");
                          setLookupOpen(false);
                          setLookupSearch("");
                          playSoundWithHaptic("success", "classic", true);
                        }}
                        className="w-full text-left grid grid-cols-[auto_1fr_auto_auto] gap-2 px-3 py-2.5 border-b last:border-b-0 text-sm items-center hover:bg-blue-50/60 transition-colors cursor-pointer"
                        data-testid={`lookup-row-${sku}-${loc.locationId}`}
                      >
                        <Badge variant="secondary" className="text-xs">{loc.warehouseCode || "—"}</Badge>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <MapPin className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                          <span className="font-medium font-mono">{loc.location}</span>
                          {loc.zone && <span className="text-xs text-muted-foreground">({loc.zone})</span>}
                        </div>
                        <Badge variant="outline" className="text-xs">{loc.locationType || "N/A"}</Badge>
                        <div className="text-right">
                          <div className="font-medium text-green-700">{loc.available} avail</div>
                          {loc.onHand != null && (
                            <div className="text-[11px] text-muted-foreground">
                              {loc.onHand} OH · {loc.reserved ?? 0} res
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                ));
              })()}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Click any location row to pre-fill the transfer form with that source bin and SKU.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );

  if (isMobile) {
    return (
      <div className="min-h-screen bg-slate-50 p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" />
            Transfer
          </h1>
          <Badge variant="outline">{mobileStep}</Badge>
        </div>
        
        <Card className="mb-4">
          <CardContent className="pt-4">
            {mobileStep === "source" && (
              <div className="space-y-4">
                <Label className="text-lg font-semibold">Scan Source Bin</Label>
                <p className="text-sm text-muted-foreground">Scan or enter the bin you're moving FROM</p>
                <div className="relative">
                  <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    value={sourceLocationCode}
                    onChange={(e) => {
                      setSourceLocationCode(e.target.value.toUpperCase());
                      setFromLocationId(null);
                      setSelectedSku(null);
                      setVariantId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && sourceExactMatches.length === 1) {
                        e.preventDefault();
                        const loc = sourceExactMatches[0];
                        setSourceLocationCode(loc.code.toUpperCase());
                        setFromLocationId(loc.id);
                        playSoundWithHaptic("scan", "classic", true);
                        setMobileStep("sku");
                      }
                    }}
                    placeholder="A-01-01"
                    className="pl-10 h-14 text-xl text-center uppercase"
                    autoFocus
                    data-testid="input-source-location"
                  />
                </div>
                {normalizedSourceCode && !sourceSelectionMatchesInput && sourceExactMatches.length !== 1 && (
                  <div className="border rounded-md max-h-48 overflow-y-auto">
                    {actionableLocations
                      .filter(loc => loc.code.toUpperCase().includes(normalizedSourceCode))
                      .slice(0, 10)
                      .map(loc => (
                        <button
                          key={loc.id}
                          type="button"
                          className="w-full px-4 py-3 text-left hover:bg-slate-100 border-b last:border-b-0 text-base"
                          onClick={() => {
                            setSourceLocationCode(loc.code.toUpperCase());
                            setFromLocationId(loc.id);
                            playSoundWithHaptic("scan", "classic", true);
                            setMobileStep("sku");
                          }}
                        >
                          <span className="font-medium">{loc.code}</span>
                          <span className="text-sm text-muted-foreground ml-2">
                            {loc.warehouseId ? warehouseMap.get(loc.warehouseId) || '' : ''}{loc.zone ? ` · ${loc.zone}` : ''}{loc.locationType ? ` · ${loc.locationType}` : ''}
                          </span>
                        </button>
                      ))}
                    {actionableLocations.filter(loc => loc.code.toUpperCase().includes(normalizedSourceCode)).length === 0 && (
                      <p className="px-4 py-3 text-sm text-muted-foreground">No matching bins</p>
                    )}
                  </div>
                )}
                <Button
                  className="w-full h-14 text-lg"
                  disabled={!normalizedSourceCode || (!sourceSelectionMatchesInput && sourceExactMatches.length !== 1)}
                  onClick={() => {
                    const loc = sourceSelectionMatchesInput ? selectedFromLocation : sourceExactMatches[0];
                    if (loc) {
                      setFromLocationId(loc.id);
                      playSoundWithHaptic("scan", "classic", true);
                      setMobileStep("sku");
                    }
                  }}
                  data-testid="button-next-source"
                >
                  <ChevronRight className="h-5 w-5 mr-2" />
                  Next
                </Button>
              </div>
            )}
            
            {mobileStep === "sku" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-lg font-semibold">Select SKU</Label>
                  <Button variant="ghost" size="sm" onClick={() => setMobileStep("source")}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">Items in bin {sourceLocationCode}:</p>
                
                <div className="relative">
                  <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={skuFilter}
                    onChange={(e) => setSkuFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && skuFilter.trim()) {
                        e.preventDefault();
                        const token = skuFilter.trim().toLowerCase();
                        const exact = skusAtLocation.find(
                          (it) =>
                            it.sku.toLowerCase() === token ||
                            (it.barcode && it.barcode.toLowerCase() === token),
                        );
                        if (exact) {
                          setSelectedSku(exact);
                          setVariantId(exact.variantId);
                          setMobileQuantity(String(suggestedTransferQuantity(exact)));
                          setSkuFilter("");
                          playSoundWithHaptic("scan", "classic", true);
                          setMobileStep("quantity");
                        }
                      }
                    }}
                    placeholder="Scan barcode or search SKUs in this bin..."
                    className="pl-9 h-12"
                    data-testid="input-filter-sku"
                  />
                </div>
                
                <div className="max-h-[300px] overflow-y-auto space-y-2">
                  {skusAtLocation
                    .filter(
                      item =>
                        !skuFilter ||
                        item.sku.toLowerCase().includes(skuFilter.toLowerCase()) ||
                        item.name.toLowerCase().includes(skuFilter.toLowerCase()) ||
                        Boolean(item.barcode && item.barcode.toLowerCase().includes(skuFilter.toLowerCase())),
                    )
                    .map((item) => (
                    <button
                      key={item.sku}
                      type="button"
                      className={`w-full p-3 text-left rounded-lg border transition-colors ${
                        selectedSku?.sku === item.sku 
                          ? "border-primary bg-primary/10" 
                          : "border-slate-200 hover:bg-slate-50"
                      }`}
                      onClick={() => {
                        setSelectedSku(item);
                        setVariantId(item.variantId);
                        playSoundWithHaptic("success", "classic", true);
                      }}
                      data-testid={`button-select-sku-${item.sku}`}
                    >
                      <div className="font-medium">{item.sku}</div>
                      <div className="text-sm text-muted-foreground truncate">{item.name}</div>
                      <div className="text-sm text-green-600">{stockSummary(item)}</div>
                    </button>
                  ))}
                  {skusAtLocation.length === 0 && (
                    <p className="text-center text-muted-foreground py-4">No items in this bin</p>
                  )}
                </div>
                
                <Button
                  className="w-full h-14 text-lg"
                  disabled={!selectedSku}
                  onClick={() => {
                    playSoundWithHaptic("success", "classic", true);
                    if (selectedSku) setMobileQuantity(String(suggestedTransferQuantity(selectedSku)));
                    setMobileStep("quantity");
                  }}
                  data-testid="button-next-sku"
                >
                  <ChevronRight className="h-5 w-5 mr-2" />
                  Next
                </Button>
              </div>
            )}
            
            {mobileStep === "quantity" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-lg font-semibold">Enter Quantity</Label>
                  <Button variant="ghost" size="sm" onClick={() => setMobileStep("sku")}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                </div>
                <div className="bg-slate-100 rounded-lg p-3">
                  <p className="font-medium">{selectedSku?.sku}</p>
                  <p className="text-sm text-muted-foreground">{selectedSku?.name}</p>
                  <p className="text-sm text-green-600">{selectedSku ? stockSummary(selectedSku) : ""}</p>
                </div>
                
                <Input
                  type="number"
                  value={mobileQuantity}
                  onChange={(e) => setMobileQuantity(e.target.value)}
                  placeholder="0"
                  className="h-20 text-4xl text-center"
                  max={selectedSku?.onHand ?? selectedSku?.available}
                  min={1}
                  autoFocus
                  data-testid="input-quantity"
                />
                
                <div className="grid grid-cols-3 gap-2">
                  {[1, 5, 10].map(n => (
                    <Button
                      key={n}
                      variant="outline"
                      onClick={() => setMobileQuantity(String(Math.min(n, selectedSku?.onHand ?? selectedSku?.available ?? n)))}
                    >
                      {n}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    className="col-span-3"
                    onClick={() => setMobileQuantity(String(selectedSku?.onHand ?? selectedSku?.available ?? 0))}
                  >
                    All on hand ({selectedSku?.onHand ?? selectedSku?.available})
                  </Button>
                </div>
                
                <Button
                  className="w-full h-14 text-lg"
                  disabled={!mobileQuantity || parseInt(mobileQuantity) <= 0 || parseInt(mobileQuantity) > (selectedSku?.onHand ?? selectedSku?.available ?? 0)}
                  onClick={() => {
                    playSoundWithHaptic("success", "classic", true);
                    setMobileStep("destination");
                  }}
                  data-testid="button-next-quantity"
                >
                  <ChevronRight className="h-5 w-5 mr-2" />
                  Next
                </Button>
              </div>
            )}
            
            {mobileStep === "destination" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-lg font-semibold">Scan Destination Bin</Label>
                  <Button variant="ghost" size="sm" onClick={() => setMobileStep("quantity")}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">Scan or enter the bin you're moving TO</p>

                {activePrimaryPickLocationId && activePrimaryPickLocationCode && (
                  <button
                    type="button"
                    onClick={() => {
                      setDestLocationCode(activePrimaryPickLocationCode.toUpperCase());
                      setToLocationId(activePrimaryPickLocationId);
                      playSoundWithHaptic("scan", "classic", true);
                      setMobileStep("confirm");
                    }}
                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-md border border-emerald-300 bg-emerald-50 text-emerald-900 text-sm font-medium"
                    data-testid="button-mobile-use-primary-pick"
                  >
                    <span>Primary Pick Bin: <strong className="font-mono">{activePrimaryPickLocationCode}</strong></span>
                    <Badge className="bg-emerald-600 text-xs">Tap to select</Badge>
                  </button>
                )}
                
                <div className="relative">
                  <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    value={destLocationCode}
                    onChange={(e) => {
                      setDestLocationCode(e.target.value.toUpperCase());
                      setToLocationId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && destinationExactMatches.length === 1) {
                        e.preventDefault();
                        const loc = destinationExactMatches[0];
                        setDestLocationCode(loc.code.toUpperCase());
                        setToLocationId(loc.id);
                        playSoundWithHaptic("scan", "classic", true);
                        setMobileStep("confirm");
                      }
                    }}
                    placeholder="B-02-03"
                    className="pl-10 h-14 text-xl text-center uppercase"
                    autoFocus
                    data-testid="input-dest-location"
                  />
                </div>

                {normalizedDestinationCode
                  && normalizedDestinationCode === normalizedSourceCode
                  && destinationExactMatches.length === 0 && (
                  <p className="text-sm text-red-500">Destination must be different from source</p>
                )}

                {normalizedDestinationCode && !destinationSelectionMatchesInput && destinationExactMatches.length !== 1 && (
                  <div className="border rounded-md max-h-48 overflow-y-auto">
                    {destinationCandidates
                      .filter(loc => loc.code.toUpperCase().includes(normalizedDestinationCode))
                      .slice(0, 10)
                      .map(loc => (
                        <button
                          key={loc.id}
                          type="button"
                          className="w-full px-4 py-3 text-left hover:bg-slate-100 border-b last:border-b-0 text-base"
                          onClick={() => {
                            setDestLocationCode(loc.code.toUpperCase());
                            setToLocationId(loc.id);
                            playSoundWithHaptic("scan", "classic", true);
                            setMobileStep("confirm");
                          }}
                        >
                          <span className="font-medium">{loc.code}</span>
                          <span className="text-sm text-muted-foreground ml-2">
                            {loc.warehouseId ? warehouseMap.get(loc.warehouseId) || '' : ''}{loc.zone ? ` · ${loc.zone}` : ''}{loc.locationType ? ` · ${loc.locationType}` : ''}
                          </span>
                        </button>
                      ))}
                    {destinationCandidates.filter(loc => loc.code.toUpperCase().includes(normalizedDestinationCode)).length === 0 && (
                      <p className="px-4 py-3 text-sm text-muted-foreground">No matching bins</p>
                    )}
                  </div>
                )}

                <Button
                  className="w-full h-14 text-lg"
                  disabled={
                    !normalizedDestinationCode ||
                    (!destinationSelectionMatchesInput && destinationExactMatches.length !== 1)
                  }
                  onClick={() => {
                    const loc = destinationSelectionMatchesInput ? selectedToLocation : destinationExactMatches[0];
                    if (loc) {
                      setToLocationId(loc.id);
                      playSoundWithHaptic("scan", "classic", true);
                      setMobileStep("confirm");
                    }
                  }}
                  data-testid="button-next-dest"
                >
                  <ChevronRight className="h-5 w-5 mr-2" />
                  Review
                </Button>
              </div>
            )}
            
            {mobileStep === "confirm" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-lg font-semibold">Confirm Transfer</Label>
                  <Button variant="ghost" size="sm" onClick={() => setMobileStep("destination")}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                </div>
                
                <div className="bg-slate-100 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">From:</span>
                    <Badge variant="outline" className="text-lg px-3 py-1">
                      {sourceLocationCode}{selectedFromLocation?.warehouseId ? ` · ${warehouseMap.get(selectedFromLocation.warehouseId) ?? ""}` : ""}
                    </Badge>
                  </div>
                  <div className="flex justify-center">
                    <ArrowRight className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">To:</span>
                    <Badge variant="outline" className="text-lg px-3 py-1">
                      {destLocationCode}{selectedToLocation?.warehouseId ? ` · ${warehouseMap.get(selectedToLocation.warehouseId) ?? ""}` : ""}
                    </Badge>
                  </div>
                  <hr />
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">SKU:</span>
                    <span className="font-medium">{selectedSku?.sku}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Quantity:</span>
                    <span className="font-bold text-xl">{mobileQuantity}</span>
                  </div>
                </div>
                {isCrossWarehouse && (
                  <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                    <p className="font-medium">This is a warehouse shipment.</p>
                    <p className="mt-1">Confirming will remove the stock from {warehouseMap.get(selectedFromLocation?.warehouseId ?? 0)} and track it as In Transit. It becomes available at {warehouseMap.get(selectedToLocation?.warehouseId ?? 0)} only after receiving scans the physical count.</p>
                  </div>
                )}
                
                <Button
                  className="w-full h-16 text-xl bg-green-600 hover:bg-green-700"
                  onClick={handleMobileSubmit}
                  disabled={transferMutation.isPending}
                  data-testid="button-confirm-transfer"
                >
                  {transferMutation.isPending ? (
                    <Loader2 className="h-6 w-6 animate-spin mr-2" />
                  ) : (
                    <Check className="h-6 w-6 mr-2" />
                  )}
                  {isCrossWarehouse ? "Dispatch Transfer" : "Confirm Move"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Warehouse transfers awaiting receipt</CardTitle>
          </CardHeader>
          <CardContent><InterwarehouseTransferQueue compact /></CardContent>
        </Card>
        
        {transfers.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Recent Transfers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {transfers.slice(0, 5).map((t) => (
                <div key={t.id} className="flex items-center justify-between p-2 bg-slate-50 rounded text-sm">
                  <div>
                    <div className="font-medium">{t.sku}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.fromLocation} → {t.toLocation} ({t.quantity})
                    </div>
                  </div>
                  {t.canUndo && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => undoMutation.mutate(t.id)}
                      disabled={undoMutation.isPending}
                    >
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        {lookupDialog}
        {caseBreakModal}
        {reservationDialog}
      </div>
    );
  }
  
  return (
    <div className="container mx-auto py-6 px-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ArrowLeftRight className="h-6 w-6" />
          Inventory Transfers
        </h1>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <CardTitle>New Transfer</CardTitle>
            <div className="flex items-center rounded-md border bg-muted/40 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setTransferTab("move")}
                className={`px-2.5 py-1 rounded font-medium transition-colors ${
                  transferTab === "move" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid="tab-transfer-move"
              >
                Move Stock
              </button>
              <button
                type="button"
                onClick={() => setTransferTab("case_break")}
                className={`px-2.5 py-1 rounded font-medium transition-colors flex items-center gap-1 ${
                  transferTab === "case_break" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid="tab-transfer-case-break"
              >
                <Boxes className="h-3.5 w-3.5" />
                Case Break
              </button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Source Location</Label>
              {fromLocationId ? (
                <div className="flex items-center gap-2 p-2 border rounded-md bg-slate-50">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium flex-1">
                    {locations.find(l => l.id === fromLocationId)?.code}
                    {(() => { const loc = locations.find(l => l.id === fromLocationId); return loc?.warehouseId ? ` (${warehouseMap.get(loc.warehouseId) || ''})` : ''; })()}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setFromLocationId(null);
                      setLocationSearch("");
                      setVariantId(null);
                      setSelectedSkuLabel("");
                      setSelectedSkuAvailable(null);
                      setQuantity("");
                    }}
                    className="p-1 hover:bg-slate-200 rounded"
                    data-testid="button-clear-source"
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={locationSearch}
                    onChange={(e) => {
                      setLocationSearch(e.target.value);
                      // Do NOT auto-select on an exact code match — that picked
                      // the bin literally coded "FLOOR" and suppressed the
                      // dropdown, hiding FLOOR-01..FLOOR-06. Clear any prior
                      // pick so the list stays open for an explicit choice.
                      if (fromLocationId) setFromLocationId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && locationSearch.trim()) {
                        const upper = locationSearch.trim().toUpperCase();
                        const exact = actionableLocations.filter((l) => l.code.trim().toUpperCase() === upper);
                        if (exact.length === 1) {
                          e.preventDefault();
                          setFromLocationId(exact[0].id);
                          setLocationSearch(exact[0].code);
                          playSoundWithHaptic("scan", "classic", true);
                        }
                      }
                    }}
                    placeholder="Search or scan bin location..."
                    className="pl-10"
                    data-testid="input-source-search"
                  />
                </div>
              )}
              {locationSearch && filteredLocations.length > 0 && !fromLocationId && (
                <div className="border rounded-md max-h-32 overflow-y-auto">
                  {filteredLocations.slice(0, 10).map(loc => (
                    <button
                      key={loc.id}
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-slate-100 text-sm"
                      onClick={() => {
                        setFromLocationId(loc.id);
                        setLocationSearch(loc.code);
                      }}
                    >
                      {loc.code} <span className="text-muted-foreground">({loc.warehouseId ? warehouseMap.get(loc.warehouseId) || '' : ''}{loc.zone ? ` · ${loc.zone}` : ''})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {isCrossWarehouse && (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                <p className="font-medium">Inter-warehouse dispatch</p>
                <p className="mt-1">Stock leaves the source now and stays in transit until the destination posts its received count. It will not be sellable at the destination early.</p>
              </div>
            )}
            
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>SKU</Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2"
                  onClick={() => setLookupOpen(true)}
                  data-testid="button-open-lookup"
                >
                  <Search className="h-3 w-3 mr-1" />
                  Look up SKU
                </Button>
              </div>
              {variantId ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 p-2 border rounded-md bg-slate-50">
                    <Package className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium flex-1 font-mono">{selectedSkuLabel}</span>
                    {selectedSkuAvailable != null && (
                      <span className="text-xs text-green-600">{currentSelectedStock ? stockSummary(currentSelectedStock) : `${selectedSkuAvailable.toLocaleString()} available`}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setVariantId(null);
                        setSelectedSkuLabel("");
                        setSelectedSkuAvailable(null);
                        setQuantity("");
                      }}
                      className="p-1 hover:bg-slate-200 rounded"
                      data-testid="button-clear-sku"
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                  {(transferTab === "case_break" || canBreakSelectedSku) && (
                    <div className="rounded-md border border-blue-200 bg-blue-50/60 p-2.5 flex items-center justify-between gap-2 text-xs">
                      {canBreakSelectedSku ? (
                        <>
                          <div>
                            <div className="font-medium text-blue-900">
                              Case/Pack convertible to <span className="font-mono">{currentSelectedStock?.breakTargetSku}</span>
                            </div>
                            <div className="text-blue-700">
                              1 {selectedSkuLabel} yields {currentSelectedStock?.breakOutputQty} {currentSelectedStock?.breakTargetSku}
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="border-blue-300 text-blue-800 hover:bg-blue-100 shrink-0"
                            onClick={() => setCaseBreakOpen(true)}
                            data-testid="button-open-inline-case-break"
                          >
                            <Boxes className="h-3.5 w-3.5 mr-1" />
                            Break Case
                          </Button>
                        </>
                      ) : (
                        <span className="text-blue-800">
                          Select a Case or Multi-pack SKU in the source bin to break it into smaller sellable units.
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ) : !fromLocationId ? (
                <p className="text-sm text-muted-foreground py-2">Select a source bin first</p>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={skuFilter}
                      onChange={(e) => setSkuFilter(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && skuFilter.trim()) {
                          e.preventDefault();
                          const token = skuFilter.trim().toLowerCase();
                          const exact = skusAtLocation.find(
                            (it) =>
                              it.sku.toLowerCase() === token ||
                              (it.barcode && it.barcode.toLowerCase() === token),
                          );
                          if (exact) {
                            setSelectedSkuLabel(exact.sku);
                            setVariantId(exact.variantId);
                            setSelectedSkuAvailable(exact.available);
                            setQuantity(String(suggestedTransferQuantity(exact)));
                            setSkuFilter("");
                            playSoundWithHaptic("scan", "classic", true);
                          }
                        }
                      }}
                      placeholder="Filter or scan SKU / barcode in this bin..."
                      className="pl-9 h-9 text-sm"
                      data-testid="input-desktop-sku-filter"
                    />
                  </div>
                  {skusAtLocation.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">
                      {skuFilter.trim() ? "No matching SKUs in this bin" : "No inventory in this bin"}
                    </p>
                  ) : (
                    <div className="border rounded-md max-h-48 overflow-y-auto">
                      {skusAtLocation
                        .filter(
                          (result) =>
                            !skuFilter.trim() ||
                            result.sku.toLowerCase().includes(skuFilter.toLowerCase()) ||
                            result.name.toLowerCase().includes(skuFilter.toLowerCase()) ||
                            Boolean(result.barcode && result.barcode.toLowerCase().includes(skuFilter.toLowerCase())),
                        )
                        .map((result) => (
                          <button
                            key={result.variantId}
                            type="button"
                            className="w-full px-3 py-2 text-left hover:bg-slate-100 border-b last:border-b-0"
                            onClick={() => {
                              setSelectedSkuLabel(result.sku);
                              setVariantId(result.variantId);
                              setSelectedSkuAvailable(result.available);
                              setQuantity(String(suggestedTransferQuantity(result)));
                            }}
                            data-testid={`sku-at-location-${result.variantId}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium font-mono">{result.sku}</span>
                              {result.primaryPickLocationCode && (
                                <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700">
                                  Pick: {result.primaryPickLocationCode}
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">{result.name}</div>
                            <div className="text-xs text-green-600">{stockSummary(result)}</div>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            
            <div className="space-y-2">
              <Label>Quantity</Label>
              <Input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="Enter quantity"
                min={1}
                data-testid="input-desktop-quantity"
              />
            </div>
            
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Destination Location</Label>
                {activePrimaryPickLocationId && activePrimaryPickLocationCode && toLocationId !== activePrimaryPickLocationId && (
                  <button
                    type="button"
                    onClick={() => {
                      setToLocationId(activePrimaryPickLocationId);
                      setDestLocationSearch(activePrimaryPickLocationCode);
                    }}
                    className="text-xs font-medium text-emerald-700 hover:underline flex items-center gap-1"
                    data-testid="button-use-primary-pick-bin"
                  >
                    <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800 text-[10px] px-1.5 py-0">
                      Primary Pick: {activePrimaryPickLocationCode}
                    </Badge>
                  </button>
                )}
              </div>
              {toLocationId ? (
                <div className="flex items-center gap-2 p-2 border rounded-md bg-slate-50">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium flex-1">
                    {locations.find(l => l.id === toLocationId)?.code}
                    {(() => { const loc = locations.find(l => l.id === toLocationId); return loc?.warehouseId ? ` (${warehouseMap.get(loc.warehouseId) || ''})` : ''; })()}
                  </span>
                  {toLocationId === activePrimaryPickLocationId && (
                    <Badge className="bg-emerald-600 text-[10px] px-1.5 py-0">Primary Pick Bin</Badge>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setToLocationId(null);
                      setDestLocationSearch("");
                    }}
                    className="p-1 hover:bg-slate-200 rounded"
                    data-testid="button-clear-dest"
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={destLocationSearch}
                    onChange={(e) => {
                      setDestLocationSearch(e.target.value);
                      // Do NOT auto-select on an exact code match (see source
                      // bin above) — keep the dropdown open so sub-locations
                      // like FLOOR-06 remain selectable.
                      if (toLocationId) setToLocationId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && destLocationSearch.trim()) {
                        const upper = destLocationSearch.trim().toUpperCase();
                        const exact = destinationCandidates.filter((l) => l.code.trim().toUpperCase() === upper);
                        if (exact.length === 1) {
                          e.preventDefault();
                          setToLocationId(exact[0].id);
                          setDestLocationSearch(exact[0].code);
                          playSoundWithHaptic("scan", "classic", true);
                        }
                      }
                    }}
                    placeholder="Search or scan destination..."
                    className="pl-10"
                    data-testid="input-dest-search"
                  />
                </div>
              )}
              {destLocationSearch && filteredDestLocations.length > 0 && !toLocationId && (
                <div className="border rounded-md max-h-32 overflow-y-auto">
                  {filteredDestLocations.slice(0, 10).map(loc => (
                    <button
                      key={loc.id}
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-slate-100 text-sm flex items-center justify-between gap-2"
                      onClick={() => {
                        setToLocationId(loc.id);
                        setDestLocationSearch(loc.code);
                      }}
                    >
                      <span>
                        {loc.code} <span className="text-muted-foreground">({loc.warehouseId ? warehouseMap.get(loc.warehouseId) || '' : ''}{loc.zone ? ` · ${loc.zone}` : ''})</span>
                      </span>
                      {loc.id === activePrimaryPickLocationId && (
                        <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800 text-[10px]">
                          Primary Pick Bin
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            <div className="space-y-2">
              <Label>Notes (Optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Reason for transfer..."
                rows={2}
                data-testid="input-notes"
              />
            </div>
            
            <Button
              className="w-full"
              onClick={handleDesktopSubmit}
              disabled={!fromLocationId || !toLocationId || !variantId || !quantity || transferMutation.isPending}
              data-testid="button-desktop-transfer"
            >
              {transferMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <ArrowRight className="h-4 w-4 mr-2" />
              )}
              {isCrossWarehouse ? "Dispatch Warehouse Transfer" : "Move Inventory"}
            </Button>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader>
            <CardTitle>Warehouse transfer orders</CardTitle>
          </CardHeader>
          <CardContent>
            <InterwarehouseTransferQueue />
            <div className="mt-6 border-t pt-5">
              <h3 className="mb-3 font-medium">Recent bin moves</h3>
            {transfersLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : transfers.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No transfers yet</p>
            ) : (
              <div className="space-y-3 max-h-[500px] overflow-y-auto">
                {transfers.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between p-3 bg-slate-50 rounded-lg"
                    data-testid={`transfer-row-${t.id}`}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{t.fromLocation}</Badge>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        <Badge variant="outline">{t.toLocation}</Badge>
                      </div>
                      <div className="mt-1">
                        <span className="font-medium">{t.sku}</span>
                        <span className="text-muted-foreground ml-2">x{t.quantity}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {format(new Date(t.createdAt), "MMM d, h:mm a")} by {t.userId}
                      </div>
                    </div>
                    {t.canUndo && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => undoMutation.mutate(t.id)}
                        disabled={undoMutation.isPending}
                        data-testid={`button-undo-${t.id}`}
                        title="Create an append-only reverse transfer back to the source bin"
                      >
                        <Undo2 className="h-4 w-4 mr-1" />
                        Reverse
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            </div>
          </CardContent>
        </Card>
      </div>
      
      {lookupDialog}
      {caseBreakModal}
      {reservationDialog}
    </div>
  );
}
