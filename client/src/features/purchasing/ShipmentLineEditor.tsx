import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  shipmentEditorApprovalSchema, shipmentEditorContextSchema, shipmentEditorPreviewSchema, shipmentEditorRequestSchema,
  shipmentEditorResultSchema, type ShipmentEditorContext, type ShipmentEditorPreview, type ShipmentEditorRequest, type ShipmentEditorResult,
} from "@shared/procurement/shipment-editor";
import { SHIPMENT_LINE_EDITABLE_FIELDS, shipmentLineEditableSchema } from "@shared/procurement/shipment-line-command";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/lib/auth";
import { financialCommandFetchJson, FinancialCommandRequestError } from "@/lib/financial-command";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { ShipmentLineAdditions, type AddedShipmentLine } from "./ShipmentLineAdditions";

type Line = ShipmentEditorContext["lines"][number];
type Field = typeof SHIPMENT_LINE_EDITABLE_FIELDS[number];
type Draft = Record<Field, string>;
const labels: Record<Field, string> = { qtyShipped: "Pieces", cartonCount: "Shipping cartons", dimensionBasis: "Measurements per",
  weightKg: "Weight (kg)", lengthCm: "Length (cm)", widthCm: "Width (cm)", heightCm: "Height (cm)", notes: "Line notes" };
const dimensions = ["weightKg", "lengthCm", "widthCm", "heightCm"] as const;
const intentSchema = z.object({ key: z.string().uuid(), body: shipmentEditorApprovalSchema, preview: shipmentEditorPreviewSchema }).strict();
type Intent = z.infer<typeof intentSchema>;

function draftFor(line: Line): Draft {
  return Object.fromEntries(SHIPMENT_LINE_EDITABLE_FIELDS.map(field => [field, line.fields[field] == null ? "" : String(line.fields[field])])) as Draft;
}
function changedFields(line: Line, draft: Draft) {
  const original = draftFor(line);
  const changes: Record<string, unknown> = {};
  for (const field of SHIPMENT_LINE_EDITABLE_FIELDS) {
    if (draft[field] === original[field]) continue;
    if (field === "qtyShipped" || field === "cartonCount") {
      changes[field] = draft[field] === "" && field === "cartonCount" ? null : /^\d+$/.test(draft[field]) ? Number(draft[field]) : NaN;
    } else changes[field] = draft[field] === "" ? null : draft[field];
  }
  return shipmentLineEditableSchema.parse(changes);
}

export function ShipmentEditSummary({ preview }: { preview: ShipmentEditorPreview }) {
  const { review } = preview;
  const keys = [...new Set([...review.before, ...review.after].map(line => line.key))];
  const displayField = (line: Line | undefined, field: Field) => {
    if (!line || line.fields[field] == null) return "—";
    if (field === "dimensionBasis") return line.fields[field] === "carton" ? "Shipping carton" : "Piece";
    return String(line.fields[field]);
  };
  return <div className="space-y-4 text-sm">
    <div><h4 className="font-semibold">Shipment cost shares</h4>{review.costShares.map(share => <p key={share.purchaseOrderId ?? "unlinked"}>{share.poNumber ?? "Unlinked lines"}: {exactMoneyAsInput(share.beforeCents, 2)} → {exactMoneyAsInput(share.afterCents, 2)}</p>)}</div>
    <p>Shipment charges: {review.charges.length ? review.charges.map(charge => `${exactMoneyAsInput(charge.cents, 2)} ${charge.currency}`).join(", ") : "No charges recorded"}. The charge amounts stay the same; their allocation follows the edited lines.</p>
    <h3 className="font-semibold">Before and after</h3>
    {keys.map(key => {
      const before = review.before.find(line => line.key === key), after = review.after.find(line => line.key === key), line = after ?? before!;
      const packingFields = SHIPMENT_LINE_EDITABLE_FIELDS.filter(field => field !== "qtyShipped" && field !== "cartonCount" && before?.fields[field] !== after?.fields[field]);
      const totalFields = (["totalWeightKg", "totalVolumeCbm"] as const).filter(field => before?.[field] !== after?.[field]);
      return <section key={key} className="rounded border p-3">
        <p className="font-semibold">{line.poNumber ?? "Unlinked PO"} · {line.name}</p>
        {(!before || !after) && <p className="text-muted-foreground">{!before ? "Added to shipment" : "Removed from shipment"}</p>}
        <table className="mt-2 w-full text-left" aria-label={`${line.name} before and after`}>
          <thead><tr className="border-b"><th className="py-1">Item</th><th className="py-1 text-right">Before</th><th className="py-1 text-right">After</th></tr></thead>
          <tbody>
            <tr><td className="py-1">Pieces</td><td className="text-right">{before?.fields.qtyShipped?.toLocaleString() ?? "—"}</td><td className="text-right font-medium">{after?.fields.qtyShipped?.toLocaleString() ?? "—"}</td></tr>
            <tr><td className="py-1">Shipping cartons</td><td className="text-right">{displayField(before, "cartonCount")}</td><td className="text-right">{displayField(after, "cartonCount")}</td></tr>
            <tr><td className="py-1">Cost share (USD)</td><td className="text-right">{before ? exactMoneyAsInput(before.allocatedCostCents, 2) : "—"}</td><td className="text-right font-medium">{after ? exactMoneyAsInput(after.allocatedCostCents, 2) : "—"}</td></tr>
          </tbody>
        </table>
        {(packingFields.length > 0 || totalFields.length > 0) && <details className="mt-2 border-t pt-2"><summary className="cursor-pointer">Packing and measurement changes</summary>
          <table className="mt-2 w-full table-fixed text-left"><thead><tr><th className="w-2/5">Item</th><th>Before</th><th>After</th></tr></thead><tbody>
            {packingFields.map(field => <tr key={field}><td className="py-1">{labels[field]}</td><td className="break-words">{displayField(before, field)}</td><td className="break-words">{displayField(after, field)}</td></tr>)}
            {totalFields.map(field => <tr key={field}><td className="py-1">{field === "totalWeightKg" ? "Total weight (kg)" : "Total volume (CBM)"}</td><td>{before?.[field] ?? "—"}</td><td>{after?.[field] ?? "—"}</td></tr>)}
          </tbody></table>
        </details>}
      </section>;
    })}
    <p>Receiving expectations use the saved shipment lines. This edit does not record a receipt or change PO ordered quantities, supplier invoices or payments.</p>
  </div>;
}

