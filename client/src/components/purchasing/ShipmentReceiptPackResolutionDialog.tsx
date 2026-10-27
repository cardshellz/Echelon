import { useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Plus, RefreshCw } from "lucide-react";
import { ShipmentCustodyReceiptLinks } from "./ShipmentCustodyReceiptLinks";
import { readReceiptUnitDraft, saveReceiptUnitDraft, shipmentReceiveCoverageLabel } from "@/lib/shipment-receipt-units";
import { ReceivingConfigurationForm } from "@/features/catalog/ReceivingConfigurationForm";
import { useAuth } from "@/lib/auth";
import type { ShipmentReceiptUnitSelection } from "@shared/procurement/shipment-receipt-plan";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { ShipmentReceiptPackResolution, ShipmentReceiptPackResolutionLine } from "@/lib/shipment-receipt-units";
export type { ShipmentReceiptPackResolution, ShipmentReceiptPackResolutionLine } from "@/lib/shipment-receipt-units";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resolution: ShipmentReceiptPackResolution | null;
  creating?: boolean;
  refreshing?: boolean;
  onCreateReceipt: (selections: ShipmentReceiptUnitSelection[]) => void;
  onRefresh: (selections?: ShipmentReceiptUnitSelection[]) => Promise<void>;
  onOpenCatalog: (line?: ShipmentReceiptPackResolutionLine) => void;
};

export function ShipmentReceiptPackResolutionDialog(props: Props) {
  return props.resolution ? <ReceiptSetupDialog key={`${props.resolution.shipmentId}:${props.resolution.purchaseOrderId}:${props.resolution.lines.map(line => line.shipmentLineId).join(",")}`} {...props} resolution={props.resolution} /> : null;
}

const selectionVersion = (values: readonly ShipmentReceiptUnitSelection[]) => JSON.stringify([...values].sort((a, b) => a.shipmentLineId - b.shipmentLineId));

