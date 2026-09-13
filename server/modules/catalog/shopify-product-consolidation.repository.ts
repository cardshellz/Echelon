import { sql } from "drizzle-orm";

import { db } from "../../db";
import { sqlIntegerArray } from "../../infrastructure/postgres-array";
import { normalizeShopifyId } from "./shopify-product-mapping.domain";
import {
  shopifyProductConsolidationEvidenceSchema,
  type ShopifyProductConsolidationEvidence,
  type ShopifyProductConsolidationProductEvidence,
  type ShopifyProductConsolidationVariantEvidence,
} from "./shopify-product-consolidation.domain";
import { ShopifyMappingReconciliationError } from "./shopify-product-mapping-reconciliation.repository";

const MAX_CONSOLIDATION_PRODUCTS = 100;

type QueryDatabase = Pick<typeof db, "execute">;

export interface ShopifyProductConsolidationLocalEvidence extends Omit<
  ShopifyProductConsolidationEvidence,
  | "remoteProductExists"
  | "remoteProductTitle"
  | "remoteVariantProductIds"
> {
  readonly externalVariantIds: readonly string[];
}

export interface ShopifyProductConsolidationRepository {
  loadLocalEvidence(input: {
    channelId: number;
    shopDomain: string;
    shopifyProductId: string;
    canonicalProductId: number;
  }): Promise<ShopifyProductConsolidationLocalEvidence>;
}

function rows(result: unknown): Record<string, unknown>[] {
  if (
    typeof result !== "object"
    || result === null
    || !("rows" in result)
    || !Array.isArray(result.rows)
  ) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      "The database returned invalid product-consolidation evidence",
      500,
    );
  }
  return result.rows as Record<string, unknown>[];
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      `Invalid ${field} in product-consolidation evidence`,
      500,
    );
  }
  return parsed;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      `Invalid ${field} in product-consolidation evidence`,
      500,
    );
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined
    ? null
    : positiveInteger(value, field);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      `Invalid ${field} in product-consolidation evidence`,
      500,
    );
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function boolean(value: unknown, field: string): boolean {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  throw new ShopifyMappingReconciliationError(
    "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
    `Invalid ${field} in product-consolidation evidence`,
    500,
  );
}

function integerQuantity(value: unknown, field: string): string {
  const parsed = String(value);
  if (!/^-?(0|[1-9]\d*)$/.test(parsed)) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      `Invalid ${field} in product-consolidation evidence`,
      500,
    );
  }
  return parsed;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      `Invalid ${field} in product-consolidation evidence`,
      500,
    );
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

async function loadOwnerProductIds(
  database: QueryDatabase,
  channelId: number,
  shopifyProductId: string,
): Promise<number[]> {
  const result = await database.execute(sql`
    SELECT DISTINCT ownership.product_id
    FROM (
      SELECT product.id AS product_id
      FROM catalog.products AS product
      WHERE substring(btrim(product.shopify_product_id) FROM '([0-9]+)$') = ${shopifyProductId}

      UNION ALL

      SELECT variant.product_id
      FROM channels.channel_feeds AS feed
      JOIN catalog.product_variants AS variant ON variant.id = feed.product_variant_id
      WHERE feed.channel_id = ${channelId}
        AND feed.channel_type = 'shopify'
        AND substring(btrim(feed.channel_product_id) FROM '([0-9]+)$') = ${shopifyProductId}

      UNION ALL

      SELECT variant.product_id
      FROM channels.channel_listings AS listing
      JOIN catalog.product_variants AS variant ON variant.id = listing.product_variant_id
      WHERE listing.channel_id = ${channelId}
        AND substring(btrim(listing.external_product_id) FROM '([0-9]+)$') = ${shopifyProductId}
    ) AS ownership
    ORDER BY ownership.product_id
  `);
  const ownerProductIds = rows(result).map((row) =>
    positiveInteger(row.product_id, "owner product id"));
  if (ownerProductIds.length > MAX_CONSOLIDATION_PRODUCTS) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_SCOPE_TOO_LARGE",
      "The Shopify product has too many local owners for one consolidation command",
      409,
      { ownerCount: ownerProductIds.length, maximum: MAX_CONSOLIDATION_PRODUCTS },
    );
  }
  return ownerProductIds;
}

