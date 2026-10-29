import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import type { ShopifyCatalogProduct } from "../integrations/shopify";

const ownershipRows = z.array(z.object({
  command_key: z.string().uuid(), remote_product_id: z.string().nullable(), state: z.string(), product_only: z.boolean(),
}));

/** A full-store importer must not adopt an unfinished native placeholder or
 * manufacture warehouse variants for a deliberately product-only connection.
 * The durable receipt, not the presence of a freely editable tag, is authority.
 */
export async function filterConnectionOwnedShopifyProducts<Row extends Pick<ShopifyCatalogProduct, "shopifyProductId" | "tags">>(
  snapshot: readonly Row[], database: Pick<typeof db, "execute"> = db,
): Promise<readonly Row[]> {
  if (!snapshot.length) return snapshot;
  const result = await database.execute(sql`
    SELECT command.command_key,
      coalesce(command.remote_product_id,command.review_evidence->>'remoteProductId') AS remote_product_id,
      command.state,jsonb_array_length(command.source_snapshot->'variants')=0 AS product_only
    FROM catalog.shopify_product_connection_commands command
    WHERE command.channel_id=(SELECT id FROM channels.channels WHERE provider='shopify'
      ORDER BY CASE WHEN is_default=1 THEN 0 ELSE 1 END,id LIMIT 1)
      AND (command.state NOT IN ('complete','rejected') OR
        (command.state='complete' AND jsonb_array_length(command.source_snapshot->'variants')=0))
  `);
  const owners = ownershipRows.parse(result.rows);
  const blockedIds = new Set(owners.flatMap(owner => owner.remote_product_id ? [owner.remote_product_id] : []));
  const pendingTags = new Set(owners.filter(owner => owner.state !== "complete").map(owner => `echelon-connection-${owner.command_key}`));
  const filtered = snapshot.filter(product => !blockedIds.has(String(product.shopifyProductId))
    && !product.tags?.some(tag => pendingTags.has(tag)));
  if (filtered.length !== snapshot.length) console.info(JSON.stringify({
    code: "SHOPIFY_IMPORT_CONNECTION_OWNERS_PRESERVED", skippedVariants: snapshot.length - filtered.length,
  }));
  return filtered;
}