function ReceiptSetupDialog({
  open,
  onOpenChange,
  resolution,
  creating = false,
  refreshing = false,
  onCreateReceipt,
  onRefresh,
  onOpenCatalog,
}: Props & { resolution: ShipmentReceiptPackResolution }) {
  const { hasPermission } = useAuth();
  const [selections, setSelections] = useState<ShipmentReceiptUnitSelection[]>(() => {
    const saved = readReceiptUnitDraft(resolution);
    return saved.length ? saved : resolution.receiptUnitSelections ?? [];
  });
  const [addingFor, setAddingFor] = useState<ShipmentReceiptPackResolutionLine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const dirty = selectionVersion(selections) !== selectionVersion(resolution.receiptUnitSelections ?? []);
  const busy = creating || refreshing || reviewing;
  function choose(line: ShipmentReceiptPackResolutionLine, variantId: number | null, units?: number) {
    const next = selections.filter(selection => selection.shipmentLineId !== line.shipmentLineId);
    if (variantId && units && line.shipmentLineId && line.qtyShipped) next.push({ shipmentLineId: line.shipmentLineId,
      productVariantId: variantId, unitsPerVariant: units, expectedBaseQty: line.qtyShipped });
    setSelections(next);
    try { saveReceiptUnitDraft(resolution, next); setError(null); }
    catch { setError("These choices could not be kept for a return visit. Keep this dialog open until the receipt is created."); }
    return next;
  }
  async function review(next = selections) {
    setReviewing(true);
    try { await onRefresh(next); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The configurations could not be checked."); throw failure; }
    finally { setReviewing(false); }
  }
  function configuration(line: ShipmentReceiptPackResolutionLine) {
    const choice = selections.find(value => value.shipmentLineId === line.shipmentLineId);
    const selectedId = choice?.productVariantId ?? line.receivePlan?.productVariantId;
    const selected = line.activeVariants.find(value => value.id === selectedId) ?? (line.matchedVariant?.id === selectedId ? line.matchedVariant : null);
    const count = selected && line.qtyShipped && line.qtyShipped % selected.unitsPerVariant === 0 ? line.qtyShipped / selected.unitsPerVariant : null;
    return <div className="space-y-2 min-w-0 md:min-w-56">
      <label className="block text-sm">Receive {line.sku ?? line.productName ?? "this item"} as
        <select className="mt-1 min-h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-2" value={selectedId ?? ""} disabled={busy || !!addingFor}
          onChange={event => { const variant = line.activeVariants.find(value => value.id === Number(event.target.value)); choose(line, variant?.id ?? null, variant?.unitsPerVariant); }}>
          <option value="">Choose the configuration that arrived</option>
          {line.activeVariants.map(variant => <option key={variant.id} value={variant.id} disabled={line.qtyShipped === null || line.qtyShipped % variant.unitsPerVariant !== 0}>
            {variant.sku ? `${variant.sku} · ` : ""}{variant.name ?? "Receiving configuration"} · {variant.unitsPerVariant.toLocaleString("en-US")} pieces{line.qtyShipped !== null && line.qtyShipped % variant.unitsPerVariant !== 0 ? " · not a whole count" : ""}
          </option>)}
        </select>
      </label>
      {count !== null && selected && <p className="text-sm font-medium">{count.toLocaleString("en-US")} × {selected.unitsPerVariant.toLocaleString("en-US")} pieces = {line.qtyShipped!.toLocaleString("en-US")} pieces</p>}
      {selected?.sku && <p className="text-xs text-muted-foreground">Inventory SKU: <span className="font-mono">{selected.sku}</span></p>}
      {choice && selected && count !== null && (choice.unitsPerVariant !== selected.unitsPerVariant || choice.expectedBaseQty !== line.qtyShipped) &&
        <Button type="button" size="sm" variant="outline" disabled={busy || !!addingFor} onClick={() => choose(line, selected.id, selected.unitsPerVariant)}>Use these updated counts</Button>}
      {choice && dirty && <p className="text-xs text-muted-foreground">Before: {line.receivePlan ? `${line.receivePlan.expectedQty.toLocaleString("en-US")} × ${line.receivePlan.unitsPerVariant.toLocaleString("en-US")} pieces` : "No receiving configuration"}. Review the selected count before creating the receipt.</p>}
      {!dirty && line.issue && line.status !== "selection_required" && <p className="text-xs text-muted-foreground">{line.issue}</p>}
      {!line.activeVariants.length && <p className="text-sm text-destructive">No active product configurations yet.</p>}
      {line.productId && hasPermission("inventory", "create") && <Button type="button" size="sm" variant="outline" disabled={busy || !!addingFor} onClick={() => setAddingFor(line)}><Plus className="mr-1 h-4 w-4" />Add receiving configuration</Button>}
      {!hasPermission("inventory", "create") && <p className="text-xs text-muted-foreground">A catalog editor can add a missing configuration.</p>}
    </div>;
  }
  const unresolvedCount = resolution?.unresolvedCount ?? 0;
  const canCreate = Boolean(resolution?.canCreateReceipt) && !dirty;
  const blockingLines = (resolution?.lines ?? []).filter((line) => line.blocking);
  const primaryBlockingLine = blockingLines[0];

  return (
    <Dialog open={open} onOpenChange={value => { if (!busy && !addingFor) onOpenChange(value); }}>
      <DialogContent className="min-w-0 max-w-5xl max-h-[90vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {canCreate ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            )}
            Receive shipment items
          </DialogTitle>
          <DialogDescription>
            {resolution?.shipmentNumber ?? `Shipment #${resolution?.shipmentId ?? ""}`}
            {resolution?.poNumber ? ` for ${resolution.poNumber}` : ""}. Choose the product configurations that actually arrived. Shipping cartons are a separate packing reference.
          </DialogDescription>
        </DialogHeader>

        {resolution?.issue && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {resolution.issue}
          </div>
        )}
        {resolution && ((resolution.custodyBaseQty ?? 0) > 0 || (resolution.excessBaseQty ?? 0) > 0) && (
          <div className="rounded-md border p-3 text-sm">
            <p>{shipmentReceiveCoverageLabel(resolution).text}</p>
            <ShipmentCustodyReceiptLinks coverage={resolution} />
          </div>
        )}

        {dirty && <p className="rounded-md border p-3 text-sm">Review the receiving counts below before creating the receipt.</p>}
        {!canCreate && !dirty && unresolvedCount > 0 && (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-medium">
              Choose or add a receiving configuration for {unresolvedCount} item{unresolvedCount === 1 ? "" : "s"}.
            </div>
            <div>
              Use the product's existing cases, boxes or packs, or add a missing configuration below. The selected count must preserve all remaining pieces.
            </div>
          </div>
        )}

        <div className="space-y-3 md:hidden">
          {(resolution?.lines ?? []).map((line, index) => <div key={line.shipmentLineId ?? index} className="min-w-0 rounded-md border p-3 text-sm space-y-2">
            <div className="font-mono break-all">{line.sku ?? "Unlinked SKU"}</div>
            <div className="break-words">{line.productName ?? "Product needs review"}</div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
              <dt className="text-muted-foreground">Remaining pieces</dt><dd className="text-right">{line.qtyShipped?.toLocaleString("en-US") ?? "Unknown"}</dd>
              <dt className="text-muted-foreground">Cartons (reference)</dt><dd className="text-right">{line.cartonCount ?? "Not recorded"}</dd>
            </dl>
            {configuration(line)}
          </div>)}
        </div>
        <div className="hidden min-w-0 max-w-full overflow-x-auto rounded-md border md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Remaining pieces to receive</TableHead>
                <TableHead className="text-right">Cartons (reference)</TableHead>
                <TableHead>Receiving configuration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(resolution?.lines ?? []).map((line) => (
                <TableRow key={line.shipmentLineId ?? `${line.purchaseOrderLineId}-${line.sku}`}>
                  <TableCell className="font-mono text-xs">{line.sku ?? "-"}</TableCell>
                  <TableCell>
                    <div className="font-medium">{line.productName ?? "-"}</div>
                  </TableCell>
                  <TableCell className="text-right">{line.qtyShipped?.toLocaleString("en-US") ?? "-"}</TableCell>
                  <TableCell className="text-right">{line.cartonCount ?? "-"}</TableCell>
                  <TableCell>
                    {configuration(line)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {addingFor?.productId && <ReceivingConfigurationForm key={addingFor.shipmentLineId} productId={addingFor.productId}
          productName={addingFor.productName ?? addingFor.sku ?? "Product"} onCancel={() => setAddingFor(null)}
          onCreated={async variant => { const next = choose(addingFor, variant.id, variant.unitsPerVariant); await review(next); setAddingFor(null); }} />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">The selected configurations set this receipt's expected counts. Stock and costs are posted when receiving is completed.</p>
        <DialogFooter className="gap-2 sm:space-x-0 flex-wrap">
          {(resolution?.lines.length ?? 0) > 0 && <Button variant="outline" disabled={busy || !!addingFor} onClick={() => onOpenCatalog(primaryBlockingLine)}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Manage product configurations
          </Button>}
          <Button variant="outline" onClick={() => { void review().catch(() => undefined); }} disabled={busy || !!addingFor}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            {dirty ? "Review receiving counts" : "Refresh configurations"}
          </Button>
          <Button onClick={() => onCreateReceipt(resolution.receiptUnitSelections ?? [])} disabled={!canCreate || busy || !!addingFor}>
            {creating ? "Creating..." : "Create receipt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
