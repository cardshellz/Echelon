import { describe, expect, it } from "vitest";
import { buildLegacyChannelShippingFallback } from "../../application/legacy-channel-shipping-fallback";
import {
  resolveActiveChannelShippingPolicy,
  resolveChannelShippingDecision,
  validateChannelShippingPolicyForActivation,
  type ChannelShippingPolicyCandidate,
  type ChannelShippingRouteCandidate,
} from "../../domain/channel-shipping-policy";

const input = {
  channelId: 36,
  purpose: "customer_checkout" as const,
  originWarehouseId: 1,
  destination: {
    country: "us",
    region: "pa",
    postalCode: "16066",
  },
};

const catchAllEngineRoute: ChannelShippingRouteCandidate = {
  routeId: 1,
  originWarehouseId: null,
  sourceDestinationScopeId: null,
  destinationMembers: [],
  mode: "engine_quoted",
  eligibilityMode: "engine",
  rateBookId: 10,
  rateBookStatus: "active",
};

function policy(
  routes: readonly ChannelShippingRouteCandidate[],
  overrides: Partial<ChannelShippingPolicyCandidate> = {},
): ChannelShippingPolicyCandidate {
  return {
    policyId: 100,
    channelId: 36,
    purpose: "customer_checkout",
    version: 1,
    status: "active",
    routes,
    ...overrides,
  };
}

describe("resolveActiveChannelShippingPolicy", () => {
  it("resolves a channel-wide catch-all route", () => {
    expect(resolveActiveChannelShippingPolicy([policy([catchAllEngineRoute])], input))
      .toEqual({
        ok: true,
        source: "channel_policy",
        policyId: 100,
        policyVersion: 1,
        routeId: 1,
        mode: "engine_quoted",
        eligibilityMode: "engine",
        rateBookId: 10,
        legacyRateContext: null,
      });
  });

  it("uses a destination scope before a catch-all at the same warehouse scope", () => {
    const pennsylvaniaChannelRoute: ChannelShippingRouteCandidate = {
      routeId: 2,
      originWarehouseId: null,
      sourceDestinationScopeId: 20,
      destinationMembers: [{
        country: "US",
        region: "PA",
        postalPrefix: null,
      }],
      mode: "channel_managed",
      eligibilityMode: "channel",
      rateBookId: null,
      rateBookStatus: null,
    };

    expect(resolveActiveChannelShippingPolicy(
      [policy([catchAllEngineRoute, pennsylvaniaChannelRoute])],
      input,
    )).toMatchObject({
      ok: true,
      routeId: 2,
      mode: "channel_managed",
    });
  });

  it("uses the longest matching postal prefix", () => {
    const broadPrefix: ChannelShippingRouteCandidate = {
      routeId: 2,
      originWarehouseId: null,
      sourceDestinationScopeId: 20,
      destinationMembers: [{
        country: "US",
        region: null,
        postalPrefix: "16",
      }],
      mode: "channel_managed",
      eligibilityMode: "channel",
      rateBookId: null,
      rateBookStatus: null,
    };
    const narrowPrefix: ChannelShippingRouteCandidate = {
      routeId: 3,
      originWarehouseId: null,
      sourceDestinationScopeId: 21,
      destinationMembers: [{
        country: "US",
        region: "PA",
        postalPrefix: "160",
      }],
      mode: "disabled",
      eligibilityMode: "none",
      rateBookId: null,
      rateBookStatus: null,
    };

    expect(resolveActiveChannelShippingPolicy(
      [policy([broadPrefix, narrowPrefix])],
      input,
    )).toMatchObject({
      ok: true,
      routeId: 3,
      mode: "disabled",
    });
  });

  it("normalizes spaces and hyphens in international postal prefixes", () => {
    const canadianPostalRoute: ChannelShippingRouteCandidate = {
      routeId: 2,
      originWarehouseId: null,
      sourceDestinationScopeId: 20,
      destinationMembers: [{
        country: "CA",
        region: "ON",
        postalPrefix: "K1A-0",
      }],
      mode: "channel_managed",
      eligibilityMode: "channel",
      rateBookId: null,
      rateBookStatus: null,
    };

    expect(resolveActiveChannelShippingPolicy(
      [policy([canadianPostalRoute])],
      {
        ...input,
        destination: {
          country: "ca",
          region: "on",
          postalCode: "K1A 0B1",
        },
      },
    )).toMatchObject({
      ok: true,
      routeId: 2,
    });
  });

  it("uses a warehouse-specific route before a global route", () => {
    const globalPennsylvania: ChannelShippingRouteCandidate = {
      routeId: 2,
      originWarehouseId: null,
      sourceDestinationScopeId: 20,
      destinationMembers: [{
        country: "US",
        region: "PA",
        postalPrefix: null,
      }],
      mode: "channel_managed",
      eligibilityMode: "channel",
      rateBookId: null,
      rateBookStatus: null,
    };
    const warehouseCatchAll: ChannelShippingRouteCandidate = {
      ...catchAllEngineRoute,
      routeId: 3,
      originWarehouseId: 1,
      rateBookId: 11,
    };

    expect(resolveActiveChannelShippingPolicy(
      [policy([globalPennsylvania, warehouseCatchAll])],
      input,
    )).toMatchObject({
      ok: true,
      routeId: 3,
      rateBookId: 11,
    });
  });

  it("fails closed when two routes have equal specificity", () => {
    const duplicate = {
      ...catchAllEngineRoute,
      routeId: 2,
      rateBookId: 11,
    };

    expect(resolveActiveChannelShippingPolicy(
      [policy([catchAllEngineRoute, duplicate])],
      input,
    )).toMatchObject({
      ok: false,
      code: "AMBIGUOUS_ROUTE",
    });
  });

  it("fails closed when an active policy has no matching route", () => {
    const canadaOnly: ChannelShippingRouteCandidate = {
      routeId: 2,
      originWarehouseId: null,
      sourceDestinationScopeId: 20,
      destinationMembers: [{
        country: "CA",
        region: null,
        postalPrefix: null,
      }],
      mode: "channel_managed",
      eligibilityMode: "channel",
      rateBookId: null,
      rateBookStatus: null,
    };

    expect(resolveActiveChannelShippingPolicy([policy([canadaOnly])], input))
      .toMatchObject({
        ok: false,
        code: "NO_MATCHING_ROUTE",
      });
  });

  it("rejects multiple active policy versions defensively", () => {
    expect(resolveActiveChannelShippingPolicy([
      policy([catchAllEngineRoute]),
      policy([catchAllEngineRoute], { policyId: 101, version: 2 }),
    ], input)).toMatchObject({
      ok: false,
      code: "AMBIGUOUS_ACTIVE_POLICY",
    });
  });

  it("rejects a malformed route instead of attempting to rate it", () => {
    expect(resolveActiveChannelShippingPolicy([policy([{
      ...catchAllEngineRoute,
      rateBookId: null,
    }])], input)).toMatchObject({
      ok: false,
      code: "INVALID_POLICY_CONFIGURATION",
    });
  });

  it("rejects an inactive rate book before rating", () => {
    expect(resolveActiveChannelShippingPolicy([policy([{
      ...catchAllEngineRoute,
      rateBookStatus: "draft",
    }])], input)).toMatchObject({
      ok: false,
      code: "INVALID_POLICY_CONFIGURATION",
    });
  });
});

