import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin, PackageCheck, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { InventoryLocationCombobox } from "@/components/inventory/InventoryLocationCombobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  ReturnCaseAdminApiError,
  applyReturnInventoryTreatment,
  createReturnCaseIdempotencyKey,
  getReturnVariantBinAssignments,
  getReturnWarehouseLocations,
  type ApplyReturnInventoryTreatmentResult,
  type ReturnCaseAction,
  type ReturnCaseDetailItem,
  type ReturnCaseInventoryTreatmentSummary,
  type ReturnVariantBinAssignment,
  type ReturnWarehouseLocation,
} from "./return-case-admin-api";

export interface InventoryTreatmentDraftLine {
  dispositionItemId: number;
  returnCaseItemId: number;
  title: string;
  sku: string | null;
  productVariantId: number | null;
  treatment: "restock_sellable" | "hold_non_sellable";
  quantity: number;
  warehouseLocationId: string;
}

export interface InventoryTreatmentValidation {
  success: boolean;
  lines: Array<{
    dispositionItemId: number;
    expectedTreatment: "restock_sellable" | "hold_non_sellable";
    expectedQuantity: number;
    warehouseLocationId: number | null;
  }>;
  fieldErrors: Readonly<Record<number, string>>;
  formError: string | null;
}

export interface ReturnVariantSlotResolution {
  productVariantId: number;
  status: "valid" | "unassigned" | "invalid" | "duplicate" | "missing" | "unavailable";
  warehouseLocationId: number | null;
  warehouseLocationCode: string | null;
  issue: string | null;
}

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  returnCaseId: number;
  action: ReturnCaseAction | null;
  items: readonly ReturnCaseDetailItem[];
  summary: ReturnCaseInventoryTreatmentSummary;
  onCompleted(result: ApplyReturnInventoryTreatmentResult): void;
  onRefreshRequested(): Promise<void>;
}

