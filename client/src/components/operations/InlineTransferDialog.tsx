import { useState, useEffect, useId } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useInventoryCommand } from "@/lib/inventory-command";
import { isActionableWarehouseLocation } from "@/lib/warehouse-locations";
import {
  TransferLocationField, transferLocationLabel, transferLocationSchema, transferWarehouseSchema,
} from "./TransferLocationField";

interface InlineTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultFromLocationId?: number;
  defaultFromLocationCode?: string;
  defaultToLocationId?: number;
  defaultToLocationCode?: string;
  defaultVariantId?: number;
  defaultSku?: string;
  defaultQty?: number;
}

const skuAtLocationSchema = z.object({
  variantId: z.number().int().positive(), sku: z.string(), name: z.string(), available: z.number().int(),
});

async function readList<T>(url: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Unable to load transfer options (${response.status}).`);
  return schema.parse(await response.json());
}

export default function InlineTransferDialog({
  open, onOpenChange, defaultFromLocationId, defaultFromLocationCode, defaultToLocationId,
  defaultToLocationCode, defaultVariantId, defaultSku, defaultQty,
}: InlineTransferDialogProps) {
  const id = useId();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inventoryCommand = useInventoryCommand();
  const [fromLocationId, setFromLocationId] = useState<number | null>(null);
  const [toLocationId, setToLocationId] = useState<number | null>(null);
  const [fromWarehouseId, setFromWarehouseId] = useState<number | null>(null);
  const [toWarehouseId, setToWarehouseId] = useState<number | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [arrivalConfirmed, setArrivalConfirmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFromLocationId(defaultFromLocationId ?? null);
    setToLocationId(defaultToLocationId ?? null);
    setFromWarehouseId(null);
    setToWarehouseId(null);
    setVariantId(defaultVariantId ?? null);
    setQuantity(defaultQty ? String(defaultQty) : "");
    setNotes("");
    setArrivalConfirmed(false);
  }, [open, defaultFromLocationId, defaultToLocationId, defaultVariantId, defaultQty]);

  const locationsQuery = useQuery({
    queryKey: ["/api/warehouse/locations"],
    queryFn: ({ signal }) => readList("/api/warehouse/locations", z.array(transferLocationSchema), signal),
    enabled: open,
  });
  const warehousesQuery = useQuery({
    queryKey: ["/api/warehouses"],
    queryFn: ({ signal }) => readList("/api/warehouses", z.array(transferWarehouseSchema), signal),
    enabled: open,
  });
  const skusQuery = useQuery({
    queryKey: ["/api/inventory/skus/search", fromLocationId],
    queryFn: ({ signal }) => readList(`/api/inventory/skus/search?locationId=${fromLocationId}&limit=100`, z.array(skuAtLocationSchema), signal),
    enabled: open && fromLocationId !== null,
  });
  const locations = locationsQuery.data ?? [];
  const warehouses = warehousesQuery.data ?? [];
  const from = locations.find((location) => location.id === fromLocationId);
  const to = locations.find((location) => location.id === toLocationId);
  const crossWarehouse = from?.warehouseId != null && to?.warehouseId != null && from.warehouseId !== to.warehouseId;
  const selectedSku = skusQuery.data?.find((sku) => sku.variantId === variantId);
  // This endpoint's legacy "available" field is physical on-hand, not ATP.
  // The posting service separately protects reservations.
  const maxQty = selectedSku?.available;
  const qtyNum = Number(quantity);
  const overMax = maxQty !== undefined && qtyNum > maxQty;
  const loadFailed = locationsQuery.isError || warehousesQuery.isError || skusQuery.isError;
  const optionsReady = locationsQuery.isSuccess && warehousesQuery.isSuccess && !loadFailed;
  const activeWarehouse = (warehouseId: number | null | undefined) => warehouses.some((warehouse) => warehouse.id === warehouseId && warehouse.isActive === 1);
  const isValid = optionsReady && isActionableWarehouseLocation(from) && isActionableWarehouseLocation(to)
    && activeWarehouse(from?.warehouseId) && activeWarehouse(to?.warehouseId)
    && variantId !== null && Number.isSafeInteger(qtyNum) && qtyNum > 0 && !overMax
    && fromLocationId !== toLocationId && (!crossWarehouse || arrivalConfirmed);

  const transferMutation = useMutation({
    mutationFn: async () => {
      if (!isValid) throw new Error("Choose valid warehouses, locations and a whole-number quantity before transferring.");
      return inventoryCommand("/api/inventory/transfer", {
        fromLocationId, toLocationId, variantId, quantity: qtyNum, notes: notes || undefined,
        // Omitting this for same-building transfers preserves their existing command identity.
        crossWarehouseArrivalConfirmed: crossWarehouse ? true : undefined,
      });
    },
    onSuccess: () => {
      const sku = defaultSku || selectedSku?.sku || "";
      toast({ title: "Transfer complete", description: `Moved ${quantity} ${sku} units to ${to ? transferLocationLabel(to, warehouses) : "the destination"}` });
      queryClient.invalidateQueries({ predicate: (query) => {
        const key = query.queryKey[0];
        return typeof key === "string" && (key.startsWith("/api/inventory/") || key.startsWith("/api/operations/"));
      } });
      onOpenChange(false);
    },
    onError: (error: Error) => toast({ title: "Transfer failed", description: error.message, variant: "destructive" }),
  });
  const busy = transferMutation.isPending;

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="sm:max-w-[620px] max-h-[90dvh] flex flex-col overflow-hidden">
      <DialogHeader className="shrink-0">
        <DialogTitle>Transfer Inventory</DialogTitle>
        <DialogDescription>Record stock moved between locations, in the same warehouse or another building.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2 min-h-0 overflow-y-auto">
        {loadFailed && <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Could not load warehouse, location or stock details. Reload these details before transferring.</p>
          <Button variant="outline" size="sm" onClick={() => {
            void locationsQuery.refetch(); void warehousesQuery.refetch();
            if (fromLocationId !== null) void skusQuery.refetch();
          }}>Retry loading</Button>
        </div>}
        <TransferLocationField key={`${open}-from`} direction="From" locations={locations} warehouses={warehouses}
          locationId={fromLocationId} warehouseId={fromWarehouseId} fixed={defaultFromLocationId != null}
          fallbackCode={defaultFromLocationCode} disabled={!optionsReady || busy}
          onWarehouseChange={(value) => { setFromWarehouseId(value); setFromLocationId(null); if (!defaultVariantId) setVariantId(null); setArrivalConfirmed(false); }}
          onLocationChange={(value) => { setFromLocationId(value); if (!defaultVariantId) setVariantId(null); setArrivalConfirmed(false); }} />
        <div className="space-y-2">
          <Label htmlFor={`${id}-sku`}>SKU</Label>
          {defaultSku ? <Input id={`${id}-sku`} value={defaultSku} readOnly className="font-mono" /> : (
            <Select value={variantId?.toString() ?? ""} onValueChange={(value) => { setVariantId(Number(value)); setArrivalConfirmed(false); }} disabled={!fromLocationId || busy}>
              <SelectTrigger id={`${id}-sku`}><SelectValue placeholder={fromLocationId ? "Select SKU" : "Select source first"} /></SelectTrigger>
              <SelectContent className="max-h-[200px]">{skusQuery.data?.map((sku) =>
                <SelectItem key={sku.variantId} value={String(sku.variantId)}>{sku.sku} — {sku.name} (on hand: {sku.available})</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-qty`}>Quantity {maxQty !== undefined && <span className="text-muted-foreground">(on hand {maxQty})</span>}</Label>
          <div className="flex gap-2">
            <Input id={`${id}-qty`} type="number" min="1" step="1" max={maxQty} value={quantity} disabled={busy}
              onChange={(event) => { setQuantity(event.target.value); setArrivalConfirmed(false); }} placeholder="Enter quantity" className="font-mono" />
            {maxQty !== undefined && maxQty > 0 && <Button variant="outline" size="sm" disabled={busy}
              onClick={() => { setQuantity(String(maxQty)); setArrivalConfirmed(false); }}>All</Button>}
          </div>
          {overMax && <p className="text-xs text-destructive">Exceeds on-hand quantity ({maxQty}). Reserved stock cannot be moved.</p>}
        </div>
        <TransferLocationField key={`${open}-to`} direction="To" locations={locations} warehouses={warehouses}
          locationId={toLocationId} warehouseId={toWarehouseId} fixed={defaultToLocationId != null}
          fallbackCode={defaultToLocationCode} excludeLocationId={fromLocationId} disabled={!optionsReady || busy}
          onWarehouseChange={(value) => { setToWarehouseId(value); setToLocationId(null); setArrivalConfirmed(false); }}
          onLocationChange={(value) => { setToLocationId(value); setArrivalConfirmed(false); }} />
        {from && to && <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-2" data-testid="transfer-route">
          <p><span className="font-medium">From:</span> {transferLocationLabel(from, warehouses)}</p>
          <p><span className="font-medium">To:</span> {transferLocationLabel(to, warehouses)}</p>
          {crossWarehouse && <>
            <p>This updates both warehouses immediately. Record it after the stock arrives, not while it is in transit.</p>
            <div className="flex items-start gap-2">
              <Checkbox id={`${id}-arrival`} checked={arrivalConfirmed} disabled={busy} onCheckedChange={(value) => setArrivalConfirmed(value === true)} />
              <Label htmlFor={`${id}-arrival`} className="leading-5">The stock has arrived at the destination location.</Label>
            </div>
          </>}
        </div>}
        <div className="space-y-2">
          <Label htmlFor={`${id}-notes`}>Notes (optional)</Label>
          <Textarea id={`${id}-notes`} value={notes} disabled={busy} onChange={(event) => setNotes(event.target.value)} placeholder="Reason for transfer…" rows={2} />
        </div>
      </div>
      <DialogFooter className="shrink-0 border-t pt-3">
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button onClick={() => transferMutation.mutate()} disabled={!isValid || busy}>
          {busy ? "Transferring…" : <><ArrowRight className="h-4 w-4 mr-2" />Transfer</>}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
