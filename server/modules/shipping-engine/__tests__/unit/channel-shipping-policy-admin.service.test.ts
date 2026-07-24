import { describe, expect, it } from "vitest";
import type {
  ShippingChannelPolicyPurpose,
  ShippingChannelPolicyView,
  ShippingDestinationScopeMember,
  ShippingDestinationScopeSummary,
} from "@shared/types/shipping-channel-routing";
import type { AuditLogPayload } from "../../../../infrastructure/auditLogger";
import {
  ChannelShippingPolicyAdminService,
  type ChannelShippingPolicyAdminStore,
  type ChannelShippingPolicyStoreOverview,
  type ChannelShippingPolicyAdminTransaction,
  type PreparedPolicyRoute,
} from "../../application/channel-shipping-policy-admin.service";

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("ChannelShippingPolicyAdminService", () => {
  it("creates an explicit disabled catch-all for a new routing slot", async () => {
    const store = new FakeStore();
    const service = createService(store);

    const created = await service.createPolicyDraft({
      channelId: 36,
      purpose: "customer_checkout",
      cloneActive: true,
      notes: null,
    }, "operator-1");

    expect(created).toMatchObject({
      channelId: 36,
      purpose: "customer_checkout",
      version: 1,
      status: "draft",
      lockVersion: 1,
      activationErrors: [],
    });
    expect(created.routes).toEqual([
      expect.objectContaining({
        originWarehouseId: null,
        destinationScopeId: null,
        destinationMembers: [],
        mode: "disabled",
        eligibilityMode: "none",
        rateBookId: null,
      }),
    ]);
    expect(store.audits).toEqual([
      expect.objectContaining({
        action: "shipping.channel_policy.draft_created",
        actor: "operator-1",
      }),
    ]);
  });

  it("projects immutable adapter capabilities into the routing overview", async () => {
    const store = new FakeStore();
    const service = createService(store);

    const overview = await service.listOverview();

    expect(overview.channels[0]).toMatchObject({
      id: 36,
      provider: "shopify",
      shippingCapabilities: {
        acceptsEngineQuotes: true,
        managesOwnRates: true,
        enforcesDestinationEligibility: true,
      },
    });
  });

  it("clones the active revision into a new draft without sharing route state", async () => {
    const store = new FakeStore();
    const active = activePolicy();
    active.notes = "Current routing";
    store.policies.set(100, active);
    const service = createService(store);

    const draft = await service.createPolicyDraft({
      channelId: 36,
      purpose: "customer_checkout",
      cloneActive: true,
      notes: null,
    }, "operator-1");

    expect(draft.version).toBe(2);
    expect(draft.notes).toBe("Current routing");
    expect(draft.routes).toEqual([
      expect.objectContaining({
        destinationScopeId: 10,
        destinationMembers: [{
          country: "US",
          region: "PA",
          postalPrefix: null,
        }],
        rateBookId: 10,
      }),
      expect.objectContaining({
        destinationScopeId: null,
        mode: "disabled",
      }),
    ]);

    draft.routes[0].destinationMembers[0].region = "OH";
    expect(store.policies.get(100)?.routes[0].destinationMembers[0].region)
      .toBe("PA");
  });

  it("rejects a stale draft save before replacing route state", async () => {
    const store = new FakeStore();
    const draft = draftPolicy();
    draft.lockVersion = 3;
    store.policies.set(draft.id, draft);
    const service = createService(store);

    await expect(service.savePolicyDraft({
      policyId: draft.id,
      expectedLockVersion: 2,
      notes: null,
      routes: draft.routes.map(routeInput),
    }, "operator-1")).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_CHANNEL_POLICY_CHANGED",
    });
    expect(store.replaceRouteCalls).toBe(0);
  });

  it("refuses activation when an engine route has no live rate table", async () => {
    const store = new FakeStore();
    const draft = draftPolicy();
    draft.routes[0].activeRateTableCount = 0;
    store.policies.set(draft.id, draft);
    const service = createService(store);

    await expect(service.activatePolicyDraft({
      policyId: draft.id,
      expectedLockVersion: draft.lockVersion,
    }, "operator-1")).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_CHANNEL_POLICY_NOT_READY",
      details: [
        expect.stringContaining("has no live rates"),
      ],
    });
  });

  it("refuses activation when a warehouse-scoped route references an inactive warehouse", async () => {
    const store = new FakeStore();
    const draft = draftPolicy();
    draft.routes[0].originWarehouseId = 7;
    draft.routes[0].originWarehouseName = "Retired warehouse";
    draft.routes[0].originWarehouseActive = false;
    store.policies.set(draft.id, draft);
    const service = createService(store);

    await expect(service.activatePolicyDraft({
      policyId: draft.id,
      expectedLockVersion: draft.lockVersion,
    }, "operator-1")).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_CHANNEL_POLICY_NOT_READY",
      details: [
        expect.stringContaining("Retired warehouse"),
      ],
    });
  });

  it("refuses an engine quote route when the provider cannot accept it", async () => {
    const store = new FakeStore();
    store.channel.provider = "ebay";
    const draft = draftPolicy();
    store.policies.set(draft.id, draft);
    const service = createService(store);

    await expect(service.activatePolicyDraft({
      policyId: draft.id,
      expectedLockVersion: draft.lockVersion,
    }, "operator-1")).rejects.toMatchObject({
      status: 409,
      code: "SHIPPING_CHANNEL_POLICY_NOT_READY",
      details: [
        expect.stringContaining("cannot accept Echelon rate quotes"),
      ],
    });
  });

  it("refuses channel-managed rates when the provider has no channel checkout", async () => {
    const store = new FakeStore();
    store.channel.provider = "manual";
    const draft = draftPolicy();
    draft.routes[0] = {
      ...draft.routes[0],
      mode: "channel_managed",
      eligibilityMode: "channel",
      rateBookId: null,
      rateBookName: null,
      rateBookStatus: null,
      activeRateTableCount: 0,
    };
    store.policies.set(draft.id, draft);
    const service = createService(store);

    await expect(service.activatePolicyDraft({
      policyId: draft.id,
      expectedLockVersion: draft.lockVersion,
    }, "operator-1")).rejects.toMatchObject({
      details: expect.arrayContaining([
        expect.stringContaining("cannot manage checkout rates"),
        expect.stringContaining("cannot enforce the selected destination"),
      ]),
    });
  });

  it("allows an explicit disabled policy for an unregistered provider", async () => {
    const store = new FakeStore();
    store.channel.provider = "amazon";
    const draft = draftPolicy();
    draft.routes = [draft.routes[1]];
    store.policies.set(draft.id, draft);
    const service = createService(store);

    const activated = await service.activatePolicyDraft({
      policyId: draft.id,
      expectedLockVersion: draft.lockVersion,
    }, "operator-1");

    expect(activated.status).toBe("active");
    expect(activated.activationErrors).toEqual([]);
  });

  it("retires the previous active policy and activates the draft in one command", async () => {
    const store = new FakeStore();
    const previous = activePolicy();
    const draft = draftPolicy();
    store.policies.set(previous.id, previous);
    store.policies.set(draft.id, draft);
    const service = createService(store);

    const activated = await service.activatePolicyDraft({
      policyId: draft.id,
      expectedLockVersion: draft.lockVersion,
    }, "operator-2");

    expect(activated.status).toBe("active");
    expect(activated.activatedBy).toBe("operator-2");
    expect(store.policies.get(previous.id)?.status).toBe("retired");
    expect(store.audits.at(-1)).toMatchObject({
      action: "shipping.channel_policy.activated",
      context: {
        supersededPolicyId: previous.id,
      },
    });
  });

  it("discards a draft as an audited retired revision", async () => {
    const store = new FakeStore();
    const draft = draftPolicy();
    store.policies.set(draft.id, draft);
    const service = createService(store);

    const discarded = await service.discardPolicyDraft({
      policyId: draft.id,
      expectedLockVersion: draft.lockVersion,
    }, "operator-3");

    expect(discarded).toMatchObject({
      status: "retired",
      activatedBy: null,
      activatedAt: null,
      retiredAt: NOW.toISOString(),
      lockVersion: 2,
    });
    expect(store.audits.at(-1)).toMatchObject({
      actor: "operator-3",
      action: "shipping.channel_policy.draft_discarded",
    });
  });

  it("normalizes and deduplicates delivery-region data at the boundary", async () => {
    const store = new FakeStore();
    const service = createService(store);

    const scope = await service.createDestinationScope({
      code: "  lower-48 ",
      name: " Lower 48 ",
      members: [{
        country: "us",
        region: "pa",
        postalPrefix: " 160 ",
      }],
    }, "operator-1");

    expect(scope).toMatchObject({
      code: "lower-48",
      name: "Lower 48",
      status: "active",
      members: [{
        country: "US",
        region: "PA",
        postalPrefix: "160",
      }],
    });

    const formattedPostalScope = await service.createDestinationScope({
      code: "ottawa",
      name: "Ottawa",
      members: [{
        country: "ca",
        region: "on",
        postalPrefix: " K1A-0 ",
      }],
    }, "operator-1");

    expect(formattedPostalScope.members).toEqual([{
      country: "CA",
      region: "ON",
      postalPrefix: "K1A0",
    }]);

    await expect(service.createDestinationScope({
      code: "duplicates",
      name: "Duplicates",
      members: [
        { country: "US", region: "PA", postalPrefix: null },
        { country: "us", region: "pa", postalPrefix: null },
      ],
    }, "operator-1")).rejects.toMatchObject({
      status: 400,
      code: "SHIPPING_CHANNEL_POLICY_INVALID_INPUT",
    });
  });

  it("records a durable shadow mismatch against the explicit legacy profile", async () => {
    const store = new FakeStore();
    store.policies.set(100, activePolicy());
    store.legacyRateBookId = 99;
    const service = createService(store);

    const comparison = await service.comparePolicyToLegacy({
      policyId: 100,
      originWarehouseId: 1,
      destination: {
        country: "US",
        region: "PA",
        postalCode: "16066",
      },
      legacyProfile: "shopify",
      actor: "operator-1",
    });

    expect(comparison).toMatchObject({
      matchesLegacy: false,
      differences: ["Pricing program differs: 10 vs 99."],
      snapshotId: 1,
    });
    expect(store.shadowWrites).toHaveLength(1);
  });
});

