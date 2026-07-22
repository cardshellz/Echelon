/** Direct-geography service-level rate selection. Pure domain logic, no I/O. */

export type ShippingPricingBasis = "shipment_weight" | "pallet_count";
export type ShippingFulfillmentMode = "parcel" | "freight";
export type ShippingRateChargeModel = "fixed_band" | "base_plus_per_started_pound";

const GRAMS_PER_POUND_NUMERATOR = 45_359_237;
const GRAMS_PER_POUND_DENOMINATOR = 100_000;
const ROUNDING_HALF_DENOMINATOR = GRAMS_PER_POUND_DENOMINATOR / 2;

export interface RateCandidateRow {
  rateTableId: number;
  serviceLevelId: number;
  serviceLevelCode: string;
  displayName: string;
  description: string | null;
  fulfillmentMode: ShippingFulfillmentMode;
  pricingBasis: ShippingPricingBasis;
  sortOrder: number;
  promiseMinBusinessDays: number | null;
  promiseMaxBusinessDays: number | null;
  currency: string;
  /** NULL = applies to any origin warehouse. */
  originWarehouseId: number | null;
  destinationCountry: string;
  destinationRegion: string;
  postalPrefix: string | null;
  /** Grams for shipment_weight; pallet quantity for pallet_count. */
  minMeasure: number;
  /** Grams for shipment_weight; pallet quantity for pallet_count. */
  maxMeasure: number | null;
  /** Optional freight eligibility ceiling. */
  maxShipmentWeightGrams: number | null;
  chargeModel: ShippingRateChargeModel;
  /** Fixed charge or base charge, in integer cents. */
  rateCents: number;
  /** Added for each started pound when chargeModel uses the formula. */
  perStartedPoundCents: number | null;
}

export interface RateSelectionInput {
  destinationCountry: string;
  destinationRegion: string;
  destinationPostal: string;
  shipmentWeightGrams: number;
  palletCount?: number | null;
  originWarehouseId: number;
}

export interface SelectedServiceLevelRate {
  serviceLevelId: number;
  serviceLevelCode: string;
  displayName: string;
  description: string | null;
  fulfillmentMode: ShippingFulfillmentMode;
  pricingBasis: ShippingPricingBasis;
  sortOrder: number;
  promiseMinBusinessDays: number | null;
  promiseMaxBusinessDays: number | null;
  currency: string;
  rateCents: number;
  chargeModel: ShippingRateChargeModel;
  perStartedPoundCents: number | null;
  billablePounds: number | null;
  rateTableId: number;
  ratedMeasure: number;
  maxShipmentWeightGrams: number | null;
  warehouseSpecific: boolean;
  postalSpecific: boolean;
}

/**
 * Select one charge per internal service level.
 *
 * Warehouse-specific rows outrank global rows. Within that scope, the longest
 * matching ZIP prefix outranks a shorter prefix or statewide fallback.
 */
export function selectServiceLevelRates(
  rows: readonly RateCandidateRow[],
  input: RateSelectionInput,
): SelectedServiceLevelRate[] {
  if (!Number.isFinite(input.shipmentWeightGrams) || input.shipmentWeightGrams < 0) {
    return [];
  }

  const country = input.destinationCountry.trim().toUpperCase();
  const region = input.destinationRegion.trim().toUpperCase();
  const postal = input.destinationPostal.trim().toUpperCase();
  const bestByLevel = new Map<number, {
    row: RateCandidateRow;
    calculatedRateCents: number;
    billablePounds: number | null;
  }>();

  for (const row of rows) {
    const measure = measureForBasis(row.pricingBasis, input);
    if (measure === null) continue;
    if (row.destinationCountry.toUpperCase() !== country) continue;
    if (row.destinationRegion.toUpperCase() !== region) continue;
    if (row.postalPrefix !== null && !postal.startsWith(row.postalPrefix)) continue;
    if (row.originWarehouseId !== null && row.originWarehouseId !== input.originWarehouseId) continue;
    if (row.minMeasure > measure || (row.maxMeasure !== null && row.maxMeasure < measure)) continue;
    if (
      row.maxShipmentWeightGrams !== null
      && input.shipmentWeightGrams > row.maxShipmentWeightGrams
    ) {
      continue;
    }

    const calculated = calculateRate(row, input.shipmentWeightGrams);
    if (calculated === null) continue;

    const incumbent = bestByLevel.get(row.serviceLevelId);
    if (incumbent === undefined || compareRows(row, incumbent.row) < 0) {
      bestByLevel.set(row.serviceLevelId, {
        row,
        calculatedRateCents: calculated.rateCents,
        billablePounds: calculated.billablePounds,
      });
    }
  }

  return [...bestByLevel.values()]
    .map(({ row, calculatedRateCents, billablePounds }) => ({
      serviceLevelId: row.serviceLevelId,
      serviceLevelCode: row.serviceLevelCode,
      displayName: row.displayName,
      description: row.description,
      fulfillmentMode: row.fulfillmentMode,
      pricingBasis: row.pricingBasis,
      sortOrder: row.sortOrder,
      promiseMinBusinessDays: row.promiseMinBusinessDays,
      promiseMaxBusinessDays: row.promiseMaxBusinessDays,
      currency: row.currency,
      rateCents: calculatedRateCents,
      chargeModel: row.chargeModel,
      perStartedPoundCents: row.perStartedPoundCents,
      billablePounds,
      rateTableId: row.rateTableId,
      ratedMeasure: measureForBasis(row.pricingBasis, input)!,
      maxShipmentWeightGrams: row.maxShipmentWeightGrams,
      warehouseSpecific: row.originWarehouseId !== null,
      postalSpecific: row.postalPrefix !== null,
    }))
    .sort(compareRates);
}

