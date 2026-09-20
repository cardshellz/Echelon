import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  loadAdvancePolicyWithClient,
  loadAdvanceSourcesWithClient,
  relationExistsWithClient,
} from "../../infrastructure/dropship-advance.reader";

interface Call { sql: string; params: unknown[] }

function fakeClient(answer: (sql: string, params: unknown[]) => unknown[]) {
  const calls: Call[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const rows = answer(sql, params);
    return { rows, rowCount: rows.length };
  });
  return { client: { query } as unknown as PoolClient, calls };
}

const ALL_PRESENT = (sql: string, params: unknown[]): unknown[] | null =>
  sql.includes("to_regclass($1)") ? [{ present: String(params[0]) }] : null;

describe("dropship advance reader", () => {
  it("probes a relation by parameter and reads its absence as false", async () => {
    const { client, calls } = fakeClient((sql) => (sql.includes("to_regclass") ? [{ present: null }] : []));
    expect(await relationExistsWithClient(client, "dropship.dropship_wallet_policies")).toBe(false);
    expect(calls[0].params).toEqual(["dropship.dropship_wallet_policies"]);
  });

  it("returns no policy when the policy table is absent, without touching it", async () => {
    const { client, calls } = fakeClient((sql) => (sql.includes("to_regclass") ? [{ present: null }] : []));
    expect(await loadAdvancePolicyWithClient(client, 10)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("resolves the fee and the vendor's cap override over the policy cap", async () => {
    const { client } = fakeClient((sql, params) => {
      const probe = ALL_PRESENT(sql, params);
      if (probe) return probe;
      if (sql.includes("SELECT advance_fee_bps, advance_cap_cents")) return [{ advance_fee_bps: "100", advance_cap_cents: "50000" }];
      if (sql.includes("SELECT advance_cap_override_cents")) {
        expect(params).toEqual([10]);
        return [{ advance_cap_override_cents: "20000" }];
      }
      return [];
    });
    expect(await loadAdvancePolicyWithClient(client, 10)).toEqual({ feeBps: 100, capCents: 20_000, capSource: "vendor_override" });
  });

  it("uses the policy cap when the vendor has no profile, and when the profile table is absent", async () => {
    const noProfile = fakeClient((sql, params) => {
      const probe = ALL_PRESENT(sql, params);
      if (probe) return probe;
      if (sql.includes("SELECT advance_fee_bps")) return [{ advance_fee_bps: 100, advance_cap_cents: 50_000 }];
      return [];
    });
    expect(await loadAdvancePolicyWithClient(noProfile.client, 10)).toEqual({ feeBps: 100, capCents: 50_000, capSource: "policy" });

    const noProfileTable = fakeClient((sql, params) => {
      if (sql.includes("to_regclass($1)")) return [{ present: params[0] === "dropship.dropship_wallet_policies" ? "x" : null }];
      if (sql.includes("SELECT advance_fee_bps")) return [{ advance_fee_bps: 100, advance_cap_cents: 50_000 }];
      throw new Error(`unexpected ${sql}`);
    });
    expect(await loadAdvancePolicyWithClient(noProfileTable.client, 10)).toEqual({ feeBps: 100, capCents: 50_000, capSource: "policy" });
  });

  it("fails closed on a non-integer stored fee or cap", async () => {
    const { client } = fakeClient((sql, params) => {
      const probe = ALL_PRESENT(sql, params);
      if (probe) return probe;
      if (sql.includes("SELECT advance_fee_bps")) return [{ advance_fee_bps: "1.5", advance_cap_cents: 50_000 }];
      return [];
    });
    await expect(loadAdvancePolicyWithClient(client, 10)).rejects.toMatchObject({ code: "DROPSHIP_ADVANCE_INVALID_STORED_VALUE" });
  });

  it("lists each bank account with its pending credit and the three eligibility facts", async () => {
    const { client, calls } = fakeClient((sql, params) => {
      const probe = ALL_PRESENT(sql, params);
      if (probe) return probe;
      if (sql.includes("FROM dropship.dropship_funding_methods m")) {
        return [
          { funding_method_id: 100, metadata: { accountHolderType: "company" }, pending_cents: "40000", prior_pull_settled: true, balance_verified: true },
          { funding_method_id: 101, metadata: { accountHolderType: "individual" }, pending_cents: "0", prior_pull_settled: false, balance_verified: false },
          { funding_method_id: 102, metadata: null, pending_cents: 500, prior_pull_settled: true, balance_verified: false },
        ];
      }
      return [];
    });
    const sources = await loadAdvanceSourcesWithClient(client, { vendorId: 10, walletAccountId: 1 });
    expect(sources).toEqual([
      { fundingMethodId: 100, pendingCents: 40_000, accountHolderType: "company", balanceVerified: true, priorPullSettled: true },
      { fundingMethodId: 101, pendingCents: 0, accountHolderType: "individual", balanceVerified: false, priorPullSettled: false },
      { fundingMethodId: 102, pendingCents: 500, accountHolderType: null, balanceVerified: false, priorPullSettled: true },
    ]);
    const query = calls.find((call) => call.sql.includes("FROM dropship.dropship_funding_methods m"));
    expect(query?.params).toEqual([10, 1, "stripe_ach"]);
    expect(query?.sql).toContain("AND status = 'pending'");
    expect(query?.sql).toContain("AND s.status = 'settled'");
    expect(query?.sql).toContain("v.status = 'succeeded'");
  });

  it("reads every account as unverified while the verification table is absent, without querying it", async () => {
    const { client, calls } = fakeClient((sql, params) => {
      if (sql.includes("to_regclass($1)")) return [{ present: null }];
      if (sql.includes("FROM dropship.dropship_funding_methods m")) {
        expect(sql).not.toContain("dropship_funding_method_balance_verifications");
        return [{ funding_method_id: 100, metadata: { accountHolderType: "company" }, pending_cents: "1", prior_pull_settled: true, balance_verified: false }];
      }
      return [];
    });
    const sources = await loadAdvanceSourcesWithClient(client, { vendorId: 10, walletAccountId: 1 });
    expect(sources[0].balanceVerified).toBe(false);
    expect(calls.map((call) => call.params[0])).toEqual(["dropship.dropship_funding_method_balance_verifications", 10]);
  });
});