function createService(store: FakeStore) {
  return new ChannelShippingPolicyAdminService(
    store,
    {
      resolve: (provider) => {
        if (provider === "shopify") {
          return {
            acceptsEngineQuotes: true,
            managesOwnRates: true,
            enforcesDestinationEligibility: true,
          };
        }
        if (provider === "ebay") {
          return {
            acceptsEngineQuotes: false,
            managesOwnRates: true,
            enforcesDestinationEligibility: true,
          };
        }
        if (provider === "manual") {
          return {
            acceptsEngineQuotes: true,
            managesOwnRates: false,
            enforcesDestinationEligibility: false,
          };
        }
        return null;
      },
    },
    { now: () => NOW },
  );
}

class FakeStore
implements ChannelShippingPolicyAdminStore, ChannelShippingPolicyAdminTransaction {
  channel = { id: 36, name: "Shopify", provider: "shopify" };
  policies = new Map<number, ShippingChannelPolicyView>();
  scopes = new Map<number, ShippingDestinationScopeSummary>();
  audits: AuditLogPayload[] = [];
  shadowWrites: unknown[] = [];
  legacyRateBookId = 10;
  replaceRouteCalls = 0;
  private nextPolicyId = 200;
  private nextScopeId = 20;
  private nextRouteId = 500;

  async listOverview(): Promise<ChannelShippingPolicyStoreOverview> {
    return {
      channels: [{
        ...this.channel,
        status: "active",
        customerCheckout: { active: null, draft: null },
        vendorFulfillmentCharge: { active: null, draft: null },
      }],
      destinationScopes: [...this.scopes.values()].map(cloneScope),
      rateBooks: [],
      warehouses: [],
    };
  }

  async getChannel(channelId: number) {
    return channelId === this.channel.id ? { ...this.channel } : null;
  }

  async getPolicy(policyId: number) {
    const policy = this.policies.get(policyId);
    return policy ? clonePolicy(policy) : null;
  }

  async transaction<T>(
    work: (tx: ChannelShippingPolicyAdminTransaction) => Promise<T>,
  ): Promise<T> {
    return work(this);
  }

  async resolveLegacyRateBook() {
    return { ok: true as const, rateBookId: this.legacyRateBookId };
  }

  async persistShadowComparison(input: unknown): Promise<number> {
    this.shadowWrites.push(input);
    return this.shadowWrites.length;
  }

  async getChannelForUpdate(channelId: number) {
    return channelId === this.channel.id ? { ...this.channel } : null;
  }

  async getPolicyForUpdate(policyId: number) {
    return this.getPolicy(policyId);
  }

  async findDraftPolicy(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ) {
    return this.findPolicy(channelId, purpose, "draft");
  }

  async findActivePolicy(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ) {
    return this.findPolicy(channelId, purpose, "active");
  }

  async nextPolicyVersion(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ) {
    return Math.max(
      0,
      ...[...this.policies.values()]
        .filter((policy) =>
          policy.channelId === channelId && policy.purpose === purpose)
        .map((policy) => policy.version),
    ) + 1;
  }

  async insertPolicyDraft(input: {
    channelId: number;
    purpose: ShippingChannelPolicyPurpose;
    version: number;
    notes: string | null;
    actor: string;
    now: Date;
  }) {
    const id = this.nextPolicyId++;
    this.policies.set(id, {
      id,
      channelId: input.channelId,
      purpose: input.purpose,
      version: input.version,
      status: "draft",
      lockVersion: 1,
      notes: input.notes,
      createdBy: input.actor,
      activatedBy: null,
      activatedAt: null,
      retiredAt: null,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
      routes: [],
      activationErrors: [],
    });
    return id;
  }

  async replacePolicyRoutes(
    policyId: number,
    routes: readonly PreparedPolicyRoute[],
    now: Date,
  ) {
    this.replaceRouteCalls += 1;
    const policy = this.requiredPolicy(policyId);
    policy.routes = routes.map((route) => ({
      id: this.nextRouteId++,
      originWarehouseId: route.originWarehouseId,
      originWarehouseName: route.originWarehouseId === null
        ? null
        : `Warehouse ${route.originWarehouseId}`,
      originWarehouseActive: route.originWarehouseId === null ? null : true,
      destinationScopeId: route.destinationScopeId,
      destinationScopeName: route.destinationScopeId === null
        ? null
        : this.scopes.get(route.destinationScopeId)?.name ?? "Region",
      destinationScopeStatus: route.destinationScopeId === null ? null : "active",
      destinationMembers: route.destinationMembers.map((member) => ({ ...member })),
      mode: route.mode,
      eligibilityMode: route.eligibilityMode,
      rateBookId: route.rateBookId,
      rateBookName: route.rateBookId === null ? null : `Program ${route.rateBookId}`,
      rateBookStatus: route.rateBookId === null ? null : "active",
      activeRateTableCount: route.rateBookId === null ? 0 : 1,
    }));
    policy.updatedAt = now.toISOString();
  }

  async updatePolicyDraft(input: {
    policyId: number;
    expectedLockVersion: number;
    notes: string | null;
    now: Date;
  }) {
    const policy = this.requiredPolicy(input.policyId);
    if (
      policy.status !== "draft"
      || policy.lockVersion !== input.expectedLockVersion
    ) {
      return false;
    }
    policy.notes = input.notes;
    policy.lockVersion += 1;
    policy.updatedAt = input.now.toISOString();
    return true;
  }

  async activatePolicy(input: {
    policyId: number;
    expectedLockVersion: number;
    actor: string;
    now: Date;
  }) {
    const policy = this.requiredPolicy(input.policyId);
    if (
      policy.status !== "draft"
      || policy.lockVersion !== input.expectedLockVersion
    ) {
      return false;
    }
    policy.status = "active";
    policy.activatedBy = input.actor;
    policy.activatedAt = input.now.toISOString();
    policy.lockVersion += 1;
    policy.updatedAt = input.now.toISOString();
    return true;
  }

  async retirePolicy(input: {
    policyId: number;
    expectedLockVersion: number;
    now: Date;
  }) {
    const policy = this.requiredPolicy(input.policyId);
    if (
      policy.status !== "active"
      || policy.lockVersion !== input.expectedLockVersion
    ) {
      return false;
    }
    policy.status = "retired";
    policy.retiredAt = input.now.toISOString();
    policy.lockVersion += 1;
    policy.updatedAt = input.now.toISOString();
    return true;
  }

  async discardPolicyDraft(input: {
    policyId: number;
    expectedLockVersion: number;
    now: Date;
  }) {
    const policy = this.requiredPolicy(input.policyId);
    if (
      policy.status !== "draft"
      || policy.lockVersion !== input.expectedLockVersion
    ) {
      return false;
    }
    policy.status = "retired";
    policy.retiredAt = input.now.toISOString();
    policy.lockVersion += 1;
    policy.updatedAt = input.now.toISOString();
    return true;
  }

  async getDestinationScopesByIds(ids: readonly number[]) {
    return ids.flatMap((id) => {
      const scope = this.scopes.get(id);
      return scope ? [cloneScope(scope)] : [];
    });
  }

  async getRateBooksByIds(ids: readonly number[]) {
    return ids.map((id) => ({
      id,
      name: `Program ${id}`,
      status: "active",
      activeRateTableCount: 1,
    }));
  }

  async getWarehousesByIds(ids: readonly number[]) {
    return ids.map((id) => ({
      id,
      name: `Warehouse ${id}`,
      isActive: true,
    }));
  }

  async insertDestinationScope(input: {
    code: string;
    name: string;
    members: ShippingDestinationScopeMember[];
    now: Date;
  }) {
    const id = this.nextScopeId++;
    this.scopes.set(id, {
      id,
      code: input.code,
      name: input.name,
      status: "active",
      lockVersion: 1,
      members: input.members.map((member) => ({ ...member })),
      updatedAt: input.now.toISOString(),
    });
    return id;
  }

  async getDestinationScopeForUpdate(scopeId: number) {
    const scope = this.scopes.get(scopeId);
    return scope ? cloneScope(scope) : null;
  }

  async updateDestinationScope(input: {
    scopeId: number;
    expectedLockVersion: number;
    code: string;
    name: string;
    members: ShippingDestinationScopeMember[];
    now: Date;
  }) {
    const scope = this.scopes.get(input.scopeId);
    if (
      !scope
      || scope.status === "retired"
      || scope.lockVersion !== input.expectedLockVersion
    ) {
      return false;
    }
    scope.code = input.code;
    scope.name = input.name;
    scope.members = input.members.map((member) => ({ ...member }));
    scope.lockVersion += 1;
    scope.updatedAt = input.now.toISOString();
    return true;
  }

  async retireDestinationScope(input: {
    scopeId: number;
    expectedLockVersion: number;
    now: Date;
  }) {
    const scope = this.scopes.get(input.scopeId);
    if (
      !scope
      || scope.status === "retired"
      || scope.lockVersion !== input.expectedLockVersion
    ) {
      return false;
    }
    scope.status = "retired";
    scope.lockVersion += 1;
    scope.updatedAt = input.now.toISOString();
    return true;
  }

  async persistAudit(payload: AuditLogPayload) {
    this.audits.push(payload);
  }

  private async findPolicy(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
    status: "draft" | "active",
  ) {
    const policy = [...this.policies.values()].find((candidate) =>
      candidate.channelId === channelId
      && candidate.purpose === purpose
      && candidate.status === status);
    return policy ? clonePolicy(policy) : null;
  }

  private requiredPolicy(policyId: number): ShippingChannelPolicyView {
    const policy = this.policies.get(policyId);
    if (!policy) throw new Error(`Policy ${policyId} not found.`);
    return policy;
  }
}

