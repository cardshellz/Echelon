import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAuth } from "@/lib/auth";

import { describeError } from "../api";
import { describePackUnit } from "../format";
import { invalidateChannelInventory, useChannelInventoryView } from "../hooks";
import { sellableVariants, type PolicyFormError, type View } from "../model";
import {
  EMPTY_STOCK_RULE_INPUT, STOCK_RULE_FIELDS, describeStockRuleOutcome, listChannelStockRules, mergeStockRuleInput,
  needsStockRuleRewrite,
  sameStockRuleInput, saveAndApplyStockRule, stockRuleInputFor, stockRuleValue,
  type ChannelStockRuleRow, type StockRuleCell, type StockRuleInput, type StockRuleSaveOutcome, type StockRuleSubject,
} from "../product-stock-rules";
import { Callout, EvidenceNote, NoteField, PendingPill, StatePill } from "./primitives";

/** Which channels an open editor writes to. */
type EditorTarget = { kind: "channel"; channelId: number } | { kind: "all" };
interface SaveResult { channelName: string; outcome: StockRuleSaveOutcome }

/**
 * The product page's SKU view of channel stock rules: pick the whole product
 * or one SKU and see, per channel, the four numbers that decide what the
 * channel shows. Saving takes effect straight away. The same rows are edited
 * per channel in Channel Inventory → Stock rules.
 */
