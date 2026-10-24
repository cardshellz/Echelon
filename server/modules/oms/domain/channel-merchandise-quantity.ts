const POSTGRES_INTEGER_MAX = 2_147_483_647;

export interface ChannelMerchandiseQuantity {
  channelCurrentQuantity: number | null;
  channelQuantityUpdatedAt: Date | null;
}

export class ChannelQuantityEvidenceError extends Error {
  readonly code = "CHANNEL_QUANTITY_EVIDENCE_INVALID";
}

function quantity(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > POSTGRES_INTEGER_MAX)
    throw new ChannelQuantityEvidenceError(`${field} must be a nonnegative PostgreSQL integer.`);
  return value;
}

function timestamp(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new ChannelQuantityEvidenceError("The channel quantity timestamp is invalid.");
  return date;
}

/** Merchandise observations never grant payment permission. Missing data stays unknown. */
export function observeChannelMerchandiseQuantity(input: {
  purchasedQuantity: number;
  currentQuantity?: number | null;
  updatedAt?: Date | string | null;
  previous?: {
    channelCurrentQuantity?: number | null;
    channelQuantityUpdatedAt?: Date | string | null;
  } | null;
}): ChannelMerchandiseQuantity & { stale: boolean } {
  const purchased = quantity(input.purchasedQuantity, "Purchased quantity");
  const previousQuantity = input.previous?.channelCurrentQuantity == null
    ? null : quantity(input.previous.channelCurrentQuantity, "Previous channel quantity");
  const previousTime = timestamp(input.previous?.channelQuantityUpdatedAt);
  if (input.currentQuantity == null)
    return { channelCurrentQuantity: previousQuantity, channelQuantityUpdatedAt: previousTime, stale: false };
  const current = quantity(input.currentQuantity, "Current channel quantity");
  const updatedAt = timestamp(input.updatedAt);
  if (!updatedAt || current > purchased)
    throw new ChannelQuantityEvidenceError("Channel quantities require a dated observation within the purchased quantity.");
  if (previousTime && updatedAt < previousTime)
    return { channelCurrentQuantity: previousQuantity, channelQuantityUpdatedAt: previousTime, stale: true };
  if (previousTime && updatedAt.getTime() === previousTime.getTime()
    && previousQuantity !== null && current !== previousQuantity)
    throw new ChannelQuantityEvidenceError("Conflicting channel quantities have the same source version. Refresh the channel order.");
  return { channelCurrentQuantity: current, channelQuantityUpdatedAt: updatedAt, stale: false };
}
