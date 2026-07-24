export const SHIPPING_CHANNEL_POLICY_PURPOSES = [
  "customer_checkout",
  "vendor_fulfillment_charge",
] as const;
export type ShippingChannelPolicyPurpose =
  (typeof SHIPPING_CHANNEL_POLICY_PURPOSES)[number];

export const SHIPPING_CHANNEL_POLICY_STATUSES = [
  "draft",
  "active",
  "retired",
] as const;
export type ShippingChannelPolicyStatus =
  (typeof SHIPPING_CHANNEL_POLICY_STATUSES)[number];

export const SHIPPING_CHANNEL_ROUTE_MODES = [
  "engine_quoted",
  "channel_managed",
  "disabled",
] as const;
export type ShippingChannelRouteMode =
  (typeof SHIPPING_CHANNEL_ROUTE_MODES)[number];

export const SHIPPING_CHANNEL_ELIGIBILITY_MODES = [
  "engine",
  "channel",
  "intersection",
  "none",
] as const;
export type ShippingChannelEligibilityMode =
  (typeof SHIPPING_CHANNEL_ELIGIBILITY_MODES)[number];

export const SHIPPING_DESTINATION_SCOPE_STATUSES = [
  "draft",
  "active",
  "retired",
] as const;
export type ShippingDestinationScopeStatus =
  (typeof SHIPPING_DESTINATION_SCOPE_STATUSES)[number];