async function loadProductRows(
  database: QueryDatabase,
  productIds: readonly number[],
): Promise<Record<string, unknown>[]> {
  if (productIds.length === 0) return [];
  return rows(await database.execute(sql`
    SELECT
      product.id,
      product.sku,
      product.name,
      product.status,
      product.is_active,
      product.shopify_product_id,
      shipping_group.code AS shipping_group_code,
      product.inventory_strategy,
      product.base_unit,
      product.inventory_type,
      model_head.active_model_id,
      model_head.draft_model_id,
      (
        SELECT COUNT(*)::integer
        FROM inventory.replen_rules AS rule
        WHERE rule.product_id = product.id AND rule.is_active = 1
      ) AS active_replen_rule_count,
      (
        SELECT COUNT(*)::integer
        FROM inventory.replen_tasks AS task
        WHERE task.product_id = product.id
          AND task.status NOT IN ('completed', 'cancelled')
      ) AS active_replen_task_count,
      (
        (SELECT COUNT(*) FROM channels.channel_product_allocation AS allocation
          WHERE allocation.product_id = product.id)
        + (SELECT COUNT(*) FROM channels.channel_product_overrides AS override
          WHERE override.product_id = product.id)
        + (SELECT COUNT(*) FROM channels.channel_allocation_rules AS rule
          WHERE rule.product_id = product.id)
      )::integer AS legacy_channel_configuration_count,
      (
        SELECT COUNT(*)::integer
        FROM inventory.channel_exposure_policy_heads AS head
        JOIN inventory.channel_exposure_policy_versions AS policy
          ON policy.id = head.active_policy_id
        WHERE policy.product_id = product.id
      ) AS active_channel_exposure_policy_count,
      (
        SELECT COUNT(*)::integer
        FROM marketplace.listing_scopes AS scope
        WHERE scope.product_id = product.id
      ) AS active_marketplace_listing_scope_count
    FROM catalog.products AS product
    LEFT JOIN catalog.shipping_groups AS shipping_group
      ON shipping_group.id = product.shipping_group_id
    LEFT JOIN inventory.transformation_model_heads AS model_head
      ON model_head.product_id = product.id
    WHERE product.id = ANY(${sqlIntegerArray(productIds)})
    ORDER BY product.id
  `));
}