/**
 * Return the smallest whole-pound quantity whose gram boundary, rounded the
 * same way as stored band limits, contains the shipment weight.
 */
export function startedPoundsFromGrams(weightGrams: number): number | null {
  if (!Number.isSafeInteger(weightGrams) || weightGrams < 0) return null;
  if (weightGrams === 0) return 0;
  const numerator = weightGrams * GRAMS_PER_POUND_DENOMINATOR - ROUNDING_HALF_DENOMINATOR;
  if (!Number.isSafeInteger(numerator)) return null;
  return Math.ceil(numerator / GRAMS_PER_POUND_NUMERATOR);
}

function calculateRate(
  row: RateCandidateRow,
  shipmentWeightGrams: number,
): { rateCents: number; billablePounds: number | null } | null {
  if (!Number.isSafeInteger(row.rateCents) || row.rateCents < 0) return null;
  if (row.chargeModel === "fixed_band") {
    return row.perStartedPoundCents === null
      ? { rateCents: row.rateCents, billablePounds: null }
      : null;
  }
  if (row.pricingBasis !== "shipment_weight") return null;
  if (!Number.isSafeInteger(row.perStartedPoundCents) || row.perStartedPoundCents! < 0) return null;
  const billablePounds = startedPoundsFromGrams(shipmentWeightGrams);
  if (billablePounds === null) return null;
  const variableCharge = row.perStartedPoundCents! * billablePounds;
  const total = row.rateCents + variableCharge;
  if (!Number.isSafeInteger(variableCharge) || !Number.isSafeInteger(total)) return null;
  return { rateCents: total, billablePounds };
}

function measureForBasis(
  pricingBasis: ShippingPricingBasis,
  input: RateSelectionInput,
): number | null {
  if (pricingBasis === "shipment_weight") return input.shipmentWeightGrams;
  const palletCount = input.palletCount;
  return Number.isInteger(palletCount) && palletCount! > 0 ? palletCount! : null;
}

function compareRows(a: RateCandidateRow, b: RateCandidateRow): number {
  const warehouseSpecificity = Number(b.originWarehouseId !== null) - Number(a.originWarehouseId !== null);
  if (warehouseSpecificity !== 0) return warehouseSpecificity;
  const postalSpecificity = (b.postalPrefix?.length ?? 0) - (a.postalPrefix?.length ?? 0);
  if (postalSpecificity !== 0) return postalSpecificity;
  const weightCeilingSpecificity = compareOptionalCeiling(
    a.maxShipmentWeightGrams,
    b.maxShipmentWeightGrams,
  );
  if (weightCeilingSpecificity !== 0) return weightCeilingSpecificity;
  if (a.rateCents !== b.rateCents) return a.rateCents - b.rateCents;
  if (a.rateTableId !== b.rateTableId) return a.rateTableId - b.rateTableId;
  return a.minMeasure - b.minMeasure;
}

function compareOptionalCeiling(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compareRates(a: SelectedServiceLevelRate, b: SelectedServiceLevelRate): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.serviceLevelCode.localeCompare(b.serviceLevelCode);
}
