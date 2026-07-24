import {
  SHIPPING_CHANNEL_POLICY_PURPOSES,
  type ShippingChannelEligibilityMode,
  type ShippingChannelPolicyPurpose,
  type ShippingChannelPolicyStatus,
  type ShippingChannelRouteMode,
} from "@shared/types/shipping-channel-routing";
import type { ShippingRateContext } from "./shipping-channel";

export interface ShippingDestinationInput {
  country: string;
  region?: string | null;
  postalCode?: string | null;
}

export interface DestinationScopeMemberCandidate {
  country: string;
  region: string | null;
  postalPrefix: string | null;
}

export interface ChannelShippingRouteCandidate {
  routeId: number;
  originWarehouseId: number | null;
  sourceDestinationScopeId: number | null;
  destinationMembers: readonly DestinationScopeMemberCandidate[];
  mode: ShippingChannelRouteMode;
  eligibilityMode: ShippingChannelEligibilityMode;
  rateBookId: number | null;
  rateBookStatus: "draft" | "active" | "retired" | null;
}

export interface ChannelShippingPolicyCandidate {
  policyId: number;
  channelId: number;
  purpose: ShippingChannelPolicyPurpose;
  version: number;
  status: ShippingChannelPolicyStatus;
  routes: readonly ChannelShippingRouteCandidate[];
}

export interface ChannelShippingPolicyResolutionInput {
  channelId: number;
  purpose: ShippingChannelPolicyPurpose;
  originWarehouseId: number;
  destination: ShippingDestinationInput;
}

export interface LegacyChannelShippingFallback {
  purpose: ShippingChannelPolicyPurpose;
  mode: Exclude<ShippingChannelRouteMode, "disabled">;
  eligibilityMode: Exclude<ShippingChannelEligibilityMode, "none">;
  rateContext: ShippingRateContext | null;
}

export type ChannelShippingDecision =
  | {
      ok: true;
      source: "channel_policy";
      policyId: number;
      policyVersion: number;
      routeId: number;
      mode: ShippingChannelRouteMode;
      eligibilityMode: ShippingChannelEligibilityMode;
      rateBookId: number | null;
      legacyRateContext: null;
    }
  | {
      ok: true;
      source: "legacy_profile";
      policyId: null;
      policyVersion: null;
      routeId: null;
      mode: Exclude<ShippingChannelRouteMode, "disabled">;
      eligibilityMode: Exclude<ShippingChannelEligibilityMode, "none">;
      rateBookId: null;
      legacyRateContext: ShippingRateContext | null;
    }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "NO_ACTIVE_POLICY"
        | "AMBIGUOUS_ACTIVE_POLICY"
        | "NO_MATCHING_ROUTE"
        | "AMBIGUOUS_ROUTE"
        | "INVALID_POLICY_CONFIGURATION"
        | "INVALID_LEGACY_FALLBACK";
      message: string;
    };

interface NormalizedDestination {
  country: string;
  region: string | null;
  postalCode: string | null;
}

interface RouteMatch {
  route: ChannelShippingRouteCandidate;
  warehouseSpecificity: number;
  destinationSpecificity: number;
  postalPrefixLength: number;
}

/**
 * Resolve the active policy only. This function never consults legacy channel
 * names, marketplace stores, or provider-specific settings.
 */
export function resolveActiveChannelShippingPolicy(
  policies: readonly ChannelShippingPolicyCandidate[],
  input: ChannelShippingPolicyResolutionInput,
): ChannelShippingDecision {
  const invalidInput = validateInput(input);
  if (invalidInput) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: invalidInput,
    };
  }

  const activePolicies = policies.filter((policy) =>
    policy.status === "active"
    && policy.channelId === input.channelId
    && policy.purpose === input.purpose);

  if (activePolicies.length === 0) {
    return {
      ok: false,
      code: "NO_ACTIVE_POLICY",
      message: `no active shipping policy exists for channel ${input.channelId}/${input.purpose}`,
    };
  }
  if (activePolicies.length > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS_ACTIVE_POLICY",
      message: `multiple active shipping policies exist for channel ${input.channelId}/${input.purpose}`,
    };
  }

  const policy = activePolicies[0];
  const invalidRoute = policy.routes.find((route) => invalidRouteConfiguration(route) !== null);
  if (invalidRoute) {
    return {
      ok: false,
      code: "INVALID_POLICY_CONFIGURATION",
      message: `route ${invalidRoute.routeId}: ${invalidRouteConfiguration(invalidRoute)}`,
    };
  }

  const destination = normalizeDestination(input.destination);
  const matches = policy.routes
    .map((route) => matchRoute(route, input.originWarehouseId, destination))
    .filter((match): match is RouteMatch => match !== null);

  if (matches.length === 0) {
    return {
      ok: false,
      code: "NO_MATCHING_ROUTE",
      message: `active policy ${policy.policyId} has no route for warehouse ${input.originWarehouseId} and destination ${destination.country}`,
    };
  }

  const best = matches.reduce((current, candidate) =>
    compareRouteMatches(candidate, current) > 0 ? candidate : current);
  const equallySpecific = matches.filter((candidate) =>
    compareRouteMatches(candidate, best) === 0);

  if (equallySpecific.length > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS_ROUTE",
      message: `active policy ${policy.policyId} has multiple equally specific routes: ${
        equallySpecific.map((candidate) => candidate.route.routeId).sort((a, b) => a - b).join(", ")
      }`,
    };
  }

  return {
    ok: true,
    source: "channel_policy",
    policyId: policy.policyId,
    policyVersion: policy.version,
    routeId: best.route.routeId,
    mode: best.route.mode,
    eligibilityMode: best.route.eligibilityMode,
    rateBookId: best.route.rateBookId,
    legacyRateContext: null,
  };
}

