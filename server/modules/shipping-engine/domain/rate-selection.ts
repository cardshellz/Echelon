/** Direct-geography service-level rate selection. Pure domain logic, no I/O. */

export type ShippingPricingBasis = "shipment_weight" | "pallet_count";
export type ShippingFulfillmentMode = "parcel" | "freight";

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
  maxMeasure: number;
  /** Optional freight eligibility ceiling. */
  maxShipmentWeightGrams: number | null;
  rateCents: number;
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
  const bestByLevel = new Map<number, RateCandidateRow>();

  for (const row of rows) {
    const measure = measureForBasis(row.pricingBasis, input);
    if (measure === null) continue;
    if (row.destinationCountry.toUpperCase() !== country) continue;
    if (row.destinationRegion.toUpperCase() !== region) continue;
    if (row.postalPrefix !== null && !postal.startsWith(row.postalPrefix)) continue;
    if (row.originWarehouseId !== null && row.originWarehouseId !== input.originWarehouseId) continue;
    if (row.minMeasure > measure || row.maxMeasure < measure) continue;
    if (
      row.maxShipmentWeightGrams !== null
      && input.shipmentWeightGrams > row.maxShipmentWeightGrams
    ) {
      continue;
    }

    const incumbent = bestByLevel.get(row.serviceLevelId);
    if (incumbent === undefined || compareRows(row, incumbent) < 0) {
      bestByLevel.set(row.serviceLevelId, row);
    }
  }

  return [...bestByLevel.values()]
    .map((row) => ({
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
      rateCents: row.rateCents,
      rateTableId: row.rateTableId,
      ratedMeasure: measureForBasis(row.pricingBasis, input)!,
      maxShipmentWeightGrams: row.maxShipmentWeightGrams,
      warehouseSpecific: row.originWarehouseId !== null,
      postalSpecific: row.postalPrefix !== null,
    }))
    .sort(compareRates);
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