describe("resolveChannelShippingDecision compatibility behavior", () => {
  it("uses the legacy profile only when no active canonical policy exists", () => {
    expect(resolveChannelShippingDecision(
      [],
      input,
      buildLegacyChannelShippingFallback("shopify"),
    )).toEqual({
      ok: true,
      source: "legacy_profile",
      policyId: null,
      policyVersion: null,
      routeId: null,
      mode: "engine_quoted",
      eligibilityMode: "engine",
      rateBookId: null,
      legacyRateContext: {
        pricingChannel: "shopify",
        purpose: "customer_checkout",
      },
    });
  });

  it("does not escape an incomplete active policy through legacy fallback", () => {
    expect(resolveChannelShippingDecision(
      [policy([])],
      input,
      buildLegacyChannelShippingFallback("shopify"),
    )).toMatchObject({
      ok: false,
      code: "NO_MATCHING_ROUTE",
    });
  });

  it("leaves an unknown channel disabled until a policy is explicitly activated", () => {
    expect(resolveChannelShippingDecision([], input, null)).toMatchObject({
      ok: false,
      code: "NO_ACTIVE_POLICY",
    });
  });

  it("maps the existing eBay profile to channel-managed checkout", () => {
    expect(buildLegacyChannelShippingFallback("ebay")).toEqual({
      purpose: "customer_checkout",
      mode: "channel_managed",
      eligibilityMode: "channel",
      rateContext: null,
    });
  });

  it("rejects a legacy fallback for the wrong business purpose", () => {
    expect(resolveChannelShippingDecision(
      [],
      input,
      buildLegacyChannelShippingFallback("dropship"),
    )).toMatchObject({
      ok: false,
      code: "INVALID_LEGACY_FALLBACK",
    });
  });
});

