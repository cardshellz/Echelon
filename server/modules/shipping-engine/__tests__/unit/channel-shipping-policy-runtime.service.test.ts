import { describe, expect, it, vi } from "vitest";
import {
  resolveRuntimeChannelShipping,
  type ChannelShippingPolicyRuntimeStore,
  type ResolveRuntimeChannelShippingInput,
  type RuntimeShippingChannel,
} from "../../application/channel-shipping-policy-runtime.service";
import type {
  ChannelShippingPolicyCandidate,
  LegacyChannelShippingFallback,
} from "../../domain/channel-shipping-policy";

const CHANNEL: RuntimeShippingChannel = {
  id: 36,
  provider: "shopify",
  status: "active",
  isDefault: 1,
};

const LEGACY_ENGINE: LegacyChannelShippingFallback = {
  purpose: "customer_checkout",
  mode: "engine_quoted",
  eligibilityMode: "engine",
  rateContext: {
    pricingChannel: "shopify",
    purpose: "customer_checkout",
  },
};

function activePolicy(
  overrides: Partial<ChannelShippingPolicyCandidate> = {},
): ChannelShippingPolicyCandidate {
  return {
    policyId: 10,
    channelId: CHANNEL.id,
    purpose: "customer_checkout",
    version: 2,
    status: "active",
    routes: [{
      routeId: 20,
      originWarehouseId: null,
      sourceDestinationScopeId: null,
      destinationMembers: [],
      mode: "engine_quoted",
      eligibilityMode: "intersection",
      rateBookId: 30,
      rateBookStatus: "active",
    }],
    ...overrides,
  };
}

function store(input: {
  channel?: RuntimeShippingChannel | null;
  policies?: ChannelShippingPolicyCandidate[];
} = {}): ChannelShippingPolicyRuntimeStore {
  return {
    getChannel: vi.fn(async () =>
      input.channel === undefined ? CHANNEL : input.channel),
    loadActivePolicies: vi.fn(async () => input.policies ?? []),
  };
}

function request(
  overrides: Partial<ResolveRuntimeChannelShippingInput> = {},
): ResolveRuntimeChannelShippingInput {
  return {
    provider: "shopify",
    configuredChannelId: "36",
    purpose: "customer_checkout" as const,
    originWarehouseId: 1,
    destination: {
      country: "US",
      region: "PA",
      postalCode: "16066",
    },
    legacyFallback: LEGACY_ENGINE,
    ...overrides,
  };
}

describe("resolveRuntimeChannelShipping", () => {
  it("preserves legacy behavior while the callback has no channel binding", async () => {
    const runtimeStore = store();

    const result = await resolveRuntimeChannelShipping(
      runtimeStore,
      request({ configuredChannelId: undefined }),
    );

    expect(result).toMatchObject({
      ok: true,
      channel: null,
      decision: {
        source: "legacy_profile",
        mode: "engine_quoted",
      },
    });
    expect(runtimeStore.getChannel).not.toHaveBeenCalled();
    expect(runtimeStore.loadActivePolicies).not.toHaveBeenCalled();
  });

  it("uses the active canonical policy and its exact pricing program", async () => {
    const runtimeStore = store({ policies: [activePolicy()] });

    const result = await resolveRuntimeChannelShipping(
      runtimeStore,
      request(),
    );

    expect(result).toMatchObject({
      ok: true,
      channel: { id: 36 },
      decision: {
        source: "channel_policy",
        policyId: 10,
        routeId: 20,
        mode: "engine_quoted",
        rateBookId: 30,
      },
    });
    expect(runtimeStore.loadActivePolicies).toHaveBeenCalledWith(
      36,
      "customer_checkout",
    );
  });

  it("uses legacy only when the bound channel has no active policy", async () => {
    const result = await resolveRuntimeChannelShipping(store(), request());

    expect(result).toMatchObject({
      ok: true,
      channel: { id: 36 },
      decision: {
        source: "legacy_profile",
        mode: "engine_quoted",
      },
    });
  });

  it("fails closed when an active policy is incomplete", async () => {
    const policy = activePolicy({
      routes: [{
        ...activePolicy().routes[0],
        rateBookId: null,
        rateBookStatus: null,
      }],
    });

    const result = await resolveRuntimeChannelShipping(
      store({ policies: [policy] }),
      request(),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_POLICY_CONFIGURATION",
      channel: { id: 36 },
    });
  });

  it.each([
    {
      configuredChannelId: "not-an-id",
      storeInput: {},
      code: "INVALID_CHANNEL_CONFIGURATION",
    },
    {
      configuredChannelId: "99",
      storeInput: { channel: null },
      code: "CHANNEL_NOT_FOUND",
    },
    {
      configuredChannelId: "36",
      storeInput: { channel: { ...CHANNEL, provider: "ebay" } },
      code: "CHANNEL_PROVIDER_MISMATCH",
    },
    {
      configuredChannelId: "36",
      storeInput: { channel: { ...CHANNEL, status: "paused" } },
      code: "CHANNEL_NOT_ACTIVE",
    },
  ])(
    "rejects invalid or stale explicit channel bindings: $code",
    async ({ configuredChannelId, storeInput, code }) => {
      const result = await resolveRuntimeChannelShipping(
        store(storeInput),
        request({ configuredChannelId }),
      );

      expect(result).toMatchObject({ ok: false, code });
    },
  );
});
