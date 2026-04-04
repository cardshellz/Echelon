/**
 * Domain Logic for Inventory Management.
 * 
 * This file contains pure mathematical functions related to:
 * 1. Available to Promise (ATP) calculations and base unit conversions.
 * 2. FIFO Cost of Goods Sold (COGS) lot consumption algorithms.
 * 3. General mathematical bounds checking (preventing negative inventory).
 * 
 * NO DATABASE CALLS are permitted in this file. This ensures logic can be heavily unit-tested.
 */

export interface InventoryLevelData {
  variantQty: number;
  reservedQty: number;
  pickedQty: number;
  packedQty: number;
  backorderQty: number;
  unitsPerVariant: number;
}

export interface BaseUnitTotals {
  onHand: number;
  reserved: number;
  picked: number;
  packed: number;
  backorder: number;
}

// ----------------------------------------------------------------------------
// ATP & Unit Math
// ----------------------------------------------------------------------------

/**
 * Calculates sum of base units across all provided inventory levels.
 */
export function calculateBaseUnitTotals(levels: InventoryLevelData[]): BaseUnitTotals {
  return levels.reduce(
    (acc, lvl) => ({
      onHand: acc.onHand + (lvl.variantQty * lvl.unitsPerVariant),
      reserved: acc.reserved + (lvl.reservedQty * lvl.unitsPerVariant),
      picked: acc.picked + (lvl.pickedQty * lvl.unitsPerVariant),
      packed: acc.packed + ((lvl.packedQty || 0) * lvl.unitsPerVariant),
      backorder: acc.backorder + ((lvl.backorderQty || 0) * lvl.unitsPerVariant),
    }),
    { onHand: 0, reserved: 0, picked: 0, packed: 0, backorder: 0 }
  );
}

/**
 * Derives the fungible ATP pool (in base units) from totals.
 * Formula: ATP = totalOnHand - totalReserved - totalPicked - totalPacked
 */
export function calculateFungibleAtpBase(totals: BaseUnitTotals): number {
  return totals.onHand - totals.reserved - totals.picked - totals.packed;
}

/**
 * Derives the actual sellable units for a specific variant layout.
 * Example: if 15 base units remain, and variant is "case of 10", it yields 1 case.
 */
export function deriveSellableVariantUnits(atpBase: number, unitsPerVariant: number): number {
  if (unitsPerVariant <= 0) return 0;
  return Math.floor(Math.max(0, atpBase) / unitsPerVariant);
}

// ----------------------------------------------------------------------------
// FIFO COGS Math
// ----------------------------------------------------------------------------

export interface FIFOInputLot {
  lotId: number;
  lotNumber: string;
  qtyOnHand: number;
  qtyReserved: number;
  qtyPicked: number;
  unitCostCents: number;
}

export interface FIFOConsumption {
  lotId: number;
  lotNumber: string;
  qty: number;
  unitCostCents: number;
  totalCostCents: number;
}

/**
 * Given a sorted array of FIFO active lots, and a quantity to consume,
 * returns the optimal consumptions without exceeding the required quantity.
 * This function expects `lots` to already be sorted ascending by `receivedAt`.
 */
export function calculateFIFOConsumption(
  sortedLots: FIFOInputLot[], 
  qtyToConsume: number
): { consumptions: FIFOConsumption[], unfundedQty: number } {
  const consumptions: FIFOConsumption[] = [];
  let remaining = qtyToConsume;

  for (const lot of sortedLots) {
    if (remaining <= 0) break;

    const available = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
    if (available <= 0) continue;

    const take = Math.min(available, remaining);

    consumptions.push({
      lotId: lot.lotId,
      lotNumber: lot.lotNumber,
      qty: take,
      unitCostCents: lot.unitCostCents,
      totalCostCents: take * lot.unitCostCents,
    });

    remaining -= take;
  }

  return { consumptions, unfundedQty: remaining };
}

// ----------------------------------------------------------------------------
// Safety Bounds Checking
// ----------------------------------------------------------------------------

/**
 * Throw cleanly if any variant qty operations drop below 0.
 */
export function assertSufficientStock(currentQty: number, decrementQty: number): void {
  if (currentQty < decrementQty) {
    throw new Error(`Insufficient stock: have ${currentQty}, need ${decrementQty}`);
  }
}