async function loadVariantRows(
  database: QueryDatabase,
  productIds: readonly number[],
  channelId: number,
): Promise<Record<string, unknown>[]> {
  if (productIds.length === 0) return [];
  return rows(await database.execute(sql`
    SELECT
      variant.id,
      variant.product_id,
      variant.sku,
      variant.name,
      variant.uom_type,
      variant.units_per_variant,
      variant.hierarchy_level,
      variant.parent_variant_id,
      variant.is_base_unit,
      variant.requires_shipping,
      COALESCE(variant.track_inventory, true) AS track_inventory,
      variant.sales_eligibility,
      variant.is_active,
      variant.shopify_variant_id,
      COALESCE(inventory.on_hand_qty, 0)::text AS on_hand_qty,
      COALESCE(inventory.reserved_qty, 0)::text AS reserved_qty,
      COALESCE(inventory.picked_qty, 0)::text AS picked_qty,
      COALESCE(inventory.packed_qty, 0)::text AS packed_qty,
      COALESCE(inventory.backorder_qty, 0)::text AS backorder_qty,
      ARRAY(
        SELECT DISTINCT feed.channel_variant_id
        FROM channels.channel_feeds AS feed
        WHERE feed.channel_id = ${channelId}
          AND feed.channel_type = 'shopify'
          AND feed.product_variant_id = variant.id
          AND NULLIF(btrim(feed.channel_variant_id), '') IS NOT NULL
        ORDER BY feed.channel_variant_id
      ) AS feed_variant_ids,
      ARRAY(
        SELECT DISTINCT listing.external_variant_id
        FROM channels.channel_listings AS listing
        WHERE listing.channel_id = ${channelId}
          AND listing.product_variant_id = variant.id
          AND NULLIF(btrim(listing.external_variant_id), '') IS NOT NULL
        ORDER BY listing.external_variant_id
      ) AS listing_variant_ids,
      (
        SELECT COUNT(DISTINCT claim.id)::integer
        FROM inventory.availability_claims AS claim
        WHERE claim.status = 'active'
          AND (
            EXISTS (SELECT 1 FROM inventory.availability_claim_lines AS line
              WHERE line.claim_id = claim.id AND line.target_variant_id = variant.id)
            OR EXISTS (SELECT 1 FROM inventory.availability_claim_resources AS resource
              WHERE resource.claim_id = claim.id AND resource.source_variant_id = variant.id)
            OR EXISTS (SELECT 1 FROM inventory.availability_claim_operations AS operation
              WHERE operation.claim_id = claim.id AND operation.destination_variant_id = variant.id)
            OR EXISTS (
              SELECT 1
              FROM inventory.availability_claim_operation_inputs AS input
              WHERE input.claim_id = claim.id AND input.source_variant_id = variant.id
            )
          )
      ) AS active_claim_count,
      (
        (SELECT COUNT(DISTINCT build_order.id)
          FROM inventory.build_orders AS build_order
          LEFT JOIN inventory.build_order_components AS component
            ON component.build_order_id = build_order.id
          WHERE build_order.status IN ('draft', 'released', 'in_progress')
            AND (build_order.output_variant_id = variant.id
              OR component.component_variant_id = variant.id))
        + (SELECT COUNT(*) FROM inventory.replen_tasks AS task
          WHERE task.status NOT IN ('completed', 'cancelled')
            AND (task.source_product_variant_id = variant.id
              OR task.pick_product_variant_id = variant.id))
        + (SELECT COUNT(DISTINCT work.id)
          FROM warehouse.work_items AS work
          JOIN inventory.availability_claim_operations AS operation
            ON operation.id = work.claim_operation_id
          LEFT JOIN inventory.availability_claim_operation_inputs AS input
            ON input.claim_operation_id = operation.id
          WHERE work.state NOT IN ('completed', 'cancelled')
            AND (operation.destination_variant_id = variant.id
              OR input.source_variant_id = variant.id))
      )::integer AS open_work_reference_count,
      (
        SELECT COUNT(*)::integer
        FROM channels.channel_feeds AS feed
        WHERE feed.product_variant_id = variant.id AND feed.is_active = 1
      ) AS active_channel_feed_count,
      (
        (SELECT COUNT(*) FROM inventory.build_recipes AS recipe
          WHERE recipe.output_variant_id = variant.id)
        + (SELECT COUNT(*) FROM inventory.build_recipe_components AS component
          WHERE component.component_variant_id = variant.id)
      )::integer AS build_recipe_reference_count,
      (
        SELECT COUNT(DISTINCT model.id)::integer
        FROM inventory.transformation_model_versions AS model
        JOIN inventory.transformation_model_paths AS path ON path.model_id = model.id
        WHERE model.lifecycle_status <> 'draft'
          AND (path.source_variant_id = variant.id OR path.destination_variant_id = variant.id)
      ) AS non_draft_transformation_reference_count,
      (SELECT COUNT(*)::integer FROM procurement.demand_event_lines AS line
        WHERE line.product_variant_id = variant.id AND line.product_id = variant.product_id)
        AS demand_event_line_count,
      (SELECT COUNT(*)::integer FROM procurement.purchase_forecast_observations AS observation
        WHERE observation.selected_receive_variant_id = variant.id
          AND observation.product_id = variant.product_id)
        AS purchase_forecast_observation_count,
      (SELECT COUNT(*)::integer FROM marketplace.listing_publication_members AS member
        WHERE member.product_variant_id = variant.id AND member.product_id = variant.product_id)
        AS listing_publication_member_count,
      (SELECT COUNT(*)::integer FROM marketplace.listing_verification_members AS member
        WHERE member.product_variant_id = variant.id AND member.product_id = variant.product_id)
        AS listing_verification_member_count,
      (SELECT COUNT(*)::integer FROM inventory.channel_exposure_policy_versions AS policy
        WHERE policy.product_variant_id = variant.id AND policy.product_id = variant.product_id)
        AS channel_exposure_policy_version_count,
      (SELECT COUNT(*)::integer FROM inventory.transformation_recipe_bindings AS binding
        WHERE binding.output_variant_id_snapshot = variant.id
          AND binding.output_product_id_snapshot = variant.product_id)
        AS transformation_recipe_binding_count,
      (SELECT COUNT(*)::integer FROM inventory.transformation_recipe_component_snapshots AS component
        WHERE component.component_variant_id = variant.id
          AND component.component_product_id = variant.product_id)
        AS transformation_recipe_component_snapshot_count
    FROM catalog.product_variants AS variant
    LEFT JOIN LATERAL (
      SELECT
        SUM(level.variant_qty)::bigint AS on_hand_qty,
        SUM(level.reserved_qty)::bigint AS reserved_qty,
        SUM(level.picked_qty)::bigint AS picked_qty,
        SUM(level.packed_qty)::bigint AS packed_qty,
        SUM(level.backorder_qty)::bigint AS backorder_qty
      FROM inventory.inventory_levels AS level
      WHERE level.product_variant_id = variant.id
    ) AS inventory ON true
    WHERE variant.product_id = ANY(${sqlIntegerArray(productIds)})
    ORDER BY variant.product_id, variant.id
  `));
}

