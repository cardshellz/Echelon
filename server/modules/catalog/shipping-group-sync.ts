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
 * Source changes and outbox writes must share one transaction. Enqueue failures
 * are surfaced instead of committing catalog/storefront drift. The backfill
 * script remains a reconciliation safety net for historical data.
 */
import { db } from "../../db";
import { products, shippingGroups } from "@shared/schema";
import { eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

const NAMESPACE = "cardshellz";
const KEY = "shipping_group";
const SHIPPING_GROUP_CODE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

type TransactionCallback = Parameters<typeof db.transaction>[0];
type TransactionClient = Parameters<TransactionCallback>[0];
export type ShippingGroupSyncClient = typeof db | TransactionClient;

export interface ShippingGroupMetafieldWrite {
  shopifyProductId: string;
  shippingGroupCode: string | null;
}

export interface ShippingGroupMetafieldSyncResult {
  requestedProductCount: number;
  queuedProductCount: number;
  skippedUnmappedProductCount: number;
}

interface ShippingGroupProjection {
  productId: number;
  shopifyProductId: string;
  shopifyProductGid: string;
  shippingGroupId: number | null;
  shippingGroupCode: string | null;
}

export class ShippingGroupMetafieldSyncError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ShippingGroupMetafieldSyncError";
  }
}

function toProductGid(shopifyProductId: string): string {
  if (/^\d+$/.test(shopifyProductId)) {
    return `gid://shopify/Product/${shopifyProductId}`;
  }
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(shopifyProductId)) {
    return shopifyProductId;
  }
  throw new ShippingGroupMetafieldSyncError(
    "INVALID_SHOPIFY_PRODUCT_ID",
    "Shipping-group metafield synchronization requires a numeric Shopify product id or Product GID",
    { shopifyProductId },
  );
}

function assertCanonicalShippingGroupCode(
  shippingGroupCode: string | null,
): void {
  if (
    shippingGroupCode !== null &&
    !SHIPPING_GROUP_CODE_PATTERN.test(shippingGroupCode)
  ) {
    throw new ShippingGroupMetafieldSyncError(
      "INVALID_SHIPPING_GROUP_CODE",
      "Shipping-group metafield synchronization requires a canonical lowercase snake-case group code",
      { shippingGroupCode },
    );
  }
}

async function assertSingleLocalOwnerPerShopifyProduct(
  client: ShippingGroupSyncClient,
  projections: readonly ShippingGroupProjection[],
): Promise<void> {
  if (projections.length === 0) return;

  const requestedGids = new Set(
    projections.map((projection) => projection.shopifyProductGid),
  );
  const projectedProductIds = new Set(
    projections.map((projection) => projection.productId),
  );
  const mappedProducts = await client
    .select({
      productId: products.id,
      shopifyProductId: products.shopifyProductId,
      shippingGroupId: products.shippingGroupId,
      shippingGroupCode: shippingGroups.code,
      isActive: products.isActive,
    })
    .from(products)
    .leftJoin(shippingGroups, eq(products.shippingGroupId, shippingGroups.id))
    .where(isNotNull(products.shopifyProductId));

  const ownersByGid = new Map<
    string,
    Array<{
      productId: number;
      shippingGroupId: number | null;
      shippingGroupCode: string | null;
    }>
  >();
  for (const mappedProduct of mappedProducts) {
    if (!mappedProduct.shopifyProductId) continue;
    // A retired product still carries its old Shopify mapping, but it cannot be
    // the listing's owner — treating it as one made every archived duplicate
    // permanently block assignment for the live product beside it. A product
    // being written right now always counts, even if it is archived, so an
    // explicit assignment to it still fails closed against a live twin.
    if (mappedProduct.isActive === false && !projectedProductIds.has(mappedProduct.productId)) continue;

    let gid: string;
    try {
      gid = toProductGid(mappedProduct.shopifyProductId);
    } catch {
      // An unrelated malformed mapping cannot own a valid requested target.
      continue;
    }
    if (!requestedGids.has(gid)) continue;

    const owners = ownersByGid.get(gid) ?? [];
    owners.push({
      productId: mappedProduct.productId,
      shippingGroupId: mappedProduct.shippingGroupId,
      shippingGroupCode: mappedProduct.shippingGroupCode,
    });
    ownersByGid.set(gid, owners);
  }

  for (const gid of [...requestedGids].sort()) {
    const owners = (ownersByGid.get(gid) ?? [])
      .sort((left, right) => left.productId - right.productId);
    if (owners.length <= 1) continue;

    const distinctGroupCodes = new Set(
      owners.map((owner) => owner.shippingGroupCode),
    );
    const hasConflictingGroups = distinctGroupCodes.size > 1;
    throw new ShippingGroupMetafieldSyncError(
      hasConflictingGroups
        ? "SHOPIFY_PRODUCT_MAPPING_CONFLICT"
        : "SHOPIFY_PRODUCT_MAPPING_DUPLICATE",
      hasConflictingGroups
        ? "Multiple Echelon products with different shipping groups map to the same Shopify product"
        : "Multiple Echelon products map to the same Shopify product",
      {
        shopifyProductId: gid,
        owners,
      },
    );
  }
}

