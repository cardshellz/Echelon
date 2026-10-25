const POSTGRES_INTEGER_MAX = 2_147_483_647;

export interface ChannelMerchandiseDemandChange {
  warehouseQuantity: number;
  previousAuthorityQuantity: number;
  currentAuthorityQuantity: number;
  pickedQuantity: number;
  fulfilledQuantity: number;
}

/** Historical short/completed item quantities may remain unchanged. Reconcile
 * the decrease in unconsumed, authorized demand, never refund counts or money. */
export function channelMerchandiseDemandReduction(
  input: Readonly<ChannelMerchandiseDemandChange>,
): number {
  for (const field of ["warehouseQuantity", "previousAuthorityQuantity", "currentAuthorityQuantity", "pickedQuantity", "fulfilledQuantity"] as const) {
    const value = input[field];
    if (!Number.isSafeInteger(value) || value < 0 || value > POSTGRES_INTEGER_MAX)
      throw Object.assign(new Error(`${field} must be a nonnegative PostgreSQL integer.`), {
        code: "CHANNEL_MERCHANDISE_DEMAND_INVALID", context: { field },
      });
  }
  const consumed = Math.max(input.pickedQuantity, input.fulfilledQuantity);
  const previousDemand = Math.max(
    Math.min(input.warehouseQuantity, input.previousAuthorityQuantity) - consumed,
    0,
  );
  const currentDemand = Math.max(
    Math.min(input.warehouseQuantity, input.currentAuthorityQuantity) - consumed,
    0,
  );
  return Math.max(previousDemand - currentDemand, 0);
}
