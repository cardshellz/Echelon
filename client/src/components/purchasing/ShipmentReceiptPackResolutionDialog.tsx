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

export type ShipmentReceiptPackResolutionLine = {
  shipmentLineId: number | null;
  purchaseOrderLineId: number | null;
  sku: string | null;
  productId: number | null;
  productName: string | null;
  qtyShipped: number | null;
  cartonCount: number | null;
  unitsPerCarton: number | null;
  status: string;
  blocking: boolean;
  issue: string | null;
  matchedVariant: {
    id: number;
    sku: string | null;
    name: string | null;
    unitsPerVariant: number;
  } | null;
  activeVariants: Array<{
    id: number;
    sku: string | null;
    name: string | null;
    unitsPerVariant: number;
  }>;
};

export type ShipmentReceiptPackResolution = {
  shipmentId: number;
  shipmentNumber: string | null;
  status: string | null;
  purchaseOrderId: number;
  poNumber: string | null;
  canCreateReceipt: boolean;
  unresolvedCount: number;
  lineCount: number;
  issue: string | null;
  lines: ShipmentReceiptPackResolutionLine[];
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resolution: ShipmentReceiptPackResolution | null;
  creating?: boolean;
  refreshing?: boolean;
  onCreateReceipt: () => void;
  onRefresh: () => void;
  onOpenCatalog: () => void;
};

function statusLabel(line: ShipmentReceiptPackResolutionLine): string {
  if (line.status === "missing_variant") return "Missing variant";
  if (line.status === "missing_product") return "Missing product";
  if (line.status === "fractional_carton") return "Invalid cartons";
  if (line.status === "no_carton_count") return "Fallback config";
  if (line.status === "invalid_po_line") return "Invalid PO line";
  return "Resolved";
}

function formatVariantList(line: ShipmentReceiptPackResolutionLine): string {
  if (line.activeVariants.length === 0) return "No active variants";
  return line.activeVariants
    .map((variant) => `${variant.sku ?? `Variant ${variant.id}`} (${variant.unitsPerVariant})`)
    .join(", ");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
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
            {resolution?.poNumber ? ` for ${resolution.poNumber}` : ""}. Shipment cartons must map to an active receive variant before inventory can be posted.
          </DialogDescription>
        </DialogHeader>

        {resolution?.issue && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {resolution.issue}
          </div>
        )}

        {!canCreate && unresolvedCount > 0 && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {unresolvedCount} line{unresolvedCount === 1 ? "" : "s"} need catalog receive-pack configuration before this receipt can be created.
          </div>
        )}

        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Shipped</TableHead>
                <TableHead className="text-right">Cartons</TableHead>
                <TableHead className="text-right">Units/Carton</TableHead>
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
                  <TableCell className="text-right">{line.unitsPerCarton ?? "-"}</TableCell>
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
                          {line.matchedVariant.name ?? "Active variant"} ({line.matchedVariant.unitsPerVariant})
                        </div>
                      </div>
                    ) : (
                      <div className="max-w-sm text-xs text-muted-foreground">{formatVariantList(line)}</div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <DialogFooter className="gap-2 sm:space-x-0">
          <Button variant="outline" onClick={onOpenCatalog}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Open variants
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
