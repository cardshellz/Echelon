import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { PricingProgramsTab } from "@/components/shipping/pricing-programs/PricingProgramsTab";
import {
  Archive,
  Box,
  CircleCheck,
  FileSpreadsheet,
  Loader2,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  Ruler,
  Save,
  Search,
  Trash2,
  Truck,
} from "lucide-react";

// ===== Types (API contract: /api/shipping/admin/*) =====

interface ShippingBox {
  id: number;
  code: string;
  name: string;
  kind: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  tareWeightGrams: number;
  maxWeightGrams: number | null;
  costCents: number;
  fillFactorBps: number;
  isActive: boolean;
  warehouseIds: number[];
}

interface ShippingAdminConfig {
  boxes: ShippingBox[];
  dimsCoverage: { variantsTotal: number; variantsWithDims: number };
}

interface VariantAttrsRow {
  productVariantId: number;
  sku: string | null;
  name: string;
  productName: string;
  shipsInOwnContainer: boolean;
  siocSuggested: boolean;
  riderEligible: boolean;
  riderVoidCm3: number | null;
  riderVoidMaxWeightGrams: number | null;
  riderVoidMaxItems: number | null;
  notes: string | null;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

interface SiocSuggestionRow {
  productVariantId: number;
  sku: string | null;
  name: string;
  unitsPerVariant: number;
  hierarchyLevel: number;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

interface WarehouseType {
  id: number;
  name: string;
  code: string;
}


// ===== Unit conversion helpers (copied from ProductDetail.tsx — keep in sync) =====

const GRAMS_PER_POUND = 453.59237;
const MILLIMETERS_PER_INCH = 25.4;
// Derived from the constants above — do not introduce new base constants.
const GRAMS_PER_OUNCE = GRAMS_PER_POUND / 16;
const CUBIC_CM_PER_CUBIC_INCH = Math.pow(MILLIMETERS_PER_INCH / 10, 3);

function formatMeasurementInput(value: number | null | undefined, divisor: number): string {
  if (value === null || value === undefined) return "";
  return (value / divisor).toFixed(3).replace(/\.?0+$/, "");
}

function parsePositiveMeasurement(rawValue: string, label: string): number | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
  return parsed;
}

function toStoredMeasurement(rawValue: string, label: string, multiplier: number): number | null {
  const parsed = parsePositiveMeasurement(rawValue, label);
  if (parsed === null) return null;

  const storedValue = Math.round(parsed * multiplier);
  if (!Number.isInteger(storedValue) || storedValue <= 0) {
    throw new Error(`${label} is too small to store.`);
  }
  return storedValue;
}

// ===== Display helpers =====

function formatInches(mm: number | null | undefined): string {
  return formatMeasurementInput(mm, MILLIMETERS_PER_INCH);
}

function formatDimsIn(lengthMm: number | null, widthMm: number | null, heightMm: number | null): string {
  if (!lengthMm || !widthMm || !heightMm) return "—";
  return `${formatInches(lengthMm)} × ${formatInches(widthMm)} × ${formatInches(heightMm)} in`;
}

function formatWeight(grams: number | null | undefined): string {
  if (grams === null || grams === undefined) return "—";
  if (grams >= GRAMS_PER_POUND) return `${formatMeasurementInput(grams, GRAMS_PER_POUND)} lb`;
  return `${formatMeasurementInput(grams, GRAMS_PER_OUNCE)} oz`;
}

function formatCostUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatFillFactor(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

const HIERARCHY_LABELS: Record<number, string> = { 1: "Pack", 2: "Box", 3: "Case", 4: "Skid" };

function hierarchyLabel(level: number): string {
  return HIERARCHY_LABELS[level] || `Level ${level}`;
}

const BOX_KINDS = ["box", "mailer", "envelope"] as const;

// Every /api/shipping/admin/* query uses its full URL string as the query key,
// so mutations invalidate by URL-string prefix predicate (repo convention).
function invalidateShippingAdmin(queryClient: QueryClient) {
  queryClient.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/shipping/admin"),
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw apiErrorFromBody(body, res.status);
  }
  return res.json();
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw apiErrorFromBody(errBody, res.status);
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
    throw apiErrorFromBody(errBody, res.status);
  }
  return res.json();
}