function draftPolicy(): ShippingChannelPolicyView {
  const active = activePolicy();
  return {
    ...active,
    id: 101,
    version: 2,
    status: "draft",
    lockVersion: 1,
    activatedBy: null,
    activatedAt: null,
  };
}

function activePolicy(): ShippingChannelPolicyView {
  return {
    id: 100,
    channelId: 36,
    purpose: "customer_checkout",
    version: 1,
    status: "active",
    lockVersion: 1,
    notes: null,
    createdBy: "operator-0",
    activatedBy: "operator-0",
    activatedAt: "2026-07-23T12:00:00.000Z",
    retiredAt: null,
    createdAt: "2026-07-23T12:00:00.000Z",
    updatedAt: "2026-07-23T12:00:00.000Z",
    routes: [
      {
        id: 1,
        originWarehouseId: null,
        originWarehouseName: null,
        originWarehouseActive: null,
        destinationScopeId: 10,
        destinationScopeName: "Pennsylvania",
        destinationScopeStatus: "active",
        destinationMembers: [{
          country: "US",
          region: "PA",
          postalPrefix: null,
        }],
        mode: "engine_quoted",
        eligibilityMode: "engine",
        rateBookId: 10,
        rateBookName: "Retail",
        rateBookStatus: "active",
        activeRateTableCount: 1,
      },
      {
        id: 2,
        originWarehouseId: null,
        originWarehouseName: null,
        originWarehouseActive: null,
        destinationScopeId: null,
        destinationScopeName: null,
        destinationScopeStatus: null,
        destinationMembers: [],
        mode: "disabled",
        eligibilityMode: "none",
        rateBookId: null,
        rateBookName: null,
        rateBookStatus: null,
        activeRateTableCount: 0,
      },
    ],
    activationErrors: [],
  };
}

function routeInput(
  route: ShippingChannelPolicyView["routes"][number],
) {
  return {
    originWarehouseId: route.originWarehouseId,
    destinationScopeId: route.destinationScopeId,
    mode: route.mode,
    eligibilityMode: route.eligibilityMode,
    rateBookId: route.rateBookId,
  };
}

function clonePolicy(policy: ShippingChannelPolicyView): ShippingChannelPolicyView {
  return {
    ...policy,
    routes: policy.routes.map((route) => ({
      ...route,
      destinationMembers: route.destinationMembers.map((member) => ({ ...member })),
    })),
    activationErrors: [...policy.activationErrors],
  };
}

function cloneScope(
  scope: ShippingDestinationScopeSummary,
): ShippingDestinationScopeSummary {
  return {
    ...scope,
    members: scope.members.map((member) => ({ ...member })),
  };
}