function mapVariant(row: Record<string, unknown>): ShopifyProductConsolidationVariantEvidence {
  const id = positiveInteger(row.id, "variant id");
  return {
    id,
    productId: positiveInteger(row.product_id, `variant ${id} product id`),
    sku: nullableText(row.sku),
    name: text(row.name, `variant ${id} name`),
    uomType: text(row.uom_type, `variant ${id} UOM`),
    unitsPerVariant: positiveInteger(row.units_per_variant, `variant ${id} units per variant`),
    hierarchyLevel: positiveInteger(row.hierarchy_level, `variant ${id} hierarchy level`),
    parentVariantId: nullablePositiveInteger(row.parent_variant_id, `variant ${id} parent id`),
    isBaseUnit: boolean(row.is_base_unit, `variant ${id} base-unit flag`),
    requiresShipping: boolean(row.requires_shipping, `variant ${id} shipping flag`),
    trackInventory: boolean(row.track_inventory, `variant ${id} inventory flag`),
    salesEligibility: text(row.sales_eligibility, `variant ${id} sales eligibility`),
    isActive: boolean(row.is_active, `variant ${id} active flag`),
    shopifyVariantId: normalizeShopifyId(nullableText(row.shopify_variant_id)),
    feedVariantIds: stringArray(row.feed_variant_ids, `variant ${id} feed ids`),
    listingVariantIds: stringArray(row.listing_variant_ids, `variant ${id} listing ids`),
    onHandQty: integerQuantity(row.on_hand_qty, `variant ${id} on-hand quantity`),
    reservedQty: integerQuantity(row.reserved_qty, `variant ${id} reserved quantity`),
    pickedQty: integerQuantity(row.picked_qty, `variant ${id} picked quantity`),
    packedQty: integerQuantity(row.packed_qty, `variant ${id} packed quantity`),
    backorderQty: integerQuantity(row.backorder_qty, `variant ${id} backorder quantity`),
    activeClaimCount: nonnegativeInteger(row.active_claim_count, `variant ${id} active claim count`),
    openWorkReferenceCount: nonnegativeInteger(row.open_work_reference_count, `variant ${id} open work count`),
    activeChannelFeedCount: nonnegativeInteger(row.active_channel_feed_count, `variant ${id} active feed count`),
    buildRecipeReferenceCount: nonnegativeInteger(row.build_recipe_reference_count, `variant ${id} build recipe count`),
    nonDraftTransformationReferenceCount: nonnegativeInteger(
      row.non_draft_transformation_reference_count,
      `variant ${id} transformation history count`,
    ),
    immutableProductReferences: {
      demand_event_lines: nonnegativeInteger(row.demand_event_line_count, `variant ${id} demand history count`),
      purchase_forecast_observations: nonnegativeInteger(row.purchase_forecast_observation_count, `variant ${id} forecast history count`),
      listing_publication_members: nonnegativeInteger(row.listing_publication_member_count, `variant ${id} listing publication count`),
      listing_verification_members: nonnegativeInteger(row.listing_verification_member_count, `variant ${id} listing verification count`),
      channel_exposure_policy_versions: nonnegativeInteger(row.channel_exposure_policy_version_count, `variant ${id} exposure policy count`),
      transformation_recipe_bindings: nonnegativeInteger(row.transformation_recipe_binding_count, `variant ${id} recipe binding count`),
      transformation_recipe_component_snapshots: nonnegativeInteger(
        row.transformation_recipe_component_snapshot_count,
        `variant ${id} recipe component snapshot count`,
      ),
    },
  };
}

