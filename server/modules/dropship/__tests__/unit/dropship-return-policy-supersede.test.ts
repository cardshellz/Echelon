/**
 * Supersede-invariant regression tests (PR1 live-test finding, 2026-08-06):
 * creating a new policy/fee version must deactivate the prior active version
 * at the SAME scope (or same fee_type+fault_category+scope). B1 only
 * superseded global policy rows, leaving multiple active scoped versions.
 *
 * The repository is exercised with a queue-based mock PoolClient; assertions
 * target the ORDER and PARAMS of issued SQL, not a live database.
 */
import { describe, expect, it, vi } from "vitest";
import { PgDropshipReturnPolicyRepository } from "../../infrastructure/dropship-return-policy.repository";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function makeClient(handlers: Array<{ match: string; rows: unknown[] }>) {
  const calls: RecordedQuery[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      const handler = handlers.find((h) => normalized.includes(h.match));
      return { rows: handler ? handler.rows : [], rowCount: handler ? handler.rows.length : 0 };
    }),
    release: vi.fn(),
  };
  return { client, calls };
}

function makePool(client: unknown) {
  return { connect: vi.fn(async () => client) } as never;
}

const NOW = new Date("2026-08-06T18:00:00Z");
const ACTOR = { actorType: "admin" as const, actorId: "test" };

const policyRow = {
  id: 3,
  version: 2,
  return_window_days: 60,
  vendor_id: 1,
  store_connection_id: 1,
  priority: 0,
  is_active: true,
  effective_from: NOW,
  effective_to: null,
  created_at: NOW,
  updated_at: NOW,
};

const feeRow = {
  id: 2,
  version: 2,
  fee_type: "restocking_fee",
  fault_category: "customer",
  amount_type: "flat_cents",
  amount: "500",
  vendor_id: 1,
  store_connection_id: 1,
  priority: 0,
  is_active: true,
  effective_from: NOW,
  effective_to: null,
  created_at: NOW,
  updated_at: NOW,
};

function baseHandlers(returningRow: Record<string, unknown>) {
  return [
    { match: "INSERT INTO dropship.dropship_admin_config_commands", rows: [{ id: 10 }] },
    { match: "COALESCE(MAX(version), 0) + 1", rows: [{ next_version: 2 }] },
    { match: "RETURNING *", rows: [returningRow] },
  ];
}