/**
 * Compatibility boundary for the expansion phase. Legacy behavior is used
 * only when no active canonical policy exists. An incomplete or ambiguous
 * active policy always fails closed instead of silently escaping to legacy.
 */
export function resolveChannelShippingDecision(
  policies: readonly ChannelShippingPolicyCandidate[],
  input: ChannelShippingPolicyResolutionInput,
  legacyFallback: LegacyChannelShippingFallback | null,
): ChannelShippingDecision {
  const canonical = resolveActiveChannelShippingPolicy(policies, input);
  if (canonical.ok || canonical.code !== "NO_ACTIVE_POLICY" || legacyFallback === null) {
    return canonical;
  }
  if (legacyFallback.purpose !== input.purpose) {
    return {
      ok: false,
      code: "INVALID_LEGACY_FALLBACK",
      message: `legacy fallback purpose ${legacyFallback.purpose} does not match ${input.purpose}`,
    };
  }

  return {
    ok: true,
    source: "legacy_profile",
    policyId: null,
    policyVersion: null,
    routeId: null,
    mode: legacyFallback.mode,
    eligibilityMode: legacyFallback.eligibilityMode,
    rateBookId: null,
    legacyRateContext: legacyFallback.rateContext,
  };
}

function validateInput(input: ChannelShippingPolicyResolutionInput): string | null {
  if (!Number.isInteger(input.channelId) || input.channelId <= 0) {
    return "channelId must be a positive integer";
  }
  if (!Number.isInteger(input.originWarehouseId) || input.originWarehouseId <= 0) {
    return "originWarehouseId must be a positive integer";
  }
  if (!SHIPPING_CHANNEL_POLICY_PURPOSES.includes(input.purpose)) {
    return `unsupported shipping purpose: ${String(input.purpose)}`;
  }
  if (!/^[A-Z]{2}$/.test(input.destination.country.trim().toUpperCase())) {
    return "destination.country must be a two-letter country code";
  }
  return null;
}

function invalidRouteConfiguration(route: ChannelShippingRouteCandidate): string | null {
  if (!Number.isInteger(route.routeId) || route.routeId <= 0) {
    return "routeId must be a positive integer";
  }
  if (
    route.originWarehouseId !== null
    && (!Number.isInteger(route.originWarehouseId) || route.originWarehouseId <= 0)
  ) {
    return "originWarehouseId must be null or a positive integer";
  }
  if (route.sourceDestinationScopeId === null && route.destinationMembers.length > 0) {
    return "a catch-all route cannot contain destination members";
  }
  if (route.sourceDestinationScopeId !== null && route.destinationMembers.length === 0) {
    return "a destination-scoped route must contain at least one member";
  }
  if (
    route.sourceDestinationScopeId !== null
    && (!Number.isInteger(route.sourceDestinationScopeId) || route.sourceDestinationScopeId <= 0)
  ) {
    return "sourceDestinationScopeId must be null or a positive integer";
  }
  const invalidMember = route.destinationMembers.find((member) =>
    invalidDestinationMember(member) !== null);
  if (invalidMember) {
    return `invalid destination member: ${invalidDestinationMember(invalidMember)}`;
  }
  if (route.mode === "engine_quoted") {
    if (route.rateBookId === null) return "engine_quoted requires a rate book";
    if (!Number.isInteger(route.rateBookId) || route.rateBookId <= 0) {
      return "rateBookId must be a positive integer";
    }
    if (route.rateBookStatus !== "active") return "engine_quoted requires an active rate book";
    if (route.eligibilityMode === "none") return "engine_quoted requires eligibility authority";
    return null;
  }
  if (route.mode === "channel_managed") {
    if (route.rateBookId !== null) return "channel_managed cannot reference a rate book";
    if (route.rateBookStatus !== null) return "channel_managed cannot carry rate-book status";
    if (route.eligibilityMode === "none") return "channel_managed requires eligibility authority";
    return null;
  }
  if (
    route.rateBookId !== null
    || route.rateBookStatus !== null
    || route.eligibilityMode !== "none"
  ) {
    return "disabled requires no rate book, rate-book status, or eligibility authority";
  }
  return null;
}

