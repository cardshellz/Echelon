import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  Check,
  Loader2,
  PackageCheck,
  Plus,
  RotateCcw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useLocation, useSearch } from "wouter";
import type { RecipeType } from "@/features/inventory-builds/build-recipe-model";
type RecipeComponent = {
  id: number;
  componentVariantId: number;
  componentProductId: number;
  componentUnitsPerVariant: number;
  sku: string | null;
  name: string;
  qtyPerBuild: number;
};

type BuildRecipe = {
  id: number;
  code: string;
  name: string;
  version: number;
  status: string;
  recipeType: RecipeType;
  outputVariantId: number;
  outputProductId: number;
  outputUnitsPerVariant: number;
  outputSku: string | null;
  outputName: string;
  outputQty: number;
  notes: string | null;
  components: RecipeComponent[];
};

type BuildOrderComponent = RecipeComponent & {
  plannedQty: number;
  consumedQty: number;
  reservedQty: number;
  sourceLocationId: number | null;
  sourceLocationCode: string | null;
};

type BuildRun = {
  id: number;
  runNumber: number;
  status: string;
  buildsCompleted: number;
  outputQty: number;
  outputQtyOnHand: number;
  totalComponentCostMills: string;
  postedAt: string | null;
  reversalId: number | null;
  reversalReason: string | null;
  reversedAt: string | null;
  canReverse: boolean;
  reversalBlocker: string | null;
};

type BuildOrder = {
  id: number;
  systemNumber: string;
  recipeId: number;
  recipeCode: string;
  recipeVersion: number;
  recipeType: RecipeType;
  outputVariantId: number;
  outputProductId: number;
  outputUnitsPerVariant: number;
  outputSku: string | null;
  outputName: string;
  outputQtyPerBuild: number;
  plannedBuilds: number;
  completedBuilds: number;
  remainingBuilds: number;
  warehouseId: number;
  warehouseName: string;
  outputLocationId: number;
  outputLocationCode: string;
  status: string;
  totalComponentCostMills: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  failureCount: number;
  lastFailureAt: string | null;
  cancellationReason: string | null;
  cancelledReservationQty: number | null;
  components: BuildOrderComponent[];
  runs: BuildRun[];
  createdAt: string;
};

type Warehouse = { id: number; name: string; code: string };
type WarehouseLocation = {
  id: number;
  code: string;
  name: string | null;
  warehouseId: number | null;
  isActive: number;
  locationType: string;
};
type VariantLocationLevel = {
  variantQty: number;
  reservedQty: number;
  location: WarehouseLocation | null;
};

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message ?? body?.error ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function statusBadge(status: string) {
  if (status === "completed") return <Badge className="bg-green-600">Completed</Badge>;
  if (status === "released") return <Badge className="bg-blue-600">Released</Badge>;
  if (status === "in_progress") return <Badge className="bg-amber-600">In progress</Badge>;
  if (status === "failed" || status === "cancelled") return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="secondary">Draft</Badge>;
}

function formatTotalMills(value: string | null): string {
  if (value == null) return "-";
  const mills = BigInt(value);
  const dollars = mills / BigInt(10000);
  const fraction = (mills % BigInt(10000)).toString().padStart(4, "0");
  return `$${dollars}.${fraction}`;
}