export function ProductStockRulesCard({ productId }: { productId: number }) {
  const { hasPermission } = useAuth();
  const canView = hasPermission("inventory_planning", "view");
  // Saving a rule here also applies it, so both permissions are needed.
  const canChange = hasPermission("inventory_planning", "edit") && hasPermission("inventory_planning", "activate");
  return (
    <Card data-testid="product-stock-rules">
      <CardHeader className="p-3 md:p-6">
        <CardTitle className="text-base md:text-lg">Stock rules by channel</CardTitle>
        <CardDescription className="text-xs md:text-sm">
          What each channel is allowed to show for this product. Set Max to 0 to show it as out of stock.
          Changes take effect when you save.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-3 pt-0 md:p-6 md:pt-0">
        {canView
          ? <StockRules productId={productId} canChange={canChange} />
          : <p className="text-sm text-muted-foreground">Seeing stock rules needs inventory planning view permission.</p>}
        <Button asChild variant="outline" size="sm">
          <Link href={`/channels/inventory?product=${productId}&tab=rules`}>Open channel defaults in Channel Inventory</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function StockRules({ productId, canChange }: { productId: number; canChange: boolean }) {
  const view = useChannelInventoryView(productId);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [target, setTarget] = useState<EditorTarget | null>(null);
  const [results, setResults] = useState<SaveResult[] | null>(null);
  const subject: StockRuleSubject = useMemo(() => ({ productId, productVariantId: variantId }), [productId, variantId]);
  const rows = useMemo(() => view.data ? listChannelStockRules(view.data, subject) : [], [view.data, subject]);

  if (view.isLoading) return <p className="text-sm text-muted-foreground">Loading stock rules…</p>;
  if (view.isError || !view.data) {
    return (
      <Callout tone="danger" title="Stock rules could not be loaded"
        action={<Button type="button" size="sm" variant="outline" onClick={() => void view.refetch()}>Try again</Button>}>
        {describeError(view.error).message}
      </Callout>
    );
  }
  if (view.data.runtimeAuthority !== "canonical") {
    return <p className="text-sm text-muted-foreground">Stock rules apply after inventory cutover.</p>;
  }
  const variants = view.data.selectedProduct?.id === productId ? sellableVariants(view.data.selectedProduct.variants) : [];
  const variant = variants.find(item => item.id === variantId) ?? null;
  const subjectName = variant ? (variant.sku ?? variant.name) : "the whole product";
  const managedRows = rows.filter(row => row.managed);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Rules for</Label>
        <ToggleGroup type="single" variant="outline" size="sm" className="flex-wrap justify-start"
          value={variantId === null ? "product" : String(variantId)}
          onValueChange={next => { if (next) { setVariantId(next === "product" ? null : Number(next)); setResults(null); } }}>
          <ToggleGroupItem value="product">Whole product</ToggleGroupItem>
          {variants.map(item => (
            <ToggleGroupItem key={item.id} value={String(item.id)} title={describePackUnit(item.unitsPerVariant)}>
              {item.sku ?? item.name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">
          {variant
            ? `A SKU rule wins over a whole-product rule, which wins over the channel default. Numbers count this SKU (${describePackUnit(variant.unitsPerVariant)}).`
            : "A whole-product rule applies to every SKU that has no rule of its own."}
        </p>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Channel</TableHead>
              {STOCK_RULE_FIELDS.map(field => <TableHead key={field.key} className="text-right" title={field.help}>{field.label}</TableHead>)}
              <TableHead>Status</TableHead>
              <TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={STOCK_RULE_FIELDS.length + 3} className="text-sm text-muted-foreground">No active channels.</TableCell></TableRow>
            )}
            {rows.map(row => (
              <TableRow key={row.channel.id} data-testid={`stock-rule-row-${row.channel.id}`}>
                <TableCell className="font-medium">{row.channel.name}</TableCell>
                {row.managed
                  ? STOCK_RULE_FIELDS.map(field => <RuleCell key={field.key} cell={row.cells[field.key]} />)
                  : <TableCell colSpan={STOCK_RULE_FIELDS.length} className="text-sm text-muted-foreground">
                      No channel default yet, so nothing is sent here. Set it up in Channel Inventory.
                    </TableCell>}
                <TableCell><RowStatus row={row} /></TableCell>
                <TableCell className="text-right">
                  {row.managed && canChange && (
                    <Button type="button" size="sm" variant="outline" className="min-h-[36px]"
                      onClick={() => { setResults(null); setTarget({ kind: "channel", channelId: row.channel.id }); }}>
                      {row.hasException ? "Edit" : "Add exception"}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {canChange && managedRows.length > 1 && (
        <Button type="button" size="sm" onClick={() => { setResults(null); setTarget({ kind: "all" }); }}>
          Set on all channels
        </Button>
      )}
      {!canChange && <p className="text-xs text-muted-foreground">Changing stock rules needs inventory planning edit and activate permission.</p>}

      {results && (
        <div role="status" className="space-y-1 rounded-md border p-3 text-sm" data-testid="stock-rule-results">
          {results.map(result => (
            <p key={result.channelName} className={result.outcome.status === "applied" || result.outcome.status === "unchanged" ? "" : "text-destructive"}>
              <span className="font-medium">{result.channelName}:</span> {describeStockRuleOutcome(result.outcome, variantId)}
            </p>
          ))}
        </div>
      )}

      <EvidenceNote>
        Stock is one shared pool across this product's SKUs and follows the package hierarchy. These rules only limit what each channel shows.
      </EvidenceNote>

      {target && (
        <StockRuleEditor
          key={`${target.kind === "all" ? "all" : target.channelId}:${variantId ?? "product"}`}
          view={view.data}
          rows={target.kind === "all" ? managedRows : managedRows.filter(row => row.channel.id === target.channelId)}
          allChannels={target.kind === "all"}
          subjectName={subjectName}
          onClose={() => setTarget(null)}
          onDone={setResults}
        />
      )}
    </div>
  );
}

function RuleCell({ cell }: { cell: StockRuleCell }) {
  const own = cell.source === "sku" || cell.source === "product";
  return (
    <TableCell className="text-right tabular-nums">
      <span className={own ? "font-semibold" : "text-muted-foreground"}>{cell.display}</span>
      <span className="block text-[11px] text-muted-foreground">
        {cell.source === "sku" ? "SKU rule" : cell.source === "product" ? "product rule" : cell.source === "channel" ? "default" : ""}
      </span>
    </TableCell>
  );
}

function RowStatus({ row }: { row: ChannelStockRuleRow }) {
  if (!row.managed) return <StatePill tone="off">Not managed</StatePill>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {row.outOfStock ? <StatePill tone="held">Out of stock</StatePill>
        : row.hasException ? <StatePill tone="neutral">Exception</StatePill>
        : <span className="text-xs text-muted-foreground">Channel default</span>}
      {row.pending && <PendingPill>Saved, not applied</PendingPill>}
    </div>
  );
}

function StockRuleEditor({ view, rows, allChannels, subjectName, onClose, onDone }: {
  view: View;
  rows: ChannelStockRuleRow[];
  allChannels: boolean;
  subjectName: string;
  onClose(): void;
  onDone(results: SaveResult[]): void;
}) {
  const queryClient = useQueryClient();
  const single = allChannels ? null : rows[0] ?? null;
  // One channel: start from what is saved there, blank = use the default.
  // All channels: start blank, blank = leave each channel's value as it is.
  const initial = useMemo(() => single ? stockRuleInputFor(single.head) : EMPTY_STOCK_RULE_INPUT, [single]);
  const [input, setInput] = useState<StockRuleInput>(initial);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<PolicyFormError[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const patch = (change: Partial<StockRuleInput>) => setInput(current => ({ ...current, ...change }));
  const nothingTyped = sameStockRuleInput(input, EMPTY_STOCK_RULE_INPUT);
  const hasUnapplied = rows.some(row => row.pending);
  const canSave = !busy && rows.length > 0
    && (allChannels ? !nothingTyped : (!sameStockRuleInput(input, initial) || hasUnapplied));

  const run = async (inputFor: (row: ChannelStockRuleRow) => StockRuleInput) => {
    if (inFlight.current) return;
    // Validate every channel before writing to any, so a typo changes nothing.
    const planned: Array<{ row: ChannelStockRuleRow; value: Parameters<typeof saveAndApplyStockRule>[0]["value"]; changed: boolean }> = [];
    for (const row of rows) {
      const next = inputFor(row);
      const parsed = stockRuleValue(next, row.head);
      if (!parsed.ok) { setErrors(parsed.errors); return; }
      planned.push({ row, value: parsed.value, changed: !sameStockRuleInput(next, stockRuleInputFor(row.head)) || needsStockRuleRewrite(row.head) });
    }
    setErrors([]);
    inFlight.current = true; setBusy(true);
    const results: SaveResult[] = [];
    try {
      // One channel at a time: each apply replans this product on every
      // destination, and running them together would only make them contend.
      for (const item of planned) {
        results.push({ channelName: item.row.channel.name, outcome: await saveAndApplyStockRule({ ...item, note }) });
      }
    } finally {
      inFlight.current = false; setBusy(false);
      // Refresh even after a failure: an unknown outcome is resolved by what the server now holds.
      await invalidateChannelInventory(queryClient).catch(() => undefined);
      onDone(results);
      onClose();
    }
  };

  const fieldError = (key: PolicyFormError["field"]) => errors.find(error => error.field === key)?.message ?? null;
  const blankHint = allChannels ? "Leave as is" : "Use default";
  const channelNames = rows.map(row => row.channel.name).join(", ");
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{allChannels ? "Set on all channels" : `Stock rule on ${single?.channel.name ?? ""}`}</DialogTitle>
          <DialogDescription>
            For {subjectName}. {allChannels
              ? `Writes the fields you fill in to ${channelNames}. Blank fields keep each channel's current value.`
              : "A blank field uses the default for this channel."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberField id="stock-rule-share" label="Stock %" help="Share of available stock" placeholder={blankHint}
            value={input.sharePercent} onChange={sharePercent => patch({ sharePercent })} error={fieldError("shareBps")} disabled={busy} />
          <NumberField id="stock-rule-buffer" label="Buffer" help="Subtracted after the %" placeholder={blankHint}
            value={input.bufferUnits} onChange={bufferUnits => patch({ bufferUnits })} error={fieldError("holdbackSellableUnits")} disabled={busy} />
          <div className="space-y-1.5">
            <Label htmlFor="stock-rule-max-mode">Max</Label>
            <Select value={input.maxMode} onValueChange={maxMode => patch({ maxMode: maxMode as StockRuleInput["maxMode"] })} disabled={busy}>
              <SelectTrigger id="stock-rule-max-mode" className="min-h-[44px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">{blankHint}</SelectItem>
                <SelectItem value="units">Set a number</SelectItem>
                <SelectItem value="unlimited">No max</SelectItem>
              </SelectContent>
            </Select>
            {input.maxMode === "units" && (
              <Input aria-label="Max units" inputMode="numeric" className="min-h-[44px]" value={input.maxUnits} disabled={busy}
                onChange={event => patch({ maxUnits: event.target.value })} placeholder="0 = out of stock" />
            )}
            {fieldError("maxPublish")
              ? <p role="alert" className="text-xs text-destructive">{fieldError("maxPublish")}</p>
              : <p className="text-xs text-muted-foreground">0 = out of stock</p>}
          </div>
          <NumberField id="stock-rule-hide-below" label="Hide when below" help="Shows 0 when fewer than this are available"
            placeholder={blankHint} value={input.hideBelowUnits} onChange={hideBelowUnits => patch({ hideBelowUnits })}
            error={fieldError("minPublishSellableUnits")} disabled={busy} />
        </div>
        {fieldError("form") && <Callout tone="warning">{fieldError("form")}</Callout>}
        {hasUnapplied && !allChannels && <Callout tone="warning">A saved change on this rule was never applied. Saving applies it.</Callout>}
        <NoteField id="stock-rule-note" value={note} onChange={setNote} disabled={busy} />
        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" className="min-h-[44px]" disabled={busy || rows.every(row => !row.hasException)}
            onClick={() => void run(() => EMPTY_STOCK_RULE_INPUT)}>
            {allChannels ? "Clear on all channels" : "Clear exception"}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" className="min-h-[44px]" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="button" className="min-h-[44px]" disabled={!canSave}
              onClick={() => void run(row => allChannels ? mergeStockRuleInput(stockRuleInputFor(row.head), input) : input)}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({ id, label, help, placeholder, value, onChange, error, disabled }: {
  id: string; label: string; help: string; placeholder: string; value: string;
  onChange(value: string): void; error: string | null; disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="decimal" className="min-h-[44px]" value={value} placeholder={placeholder} disabled={disabled}
        aria-invalid={error !== null} onChange={event => onChange(event.target.value)} />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}
