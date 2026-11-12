import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import type { PromiseSafetyAdminScope, PromiseSafetyAdminValue } from "@shared/types/inventory-promise-safety-admin";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { describeError } from "../api";
import {
  HOLD_BACK_ENDPOINT, activeHoldBackExceptions, describeHoldBack, describeHoldBackOutcome, fetchHoldBackOverview, holdBackFingerprint,
  holdBackInput, parseHoldBack, sameHoldBack, saveHoldBack, type HoldBackException, type HoldBackOutcome,
} from "../available-stock";
import { describePackUnit, formatAbsoluteTime } from "../format";
import { invalidateChannelInventory, useChannelInventoryView, useCommandKey } from "../hooks";
import { sellableVariants, type View } from "../model";
import { ProductPicker } from "./ProductPicker";
import { Callout, EvidenceNote, NoteField, SectionCard } from "./primitives";

const OVERVIEW_QUERY_KEY = [HOLD_BACK_ENDPOINT, "overview"] as const;
/** The demand-based mode and its evidence stay on the screen that shows that evidence. */
const ADVANCED_PATH = "/settings/procurement/promise-safety";

type Editing = { kind: "add" } | { kind: "edit"; row: HoldBackException };

/**
 * Channel Inventory → Available stock: what is held back from every channel
 * before any channel stock rule runs. One number for the business and optional
 * numbers per SKU; saving takes effect straight away.
 */
export function AvailableStockPanel({ view, canChange }: { view: View; canChange: boolean }) {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: OVERVIEW_QUERY_KEY, queryFn: ({ signal }) => fetchHoldBackOverview(signal) });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const finished = async (subject: string, outcome: HoldBackOutcome) => {
    setMessage({ ok: outcome.status === "saved", text: `${subject}: ${describeHoldBackOutcome(outcome)}` });
    // Refresh even after a failure: an unknown outcome is resolved by what the server now holds.
    await Promise.all([queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY }), invalidateChannelInventory(queryClient)]).catch(() => undefined);
  };

  if (overview.isLoading) return <p className="text-sm text-muted-foreground">Loading available stock settings…</p>;
  if (overview.isError || !overview.data) {
    return (
      <Callout tone="danger" title="Available stock settings could not be loaded"
        action={<Button type="button" size="sm" variant="outline" onClick={() => void overview.refetch()}>Try again</Button>}>
        {describeError(overview.error).message}
      </Callout>
    );
  }
  const data = overview.data;
  if (data.runtimeAuthority !== "canonical") {
    return <Callout>Held-back stock applies after inventory cutover. Nothing set here would change what channels are sent yet.</Callout>;
  }
  const exceptions = activeHoldBackExceptions(data);

  return (
    <section className="min-w-0 space-y-5" aria-label="Available stock">
      <div>
        <h2 className="text-lg font-semibold leading-tight">Available stock</h2>
        <p className="text-xs text-muted-foreground">Held back from every channel, before any channel stock rule runs.</p>
      </div>

      {!canChange && <Callout>Changing held-back stock needs inventory planning edit and activate permission.</Callout>}

      <BusinessHoldBack key={data.business?.revision ?? "none"} setting={data.business} canChange={canChange}
        onDone={outcome => finished("Every SKU", outcome)} />

      <SectionCard
        title="SKU exceptions"
        description="A SKU listed here uses its own number instead of the one above."
        actions={canChange ? <Button type="button" size="sm" onClick={() => { setMessage(null); setEditing({ kind: "add" }); }}>Add exception</Button> : undefined}
      >
        {exceptions.length === 0
          ? <p className="text-sm text-muted-foreground">No exceptions. Every SKU uses the number above.</p>
          : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Hold back</TableHead>
                    <TableHead>Last changed</TableHead>
                    <TableHead><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exceptions.map(row => <ExceptionRow key={row.scopeKey} row={row} canChange={canChange}
                    onEdit={() => { setMessage(null); setEditing({ kind: "edit", row }); }} />)}
                </TableBody>
              </Table>
            </div>
          )}
      </SectionCard>

      {message && (
        <p role="status" data-testid="hold-back-result" className={`rounded-md border p-3 text-sm ${message.ok ? "" : "text-destructive"}`}>{message.text}</p>
      )}

      <EvidenceNote>
        Held-back units come off a SKU's stock in each warehouse before channels are sent anything, so every channel sees less.
        Stock rules then limit each channel separately. Reorder safety stock is a different setting and stays in Procurement.{" "}
        <Link href={ADVANCED_PATH} className="underline underline-offset-2">Hold back by days of recent sales</Link>
      </EvidenceNote>

      {editing && (
        <ExceptionEditor key={editing.kind === "edit" ? editing.row.scopeKey : "add"} view={view} editing={editing}
          existing={data.exceptions} onClose={() => setEditing(null)}
          onDone={(subject, outcome) => finished(subject, outcome)} />
      )}
    </section>
  );
}