export function ApplyReturnInventoryTreatmentDialog({
  open,
  onOpenChange,
  returnCaseId,
  action,
  items,
  summary,
  onCompleted,
  onRefreshRequested,
}: Props) {
  const commandVersion = summary.items
    .map((item) => `${item.dispositionItemId}:${item.treatment}:${item.quantity}:${item.applied}`)
    .join("|");
  const initializedVersion = useRef<string | null>(null);
  const initializedSlotDefaultsVersion = useRef<string | null>(null);
  const [draft, setDraft] = useState<InventoryTreatmentDraftLine[]>(() => createInventoryTreatmentDraft(items, summary));
  const [notes, setNotes] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const locationsQuery = useQuery({
    queryKey: ["/api/warehouse/locations"],
    queryFn: () => getReturnWarehouseLocations(),
    enabled: open,
  });
  const pickableLocations = useMemo(
    () => filterPickableReturnLocations(locationsQuery.data ?? []),
    [locationsQuery.data],
  );
  const productVariantIds = useMemo(
    () => [...new Set(draft.flatMap((line) =>
      line.treatment === "restock_sellable" && line.productVariantId !== null
        ? [line.productVariantId]
        : []))].sort((left, right) => left - right),
    [draft],
  );
  const slotAssignmentsQuery = useQuery({
    queryKey: ["/api/bin-assignments", "variantIds", productVariantIds.join(",")],
    queryFn: () => getReturnVariantBinAssignments(productVariantIds),
    enabled: open && productVariantIds.length > 0,
  });
  const slotResolutionByVariantId = useMemo(
    () => resolveReturnVariantSlots(
      productVariantIds,
      slotAssignmentsQuery.data ?? [],
      pickableLocations,
    ),
    [pickableLocations, productVariantIds, slotAssignmentsQuery.data],
  );
  const slotDefaultsVersion = useMemo(() => [
    commandVersion,
    ...productVariantIds.map((productVariantId) => {
      const resolution = slotResolutionByVariantId.get(productVariantId);
      return `${productVariantId}:${resolution?.status ?? "pending"}:${resolution?.warehouseLocationId ?? ""}`;
    }),
  ].join("|"), [commandVersion, productVariantIds, slotResolutionByVariantId]);
  const validation = useMemo(() => validateInventoryTreatmentDraft(draft), [draft]);

  useEffect(() => {
    if (!open || initializedVersion.current === commandVersion) return;
    initializedVersion.current = commandVersion;
    setDraft(createInventoryTreatmentDraft(items, summary));
    setNotes("");
    setAttempted(false);
    setPending(false);
    setError(null);
    try {
      setIdempotencyKey(createReturnCaseIdempotencyKey("apply_inventory_treatment"));
    } catch (caught) {
      setIdempotencyKey(null);
      setError(caught);
    }
  }, [commandVersion, items, open, summary]);

  useEffect(() => {
    if (!open
      || productVariantIds.length === 0
      || locationsQuery.isFetching
      || slotAssignmentsQuery.isFetching
      || locationsQuery.error
      || slotAssignmentsQuery.error
      || locationsQuery.data === undefined
      || slotAssignmentsQuery.data === undefined
      || initializedSlotDefaultsVersion.current === slotDefaultsVersion) return;
    initializedSlotDefaultsVersion.current = slotDefaultsVersion;
    setDraft((current) => applySlottedLocationDefaults(current, slotResolutionByVariantId));
  }, [
    locationsQuery.data,
    locationsQuery.error,
    locationsQuery.isFetching,
    open,
    productVariantIds.length,
    slotAssignmentsQuery.data,
    slotAssignmentsQuery.error,
    slotAssignmentsQuery.isFetching,
    slotDefaultsVersion,
    slotResolutionByVariantId,
  ]);

  const payloadChanged = () => {
    setError(null);
    if (!attempted) return;
    setAttempted(false);
    try {
      setIdempotencyKey(createReturnCaseIdempotencyKey("apply_inventory_treatment"));
    } catch (caught) {
      setIdempotencyKey(null);
      setError(caught);
    }
  };

  const refreshAfterConflict = async (caught: unknown) => {
    if (!(caught instanceof ReturnCaseAdminApiError) || caught.status !== 409) return;
    setRefreshing(true);
    try {
      await onRefreshRequested();
    } finally {
      setRefreshing(false);
    }
  };

  const submit = async () => {
    const parsed = validateInventoryTreatmentDraft(draft);
    if (!parsed.success || idempotencyKey === null) return;
    setAttempted(true);
    setPending(true);
    setError(null);
    try {
      const result = await applyReturnInventoryTreatment(returnCaseId, {
        idempotencyKey,
        notes,
        lines: parsed.lines,
      });
      onCompleted(result);
    } catch (caught) {
      setError(caught);
      await refreshAfterConflict(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{action?.label ?? "Apply inventory treatment"}</DialogTitle>
          <DialogDescription>
            Apply the recorded treatment decision. Sellable items enter inventory at the selected
            pickable location; held items remain outside sellable inventory.
          </DialogDescription>
        </DialogHeader>

        <Alert>
          <PackageCheck />
          <AlertTitle>This changes inventory only where explicitly shown</AlertTitle>
          <AlertDescription>
            This action does not issue a customer refund, settle a vendor balance, or close the return case.
          </AlertDescription>
        </Alert>

        <div className="overflow-x-auto border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b bg-muted/40 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Returned item</th>
                <th className="px-3 py-2 font-medium">Recorded treatment</th>
                <th className="px-3 py-2 text-right font-medium">Quantity</th>
                <th className="w-64 px-3 py-2 font-medium">Inventory destination</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {draft.map((line, index) => (
                <tr key={line.dispositionItemId}>
                  <td className="px-3 py-2 align-middle">
                    <div className="font-medium">{line.title}</div>
                    <div className="text-xs text-muted-foreground">{line.sku ?? "SKU not provided"}</div>
                  </td>
                  <td className="px-3 py-2 align-middle">
                    {line.treatment === "restock_sellable" ? "Restock as sellable" : "Hold as non-sellable"}
                  </td>
                  <td className="px-3 py-2 text-right align-middle">{line.quantity}</td>
                  <td className="px-3 py-2 align-middle">
                    {line.treatment === "restock_sellable" ? (
                      <>
                        <InventoryLocationCombobox
                          locations={pickableLocations}
                          value={line.warehouseLocationId === "" ? null : Number(line.warehouseLocationId)}
                          disabled={pending || locationsQuery.isLoading}
                          loading={locationsQuery.isLoading}
                          ariaLabel={`Inventory destination for ${line.title}`}
                          placeholder="Select pickable location"
                          searchPlaceholder="Search pickable locations..."
                          emptyMessage="No matching pickable locations found."
                          onValueChange={(locationId) => {
                            setDraft((current) => current.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, warehouseLocationId: locationId === null ? "" : String(locationId) }
                                : candidate));
                            payloadChanged();
                          }}
                        />
                        <SlottingHint
                          productVariantId={line.productVariantId}
                          resolution={line.productVariantId === null
                            ? null
                            : slotResolutionByVariantId.get(line.productVariantId) ?? null}
                          selectedLocationId={line.warehouseLocationId === ""
                            ? null
                            : Number(line.warehouseLocationId)}
                          loading={slotAssignmentsQuery.isFetching || locationsQuery.isFetching}
                          failed={Boolean(slotAssignmentsQuery.error)}
                        />
                        {validation.fieldErrors[line.dispositionItemId] && (
                          <p className="mt-1 text-xs text-destructive">{validation.fieldErrors[line.dispositionItemId]}</p>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">No inventory movement</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <label htmlFor="return-inventory-treatment-notes" className="mb-1 block text-sm font-medium">
            Inventory treatment notes (optional)
          </label>
          <Textarea
            id="return-inventory-treatment-notes"
            value={notes}
            maxLength={2_000}
            disabled={pending}
            placeholder="Putaway or hold evidence"
            onChange={(event) => { setNotes(event.target.value); payloadChanged(); }}
          />
        </div>

        {locationsQuery.error && <OperationError error={locationsQuery.error} />}
        {slotAssignmentsQuery.error && <OperationError error={slotAssignmentsQuery.error} />}
        {!validation.success && validation.formError && (
          <div className="border border-destructive p-3 text-sm text-destructive">{validation.formError}</div>
        )}
        {error !== null && <OperationError error={error} />}
        {refreshing && (
          <Alert><Loader2 className="animate-spin" /><AlertTitle>Refreshing return case</AlertTitle></Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            disabled={pending || refreshing || locationsQuery.isLoading || !validation.success || idempotencyKey === null}
            onClick={() => void submit()}
          >
            {pending && <Loader2 className="animate-spin" />}
            {pending ? "Applying..." : (action?.label ?? "Apply inventory treatment")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function createInventoryTreatmentDraft(
  items: readonly ReturnCaseDetailItem[],
  summary: ReturnCaseInventoryTreatmentSummary,
): InventoryTreatmentDraftLine[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  return summary.items.filter((source) => !source.applied).map((source) => {
    const item = itemById.get(source.returnCaseItemId);
    return {
      dispositionItemId: source.dispositionItemId,
      returnCaseItemId: source.returnCaseItemId,
      title: item?.title || item?.externalLineItemId || `Return item #${source.returnCaseItemId}`,
      sku: item?.sku ?? null,
      productVariantId: item?.productVariantId ?? null,
      treatment: source.treatment,
      quantity: source.quantity,
      warehouseLocationId: "",
    };
  }).sort((left, right) => left.dispositionItemId - right.dispositionItemId);
}

export function resolveReturnVariantSlots(
  productVariantIds: readonly number[],
  assignments: readonly ReturnVariantBinAssignment[],
  pickableLocations: readonly ReturnWarehouseLocation[],
): ReadonlyMap<number, ReturnVariantSlotResolution> {
  const rowsByVariantId = new Map<number, ReturnVariantBinAssignment[]>();
  assignments.forEach((assignment) => {
    const rows = rowsByVariantId.get(assignment.productVariantId) ?? [];
    rows.push(assignment);
    rowsByVariantId.set(assignment.productVariantId, rows);
  });
  const pickableIds = new Set(pickableLocations.map((location) => location.id));
  const result = new Map<number, ReturnVariantSlotResolution>();
  [...new Set(productVariantIds)].sort((left, right) => left - right).forEach((productVariantId) => {
    const rows = rowsByVariantId.get(productVariantId) ?? [];
    if (rows.length === 0) {
      result.set(productVariantId, slotResolution(productVariantId, "missing"));
      return;
    }
    if (rows.length !== 1 || rows.some((row) => row.slotStatus === "duplicate" || row.assignmentCount > 1)) {
      result.set(productVariantId, slotResolution(productVariantId, "duplicate"));
      return;
    }
    const row = rows[0];
    if (row.slotStatus === "unassigned") {
      result.set(productVariantId, slotResolution(productVariantId, "unassigned"));
      return;
    }
    if (row.slotStatus !== "valid"
      || row.assignedLocationId === null
      || row.assignedLocationCode === null
      || row.assignmentCount !== 1
      || row.validAssignmentCount !== 1) {
      result.set(productVariantId, {
        ...slotResolution(productVariantId, "invalid"),
        warehouseLocationId: row.assignedLocationId,
        warehouseLocationCode: row.assignedLocationCode,
        issue: row.slotIssue,
      });
      return;
    }
    if (!pickableIds.has(row.assignedLocationId)) {
      result.set(productVariantId, {
        ...slotResolution(productVariantId, "unavailable"),
        warehouseLocationId: row.assignedLocationId,
        warehouseLocationCode: row.assignedLocationCode,
      });
      return;
    }
    result.set(productVariantId, {
      productVariantId,
      status: "valid",
      warehouseLocationId: row.assignedLocationId,
      warehouseLocationCode: row.assignedLocationCode,
      issue: null,
    });
  });
  return result;
}

export function applySlottedLocationDefaults(
  draft: readonly InventoryTreatmentDraftLine[],
  resolutions: ReadonlyMap<number, ReturnVariantSlotResolution>,
): InventoryTreatmentDraftLine[] {
  return draft.map((line) => {
    if (line.treatment !== "restock_sellable"
      || line.warehouseLocationId !== ""
      || line.productVariantId === null) return line;
    const resolution = resolutions.get(line.productVariantId);
    return resolution?.status === "valid" && resolution.warehouseLocationId !== null
      ? { ...line, warehouseLocationId: String(resolution.warehouseLocationId) }
      : line;
  });
}

function slotResolution(
  productVariantId: number,
  status: ReturnVariantSlotResolution["status"],
): ReturnVariantSlotResolution {
  return { productVariantId, status, warehouseLocationId: null, warehouseLocationCode: null, issue: null };
}

export function validateInventoryTreatmentDraft(
  draft: readonly InventoryTreatmentDraftLine[],
): InventoryTreatmentValidation {
  const errors: Record<number, string> = {};
  const lines: InventoryTreatmentValidation["lines"] = [];
  const seen = new Set<number>();
  for (const line of draft) {
    if (!Number.isSafeInteger(line.dispositionItemId) || line.dispositionItemId <= 0
      || !Number.isSafeInteger(line.returnCaseItemId) || line.returnCaseItemId <= 0
      || !Number.isSafeInteger(line.quantity) || line.quantity <= 0
      || seen.has(line.dispositionItemId)) {
      errors[line.dispositionItemId] = "Recorded treatment evidence is invalid. Refresh the return case.";
      continue;
    }
    seen.add(line.dispositionItemId);
    const parsedLocation = line.warehouseLocationId === "" ? null : Number(line.warehouseLocationId);
    if (line.treatment === "restock_sellable"
      && (!Number.isSafeInteger(parsedLocation) || Number(parsedLocation) <= 0)) {
      errors[line.dispositionItemId] = "Select an active, pickable inventory location.";
      continue;
    }
    if (line.treatment === "hold_non_sellable" && parsedLocation !== null) {
      errors[line.dispositionItemId] = "Held items cannot specify a sellable inventory location.";
      continue;
    }
    lines.push({
      dispositionItemId: line.dispositionItemId,
      expectedTreatment: line.treatment,
      expectedQuantity: line.quantity,
      warehouseLocationId: parsedLocation,
    });
  }
  const formError = Object.keys(errors).length > 0
    ? "Correct the inventory destinations before continuing."
    : lines.length === 0
      ? "No recorded treatments remain to apply."
      : null;
  return { success: formError === null, lines, fieldErrors: Object.freeze(errors), formError };
}

export function filterPickableReturnLocations(
  locations: readonly ReturnWarehouseLocation[],
): ReturnWarehouseLocation[] {
  return locations.filter((location) => location.isActive === 1
    && location.isPickable === 1
    && location.warehouseId !== null
    && location.cycleCountFreezeId === null)
    .sort((left, right) => left.code.localeCompare(right.code));
}

function SlottingHint({
  productVariantId,
  resolution,
  selectedLocationId,
  loading,
  failed,
}: {
  productVariantId: number | null;
  resolution: ReturnVariantSlotResolution | null;
  selectedLocationId: number | null;
  loading: boolean;
  failed: boolean;
}) {
  if (failed) {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
        <TriangleAlert className="h-3 w-3" />
        Slot assignment could not be loaded; choose manually.
      </p>
    );
  }
  if (productVariantId === null) {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
        <TriangleAlert className="h-3 w-3" />
        No exact catalog variant is linked for slot lookup.
      </p>
    );
  }
  if (loading) {
    return <p className="mt-1 text-xs text-muted-foreground">Checking assigned slot...</p>;
  }
  if (resolution === null || resolution.status === "missing" || resolution.status === "unassigned") {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
        <TriangleAlert className="h-3 w-3" />
        No active slotted location is assigned; choose manually.
      </p>
    );
  }
  if (resolution.status === "duplicate") {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
        <TriangleAlert className="h-3 w-3" />
        Multiple active slot assignments exist; choose manually and correct Slotting Setup.
      </p>
    );
  }
  if (resolution.status === "invalid") {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
        <TriangleAlert className="h-3 w-3" />
        The assigned slot is invalid; choose manually and correct Slotting Setup.
      </p>
    );
  }
  if (resolution.status === "unavailable") {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs text-amber-700">
        <TriangleAlert className="h-3 w-3" />
        Slotted location {resolution.warehouseLocationCode ?? "unknown"} is not currently selectable; choose manually.
      </p>
    );
  }
  const overridden = selectedLocationId !== null && selectedLocationId !== resolution.warehouseLocationId;
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
      <MapPin className="h-3 w-3" />
      Slotted location: {resolution.warehouseLocationCode}
      {overridden ? " - Override selected" : " - Slotted default"}
    </p>
  );
}

function OperationError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Inventory treatment failed.";
  const code = error instanceof ReturnCaseAdminApiError ? error.code : null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Operation could not be completed</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {code && <p className="mt-1 font-mono text-xs">{code}</p>}
      </AlertDescription>
    </Alert>
  );
}
