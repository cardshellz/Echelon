import { Decimal } from "decimal.js";
import { SHIPMENT_LINE_INTEGER_MAX, shipmentLineEditableSchema, shipmentLineResourceIdSchema } from "./shipment-line-command";

const PhysicalDecimal = Decimal.clone({ precision: 40 });
const CUBIC_CENTIMETRES_PER_CUBIC_METRE = 1_000_000;
// Preserve the existing chargeable-weight conversion used by inbound shipments.
const VOLUMETRIC_CUBIC_CENTIMETRES_PER_KILOGRAM = 5_000;
const physicalSourceSchema = shipmentLineEditableSchema.extend({ qtyShipped: shipmentLineResourceIdSchema });
export interface ShipmentPhysicalSource {
  qtyShipped: number;
  cartonCount?: number | null;
  dimensionBasis?: string | null;
  weightKg?: string | null;
  lengthCm?: string | null;
  widthCm?: string | null;
  heightCm?: string | null;
}
export interface ShipmentPhysicalTotals {
  totalWeightKg: string;
  totalVolumeCbm: string;
  chargeableWeightKg: string;
}
export interface ShipmentPhysicalSummary {
  totalPieces: number;
  totalCartons: number;
  totalWeightKg: string;
  totalVolumeCbm: string;
}
export class ShipmentPhysicalValuesError extends Error {
  constructor(message: string, readonly statusCode: number, readonly details: { code: string; lineId?: number | null; field?: string }) {
    super(message);
    this.name = "ShipmentPhysicalValuesError";
  }
}

function numericColumn(value: Decimal, precision: number, scale: number): string {
  const rounded = value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  if (!rounded.isFinite() || rounded.isNegative() || rounded.gte(new PhysicalDecimal(10).pow(precision - scale))) {
    throw new ShipmentPhysicalValuesError("Physical shipment totals exceed the supported column range. Review pieces, cartons, and dimensions.", 422,
      { code: "SHIPMENT_LINE_TOTAL_OVERFLOW" });
  }
  return rounded.toFixed(scale);
}

/** The shipment's saved measurements and physical basis are authoritative.
 * Receive-pack factors and catalog measurements never change this multiplier.
 * Stored totals are materialized results of this function, not editable inputs. */
export function computeShipmentPhysicalTotals(line: ShipmentPhysicalSource): ShipmentPhysicalTotals {
  const parsed = physicalSourceSchema.safeParse({
    qtyShipped: line.qtyShipped, cartonCount: line.cartonCount, dimensionBasis: line.dimensionBasis,
    weightKg: line.weightKg, lengthCm: line.lengthCm, widthCm: line.widthCm, heightCm: line.heightCm,
  });
  if (!parsed.success) throw new ShipmentPhysicalValuesError(
    "Shipment physical values require correction: " + parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    422, { code: "SHIPMENT_LINE_INPUT_INVALID" });
  // Null is an explicit legacy basis: keep its original carton/piece rule until
  // an approved packing edit selects a basis. Never infer a new receive unit.
  const basis = line.dimensionBasis ?? (line.cartonCount == null ? "piece" : "carton");
  if (basis === "carton" && line.cartonCount == null) throw new ShipmentPhysicalValuesError(
    "Enter the number of shipping cartons for measurements per carton, or select measurements per piece.",
    422, { code: "SHIPMENT_LINE_CARTON_COUNT_REQUIRED" });
  const multiplier = basis === "carton" ? line.cartonCount! : line.qtyShipped;
  const weight = new PhysicalDecimal(line.weightKg ?? "0");
  const cubicCm = new PhysicalDecimal(line.lengthCm ?? "0").mul(line.widthCm ?? "0").mul(line.heightCm ?? "0");
  return {
    totalWeightKg: numericColumn(weight.mul(multiplier), 12, 3),
    totalVolumeCbm: numericColumn(cubicCm.mul(multiplier).div(CUBIC_CENTIMETRES_PER_CUBIC_METRE), 12, 6),
    chargeableWeightKg: numericColumn(PhysicalDecimal.max(weight, cubicCm.div(VOLUMETRIC_CUBIC_CENTIMETRES_PER_KILOGRAM)).mul(multiplier), 12, 3),
  };
}

export function summarizeShipmentPhysicalValues(lines: readonly ShipmentPhysicalSource[]): ShipmentPhysicalSummary {
  let totalPieces = 0, totalCartons = 0;
  let weight = new PhysicalDecimal(0), volume = new PhysicalDecimal(0);
  for (const line of lines) {
    const totals = computeShipmentPhysicalTotals(line);
    totalPieces += line.qtyShipped;
    totalCartons += line.cartonCount ?? 0;
    weight = weight.plus(totals.totalWeightKg);
    volume = volume.plus(totals.totalVolumeCbm);
  }
  if (![totalPieces, totalCartons].every(value => Number.isSafeInteger(value) && value >= 0 && value <= SHIPMENT_LINE_INTEGER_MAX)) {
    throw new ShipmentPhysicalValuesError("Shipment piece or carton totals exceed the supported integer range.", 422,
      { code: "SHIPMENT_LINE_TOTAL_OVERFLOW" });
  }
  return { totalPieces, totalCartons, totalWeightKg: numericColumn(weight, 12, 3), totalVolumeCbm: numericColumn(volume, 12, 6) };
}

export function shipmentPhysicalAllocationValue(line: ShipmentPhysicalSource, method: "by_volume" | "by_weight" | "by_chargeable_weight"): string | null {
  const totals = computeShipmentPhysicalTotals(line);
  const dimensions = [line.lengthCm, line.widthCm, line.heightCm];
  const required = method === "by_weight" ? [line.weightKg] : method === "by_volume" ? dimensions : [line.weightKg, ...dimensions];
  // max(actual, volumetric) cannot be established from only one known side.
  if (required.some(value => value == null || !new PhysicalDecimal(value).isPositive())) return null;
  return method === "by_weight" ? totals.totalWeightKg : method === "by_volume" ? totals.totalVolumeCbm : totals.chargeableWeightKg;
}

export function validateMaterializedShipmentPhysicalTotals(lines: readonly (ShipmentPhysicalSource & {
  id?: number; totalWeightKg?: string | null; totalVolumeCbm?: string | null; chargeableWeightKg?: string | null;
})[]): void {
  for (const line of lines) {
    const expected = computeShipmentPhysicalTotals(line);
    for (const field of ["totalWeightKg", "totalVolumeCbm", "chargeableWeightKg"] as const) {
      let stored: Decimal;
      try { stored = new PhysicalDecimal(line[field] ?? "0"); }
      catch { throw new ShipmentPhysicalValuesError("Stored shipment totals require correction.", 422, { code: "SHIPMENT_LINE_TOTAL_OVERFLOW", lineId: line.id ?? null, field }); }
      numericColumn(stored, 12, field === "totalVolumeCbm" ? 6 : 3);
      if (!stored.eq(expected[field])) throw new ShipmentPhysicalValuesError(
        `Shipment line ${line.id ?? ""} has physical totals that disagree with its pieces, cartons, or dimensions. Resolve dimensions or correct that line before changing allocation.`,
        409, { code: "SHIPMENT_LINE_TOTALS_REVIEW_REQUIRED", lineId: line.id ?? null, field });
    }
  }
  summarizeShipmentPhysicalValues(lines);
}
