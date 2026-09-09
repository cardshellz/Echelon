import type { FulfillmentChannel } from "@shared/shipping/configuration";

// Matches the internal source identity enforced by
// resolveDropshipOmsChannelIdWithClient. Store names are never channel identity.
const INTERNAL_DROPSHIP_SOURCE = {
  name: "dropship oms",
  type: "internal",
  provider: "manual",
} as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function resolvePackingFulfillmentChannel(input: {
  source: string;
  channelName: string | null;
  channelType: string | null;
  channelProvider: string | null;
  shippingConfig: unknown;
}): FulfillmentChannel {
  const dropship = object(object(input.shippingConfig)?.dropship);
  const internalDropship =
    input.channelName?.trim().toLowerCase() === INTERNAL_DROPSHIP_SOURCE.name &&
    input.channelType === INTERNAL_DROPSHIP_SOURCE.type &&
    input.channelProvider === INTERNAL_DROPSHIP_SOURCE.provider;
  if (
    internalDropship ||
    (typeof dropship?.role === "string" &&
      dropship.role.toLowerCase() === "oms") ||
    dropship?.omsChannel === true ||
    dropship?.omsChannel === "true"
  )
    return "dropship";
  if (input.source === "shopify" || input.source === "ebay")
    return input.source;
  // Existing manual/API/other marketplace orders share the internal profile.
  return "internal";
}
