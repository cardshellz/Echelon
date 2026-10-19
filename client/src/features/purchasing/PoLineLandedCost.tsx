import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import {
  formatLandedCostPerPiece,
  type PoLandedCostLine,
} from "@shared/procurement/po-line-landed-cost";

export function PoLineLandedCost({
  line,
  currency,
  kind,
  supplierCents,
}: {
  line: PoLandedCostLine | undefined;
  currency: string;
  kind: "unit" | "total";
  supplierCents?: number;
}) {
  if (kind === "unit")
    return (
      <div className="text-xs font-sans mt-1">
        Landed:{" "}
        <strong className="font-mono">
          {line
            ? (formatLandedCostPerPiece(
                line.totalCents,
                line.pieces,
                currency,
              ) ?? "—")
            : "—"}
        </strong>
      </div>
    );
  return (
    <div data-testid="po-line-landed-total">
      <div className="font-mono font-semibold">
        {line ? formatIntegerCents(line.totalCents, currency) : "—"}
      </div>
      {line && (
        <div className="text-[11px] font-sans text-muted-foreground">
          Supplier {formatIntegerCents(line.supplierCents, currency)}
          <br />
          Shipment {formatIntegerCents(line.shipmentCents, currency)}
        </div>
      )}
      {!line && supplierCents !== undefined && (
        <div className="text-[11px] font-sans text-muted-foreground">
          Supplier {formatIntegerCents(supplierCents, currency)}
        </div>
      )}
    </div>
  );
}
