import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  Settings,
  Save,
  Loader2,
  Warehouse,
  PackageCheck,
  Layers,
  Scan,
  Info,
} from "lucide-react";

interface WarehouseType {
  id: number;
  name: string;
  code: string;
}

interface WarehouseSettings {
  id: number;
  warehouseId: number | null;
  warehouseCode: string;
  warehouseName: string;
  postPickStatus: string;
  pickMode: string;
  requireScanConfirm: number;
  pickingBatchSize: number;
  autoReleaseDelayMinutes: number;
  isActive: number;
  [key: string]: any;
}

export default function PickingSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data: warehouses = [] } = useQuery<WarehouseType[]>({
    queryKey: ["/api/warehouses"],
    queryFn: async () => {
      const res = await fetch("/api/warehouses", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch warehouses");
      return res.json();
    },
  });

  const { data: allWarehouseSettings = [], isLoading: settingsLoading } = useQuery<WarehouseSettings[]>({
    queryKey: ["/api/warehouse-settings"],
    queryFn: async () => {
      const res = await fetch("/api/warehouse-settings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
  });

  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>("");

  const selectedWarehouseData = warehouses.find(w => w.id.toString() === selectedWarehouseId);

  const selectedWarehouse = allWarehouseSettings.find(
    w => w.warehouseId?.toString() === selectedWarehouseId ||
         (selectedWarehouseData && w.warehouseCode === selectedWarehouseData.code)
  );

  const [form, setForm] = useState({
    postPickStatus: "ready_to_ship",
    pickMode: "single_order",
    requireScanConfirm: "0",
    pickingBatchSize: "20",
    autoReleaseDelayMinutes: "30",
  });

  // Auto-select first warehouse
  useEffect(() => {
    if (warehouses.length > 0 && !selectedWarehouseId) {
      setSelectedWarehouseId(warehouses[0].id.toString());
    }
  }, [warehouses, selectedWarehouseId]);

  // Sync form when warehouse changes
  useEffect(() => {
    if (selectedWarehouse) {
      setForm({
        postPickStatus: selectedWarehouse.postPickStatus || "ready_to_ship",
        pickMode: selectedWarehouse.pickMode || "single_order",
        requireScanConfirm: (selectedWarehouse.requireScanConfirm ?? 0).toString(),
        pickingBatchSize: (selectedWarehouse.pickingBatchSize ?? 20).toString(),
        autoReleaseDelayMinutes: (selectedWarehouse.autoReleaseDelayMinutes ?? 30).toString(),
      });
    }
  }, [selectedWarehouse]);

  const saveMutation = useMutation({
    mutationFn: async (data: { postPickStatus: string; pickMode: string; requireScanConfirm: number; pickingBatchSize: number; autoReleaseDelayMinutes: number }) => {
      if (!selectedWarehouseData) throw new Error("No warehouse selected");

      if (selectedWarehouse?.id) {
        const res = await fetch(`/api/warehouse-settings/${selectedWarehouse.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            ...data,
            warehouseId: selectedWarehouseData.id,
          }),
        });
        if (!res.ok) throw new Error("Failed to save settings");
        return res.json();
      } else {
        const res = await fetch("/api/warehouse-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            warehouseId: selectedWarehouseData.id,
            warehouseCode: selectedWarehouseData.code,
            warehouseName: selectedWarehouseData.name,
            ...data,
          }),
        });
        if (!res.ok) throw new Error("Failed to create settings");
        return res.json();
      }
    },
    onSuccess: () => {
      toast({ title: "Pick settings saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse-settings"] });
    },
    onError: () => {
      toast({ title: "Failed to save settings", variant: "destructive" });
    },
  });

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-6">
      <Card>
        <CardHeader className="p-3 md:p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base md:text-lg">
              <Settings className="w-5 h-5" />
              Pick Workflow Settings
            </CardTitle>
            <div className="w-full sm:w-64">
              <Select value={selectedWarehouseId} onValueChange={setSelectedWarehouseId}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Select warehouse..." />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((wh) => (
                    <SelectItem key={wh.id} value={wh.id.toString()}>
                      {wh.name} ({wh.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-3 md:p-6 space-y-4 md:space-y-6">
          {settingsLoading ? (
            <div className="flex justify-center p-8">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : warehouses.length === 0 ? (
            <div className="text-center p-8 text-muted-foreground">
              <Warehouse className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p>No warehouses configured. Add warehouses from the Warehouses page first.</p>
            </div>
          ) : !selectedWarehouseData ? (
            <div className="text-center p-8 text-muted-foreground">
              <Warehouse className="w-12 h-12 mx-auto mb-2 opacity-50" />
              <p>Select a warehouse to configure its pick settings.</p>
            </div>
          ) : (
            <>
              {/* Post-Pick Status */}
              <div className="space-y-4">
                <div>
                  <Label className="text-sm md:text-base font-semibold">After All Items Picked</Label>
                  <p className="text-xs md:text-sm text-muted-foreground mb-3">
                    What happens to an order after every item has been picked?
                  </p>
                  <div className="grid gap-3">
                    <label className={`flex items-start gap-3 p-3 md:p-4 border rounded-lg cursor-pointer hover:bg-muted/50 ${form.postPickStatus === 'ready_to_ship' ? 'border-primary bg-primary/5' : ''}`}>
                      <input
                        type="radio"
                        name="postPickStatus"
                        value="ready_to_ship"
                        checked={form.postPickStatus === "ready_to_ship"}
                        onChange={(e) => setForm({ ...form, postPickStatus: e.target.value })}
                        className="mt-1 h-5 w-5"
                      />
                      <div>
                        <div className="font-medium text-sm md:text-base flex items-center gap-2">
                          <PackageCheck className="w-4 h-4" />
                          Ready to Ship
                          <Badge variant="secondary" className="text-xs">Current</Badge>
                        </div>
                        <div className="text-xs md:text-sm text-muted-foreground">
                          Skip packing — order goes straight to shipping queue. Best for simple operations where packing is done at the pick station.
                        </div>
                      </div>
                    </label>
                    <label className={`flex items-start gap-3 p-3 md:p-4 border rounded-lg cursor-pointer hover:bg-muted/50 ${form.postPickStatus === 'picked' ? 'border-primary bg-primary/5' : ''}`}>
                      <input
                        type="radio"
                        name="postPickStatus"
                        value="picked"
                        checked={form.postPickStatus === "picked"}
                        onChange={(e) => setForm({ ...form, postPickStatus: e.target.value })}
                        className="mt-1 h-5 w-5"
                      />
                      <div>
                        <div className="font-medium text-sm md:text-base flex items-center gap-2">
                          <Layers className="w-4 h-4" />
                          Send to Pack Station
                          <Badge variant="outline" className="text-xs">Future</Badge>
                        </div>
                        <div className="text-xs md:text-sm text-muted-foreground">
                          Order moves to a pack queue where items are verified, boxed, and labeled before shipping.
                        </div>
                      </div>
                    </label>
                    <label className={`flex items-start gap-3 p-3 md:p-4 border rounded-lg cursor-pointer hover:bg-muted/50 ${form.postPickStatus === 'staged' ? 'border-primary bg-primary/5' : ''}`}>
                      <input
                        type="radio"
                        name="postPickStatus"
                        value="staged"
                        checked={form.postPickStatus === "staged"}
                        onChange={(e) => setForm({ ...form, postPickStatus: e.target.value })}
                        className="mt-1 h-5 w-5"
                      />
                      <div>
                        <div className="font-medium text-sm md:text-base flex items-center gap-2">
                          <Warehouse className="w-4 h-4" />
                          Stage for Consolidation
                          <Badge variant="outline" className="text-xs">Future</Badge>
                        </div>
                        <div className="text-xs md:text-sm text-muted-foreground">
                          Order is staged in a holding area for consolidated shipments or route-based loading.
                        </div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Pick Mode */}
                <div className="pt-4 border-t">
                  <Label className="text-sm md:text-base font-semibold">Pick Mode</Label>
                  <p className="text-xs md:text-sm text-muted-foreground mb-3">
                    How are orders assigned to pickers?
                  </p>
                  <div className="grid gap-3">
                    <label className={`flex items-start gap-3 p-3 md:p-4 border rounded-lg cursor-pointer hover:bg-muted/50 ${form.pickMode === 'single_order' ? 'border-primary bg-primary/5' : ''}`}>
                      <input
                        type="radio"
                        name="pickMode"
                        value="single_order"
                        checked={form.pickMode === "single_order"}
                        onChange={(e) => setForm({ ...form, pickMode: e.target.value })}
                        className="mt-1 h-5 w-5"
                      />
                      <div>
                        <div className="font-medium text-sm md:text-base flex items-center gap-2">
                          Single Order
                          <Badge variant="secondary" className="text-xs">Current</Badge>
                        </div>
                        <div className="text-xs md:text-sm text-muted-foreground">
                          Picker claims one order at a time and picks all items before moving to the next.
                        </div>
                      </div>
                    </label>
                    <label className={`flex items-start gap-3 p-3 md:p-4 border rounded-lg cursor-pointer hover:bg-muted/50 ${form.pickMode === 'batch' ? 'border-primary bg-primary/5' : ''}`}>
                      <input
                        type="radio"
                        name="pickMode"
                        value="batch"
                        checked={form.pickMode === "batch"}
                        onChange={(e) => setForm({ ...form, pickMode: e.target.value })}
                        className="mt-1 h-5 w-5"
                      />
                      <div>
                        <div className="font-medium text-sm md:text-base flex items-center gap-2">
                          Batch Pick
                          <Badge variant="outline" className="text-xs">Future</Badge>
                        </div>
                        <div className="text-xs md:text-sm text-muted-foreground">
                          Picker collects items for multiple orders in a single pass through the warehouse, then sorts at a pack station.
                        </div>
                      </div>
                    </label>
                    <label className={`flex items-start gap-3 p-3 md:p-4 border rounded-lg cursor-pointer hover:bg-muted/50 ${form.pickMode === 'wave' ? 'border-primary bg-primary/5' : ''}`}>
                      <input
                        type="radio"
                        name="pickMode"
                        value="wave"
                        checked={form.pickMode === "wave"}
                        onChange={(e) => setForm({ ...form, pickMode: e.target.value })}
                        className="mt-1 h-5 w-5"
                      />
                      <div>
                        <div className="font-medium text-sm md:text-base flex items-center gap-2">
                          Wave Pick
                          <Badge variant="outline" className="text-xs">Future</Badge>
                        </div>
                        <div className="text-xs md:text-sm text-muted-foreground">
                          Orders are grouped into waves by carrier, zone, or SLA. The wave is released as a unit and divided among pickers.
                        </div>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Scanner Requirement */}
                <div className="pt-4 border-t">
                  <Label className="text-sm md:text-base font-semibold">Scanner Requirement</Label>
                  <p className="text-xs md:text-sm text-muted-foreground mb-3">
                    Must pickers scan item barcodes to confirm picks?
                  </p>
                  <Select
                    value={form.requireScanConfirm}
                    onValueChange={(v) => setForm({ ...form, requireScanConfirm: v })}
                  >
                    <SelectTrigger className="w-full sm:w-80 h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Optional — pickers can tap or scan</SelectItem>
                      <SelectItem value="1">Required — barcode scan mandatory for each item</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Operational Defaults */}
              <div className="pt-4 border-t">
                <Label className="text-sm md:text-base font-semibold">Operational Defaults</Label>
                <p className="text-xs md:text-sm text-muted-foreground mb-3">
                  Batch sizing and order release timing for this warehouse
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="pickingBatchSize" className="text-xs md:text-sm">Batch Size</Label>
                    <Input
                      id="pickingBatchSize"
                      type="number"
                      className="w-full h-10"
                      value={form.pickingBatchSize}
                      onChange={(e) => setForm({ ...form, pickingBatchSize: e.target.value })}
                      min="1"
                      max="100"
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">Maximum orders in a single picking batch</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="autoReleaseDelayMinutes" className="text-xs md:text-sm">Auto-Release Delay (minutes)</Label>
                    <Input
                      id="autoReleaseDelayMinutes"
                      type="number"
                      className="w-full h-10"
                      value={form.autoReleaseDelayMinutes}
                      onChange={(e) => setForm({ ...form, autoReleaseDelayMinutes: e.target.value })}
                      min="1"
                      max="240"
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">Time before unclaimed orders are released back to queue</p>
                  </div>
                </div>
              </div>

              {/* Info callout */}
              <div className="flex items-start gap-3 p-3 md:p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800">
                <Info className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
                <div className="text-xs md:text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">These settings control the pick workflow for this warehouse.</span>{" "}
                  Options marked "Future" are saved but will take effect when the corresponding module (Pack Station, Wave Planning) is built.
                  Replenishment settings are managed on the{" "}
                  <span className="font-medium">Replenishment</span> page.
                </div>
              </div>

              {/* Save */}
              <div className="flex justify-end pt-4 border-t">
                <Button
                  className="w-full sm:w-auto min-h-[44px]"
                  onClick={() => saveMutation.mutate({
                    postPickStatus: form.postPickStatus,
                    pickMode: form.pickMode,
                    requireScanConfirm: parseInt(form.requireScanConfirm) || 0,
                    pickingBatchSize: parseInt(form.pickingBatchSize) || 20,
                    autoReleaseDelayMinutes: parseInt(form.autoReleaseDelayMinutes) || 30,
                  })}
                  disabled={saveMutation.isPending}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Save Pick Settings
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
