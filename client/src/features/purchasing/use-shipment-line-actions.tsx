import { shipmentUnitOptionsRequestSchema, shipmentUnitOptionsResultSchema } from "@shared/procurement/shipment-unit-options";
import { ShipmentQuantityControl } from "@/components/purchasing/ShipmentQuantityControl";
import { parseShipmentUnits, shipmentQuantityDraft, shipmentQuantityPayload, type ShipmentQuantityDraft } from "@/lib/shipment-unit-entry";
import { purchaseOrderWorkListPageSchema } from "@shared/procurement/purchase-order-work-list";
import { WorkListPagination } from "./WorkListPagination";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { PackingListPreview } from "./PackingListPreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { FinancialCommandRequestError } from "@/lib/financial-command";
import { createShipmentLineCommandClient, createShipmentLineRecoveryStore, shipmentLineEditorFromRecord,
  updateShipmentLinePayload, refreshShipmentLineDraftVersion, shipmentLineNeedsRefresh, type ShipmentLineCommand, type ShipmentLineEditor,
  type ShipmentLineRecovery, type ShipmentLineCommandResult, type ShipmentLineForm } from "@/lib/shipment-line-command";
import { autoMapPackingList, mapPackingListRows, updatePackingListCell, updatePackingListQuantity, packingListUnitOptionRows, PACKING_LIST_FIELDS, type PackingListRow } from "@/lib/shipment-packing-list";
import { SHIPMENT_LINE_IMPORT_LIMIT } from "@shared/procurement/shipment-line-command";
import { z } from "zod";

const shippableSchema = z.object({ lines: z.array(z.object({ id: z.number().int().positive(), sku: z.string().nullable(),
  remainingQty: z.number().int().nonnegative(), orderQty: z.number().int().nonnegative().optional() }).passthrough()),
  reviewRequiredLines: z.array(z.object({ id: z.number().int().positive(), sku: z.string().nullable(), code: z.string(), error: z.string() }).passthrough()).default([]) });
type Modal = "add" | "import" | "edit" | "dimensions" | "recovery" | null;
type DimensionRow = { editor: ShipmentLineEditor; status: "ready" | "saved" | "conflict" | "uncertain"; error?: string };
type UncertainLine = { operation: "update"; editor: ShipmentLineEditor } | { operation: "delete"; editor: ShipmentLineEditor };
const fieldLabels: Record<keyof ShipmentLineForm, string> = { qtyShipped: "Pieces shipped", cartonCount: "Shipping cartons", dimensionBasis: "Dimensions measured per",
  weightKg: "Weight per carton (kg)", lengthCm: "Length (cm)", widthCm: "Width (cm)", heightCm: "Height (cm)", notes: "Notes" };
const dimensionFields = ["weightKg", "lengthCm", "widthCm", "heightCm"] as const;
const packingFields = ["cartonCount", "dimensionBasis", ...dimensionFields] as const;
const message = (error: unknown) => error instanceof Error ? error.message : "The shipment line command failed.";
const ambiguous = (error: unknown) => error instanceof FinancialCommandRequestError && error.ambiguous;