async function deleteJson(url: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE", credentials: "include" });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw apiErrorFromBody(errBody, res.status);
  }
}

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly details: string[],
  ) {
    super(message);
  }
}

function apiErrorFromBody(body: unknown, status: number): ApiRequestError {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return new ApiRequestError(error, null, []);
    if (error && typeof error === "object") {
      const typed = error as { code?: unknown; message?: unknown; details?: unknown };
      return new ApiRequestError(
        typeof typed.message === "string" ? typed.message : `Request failed (${status})`,
        typeof typed.code === "string" ? typed.code : null,
        Array.isArray(typed.details) ? typed.details.filter((item): item is string => typeof item === "string") : [],
      );
    }
  }
  return new ApiRequestError(`Request failed (${status})`, null, []);
}

// ===== Box catalog =====

interface BoxPayload {
  id?: number;
  code: string;
  name: string;
  kind: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  tareWeightGrams: number;
  maxWeightGrams?: number;
  costCents: number;
  fillFactorBps: number;
  isActive: boolean;
  warehouseIds: number[];
}

interface BoxFormState {
  code: string;
  name: string;
  kind: string;
  lengthIn: string;
  widthIn: string;
  heightIn: string;
  tareOz: string;
  maxWeightLb: string;
  costUsd: string;
  fillFactorPct: string;
  isActive: boolean;
  warehouseIds: number[];
}

function emptyBoxForm(): BoxFormState {
  return {
    code: "",
    name: "",
    kind: "box",
    lengthIn: "",
    widthIn: "",
    heightIn: "",
    tareOz: "",
    maxWeightLb: "",
    costUsd: "",
    fillFactorPct: "100",
    isActive: true,
    warehouseIds: [],
  };
}

function boxFormFromBox(box: ShippingBox): BoxFormState {
  return {
    code: box.code,
    name: box.name,
    kind: box.kind,
    lengthIn: formatMeasurementInput(box.lengthMm, MILLIMETERS_PER_INCH),
    widthIn: formatMeasurementInput(box.widthMm, MILLIMETERS_PER_INCH),
    heightIn: formatMeasurementInput(box.heightMm, MILLIMETERS_PER_INCH),
    tareOz: formatMeasurementInput(box.tareWeightGrams || null, GRAMS_PER_OUNCE),
    maxWeightLb: formatMeasurementInput(box.maxWeightGrams, GRAMS_PER_POUND),
    costUsd: box.costCents ? (box.costCents / 100).toFixed(2) : "",
    fillFactorPct: formatMeasurementInput(box.fillFactorBps, 100) || "100",
    isActive: box.isActive,
    warehouseIds: box.warehouseIds || [],
  };
}

