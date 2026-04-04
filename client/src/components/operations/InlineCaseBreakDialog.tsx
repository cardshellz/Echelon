import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Boxes, Search } from "lucide-react";
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

interface InlineCaseBreakDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultFromLocationId?: number;
  defaultFromLocationCode?: string;
  sourceVariantId?: number;
  sourceSku?: string;
  pickVariantId?: number;
  pickSku?: string;
  conversionRatio?: number;
}

interface Location {
  id: number;
  code: string;
  locationType: string;
  zone: string | null;
  warehouseId: number | null;
}

export default function InlineCaseBreakDialog({
  open,
  onOpenChange,
  defaultFromLocationId,
  defaultFromLocationCode,
  sourceVariantId,
  sourceSku,
  pickVariantId,
  pickSku,
  conversionRatio = 1,
}: InlineCaseBreakDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [toLocationId, setToLocationId] = useState<number | null>(null);
  const [qtySourceUnits, setQtySourceUnits] = useState("1");
  const [notes, setNotes] = useState("");
  const [locationSearch, setLocationSearch] = useState("");

  // Auto-calculate target units
  const casesQty = parseInt(qtySourceUnits) || 0;
  const qtyTargetUnits = Math.floor(casesQty * conversionRatio).toString();

  useEffect(() => {
    if (open) {
      setToLocationId(null);
      setQtySourceUnits("1");
      setNotes("");
      setLocationSearch("");
    }
  }, [open]);

  const { data: locations } = useQuery<Location[]>({
    queryKey: ["/api/warehouse/locations"],
    queryFn: async () => {
      const res = await fetch("/api/warehouse/locations");
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: open,
  });

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

  const caseBreakMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/replen/tasks", {
        mode: "case_break",
        fromLocationId: defaultFromLocationId?.toString(),
        toLocationId: toLocationId?.toString(),
        sourceVariantId: sourceVariantId?.toString(),
        pickVariantId: pickVariantId?.toString(),
        qtySourceUnits,
        qtyTargetUnits,
        autoExecute: true,
        priority: "5",
        notes: notes || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.autoExecuteError) {
        toast({ title: "Task created but execution failed", description: data.autoExecuteError, variant: "destructive", duration: 8000 });
      } else {
        onOpenChange(false);
        if (data.autoExecuted) {
          toast({ title: "Case break completed", description: `Broke ${qtySourceUnits} ${sourceSku} into ${data.moved} ${pickSku}` });
        } else {
          toast({ title: "Case break task created" });
        }
      }
      queryClient.invalidateQueries({ queryKey: ["/api/operations/bin-inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/levels"] });
      queryClient.invalidateQueries({ queryKey: ["/api/replen/tasks"] });
    },
    onError: (error: any) => {
      toast({ title: "Case break failed", description: error.message, variant: "destructive" });
    },
  });

  const isValid = defaultFromLocationId && toLocationId && sourceVariantId && pickVariantId && parseInt(qtySourceUnits) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Break Case</DialogTitle>
          <DialogDescription>
            Unpack cases into individual units or packs in a destination bin.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-sm">
          <div className="rounded-md border bg-blue-50/50 p-3 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">FROM</span>
              <span className="font-mono">{defaultFromLocationCode}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">CASE</span>
              <span className="font-mono text-blue-700">{sourceSku}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground text-xs uppercase tracking-wider font-semibold">TO PACK</span>
              <span className="font-mono text-green-700">{pickSku}</span>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Destination Bin for Broken Packs</Label>
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
              value={toLocationId?.toString() || ""}
              onValueChange={(v) => { setToLocationId(parseInt(v)); setLocationSearch(""); }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select destination bin" />
              </SelectTrigger>
              <SelectContent className="max-h-[200px]">
                {filteredLocations
                  .filter((loc) => loc.id !== defaultFromLocationId)
                  .map((loc) => (
                    <SelectItem key={loc.id} value={loc.id.toString()}>
                      {loc.code} ({loc.locationType.replace("_", " ")})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>How many cases to break?</Label>
            <Input
              type="number"
              min="1"
              value={qtySourceUnits}
              onChange={(e) => setQtySourceUnits(e.target.value)}
              placeholder="1"
              className="font-mono"
            />
            {casesQty > 0 && conversionRatio > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                Will yield <span className="font-medium text-foreground">{qtyTargetUnits} {pickSku}</span> units.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Reason for break..."
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => caseBreakMutation.mutate()}
            disabled={!isValid || caseBreakMutation.isPending}
          >
            {caseBreakMutation.isPending ? "Executing..." : (
              <>
                <Boxes className="h-4 w-4 mr-2" />
                Break into {qtyTargetUnits} packs
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