/** UI orchestration only. The shared command boundary owns DTO validation and replay. */
export function useShipmentLineActions({ shipmentId, navigationIdentity, lines, editable }: {
  shipmentId: number | null; navigationIdentity: string; lines: unknown[]; editable: boolean;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recoveryStore = useMemo(() => user?.id ? createShipmentLineRecoveryStore(() => window.sessionStorage, user.id) : null, [user?.id]);
  const commands = useMemo(() => recoveryStore ? createShipmentLineCommandClient(() => `shipment-line-${crypto.randomUUID()}`, recoveryStore) : null, [recoveryStore]);
  const visitIdentity = navigationIdentity + "|" + (user?.id ?? "anonymous");
  const visit = useRef({ identity: visitIdentity, generation: 0, mounted: true });
  if (visit.current.identity !== visitIdentity) visit.current = { ...visit.current, identity: visitIdentity, generation: visit.current.generation + 1 };
  useEffect(() => { visit.current.mounted = true; return () => { visit.current.mounted = false; }; }, []);
  const snapshot = () => { const generation = visit.current.generation; return () => visit.current.mounted && generation === visit.current.generation; };
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<ShipmentLineRecovery | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [uncertainLine, setUncertainLine] = useState<UncertainLine | null>(null);
  const uncertainRef = useRef<UncertainLine | null>(null);
  const [editor, setEditor] = useState<ShipmentLineEditor | null>(null);
  const [editConflict, setEditConflict] = useState(false);
  const [dimensionRows, setDimensionRows] = useState<DimensionRow[]>([]);
  const [dimensionReview, setDimensionReview] = useState<Array<{ lineId: number; message: string }>>([]);
  const [poId, setPoId] = useState<number | null>(null);
  const [poSearch, setPoSearch] = useState("");
  const [poOffset, setPoOffset] = useState(0);
  const [selectedPo, setSelectedPo] = useState<{ id: number; poNumber: string } | null>(null);
  const [selections, setSelections] = useState<Record<number, ShipmentQuantityDraft>>({});
  const [rawRows, setRawRows] = useState<PackingListRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [importRows, setImportRows] = useState<PackingListRow[] | null>(null);
  const [rowErrors, setRowErrors] = useState<Array<{ row: number; error: string }>>([]);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const parseGeneration = useRef(0);
  const readRecovery = () => {
    if (!shipmentId || !recoveryStore) return;
    try { setRecovery(recoveryStore.read(shipmentId)); setRecoveryError(null); }
    catch (cause) { setRecoveryError(message(cause)); }
  };
  useEffect(() => {
    // Drafts cannot cross shipment visits. Durable collection recovery never auto-executes.
    setModal(null); setEditor(null); setEditConflict(false); setDimensionRows([]); setDimensionReview([]); setPoId(null); setSelectedPo(null); setPoSearch(""); setPoOffset(0); setSelections({});
    setRawRows([]); setHeaders([]); setMapping({}); setImportRows(null); setRowErrors([]); setImportSummary(null);
    setError(null); setRecovery(null); setRecoveryError(null); setUncertainLine(null); uncertainRef.current = null;
    parseGeneration.current += 1;
    readRecovery();
  }, [shipmentId, recoveryStore]);
  useEffect(() => {
    if (!recovery && !uncertainLine && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recovery, uncertainLine, busy]);

  const poListUrl = `/api/purchase-orders/work-list?${new URLSearchParams({ purpose: "shipment-lines", search: poSearch, limit: "20", offset: String(poOffset) })}`;
  const poList = useQuery({
    queryKey: [poListUrl], enabled: modal === "add", staleTime: 0,
    queryFn: async ({ signal }) => {
      const response = await fetch(poListUrl, { credentials: "include", signal });
      if (!response.ok) throw new Error("Purchase orders could not be loaded. Retry the list.");
      return purchaseOrderWorkListPageSchema.parse(await response.json());
    },
  });
  const shippable = useQuery({ queryKey: [`/api/purchase-orders/${poId}/shippable-lines`], enabled: modal === "add" && poId !== null,
    queryFn: async () => { const response = await fetch(`/api/purchase-orders/${poId}/shippable-lines`, { credentials: "include" });
      if (!response.ok) throw new Error("Remaining purchase quantities could not be loaded. Refresh and try again.");
      return shippableSchema.parse(await response.json()); }, staleTime: 0, refetchOnMount: "always" });
  const purchaseOrders = poList.data?.items ?? [];
  const packingOptionRows = packingListUnitOptionRows(importRows ?? []);
  const packingCatalog = useQuery({
    queryKey: ["/api/inbound-shipments", shipmentId, "line-unit-options", packingOptionRows],
    enabled: modal === "import" && shipmentId !== null && packingOptionRows.length > 0, retry: false, staleTime: 0,
    queryFn: async ({ signal }) => {
      const body = shipmentUnitOptionsRequestSchema.parse({ rows: packingOptionRows });
      const response = await fetch(`/api/inbound-shipments/${shipmentId}/lines/unit-options`, {
        method: "POST", credentials: "include", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Configured receive units could not be loaded.");
      const result = shipmentUnitOptionsResultSchema.parse(await response.json());
      if (result.shipmentId !== shipmentId || result.rows.length !== body.rows.length
        || result.rows.some((row, index) => row.row !== index + 1)) throw new Error("Receive-unit evidence does not match the preview rows. Retry the lookup.");
      return result;
    },
  });

  async function refresh(originId: number): Promise<boolean> {
    try {
      await queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === "string" && (
        query.queryKey[0] === `/api/inbound-shipments/${originId}` || query.queryKey[0].startsWith(`/api/inbound-shipments/${originId}/`)
        || query.queryKey[0].startsWith("/api/purchase-orders") || query.queryKey[0] === "/api/inbound-shipments"
      ) }, { throwOnError: true });
      return true;
    } catch (cause) {
      console.error("shipment_line_refresh_failed", { shipmentId: originId, error: message(cause) });
      return false;
    }
  }
  function notifySaved(title: string, fresh: boolean) {
    toast({ title, description: fresh ? undefined : "The command completed, but this view could not refresh. Reload the shipment to inspect the saved result.", variant: fresh ? "default" : "destructive" });
  }
  const ensureReady = (replaying = false) => {
    if (!shipmentId || !commands || !recoveryStore) throw new Error("Sign in and load a shipment before changing lines.");
    if (!editable && !replaying) throw new Error("This shipment is read-only. Refresh to inspect its current status.");
    return { id: shipmentId, client: commands };
  };
  function report(cause: unknown) { setError(message(cause)); toast({ title: "Line change needs review", description: message(cause), variant: "destructive" }); }
  function recordUncertain(value: UncertainLine | null) { uncertainRef.current = value; setUncertainLine(value); }

  async function runCommand(command: ShipmentLineCommand, pinnedRecovery?: ShipmentLineRecovery) {
    if (inFlight.current) return;
    const isCurrent = snapshot();
    let originId: number | null = null;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const ready = ensureReady(!!pinnedRecovery); originId = ready.id;
      const result = await ready.client.execute(ready.id, command, pinnedRecovery);
      const fresh = await refresh(ready.id);
      if (!isCurrent()) return;
      readRecovery(); recordUncertain(null);
      applyCommandResult(command, result, fresh);
    } catch (cause) {
      if (originId) await refresh(originId);
      if (isCurrent()) { readRecovery(); report(cause); }
    } finally { inFlight.current = false; setBusy(false); }
  }
  function applyCommandResult(command: ShipmentLineCommand, result: ShipmentLineCommandResult, fresh: boolean) {
    if (result.operation === "import" && command.operation === "import") {
      const summary = `${result.result.imported} rows imported; ${result.result.errors.length} rows rejected.`;
      setImportSummary(summary);
      // The validated response accounts for every row. Keep only rejected rows for correction.
      setImportRows(result.result.errors.map((failure) => command.body.rows[failure.row - 1] as PackingListRow));
      setRowErrors(result.result.errors.map((failure, index) => ({ row: index + 1, error: `Submitted data row ${failure.row}: ${failure.error}` })));
      setRawRows([]); setHeaders([]); setMapping({}); setModal("import");
      notifySaved(summary, fresh);
    } else if (result.operation === "resolve-dimensions") {
      setModal(null); setDimensionReview(result.reviewRequiredLines);
      notifySaved(`${result.updated} of ${result.total} lines updated from product data${result.reviewRequiredLines.length ? `; ${result.reviewRequiredLines.length} need packing measurements` : ""}`, fresh);
    } else if (result.operation === "update" || result.operation === "delete") {
      setModal(null); setEditor(null); setEditConflict(false); setDimensionRows([]); notifySaved(result.operation === "update" ? "Line updated" : "Line removed", fresh);
    } else if (result.operation === "add-from-po") {
      setModal(null); setPoId(null); setSelectedPo(null); setSelections({}); notifySaved(`${result.lines.length} lines added`, fresh);
    }
  }

  async function saveEditor(value: ShipmentLineEditor, deleting = false) {
    if (inFlight.current) return;
    const isCurrent = snapshot();
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const ready = ensureReady();
      if (ready.id !== value.shipmentId) throw new Error("This draft belongs to another shipment.");
      const existing = uncertainRef.current;
      if (existing && (existing.editor.id !== value.id || existing.operation !== (deleting ? "delete" : "update"))) throw new Error("Retry the unresolved line command first.");
      await ready.client.execute(ready.id, deleting ? { operation: "delete", lineId: value.id, body: { expectedVersion: value.version } }
        : { operation: "update", lineId: value.id, body: updateShipmentLinePayload(value) }, existing ? recovery ?? undefined : undefined);
      const fresh = await refresh(ready.id);
      if (!isCurrent()) return;
      readRecovery(); recordUncertain(null); setModal(null); setEditor(null); setEditConflict(false); notifySaved(deleting ? "Line removed" : "Line updated", fresh);
    } catch (cause) {
      await refresh(value.shipmentId);
      if (!isCurrent()) return;
      readRecovery();
      if (ambiguous(cause)) recordUncertain({ operation: deleting ? "delete" : "update", editor: value });
      else { recordUncertain(null); if (shipmentLineNeedsRefresh(cause)) setEditConflict(true); }
      report(cause);
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function loadLatest(lineId: number): Promise<ShipmentLineEditor> {
    const ready = ensureReady();
    const response = await fetch(`/api/inbound-shipments/${ready.id}`, { credentials: "include" });
    if (!response.ok) throw new Error("Latest shipment lines could not be loaded. Your draft is still preserved.");
    const data: unknown = await response.json();
    const parsed = z.object({ id: z.literal(ready.id), lines: z.array(z.object({ id: z.number() }).passthrough()) }).parse(data);
    const line = parsed.lines.find((candidate) => candidate.id === lineId);
    if (!line) throw new Error("This line no longer exists in the shipment. Close this editor and refresh the shipment.");
    return shipmentLineEditorFromRecord(line, ready.id);
  }
  async function reloadEditor() {
    if (!editor || inFlight.current) return;
    const isCurrent = snapshot(); inFlight.current = true; setBusy(true);
    try { const latest = await loadLatest(editor.id); if (isCurrent()) { setEditor(latest); setEditConflict(false); setError(null); } }
    catch (cause) { if (isCurrent()) report(cause); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function openEditor(line: unknown) {
    try {
      const ready = ensureReady();
      const saved = shipmentLineEditorFromRecord(line, ready.id);
      const unresolved = uncertainRef.current;
      if (unresolved) {
        setEditor(unresolved.editor); setModal("edit");
        setError(unresolved.operation === "delete" ? "The earlier removal is unresolved. Retry removal from the recovery banner." : "Retry the original edit before changing this line."); return;
      }
      setEditor(saved); setEditConflict(false); setError(null); setModal("edit");
    } catch (cause) { report(cause); }
  }
  function remove(line: unknown) {
    try { const ready = ensureReady(); const value = uncertainRef.current?.editor ?? shipmentLineEditorFromRecord(line, ready.id);
      if (window.confirm(`Remove ${value.sku} from this shipment?`)) void saveEditor(value, true);
    } catch (cause) { report(cause); }
  }
  function openCollection(next: "add" | "import") {
    readRecovery(); setError(null);
    try { if (shipmentId && recoveryStore?.read(shipmentId)) { setModal("recovery"); return; } }
    catch (cause) { report(cause); return; }
    setModal(next);
  }
  function openDimensions() {
    try { const ready = ensureReady();
      if (recoveryStore?.read(ready.id)) { readRecovery(); setModal("recovery"); return; }
      const editors = lines.map((line) => shipmentLineEditorFromRecord(line, ready.id));
      setDimensionRows(editors.filter((value) => dimensionFields.some((field) => !value.form[field] || Number(value.form[field]) === 0))
        .map((value) => ({ editor: value, status: "ready" })));
      setError(null); setModal("dimensions");
    } catch (cause) { report(cause); }
  }
  async function saveDimensions() {
    if (inFlight.current) return;
    const isCurrent = snapshot(); const submitted = dimensionRows;
    let earlierRowSaved = submitted.some((row) => row.status === "saved");
    inFlight.current = true; setBusy(true); setError(null);
    let originId: number | null = null;
    try {
      const ready = ensureReady(); originId = ready.id;
      if (uncertainRef.current) throw new Error("Retry the unresolved line command first.");
      for (const row of submitted) {
        if (row.status === "saved" || row.status === "conflict") continue;
        try {
          if (packingFields.every((field) => row.editor.form[field] === row.editor.original[field])) continue;
          const executable = earlierRowSaved && row.status !== "uncertain"
            ? refreshShipmentLineDraftVersion(row.editor, await loadLatest(row.editor.id)) : row.editor;
          if (isCurrent()) setDimensionRows((current) => current.map((item) => item.editor.id === row.editor.id ? { ...item, editor: executable } : item));
          const pinned = row.status === "uncertain" ? recoveryStore?.read(ready.id) ?? undefined : undefined;
          await ready.client.execute(ready.id, { operation: "update", lineId: executable.id, body: updateShipmentLinePayload(executable) }, pinned);
          earlierRowSaved = true;
          if (isCurrent()) setDimensionRows((current) => current.map((item) => item.editor.id === row.editor.id ? { ...item, status: "saved", error: undefined } : item));
        } catch (cause) {
          if (isCurrent()) setDimensionRows((current) => current.map((item) => item.editor.id === row.editor.id ? {
            ...item, status: ambiguous(cause) ? "uncertain" : shipmentLineNeedsRefresh(cause) ? "conflict" : "ready", error: message(cause),
          } : item));
          // Stop at the first failure. Earlier successful rows remain explicitly saved.
          throw cause;
        }
      }
      const fresh = await refresh(ready.id);
      if (isCurrent()) { readRecovery(); notifySaved("Dimension changes saved; review allocation status before closing the shipment", fresh); }
    } catch (cause) { if (originId) await refresh(originId); if (isCurrent()) { readRecovery(); report(cause); } }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function reloadDimension(lineId: number) {
    const isCurrent = snapshot();
    try { const latest = await loadLatest(lineId); if (isCurrent()) setDimensionRows((rows) => rows.map((row) => row.editor.id === lineId ? { editor: latest, status: "ready" } : row)); }
    catch (cause) { if (isCurrent()) report(cause); }
  }
  function parseFile(file: File) {
    const isCurrent = snapshot(); const generation = ++parseGeneration.current;
    setError(null); setImportRows(null); setRawRows([]); setRowErrors([]); setImportSummary(null);
    Papa.parse<PackingListRow>(file, { header: true, skipEmptyLines: true, complete: (result) => {
      if (!isCurrent() || generation !== parseGeneration.current) return;
      if (result.errors.length) { report(new Error(result.errors.map((issue) => `${issue.row === undefined ? "CSV" : `Data row ${issue.row + 1}`}: ${issue.message}`).join("; "))); return; }
      if (!result.data.length || result.data.length > SHIPMENT_LINE_IMPORT_LIMIT) { report(new Error(`Choose a CSV with 1–${SHIPMENT_LINE_IMPORT_LIMIT} data rows.`)); return; }
      const fields = result.meta.fields ?? []; setHeaders(fields); setMapping(autoMapPackingList(fields)); setRawRows(result.data);
    }, error: (cause) => { if (isCurrent() && generation === parseGeneration.current) report(cause); } });
  }
  function previewImport() { try { setImportRows(mapPackingListRows(rawRows, mapping)); setError(null); } catch (cause) { report(cause); } }
  function submitPo() {
    if (!poId) return;
    try {
      const selected = Object.entries(selections).map(([id, draft]) => {
        const source = shippable.data?.lines.find((line) => line.id === Number(id));
        if (!source) throw new Error("Refresh and review the selected purchase line.");
        const { qtyShipped, ...unit } = shipmentQuantityPayload(draft, parseShipmentUnits(source.shipmentUnits), source.remainingQty);
        return { poLineId: Number(id), qty: qtyShipped, ...unit };
      });
      if (!selected.length) throw new Error("Select at least one purchase line.");
      void runCommand({ operation: "add-from-po", body: { purchaseOrderId: poId, lineSelections: selected } });
    } catch (cause) { report(cause); }
  }
  const changeField = (field: keyof ShipmentLineForm, value: string) => setEditor((current) => current ? { ...current, form: { ...current.form, [field]: value } } : current);
  const editorLocked = busy || editConflict || !!uncertainLine;
  const collectionLocked = busy || !!recovery || !!recoveryError || !!uncertainLine || !editable;
  const recoveryBanner = <>{dimensionReview.length > 0 && <div role="status" className="rounded border border-amber-500/50 p-3 text-sm space-y-2"><p className="font-medium">Packing measurements still needed</p>{dimensionReview.map((line) => <p key={line.lineId}>Line #{line.lineId}: {line.message}</p>)}<Button variant="outline" disabled={busy} onClick={openDimensions}>Enter packing measurements</Button></div>}{(recovery || recoveryError || uncertainLine) && <div role="status" className="rounded-md border border-amber-500/50 bg-amber-50/50 p-3 text-sm space-y-2 dark:bg-amber-950/20">
    <p className="font-medium">Shipment line change needs review</p>
    <p>{recoveryError ?? (recovery ? "An earlier line command has an unknown outcome. Its original request is saved in this browser tab; review and retry it before changing shipment lines." : "An earlier line edit or removal has an unknown outcome. Retry its original request before changing another line.")}</p>
    {recovery && <Button size="sm" variant="outline" onClick={() => { setError(null); setModal("recovery"); }}>Review pending line command</Button>}
    {uncertainLine && <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveEditor(uncertainLine.editor, uncertainLine.operation === "delete")}>Retry original {uncertainLine.operation === "delete" ? "removal" : "edit"}</Button>}
  </div>}</>;
  const dialogs = <Dialog open={modal !== null} onOpenChange={(open) => { if (!open) setModal(null); }}>
    <DialogContent className="max-w-3xl max-h-[90dvh] min-w-0 overflow-y-auto">
      <DialogHeader><DialogTitle>{modal === "add" ? "Add Lines from Purchase Order" : modal === "import" ? "Import Packing List" : modal === "edit" ? `Edit Line — ${editor?.sku ?? ""}` : modal === "dimensions" ? "Enter missing dimensions" : "Review pending line command"}</DialogTitle>
        <DialogDescription>{modal === "edit" ? "Choose a configured receive unit and quantity. Review the exact piece total before saving. Shipping cartons describe physical packing separately." : modal === "import" ? "Import up to 500 data rows. Valid rows are saved; rejected rows stay here for correction." : modal === "dimensions" ? "Each line saves separately. Completed rows remain saved if a later row fails." : modal === "recovery" ? "Retry sends the exact original request and key. It does not start a second command." : "Choose the unit and quantity shipped from each purchase line. The exact piece total is checked against the remaining purchase quantity."}</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
      {modal === "recovery" && recovery && <div className="min-w-0 space-y-3">
        <p className="font-medium">{recovery.command.operation}</p>
        <pre className="text-xs whitespace-pre-wrap break-all rounded border p-3 max-h-72 overflow-auto">{JSON.stringify(recovery.command.body, null, 2)}</pre>
        <Button disabled={busy} onClick={() => void runCommand(recovery.command, recovery)}>{busy ? "Retrying…" : "Retry original line command"}</Button>
      </div>}
      {modal === "add" && <div className="min-w-0 space-y-4">
        <fieldset disabled={collectionLocked} className="min-w-0 space-y-3">
          <Label htmlFor="shipment-po-search">Find purchase order</Label><Input id="shipment-po-search" value={poSearch} onChange={(event) => { setPoSearch(event.target.value); setPoOffset(0); }} placeholder="Search PO number" />
          {poList.isError && <div role="alert">Purchase orders could not be loaded. <Button type="button" variant="link" onClick={() => void poList.refetch()}>Retry purchase orders</Button></div>}
          {poList.isFetching && <p role="status">Loading purchase orders…</p>}
          {!poList.isError && !poList.isFetching && poList.data?.total === 0 && <p>No purchase orders match this search.</p>}
          <Label htmlFor="shipment-po-select">Purchase order</Label><select id="shipment-po-select" className="w-full rounded border bg-background p-2"
            disabled={poList.isFetching || poList.isError} value={poId ?? ""} onChange={(event) => {
              const id = event.target.value ? Number(event.target.value) : null;
              setPoId(id); setSelectedPo(purchaseOrders.find(po => po.id === id) ?? null); setSelections({});
            }}>
            <option value="">Select purchase order</option>
            {selectedPo && !purchaseOrders.some(po => po.id === selectedPo.id) && <option value={selectedPo.id}>{selectedPo.poNumber} (selected)</option>}
            {purchaseOrders.map(po => <option key={po.id} value={po.id}>{po.poNumber}</option>)}
          </select>
          {!poList.isError && <WorkListPagination page={poList.data} busy={poList.isFetching} onOffset={setPoOffset} label="purchase orders" />}
          {shippable.isFetching && poId && <p>Loading remaining quantities…</p>}
          {shippable.error && <p role="alert">{message(shippable.error)}</p>}
          {shippable.data?.reviewRequiredLines.map((line) => <p key={line.id} role="alert" className="rounded border border-amber-500/50 p-2 text-sm">{line.sku ?? `PO line ${line.id}`}: {line.error}</p>)}
          {poId && shippable.data?.lines.filter((line) => line.remainingQty > 0).map((line) => <div key={line.id} className="rounded border p-3 space-y-2">
            <label className="flex items-center gap-2"><input type="checkbox" checked={selections[line.id] !== undefined} onChange={(event) => setSelections((current) => { const next = { ...current }; if (event.target.checked) next[line.id] = shipmentQuantityDraft(line.remainingQty, parseShipmentUnits(line.shipmentUnits)); else delete next[line.id]; return next; })} />{line.sku ?? `PO line ${line.id}`}</label>
            <p className="text-xs text-muted-foreground">Remaining to ship: {line.remainingQty} pieces</p>
            {selections[line.id] !== undefined && <ShipmentQuantityControl id={`po-line-${line.id}`} value={selections[line.id]} units={parseShipmentUnits(line.shipmentUnits)} maximumPieces={line.remainingQty} quantityLabel={`Pieces for ${line.sku ?? line.id}`} onChange={(draft) => setSelections((current) => ({ ...current, [line.id]: draft }))} />}
          </div>)}
          {poId && shippable.data && !shippable.data.lines.some((line) => line.remainingQty > 0) && <p>No remaining quantities are available to ship.</p>}
        </fieldset>
        <Button disabled={collectionLocked || shippable.isFetching || !!shippable.error || !Object.keys(selections).length} onClick={submitPo}>{busy ? "Adding…" : "Add selected lines"}</Button>
      </div>}
      {modal === "import" && <div className="min-w-0 space-y-4">
        {importSummary && <p role="status" className="font-medium">{importSummary}</p>}
        {packingCatalog.isError && <p role="alert" className="text-sm">Configured receive units could not be loaded. Existing piece entries remain visible. <Button variant="link" onClick={() => void packingCatalog.refetch()}>Retry receive units</Button></p>}
        <p className="text-xs text-muted-foreground">For case or pack CSV quantities, map Receive variant ID, Receive unit count and Pieces per receive unit together. The catalog is checked before saving; shipping carton counts never supply a conversion factor.</p>
        <fieldset disabled={collectionLocked} className="min-w-0 space-y-3">
          {!importRows && <><Label htmlFor="packing-list-file">Packing list CSV</Label><Input id="packing-list-file" type="file" accept=".csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) parseFile(file); }} />
            {rawRows.length > 0 && <><p>{rawRows.length} data rows found</p><div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{PACKING_LIST_FIELDS.map(({ field, label }) => <div key={field} className="space-y-1"><Label htmlFor={`mapping-${field}`}>{label}</Label><select id={`mapping-${field}`} className="w-full rounded border bg-background p-2" value={mapping[field] ?? "__skip__"} onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value }))}><option value="__skip__">Skip</option>{headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></div>)}</div><Button onClick={previewImport}>Preview rows</Button></>}
          </>}
          {importRows && importRows.length > 0 && <><p className="text-xs text-muted-foreground">Review the configured count unit and exact piece total for each row. Shipping cartons describe physical packing. Errors refer to data rows, excluding the CSV header.</p><PackingListPreview rows={importRows} errors={rowErrors} unitOptions={packingCatalog.isError ? [] : packingCatalog.data?.rows ?? []} onChange={(index, field, value) => setImportRows((current) => current?.map((row, rowIndex) => rowIndex === index ? updatePackingListCell(row, field, value) : row) ?? null)} onQuantityChange={(index, draft, units) => setImportRows((current) => current?.map((row, rowIndex) => rowIndex === index ? updatePackingListQuantity(row, draft, units) : row) ?? null)} />
            <div className="flex flex-wrap gap-2"><Button onClick={() => void runCommand({ operation: "import", body: { rows: importRows } })}>{busy ? "Importing…" : `Import ${importRows.length} rows`}</Button>{rawRows.length > 0 && <Button variant="outline" onClick={() => setImportRows(null)}>Change column mapping</Button>}</div></>}
          {importRows?.length === 0 && <p>All submitted rows were imported.</p>}
          {importRows && <Button variant="outline" onClick={() => { setImportRows(null); setRawRows([]); setRowErrors([]); setImportSummary(null); }}>Choose another CSV</Button>}
        </fieldset>
      </div>}
      {modal === "edit" && editor && <div className="min-w-0 space-y-4">
        <p className="text-xs text-muted-foreground">Line #{editor.id}</p>
        {editor.physicalReviewRequired && <p role="status" className="rounded border border-amber-500/50 p-3 text-sm">This line has recorded physical values that need review. Correcting notes preserves those values; physical changes must pass current validation.</p>}
        {editConflict && <div role="alert" className="rounded border p-3 text-sm">This line changed or is no longer available. Load its latest values and review them before saving.<Button className="mt-2 block" variant="outline" disabled={busy} onClick={() => void reloadEditor()}>Load latest line</Button></div>}
        <ShipmentQuantityControl id={`line-edit-${editor.id}`} value={editor.quantity} units={editor.units} disabled={editorLocked}
          onChange={(quantity) => setEditor((current) => current ? { ...current, quantity } : current)} />
        <fieldset disabled={editorLocked} className="space-y-3 rounded border p-3">
          <legend className="px-1 text-sm font-medium">Physical packing</legend>
          <p className="text-xs text-muted-foreground">Shipping cartons can contain partial packs. They are never calculated from the selected receive unit.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1"><Label htmlFor="line-edit-cartonCount">Shipping cartons</Label><Input id="line-edit-cartonCount" inputMode="numeric" value={editor.form.cartonCount} onChange={(event) => changeField("cartonCount", event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="line-edit-dimensionBasis">Dimensions measured per</Label><select id="line-edit-dimensionBasis" className="h-10 w-full rounded border bg-background px-2" value={editor.form.dimensionBasis} onChange={(event) => changeField("dimensionBasis", event.target.value)}>
              {editor.original.dimensionBasis === "" && <option value="">Existing basis: {editor.original.cartonCount ? "shipping carton" : "piece"}</option>}
              <option value="piece">Piece</option><option value="carton">Shipping carton</option>
            </select></div>
            {dimensionFields.map((field) => <div key={field} className="space-y-1"><Label htmlFor={`line-edit-${field}`}>{field === "weightKg" ? `Weight per ${(editor.form.dimensionBasis || (editor.original.cartonCount ? "carton" : "piece")) === "carton" ? "shipping carton" : "piece"} (kg)` : fieldLabels[field]}</Label><Input id={`line-edit-${field}`} inputMode="decimal" value={editor.form[field]} onChange={(event) => changeField(field, event.target.value)} /></div>)}
          </div>
          <p className="text-xs text-muted-foreground">Weight and volume use {editor.form.dimensionBasis || (editor.original.cartonCount ? "carton" : "piece")} measurements × {(editor.form.dimensionBasis || (editor.original.cartonCount ? "carton" : "piece")) === "carton" ? (editor.form.cartonCount || "the required shipping carton count") : "shipped pieces"}. Changing count units does not change these measurements.</p>
        </fieldset>
        <div className="space-y-1"><Label htmlFor="line-edit-notes">Notes</Label><Input id="line-edit-notes" disabled={editorLocked} value={editor.form.notes} onChange={(event) => changeField("notes", event.target.value)} /></div>
        <Button disabled={busy || editConflict || uncertainLine?.operation === "delete"} onClick={() => void saveEditor(uncertainLine?.editor ?? editor)}>{busy ? "Saving…" : uncertainLine ? "Retry original edit" : "Save line"}</Button>
      </div>}
      {modal === "dimensions" && <div className="min-w-0 space-y-4">
        {!dimensionRows.length && <p>No lines with missing dimensions were found. Review allocation status for any remaining blockers.</p>}
        {dimensionRows.map((row) => <div key={row.editor.id} className="rounded border p-3 space-y-2"><p className="font-medium">{row.editor.sku} — {row.status === "saved" ? "Saved" : row.status === "uncertain" ? "Outcome unknown; retry original values" : row.status === "conflict" ? "Changed; load latest" : "Not saved"}</p>
          {row.error && <p role="alert" className="text-sm text-destructive">{row.error}</p>}
          <fieldset disabled={busy || row.status !== "ready"} className="grid grid-cols-1 sm:grid-cols-2 gap-2">{packingFields.map((field) => <div key={field}><Label htmlFor={`dimension-${row.editor.id}-${field}`}>{field === "weightKg" ? `Weight per ${(row.editor.form.dimensionBasis || (row.editor.original.cartonCount ? "carton" : "piece")) === "carton" ? "shipping carton" : "piece"} (kg)` : fieldLabels[field]}</Label>
            {field === "dimensionBasis" ? <select id={`dimension-${row.editor.id}-${field}`} className="h-10 w-full rounded border bg-background px-2" value={row.editor.form[field]} onChange={(event) => setDimensionRows((current) => current.map((item) => item.editor.id === row.editor.id ? { ...item, editor: { ...item.editor, form: { ...item.editor.form, dimensionBasis: event.target.value } } } : item))}>
              {row.editor.original.dimensionBasis === "" && <option value="">Existing basis: {row.editor.original.cartonCount ? "shipping carton" : "piece"}</option>}<option value="piece">Piece</option><option value="carton">Shipping carton</option>
            </select> : <Input id={`dimension-${row.editor.id}-${field}`} inputMode="decimal" value={row.editor.form[field]} onChange={(event) => setDimensionRows((current) => current.map((item) => item.editor.id === row.editor.id ? { ...item, editor: { ...item.editor, form: { ...item.editor.form, [field]: event.target.value } } } : item))} />}</div>)}</fieldset>
          <p className="text-xs text-muted-foreground">Measurements are per {row.editor.form.dimensionBasis || (row.editor.original.cartonCount ? "carton" : "piece")}. Enter actual shipping carton counts when using carton measurements.</p>
          {row.status === "conflict" && <Button variant="outline" disabled={busy} onClick={() => void reloadDimension(row.editor.id)}>Load latest for {row.editor.sku}</Button>}
        </div>)}
        <Button disabled={busy || !dimensionRows.some((row) => row.status === "uncertain" || row.status === "ready" && packingFields.some((field) => row.editor.form[field] !== row.editor.original[field]))} onClick={() => void saveDimensions()}>{busy ? "Saving…" : "Save remaining dimensions"}</Button>
      </div>}
      <div className="flex justify-end"><Button variant="outline" onClick={() => setModal(null)}>Close</Button></div>
    </DialogContent>
  </Dialog>;
  return { dialogs, recoveryBanner, busy, openEditor, remove, openDimensions,
    openAdd: () => openCollection("add"), openImport: () => openCollection("import"),
    resolve: () => { if (recovery) setModal("recovery"); else void runCommand({ operation: "resolve-dimensions", body: {} }); } };
}
