import { z } from "zod";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";

/**
 * Which Card Shellz channels sell on a provider account (PR C, PLAN-C v4.1 §5.8, SAF-4): the Card Shellz eBay
 * channels whose stored token (ebay.ebay_oauth_tokens) names this account in this environment, whatever its identity
 * scheme. Marketplace-listings owns the cross-group view of provider accounts (the retirement view reads the same
 * tokens, migration 900000013000018480001 :66-84; archived-listing-member.reader.ts), so Dropship asks here instead of
 * reading channels or eBay tables itself (CLAUDE.md §2). Dropship's own stores are never read: Dropship compares
 * those itself. A token without an account id cannot match (HYPOTHESIS A20: Card Shellz tokens carry one).
 *
 * eBay only, the one provider Dropship ends listings on. Plain reads: no row is locked.
 */
const inputSchema = z.object({
  provider: z.literal("ebay"),
  accountId: z.string().trim().min(1).max(255),
  environment: z.enum(["production", "sandbox"]),
}).strict();
const rowSchema = z.object({ channelId: z.number().int().positive().max(2_147_483_647) });

export interface ProviderAccountDestination {
  destinationKind: "channel_connection";
  channelId: number;
}

export async function readProviderAccountDestinations(client: StockSelectionQueryClient,
  raw: { provider: "ebay"; accountId: string; environment: "production" | "sandbox" }): Promise<ProviderAccountDestination[]> {
  const input = inputSchema.parse(raw);
  const rows = (await client.query(`SELECT DISTINCT t.channel_id AS "channelId"
    FROM ebay.ebay_oauth_tokens t JOIN channels.channels c ON c.id = t.channel_id
    WHERE lower(c.provider) = $1 AND btrim(t.external_account_id) = $2 AND t.environment = $3
    ORDER BY t.channel_id`, [input.provider, input.accountId, input.environment])).rows;
  return z.array(rowSchema).parse(rows).map((row) => ({ destinationKind: "channel_connection", channelId: row.channelId }));
}