function invalidDestinationMember(member: DestinationScopeMemberCandidate): string | null {
  const country = member.country.trim().toUpperCase();
  const region = normalizeOptional(member.region);
  const postalPrefix = normalizeOptional(member.postalPrefix);
  if (!/^[A-Z]{2}$/.test(country)) return "country must be a two-letter code";
  if (region !== null && !/^[A-Z0-9][A-Z0-9-]{0,9}$/.test(region)) {
    return "region must be a normalized subdivision code";
  }
  if (postalPrefix !== null && !/^[A-Z0-9][A-Z0-9 -]{0,19}$/.test(postalPrefix)) {
    return "postalPrefix contains unsupported characters";
  }
  return null;
}

function matchRoute(
  route: ChannelShippingRouteCandidate,
  originWarehouseId: number,
  destination: NormalizedDestination,
): RouteMatch | null {
  const warehouseSpecificity = route.originWarehouseId === originWarehouseId
    ? 1
    : route.originWarehouseId === null
      ? 0
      : -1;
  if (warehouseSpecificity < 0) return null;

  if (route.sourceDestinationScopeId === null) {
    return {
      route,
      warehouseSpecificity,
      destinationSpecificity: 0,
      postalPrefixLength: 0,
    };
  }

  const memberMatches = route.destinationMembers
    .map((member) => matchDestinationMember(member, destination))
    .filter((match): match is Pick<RouteMatch, "destinationSpecificity" | "postalPrefixLength"> =>
      match !== null);
  if (memberMatches.length === 0) return null;

  const bestMember = memberMatches.reduce((current, candidate) =>
    candidate.destinationSpecificity > current.destinationSpecificity
    || (
      candidate.destinationSpecificity === current.destinationSpecificity
      && candidate.postalPrefixLength > current.postalPrefixLength
    )
      ? candidate
      : current);

  return {
    route,
    warehouseSpecificity,
    ...bestMember,
  };
}

function matchDestinationMember(
  member: DestinationScopeMemberCandidate,
  destination: NormalizedDestination,
): Pick<RouteMatch, "destinationSpecificity" | "postalPrefixLength"> | null {
  const country = member.country.trim().toUpperCase();
  const region = normalizeOptional(member.region);
  const postalPrefix = normalizePostal(member.postalPrefix);
  if (country !== destination.country) return null;

  if (postalPrefix !== null) {
    if (
      destination.postalCode === null
      || !destination.postalCode.startsWith(postalPrefix)
      || (region !== null && region !== destination.region)
    ) {
      return null;
    }
    return {
      destinationSpecificity: 3,
      postalPrefixLength: postalPrefix.length,
    };
  }

  if (region !== null) {
    return region === destination.region
      ? { destinationSpecificity: 2, postalPrefixLength: 0 }
      : null;
  }

  return { destinationSpecificity: 1, postalPrefixLength: 0 };
}

function compareRouteMatches(left: RouteMatch, right: RouteMatch): number {
  return left.warehouseSpecificity - right.warehouseSpecificity
    || left.destinationSpecificity - right.destinationSpecificity
    || left.postalPrefixLength - right.postalPrefixLength;
}

function normalizeDestination(destination: ShippingDestinationInput): NormalizedDestination {
  return {
    country: destination.country.trim().toUpperCase(),
    region: normalizeOptional(destination.region),
    postalCode: normalizePostal(destination.postalCode),
  };
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toUpperCase();
  return normalized === "" ? null : normalized;
}

function normalizePostal(value: string | null | undefined): string | null {
  const normalized = normalizeOptional(value);
  if (normalized === null) return null;
  const compact = normalized.replace(/[\s-]+/g, "");
  return compact === "" ? null : compact;
}