function ComponentSourceSelect({ component, warehouseId, value, onChange }: {
  component: RecipeComponent;
  warehouseId: number;
  value: number | null;
  onChange: (locationId: number) => void;
}) {
  const { data = [], isLoading } = useQuery<VariantLocationLevel[]>({
    queryKey: ["/api/inventory/variants", component.componentVariantId, "build-source", warehouseId],
    queryFn: async () => responseJson<VariantLocationLevel[]>(await fetch(
      `/api/inventory/variants/${component.componentVariantId}/locations`,
      { credentials: "include" },
    )),
    enabled: warehouseId > 0,
  });
  const locations = data
    .filter((level) => level.location?.warehouseId === warehouseId && level.location.isActive === 1)
    .map((level) => ({
      id: level.location!.id,
      code: level.location!.code,
      available: level.variantQty - level.reservedQty,
    }))
    .filter((location) => location.available > 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  return (
    <Select value={value == null ? "" : String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger><SelectValue placeholder={isLoading ? "Loading..." : "Select source"} /></SelectTrigger>
      <SelectContent>
        {locations.map((location) => (
          <SelectItem key={location.id} value={String(location.id)}>
            {location.code} ({location.available} available)
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Builds() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const [activeBuildsTab, setActiveBuildsTab] = useState<"orders" | "recipes">(
    () => new URLSearchParams(search).get("tab") === "recipes" ? "recipes" : "orders",
  );
  const [orderOpen, setOrderOpen] = useState(false);
  const [executeOrder, setExecuteOrder] = useState<BuildOrder | null>(null);
  const [executeBuilds, setExecuteBuilds] = useState("1");
  const [executeCommandKey, setExecuteCommandKey] = useState("");
  const [cancelOrder, setCancelOrder] = useState<BuildOrder | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [reverseSelection, setReverseSelection] = useState<{ order: BuildOrder; run: BuildRun } | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseCommandKey, setReverseCommandKey] = useState("");
  const [selectedRecipeId, setSelectedRecipeId] = useState<number | null>(null);
  const [plannedBuilds, setPlannedBuilds] = useState("1");
  const [warehouseId, setWarehouseId] = useState<number | null>(null);
  const [outputLocationId, setOutputLocationId] = useState<number | null>(null);
  const [sourceLocations, setSourceLocations] = useState<Record<number, number>>({});
  const [orderCommandKey, setOrderCommandKey] = useState("");

  const { data: recipes = [], isLoading: recipesLoading } = useQuery<BuildRecipe[]>({
    queryKey: ["/api/inventory/build-recipes"],
  });
  const { data: orders = [], isLoading: ordersLoading } = useQuery<BuildOrder[]>({
    queryKey: ["/api/inventory/build-orders"],
  });
  const { data: warehouses = [] } = useQuery<Warehouse[]>({ queryKey: ["/api/warehouses"] });
  const { data: allLocations = [] } = useQuery<WarehouseLocation[]>({ queryKey: ["/api/warehouse/locations"] });

  const selectedRecipe = recipes.find((recipe) => recipe.id === selectedRecipeId) ?? null;
  const outputLocations = useMemo(() => allLocations
    .filter((location) => location.warehouseId === warehouseId && location.isActive === 1)
    .sort((a, b) => a.code.localeCompare(b.code)), [allLocations, warehouseId]);

  const resetOrder = () => {
    setSelectedRecipeId(null); setPlannedBuilds("1"); setWarehouseId(null);
    setOutputLocationId(null); setSourceLocations({}); setOrderCommandKey(crypto.randomUUID());
  };
  const openExecuteDialog = (order: BuildOrder) => {
    setExecuteOrder(order);
    setExecuteBuilds(String(order.remainingBuilds));
    setExecuteCommandKey(crypto.randomUUID());
  };
  const openCancelDialog = (order: BuildOrder) => {
    setCancelOrder(order);
    setCancelReason("");
  };
  const openReverseDialog = (order: BuildOrder, run: BuildRun) => {
    setReverseSelection({ order, run });
    setReverseReason("");
    setReverseCommandKey(crypto.randomUUID());
  };
  const refreshBuildData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/build-orders"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/levels"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/summary"] }),
    ]);
  };

  const createOrder = useMutation({
    mutationFn: async () => responseJson(await fetch("/api/inventory/build-orders", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "Idempotency-Key": orderCommandKey },
      body: JSON.stringify({
        recipeId: selectedRecipeId,
        plannedBuilds: Number(plannedBuilds),
        warehouseId,
        outputLocationId,
        sourceLocations: selectedRecipe?.components.map((component) => ({
          componentVariantId: component.componentVariantId,
          sourceLocationId: sourceLocations[component.componentVariantId],
        })) ?? [],
      }),
    })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/inventory/build-orders"] });
      setOrderOpen(false); resetOrder();
      toast({ title: "Build order created" });
    },
    onError: (error: Error) => toast({ title: "Build order failed", description: error.message, variant: "destructive" }),
  });

  const releaseBuild = useMutation({
    mutationFn: async (id: number) => responseJson(
      await fetch(`/api/inventory/build-orders/${id}/release`, {
        method: "POST",
        credentials: "include",
      }),
    ),
    onSuccess: async () => {
      await refreshBuildData();
      toast({ title: "Build released", description: "Component inventory is reserved for this build." });
    },
    onError: (error: Error) => toast({
      title: "Build release failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  const executeBuild = useMutation({
    mutationFn: async () => {
      if (!executeOrder) throw new Error("No build order is selected");
      return responseJson(await fetch(`/api/inventory/build-orders/${executeOrder.id}/execute`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": executeCommandKey,
        },
        body: JSON.stringify({ buildsCompleted: Number(executeBuilds) }),
      }));
    },
    onSuccess: async () => {
      await refreshBuildData();
      setExecuteOrder(null);
      toast({ title: "Build run posted" });
    },
    onError: (error: Error) => toast({
      title: "Build posting failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  const cancelBuild = useMutation({
    mutationFn: async () => {
      if (!cancelOrder) throw new Error("No build order is selected");
      return responseJson(await fetch(`/api/inventory/build-orders/${cancelOrder.id}/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason }),
      }));
    },
    onSuccess: async () => {
      await refreshBuildData();
      setCancelOrder(null);
      toast({ title: "Remaining build work cancelled" });
    },
    onError: (error: Error) => toast({
      title: "Build cancellation failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  const reverseBuild = useMutation({
    mutationFn: async () => {
      if (!reverseSelection) throw new Error("No build run is selected");
      const { order, run } = reverseSelection;
      return responseJson(await fetch(
        `/api/inventory/build-orders/${order.id}/runs/${run.id}/reverse`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": reverseCommandKey,
          },
          body: JSON.stringify({ reason: reverseReason }),
        },
      ));
    },
    onSuccess: async () => {
      await refreshBuildData();
      setReverseSelection(null);
      toast({ title: "Build run reversed" });
    },
    onError: (error: Error) => toast({
      title: "Build reversal failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  const orderValid = selectedRecipe && warehouseId && outputLocationId
    && Number.isSafeInteger(Number(plannedBuilds)) && Number(plannedBuilds) > 0
    && selectedRecipe.components.every((component) => sourceLocations[component.componentVariantId]);
  const executeBuildCount = Number(executeBuilds);
  const executeValid = executeOrder != null
    && Number.isSafeInteger(executeBuildCount)
    && executeBuildCount > 0
    && executeBuildCount <= executeOrder.remainingBuilds;
  const cancelValid = cancelReason.trim().length > 0 && cancelReason.trim().length <= 2000;
  const reverseValid = reverseReason.trim().length > 0 && reverseReason.trim().length <= 2000;

  return (
    <div className="space-y-5 p-3 md:p-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold">Inventory Builds</h1>
          <p className="text-sm text-muted-foreground">Convert component inventory into sellable packs, cases, and assembled products.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate("/inventory/builds/recipes/new")}><Plus className="mr-2 h-4 w-4" />Recipe</Button>
          <Button onClick={() => { resetOrder(); setOrderOpen(true); }} disabled={!recipes.some((recipe) => recipe.status === "active")}>
            <PackageCheck className="mr-2 h-4 w-4" />Create Build
          </Button>
        </div>
      </div>

      <Tabs
        value={activeBuildsTab}
        onValueChange={(value) => {
          if (value === "orders" || value === "recipes") setActiveBuildsTab(value);
        }}
      >
        <TabsList>
          <TabsTrigger value="orders">Build Orders ({orders.length})</TabsTrigger>
          <TabsTrigger value="recipes">Recipes ({recipes.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="orders" className="mt-4">
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Build</TableHead><TableHead>Output</TableHead><TableHead>Components</TableHead>
                <TableHead>Warehouse</TableHead><TableHead>Progress</TableHead><TableHead>Status</TableHead>
                <TableHead>Cost</TableHead><TableHead className="text-right">Actions</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {ordersLoading && <TableRow><TableCell colSpan={8}>Loading builds...</TableCell></TableRow>}
                {!ordersLoading && orders.length === 0 && <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No build orders yet.</TableCell></TableRow>}
                {orders.map((order) => {
                  const latestReversibleRun = order.runs.find((run) => run.canReverse);
                  const canContinue = ["released", "in_progress", "failed"].includes(order.status)
                    && order.remainingBuilds > 0;
                  const canCancel = ["draft", "released", "in_progress", "failed"].includes(order.status);
                  return (
                    <TableRow key={order.id}>
                      <TableCell>
                        <div className="font-medium">{order.systemNumber}</div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {order.recipeCode} v{order.recipeVersion}<Badge variant="outline">{order.recipeType}</Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>{order.outputSku ?? order.outputName}</div>
                        <div className="text-xs text-muted-foreground">
                          {order.outputQtyPerBuild * order.plannedBuilds} planned units to {order.outputLocationCode}
                        </div>
                      </TableCell>
                      <TableCell>
                        {order.components.map((component) => (
                          <div key={component.id} className="text-xs">
                            {component.consumedQty}/{component.plannedQty} consumed, {component.reservedQty} reserved
                            {" "}{component.sku ?? component.name} from {component.sourceLocationCode ?? "-"}
                          </div>
                        ))}
                      </TableCell>
                      <TableCell>{order.warehouseName}</TableCell>
                      <TableCell>
                        <div className="font-medium">{order.completedBuilds} / {order.plannedBuilds} builds</div>
                        <div className="text-xs text-muted-foreground">
                          {order.remainingBuilds} remaining, {order.runs.length} run{order.runs.length === 1 ? "" : "s"}
                        </div>
                      </TableCell>
                      <TableCell>
                        {statusBadge(order.status)}
                        {order.failureMessage && (
                          <div className="mt-1 max-w-56 text-xs text-red-700" title={order.failureCode ?? undefined}>
                            {order.failureMessage}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{formatTotalMills(order.totalComponentCostMills)}</TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {order.status === "draft" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => releaseBuild.mutate(order.id)}
                              disabled={releaseBuild.isPending}
                            >
                              Release
                            </Button>
                          )}
                          {canContinue && (
                            <Button size="sm" onClick={() => openExecuteDialog(order)}>
                              {order.status === "failed" ? "Retry" : "Post run"}
                            </Button>
                          )}
                          {latestReversibleRun && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openReverseDialog(order, latestReversibleRun)}
                              title={"Reverse run " + latestReversibleRun.runNumber}
                            >
                              <RotateCcw className="mr-1 h-4 w-4" />Reverse
                            </Button>
                          )}
                          {canCancel && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => openCancelDialog(order)}
                              title={order.completedBuilds > 0 ? "Cancel remaining build work" : "Cancel build order"}
                            >
                              <Ban className="h-4 w-4" />
                            </Button>
                          )}
                          {order.status === "completed" && !latestReversibleRun && (
                            <span className="inline-flex items-center gap-1 text-sm text-green-700">
                              <Check className="h-4 w-4" />Posted
                            </span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
        <TabsContent value="recipes" className="mt-4">
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader><TableRow><TableHead>Recipe</TableHead><TableHead>Output</TableHead><TableHead>Components per build</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {recipesLoading && <TableRow><TableCell colSpan={4}>Loading recipes...</TableCell></TableRow>}
                {!recipesLoading && recipes.length === 0 && <TableRow><TableCell colSpan={4} className="py-10 text-center text-muted-foreground">Create a recipe to define how component units become an output SKU.</TableCell></TableRow>}
                {recipes.map((recipe) => <TableRow key={recipe.id}>
                  <TableCell><div className="font-medium">{recipe.code}</div><div className="flex items-center gap-2 text-xs text-muted-foreground">{recipe.name} / v{recipe.version}<Badge variant="outline">{recipe.recipeType}</Badge></div></TableCell>
                  <TableCell>{recipe.outputQty} x {recipe.outputSku ?? recipe.outputName}</TableCell>
                  <TableCell>{recipe.components.map((component) => <div key={component.id} className="text-xs">{component.qtyPerBuild} x {component.sku ?? component.name}</div>)}</TableCell>
                  <TableCell><Badge variant={recipe.status === "active" ? "default" : "secondary"}>{recipe.status}</Badge></TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={orderOpen} onOpenChange={setOrderOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader><DialogTitle>Create build order</DialogTitle></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><Label>Recipe</Label><Select value={selectedRecipeId == null ? "" : String(selectedRecipeId)} onValueChange={(value) => { setSelectedRecipeId(Number(value)); setSourceLocations({}); }}><SelectTrigger><SelectValue placeholder="Select active recipe" /></SelectTrigger><SelectContent>{recipes.filter((recipe) => recipe.status === "active").map((recipe) => <SelectItem key={recipe.id} value={String(recipe.id)}>{recipe.code} v{recipe.version} - {recipe.outputSku ?? recipe.outputName}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Number of builds</Label><Input type="number" min="1" step="1" value={plannedBuilds} onChange={(e) => setPlannedBuilds(e.target.value)} /></div>
            <div><Label>Warehouse</Label><Select value={warehouseId == null ? "" : String(warehouseId)} onValueChange={(value) => { setWarehouseId(Number(value)); setOutputLocationId(null); setSourceLocations({}); }}><SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger><SelectContent>{warehouses.map((warehouse) => <SelectItem key={warehouse.id} value={String(warehouse.id)}>{warehouse.name}</SelectItem>)}</SelectContent></Select></div>
            <div className="sm:col-span-2"><Label>Output location</Label><Select value={outputLocationId == null ? "" : String(outputLocationId)} onValueChange={(value) => setOutputLocationId(Number(value))} disabled={!warehouseId}><SelectTrigger><SelectValue placeholder="Select output location" /></SelectTrigger><SelectContent>{outputLocations.map((location) => <SelectItem key={location.id} value={String(location.id)}>{location.code} {location.name ? `- ${location.name}` : ""}</SelectItem>)}</SelectContent></Select></div>
          </div>
          {selectedRecipe && warehouseId && <div className="space-y-3 border-t pt-4"><Label>Component source locations</Label>{selectedRecipe.components.map((component) => <div key={component.id} className="grid items-center gap-2 sm:grid-cols-[1fr_1fr]"><div><div className="text-sm font-medium">{component.sku ?? component.name}</div><div className="text-xs text-muted-foreground">Need {component.qtyPerBuild * Number(plannedBuilds || 0)} units</div></div><ComponentSourceSelect component={component} warehouseId={warehouseId} value={sourceLocations[component.componentVariantId] ?? null} onChange={(locationId) => setSourceLocations((current) => ({ ...current, [component.componentVariantId]: locationId }))} /></div>)}</div>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setOrderOpen(false)}>Cancel</Button><Button disabled={!orderValid || createOrder.isPending} onClick={() => createOrder.mutate()}>{createOrder.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create draft</Button></div>
        </DialogContent>
      </Dialog>

      <Dialog open={executeOrder != null} onOpenChange={(open) => !open && setExecuteOrder(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Post {executeOrder?.systemNumber} run</DialogTitle></DialogHeader>
          <div className="flex gap-3 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <p>Post only the quantity physically completed. This consumes reserved components and creates output inventory atomically.</p>
          </div>
          {executeOrder && (
            <div className="space-y-3">
              <div>
                <Label htmlFor="builds-completed">Completed builds</Label>
                <Input
                  id="builds-completed"
                  type="number"
                  min="1"
                  max={executeOrder.remainingBuilds}
                  step="1"
                  value={executeBuilds}
                  onChange={(event) => setExecuteBuilds(event.target.value)}
                />
                <div className="mt-1 text-xs text-muted-foreground">
                  {executeOrder.remainingBuilds} builds remain on this order.
                </div>
              </div>
              {executeValid && (
                <div className="space-y-1 text-sm">
                  <p><strong>Produce:</strong> {executeOrder.outputQtyPerBuild * executeBuildCount} {executeOrder.outputSku ?? executeOrder.outputName}</p>
                  {executeOrder.components.map((component) => (
                    <p key={component.id}>
                      <strong>Consume:</strong> {component.qtyPerBuild * executeBuildCount} {component.sku ?? component.name}
                      {" "}from {component.sourceLocationCode}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setExecuteOrder(null)}>Cancel</Button>
            <Button disabled={!executeValid || executeBuild.isPending} onClick={() => executeBuild.mutate()}>
              {executeBuild.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Post run
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOrder != null} onOpenChange={(open) => !open && setCancelOrder(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancel {cancelOrder?.systemNumber}</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground">
            Posted runs remain immutable. This cancels only unfinished work and releases its component reservations.
          </div>
          <div>
            <Label htmlFor="build-cancellation-reason">Reason</Label>
            <Textarea
              id="build-cancellation-reason"
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              maxLength={2000}
              placeholder="Why is the remaining build work being cancelled?"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCancelOrder(null)}>Keep build</Button>
            <Button
              variant="destructive"
              disabled={!cancelValid || cancelBuild.isPending}
              onClick={() => cancelBuild.mutate()}
            >
              {cancelBuild.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Cancel remaining
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reverseSelection != null} onOpenChange={(open) => !open && setReverseSelection(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Reverse {reverseSelection?.order.systemNumber} run {reverseSelection?.run.runNumber}
            </DialogTitle>
          </DialogHeader>
          <div className="flex gap-3 border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <p>The server verified this is the latest posted run and its output is untouched. Reversal removes that output and restores the exact component lots as reserved.</p>
          </div>
          {reverseSelection && (
            <div className="text-sm">
              {reverseSelection.run.buildsCompleted} builds, {reverseSelection.run.outputQty} output units
            </div>
          )}
          <div>
            <Label htmlFor="build-reversal-reason">Correction reason</Label>
            <Textarea
              id="build-reversal-reason"
              value={reverseReason}
              onChange={(event) => setReverseReason(event.target.value)}
              maxLength={2000}
              placeholder="Why must this posted run be reversed?"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setReverseSelection(null)}>Keep posted</Button>
            <Button
              variant="destructive"
              disabled={!reverseValid || reverseBuild.isPending}
              onClick={() => reverseBuild.mutate()}
            >
              {reverseBuild.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Reverse run
            </Button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