describe("validateChannelShippingPolicyForActivation", () => {
  const disabledCatchAll: ChannelShippingRouteCandidate = {
    routeId: 99,
    originWarehouseId: null,
    sourceDestinationScopeId: null,
    destinationMembers: [],
    mode: "disabled",
    eligibilityMode: "none",
    rateBookId: null,
    rateBookStatus: null,
  };

  it("requires exactly one global catch-all route", () => {
    const scopedRoute: ChannelShippingRouteCandidate = {
      ...catchAllEngineRoute,
      routeId: 2,
      sourceDestinationScopeId: 20,
      destinationMembers: [{
        country: "US",
        region: "PA",
        postalPrefix: null,
      }],
    };

    expect(validateChannelShippingPolicyForActivation([scopedRoute]))
      .toContain(
        "Define exactly one all-warehouses, all-destinations fallback route. "
        + "Use Disabled when unmatched destinations must not be offered.",
      );
  });

  it("accepts a disabled global catch-all as an explicit fail-closed fallback", () => {
    expect(validateChannelShippingPolicyForActivation([disabledCatchAll]))
      .toEqual([]);
  });

  it("rejects country scopes that overlap at equal specificity", () => {
    const countryRoute = (
      routeId: number,
      scopeId: number,
    ): ChannelShippingRouteCandidate => ({
      ...catchAllEngineRoute,
      routeId,
      sourceDestinationScopeId: scopeId,
      destinationMembers: [{
        country: "US",
        region: null,
        postalPrefix: null,
      }],
    });

    expect(validateChannelShippingPolicyForActivation([
      disabledCatchAll,
      countryRoute(1, 10),
      countryRoute(2, 11),
    ])).toContain("Routes 1 and 2 overlap at equal specificity.");
  });

  it("allows nested postal prefixes because the longer prefix wins", () => {
    const postalRoute = (
      routeId: number,
      scopeId: number,
      prefix: string,
    ): ChannelShippingRouteCandidate => ({
      ...catchAllEngineRoute,
      routeId,
      sourceDestinationScopeId: scopeId,
      destinationMembers: [{
        country: "US",
        region: "PA",
        postalPrefix: prefix,
      }],
    });

    expect(validateChannelShippingPolicyForActivation([
      disabledCatchAll,
      postalRoute(1, 10, "16"),
      postalRoute(2, 11, "160"),
    ])).toEqual([]);
  });

  it("rejects equal postal prefixes when one route covers every region", () => {
    const postalRoute = (
      routeId: number,
      scopeId: number,
      region: string | null,
    ): ChannelShippingRouteCandidate => ({
      ...catchAllEngineRoute,
      routeId,
      sourceDestinationScopeId: scopeId,
      destinationMembers: [{
        country: "US",
        region,
        postalPrefix: "160",
      }],
    });

    expect(validateChannelShippingPolicyForActivation([
      disabledCatchAll,
      postalRoute(1, 10, null),
      postalRoute(2, 11, "PA"),
    ])).toContain("Routes 1 and 2 overlap at equal specificity.");
  });

  it("allows equal postal prefixes in different explicit regions", () => {
    const postalRoute = (
      routeId: number,
      scopeId: number,
      region: string,
    ): ChannelShippingRouteCandidate => ({
      ...catchAllEngineRoute,
      routeId,
      sourceDestinationScopeId: scopeId,
      destinationMembers: [{
        country: "US",
        region,
        postalPrefix: "100",
      }],
    });

    expect(validateChannelShippingPolicyForActivation([
      disabledCatchAll,
      postalRoute(1, 10, "NY"),
      postalRoute(2, 11, "PA"),
    ])).toEqual([]);
  });

  it("allows the same destination coverage at different warehouse scopes", () => {
    const route = (
      routeId: number,
      warehouseId: number,
    ): ChannelShippingRouteCandidate => ({
      ...catchAllEngineRoute,
      routeId,
      originWarehouseId: warehouseId,
      sourceDestinationScopeId: 10 + routeId,
      destinationMembers: [{
        country: "US",
        region: "PA",
        postalPrefix: null,
      }],
    });

    expect(validateChannelShippingPolicyForActivation([
      disabledCatchAll,
      route(1, 1),
      route(2, 2),
    ])).toEqual([]);
  });
});
