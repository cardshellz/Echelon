import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface InlineTransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultFromLocationId?: number;
  defaultFromLocationCode?: string;
  defaultToLocationId?: number;
  defaultToLocationCode?: string;
  defaultVariantId?: number;
  defaultSku?: string;
}

interface Location {
  id: number;
  code: string;
  locationType: string;
  zone: string | null;
  warehouseId: number | null;
}

interface SkuAtLocation {
  variantId: number;
  sku: string;
  name: string;
  variantQty: number;
}

export default function InlineTransferDialog({
  open,
  onOpenChange,
  defaultFromLocationId,
  defaultFromLocationCode,
  defaultToLocationId,
  defaultToLocationCode,
  defaultVariantId,
  defaultSku,
}: InlineTransferDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [fromLocationId, setFromLocationId] = useState<number | null>(null);
  const [toLocationId, setToLocationId] = useState<number | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [locationSearch, setLocationSearch] = useState("");

  // Reset form when dialog opens with defaults
  useEffect(() => {
    if (open) {
      setFromLocationId(defaultFromLocationId ?? null);
      setToLocationId(defaultToLocationId ?? null);
      setVariantId(defaultVariantId ?? null);
      setQuantity("");
      setNotes("");
      setLocationSearch("");
    }
  }, [open, defaultFromLocationId, defaultToLocationId, defaultVariantId]);

  // Fetch all locations
  const { data: locations } = useQuery<Location[]>({
    queryKey: ["/api/warehouse/locations"],
    queryFn: async () => {
      const res = await fetch("/api/warehouse/locations");
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: open,
  });

  // Fetch SKUs at source location
  const { data: skusAtLocation } = useQuery<SkuAtLocation[]>({
    queryKey: ["/api/inventory/skus/search", fromLocationId],
    queryFn: async () => {
      const res = await fetch(`/api/inventory/skus/search?locationId=${fromLocationId}&limit=100`);
      if (!res.ok) throw new Error("Failed to fetch SKUs");
      return res.json();
    },
    enabled: open && !!fromLocationId,
  });

  // Filter locations for search
  const filteredLocations = useMemo(() => {
    if (!locations) return [];
    if (!locationSearch) return locations;
    const q = locationSearch.toLowerCase();
    return locations.filter(
      (loc) =>
        loc.code.toLowerCase().includes(q) ||
        loc.locationType.toLowerCase().includes(q) ||
        (loc.zone?.toLowerCase().includes(q) ?? false),
    );
  }, [locations, locationSearch]);

  const transferMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/inventory/transfer", {
        fromLocationId,
        toLocationId,
        variantId,
        quantity: parseInt(quantity),
        notes: notes || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      const sku = defaultSku || skusAtLocation?.find((s) => s.variantId === variantId)?.sku || "";
      toast({ title: "Transfer complete", description: `Moved ${quantity} ${sku} units` });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/bin-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/location-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/exceptions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/pick-readiness"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/unassigned-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/levels"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/activity"] });
      onOpenChange(false);
    },
    onError: (error: any) => {
      toast({ title: "Transfer failed", description: error.message, variant: "destructive" });
    },
  });

  const selectedSku = skusAtLocation?.find((s) => s.variantId === variantId);
  const maxQty = selectedSku?.variantQty ?? 0;
  const qtyNum = parseInt(quantity) || 0;
  const isValid = fromLocationId && toLocationId && variantId && qtyNum > 0 && fromLocationId !== toLocationId;
  const overMax = maxQty > 0 && qtyNum > maxQty;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Transfer Inventory</DialogTitle>
          <DialogDescription>
            Move inventory from one location to another.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Source location */}
          <div className="space-y-2">
            <Label>From Location</Label>
            {defaultFromLocationCode ? (
              <Input value={defaultFromLocationCode} disabled className="font-mono" />
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search locations..."
                    value={locationSearch}
                    onChange={(e) => setLocationSearch(e.target.value)}
                    className="pl-9 h-9 mb-1"
                  />
                </div>
                <Select
                  value={fromLocationId?.toString() || ""}
                  onValueChange={(v) => { setFromLocationId(parseInt(v)); setVariantId(null); setLocationSearch(""); }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select source location" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[200px]">
                    {filteredLocations.map((loc) => (
                      <SelectItem key={loc.id} value={loc.id.toString()}>
                        {loc.code} ({loc.locationType.replace("_", " ")})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>

          {/* SKU selector */}
          <div className="space-y-2">
            <Label>SKU</Label>
            {defaultSku ? (
              <Input value={defaultSku} disabled className="font-mono" />
            ) : (
              <Select
                value={variantId?.toString() || ""}
                onValueChange={(v) => setVariantId(parseInt(v))}
                disabled={!fromLocationId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={fromLocationId ? "Select SKU" : "Select location first"} />
                </SelectTrigger>
                <SelectContent className="max-h-[200px]">
                  {skusAtLocation?.map((s) => (
                    <SelectItem key={s.variantId} value={s.variantId.toString()}>
                      {s.sku} — {s.name} (qty: {s.variantQty})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Quantity */}
          <div className="space-y-2">
            <Label>Quantity {maxQty > 0 && <span className="text-muted-foreground">(max {maxQty})</span>}</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min="1"
                max={maxQty || undefined}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="Enter quantity"
                className={`font-mono ${overMax ? "border-red-500 focus-visible:ring-red-500" : ""}`}
              />
              {maxQty > 0 && (
                <Button variant="outline" size="sm" onClick={() => setQuantity(maxQty.toString())}>
                  All
                </Button>
              )}
            </div>
            {overMax && (
              <p className="text-xs text-red-600">Exceeds available quantity ({maxQty})</p>
            )}
          </div>

          {/* Destination */}
          <div className="space-y-2">
            <Label>To Location</Label>
            {defaultToLocationCode ? (
              <Input value={defaultToLocationCode} disabled className="font-mono" />
            ) : (
              <>
                {!defaultFromLocationCode && (
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search locations..."
                      value={locationSearch}
                      onChange={(e) => setLocationSearch(e.target.value)}
                      className="pl-9 h-9 mb-1"
                    />
                  </div>
                )}
                <Select
                  value={toLocationId?.toString() || ""}
                  onValueChange={(v) => { setToLocationId(parseInt(v)); setLocationSearch(""); }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select destination" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[200px]">
                    {(defaultFromLocationCode ? locations : filteredLocations)
                      ?.filter((loc) => loc.id !== fromLocationId)
                      .map((loc) => (
                        <SelectItem key={loc.id} value={loc.id.toString()}>
                          {loc.code} ({loc.locationType.replace("_", " ")})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Reason for transfer..."
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => transferMutation.mutate()}
            disabled={!isValid || overMax || transferMutation.isPending}
          >
            {transferMutation.isPending ? "Transferring..." : (
              <>
                <ArrowRight className="h-4 w-4 mr-2" />
                Transfer
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
