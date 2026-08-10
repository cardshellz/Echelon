import { describe, expect, it } from "vitest";
import type { ReturnPolicy } from "@shared/schema";
import {
  ReturnPolicyAdminError,
  ReturnPolicyAdminService,
  type CreateReturnPolicyInput,
  type ReturnPolicyAdminStore,
  type ReturnPolicyAdminTransaction,
  type ReturnPolicyCommandRecord,
} from "../../application/return-policy-admin.service";

const NOW = new Date("2026-08-10T12:00:00.000Z");

function input(overrides: Partial<CreateReturnPolicyInput> = {}): CreateReturnPolicyInput {
  return {
    idempotencyKey: "command-1",
    actor: "admin-1",
    name: "Shopify direct returns",
    scopeKind: "channel_context",
    businessContext: "retail",
    channelId: 36,
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
  references = { channel: { id: 36, name: "Shopify" }, vendor: null, store: null };

  async lockCommand(): Promise<void> {}
  async findCommand(key: string): Promise<ReturnPolicyCommandRecord | null> { return this.commands.get(key) ?? null; }
  async getScopeReferences() { return this.references; }
  async getActivePolicyForUpdate(): Promise<ReturnPolicy | null> { return this.active; }
  async getNextVersion(): Promise<number> { return this.policies.length + (this.active ? 2 : 1); }
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
  constructor(readonly tx = new FakeTransaction()) {}
  async listOverview() { return { policies: [], channels: [], vendors: [], stores: [] }; }
  async listActivePolicies() { return this.tx.active ? [this.tx.active] : []; }
  async transaction<T>(work: (tx: ReturnPolicyAdminTransaction) => Promise<T>): Promise<T> { return work(this.tx); }
}

describe("ReturnPolicyAdminService.createVersion", () => {
  it("atomically retires the prior scope version and records command plus audit", async () => {
    const store = new FakeStore();
    store.tx.active = {
      id: 41,
      name: "Old policy",
      scopeKind: "channel_context",
      scopeKey: "context:retail:channel:36",
      businessContext: "retail",
      channelId: 36,
      vendorId: null,
      storeConnectionId: null,
      version: 1,
      status: "active",
      returnWindowDays: 14,
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
      createdAt: new Date("2026-08-01T00:00:00Z"),
    } as ReturnPolicy;

    const result = await new ReturnPolicyAdminService(store, () => NOW).createVersion(input());

    expect(result.replayed).toBe(false);
    expect(result.policy).toMatchObject({ version: 2, supersedesPolicyId: 41, scopeKey: "context:retail:channel:36" });
    expect(store.tx.retired.map((policy) => policy.id)).toEqual([41]);
    expect(store.tx.commands.has("command-1")).toBe(true);
    expect(store.tx.audits).toEqual([{
      actor: "admin-1",
      before: expect.objectContaining({ id: 41 }),
      after: expect.objectContaining({ id: result.policy.id }),
      now: NOW,
    }]);
  });

  it("replays an identical idempotent command without writing another version", async () => {
    const store = new FakeStore();
    const service = new ReturnPolicyAdminService(store, () => NOW);
    const first = await service.createVersion(input());
    const second = await service.createVersion(input());

    expect(second).toEqual({ policy: first.policy, replayed: true });
    expect(store.tx.policies).toHaveLength(1);
    expect(store.tx.audits).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key for a different command", async () => {
    const store = new FakeStore();
    const service = new ReturnPolicyAdminService(store, () => NOW);
    await service.createVersion(input());

    await expect(service.createVersion(input({ returnWindowDays: 45 }))).rejects.toMatchObject({
      code: "RETURN_POLICY_IDEMPOTENCY_CONFLICT",
      status: 409,
    });
  });

  it("rejects a store that does not belong to the selected vendor", async () => {
    const store = new FakeStore();
    store.tx.references = {
      channel: { id: 67, name: "eBay" },
      vendor: { id: 7, memberId: "member-7" },
      store: { id: 11, vendorId: 8, platform: "ebay" },
    };

    await expect(new ReturnPolicyAdminService(store, () => NOW).createVersion(input({
      scopeKind: "store",
      businessContext: "dropship",
      channelId: 67,
      vendorId: 7,
      storeConnectionId: 11,
    }))).rejects.toBeInstanceOf(ReturnPolicyAdminError);
  });
});