/** Runs one save at a time and keeps the retry key for an identical retry. */
function useHoldBackSave() {
  const command = useCommandKey();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const save = async (input: { scope: PromiseSafetyAdminScope; value: PromiseSafetyAdminValue; expectedHeadRevision: string | null; note: string }) => {
    if (inFlight.current) return null;
    inFlight.current = true; setBusy(true);
    try {
      const outcome = await saveHoldBack({ ...input, idempotencyKey: command.keyFor(holdBackFingerprint(input)) });
      // Only an unknown outcome keeps the key: a retry must replay it, anything else is a new command.
      if (outcome.status !== "unknown") command.clear();
      return outcome;
    } finally { inFlight.current = false; setBusy(false); }
  };
  return { busy, save };
}

function BusinessHoldBack({ setting, canChange, onDone }: {
  setting: { revision: string; value: PromiseSafetyAdminValue | null } | null;
  canChange: boolean;
  onDone(outcome: HoldBackOutcome): Promise<void>;
}) {
  const current = setting?.value ?? null;
  const described = describeHoldBack(current);
  const [text, setText] = useState(holdBackInput(current));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, save } = useHoldBackSave();
  const parsed = parseHoldBack(text, { blankUsesBusiness: false });
  const changed = parsed.ok ? !sameHoldBack(parsed.value, current) : text.trim() !== holdBackInput(current);

  const submit = async () => {
    if (!parsed.ok) { setError(parsed.message); return; }
    setError(null);
    const outcome = await save({ scope: { scopeType: "business" }, value: parsed.value, expectedHeadRevision: setting?.revision ?? null, note });
    if (outcome) await onDone(outcome);
  };

  return (
    <SectionCard title="Hold back from every channel" description="Taken off each SKU's stock before any channel stock rule runs. Saves take effect immediately.">
      <div className="space-y-3">
        {!described.simple && (
          <Callout>
            Right now this is set to hold back {described.text}. Saving a number here replaces that.
          </Callout>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="hold-back-business">Units to hold back</Label>
            <Input id="hold-back-business" inputMode="numeric" className="min-h-[44px] w-32" value={text} disabled={!canChange || busy}
              aria-invalid={error !== null} onChange={event => { setText(event.target.value); setError(null); }} />
          </div>
          <p className="pb-3 text-sm text-muted-foreground">units of each SKU, in each warehouse</p>
          {canChange && (
            <Button type="button" className="ml-auto min-h-[44px]" disabled={busy || !changed} onClick={() => void submit()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        {busy && <p className="text-xs text-muted-foreground">Recalculating every product and sending the new quantities. This can take a moment.</p>}
        {canChange && <NoteField id="hold-back-business-note" value={note} onChange={setNote} disabled={busy} />}
      </div>
    </SectionCard>
  );
}

function ExceptionRow({ row, canChange, onEdit }: { row: HoldBackException; canChange: boolean; onEdit(): void }) {
  const described = describeHoldBack(row.value);
  return (
    <TableRow data-testid={`hold-back-row-${row.scopeKey}`}>
      <TableCell>
        <span className="font-medium">{row.sku ?? row.variantName}</span>
        <span className="block text-xs text-muted-foreground">
          {row.productName} · {describePackUnit(row.unitsPerVariant)}{row.warehouseCode ? ` · only at ${row.warehouseCode}` : ""}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="font-semibold">{described.text}</span>
        {row.value === null && <span className="block text-[11px] text-muted-foreground">saved earlier, never took effect</span>}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{row.updatedAt ? formatAbsoluteTime(row.updatedAt) : ""}</TableCell>
      <TableCell className="text-right">
        {canChange && (described.simple
          ? <Button type="button" size="sm" variant="outline" className="min-h-[36px]" onClick={onEdit}>Edit</Button>
          : <Button asChild size="sm" variant="outline" className="min-h-[36px]"><Link href={`${ADVANCED_PATH}?productId=${row.productId}`}>Open</Link></Button>)}
      </TableCell>
    </TableRow>
  );
}

function ExceptionEditor({ view, editing, existing, onClose, onDone }: {
  view: View;
  editing: Editing;
  existing: readonly HoldBackException[];
  onClose(): void;
  onDone(subject: string, outcome: HoldBackOutcome): Promise<void>;
}) {
  const row = editing.kind === "edit" ? editing.row : null;
  const [productId, setProductId] = useState<number | null>(row?.productId ?? null);
  const [variantId, setVariantId] = useState<number | null>(row?.productVariantId ?? null);
  const [text, setText] = useState(row ? holdBackInput(row.value) : "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { busy, save } = useHoldBackSave();
  // Adding needs the picked product's SKUs; the shared view read supplies them.
  const product = useChannelInventoryView(row ? null : productId);
  const variants = useMemo(() => !row && product.data?.selectedProduct?.id === productId
    ? sellableVariants(product.data.selectedProduct.variants) : [], [row, product.data, productId]);
  const variant = variants.find(item => item.id === variantId) ?? null;
  // A SKU that already has (or once had) a setting must be saved against that setting's revision.
  const target = row ?? existing.find(item => item.productVariantId === variantId && item.warehouseId === null) ?? null;
  const subject = row ? (row.sku ?? row.variantName) : variant ? (variant.sku ?? variant.name) : "";
  const scope: PromiseSafetyAdminScope | null = row
    ? row.warehouseId === null
      ? { scopeType: "network_variant", productVariantId: row.productVariantId }
      : { scopeType: "warehouse_variant", warehouseId: row.warehouseId, productVariantId: row.productVariantId }
    : variantId === null ? null : { scopeType: "network_variant", productVariantId: variantId };

  const submit = async (value: PromiseSafetyAdminValue) => {
    if (!scope) { setError("Choose a product and a SKU first."); return; }
    setError(null);
    const outcome = await save({ scope, value, expectedHeadRevision: target?.revision ?? null, note });
    if (!outcome) return;
    await onDone(subject, outcome);
    onClose();
  };
  const submitNumber = () => {
    // Clearing is its own button, so a blank box here is a mistake, not "use the business number".
    const parsed = parseHoldBack(text, { blankUsesBusiness: false });
    if (!parsed.ok) { setError(parsed.message); return; }
    void submit(parsed.value);
  };
  const unchanged = row !== null && (() => { const parsed = parseHoldBack(text, { blankUsesBusiness: false }); return parsed.ok && sameHoldBack(parsed.value, row.value); })();

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{row ? `Hold back for ${subject}` : "Add a SKU exception"}</DialogTitle>
          <DialogDescription>
            {row?.warehouseCode ? `Applies only at ${row.warehouseCode}. ` : ""}This SKU uses its own number instead of the business one. It takes effect when you save.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!row && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="hold-back-product">Product</Label>
                <ProductPicker id="hold-back-product" products={view.products} value={productId} className="w-full"
                  onChange={id => { setProductId(id); setVariantId(null); setError(null); }} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hold-back-sku">SKU</Label>
                <Select value={variantId === null ? "" : String(variantId)} disabled={busy || productId === null || variants.length === 0}
                  onValueChange={value => { setVariantId(Number(value)); setError(null); }}>
                  <SelectTrigger id="hold-back-sku" className="min-h-[44px]">
                    <SelectValue placeholder={productId === null ? "Choose a product first" : product.isFetching ? "Loading SKUs…" : variants.length === 0 ? "No sellable SKUs" : "Choose a SKU"} />
                  </SelectTrigger>
                  <SelectContent>
                    {variants.map(item => <SelectItem key={item.id} value={String(item.id)}>{item.sku ?? item.name} · {describePackUnit(item.unitsPerVariant)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="hold-back-units">Units to hold back</Label>
            <Input id="hold-back-units" inputMode="numeric" className="min-h-[44px]" value={text} disabled={busy}
              aria-invalid={error !== null} onChange={event => { setText(event.target.value); setError(null); }} />
            {error
              ? <p role="alert" className="text-xs text-destructive">{error}</p>
              : <p className="text-xs text-muted-foreground">Units of this SKU, in each warehouse. 0 holds nothing back for it.</p>}
          </div>
          <NoteField id="hold-back-note" value={note} onChange={setNote} disabled={busy} />
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {row
            ? <Button type="button" variant="outline" className="min-h-[44px]" disabled={busy} onClick={() => void submit({ policyMode: "inherit" })}>Remove exception</Button>
            : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" className="min-h-[44px]" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="button" className="min-h-[44px]" disabled={busy || unchanged} onClick={submitNumber}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
