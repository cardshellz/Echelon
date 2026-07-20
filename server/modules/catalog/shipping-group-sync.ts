/**
 * Pushes a product's shipping group to Shopify as the `cardshellz.shipping_group`
 * product metafield, so the storefront checkout Function (in shellz-club-functions)
 * can bucket cart lines by shipping group for per-group free-shipping thresholds.
 *
 * HOW: Echelon and shellz-club-app share one Postgres database. The club app owns
 * a durable metafield outbox (membership.shopify_metafield_outbox) drained by its
 * worker, which calls the Shopify Admin API. We enqueue directly into that outbox
 * so a shipping-group change propagates to Shopify on the club app's next worker
 * tick (~1 min) — i.e. effectively instantly, with no new cross-service API.
 *
 * CONTRACT: the row shape + dedupe-key format MUST match
 * shellz-club-app/server/sync/outbox.ts (enqueueMetafieldWrite). Keep in sync.
 * The metafield type `cardshellz.shipping_group` must be registered in the club
 * app's server/sync/metafield-registry.ts, or its worker terminal-fails the rows.
 *
 * Best-effort: failures are logged, never thrown into the caller's request path.
 * The one-time/periodic backfill (scripts/backfill-shipping-group-metafields.ts)
 * is the safety net for anything missed (e.g. a product synced to Shopify later).
 */
import { db } from "../../db";
import { products, shippingGroups } from "@shared/schema";
import { eq, inArray, sql, type SQL } from "drizzle-orm";

const NAMESPACE = "cardshellz";
const KEY = "shipping_group";

function toProductGid(shopifyProductId: string): string {
  return shopifyProductId.startsWith("gid://")
    ? shopifyProductId
    : `gid://shopify/Product/${shopifyProductId}`;
}

interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

export interface ShippingGroupMetafieldWrite {
  shopifyProductId: string;
  shippingGroupCode: string | null;
}

/**
 * Transaction-compatible primitive used by mapping repair. Unlike the public
 * best-effort wrapper, this throws so the catalog identity, audit event, and
 * outbox command either commit together or roll back together.
 */
export async function enqueueShippingGroupMetafieldWrite(
  executor: SqlExecutor,
  input: ShippingGroupMetafieldWrite,
): Promise<void> {
  const gid = toProductGid(input.shopifyProductId);
  const dedupeKey = `product:${gid}:${NAMESPACE}:${KEY}`;
  const operation = input.shippingGroupCode === null ? "delete" : "set";
  const valueJson = input.shippingGroupCode === null
    ? null
    : JSON.stringify(input.shippingGroupCode);

  await executor.execute(sql`
    INSERT INTO membership.shopify_metafield_outbox
      (target_type, target_id, namespace, key, value, operation, dedupe_key, scheduled_for)
    VALUES (
      'product', ${gid}, ${NAMESPACE}, ${KEY},
      ${valueJson === null ? sql`NULL` : sql`${valueJson}::jsonb`},
      ${operation}, ${dedupeKey}, now()
    )
    ON CONFLICT (dedupe_key) WHERE status = 'pending'
    DO UPDATE SET
      value         = EXCLUDED.value,
      operation     = EXCLUDED.operation,
      scheduled_for = EXCLUDED.scheduled_for,
      attempts      = 0,
      last_error    = NULL
  `);
}

/**
 * Enqueue `cardshellz.shipping_group` metafield writes for the given Echelon
 * product ids. Reads each product's current group code; a product with no group
 * (shipping_group_id NULL) enqueues a delete. Products with no shopify_product_id
 * (not pushed to Shopify yet) are skipped — the backfill catches them later.
 */
export async function enqueueShippingGroupMetafields(productIds: number[]): Promise<void> {
  if (!productIds || productIds.length === 0) return;
  try {
    const rows = await db
      .select({
        shopifyProductId: products.shopifyProductId,
        code: shippingGroups.code,
      })
      .from(products)
      .leftJoin(shippingGroups, eq(products.shippingGroupId, shippingGroups.id))
      .where(inArray(products.id, productIds));

    for (const row of rows) {
      if (!row.shopifyProductId) continue; // not on Shopify yet
      await enqueueShippingGroupMetafieldWrite(db, {
        shopifyProductId: row.shopifyProductId,
        shippingGroupCode: row.code,
      });
    }
  } catch (err) {
    // Never fail the catalog write because the cross-app enqueue failed (e.g. a
    // missing cross-schema grant). The backfill script reconciles. If this logs
    // in prod, grant the Echelon DB role INSERT on membership.shopify_metafield_outbox.
    console.error("[shipping-group-sync] enqueue failed:", err);
  }
}