function mapProduct(
  row: Record<string, unknown>,
  variants: readonly ShopifyProductConsolidationVariantEvidence[],
): ShopifyProductConsolidationProductEvidence {
  const id = positiveInteger(row.id, "product id");
  return {
    id,
    sku: nullableText(row.sku),
    name: text(row.name, `product ${id} name`),
    status: nullableText(row.status),
    isActive: boolean(row.is_active, `product ${id} active flag`),
    shopifyProductId: normalizeShopifyId(nullableText(row.shopify_product_id)),
    shippingGroupCode: nullableText(row.shipping_group_code),
    inventoryStrategy: text(row.inventory_strategy, `product ${id} inventory strategy`),
    baseUnit: text(row.base_unit, `product ${id} base unit`),
    inventoryType: text(row.inventory_type, `product ${id} inventory type`),
    activeTransformationModelId: nullablePositiveInteger(row.active_model_id, `product ${id} active model id`),
    draftTransformationModelId: nullablePositiveInteger(row.draft_model_id, `product ${id} draft model id`),
    activeReplenRuleCount: nonnegativeInteger(row.active_replen_rule_count, `product ${id} replen rule count`),
    activeReplenTaskCount: nonnegativeInteger(row.active_replen_task_count, `product ${id} replen task count`),
    legacyChannelConfigurationCount: nonnegativeInteger(
      row.legacy_channel_configuration_count,
      `product ${id} legacy channel configuration count`,
    ),
    activeChannelExposurePolicyCount: nonnegativeInteger(
      row.active_channel_exposure_policy_count,
      `product ${id} exposure policy count`,
    ),
    activeMarketplaceListingScopeCount: nonnegativeInteger(
      row.active_marketplace_listing_scope_count,
      `product ${id} marketplace scope count`,
    ),
    variants: variants.filter((variant) => variant.productId === id),
  };
}

async function loadLocalEvidence(
  database: QueryDatabase,
  input: {
    channelId: number;
    shopDomain: string;
    shopifyProductId: string;
    canonicalProductId: number;
  },
): Promise<ShopifyProductConsolidationLocalEvidence> {
  const ownerProductIds = await loadOwnerProductIds(
    database,
    input.channelId,
    input.shopifyProductId,
  );
  const productIds = [...new Set([
    ...ownerProductIds,
    input.canonicalProductId,
  ])].sort((left, right) => left - right);
  const productRows = await loadProductRows(database, productIds);
  const variantRows = await loadVariantRows(database, productIds, input.channelId);
  const freezeRows = rows(await database.execute(sql`
    SELECT activation_run_id::text AS activation_run_id
    FROM inventory.availability_activation_freezes
    WHERE released_at IS NULL
    ORDER BY activation_run_id
    LIMIT 2
  `));
  if (freezeRows.length > 1) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      "More than one inventory cutover freeze is active",
      500,
    );
  }
  const variants = variantRows.map(mapVariant);
  const products = productRows.map((row) => mapProduct(row, variants));
  const loadedProductIds = new Set(products.map((product) => product.id));
  const missingProductIds = productIds.filter(
    (productId) => !loadedProductIds.has(productId),
  );
  if (missingProductIds.length > 0) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      "Product-consolidation evidence is missing a requested local product",
      500,
      { productIds: missingProductIds },
    );
  }
  const externalVariantIds = [...new Set(variants.flatMap((variant) => [
    variant.shopifyVariantId,
    ...variant.feedVariantIds,
    ...variant.listingVariantIds,
  ]).filter((value): value is string => value !== null))]
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));

  const parsed = shopifyProductConsolidationEvidenceSchema.safeParse({
    channelId: input.channelId,
    shopDomain: input.shopDomain,
    shopifyProductId: input.shopifyProductId,
    remoteProductExists: false,
    remoteProductTitle: null,
    ownerProductIds,
    canonicalProductId: input.canonicalProductId,
    activeCutoverFreezeId: nullableText(freezeRows[0]?.activation_run_id),
    products,
    remoteVariantProductIds: {},
  });
  if (!parsed.success) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      "Product-consolidation evidence failed contract validation",
      500,
      { issues: parsed.error.issues },
    );
  }
  const {
    remoteProductExists: _remoteProductExists,
    remoteProductTitle: _remoteProductTitle,
    remoteVariantProductIds: _remoteVariantProductIds,
    ...local
  } = parsed.data;
  return { ...local, externalVariantIds };
}

export function createShopifyProductConsolidationRepository(
  database: typeof db = db,
): ShopifyProductConsolidationRepository {
  return {
    loadLocalEvidence: (input) => database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      return loadLocalEvidence(tx, input);
    }),
  };
}
