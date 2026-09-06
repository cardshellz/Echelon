import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  onCreateReceipt: () => void;
  onRefresh: () => void;
  onOpenCatalog: (line?: ShipmentReceiptPackResolutionLine) => void;
};

function statusLabel(line: ShipmentReceiptPackResolutionLine): string {
  if (line.status === "missing_variant") return "Missing variant";
  if (line.status === "missing_product") return "Missing product";
  if (line.status === "fractional_carton") return "Invalid cartons";
  if (line.status === "no_carton_count") return "Fallback config";
  if (line.status === "invalid_po_line") return "Invalid PO line";
  if (line.status === "invalid_quantity") return "Invalid piece quantity";
  if (line.status === "missing_piece_variant") return "Piece variant required";
  if (line.status === "unit_mismatch") return "Unit source changed";
  return line.status === "resolved" ? "Resolved" : "Needs review";
}

function formatVariantList(line: ShipmentReceiptPackResolutionLine): string {
  if (line.activeVariants.length === 0) return "No active variants";
  return line.activeVariants
    .map((variant) => `${variant.sku ?? `Variant ${variant.id}`} (${variant.unitsPerVariant})`)
    .join(", ");
}

function requiredSetupText(line: ShipmentReceiptPackResolutionLine): string {
  if (!line.productId) return "Link this shipment line to a product before creating the receipt.";
  if (line.status === "missing_piece_variant") return "Create or activate a one-piece variant for this product. The shipped quantity cannot be represented as whole preferred packs.";
  return line.issue ?? "Review the source line and its active receive variant, then refresh this check.";
}

export function ShipmentReceiptPackResolutionDialog({
  open,
  onOpenChange,
  resolution,
  creating = false,
  refreshing = false,
  onCreateReceipt,
  onRefresh,
  onOpenCatalog,
}: Props) {
  const unresolvedCount = resolution?.unresolvedCount ?? 0;
  const canCreate = Boolean(resolution?.canCreateReceipt);
  const blockingLines = (resolution?.lines ?? []).filter((line) => line.blocking);
  const primaryBlockingLine = blockingLines[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="min-w-0 max-w-5xl max-h-[90vh] overflow-y-auto overflow-x-hidden [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {canCreate ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            )}
            Shipment receipt pack check
          </DialogTitle>
          <DialogDescription>
            {resolution?.shipmentNumber ?? `Shipment #${resolution?.shipmentId ?? ""}`}
            {resolution?.poNumber ? ` for ${resolution.poNumber}` : ""}. Shipped pieces determine the receipt count. Cartons are a packing reference and do not define the receive unit.
          </DialogDescription>
        </DialogHeader>

        {resolution?.issue && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {resolution.issue}
          </div>
        )}

        {!canCreate && unresolvedCount > 0 && (
          <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <div className="font-medium">
              {unresolvedCount} line{unresolvedCount === 1 ? "" : "s"} need receive-pack setup before this receipt can be created.
            </div>
            <div>
              Fix the blocking line below, then return here and refresh. An active receive variant must represent the shipped pieces exactly.
            </div>
            {primaryBlockingLine && (
              <div className="rounded border border-red-200 bg-white/70 p-2 text-red-900">
                <div className="font-medium">{primaryBlockingLine.sku ?? primaryBlockingLine.productName ?? "Blocking line"}</div>
                <div>{requiredSetupText(primaryBlockingLine)}</div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-3 md:hidden">
          {(resolution?.lines ?? []).map((line, index) => <div key={line.shipmentLineId ?? index} className="min-w-0 rounded-md border p-3 text-sm space-y-2">
            <div className="font-mono break-all">{line.sku ?? "Unlinked SKU"}</div>
            <div className="break-words">{line.productName ?? "Product needs review"}</div>
            <Badge variant={line.blocking ? "destructive" : "secondary"}>{statusLabel(line)}</Badge>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
              <dt className="text-muted-foreground">Remaining pieces</dt><dd className="text-right">{line.qtyShipped ?? "Unknown"}</dd>
              <dt className="text-muted-foreground">Cartons (reference)</dt><dd className="text-right">{line.cartonCount ?? "Not recorded"}</dd>
              <dt className="text-muted-foreground">Planned receive count</dt><dd className="text-right font-semibold">{line.receivePlan ? line.receivePlan.expectedQty.toLocaleString() + (line.receivePlan.countsAsPieces ? " pieces" : " receive units") : "Needs review"}</dd>
              {line.receivePlan && <><dt className="text-muted-foreground">Pieces per receive unit</dt><dd className="text-right">{line.receivePlan.unitsPerVariant}</dd></>}
            </dl>
            {line.matchedVariant && <div className="break-words text-xs text-muted-foreground">{line.matchedVariant.name ?? "Receive variant"} — {line.matchedVariant.sku ?? "SKU not recorded"}</div>}
            {line.issue && <p className="break-words text-xs text-muted-foreground">{line.issue}</p>}
            {line.blocking && <Button variant="outline" size="sm" className="min-h-10" onClick={() => onOpenCatalog(line)}>Fix variant</Button>}
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
                <TableHead className="text-right">Planned receive count</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Receive Variant</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(resolution?.lines ?? []).map((line) => (
                <TableRow key={line.shipmentLineId ?? `${line.purchaseOrderLineId}-${line.sku}`}>
                  <TableCell className="font-mono text-xs">{line.sku ?? "-"}</TableCell>
                  <TableCell>
                    <div className="font-medium">{line.productName ?? "-"}</div>
                    <div className="text-xs text-muted-foreground">
                      {line.productId ? `Product ${line.productId}` : "No product id"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{line.qtyShipped ?? "-"}</TableCell>
                  <TableCell className="text-right">{line.cartonCount ?? "-"}</TableCell>
                  <TableCell className="text-right">{line.receivePlan ? <div><b>{line.receivePlan.expectedQty.toLocaleString()}</b> {line.receivePlan.countsAsPieces ? "pieces" : "receive units"}<div className="text-xs text-muted-foreground">{line.receivePlan.unitsPerVariant} pieces per receive unit</div></div> : "Needs review"}</TableCell>
                  <TableCell>
                    <Badge variant={line.blocking ? "destructive" : "secondary"}>
                      {statusLabel(line)}
                    </Badge>
                    {line.issue && <div className="mt-1 max-w-md text-xs text-muted-foreground">{line.issue}</div>}
                  </TableCell>
                  <TableCell>
                    {line.matchedVariant ? (
                      <div>
                        <div className="font-mono text-xs">{line.matchedVariant.sku ?? `Variant ${line.matchedVariant.id}`}</div>
                        <div className="text-xs text-muted-foreground">
                          {line.matchedVariant.name ?? "Active variant"} ({line.matchedVariant.unitsPerVariant} pieces)
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="max-w-sm text-xs text-muted-foreground">{formatVariantList(line)}</div>
                        {line.blocking && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => onOpenCatalog(line)}
                            className="h-8"
                          >
                            <ExternalLink className="mr-2 h-3.5 w-3.5" />
                            Fix variant
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="gap-2 sm:space-x-0">
          <Button variant="outline" onClick={() => onOpenCatalog(primaryBlockingLine)}>
            <ExternalLink className="mr-2 h-4 w-4" />
            {primaryBlockingLine?.productId ? "Open product variants" : "Open variants"}
          </Button>
          <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button onClick={onCreateReceipt} disabled={!canCreate || creating}>
            {creating ? "Creating..." : "Create receipt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