export function ShipmentLineEditor({ shipmentId, onLock, onClose, onSaved, onCorrect }: {
  shipmentId: number; onLock: (locked: boolean) => void; onClose: () => void; onSaved?: () => void; onCorrect: () => void;
}) {
  const { user } = useAuth();
  const root = `/api/inbound-shipments/${shipmentId}/editor`;
  const query = useQuery({ queryKey: [root], refetchOnWindowFocus: false, staleTime: 0,
    queryFn: async () => {
      const context = shipmentEditorContextSchema.parse(await financialCommandFetchJson(root, { credentials: "include" }));
      if (context.shipmentId !== shipmentId) throw new Error("The editor returned a different shipment. Reload before editing.");
      return context;
    } });
  if (query.error && !query.data) return <p role="alert">Could not load shipment editing details. {query.error.message} <Button variant="outline" onClick={() => void query.refetch()}>Retry editor</Button></p>;
  if (!query.data) return <p>Loading shipment lines…</p>;
  return <Editor key={`${user?.id}:${shipmentId}`} initial={query.data} storageKey={`shipment-editor:${user?.id}:${shipmentId}`}
    onLock={onLock} onClose={onClose} onSaved={onSaved} onCorrect={onCorrect} />;
}

function Editor({ initial, storageKey, onLock, onClose, onSaved, onCorrect }: {
  initial: ShipmentEditorContext; storageKey: string; onLock: (locked: boolean) => void; onClose: () => void; onSaved?: () => void; onCorrect: () => void;
}) {
  // A refreshed query must not silently replace the evidence an admin is editing.
  const [context] = useState(initial);
  const [drafts, setDrafts] = useState(() => Object.fromEntries(context.lines.map(line => [line.id!, draftFor(line)])));
  const [removed, setRemoved] = useState<number[]>([]);
  const [added, setAdded] = useState<AddedShipmentLine[]>([]);
  const [pendingLine, setPendingLine] = useState(false);
  const [reason, setReason] = useState("");
  const recovery = useRef<{ intent: Intent | null; error: string | null } | null>(null);
  if (!recovery.current) {
    try {
      const saved = sessionStorage.getItem(storageKey);
      const intent = saved ? intentSchema.parse(JSON.parse(saved)) : null;
      if (intent && intent.preview.review.shipmentId !== context.shipmentId) throw new Error("Saved approval belongs to another shipment.");
      recovery.current = { intent, error: null };
    } catch { recovery.current = { intent: null, error: "The saved approval cannot be read. Reload or recover the original approval before making another edit." }; }
  }
  const [intent, setIntent] = useState<Intent | null>(recovery.current.intent);
  const [review, setReview] = useState<{ request: ShipmentEditorRequest; preview: ShipmentEditorPreview } | null>(null);
  const [result, setResult] = useState<ShipmentEditorResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const queryClient = useQueryClient();
  const root = `/api/inbound-shipments/${context.shipmentId}/editor`;
  const blocked = !context.canApprove ? "An Administrator with purchasing approval permission must approve shipment edits." : context.blockedReason;
  const preview = result?.preview ?? intent?.preview ?? review?.preview;
  const locked = busy || intent !== null;
  useEffect(() => { onLock(locked); return () => onLock(false); }, [locked, onLock]);
  async function previewChanges() {
    if (inFlight.current || blocked || stale) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const changes = context.lines.filter(line => !removed.includes(line.id!)).flatMap(line => {
        const fields = changedFields(line, drafts[line.id!]);
        return Object.keys(fields).length ? [{ lineId: line.id!, fields }] : [];
      });
      const request = shipmentEditorRequestSchema.parse({ sourceVersion: context.sourceVersion, reason, changes, removals: removed, additions: added.map(line => line.input) });
      const value = shipmentEditorPreviewSchema.parse(await financialCommandFetchJson(`${root}/preview`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
      if (value.review.shipmentId !== context.shipmentId || value.review.sourceVersion !== request.sourceVersion) throw new Error("The review does not match this shipment. Reload and try again.");
      setReview({ request, preview: value }); setConfirmed(false);
    } catch (cause) {
      setError(cause instanceof z.ZodError ? "Make at least one change, enter valid whole quantities and measurements, and give a reason of at least 10 characters." : cause instanceof Error ? cause.message : "The edit could not be reviewed.");
      if (cause instanceof FinancialCommandRequestError && cause.status === 409) setStale(true);
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function approve(savedIntent?: Intent) {
    if (inFlight.current || (!savedIntent && (!review || !confirmed || blocked || stale))) return;
    inFlight.current = true; setBusy(true); setError(null);
    let pending = savedIntent;
    try {
      if (!pending) {
        pending = { key: crypto.randomUUID(), body: { ...review!.request, previewVersion: review!.preview.previewVersion, approvalConfirmed: true }, preview: review!.preview };
        sessionStorage.setItem(storageKey, JSON.stringify(pending));
      }
      setIntent(pending);
      const raw = await financialCommandFetchJson(root, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.key }, body: JSON.stringify(pending.body) });
      const parsed = shipmentEditorResultSchema.safeParse(raw);
      if (!parsed.success || parsed.data.preview.review.shipmentId !== context.shipmentId || parsed.data.preview.previewVersion !== pending.body.previewVersion) {
        throw new FinancialCommandRequestError("The edit may have saved. Retry this approval to confirm its result.", { status: 200, ambiguous: true, retryable: true });
      }
      setResult(parsed.data); setIntent(null);
      try { sessionStorage.removeItem(storageKey); } catch { setError("Saved successfully. The browser retained its retry receipt; reopening safely verifies the same approval."); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approval could not be confirmed.");
      // Only a server-recorded terminal rejection proves there was no commit.
      if (cause instanceof FinancialCommandRequestError && z.object({ rejected: z.literal(true) }).safeParse(cause.responseBody).success) {
        try { sessionStorage.removeItem(storageKey); setIntent(null); } catch { /* Keep the same retry identity if storage is unavailable. */ }
        setStale(true);
      }
    } finally {
      inFlight.current = false; setBusy(false);
      void invalidatePurchaseCosts(queryClient); onSaved?.();
    }
  }
  function update(id: number, field: Field, value: string) {
    setDrafts(previous => ({ ...previous, [id]: { ...previous[id], [field]: value } }));
  }
  return <div className="flex min-h-0 flex-col">
    <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
      {blocked && <div className="space-y-2 rounded border p-3 text-sm"><p>{blocked}</p>{context.blockedReason && context.lines.length > 0 && <Button variant="outline" onClick={onCorrect}>Receipt and quantity corrections</Button>}</div>}
      {recovery.current.error && <p role="alert">{recovery.current.error}</p>}
      {!preview && !recovery.current.error && <fieldset disabled={locked || !!blocked || stale} className="space-y-4">
        <div className="overflow-x-auto rounded border"><table className="w-full min-w-[650px] text-sm"><thead><tr className="border-b text-left"><th className="p-2">PO / product</th><th className="p-2">Pieces</th><th className="p-2">Shipping cartons</th><th className="p-2">Packing details</th><th className="p-2">Remove</th></tr></thead>
          <tbody>{context.lines.map(line => <tr key={line.id} className={`border-t align-top ${removed.includes(line.id!) ? "bg-muted" : ""}`}>
            <td className="p-2"><p className="font-medium">{line.poNumber ?? "Unlinked PO"}</p><p>{line.sku} · {line.name}</p>{removed.includes(line.id!) && <strong>Will be removed</strong>}</td>
            <td className="p-2"><Input className="min-w-24" aria-label={`Pieces ${line.id}`} inputMode="numeric" value={drafts[line.id!].qtyShipped} disabled={removed.includes(line.id!)} onChange={event => update(line.id!, "qtyShipped", event.target.value)} /></td>
            <td className="p-2"><Input className="min-w-20" aria-label={`Shipping cartons ${line.id}`} inputMode="numeric" value={drafts[line.id!].cartonCount} disabled={removed.includes(line.id!)} onChange={event => update(line.id!, "cartonCount", event.target.value)} /></td>
            <td className="p-2"><details><summary className="cursor-pointer">Measurements and notes</summary><fieldset disabled={removed.includes(line.id!)} className="min-w-52 space-y-2 pt-2">
              <Label htmlFor={`basis-${line.id}`}>Measurements per</Label><select id={`basis-${line.id}`} className="w-full rounded border bg-background p-2" value={drafts[line.id!].dimensionBasis} onChange={event => update(line.id!, "dimensionBasis", event.target.value)}><option value="" disabled>Not recorded</option><option value="carton">Shipping carton</option><option value="piece">Piece</option></select>
              {dimensions.map(field => <div key={field}><Label htmlFor={`${field}-${line.id}`}>{labels[field]}</Label><Input id={`${field}-${line.id}`} inputMode="decimal" value={drafts[line.id!][field]} onChange={event => update(line.id!, field, event.target.value)} /></div>)}
              <Label htmlFor={`notes-${line.id}`}>Line notes</Label><Input id={`notes-${line.id}`} value={drafts[line.id!].notes} maxLength={10000} onChange={event => update(line.id!, "notes", event.target.value)} />
            </fieldset></details></td>
            <td className="p-2"><Button size="sm" variant="outline" onClick={() => setRemoved(values => values.includes(line.id!) ? values.filter(id => id !== line.id) : [...values, line.id!])}>{removed.includes(line.id!) ? "Undo removal" : "Remove line"}</Button></td>
          </tr>)}</tbody></table></div>
        {!blocked && <ShipmentLineAdditions lines={added} existingPoLineIds={context.lines.flatMap(line => line.purchaseOrderLineId === null ? [] : [line.purchaseOrderLineId])} onChange={setAdded} onDraftChange={setPendingLine} disabled={locked || stale} />}
      </fieldset>}
      {preview && <ShipmentEditSummary preview={preview} />}
      {result && <p role="status" className="rounded bg-green-50 p-3 font-semibold text-green-800">Shipment edit saved. Approved by {result.actorName} on {new Date(result.approvedAt).toLocaleString()}. Audit #{result.auditId}.</p>}
    </div>
    <div className="mt-4 shrink-0 space-y-3 border-t pt-3">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!preview && !blocked && !recovery.current.error && <div><Label htmlFor="shipment-editor-reason">Reason / document reference</Label><Input id="shipment-editor-reason" value={reason} maxLength={2000} disabled={locked || stale} onChange={event => setReason(event.target.value)} /></div>}
      {review && !intent && !result && <div className="flex items-center gap-2"><Checkbox id="shipment-editor-confirm" checked={confirmed} disabled={locked || stale} onCheckedChange={value => setConfirmed(value === true)} /><Label htmlFor="shipment-editor-confirm">I reviewed the line changes and cost shares.</Label></div>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={locked} onClick={onClose}>{result ? "Done" : "Close"}</Button>
        {!preview && !blocked && !recovery.current.error && <Button disabled={locked || stale || pendingLine} onClick={() => void previewChanges()}>Review changes</Button>}
        {review && !intent && !result && <><Button variant="outline" disabled={locked || stale} onClick={() => { setReview(null); setConfirmed(false); }}>Keep editing</Button><Button disabled={locked || stale || !confirmed} onClick={() => void approve()}>Approve &amp; save shipment</Button></>}
        {intent && <Button disabled={busy} onClick={() => void approve(intent)}>Retry saved approval</Button>}
      </div>
      {pendingLine && <p className="text-sm">Add the new line to this edit, or cancel it, before reviewing.</p>}
      {stale && !intent && <p className="text-sm">This review is no longer current. Close and reopen the editor to load the latest shipment.</p>}
    </div>
  </div>;
}
