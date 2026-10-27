import { describe, expect, it } from "vitest";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { readProviderAccountDestinations } from "../../listing-member-lifecycle";

/**
 * Which Card Shellz channels sell on a provider account (PR C, PLAN-C v4.1 §5.8, SAF-4; QC2 default a): the Card
 * Shellz eBay channels whose token names the account in the environment, any identity scheme; Dropship's own stores
 * are never read here.
 */
function client(rows: unknown[]): StockSelectionQueryClient & { queries: Array<{ text: string; values: unknown[] }> } {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => { queries.push({ text, values }); return { rows, rowCount: rows.length }; };
  // A recording fake of the pg client: the rows are whatever the case hands it (the reader validates them).
  return { queries, query: query as unknown as StockSelectionQueryClient["query"] };
}

describe("readProviderAccountDestinations", () => {
  it("reads the Card Shellz eBay channel tokens of the account and environment, of any identity scheme", async () => {
    const reader = client([{ channelId: 3 }, { channelId: 7 }]);
    expect(await readProviderAccountDestinations(reader, { provider: "ebay", accountId: " seller-22 ", environment: "production" }))
      .toEqual([{ destinationKind: "channel_connection", channelId: 3 }, { destinationKind: "channel_connection", channelId: 7 }]);
    expect(reader.queries).toHaveLength(1);
    const { text, values } = reader.queries[0]!;
    expect(values).toEqual(["ebay", "seller-22", "production"]);
    expect(text).toContain("FROM ebay.ebay_oauth_tokens t JOIN channels.channels c ON c.id = t.channel_id");
    expect(text).toContain("lower(c.provider) = $1 AND btrim(t.external_account_id) = $2 AND t.environment = $3");
    // Any scheme: the stable-identity column is not a filter; Dropship's tables are never read.
    expect(text).not.toMatch(/identity_scheme|verified_at|dropship\./);
  });

  it("answers no destination for an account no Card Shellz channel uses", async () => {
    expect(await readProviderAccountDestinations(client([]), { provider: "ebay", accountId: "seller-x", environment: "sandbox" })).toEqual([]);
  });

  it("refuses another provider, a blank account and an unknown environment, and a malformed row", async () => {
    await expect(readProviderAccountDestinations(client([]), { provider: "shopify" as "ebay", accountId: "a", environment: "production" })).rejects.toThrow();
    await expect(readProviderAccountDestinations(client([]), { provider: "ebay", accountId: "  ", environment: "production" })).rejects.toThrow();
    await expect(readProviderAccountDestinations(client([]), { provider: "ebay", accountId: "a", environment: "staging" as "sandbox" })).rejects.toThrow();
    await expect(readProviderAccountDestinations(client([{ channelId: "3" }]), { provider: "ebay", accountId: "a", environment: "production" }))
      .rejects.toThrow();
  });
});
