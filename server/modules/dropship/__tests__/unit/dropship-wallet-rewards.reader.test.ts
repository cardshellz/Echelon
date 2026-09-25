import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { loadRewardsPolicyInForceWithClient } from "../../infrastructure/dropship-wallet-rewards.reader";

function clientAnswering(options: { present: boolean; row?: Record<string, unknown> | null }) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
    if (sql.includes("to_regclass")) return { rows: [{ present: options.present ? "dropship.dropship_wallet_policies" : null }] };
    if (sql.includes("FROM dropship.dropship_wallet_policies")) return { rows: options.row ? [options.row] : [] };
    throw new Error(`Unexpected statement: ${sql}`);
  });
  return { statements, client: { query } as unknown as PoolClient };
}

const LAUNCH = { rates: { bankBps: 100, usdcBps: 100, cardBps: 0 }, expiryDays: null };

describe("loadRewardsPolicyInForceWithClient (funding design phase 7)", () => {
  it("reads the three rates and the expiry from the active policy row, bigint-as-string included", async () => {
    const db = clientAnswering({ present: true, row: { rewards_rate_bank_bps: "150", rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0, rewards_expiry_days: "365" } });
    await expect(loadRewardsPolicyInForceWithClient(db.client)).resolves.toEqual({ rates: { bankBps: 150, usdcBps: 100, cardBps: 0 }, expiryDays: 365 });
    expect(db.statements).toEqual(["SELECT to_regclass($1)::text", "SELECT rewards_rate_bank_bps,"]);
    // A stored NULL is "never".
    const never = clientAnswering({ present: true, row: { rewards_rate_bank_bps: 100, rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0, rewards_expiry_days: null } });
    await expect(loadRewardsPolicyInForceWithClient(never.client)).resolves.toEqual(LAUNCH);
  });

  it("falls back to the launch policy (1%, 1%, 0%, never) when the table or its active row is missing", async () => {
    const absent = clientAnswering({ present: false });
    await expect(loadRewardsPolicyInForceWithClient(absent.client)).resolves.toEqual(LAUNCH);
    expect(absent.statements).toEqual(["SELECT to_regclass($1)::text"]);
    const empty = clientAnswering({ present: true, row: null });
    await expect(loadRewardsPolicyInForceWithClient(empty.client)).resolves.toEqual(LAUNCH);
  });

  it("refuses a stored rate outside the ceiling or not a whole number instead of defaulting it", async () => {
    for (const row of [
      { rewards_rate_bank_bps: 1001, rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0, rewards_expiry_days: null },
      { rewards_rate_bank_bps: 100, rewards_rate_usdc_bps: -1, rewards_rate_card_bps: 0, rewards_expiry_days: null },
      { rewards_rate_bank_bps: 100, rewards_rate_usdc_bps: 100, rewards_rate_card_bps: null, rewards_expiry_days: null },
      { rewards_rate_bank_bps: "abc", rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0, rewards_expiry_days: null },
    ]) {
      const db = clientAnswering({ present: true, row });
      await expect(loadRewardsPolicyInForceWithClient(db.client)).rejects.toMatchObject({ code: "DROPSHIP_WALLET_REWARDS_RATE_UNREADABLE" });
    }
  });

  it("refuses a stored expiry that is neither null nor whole days within the bound, rather than reading it as never", async () => {
    for (const value of [0, 3_651, "abc", 1.5]) {
      const db = clientAnswering({ present: true, row: { rewards_rate_bank_bps: 100, rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0, rewards_expiry_days: value } });
      await expect(loadRewardsPolicyInForceWithClient(db.client), String(value)).rejects.toMatchObject({ code: "DROPSHIP_WALLET_REWARDS_EXPIRY_UNREADABLE", context: { classification: "fatal" } });
    }
  });
});
