import type { Pool } from "pg";
import { z } from "zod";
import type { OrderEditCredentialStore } from "../application/order-edit-provider";

const credentialSchema = z.object({
  connectionId: z.number().int().positive(),
  channelId: z.number().int().positive(),
  shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
  accessToken: z.string().min(1),
});

export function createOrderEditCredentialStore(
  pool: Pool,
  clock: () => Date,
): OrderEditCredentialStore {
  return {
    async get(connectionId: number) {
      const rows = (
        await pool.query(
          `SELECT cc.id AS "connectionId",cc.channel_id AS "channelId",cc.shop_domain AS "shopDomain",cc.access_token AS "accessToken"
        FROM channels.channel_connections cc JOIN channels.channels c ON c.id=cc.channel_id
        WHERE cc.id=$1 AND c.provider='shopify' AND c.status='active' AND (cc.expires_at IS NULL OR cc.expires_at>$2)`,
          [connectionId, clock()],
        )
      ).rows;
      if (rows.length !== 1) return null;
      return credentialSchema.parse(rows[0]);
    },
  };
}
