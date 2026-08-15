import { describe, expect, it } from "vitest";
import type { ReturnPolicy } from "@shared/schema";
import {
  ReturnPolicyAdminError,
  ReturnPolicyAdminService,
  type CreateReturnPolicyInput,
  type ReturnPolicyAdminStore,
  type ReturnPolicyAdminTransaction,
  type ReturnPolicyChannelReference,
  type ReturnPolicyCommandRecord,
  type ScopeReferences,
} from "../../application/return-policy-admin.service";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const SHOPIFY: ReturnPolicyChannelReference = { id: 36, name: "Shopify", type: "internal", provider: "shopify", status: "active" };
const DROPSHIP_OMS: ReturnPolicyChannelReference = { id: 103, name: "Dropship OMS", type: "internal", provider: "manual", status: "active" };

function input(overrides: Partial<CreateReturnPolicyInput> = {}): CreateReturnPolicyInput {
  return {
    idempotencyKey: "command-1",
    actor: "admin-1",
    name: "Shopify returns",
    appliesTo: "channel",
    channelId: SHOPIFY.id,
    vendorId: null,
    storeConnectionId: null,
    returnWindowDays: 30,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "customer",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
    notes: null,
    ...overrides,
  };
}

class FakeTransaction implements ReturnPolicyAdminTransaction {
  commands = new Map<string, ReturnPolicyCommandRecord>();
  active: ReturnPolicy | null = null;
  policies: ReturnPolicy[] = [];
  retired: ReturnPolicy[] = [];
  audits: Array<{ before: ReturnPolicy | null; after: ReturnPolicy }> = [];
  references: ScopeReferences = {
    channel: SHOPIFY,
    vendor: null,
    store: null,
    dropshipOmsChannel: DROPSHIP_OMS,
  };

  async lockCommand(): Promise<void> {}
  async findCommand(key: string): Promise<ReturnPolicyCommandRecord | null> { return this.commands.get(key) ?? null; }
  async getScopeReferences(): Promise<ScopeReferences> { return this.references; }
  async getActivePolicyForUpdate(): Promise<ReturnPolicy | null> { return this.active; }
  async getNextVersion(): Promise<number> { return this.active ? this.active.version + 1 : 1; }
  async retirePolicy(policy: ReturnPolicy): Promise<void> { this.retired.push(policy); this.active = null; }
  async insertPolicy(value: Omit<ReturnPolicy, "id" | "createdAt">): Promise<ReturnPolicy> {
    const policy = { ...value, id: 100 + this.policies.length, createdAt: NOW } as ReturnPolicy;
    this.policies.push(policy);
    this.active = policy;
    return policy;
  }
  async recordCommand(command: { idempotencyKey: string; requestHash: string; response: ReturnPolicy }): Promise<void> {
    this.commands.set(command.idempotencyKey, { requestHash: command.requestHash, response: command.response });
  }
  async writeAudit(value: { before: ReturnPolicy | null; after: ReturnPolicy }): Promise<void> { this.audits.push(value); }
}

class FakeStore implements ReturnPolicyAdminStore {
  readonly overviewPolicies: ReturnPolicy[] = [];
  constructor(readonly tx = new FakeTransaction()) {}
  async listOverview() {
    return { policies: this.overviewPolicies, channels: [SHOPIFY, DROPSHIP_OMS], referencedVendors: [], referencedStores: [], dropshipOmsChannelId: DROPSHIP_OMS.id };
  }
  async listActivePolicies() { return this.tx.active ? [this.tx.active] : []; }
  async getDropshipOmsChannel() { return DROPSHIP_OMS; }
  async searchVendors() { return []; }
  async searchStores() { return []; }
  async transaction<T>(work: (tx: ReturnPolicyAdminTransaction) => Promise<T>): Promise<T> { return work(this.tx); }
}

