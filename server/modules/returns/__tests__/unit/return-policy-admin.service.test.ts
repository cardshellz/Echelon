import { describe, expect, it, vi } from "vitest";
import type { ReturnPolicy } from "@shared/schema";
import type { CustomerReturnLabelSettings } from "@shared/returns/customer-return-label.contract";
import { labelSettings } from "../support/label-fixtures";
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
    expectedPolicyId: null,
    shipping: null,
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
  shipping = new Map<number, CustomerReturnLabelSettings | null>();
  warehouse = { id: 1, name: "Test Warehouse", address: "1 Test Street", city: "Austin", state: "TX", postalCode: "78701", country: "US", isActive: 1 };
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
  async lockCatalog(): Promise<void> {}
  async getShippingWarehouseForShare() { return this.warehouse; }
  async insertPolicyShipping(policyId: number, configuration: CustomerReturnLabelSettings | null) { this.shipping.set(policyId, configuration); }
  async readArchiveSnapshot() {
    const policies = [...this.policies];
    if (this.active && !policies.some(policy => policy.id === this.active!.id)) policies.push(this.active);
    return { policies, historicalReferences: { returnCases: 2, portalIntakes: 1 } };
  }
  async findCommand(key: string): Promise<ReturnPolicyCommandRecord | null> { return this.commands.get(key) ?? null; }
  async getScopeReferences(): Promise<ScopeReferences> { return this.references; }
  async getActivePolicyForUpdate(): Promise<ReturnPolicy | null> { return this.active; }
  async getNextVersion(): Promise<number> { return this.active ? this.active.version + 1 : 1; }
  async retirePolicy(policy: ReturnPolicy, actor: string, now: Date): Promise<void> {
    this.retired.push(policy); this.active = null;
    this.policies = this.policies.map(row => row.id === policy.id ? { ...row, status: "retired", retiredBy: actor, retiredAt: now } : row);
  }
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
  async listShippingWarehouses() { return [this.tx.warehouse]; }
  async getDropshipOmsChannel() { return DROPSHIP_OMS; }
  async searchVendors() { return []; }
  async searchStores() { return []; }
  async transaction<T>(work: (tx: ReturnPolicyAdminTransaction) => Promise<T>): Promise<T> { return work(this.tx); }
}

