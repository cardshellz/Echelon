import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  createDefaultShopifyAdminClient,
  type ShopifyAdminGraphQLClient,
} from "../../shopify/admin-gql-client";
import { readShopifyMerchandiseSnapshot } from "./shopify-merchandise-snapshot";

const MERCHANDISE_API_VERSION = "2026-10";
const MERCHANDISE_REQUEST_TIMEOUT_MS = 15_000;

/** Resolve the shop from the channel; the reader checks the provider's actual shop on every page. */
export async function readChannelShopifyMerchandise(
  db: { execute(statement: SQL): Promise<{ rows: unknown[] }> },
  input: { channelId: number; orderId: string },
  client: ShopifyAdminGraphQLClient = createDefaultShopifyAdminClient({
    apiVersion: MERCHANDISE_API_VERSION,
    timeoutMs: MERCHANDISE_REQUEST_TIMEOUT_MS,
  }),
) {
  z.number().int().positive().safe().parse(input.channelId);
  const result =
    await db.execute(sql`SELECT DISTINCT cc.shop_domain FROM channels.channel_connections cc
    JOIN channels.channels channel ON channel.id=cc.channel_id
    WHERE cc.channel_id=${input.channelId} AND channel.provider='shopify' AND channel.status='active'`);
  const domains = z
    .array(
      z.object({
        shop_domain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
      }),
    )
    .parse(result.rows);
  if (domains.length !== 1)
    throw new Error(
      "Channel merchandise requires one verified originating Shopify shop.",
    );
  return readShopifyMerchandiseSnapshot(client, {
    orderId: input.orderId,
    shopDomain: domains[0].shop_domain,
  });
}