describe("ReturnPolicyAdminService", () => {
  it("excludes retired versions from the active policy overview", async () => {
    const store = new FakeStore();
    store.overviewPolicies.push(
      policy({ id: 42, version: 2 }),
      policy({ id: 41, version: 1, status: "retired", retiredBy: "admin-1", retiredAt: NOW }),
    );

    const result = await new ReturnPolicyAdminService(store, () => NOW).listOverview();

    expect(result.policies.map(({ id }) => id)).toEqual([42]);
  });
  it("maps a sales-channel policy onto the existing channel scope and versions it atomically", async () => {
    const store = new FakeStore();
    store.tx.active = policy({ id: 41, version: 1, supersedesPolicyId: null });

    const result = await new ReturnPolicyAdminService(store, () => NOW).createVersion(input());

    expect(result.replayed).toBe(false);
    expect(result.policy).toMatchObject({
      scopeKind: "channel_context",
      scopeKey: "context:retail:channel:36",
      businessContext: "retail",
      channelId: 36,
      version: 2,
      supersedesPolicyId: 41,
    });
    expect(store.tx.retired.map(({ id }) => id)).toEqual([41]);
    expect(store.tx.commands.has("command-1")).toBe(true);
    expect(store.tx.audits).toHaveLength(1);
  });

  it("maps a vendor policy without inventing a marketplace channel", async () => {
    const store = new FakeStore();
    store.tx.references = {
      channel: null,
      vendor: { id: 7, memberId: "member-7", businessName: "Vendor Seven", email: "seven@example.com", status: "active" },
      store: null,
      dropshipOmsChannel: DROPSHIP_OMS,
    };

    const result = await new ReturnPolicyAdminService(store, () => NOW).createVersion(input({
      appliesTo: "vendor",
      channelId: null,
      vendorId: 7,
    }));

    expect(result.policy).toMatchObject({
      scopeKind: "vendor_context",
      scopeKey: "context:dropship:vendor:7",
      businessContext: "dropship",
      channelId: null,
      vendorId: 7,
    });
  });

  it("maps a store policy to the canonical Dropship OMS channel", async () => {
    const store = new FakeStore();
    store.tx.references = {
      channel: null,
      vendor: { id: 7, memberId: "member-7", businessName: "Vendor Seven", email: "seven@example.com", status: "active" },
      store: { id: 11, vendorId: 7, platform: "ebay", displayName: "Seven eBay", shopDomain: null, status: "connected" },
      dropshipOmsChannel: DROPSHIP_OMS,
    };

    const result = await new ReturnPolicyAdminService(store, () => NOW).createVersion(input({
      appliesTo: "store",
      channelId: null,
      vendorId: 7,
      storeConnectionId: 11,
    }));

    expect(result.policy).toMatchObject({
      scopeKind: "store",
      scopeKey: "context:dropship:vendor:7:channel:103:store:11",
      channelId: 103,
      vendorId: 7,
      storeConnectionId: 11,
    });
  });

  it("rejects a store owned by a different vendor", async () => {
    const store = new FakeStore();
    store.tx.references = {
      channel: null,
      vendor: { id: 7, memberId: "member-7", businessName: null, email: null, status: "active" },
      store: { id: 11, vendorId: 8, platform: "ebay", displayName: null, shopDomain: null, status: "connected" },
      dropshipOmsChannel: DROPSHIP_OMS,
    };

    await expect(new ReturnPolicyAdminService(store, () => NOW).createVersion(input({
      appliesTo: "store",
      channelId: null,
      vendorId: 7,
      storeConnectionId: 11,
    }))).rejects.toMatchObject({ code: "RETURN_POLICY_SCOPE_MISMATCH", status: 400 });
  });

  it("replays an identical command and rejects conflicting reuse", async () => {
    const store = new FakeStore();
    const service = new ReturnPolicyAdminService(store, () => NOW);
    const first = await service.createVersion(input());
    const replay = await service.createVersion(input());

    expect(replay).toEqual({ policy: first.policy, replayed: true });
    await expect(service.createVersion(input({ returnWindowDays: 45 }))).rejects.toBeInstanceOf(ReturnPolicyAdminError);
    expect(store.tx.policies).toHaveLength(1);
  });
});

function policy(overrides: Partial<ReturnPolicy> = {}): ReturnPolicy {
  return {
    id: 1,
    name: "Existing Shopify returns",
    scopeKind: "channel_context",
    scopeKey: "context:retail:channel:36",
    businessContext: "retail",
    channelId: 36,
    vendorId: null,
    storeConnectionId: null,
    version: 1,
    status: "active",
    returnWindowDays: 30,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "customer",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
    notes: null,
    supersedesPolicyId: null,
    createdBy: "admin-0",
    retiredBy: null,
    retiredAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as ReturnPolicy;
}
