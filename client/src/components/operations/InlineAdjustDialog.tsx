import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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

interface InlineAdjustDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId?: number;
  locationCode?: string;
  variantId?: number;
  sku?: string;
  currentQty?: number;
}

interface AdjustmentReason {
  id: number;
  code: string;
  name: string;
  requiresNote: number;
}

export default function InlineAdjustDialog({
  open,
  onOpenChange,
  locationId,
  locationCode,
  variantId,
  sku,
  currentQty,
}: InlineAdjustDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [qtyDelta, setQtyDelta] = useState("");
  const [reasonId, setReasonId] = useState<string>("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setQtyDelta("");
      setReasonId("");
      setNotes("");
    }
  }, [open]);

  const { data: reasons } = useQuery<AdjustmentReason[]>({
    queryKey: ["/api/inventory/adjustment-reasons"],
    queryFn: async () => {
      const res = await fetch("/api/inventory/adjustment-reasons");
      if (!res.ok) throw new Error("Failed to fetch reasons");
      return res.json();
    },
    enabled: open,
  });

  const adjustMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/inventory/adjust", {
        productVariantId: variantId,
        warehouseLocationId: locationId,
        qtyDelta: parseInt(qtyDelta),
        reason: selectedReason?.name || "Manual adjustment",
        reasonId: reasonId ? parseInt(reasonId) : undefined,
        notes: notes || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      const delta = parseInt(qtyDelta);
      toast({
        title: "Adjustment applied",
        description: `${sku}: ${delta > 0 ? "+" : ""}${delta} (now ${(currentQty ?? 0) + delta})`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/bin-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/location-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/exceptions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/pick-readiness"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/unassigned-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/levels"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/summary"] });
      onOpenChange(false);
    },
    onError: (error: any) => {
      toast({ title: "Adjustment failed", description: error.message, variant: "destructive" });
    },
  });

  const selectedReason = reasons?.find((r) => r.id.toString() === reasonId);
  const delta = parseInt(qtyDelta) || 0;
  const newQty = (currentQty ?? 0) + delta;
  const isValid = variantId && locationId && delta !== 0 && reasonId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Adjust Inventory</DialogTitle>
          <DialogDescription>
            Adjust quantity for <span className="font-mono font-medium">{sku}</span> at{" "}
            <span className="font-mono font-medium">{locationCode}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="bg-muted/30 p-3 rounded-lg flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Current Qty</span>
            <span className="font-mono font-bold text-lg">{currentQty?.toLocaleString() ?? "—"}</span>
          </div>

          <div className="space-y-2">
            <Label>Adjustment (+/-)</Label>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setQtyDelta("-1")}>-1</Button>
              <Button variant="outline" size="sm" onClick={() => setQtyDelta("-5")}>-5</Button>
              <Input
                type="number"
                value={qtyDelta}
                onChange={(e) => setQtyDelta(e.target.value)}
                placeholder="e.g. -3 or +10"
                className="font-mono text-center"
              />
              <Button variant="outline" size="sm" onClick={() => setQtyDelta("+5")}>+5</Button>
              <Button variant="outline" size="sm" onClick={() => setQtyDelta("+1")}>+1</Button>
            </div>
            {delta !== 0 && (
              <div className={`text-sm font-mono ${newQty < 0 ? "text-red-600" : "text-green-600"}`}>
                New qty: {newQty.toLocaleString()}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Reason</Label>
            <Select value={reasonId} onValueChange={setReasonId}>
              <SelectTrigger>
                <SelectValue placeholder="Select reason..." />
              </SelectTrigger>
              <SelectContent>
                {reasons?.map((r) => (
                  <SelectItem key={r.id} value={r.id.toString()}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Notes {selectedReason?.requiresNote ? "(required)" : "(optional)"}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Details about this adjustment..."
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => adjustMutation.mutate()}
            disabled={!isValid || adjustMutation.isPending || (selectedReason?.requiresNote === 1 && !notes)}
          >
            {adjustMutation.isPending ? "Applying..." : "Apply Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
