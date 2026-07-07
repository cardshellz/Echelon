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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import {
  Activity,
  AlertTriangle,
  Box,
  FileSpreadsheet,
  Loader2,
  Package,
  PackageCheck,
  Pencil,
  Play,
  Plus,
  Ruler,
  Save,
  Search,
  Trash2,
  Truck,
  Upload,
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

interface ServiceLevelMethod {
  id: number;
  carrier: string;
  serviceCode: string;
  isActive: boolean;
}

interface ServiceLevel {
  id: number;
  code: string;
  displayName: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  methods: ServiceLevelMethod[];
}

interface ShippingAdminConfig {
  boxes: ShippingBox[];
  serviceLevels: ServiceLevel[];
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

interface RateTableSummary {
  id: number;
  carrier: string;
  serviceCode: string;
  currency: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  rowCount: number;
  zoneCount: number;
  minWeightGrams: number | null;
  maxWeightGrams: number | null;
}

interface RateTableImportRow {
  originWarehouseId: number | null;
  destinationZone: string;
  minWeightGrams: number;
  maxWeightGrams: number;
  rateCents: number;
}

interface ParseCsvResponse {
  dialect: "pounds" | "grams" | null;
  rows: RateTableImportRow[];
  errors: Array<{ line: number; message: string }>;
  bandErrors: string[];
}

interface ImportResponse {
  rateTable: RateTableSummary;
  rowCount: number;
  warnings: string[];
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
const CARRIERS = ["usps", "ups", "fedex", "dhl"] as const;

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
    throw new Error(body.error || `Request failed (${res.status})`);
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
    throw new Error(errBody.error || `Request failed (${res.status})`);
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
    const message =
      typeof errBody.error === "string"
        ? errBody.error
        : errBody.error?.message || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return res.json();
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

// ===== Service levels =====

interface MethodFormRow {
  carrier: string;
  serviceCode: string;
  isActive: boolean;
}

function methodsFromLevel(level: ServiceLevel): MethodFormRow[] {
  return (level.methods || []).map((m) => ({
    carrier: m.carrier,
    serviceCode: m.serviceCode,
    isActive: m.isActive,
  }));
}

function ServiceLevelCard({ level }: { level: ServiceLevel }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [details, setDetails] = useState({
    displayName: level.displayName,
    description: level.description || "",
    sortOrder: String(level.sortOrder),
  });
  const [methods, setMethods] = useState<MethodFormRow[]>(methodsFromLevel(level));
  const [pendingActive, setPendingActive] = useState<boolean | null>(null);

  useEffect(() => {
    setDetails({
      displayName: level.displayName,
      description: level.description || "",
      sortOrder: String(level.sortOrder),
    });
    setMethods(methodsFromLevel(level));
  }, [level]);

  const detailsDirty =
    details.displayName !== level.displayName ||
    details.description !== (level.description || "") ||
    details.sortOrder !== String(level.sortOrder);

  const methodsDirty = JSON.stringify(methods) !== JSON.stringify(methodsFromLevel(level));

  const updateLevelMutation = useMutation({
    mutationFn: (body: { displayName?: string; description?: string; sortOrder?: number; isActive?: boolean }) =>
      putJson<{ serviceLevel: ServiceLevel }>(`/api/shipping/admin/service-levels/${level.id}`, body),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      toast({ title: "Service level saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save service level", description: e.message, variant: "destructive" });
    },
  });

  const saveMethodsMutation = useMutation({
    mutationFn: (rows: MethodFormRow[]) =>
      putJson<{ serviceLevel: ServiceLevel }>(`/api/shipping/admin/service-levels/${level.id}/methods`, {
        methods: rows,
      }),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      toast({ title: "Carrier methods saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save methods", description: e.message, variant: "destructive" });
    },
  });

  const handleSaveDetails = () => {
    const sortOrder = parseInt(details.sortOrder);
    if (!details.displayName.trim()) {
      toast({ title: "Display name is required", variant: "destructive" });
      return;
    }
    if (!Number.isInteger(sortOrder)) {
      toast({ title: "Sort order must be a whole number", variant: "destructive" });
      return;
    }
    updateLevelMutation.mutate({
      displayName: details.displayName.trim(),
      description: details.description.trim(),
      sortOrder,
    });
  };

  const handleSaveMethods = () => {
    const cleaned = methods
      .map((m) => ({ ...m, serviceCode: m.serviceCode.trim() }))
      .filter((m) => m.serviceCode.length > 0);
    if (cleaned.length !== methods.length) {
      toast({ title: "Every method needs a service code", variant: "destructive" });
      return;
    }
    saveMethodsMutation.mutate(cleaned);
  };

  return (
    <Card>
      <CardHeader className="p-3 md:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base md:text-lg">
            <Truck className="w-5 h-5" />
            {level.displayName}
            <Badge variant="outline" className="text-[10px] font-mono">{level.code}</Badge>
            {!level.isActive && (
              <Badge variant="secondary" className="text-[10px]">Inactive</Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Label htmlFor={`level-active-${level.id}`} className="text-xs md:text-sm text-muted-foreground cursor-pointer">
              Active
            </Label>
            <Switch
              id={`level-active-${level.id}`}
              checked={level.isActive}
              disabled={updateLevelMutation.isPending}
              onCheckedChange={(checked) => setPendingActive(checked === true)}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs md:text-sm">Display name</Label>
            <Input
              value={details.displayName}
              onChange={(e) => setDetails((prev) => ({ ...prev, displayName: e.target.value }))}
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs md:text-sm">Sort order</Label>
            <Input
              type="number"
              value={details.sortOrder}
              onChange={(e) => setDetails((prev) => ({ ...prev, sortOrder: e.target.value }))}
              className="h-10"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs md:text-sm">Description</Label>
          <Textarea
            value={details.description}
            onChange={(e) => setDetails((prev) => ({ ...prev, description: e.target.value }))}
            rows={2}
            className="resize-none"
            placeholder="Shown to shoppers alongside the delivery promise"
          />
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={handleSaveDetails}
            disabled={!detailsDirty || updateLevelMutation.isPending}
            className="min-h-[36px]"
          >
            {updateLevelMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Save className="w-4 h-4 mr-2" />
            )}
            Save details
          </Button>
        </div>

        <div className="pt-4 border-t space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-semibold">Carrier methods</Label>
              <p className="text-xs text-muted-foreground">
                Carrier services the rates engine may quote for this level.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setMethods((prev) => [...prev, { carrier: "usps", serviceCode: "", isActive: true }])}
              className="min-h-[36px]"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add method
            </Button>
          </div>
          {methods.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No methods configured — this level cannot be quoted.
            </p>
          ) : (
            <div className="space-y-2">
              {methods.map((method, idx) => (
                <div key={idx} className="flex flex-col sm:flex-row gap-2 sm:items-center rounded-md border p-2">
                  <Select
                    value={method.carrier}
                    onValueChange={(v) =>
                      setMethods((prev) => prev.map((m, i) => (i === idx ? { ...m, carrier: v } : m)))
                    }
                  >
                    <SelectTrigger className="h-10 sm:w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CARRIERS.map((carrier) => (
                        <SelectItem key={carrier} value={carrier} className="uppercase">
                          {carrier.toUpperCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={method.serviceCode}
                    onChange={(e) =>
                      setMethods((prev) => prev.map((m, i) => (i === idx ? { ...m, serviceCode: e.target.value } : m)))
                    }
                    placeholder="Service code (e.g. usps_ground_advantage)"
                    className="h-10 flex-1 font-mono text-sm"
                  />
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={method.isActive}
                      onCheckedChange={(checked) =>
                        setMethods((prev) =>
                          prev.map((m, i) => (i === idx ? { ...m, isActive: checked === true } : m)),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => setMethods((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={handleSaveMethods}
              disabled={!methodsDirty || saveMethodsMutation.isPending}
              className="min-h-[36px]"
            >
              {saveMethodsMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save methods
            </Button>
          </div>
        </div>
      </CardContent>

      <AlertDialog open={pendingActive !== null} onOpenChange={(open) => !open && setPendingActive(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingActive ? "Activate" : "Deactivate"} “{level.displayName}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingActive
                ? "Activating a service level affects which shipping options can be offered at checkout. Make sure its carrier methods are configured before turning it on."
                : "Deactivating a service level removes it from the options that can be offered at checkout."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingActive !== null) {
                  updateLevelMutation.mutate({ isActive: pendingActive });
                }
                setPendingActive(null);
              }}
            >
              {pendingActive ? "Activate" : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ServiceLevelsTab({ levels, isLoading }: { levels: ServiceLevel[]; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (levels.length === 0) {
    return (
      <Card>
        <CardContent className="text-center p-8 text-muted-foreground">
          <Truck className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No service levels found. The standard/expedited/express levels are seeded by the server.</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {[...levels]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((level) => (
          <ServiceLevelCard key={level.id} level={level} />
        ))}
    </div>
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

// ===== Rate tables =====

function formatEffectiveDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

function formatBandRange(minGrams: number | null, maxGrams: number | null): string {
  if (minGrams === null || maxGrams === null) return "—";
  return `${formatWeight(minGrams)} – ${formatWeight(maxGrams)}`;
}

function rateTableStatusBadge(status: string) {
  if (status === "active") {
    return (
      <Badge variant="outline" className="text-[10px] bg-green-50 text-green-700 border-green-300 capitalize">
        {status}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px] capitalize">
      {status}
    </Badge>
  );
}

const RATE_PREVIEW_ROW_LIMIT = 50;

interface RateImportFormState {
  carrier: string;
  serviceCode: string;
  csv: string;
  replaceExisting: boolean;
}

function emptyRateImportForm(): RateImportFormState {
  return { carrier: "usps", serviceCode: "", csv: "", replaceExisting: true };
}

function RateTablesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<RateImportFormState>(emptyRateImportForm());
  const [preview, setPreview] = useState<ParseCsvResponse | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[] | null>(null);

  const { data: tablesData, isLoading } = useQuery<{ rateTables: RateTableSummary[] }>({
    queryKey: ["/api/shipping/admin/rate-tables"],
    queryFn: () => fetchJson<{ rateTables: RateTableSummary[] }>("/api/shipping/admin/rate-tables"),
  });
  const tables = tablesData?.rateTables || [];

  const parseMutation = useMutation({
    mutationFn: (csv: string) =>
      postJson<ParseCsvResponse>("/api/shipping/admin/rate-tables/parse-csv", { csv }),
    onSuccess: (data) => setPreview(data),
    onError: (e: Error) => {
      toast({ title: "Failed to parse CSV", description: e.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: (body: {
      carrier: string;
      serviceCode: string;
      replaceExisting: boolean;
      rows: RateTableImportRow[];
    }) => postJson<ImportResponse>("/api/shipping/admin/rate-tables/import", body),
    onSuccess: (data) => {
      invalidateShippingAdmin(queryClient);
      toast({ title: `Rate table imported (${data.rowCount.toLocaleString()} rows)` });
      if (data.warnings.length > 0) {
        // Keep the dialog open so the zone warnings are read, not lost in a toast.
        setImportWarnings(data.warnings);
      } else {
        closeDialog();
      }
    },
    onError: (e: Error) => {
      toast({ title: "Import failed", description: e.message, variant: "destructive" });
    },
  });

  const closeDialog = () => {
    setDialogOpen(false);
    setForm(emptyRateImportForm());
    setPreview(null);
    setImportWarnings(null);
  };

  const handleFileChange = (file: File | undefined) => {
    if (!file) return;
    file
      .text()
      .then((text) => {
        setForm((prev) => ({ ...prev, csv: text }));
        setPreview(null);
      })
      .catch(() => {
        toast({ title: "Could not read file", variant: "destructive" });
      });
  };

  const handleParse = () => {
    if (!form.csv.trim()) {
      toast({ title: "Paste or upload a CSV first", variant: "destructive" });
      return;
    }
    parseMutation.mutate(form.csv);
  };

  const previewHasErrors =
    preview !== null && (preview.errors.length > 0 || preview.bandErrors.length > 0);
  const canImport =
    preview !== null && !previewHasErrors && preview.rows.length > 0 && form.serviceCode.trim().length > 0;

  const handleImport = () => {
    if (!preview || !canImport) return;
    importMutation.mutate({
      carrier: form.carrier,
      serviceCode: form.serviceCode.trim(),
      replaceExisting: form.replaceExisting,
      rows: preview.rows,
    });
  };

  return (
    <Card>
      <CardHeader className="p-3 md:p-6 flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base md:text-lg">
            <FileSpreadsheet className="w-5 h-5" />
            Rate tables
          </CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Weight-band × zone prices the rates engine quotes from. Import hand-transcribed carrier
            grids here; calibration jobs write tables through the same path.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)} className="min-h-[36px]">
          <Upload className="h-4 w-4 mr-1" />
          Import table
        </Button>
      </CardHeader>
      <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
        {isLoading ? (
          <div className="flex justify-center p-8">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : tables.length === 0 ? (
          <div className="text-center p-8 text-muted-foreground">
            <FileSpreadsheet className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p>No rate tables yet. Import a carrier's weight-band × zone grid to start quoting.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Zones</TableHead>
                  <TableHead>Weight bands</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tables.map((table) => (
                  <TableRow key={table.id} className={table.status !== "active" ? "opacity-60" : undefined}>
                    <TableCell className="text-sm uppercase font-medium">{table.carrier}</TableCell>
                    <TableCell className="font-mono text-xs">{table.serviceCode}</TableCell>
                    <TableCell>{rateTableStatusBadge(table.status)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatEffectiveDate(table.effectiveFrom)}
                      {" → "}
                      {table.effectiveTo ? formatEffectiveDate(table.effectiveTo) : "open"}
                    </TableCell>
                    <TableCell className="text-sm text-right">{table.rowCount.toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-right">{table.zoneCount.toLocaleString()}</TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatBandRange(table.minWeightGrams, table.maxWeightGrams)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import rate table</DialogTitle>
            <DialogDescription>
              CSV columns: zone,min_lb,max_lb,rate_usd or zone,min_g,max_g,rate_cents (optional
              warehouse_id). Header row required.
            </DialogDescription>
          </DialogHeader>

          {importWarnings !== null ? (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="w-4 h-4 text-yellow-600" />
                Imported with warnings
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground list-disc pl-5">
                {importWarnings.map((warning, idx) => (
                  <li key={idx}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Carrier</Label>
                  <Select
                    value={form.carrier}
                    onValueChange={(v) => setForm((prev) => ({ ...prev, carrier: v }))}
                  >
                    <SelectTrigger className="h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CARRIERS.map((carrier) => (
                        <SelectItem key={carrier} value={carrier} className="uppercase">
                          {carrier.toUpperCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Service code</Label>
                  <Input
                    value={form.serviceCode}
                    onChange={(e) => setForm((prev) => ({ ...prev, serviceCode: e.target.value }))}
                    placeholder="usps_ground_advantage"
                    className="h-10 font-mono text-sm"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>CSV</Label>
                <Textarea
                  value={form.csv}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, csv: e.target.value }));
                    setPreview(null);
                  }}
                  rows={8}
                  className="font-mono text-xs"
                  placeholder={"zone,min_lb,max_lb,rate_usd\nUS-48,0,1,8.99"}
                />
                <div className="flex items-center gap-2">
                  <Input
                    type="file"
                    accept=".csv,text/csv"
                    className="h-10 max-w-xs text-xs"
                    onChange={(e) => handleFileChange(e.target.files?.[0])}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleParse}
                    disabled={parseMutation.isPending}
                    className="min-h-[36px]"
                  >
                    {parseMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Search className="w-4 h-4 mr-2" />
                    )}
                    Preview
                  </Button>
                </div>
              </div>

              {preview && (
                <div className="space-y-3">
                  {(preview.errors.length > 0 || preview.bandErrors.length > 0) && (
                    <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                        <AlertTriangle className="w-4 h-4" />
                        Fix these before importing
                      </div>
                      <ul className="text-xs text-destructive list-disc pl-5 max-h-40 overflow-y-auto">
                        {preview.errors.map((err, idx) => (
                          <li key={`row-${idx}`}>
                            Line {err.line}: {err.message}
                          </li>
                        ))}
                        {preview.bandErrors.map((err, idx) => (
                          <li key={`band-${idx}`}>{err}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {preview.rows.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">
                        {preview.rows.length.toLocaleString()} row{preview.rows.length === 1 ? "" : "s"} parsed
                        {preview.dialect ? ` (${preview.dialect} dialect)` : ""}
                        {preview.rows.length > RATE_PREVIEW_ROW_LIMIT
                          ? ` — showing first ${RATE_PREVIEW_ROW_LIMIT}`
                          : ""}
                      </p>
                      <div className="overflow-x-auto max-h-64 overflow-y-auto rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Zone</TableHead>
                              <TableHead>Warehouse</TableHead>
                              <TableHead>Band</TableHead>
                              <TableHead className="text-right">Rate</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {preview.rows.slice(0, RATE_PREVIEW_ROW_LIMIT).map((row, idx) => (
                              <TableRow key={idx}>
                                <TableCell className="font-mono text-xs">{row.destinationZone}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {row.originWarehouseId ?? "any"}
                                </TableCell>
                                <TableCell className="text-xs whitespace-nowrap">
                                  {formatWeight(row.minWeightGrams)} – {formatWeight(row.maxWeightGrams)}
                                </TableCell>
                                <TableCell className="text-xs text-right">{formatCostUsd(row.rateCents)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-start gap-3">
                <Checkbox
                  id="rate-replace-existing"
                  checked={form.replaceExisting}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({ ...prev, replaceExisting: checked === true }))
                  }
                  className="mt-0.5"
                />
                <div>
                  <label htmlFor="rate-replace-existing" className="text-sm font-medium cursor-pointer">
                    Supersede current table for this carrier + service
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Marks the prior active table superseded so only the new one is quoted.
                  </p>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            {importWarnings !== null ? (
              <Button onClick={closeDialog}>Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button onClick={handleImport} disabled={!canImport || importMutation.isPending}>
                  {importMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 mr-2" />
                  )}
                  Import
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ===== Shadow runs =====

interface ShadowReport {
  ordersRun: number;
  packingComplete: number;
  packingFallback: number;
  ratesFound: number;
  ratesEmpty: number;
  topWarnings: Array<{ warning: string; count: number }>;
}

interface ShadowRunRecord {
  report: ShadowReport;
  days: number;
  limit: number;
  ranAt: Date;
}

const SHADOW_DAYS_OPTIONS = ["7", "30", "90"] as const;
const SHADOW_LIMIT_OPTIONS = ["25", "50", "100"] as const;
const SHADOW_RUN_HISTORY_LIMIT = 5;

function formatRunPct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function ShadowReportStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

function ShadowRunResult({ run }: { run: ShadowRunRecord }) {
  const { report } = run;
  return (
    <div className="rounded-md border p-3 md:p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
        <span className="text-sm font-medium">
          Run at {run.ranAt.toLocaleTimeString()} · {run.ranAt.toLocaleDateString()}
        </span>
        <span className="text-xs text-muted-foreground">
          last {run.days} days, up to {run.limit} orders
        </span>
      </div>
      {report.ordersRun === 0 ? (
        <p className="text-sm text-muted-foreground">
          No matching orders found in the window — widen the day range or wait for new US orders.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <ShadowReportStat label="Orders run" value={report.ordersRun.toLocaleString()} />
            <ShadowReportStat
              label="Packed completely"
              value={`${report.packingComplete.toLocaleString()} / ${report.ordersRun.toLocaleString()}`}
              detail={`${formatRunPct(report.packingComplete, report.ordersRun)} · ${report.packingFallback.toLocaleString()} fell back`}
            />
            <ShadowReportStat
              label="Rates found"
              value={`${report.ratesFound.toLocaleString()} / ${report.ordersRun.toLocaleString()}`}
              detail={`${formatRunPct(report.ratesFound, report.ordersRun)} · ${report.ratesEmpty.toLocaleString()} empty`}
            />
          </div>
          {report.packingComplete === 0 && (
            <p className="text-sm text-muted-foreground">
              No orders packed completely yet — add boxes in the Box catalog and capture product
              dims, then run again to watch readiness climb.
            </p>
          )}
          {report.topWarnings.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Top blockers
              </p>
              <div className="space-y-1">
                {report.topWarnings.map((entry) => (
                  <div
                    key={entry.warning}
                    className="flex items-start justify-between gap-3 rounded-md bg-muted/50 px-2.5 py-1.5"
                  >
                    <span className="text-xs font-mono break-all">{entry.warning}</span>
                    <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                      ×{entry.count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ShadowRunsTab() {
  const { toast } = useToast();

  const [days, setDays] = useState<string>("7");
  const [limit, setLimit] = useState<string>("50");
  // Session-only history — the server keeps snapshots, but there is no
  // list endpoint yet, so we only show runs triggered from this page load.
  const [runs, setRuns] = useState<ShadowRunRecord[]>([]);

  const runMutation = useMutation({
    mutationFn: (body: { days: number; limit: number }) =>
      postJson<{ report: ShadowReport }>("/api/shipping/admin/shadow-run", body),
    onSuccess: (data, body) => {
      setRuns((prev) =>
        [
          { report: data.report, days: body.days, limit: body.limit, ranAt: new Date() },
          ...prev,
        ].slice(0, SHADOW_RUN_HISTORY_LIMIT),
      );
    },
    onError: (e: Error) => {
      toast({ title: "Shadow run failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader className="p-3 md:p-6">
        <CardTitle className="flex items-center gap-2 text-base md:text-lg">
          <Activity className="w-5 h-5" />
          Shadow runs
        </CardTitle>
        <CardDescription className="text-xs md:text-sm">
          Replays recent real orders through the packing and rates pipeline without touching
          checkout. Run it as you capture boxes, dims, and rate tables to see data readiness climb.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="space-y-1.5">
            <Label className="text-xs md:text-sm">Order window</Label>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="h-10 sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHADOW_DAYS_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    Last {opt} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs md:text-sm">Max orders</Label>
            <Select value={limit} onValueChange={setLimit}>
              <SelectTrigger className="h-10 sm:w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHADOW_LIMIT_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => runMutation.mutate({ days: parseInt(days), limit: parseInt(limit) })}
            disabled={runMutation.isPending}
            className="min-h-[40px]"
          >
            {runMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Play className="w-4 h-4 mr-2" />
            )}
            {runMutation.isPending ? "Running..." : "Run shadow quotes"}
          </Button>
        </div>
        {runMutation.isPending && (
          <p className="text-xs text-muted-foreground">
            Replaying orders through the quote pipeline — this can take a moment for larger batches.
          </p>
        )}

        {runs.length === 0 && !runMutation.isPending ? (
          <div className="text-center p-8 text-muted-foreground">
            <Activity className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p>
              No runs yet this session. Run shadow quotes to replay recent orders and see how much
              of the catalog the engine can pack and rate today.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {runs.map((run) => (
              <ShadowRunResult key={run.ranAt.getTime()} run={run} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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
          <TabsTrigger value="service-levels">Service levels</TabsTrigger>
          <TabsTrigger value="packing-attrs">Packing attributes</TabsTrigger>
          <TabsTrigger value="rate-tables">Rate tables</TabsTrigger>
          <TabsTrigger value="shadow-runs">Shadow runs</TabsTrigger>
        </TabsList>
        <TabsContent value="boxes" className="mt-4">
          <BoxCatalogTab boxes={config?.boxes || []} warehouses={warehouses} isLoading={configLoading} />
        </TabsContent>
        <TabsContent value="service-levels" className="mt-4">
          <ServiceLevelsTab levels={config?.serviceLevels || []} isLoading={configLoading} />
        </TabsContent>
        <TabsContent value="packing-attrs" className="mt-4">
          <PackingAttributesTab />
        </TabsContent>
        <TabsContent value="rate-tables" className="mt-4">
          <RateTablesTab />
        </TabsContent>
        <TabsContent value="shadow-runs" className="mt-4">
          <ShadowRunsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