describe("PgDropshipReturnPolicyRepository supersede invariants", () => {
  it("supersedes the prior active same-scope policy version before inserting the new one", async () => {
    const { client, calls } = makeClient(baseHandlers(policyRow));
    const repo = new PgDropshipReturnPolicyRepository(makePool(client));

    await repo.createPolicyVersion({
      returnWindowDays: 60,
      vendorId: 1,
      storeConnectionId: 1,
      priority: 0,
      effectiveFrom: NOW,
      idempotencyKey: "test-key-policy-1",
      actor: ACTOR,
      now: NOW,
    });

    const supersedeIndex = calls.findIndex(
      (c) => c.sql.includes("UPDATE dropship.dropship_return_policies") && c.sql.includes("is_active = false"),
    );
    const insertIndex = calls.findIndex((c) => c.sql.includes("INSERT INTO dropship.dropship_return_policies"));

    expect(supersedeIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(supersedeIndex);

    const supersede = calls[supersedeIndex]!;
    expect(supersede.sql).toContain("vendor_id IS NOT DISTINCT FROM");
    expect(supersede.sql).toContain("store_connection_id IS NOT DISTINCT FROM");
    expect(supersede.params).toEqual([NOW, 1, 1]);
  });

  it("supersedes the prior active global policy row (all-NULL scope)", async () => {
    const globalRow = { ...policyRow, vendor_id: null, store_connection_id: null };
    const { client, calls } = makeClient(baseHandlers(globalRow));
    const repo = new PgDropshipReturnPolicyRepository(makePool(client));

    await repo.createPolicyVersion({
      returnWindowDays: 45,
      vendorId: null,
      storeConnectionId: null,
      priority: 0,
      effectiveFrom: NOW,
      idempotencyKey: "test-key-policy-2",
      actor: ACTOR,
      now: NOW,
    });

    const supersede = calls.find(
      (c) => c.sql.includes("UPDATE dropship.dropship_return_policies") && c.sql.includes("is_active = false"),
    );
    expect(supersede).toBeDefined();
    expect(supersede!.params).toEqual([NOW, null, null]);
  });

  it("does NOT supersede when the new policy version is future-effective", async () => {
    const future = new Date("2027-01-01T00:00:00Z");
    const { client, calls } = makeClient(baseHandlers(policyRow));
    const repo = new PgDropshipReturnPolicyRepository(makePool(client));

    await repo.createPolicyVersion({
      returnWindowDays: 90,
      vendorId: 1,
      storeConnectionId: 1,
      priority: 0,
      effectiveFrom: future,
      idempotencyKey: "test-key-policy-3",
      actor: ACTOR,
      now: NOW,
    });

    const supersede = calls.find((c) => c.sql.includes("UPDATE dropship.dropship_return_policies"));
    expect(supersede).toBeUndefined();
  });

  it("supersedes the prior active fee version with the same type+category+scope", async () => {
    const { client, calls } = makeClient(baseHandlers(feeRow));
    const repo = new PgDropshipReturnPolicyRepository(makePool(client));

    await repo.createFeeVersion({
      feeType: "restocking_fee",
      faultCategory: "customer",
      amountType: "flat_cents",
      amount: 500,
      vendorId: 1,
      storeConnectionId: 1,
      priority: 0,
      effectiveFrom: NOW,
      idempotencyKey: "test-key-fee-1",
      actor: ACTOR,
      now: NOW,
    });

    const supersedeIndex = calls.findIndex(
      (c) => c.sql.includes("UPDATE dropship.dropship_return_fee_schedule") && c.sql.includes("is_active = false"),
    );
    const insertIndex = calls.findIndex((c) => c.sql.includes("INSERT INTO dropship.dropship_return_fee_schedule"));

    expect(supersedeIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(supersedeIndex);

    const supersede = calls[supersedeIndex]!;
    expect(supersede.sql).toContain("fee_type =");
    expect(supersede.sql).toContain("fault_category =");
    expect(supersede.params).toEqual([NOW, "restocking_fee", "customer", 1, 1]);
  });

  it("retires the explicitly superseded policy row even when the scope key changed", async () => {
    const { client, calls } = makeClient(baseHandlers(policyRow));
    const repo = new PgDropshipReturnPolicyRepository(makePool(client));

    await repo.createPolicyVersion({
      returnWindowDays: 60,
      vendorId: 1,
      storeConnectionId: 1,
      priority: 0,
      effectiveFrom: NOW,
      supersedesPolicyId: 2,
      idempotencyKey: "test-key-policy-edit",
      actor: ACTOR,
      now: NOW,
    });

    const retire = calls.find(
      (c) => c.sql.includes("UPDATE dropship.dropship_return_policies") && c.sql.includes("WHERE id = $2"),
    );
    expect(retire).toBeDefined();
    expect(retire!.params).toEqual([NOW, 2]);
  });

  it("retires the explicitly superseded fee row even when the fault category changed", async () => {
    const { client, calls } = makeClient(baseHandlers(feeRow));
    const repo = new PgDropshipReturnPolicyRepository(makePool(client));

    await repo.createFeeVersion({
      feeType: "restocking_fee",
      faultCategory: "vendor",
      amountType: "flat_cents",
      amount: 500,
      vendorId: null,
      storeConnectionId: null,
      priority: 0,
      effectiveFrom: NOW,
      supersedesFeeId: 1,
      idempotencyKey: "test-key-fee-edit",
      actor: ACTOR,
      now: NOW,
    });

    const retire = calls.find(
      (c) => c.sql.includes("UPDATE dropship.dropship_return_fee_schedule") && c.sql.includes("WHERE id = $2"),
    );
    expect(retire).toBeDefined();
    expect(retire!.params).toEqual([NOW, 1]);
  });
});