function buildBoxPayload(form: BoxFormState, editingId: number | null): BoxPayload {
  const code = form.code.trim();
  const name = form.name.trim();
  if (!code) throw new Error("Code is required.");
  if (!name) throw new Error("Name is required.");

  const lengthMm = toStoredMeasurement(form.lengthIn, "Inner length", MILLIMETERS_PER_INCH);
  const widthMm = toStoredMeasurement(form.widthIn, "Inner width", MILLIMETERS_PER_INCH);
  const heightMm = toStoredMeasurement(form.heightIn, "Inner height", MILLIMETERS_PER_INCH);
  if (lengthMm === null || widthMm === null || heightMm === null) {
    throw new Error("Inner dimensions (L × W × H) are required.");
  }

  const tareWeightGrams = form.tareOz.trim()
    ? toStoredMeasurement(form.tareOz, "Tare weight", GRAMS_PER_OUNCE)
    : 0;
  const maxWeightGrams = toStoredMeasurement(form.maxWeightLb, "Max weight", GRAMS_PER_POUND);

  const costTrimmed = form.costUsd.trim();
  const costParsed = costTrimmed ? Number(costTrimmed) : 0;
  if (!Number.isFinite(costParsed) || costParsed < 0) {
    throw new Error("Cost must be zero or greater.");
  }
  const costCents = Math.round(costParsed * 100);

  const fillParsed = Number(form.fillFactorPct.trim() || "0");
  if (!Number.isFinite(fillParsed) || fillParsed <= 0 || fillParsed > 100) {
    throw new Error("Fill factor must be between 0 and 100%.");
  }
  const fillFactorBps = Math.round(fillParsed * 100);

  return {
    ...(editingId !== null ? { id: editingId } : {}),
    code,
    name,
    kind: form.kind,
    lengthMm,
    widthMm,
    heightMm,
    tareWeightGrams: tareWeightGrams ?? 0,
    ...(maxWeightGrams !== null ? { maxWeightGrams } : {}),
    costCents,
    fillFactorBps,
    isActive: form.isActive,
    warehouseIds: form.warehouseIds,
  };
}

function boxToPayload(box: ShippingBox): BoxPayload {
  return {
    id: box.id,
    code: box.code,
    name: box.name,
    kind: box.kind,
    lengthMm: box.lengthMm,
    widthMm: box.widthMm,
    heightMm: box.heightMm,
    tareWeightGrams: box.tareWeightGrams,
    ...(box.maxWeightGrams !== null && box.maxWeightGrams !== undefined
      ? { maxWeightGrams: box.maxWeightGrams }
      : {}),
    costCents: box.costCents,
    fillFactorBps: box.fillFactorBps,
    isActive: box.isActive,
    warehouseIds: box.warehouseIds || [],
  };
}

