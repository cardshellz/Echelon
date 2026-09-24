import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { loadRewardsRatesInForceWithClient } from "../../infrastructure/dropship-wallet-rewards.reader";

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

describe("loadRewardsRatesInForceWithClient (funding design phase 7)", () => {
  it("reads the three rates from the active policy row, bigint-as-string included", async () => {
    const db = clientAnswering({ present: true, row: { rewards_rate_bank_bps: "150", rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0 } });
    await expect(loadRewardsRatesInForceWithClient(db.client)).resolves.toEqual({ bankBps: 150, usdcBps: 100, cardBps: 0 });
    expect(db.statements).toEqual(["SELECT to_regclass($1)::text", "SELECT rewards_rate_bank_bps,"]);
  });

  it("falls back to the launch rates when the policy table or its active row is missing, without touching the table", async () => {
    const absent = clientAnswering({ present: false });
    await expect(loadRewardsRatesInForceWithClient(absent.client)).resolves.toEqual({ bankBps: 100, usdcBps: 100, cardBps: 0 });
    expect(absent.statements).toEqual(["SELECT to_regclass($1)::text"]);
    const empty = clientAnswering({ present: true, row: null });
    await expect(loadRewardsRatesInForceWithClient(empty.client)).resolves.toEqual({ bankBps: 100, usdcBps: 100, cardBps: 0 });
  });

  it("refuses a stored rate outside the ceiling or not a whole number instead of defaulting it", async () => {
    for (const row of [
      { rewards_rate_bank_bps: 1001, rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0 },
      { rewards_rate_bank_bps: 100, rewards_rate_usdc_bps: -1, rewards_rate_card_bps: 0 },
      { rewards_rate_bank_bps: 100, rewards_rate_usdc_bps: 100, rewards_rate_card_bps: null },
      { rewards_rate_bank_bps: "abc", rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0 },
    ]) {
      const db = clientAnswering({ present: true, row });
      await expect(loadRewardsRatesInForceWithClient(db.client)).rejects.toMatchObject({ code: "DROPSHIP_WALLET_REWARDS_RATE_UNREADABLE" });
    }
  });
});