describe("ReturnPolicyAdminService", () => {
  function shipping() {
    const { version: _version, policyId: _policyId, destinationAddress: _address, ...configuration } = labelSettings;
    return configuration;
  }
  function capability() {
    return { configured: true, carriers: [{ id: "se-123", code: "ups", name: "UPS", services: [{ code: "ups_ground", name: "Ground" }] }] };
  }

  it("atomically associates shipping with the newly created policy identity and freezes its destination", async () => {
    const store = new FakeStore();
    const raw = input({ shipping: shipping() });
    const before = structuredClone(raw);
    const result = await new ReturnPolicyAdminService(store, () => NOW, async () => capability()).createVersion(raw);
    const configuration = store.tx.shipping.get(result.policy.id);
    expect(configuration).toEqual({ ...labelSettings, policyId: result.policy.id, version: result.policy.id });
    expect(store.tx.commands.get(raw.idempotencyKey)?.response).toMatchObject({ shipping: configuration });
    expect(store.tx.audits[0].after).toMatchObject({ shipping: configuration });
    expect(raw).toEqual(before);
  });

  it("records an explicit unconfigured shipping binding instead of borrowing channel defaults", async () => {
    const store = new FakeStore();
    const result = await new ReturnPolicyAdminService(store, () => NOW).createVersion(input());
    expect(store.tx.shipping.has(result.policy.id)).toBe(true);
    expect(store.tx.shipping.get(result.policy.id)).toBeNull();
  });

  it.each([null, 99])("rejects stale policy identity %s before retiring or inserting anything", async expectedPolicyId => {
    const store = new FakeStore(); store.tx.active = policy({ id: 41 });
    await expect(new ReturnPolicyAdminService(store, () => NOW).createVersion(input({ expectedPolicyId }))).rejects.toMatchObject({ code: "RETURN_POLICY_CHANGED", status: 409 });
    expect(store.tx.retired).toEqual([]); expect(store.tx.policies).toEqual([]); expect(store.tx.shipping.size).toBe(0);
  });

  it.each(["vendor", "marketplace"] as const)("rejects incompatible %s physical destination before retirement", async returnDestination => {
    const store = new FakeStore();
    await expect(new ReturnPolicyAdminService(store, () => NOW).createVersion(input({ returnDestination, shipping: { ...shipping(), enabled: false } }))).rejects.toMatchObject({ code: "RETURN_POLICY_SHIPPING_INCOMPATIBLE" });
    expect(store.tx.policies).toEqual([]);
  });

  it.each([{ country: "CA" }, { isActive: 0 }, { address: "" }])("rejects unavailable/incomplete warehouses %#", async override => {
    const store = new FakeStore(); Object.assign(store.tx.warehouse, override);
    await expect(new ReturnPolicyAdminService(store, () => NOW).createVersion(input({ shipping: { ...shipping(), enabled: false } }))).rejects.toMatchObject({ code: "RETURN_POLICY_WAREHOUSE_INVALID" });
    expect(store.tx.policies).toEqual([]);
  });

  it("validates allowed carrier services before enabling and replays success during later outages", async () => {
    const store = new FakeStore();
    const read = vi.fn(async () => capability());
    const service = new ReturnPolicyAdminService(store, () => NOW, read);
    const command = input({ shipping: shipping() });
    const result = await service.createVersion(command);
    read.mockRejectedValueOnce(new Error("provider unavailable"));
    expect(await service.createVersion(command)).toEqual({ ...result, replayed: true });
    expect(read).toHaveBeenCalledTimes(1);
    await expect(service.createVersion({ ...command, idempotencyKey: "different", expectedPolicyId: result.policy.id })).rejects.toMatchObject({ code: "RETURN_POLICY_CARRIER_UNAVAILABLE", status: 503 });
    expect(store.tx.policies).toHaveLength(1);
  });

  it("rejects enabled shipping when a service is no longer available", async () => {
    const store = new FakeStore();
    await expect(new ReturnPolicyAdminService(store, () => NOW, async () => ({ configured: true, carriers: [] })).createVersion(input({ shipping: shipping() }))).rejects.toMatchObject({ code: "RETURN_POLICY_CARRIER_UNAVAILABLE" });
    expect(store.tx.policies).toEqual([]);
  });

  it("returns warehouse choices and a safe diagnostic when the carrier catalog is unavailable", async () => {
    const store = new FakeStore();
    const result = await new ReturnPolicyAdminService(store, () => NOW, async () => { throw new Error("secret credential"); }).shippingCatalog();
    expect(result).toMatchObject({ providerConfigured: false, carriers: [], warehouses: [{ id: 1 }], message: expect.stringMatching(/could not be verified/) });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("returns active and retired versions in the policy overview", async () => {
    const store = new FakeStore();
    store.overviewPolicies.push(
      policy({ id: 42, version: 2 }),
      policy({ id: 41, version: 1, status: "retired", retiredBy: "admin-1", retiredAt: NOW }),
    );

    const result = await new ReturnPolicyAdminService(store, () => NOW).listOverview();

    expect(result.policies.map(({ id }) => id)).toEqual([42, 41]);
  });
  it("maps a sales-channel policy onto the existing channel scope and versions it atomically", async () => {
    const store = new FakeStore();
    store.tx.active = policy({ id: 41, version: 1, supersedesPolicyId: null });

    const result = await new ReturnPolicyAdminService(store, () => NOW).createVersion(input({ expectedPolicyId: 41 }));

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

  it("archives only a reviewed active version, retains history and replays the same command", async () => {
    const store = new FakeStore();
    store.tx.active = policy();
    const service = new ReturnPolicyAdminService(store, () => NOW);
    const preview = await service.previewArchive(1);
    expect(store.tx.retired).toEqual([]);
    expect(preview.effects[0].after).toBeNull();
    const input = { expectedVersion: 1, previewRevision: preview.revision };
    const archived = await service.archive(1, input, "archive-1", "admin-1");
    expect(archived).toMatchObject({ policy: { id: 1, version: 1, status: "retired" }, replayed: false });
    expect(await service.archive(1, input, "archive-1", "admin-1")).toEqual({ ...archived, replayed: true });
    expect(store.tx.retired).toHaveLength(1);
    expect(store.tx.audits).toHaveLength(1);
    await expect(service.archive(1, input, "archive-1", "another-admin")).rejects.toMatchObject({ code: "RETURN_POLICY_IDEMPOTENCY_CONFLICT" });
  });

  it("rejects a stale catalog preview even when the target policy version did not change", async () => {
    const store = new FakeStore(); store.tx.active = policy();
    const service = new ReturnPolicyAdminService(store, () => NOW);
    const preview = await service.previewArchive(1);
    store.tx.policies.push(policy({ id: 2, scopeKind: "global", scopeKey: "global", businessContext: null, channelId: null }));
    await expect(service.archive(1, { expectedVersion: 1, previewRevision: preview.revision }, "archive-2", "admin-1"))
      .rejects.toMatchObject({ code: "RETURN_POLICY_ARCHIVE_CHANGED", status: 409 });
    expect(store.tx.retired).toEqual([]);
    expect(store.tx.commands.size).toBe(0);
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