function BoxCatalogTab({
  boxes,
  warehouses,
  isLoading,
}: {
  boxes: ShippingBox[];
  warehouses: WarehouseType[];
  isLoading: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBoxId, setEditingBoxId] = useState<number | null>(null);
  const [form, setForm] = useState<BoxFormState>(emptyBoxForm());

  const warehouseById = new Map(warehouses.map((w) => [w.id, w]));

  const saveBoxMutation = useMutation({
    mutationFn: (payload: BoxPayload) => putJson<{ box: ShippingBox }>("/api/shipping/admin/boxes", payload),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      setDialogOpen(false);
      toast({ title: "Box saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save box", description: e.message, variant: "destructive" });
    },
  });

  const toggleBoxMutation = useMutation({
    mutationFn: (payload: BoxPayload) => putJson<{ box: ShippingBox }>("/api/shipping/admin/boxes", payload),
    onSuccess: (_data, payload) => {
      invalidateShippingAdmin(queryClient);
      toast({ title: payload.isActive ? "Box activated" : "Box deactivated" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to update box", description: e.message, variant: "destructive" });
    },
  });

  const openCreate = () => {
    setEditingBoxId(null);
    setForm(emptyBoxForm());
    setDialogOpen(true);
  };

  const openEdit = (box: ShippingBox) => {
    setEditingBoxId(box.id);
    setForm(boxFormFromBox(box));
    setDialogOpen(true);
  };

  const handleSave = () => {
    try {
      saveBoxMutation.mutate(buildBoxPayload(form, editingBoxId));
    } catch (e) {
      toast({ title: "Invalid box", description: (e as Error).message, variant: "destructive" });
    }
  };

  const toggleWarehouse = (warehouseId: number, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      warehouseIds: checked
        ? [...prev.warehouseIds, warehouseId]
        : prev.warehouseIds.filter((id) => id !== warehouseId),
    }));
  };

  return (
    <Card>
      <CardHeader className="p-3 md:p-6 flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base md:text-lg">
            <Box className="w-5 h-5" />
            Box catalog
          </CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Containers the packing optimizer can choose from. Inner dimensions shown in inches.
          </CardDescription>
        </div>
        <Button size="sm" onClick={openCreate} className="min-h-[36px]">
          <Plus className="h-4 w-4 mr-1" />
          Add box
        </Button>
      </CardHeader>
      <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
        {isLoading ? (
          <div className="flex justify-center p-8">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : boxes.length === 0 ? (
          <div className="text-center p-8 text-muted-foreground">
            <Box className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p>No boxes yet. Add the boxes each warehouse stocks so the packing optimizer can use them.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Inner dims (in)</TableHead>
                  <TableHead>Tare</TableHead>
                  <TableHead>Max weight</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Fill</TableHead>
                  <TableHead>Warehouses</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {boxes.map((box) => (
                  <TableRow key={box.id} className={!box.isActive ? "opacity-60" : undefined}>
                    <TableCell className="font-mono text-xs font-medium">{box.code}</TableCell>
                    <TableCell className="text-sm">{box.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] capitalize">{box.kind}</Badge>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatDimsIn(box.lengthMm, box.widthMm, box.heightMm)}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{formatWeight(box.tareWeightGrams)}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap">{formatWeight(box.maxWeightGrams)}</TableCell>
                    <TableCell className="text-sm">{formatCostUsd(box.costCents)}</TableCell>
                    <TableCell className="text-sm">{formatFillFactor(box.fillFactorBps)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(box.warehouseIds || []).length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          box.warehouseIds.map((id) => (
                            <Badge key={id} variant="secondary" className="text-[10px]">
                              {warehouseById.get(id)?.code || `#${id}`}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={box.isActive}
                        disabled={toggleBoxMutation.isPending}
                        onCheckedChange={(checked) =>
                          toggleBoxMutation.mutate({ ...boxToPayload(box), isActive: checked === true })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(box)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingBoxId !== null ? "Edit Box" : "Add Box"}</DialogTitle>
            <DialogDescription className="sr-only">Form to add or edit a shipping box</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Code</Label>
                <Input
                  value={form.code}
                  onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value }))}
                  placeholder="BOX-12x9x4"
                  className="h-10 font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Kind</Label>
                <Select value={form.kind} onValueChange={(v) => setForm((prev) => ({ ...prev, kind: v }))}>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BOX_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind} className="capitalize">
                        {kind}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="12 × 9 × 4 shipper"
                className="h-10"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Inner length (in)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={form.lengthIn}
                  onChange={(e) => setForm((prev) => ({ ...prev, lengthIn: e.target.value }))}
                  placeholder="12"
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Inner width (in)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={form.widthIn}
                  onChange={(e) => setForm((prev) => ({ ...prev, widthIn: e.target.value }))}
                  placeholder="9"
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Inner height (in)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={form.heightIn}
                  onChange={(e) => setForm((prev) => ({ ...prev, heightIn: e.target.value }))}
                  placeholder="4"
                  className="h-10"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Tare weight (oz)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={form.tareOz}
                  onChange={(e) => setForm((prev) => ({ ...prev, tareOz: e.target.value }))}
                  placeholder="5"
                  className="h-10"
                />
                <p className="text-xs text-muted-foreground">Weight of the empty container</p>
              </div>
              <div className="space-y-1.5">
                <Label>Max weight (lb)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.001"
                  value={form.maxWeightLb}
                  onChange={(e) => setForm((prev) => ({ ...prev, maxWeightLb: e.target.value }))}
                  placeholder="Optional"
                  className="h-10"
                />
                <p className="text-xs text-muted-foreground">Blank = no limit</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Cost ($)</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.costUsd}
                  onChange={(e) => setForm((prev) => ({ ...prev, costUsd: e.target.value }))}
                  placeholder="0.42"
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Fill factor (%)</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={form.fillFactorPct}
                  onChange={(e) => setForm((prev) => ({ ...prev, fillFactorPct: e.target.value }))}
                  placeholder="85"
                  className="h-10"
                />
                <p className="text-xs text-muted-foreground">Usable share of the inner volume</p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Stocked warehouses</Label>
              {warehouses.length === 0 ? (
                <p className="text-xs text-muted-foreground">No warehouses configured.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md border p-3">
                  {warehouses.map((wh) => (
                    <div key={wh.id} className="flex items-center gap-2">
                      <Checkbox
                        id={`box-wh-${wh.id}`}
                        checked={form.warehouseIds.includes(wh.id)}
                        onCheckedChange={(checked) => toggleWarehouse(wh.id, checked === true)}
                      />
                      <label htmlFor={`box-wh-${wh.id}`} className="text-sm cursor-pointer">
                        {wh.name} <span className="text-muted-foreground">({wh.code})</span>
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="box-active"
                checked={form.isActive}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, isActive: checked === true }))}
              />
              <Label htmlFor="box-active" className="cursor-pointer">Active</Label>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saveBoxMutation.isPending}>
              {saveBoxMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              {editingBoxId !== null ? "Save Changes" : "Create Box"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}


// ===== Packing attributes =====

interface AttrsPayload {
  productVariantId: number;
  shipsInOwnContainer: boolean;
  riderEligible: boolean;
  riderVoidCm3?: number | null;
  riderVoidMaxWeightGrams?: number | null;
  riderVoidMaxItems?: number | null;
  notes?: string | null;
}

interface AttrsFormState {
  shipsInOwnContainer: boolean;
  riderEligible: boolean;
  riderVoidIn3: string;
  riderVoidMaxWeightOz: string;
  riderVoidMaxItems: string;
  notes: string;
}

function attrsFormFromRow(row: VariantAttrsRow): AttrsFormState {
  return {
    shipsInOwnContainer: row.shipsInOwnContainer,
    riderEligible: row.riderEligible,
    riderVoidIn3: formatMeasurementInput(row.riderVoidCm3, CUBIC_CM_PER_CUBIC_INCH),
    riderVoidMaxWeightOz: formatMeasurementInput(row.riderVoidMaxWeightGrams, GRAMS_PER_OUNCE),
    riderVoidMaxItems: row.riderVoidMaxItems !== null ? String(row.riderVoidMaxItems) : "",
    notes: row.notes || "",
  };
}

function buildAttrsPayload(productVariantId: number, form: AttrsFormState): AttrsPayload {
  const riderVoidCm3 = form.shipsInOwnContainer
    ? toStoredMeasurement(form.riderVoidIn3, "Rider void volume", CUBIC_CM_PER_CUBIC_INCH)
    : null;
  const riderVoidMaxWeightGrams = form.shipsInOwnContainer
    ? toStoredMeasurement(form.riderVoidMaxWeightOz, "Rider void max weight", GRAMS_PER_OUNCE)
    : null;
  let riderVoidMaxItems: number | null = null;
  if (form.shipsInOwnContainer && form.riderVoidMaxItems.trim()) {
    const parsed = parseInt(form.riderVoidMaxItems.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("Rider void max items must be a positive whole number.");
    }
    riderVoidMaxItems = parsed;
  }
  return {
    productVariantId,
    shipsInOwnContainer: form.shipsInOwnContainer,
    riderEligible: form.riderEligible,
    riderVoidCm3,
    riderVoidMaxWeightGrams,
    riderVoidMaxItems,
    notes: form.notes.trim() || null,
  };
}

function dimsSummary(row: { weightGrams: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null }): string {
  const weight = row.weightGrams ? formatWeight(row.weightGrams) : null;
  const dims =
    row.lengthMm && row.widthMm && row.heightMm
      ? formatDimsIn(row.lengthMm, row.widthMm, row.heightMm)
      : null;
  if (!weight && !dims) return "No dims";
  return [weight, dims].filter(Boolean).join(" · ");
}

function PackingAttributesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [editingRow, setEditingRow] = useState<VariantAttrsRow | null>(null);
  const [form, setForm] = useState<AttrsFormState | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const attrsUrl = `/api/shipping/admin/variant-attrs?search=${encodeURIComponent(search)}`;
  const { data: attrsData, isLoading: attrsLoading } = useQuery<{ rows: VariantAttrsRow[] }>({
    queryKey: [attrsUrl],
    queryFn: () => fetchJson<{ rows: VariantAttrsRow[] }>(attrsUrl),
    enabled: search.length > 0,
  });

  const { data: suggestionsData, isLoading: suggestionsLoading } = useQuery<{ rows: SiocSuggestionRow[] }>({
    queryKey: ["/api/shipping/admin/sioc-suggestions"],
    queryFn: () => fetchJson<{ rows: SiocSuggestionRow[] }>("/api/shipping/admin/sioc-suggestions"),
  });

  const saveAttrsMutation = useMutation({
    mutationFn: (payload: AttrsPayload) =>
      putJson<{ attrs: unknown }>("/api/shipping/admin/variant-attrs", payload),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      setEditingRow(null);
      setForm(null);
      toast({ title: "Packing attributes saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save attributes", description: e.message, variant: "destructive" });
    },
  });

  const suggestionMutation = useMutation({
    mutationFn: ({ payload }: { payload: AttrsPayload; confirmed: boolean }) =>
      putJson<{ attrs: unknown }>("/api/shipping/admin/variant-attrs", payload),
    onSuccess: (_data, { confirmed }) => {
      invalidateShippingAdmin(queryClient);
      toast({ title: confirmed ? "Marked as ships-in-own-container" : "Suggestion dismissed" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to update suggestion", description: e.message, variant: "destructive" });
    },
  });

  const openEdit = (row: VariantAttrsRow) => {
    setEditingRow(row);
    setForm(attrsFormFromRow(row));
  };

  const handleSave = () => {
    if (!editingRow || !form) return;
    try {
      saveAttrsMutation.mutate(buildAttrsPayload(editingRow.productVariantId, form));
    } catch (e) {
      toast({ title: "Invalid attributes", description: (e as Error).message, variant: "destructive" });
    }
  };

  const rows = attrsData?.rows || [];
  const suggestions = suggestionsData?.rows || [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="flex items-center gap-2 text-base md:text-lg">
            <Package className="w-5 h-5" />
            Packing attributes
          </CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Per-variant packing behavior: ships in own container (SIOC) and rider eligibility.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
          <div className="relative w-full sm:max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by SKU or name..."
              className="pl-9 h-10"
            />
          </div>
          {search.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Type a SKU or product name to look up variants.
            </p>
          ) : attrsLoading ? (
            <div className="flex justify-center p-8">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No variants match “{search}”.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead>Package</TableHead>
                    <TableHead>SIOC</TableHead>
                    <TableHead>Rider</TableHead>
                    <TableHead>Rider void caps</TableHead>
                    <TableHead>Notes</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.productVariantId}>
                      <TableCell className="font-mono text-xs font-medium">{row.sku || "—"}</TableCell>
                      <TableCell>
                        <div className="text-sm">{row.name}</div>
                        <div className="text-xs text-muted-foreground">{row.productName}</div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {dimsSummary(row)}
                      </TableCell>
                      <TableCell>
                        {row.shipsInOwnContainer ? (
                          <Badge variant="outline" className="text-[10px] bg-green-50 text-green-700 border-green-300">
                            SIOC
                          </Badge>
                        ) : row.siocSuggested ? (
                          <Badge variant="outline" className="text-[10px] bg-yellow-50 text-yellow-700 border-yellow-300">
                            Suggested
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.riderEligible ? (
                          <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-300">
                            Rider
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {row.riderVoidCm3 || row.riderVoidMaxWeightGrams || row.riderVoidMaxItems ? (
                          <>
                            {row.riderVoidCm3
                              ? `${formatMeasurementInput(row.riderVoidCm3, CUBIC_CM_PER_CUBIC_INCH)} in³`
                              : null}
                            {row.riderVoidMaxWeightGrams
                              ? `${row.riderVoidCm3 ? " · " : ""}${formatWeight(row.riderVoidMaxWeightGrams)}`
                              : null}
                            {row.riderVoidMaxItems
                              ? `${row.riderVoidCm3 || row.riderVoidMaxWeightGrams ? " · " : ""}${row.riderVoidMaxItems} items`
                              : null}
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[180px] truncate">
                        {row.notes || "—"}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="flex items-center gap-2 text-base md:text-lg">
            <PackageCheck className="w-5 h-5" />
            SIOC suggestions
          </CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Variants that look like they ship in their own container (e.g. sealed cases). Confirm to skip
            cartonization for them, or dismiss to keep packing them into boxes.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
          {suggestionsLoading ? (
            <div className="flex justify-center p-8">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No pending suggestions.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Units</TableHead>
                    <TableHead>Package</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suggestions.map((row) => (
                    <TableRow key={row.productVariantId}>
                      <TableCell className="font-mono text-xs font-medium">{row.sku || "—"}</TableCell>
                      <TableCell className="text-sm">{row.name}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px]">
                          {hierarchyLabel(row.hierarchyLevel)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{row.unitsPerVariant.toLocaleString()}</TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {dimsSummary(row)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="min-h-[32px]"
                            disabled={suggestionMutation.isPending}
                            onClick={() =>
                              suggestionMutation.mutate({
                                payload: {
                                  productVariantId: row.productVariantId,
                                  shipsInOwnContainer: true,
                                  riderEligible: false,
                                },
                                confirmed: true,
                              })
                            }
                          >
                            Confirm SIOC
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-h-[32px] text-muted-foreground"
                            disabled={suggestionMutation.isPending}
                            onClick={() =>
                              suggestionMutation.mutate({
                                payload: {
                                  productVariantId: row.productVariantId,
                                  shipsInOwnContainer: false,
                                  riderEligible: false,
                                },
                                confirmed: false,
                              })
                            }
                          >
                            Dismiss
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={editingRow !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingRow(null);
            setForm(null);
          }
        }}
      >
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Packing attributes</DialogTitle>
            <DialogDescription>
              {editingRow ? `${editingRow.sku || editingRow.name} — ${editingRow.productName}` : ""}
            </DialogDescription>
          </DialogHeader>
          {form && editingRow && (
            <div className="space-y-4 py-2">
              <div className="flex items-start gap-3">
                <Checkbox
                  id="attrs-sioc"
                  checked={form.shipsInOwnContainer}
                  onCheckedChange={(checked) =>
                    setForm((prev) => (prev ? { ...prev, shipsInOwnContainer: checked === true } : prev))
                  }
                  className="mt-0.5"
                />
                <div>
                  <label htmlFor="attrs-sioc" className="text-sm font-medium cursor-pointer">
                    Ships in own container (SIOC)
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Shipped as-is with a label — never packed into a box.
                  </p>
                </div>
              </div>
              {form.shipsInOwnContainer && (
                <div className="rounded-md border p-3 space-y-3">
                  <div>
                    <Label className="text-sm font-medium">Rider void caps</Label>
                    <p className="text-xs text-muted-foreground">
                      Spare capacity inside this container for small rider items. Leave blank for none.
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Volume (in³)</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.001"
                        value={form.riderVoidIn3}
                        onChange={(e) =>
                          setForm((prev) => (prev ? { ...prev, riderVoidIn3: e.target.value } : prev))
                        }
                        className="h-10"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Max weight (oz)</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.001"
                        value={form.riderVoidMaxWeightOz}
                        onChange={(e) =>
                          setForm((prev) => (prev ? { ...prev, riderVoidMaxWeightOz: e.target.value } : prev))
                        }
                        className="h-10"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Max items</Label>
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={form.riderVoidMaxItems}
                        onChange={(e) =>
                          setForm((prev) => (prev ? { ...prev, riderVoidMaxItems: e.target.value } : prev))
                        }
                        className="h-10"
                      />
                    </div>
                  </div>
                </div>
              )}
              <div className="flex items-start gap-3">
                <Checkbox
                  id="attrs-rider"
                  checked={form.riderEligible}
                  onCheckedChange={(checked) =>
                    setForm((prev) => (prev ? { ...prev, riderEligible: checked === true } : prev))
                  }
                  className="mt-0.5"
                />
                <div>
                  <label htmlFor="attrs-rider" className="text-sm font-medium cursor-pointer">
                    Rider eligible
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Small/light item that can ride inside another container's spare void space.
                  </p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs md:text-sm">Notes</Label>
                <Textarea
                  value={form.notes}
                  onChange={(e) => setForm((prev) => (prev ? { ...prev, notes: e.target.value } : prev))}
                  rows={2}
                  className="resize-none"
                  placeholder="Packing notes for this variant (optional)"
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setEditingRow(null);
                setForm(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saveAttrsMutation.isPending}>
              {saveAttrsMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


// ===== Page =====

export default function ShippingSettings() {
  const { data: config, isLoading: configLoading } = useQuery<ShippingAdminConfig>({
    queryKey: ["/api/shipping/admin/config"],
    queryFn: () => fetchJson<ShippingAdminConfig>("/api/shipping/admin/config"),
  });

  const { data: warehouses = [] } = useQuery<WarehouseType[]>({
    queryKey: ["/api/warehouses"],
    queryFn: () => fetchJson<WarehouseType[]>("/api/warehouses"),
  });

  const coverage = config?.dimsCoverage;
  const coveragePct =
    coverage && coverage.variantsTotal > 0
      ? Math.round((coverage.variantsWithDims / coverage.variantsTotal) * 100)
      : 0;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4 md:space-y-6">
      <div className="flex items-center gap-2">
        <Truck className="w-6 h-6" />
        <h1 className="text-xl md:text-2xl font-bold tracking-tight">Shipping</h1>
      </div>

      <Card>
        <CardContent className="p-3 md:p-6">
          <div className="flex items-start gap-3">
            <Ruler className="w-5 h-5 mt-0.5 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                <span className="text-sm font-semibold">
                  Dims captured:{" "}
                  {configLoading || !coverage ? (
                    <Loader2 className="inline w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <>
                      {coverage.variantsWithDims.toLocaleString()} / {coverage.variantsTotal.toLocaleString()} variants
                    </>
                  )}
                </span>
                {coverage && (
                  <span className="text-xs text-muted-foreground">{coveragePct}% complete</span>
                )}
              </div>
              <Progress value={coveragePct} className="h-2" />
              <p className="text-xs text-muted-foreground">
                The packing optimizer needs weight and L × W × H on every sellable variant. Capture dims on the
                product pages — coverage is the critical path for accurate rates.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="boxes">
        <TabsList>
          <TabsTrigger value="boxes">Box catalog</TabsTrigger>
          <TabsTrigger value="packing-attrs">Packing attributes</TabsTrigger>
          <TabsTrigger value="pricing-programs">Pricing programs</TabsTrigger>
        </TabsList>
        <TabsContent value="boxes" className="mt-4">
          <BoxCatalogTab boxes={config?.boxes || []} warehouses={warehouses} isLoading={configLoading} />
        </TabsContent>
        <TabsContent value="packing-attrs" className="mt-4">
          <PackingAttributesTab />
        </TabsContent>
        <TabsContent value="pricing-programs" className="mt-4">
          <PricingProgramsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