/**
 * Transaction-compatible primitive used by every catalog writer. This throws
 * so catalog identity and the durable outbox command commit or roll back
 * together.
 */
export async function enqueueShippingGroupMetafieldWrite(
  executor: SqlExecutor,
  input: ShippingGroupMetafieldWrite,
): Promise<void> {
  assertCanonicalShippingGroupCode(input.shippingGroupCode);
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
export async function enqueueShippingGroupMetafields(
  client: ShippingGroupSyncClient,
  productIds: readonly number[],
): Promise<ShippingGroupMetafieldSyncResult> {
  const uniqueProductIds = [...new Set(productIds)];
  if (uniqueProductIds.length === 0) {
    return {
      requestedProductCount: 0,
      queuedProductCount: 0,
      skippedUnmappedProductCount: 0,
    };
  }
  if (uniqueProductIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ShippingGroupMetafieldSyncError(
      "INVALID_PRODUCT_IDS",
      "Shipping-group metafield synchronization requires positive integer product ids",
      { productIds: uniqueProductIds },
    );
  }

  const rows = await client
    .select({
      productId: products.id,
      shopifyProductId: products.shopifyProductId,
      shippingGroupId: products.shippingGroupId,
      code: shippingGroups.code,
    })
    .from(products)
    .leftJoin(shippingGroups, eq(products.shippingGroupId, shippingGroups.id))
    .where(inArray(products.id, uniqueProductIds));

  if (rows.length !== uniqueProductIds.length) {
    const foundProductIds = new Set(rows.map((row) => row.productId));
    throw new ShippingGroupMetafieldSyncError(
      "PRODUCT_SET_INCOMPLETE",
      "Shipping-group metafield synchronization could not load every product",
      {
        requestedProductIds: uniqueProductIds,
        missingProductIds: uniqueProductIds.filter((id) => !foundProductIds.has(id)),
      },
    );
  }

  const projections: ShippingGroupProjection[] = [];
  let skippedUnmappedProductCount = 0;
  for (const row of rows) {
    if (
      row.shippingGroupId !== null &&
      (row.code === null || !SHIPPING_GROUP_CODE_PATTERN.test(row.code))
    ) {
      throw new ShippingGroupMetafieldSyncError(
        "SHIPPING_GROUP_CODE_INVALID",
        `Product ${row.productId} references shipping group ${row.shippingGroupId} without a valid canonical code`,
        {
          productId: row.productId,
          shippingGroupId: row.shippingGroupId,
          shippingGroupCode: row.code,
        },
      );
    }
    if (!row.shopifyProductId) {
      skippedUnmappedProductCount++;
      continue;
    }
    const shopifyProductGid = toProductGid(row.shopifyProductId);
    projections.push({
      productId: row.productId,
      shopifyProductId: row.shopifyProductId,
      shopifyProductGid,
      shippingGroupId: row.shippingGroupId,
      shippingGroupCode: row.code,
    });
  }

  await assertSingleLocalOwnerPerShopifyProduct(client, projections);

  for (const projection of projections) {
    await enqueueShippingGroupMetafieldWrite(client, {
      shopifyProductId: projection.shopifyProductId,
      shippingGroupCode: projection.shippingGroupCode,
    });
  }

  return {
    requestedProductCount: uniqueProductIds.length,
    queuedProductCount: projections.length,
    skippedUnmappedProductCount,
  };
}
