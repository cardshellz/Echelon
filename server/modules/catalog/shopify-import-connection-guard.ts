import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import type { ShopifyCatalogProduct } from "../integrations/shopify";

const ownershipRows = z.array(z.object({
  command_key: z.string().uuid(), remote_product_id: z.string().nullable(), state: z.string(), product_only: z.boolean(),
}));

const channelDomainRows = z.array(z.object({
  shop_domain: z.string().nullable(),
}));

export function normalizeImportShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!trimmed) return "";
  return trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`;
}

export async function assertShopifyImportStoreMatchesDefaultChannel(
  expectedShopDomain: string | null | undefined,
  database: Pick<typeof db, "execute"> = db,
): Promise<void> {
  const normalizedExpected = expectedShopDomain ? normalizeImportShopDomain(expectedShopDomain) : "";
  if (!normalizedExpected || typeof database?.execute !== "function") return;

  const result = await database.execute(sql`
    SELECT conn.shop_domain
    FROM channels.channels ch
    JOIN channels.channel_connections conn ON conn.channel_id = ch.id
    WHERE ch.provider = 'shopify'
    ORDER BY CASE WHEN ch.is_default = 1 THEN 0 ELSE 1 END, ch.id
    LIMIT 1
  `);
  const rows = channelDomainRows.parse(result.rows ?? []);
  const configuredChannelDomain = rows[0]?.shop_domain ? normalizeImportShopDomain(rows[0].shop_domain) : "";
  if (configuredChannelDomain && configuredChannelDomain !== normalizedExpected) {
    throw Object.assign(
      new Error(
        `SHOPIFY_IMPORT_STORE_MISMATCH: Environment SHOPIFY_SHOP_DOMAIN (${normalizedExpected}) does not match default Shopify channel shop_domain (${configuredChannelDomain})`,
      ),
      {
        code: "SHOPIFY_IMPORT_STORE_MISMATCH",
        expectedShopDomain: normalizedExpected,
        channelShopDomain: configuredChannelDomain,
      },
    );
  }
}

/** A full-store importer must not adopt an unfinished native placeholder or
 * manufacture warehouse variants for a deliberately product-only connection.
 * The durable receipt, not the presence of a freely editable tag, is authority.
 */
export async function filterConnectionOwnedShopifyProducts<Row extends Pick<ShopifyCatalogProduct, "shopifyProductId" | "tags">>(
  snapshot: readonly Row[],
  database: Pick<typeof db, "execute"> = db,
  options?: { expectedShopDomain?: string | null },
): Promise<readonly Row[]> {
  if (options?.expectedShopDomain) {
    await assertShopifyImportStoreMatchesDefaultChannel(options.expectedShopDomain, database);
  }
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
