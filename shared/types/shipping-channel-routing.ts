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

/**
 * Compatibility-only profile keys used while canonical channel policies are
 * shadowed against the pre-policy runtime. They are never persisted as the
 * identity of a canonical channel.
 */
export const SHIPPING_LEGACY_PROFILE_KEYS = [
  "shopify",
  "internal",
  "ebay",
  "dropship",
] as const;
export type ShippingLegacyProfileKey =
  (typeof SHIPPING_LEGACY_PROFILE_KEYS)[number];

export interface ShippingDestinationScopeMember {
  country: string;
  region: string | null;
  postalPrefix: string | null;
}

export interface ShippingDestinationScopeSummary {
  id: number;
  code: string;
  name: string;
  status: ShippingDestinationScopeStatus;
  lockVersion: number;
  members: ShippingDestinationScopeMember[];
  updatedAt: string;
}

export interface ShippingChannelPolicyRouteView {
  id: number;
  originWarehouseId: number | null;
  originWarehouseName: string | null;
  originWarehouseActive: boolean | null;
  destinationScopeId: number | null;
  destinationScopeName: string | null;
  destinationScopeStatus: ShippingDestinationScopeStatus | null;
  destinationMembers: ShippingDestinationScopeMember[];
  mode: ShippingChannelRouteMode;
  eligibilityMode: ShippingChannelEligibilityMode;
  rateBookId: number | null;
  rateBookName: string | null;
  rateBookStatus: "draft" | "active" | "retired" | null;
  activeRateTableCount: number;
}

export interface ShippingChannelPolicyView {
  id: number;
  channelId: number;
  purpose: ShippingChannelPolicyPurpose;
  version: number;
  status: ShippingChannelPolicyStatus;
  lockVersion: number;
  notes: string | null;
  createdBy: string;
  activatedBy: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  routes: ShippingChannelPolicyRouteView[];
  activationErrors: string[];
}

export interface ShippingChannelPolicySlotSummary {
  active: {
    id: number;
    version: number;
    lockVersion: number;
    activatedAt: string;
  } | null;
  draft: {
    id: number;
    version: number;
    lockVersion: number;
    updatedAt: string;
  } | null;
}

/**
 * Shipping behavior a channel adapter can enforce at the order boundary.
 * These are code capabilities, not operator-configurable channel settings.
 */
export interface ShippingChannelAdapterCapabilities {
  readonly acceptsEngineQuotes: boolean;
  readonly managesOwnRates: boolean;
  readonly enforcesDestinationEligibility: boolean;
}

export interface ShippingChannelRoutingChannelSummary {
  id: number;
  name: string;
  provider: string;
  status: string;
  shippingCapabilities: ShippingChannelAdapterCapabilities | null;
  customerCheckout: ShippingChannelPolicySlotSummary;
  vendorFulfillmentCharge: ShippingChannelPolicySlotSummary;
}

export interface ShippingChannelRoutingRateBookOption {
  id: number;
  code: string;
  name: string;
  status: string;
  activeRateTableCount: number;
}

export interface ShippingChannelRoutingWarehouseOption {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
}

export interface ShippingChannelRoutingOverview {
  channels: ShippingChannelRoutingChannelSummary[];
  destinationScopes: ShippingDestinationScopeSummary[];
  rateBooks: ShippingChannelRoutingRateBookOption[];
  warehouses: ShippingChannelRoutingWarehouseOption[];
}

export interface ShippingChannelPolicyRouteInput {
  originWarehouseId: number | null;
  destinationScopeId: number | null;
  mode: ShippingChannelRouteMode;
  eligibilityMode: ShippingChannelEligibilityMode;
  rateBookId: number | null;
}

export interface ShippingChannelPolicyResolutionView {
  ok: boolean;
  source: "channel_policy" | "legacy_profile" | null;
  policyId: number | null;
  policyVersion: number | null;
  routeId: number | null;
  mode: ShippingChannelRouteMode | null;
  eligibilityMode: ShippingChannelEligibilityMode | null;
  rateBookId: number | null;
  code: string | null;
  message: string | null;
}

export interface ShippingChannelPolicyShadowComparison {
  matchesLegacy: boolean;
  differences: string[];
  canonical: ShippingChannelPolicyResolutionView;
  legacy: ShippingChannelPolicyResolutionView;
  snapshotId: number;
}
