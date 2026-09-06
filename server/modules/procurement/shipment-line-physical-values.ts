import { Decimal } from "decimal.js";
import { SHIPMENT_LINE_INTEGER_MAX, shipmentLineEditableSchema } from "@shared/procurement/shipment-line-command";
import { ShipmentTrackingError } from "./shipment-tracking.service";

type PhysicalLine = {
  qtyShipped: number; cartonCount?: number | null;
  weightKg?: string | null; lengthCm?: string | null; widthCm?: string | null; heightCm?: string | null;
};

function numericColumn(value: Decimal, precision: number, scale: number): string {
  const rounded = value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  if (!rounded.isFinite() || rounded.isNegative() || rounded.gte(new Decimal(10).pow(precision - scale))) {
    throw new ShipmentTrackingError("Physical shipment totals exceed the supported column range. Review pieces, cartons, and dimensions.", 422, { code: "SHIPMENT_LINE_TOTAL_OVERFLOW" });
  }
  return rounded.toFixed(scale);
}

function validatePhysicalLine(line: PhysicalLine) {
  const fields = {
    qtyShipped: line.qtyShipped, cartonCount: line.cartonCount,
    weightKg: line.weightKg, lengthCm: line.lengthCm, widthCm: line.widthCm, heightCm: line.heightCm,
  };
  const parsed = shipmentLineEditableSchema.safeParse(fields);
  if (!parsed.success) throw new ShipmentTrackingError(
    "Shipment physical values require correction: " + parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    422, { code: "SHIPMENT_LINE_INPUT_INVALID" },
  );
}

export function computeShipmentLinePhysicalTotals(line: PhysicalLine) {
  validatePhysicalLine(line);
  // Cartons describe physical packaging independently of the base-piece count.
  const multiplier = line.cartonCount ?? line.qtyShipped;
  const weight = new Decimal(line.weightKg ?? "0");
  const cubicCm = new Decimal(line.lengthCm ?? "0").mul(line.widthCm ?? "0").mul(line.heightCm ?? "0");
  return {
    totalWeightKg: numericColumn(weight.mul(multiplier), 12, 3),
    totalVolumeCbm: numericColumn(cubicCm.mul(multiplier).div(1_000_000), 12, 6),
    chargeableWeightKg: numericColumn(Decimal.max(weight, cubicCm.div(5_000)).mul(multiplier), 12, 3),
  };
}

export function validateShipmentPhysicalTotals(lines: Array<{
  id?: number; qtyShipped: number; cartonCount: number | null; totalWeightKg: string | null; totalVolumeCbm: string | null; chargeableWeightKg?: string | null;
} & PhysicalLine>) {
  let pieces = 0;
  let cartons = 0;
  let weight = new Decimal(0);
  let volume = new Decimal(0);
  for (const line of lines) {
    const expected = computeShipmentLinePhysicalTotals(line);
    for (const field of ["totalWeightKg", "totalVolumeCbm", "chargeableWeightKg"] as const) {
      const stored = new Decimal(line[field] ?? "0");
      numericColumn(stored, 12, field === "totalVolumeCbm" ? 6 : 3);
      if (!stored.eq(expected[field])) throw new ShipmentTrackingError(
        `Shipment line ${line.id ?? ""} has physical totals that disagree with its pieces, cartons, or dimensions. Resolve dimensions or correct that line before changing allocation.`,
        409, { code: "SHIPMENT_LINE_TOTALS_REVIEW_REQUIRED", lineId: line.id ?? null, field },
      );
    }
    pieces += line.qtyShipped;
    cartons += line.cartonCount ?? 0;
    weight = weight.plus(line.totalWeightKg ?? "0");
    volume = volume.plus(line.totalVolumeCbm ?? "0");
  }
  if (![pieces, cartons].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= SHIPMENT_LINE_INTEGER_MAX)) {
    throw new ShipmentTrackingError("Shipment piece or carton totals exceed the supported integer range.", 422, { code: "SHIPMENT_LINE_TOTAL_OVERFLOW" });
  }
  numericColumn(weight, 12, 3);
  numericColumn(volume, 12, 6);
}
