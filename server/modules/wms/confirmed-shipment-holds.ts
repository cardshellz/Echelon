/**
 * Holds stop future picking and shipping. When ShipStation has already shipped a
 * held unit and the picker confirms it ("Yes"), that hold no longer protects
 * anything for the shipped units, and leaving it in place traps the item: the
 * pick cannot be recorded, the order stays in the Hold bucket, and the shipment
 * cannot post. These pure rules decide which holds that confirmation retires.
 */

export interface ConfirmedShipmentHoldFacts {
  lineOnHold: boolean;
  lineQuantity: number;
  /** Units the provider declared shipped for this line (the correction's declaration). */
  declaredShippedQuantity: number;
  orderOnHold: boolean;
  /** wms.orders.warehouse_status is 'shipped': every physical line has shipped. */
  orderShipped: boolean;
}

export interface ConfirmedShipmentHoldRelease {
  /** Every unit of the line shipped, so nothing remains for the line hold to protect. */
  releaseLine: boolean;
  /** The whole order shipped, so nothing remains for the order hold to protect. */
  releaseOrder: boolean;
}

export function confirmedShipmentHoldRelease(facts: ConfirmedShipmentHoldFacts): ConfirmedShipmentHoldRelease {
  for (const [field, value] of [
    ["lineQuantity", facts.lineQuantity],
    ["declaredShippedQuantity", facts.declaredShippedQuantity],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  }
  return {
    // A partly shipped line keeps its hold for the units that have not left; the
    // confirmed units are still recorded because recording bypasses holds.
    releaseLine: facts.lineOnHold && facts.lineQuantity > 0 && facts.declaredShippedQuantity >= facts.lineQuantity,
    // A partly shipped order may be held for its other lines, so only a fully
    // shipped order loses its hold.
    releaseOrder: facts.orderOnHold && facts.orderShipped,
  };
}
