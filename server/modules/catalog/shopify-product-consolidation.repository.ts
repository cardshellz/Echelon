import { sql } from "drizzle-orm";

import { canonicalJson } from "@shared/utils/canonical-json";
import { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { sqlIntegerArray } from "../../infrastructure/postgres-array";
import {
  CatalogConsolidationInventoryPlanningError,
  type CatalogConsolidationInventoryPlanningEvidence,
  type CatalogConsolidationInventoryPlanningPort,
  type CatalogConsolidationProductPlanningEvidence,
  type CatalogConsolidationVariantPlanningEvidence,
} from "../inventory-planning/application/catalog-consolidation-inventory-planning.port";
import {
  PostgresCatalogConsolidationInventoryPlanningRepository,
} from "../inventory-planning/infrastructure/catalog-consolidation-inventory-planning.repository";
import { normalizeShopifyId } from "./shopify-product-mapping.domain";
import { normalizeShopifyAdminDomain } from "./shopify-product-mapping-reconciliation.domain";
import {
  buildShopifyProductConsolidationPlan,
  shopifyProductConsolidationEvidenceSchema,
  shopifyProductConsolidationPlanSchema,
  shopifyProductConsolidationRequestHash,
  shopifyProductConsolidationResultSchema,
  type ShopifyProductConsolidationApplyRequest,
  type ShopifyProductConsolidationCommandRecord,
  type ShopifyProductConsolidationEvidence,
  type ShopifyProductConsolidationPlan,
  type ShopifyProductConsolidationProductEvidence,
  type ShopifyProductConsolidationResult,
  type ShopifyProductConsolidationVariantEvidence,
} from "./shopify-product-consolidation.domain";
import { ShopifyMappingReconciliationError } from "./shopify-product-mapping-reconciliation.repository";

const MAX_CONSOLIDATION_PRODUCTS = 100;

type QueryDatabase = Pick<typeof db, "execute">;
type TransactionCallback = Parameters<typeof db.transaction>[0];
type TransactionClient = Parameters<TransactionCallback>[0];

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
  findCommand(
    idempotencyKey: string,
  ): Promise<ShopifyProductConsolidationCommandRecord | null>;
  applyConsolidation(input: {
    channelId: number;
    shopDomain: string;
    request: ShopifyProductConsolidationApplyRequest;
    requestHash: string;
    actor: string;
    now: Date;
    remoteProductExists: boolean;
    remoteProductTitle: string | null;
    remoteVariantProductIds: ReadonlyMap<string, string | null>;
  }): Promise<{
    command: ShopifyProductConsolidationCommandRecord;
    idempotentReplay: boolean;
  }>;
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
        FROM marketplace.listing_scopes AS scope
        WHERE scope.product_id = product.id
      ) AS active_marketplace_listing_scope_count,
      (
        SELECT COUNT(DISTINCT order_item.id)::integer
        FROM wms.order_items AS order_item
        JOIN wms.orders AS orders ON orders.id = order_item.order_id
        WHERE order_item.product_id = product.id
          AND orders.warehouse_status NOT IN ('shipped', 'completed', 'cancelled')
          AND order_item.status <> 'cancelled'
          AND order_item.fulfilled_quantity < order_item.quantity
      ) AS open_wms_work_reference_count,
      (
        (SELECT COUNT(*) FROM dropship.dropship_catalog_rules AS rule
          WHERE rule.scope_type = 'product'
            AND rule.product_id = product.id
            AND rule.is_active = true)
        + (SELECT COUNT(*) FROM dropship.dropship_vendor_selection_rules AS rule
          WHERE rule.scope_type = 'product'
            AND rule.product_id = product.id
            AND rule.is_active = true)
        + (SELECT COUNT(*) FROM dropship.dropship_pricing_policies AS policy
          WHERE policy.scope_type = 'product'
            AND policy.product_id = product.id
            AND policy.is_active = true)
      )::integer AS active_dropship_configuration_count,
      (
        SELECT COUNT(*)::integer
        FROM channels.channel_pricing_rules AS rule
        WHERE rule.scope = 'product' AND rule.scope_id = product.id::text
      ) AS channel_pricing_rule_count,
      (
        SELECT COUNT(*)::integer
        FROM ebay.ebay_product_aspect_overrides AS override
        WHERE override.product_id = product.id
      ) AS ebay_aspect_override_count,
      (
        SELECT COUNT(*)::integer
        FROM procurement.vendor_products AS vendor_product
        WHERE vendor_product.product_id = product.id
          AND vendor_product.product_variant_id IS NULL
      ) AS product_level_procurement_mapping_count
    FROM catalog.products AS product
    LEFT JOIN catalog.shipping_groups AS shipping_group
      ON shipping_group.id = product.shipping_group_id
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
      COALESCE(variant.inventory_policy, 'deny') AS inventory_policy,
      COALESCE(variant.dropship_eligible, false) AS dropship_eligible,
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
        + (SELECT COUNT(*)
          FROM oms.oms_order_lines AS order_line
          JOIN oms.oms_orders AS orders ON orders.id = order_line.order_id
          WHERE order_line.product_variant_id = variant.id
            AND orders.status NOT IN ('shipped', 'delivered', 'cancelled', 'refunded'))
        + (SELECT COUNT(DISTINCT order_item.id)
          FROM wms.order_items AS order_item
          JOIN wms.orders AS orders ON orders.id = order_item.order_id
          JOIN oms.oms_order_lines AS order_line
            ON order_line.id = order_item.oms_order_line_id
          WHERE order_line.product_variant_id = variant.id
            AND orders.warehouse_status NOT IN ('shipped', 'completed', 'cancelled')
            AND order_item.status <> 'cancelled'
            AND order_item.fulfilled_quantity < order_item.quantity)
        + (SELECT COUNT(DISTINCT shipment_item.id)
          FROM wms.outbound_shipment_items AS shipment_item
          JOIN wms.outbound_shipments AS shipment
            ON shipment.id = shipment_item.shipment_id
          WHERE shipment_item.product_variant_id = variant.id
            AND shipment.status NOT IN ('shipped', 'voided', 'cancelled', 'returned', 'lost'))
        + (SELECT COUNT(*)
          FROM channels.channel_variant_availability_sync AS availability
          WHERE availability.product_variant_id = variant.id
            AND availability.status <> 'synced')
      )::integer AS open_work_reference_count,
      (
        SELECT COUNT(*)::integer
        FROM channels.channel_feeds AS feed
        WHERE feed.product_variant_id = variant.id AND feed.is_active = 1
      ) AS active_channel_feed_count,
      (SELECT COUNT(*)::integer FROM channels.channel_reservations AS reservation
        WHERE reservation.product_variant_id = variant.id)
        AS channel_reservation_count,
      (SELECT COUNT(*)::integer FROM channels.channel_variant_overrides AS override
        WHERE override.product_variant_id = variant.id)
        AS channel_variant_override_count,
      (SELECT COUNT(*)::integer FROM channels.channel_allocation_rules AS rule
        WHERE rule.product_variant_id = variant.id)
        AS channel_allocation_rule_count,
      (SELECT COUNT(*)::integer FROM channels.channel_pricing AS price
        WHERE price.product_variant_id = variant.id)
        AS channel_pricing_count,
      (SELECT COUNT(*)::integer FROM channels.channel_pricing_rules AS rule
        WHERE rule.scope = 'variant' AND rule.scope_id = variant.id::text)
        AS channel_pricing_rule_count,
      (SELECT COUNT(*)::integer FROM channels.channel_feeds AS feed
        WHERE feed.product_variant_id = variant.id
          AND (feed.channel_id IS DISTINCT FROM ${channelId}
            OR feed.channel_type <> 'shopify'))
        AS other_channel_feed_count,
      (SELECT COUNT(*)::integer FROM channels.channel_listings AS listing
        WHERE listing.product_variant_id = variant.id
          AND listing.channel_id <> ${channelId})
        AS other_channel_listing_count,
      (SELECT COUNT(*)::integer FROM channels.channel_variant_availability_sync AS availability
        WHERE availability.product_variant_id = variant.id)
        AS channel_variant_availability_sync_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_catalog_rules AS rule
        WHERE rule.scope_type = 'variant'
          AND rule.product_variant_id = variant.id AND rule.is_active = true)
        AS dropship_catalog_rule_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_vendor_selection_rules AS rule
        WHERE rule.scope_type = 'variant'
          AND rule.product_variant_id = variant.id AND rule.is_active = true)
        AS dropship_vendor_selection_rule_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_vendor_variant_overrides AS override
        WHERE override.product_variant_id = variant.id)
        AS dropship_vendor_variant_override_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_pricing_policies AS policy
        WHERE policy.scope_type = 'variant'
          AND policy.product_variant_id = variant.id AND policy.is_active = true)
        AS dropship_pricing_policy_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_ebay_store_category_assignments AS assignment
        WHERE assignment.product_variant_id = variant.id)
        AS dropship_ebay_store_category_assignment_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_ebay_listing_policy_overrides AS override
        WHERE override.product_variant_id = variant.id)
        AS dropship_ebay_listing_policy_override_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_listing_price_settings AS setting
        WHERE setting.product_variant_id = variant.id)
        AS dropship_listing_price_setting_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_vendor_listings AS listing
        WHERE listing.product_variant_id = variant.id)
        AS dropship_vendor_listing_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_listing_push_job_items AS item
        WHERE item.product_variant_id = variant.id
          AND item.status NOT IN ('completed', 'failed', 'cancelled'))
        AS dropship_open_listing_job_item_count,
      (SELECT COUNT(*)::integer FROM dropship.dropship_package_profiles AS profile
        WHERE profile.product_variant_id = variant.id AND profile.is_active = true)
        AS dropship_package_profile_count,
      (SELECT COUNT(*)::integer FROM shipping.variant_shipping_attrs AS attribute
        WHERE attribute.product_variant_id = variant.id)
        AS shipping_variant_attr_count,
      (SELECT COUNT(*)::integer FROM shipping.product_set_members AS member
        WHERE member.product_variant_id = variant.id)
        AS shipping_product_set_member_count,
      (SELECT COUNT(*)::integer FROM shipping.rate_rule_members AS member
        WHERE member.product_variant_id = variant.id)
        AS shipping_rate_rule_member_count,
      (SELECT COUNT(*)::integer FROM shipping.channel_packing_preferences AS preference
        WHERE preference.product_variant_id = variant.id)
        AS shipping_channel_packing_preference_count,
      (SELECT COUNT(*)::integer FROM warehouse.product_locations AS location
        WHERE location.product_variant_id = variant.id)
        AS warehouse_product_location_count,
      (SELECT COUNT(*)::integer FROM procurement.vendor_products AS vendor_product
        WHERE vendor_product.product_variant_id = variant.id)
        AS procurement_vendor_product_count,
      (
        (SELECT COUNT(*) FROM inventory.build_recipes AS recipe
          WHERE recipe.output_variant_id = variant.id)
        + (SELECT COUNT(*) FROM inventory.build_recipe_components AS component
          WHERE component.component_variant_id = variant.id)
      )::integer AS build_recipe_reference_count,
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
        AS listing_verification_member_count
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

function mapVariant(
  row: Record<string, unknown>,
  planning: CatalogConsolidationVariantPlanningEvidence,
): ShopifyProductConsolidationVariantEvidence {
  const id = positiveInteger(row.id, "variant id");
  if (planning.variantId !== id) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      "Inventory-planning evidence was associated with the wrong variant.",
      500,
      { variantId: id, planningVariantId: planning.variantId },
    );
  }
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
    inventoryPolicy: text(row.inventory_policy, `variant ${id} inventory policy`),
    dropshipEligible: boolean(row.dropship_eligible, `variant ${id} dropship eligibility`),
    isActive: boolean(row.is_active, `variant ${id} active flag`),
    shopifyVariantId: normalizeShopifyId(nullableText(row.shopify_variant_id)),
    feedVariantIds: stringArray(row.feed_variant_ids, `variant ${id} feed ids`),
    listingVariantIds: stringArray(row.listing_variant_ids, `variant ${id} listing ids`),
    onHandQty: integerQuantity(row.on_hand_qty, `variant ${id} on-hand quantity`),
    reservedQty: integerQuantity(row.reserved_qty, `variant ${id} reserved quantity`),
    pickedQty: integerQuantity(row.picked_qty, `variant ${id} picked quantity`),
    packedQty: integerQuantity(row.packed_qty, `variant ${id} packed quantity`),
    backorderQty: integerQuantity(row.backorder_qty, `variant ${id} backorder quantity`),
    activeClaimCount: planning.activeClaimCount,
    openWorkReferenceCount: nonnegativeInteger(
      row.open_work_reference_count,
      `variant ${id} open work count`,
    ) + planning.openPlanningWorkReferenceCount,
    activeChannelFeedCount: nonnegativeInteger(row.active_channel_feed_count, `variant ${id} active feed count`),
    runtimeConfigurationReferences: {
      channel_reservations: nonnegativeInteger(row.channel_reservation_count, `variant ${id} channel reservation count`),
      channel_variant_overrides: nonnegativeInteger(row.channel_variant_override_count, `variant ${id} channel override count`),
      channel_allocation_rules: nonnegativeInteger(row.channel_allocation_rule_count, `variant ${id} allocation rule count`),
      channel_pricing: nonnegativeInteger(row.channel_pricing_count, `variant ${id} channel pricing count`),
      channel_pricing_rules: nonnegativeInteger(row.channel_pricing_rule_count, `variant ${id} channel pricing rule count`),
      other_channel_feeds: nonnegativeInteger(row.other_channel_feed_count, `variant ${id} other channel feed count`),
      other_channel_listings: nonnegativeInteger(row.other_channel_listing_count, `variant ${id} other channel listing count`),
      channel_variant_availability_sync: nonnegativeInteger(row.channel_variant_availability_sync_count, `variant ${id} channel availability sync count`),
      dropship_catalog_rules: nonnegativeInteger(row.dropship_catalog_rule_count, `variant ${id} dropship catalog rule count`),
      dropship_vendor_selection_rules: nonnegativeInteger(row.dropship_vendor_selection_rule_count, `variant ${id} dropship vendor rule count`),
      dropship_vendor_variant_overrides: nonnegativeInteger(row.dropship_vendor_variant_override_count, `variant ${id} dropship vendor override count`),
      dropship_pricing_policies: nonnegativeInteger(row.dropship_pricing_policy_count, `variant ${id} dropship pricing policy count`),
      dropship_ebay_store_category_assignments: nonnegativeInteger(row.dropship_ebay_store_category_assignment_count, `variant ${id} dropship eBay category assignment count`),
      dropship_ebay_listing_policy_overrides: nonnegativeInteger(row.dropship_ebay_listing_policy_override_count, `variant ${id} dropship eBay policy override count`),
      dropship_listing_price_settings: nonnegativeInteger(row.dropship_listing_price_setting_count, `variant ${id} dropship price setting count`),
      dropship_vendor_listings: nonnegativeInteger(row.dropship_vendor_listing_count, `variant ${id} dropship listing count`),
      dropship_open_listing_job_items: nonnegativeInteger(row.dropship_open_listing_job_item_count, `variant ${id} dropship open listing job count`),
      dropship_package_profiles: nonnegativeInteger(row.dropship_package_profile_count, `variant ${id} dropship package profile count`),
      shipping_variant_attrs: nonnegativeInteger(row.shipping_variant_attr_count, `variant ${id} shipping attribute count`),
      shipping_product_set_members: nonnegativeInteger(row.shipping_product_set_member_count, `variant ${id} shipping product-set count`),
      shipping_rate_rule_members: nonnegativeInteger(row.shipping_rate_rule_member_count, `variant ${id} shipping rate-rule count`),
      shipping_channel_packing_preferences: nonnegativeInteger(row.shipping_channel_packing_preference_count, `variant ${id} channel packing preference count`),
      warehouse_product_locations: nonnegativeInteger(row.warehouse_product_location_count, `variant ${id} warehouse product-location count`),
    },
    procurementVendorProductCount: nonnegativeInteger(
      row.procurement_vendor_product_count,
      `variant ${id} procurement vendor-product count`,
    ),
    buildRecipeReferenceCount: nonnegativeInteger(row.build_recipe_reference_count, `variant ${id} build recipe count`),
    nonDraftTransformationReferenceCount:
      planning.nonDraftTransformationReferenceCount,
    immutableProductReferences: {
      demand_event_lines: nonnegativeInteger(row.demand_event_line_count, `variant ${id} demand history count`),
      purchase_forecast_observations: nonnegativeInteger(row.purchase_forecast_observation_count, `variant ${id} forecast history count`),
      listing_publication_members: nonnegativeInteger(row.listing_publication_member_count, `variant ${id} listing publication count`),
      listing_verification_members: nonnegativeInteger(row.listing_verification_member_count, `variant ${id} listing verification count`),
      channel_exposure_policy_versions:
        planning.channelExposurePolicyVersionCount,
      transformation_recipe_bindings:
        planning.transformationRecipeBindingCount,
      transformation_recipe_component_snapshots:
        planning.transformationRecipeComponentSnapshotCount,
    },
  };
}

function mapProduct(
  row: Record<string, unknown>,
  variants: readonly ShopifyProductConsolidationVariantEvidence[],
  planning: CatalogConsolidationProductPlanningEvidence,
): ShopifyProductConsolidationProductEvidence {
  const id = positiveInteger(row.id, "product id");
  if (planning.productId !== id) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      "Inventory-planning evidence was associated with the wrong product.",
      500,
      { productId: id, planningProductId: planning.productId },
    );
  }
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
    activeTransformationModelId: planning.activeTransformationModelId,
    draftTransformationModelId: planning.draftTransformationModelId,
    activeReplenRuleCount: nonnegativeInteger(row.active_replen_rule_count, `product ${id} replen rule count`),
    activeReplenTaskCount: nonnegativeInteger(row.active_replen_task_count, `product ${id} replen task count`),
    legacyChannelConfigurationCount: nonnegativeInteger(
      row.legacy_channel_configuration_count,
      `product ${id} legacy channel configuration count`,
    ),
    activeChannelExposurePolicyCount:
      planning.activeChannelExposurePolicyCount,
    activeMarketplaceListingScopeCount: nonnegativeInteger(
      row.active_marketplace_listing_scope_count,
      `product ${id} marketplace scope count`,
    ),
    openWmsWorkReferenceCount: nonnegativeInteger(
      row.open_wms_work_reference_count,
      `product ${id} open WMS work count`,
    ),
    activeDropshipConfigurationCount: nonnegativeInteger(
      row.active_dropship_configuration_count,
      `product ${id} active dropship configuration count`,
    ),
    channelPricingRuleCount: nonnegativeInteger(
      row.channel_pricing_rule_count,
      `product ${id} channel pricing rule count`,
    ),
    ebayAspectOverrideCount: nonnegativeInteger(
      row.ebay_aspect_override_count,
      `product ${id} eBay aspect override count`,
    ),
    productLevelProcurementMappingCount: nonnegativeInteger(
      row.product_level_procurement_mapping_count,
      `product ${id} product-level procurement mapping count`,
    ),
    variants: variants.filter((variant) => variant.productId === id),
  };
}

async function loadLocalEvidence(
  database: QueryDatabase,
  inventoryPlanning: CatalogConsolidationInventoryPlanningPort,
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
  const planningEvidence = await loadInventoryPlanningEvidence(
    inventoryPlanning,
    database,
    productIds,
    variantRows.map((row) => ({
      variantId: positiveInteger(row.id, "planning evidence variant id"),
      productId: positiveInteger(row.product_id, "planning evidence variant product id"),
    })),
  );
  const planningVariants = new Map(
    planningEvidence.variants.map((variant) => [variant.variantId, variant] as const),
  );
  const variants = variantRows.map((row) => {
    const variantId = positiveInteger(row.id, "variant id");
    const planning = planningVariants.get(variantId);
    if (!planning) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
        "Inventory-planning evidence is missing a requested variant.",
        500,
        { variantId },
      );
    }
    return mapVariant(row, planning);
  });
  const planningProducts = new Map(
    planningEvidence.products.map((product) => [product.productId, product] as const),
  );
  const products = productRows.map((row) => {
    const productId = positiveInteger(row.id, "product id");
    const planning = planningProducts.get(productId);
    if (!planning) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
        "Inventory-planning evidence is missing a requested product.",
        500,
        { productId },
      );
    }
    return mapProduct(row, variants, planning);
  });
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
    activeCutoverFreezeId: planningEvidence.activeCutoverFreezeId,
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

async function loadInventoryPlanningEvidence(
  inventoryPlanning: CatalogConsolidationInventoryPlanningPort,
  client: QueryDatabase,
  productIds: readonly number[],
  variants: readonly { variantId: number; productId: number }[],
): Promise<CatalogConsolidationInventoryPlanningEvidence> {
  try {
    return await inventoryPlanning.loadEvidence({ client, productIds, variants });
  } catch (error: unknown) {
    rethrowInventoryPlanningError(error);
  }
}

async function invalidateInventoryPlanningDrafts(
  inventoryPlanning: CatalogConsolidationInventoryPlanningPort,
  input: Parameters<CatalogConsolidationInventoryPlanningPort["invalidateDrafts"]>[0],
) {
  try {
    return await inventoryPlanning.invalidateDrafts(input);
  } catch (error: unknown) {
    rethrowInventoryPlanningError(error);
  }
}

function rethrowInventoryPlanningError(error: unknown): never {
  if (!(error instanceof CatalogConsolidationInventoryPlanningError)) throw error;
  const mapped = {
    INVENTORY_PLANNING_CONSOLIDATION_EVIDENCE_INVALID: {
      code: "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      statusCode: 500,
    },
    INVENTORY_PLANNING_CONSOLIDATION_DRAFT_STALE: {
      code: "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
      statusCode: 409,
    },
    INVENTORY_PLANNING_CONSOLIDATION_DRAFT_VERSION_EXHAUSTED: {
      code: "SHOPIFY_PRODUCT_CONSOLIDATION_DRAFT_VERSION_EXHAUSTED",
      statusCode: 409,
    },
    INVENTORY_PLANNING_CONSOLIDATION_DRAFT_NOT_REPLACED: {
      code: "SHOPIFY_PRODUCT_CONSOLIDATION_DRAFT_NOT_REPLACED",
      statusCode: 500,
    },
  }[error.code];
  throw new ShopifyMappingReconciliationError(
    mapped.code,
    error.message,
    mapped.statusCode,
    { inventoryPlanningCode: error.code, ...error.context },
  );
}

function timestamp(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_RECEIPT_INVALID",
      `Stored product-consolidation command has an invalid ${field}`,
      500,
    );
  }
  return parsed;
}

function positiveIntegerArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_RECEIPT_INVALID",
      `Stored product-consolidation command has an invalid ${field}`,
      500,
    );
  }
  return value.map((item) => positiveInteger(item, field));
}

function parseCommand(
  row: Record<string, unknown>,
): ShopifyProductConsolidationCommandRecord {
  const id = positiveInteger(row.id, "command id");
  const channelId = positiveInteger(row.channel_id, "command channel id");
  const shopifyProductId = text(
    row.shopify_product_id,
    "command Shopify product id",
  );
  const canonicalProductId = positiveInteger(
    row.canonical_product_id,
    "command canonical product id",
  );
  const idempotencyKey = text(row.idempotency_key, "command idempotency key");
  const requestHash = text(row.request_hash, "command request hash");
  const previewHash = text(row.preview_hash, "command preview hash");
  const operator = text(row.operator, "command operator");
  const reason = text(row.reason, "command reason");
  const sourceProductIds = positiveIntegerArray(
    row.source_product_ids,
    "source product ids",
  );
  const evidence = shopifyProductConsolidationEvidenceSchema.safeParse(
    row.evidence,
  );
  const storedPlan = shopifyProductConsolidationPlanSchema.safeParse(row.plan);
  const result = shopifyProductConsolidationResultSchema.safeParse(row.result);
  const completedAt = timestamp(row.completed_at, "completion timestamp");
  if (!evidence.success || !storedPlan.success || !result.success) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_RECEIPT_INVALID",
      "Stored product-consolidation command failed contract validation",
      500,
      {
        commandId: id,
        evidenceIssues: evidence.success ? [] : evidence.error.issues,
        planIssues: storedPlan.success ? [] : storedPlan.error.issues,
        resultIssues: result.success ? [] : result.error.issues,
      },
    );
  }
  const regeneratedPlan = buildShopifyProductConsolidationPlan(evidence.data);
  const reconstructedRequest: ShopifyProductConsolidationApplyRequest = {
    shopifyProductId,
    canonicalProductId,
    expectedShopDomain: evidence.data.shopDomain,
    expectedPreviewHash: previewHash,
    idempotencyKey,
    reason,
  };
  if (
    !/^[0-9a-f]{64}$/.test(requestHash)
    || !/^[0-9a-f]{64}$/.test(previewHash)
    || storedPlan.data.previewHash !== previewHash
    || regeneratedPlan.previewHash !== previewHash
    || canonicalJson(storedPlan.data) !== canonicalJson(regeneratedPlan)
    || canonicalJson(sourceProductIds) !== canonicalJson(storedPlan.data.sourceProductIds)
    || result.data.channelId !== channelId
    || result.data.shopDomain !== evidence.data.shopDomain
    || result.data.shopifyProductId !== shopifyProductId
    || result.data.canonicalProductId !== canonicalProductId
    || result.data.previewHash !== previewHash
    || canonicalJson(result.data.sourceProductIds) !== canonicalJson(sourceProductIds)
    || result.data.completedAt !== completedAt.toISOString()
    || shopifyProductConsolidationRequestHash({
      actor: operator,
      request: reconstructedRequest,
    }) !== requestHash
  ) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_RECEIPT_INVALID",
      "Stored product-consolidation command is internally inconsistent",
      500,
      { commandId: id },
    );
  }
  return Object.freeze({
    id,
    channelId,
    shopifyProductId,
    canonicalProductId,
    idempotencyKey,
    requestHash,
    previewHash,
    operator,
    reason,
    result: Object.freeze(result.data),
  });
}

export function assertShopifyProductConsolidationCommandMatches(
  command: ShopifyProductConsolidationCommandRecord,
  input: { channelId: number; requestHash: string },
): void {
  if (
    command.channelId !== input.channelId
    || command.requestHash !== input.requestHash
  ) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was already used for a different product consolidation",
      409,
      { commandId: command.id },
    );
  }
}

async function findCommand(
  database: QueryDatabase,
  idempotencyKey: string,
): Promise<ShopifyProductConsolidationCommandRecord | null> {
  const commandRows = rows(await database.execute(sql`
    SELECT *
    FROM channels.shopify_product_consolidation_commands
    WHERE idempotency_key = ${idempotencyKey}::uuid
    LIMIT 1
  `));
  return commandRows[0] ? parseCommand(commandRows[0]) : null;
}

function buildEvidence(input: {
  local: ShopifyProductConsolidationLocalEvidence;
  remoteProductExists: boolean;
  remoteProductTitle: string | null;
  remoteVariantProductIds: ReadonlyMap<string, string | null>;
}): ShopifyProductConsolidationEvidence {
  const missingVariantIds = input.local.externalVariantIds.filter(
    (variantId) => !input.remoteVariantProductIds.has(variantId),
  );
  if (missingVariantIds.length > 0) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
      "Local Shopify variant mappings changed after remote verification. Refresh and try again.",
      409,
      { variantIds: missingVariantIds },
    );
  }
  const parsed = shopifyProductConsolidationEvidenceSchema.safeParse({
    channelId: input.local.channelId,
    shopDomain: input.local.shopDomain,
    shopifyProductId: input.local.shopifyProductId,
    remoteProductExists: input.remoteProductExists,
    remoteProductTitle: input.remoteProductTitle,
    ownerProductIds: input.local.ownerProductIds,
    canonicalProductId: input.local.canonicalProductId,
    activeCutoverFreezeId: input.local.activeCutoverFreezeId,
    products: input.local.products,
    remoteVariantProductIds: Object.fromEntries(
      [...input.remoteVariantProductIds.entries()].sort(([left], [right]) =>
        left.localeCompare(right, "en", { numeric: true })),
    ),
  });
  if (!parsed.success) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_EVIDENCE_INVALID",
      "Fresh product-consolidation evidence failed contract validation",
      500,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

async function loadQuantitySnapshot(
  database: QueryDatabase,
  variantIds: readonly number[],
): Promise<readonly Record<string, unknown>[]> {
  if (variantIds.length === 0) return [];
  return rows(await database.execute(sql`
    SELECT
      level.id,
      level.product_variant_id,
      level.warehouse_location_id,
      level.variant_qty::text AS variant_qty,
      level.reserved_qty::text AS reserved_qty,
      level.picked_qty::text AS picked_qty,
      level.packed_qty::text AS packed_qty,
      level.backorder_qty::text AS backorder_qty
    FROM inventory.inventory_levels AS level
    WHERE level.product_variant_id = ANY(${sqlIntegerArray(variantIds)})
    ORDER BY level.warehouse_location_id, level.product_variant_id, level.id
  `));
}

type ConsolidationApplyInput = Parameters<
  ShopifyProductConsolidationRepository["applyConsolidation"]
>[0];

async function applyConsolidationInTransaction(
  tx: TransactionClient,
  input: ConsolidationApplyInput,
  inventoryPlanning: CatalogConsolidationInventoryPlanningPort,
): Promise<{
  command: ShopifyProductConsolidationCommandRecord;
  idempotentReplay: boolean;
}> {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
  await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`shopify-product-consolidation-command:${input.request.idempotencyKey}`},
        0::bigint
      )
    )
  `);

  const prior = await findCommand(tx, input.request.idempotencyKey);
  if (prior) {
    assertShopifyProductConsolidationCommandMatches(prior, {
      channelId: input.channelId,
      requestHash: input.requestHash,
    });
    return { command: prior, idempotentReplay: true };
  }

  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`shopify-product-mapping:${input.channelId}:${input.request.shopifyProductId}`},
        0::bigint
      )
    )
  `);

  const preliminaryProductIds = [...new Set([
    ...(await loadOwnerProductIds(
      tx,
      input.channelId,
      input.request.shopifyProductId,
    )),
    input.request.canonicalProductId,
  ])].sort((left, right) => left - right);
  await inventoryPlanning.lockProducts({
    client: tx,
    productIds: preliminaryProductIds,
  });
  const preliminaryVariantRows = preliminaryProductIds.length === 0
    ? []
    : rows(await tx.execute(sql`
      SELECT id
      FROM catalog.product_variants
      WHERE product_id = ANY(${sqlIntegerArray(preliminaryProductIds)})
      ORDER BY id
    `));
  const preliminaryVariantIds = preliminaryVariantRows.map((row) =>
    positiveInteger(row.id, "variant lock id"));
  for (const variantId of preliminaryVariantIds) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(918424, ${variantId})`);
  }

  // This is a rare, operator-authorized identity command. The explicit fences
  // prevent a legacy writer from inserting a new owner, quantity, promise,
  // work item, or immutable product/variant pair after the evidence read. Keep
  // the planning-owned fence between these two groups so extracting its table
  // knowledge does not change the established global lock-acquisition order.
  await tx.execute(sql`
    LOCK TABLE
      channels.channels,
      channels.channel_connections,
      catalog.products,
      catalog.product_variants,
      catalog.shipping_groups,
      catalog.product_assets,
      warehouse.product_locations,
      channels.channel_feeds,
      channels.channel_listings,
      channels.channel_reservations,
      channels.channel_variant_overrides,
      channels.channel_pricing,
      channels.channel_pricing_rules,
      channels.channel_product_allocation,
      channels.channel_product_overrides,
      channels.channel_allocation_rules,
      inventory.inventory_levels,
      inventory.replen_rules,
      inventory.replen_tasks,
      inventory.build_orders,
      inventory.build_order_components,
      inventory.build_recipes,
      inventory.build_recipe_components
    IN SHARE ROW EXCLUSIVE MODE
  `);
  await inventoryPlanning.fenceDependencies({ client: tx });
  await tx.execute(sql`
    LOCK TABLE
      channels.channel_variant_availability_sync,
      warehouse.work_items,
      oms.oms_orders,
      oms.oms_order_lines,
      wms.orders,
      wms.order_items,
      wms.outbound_shipments,
      wms.outbound_shipment_items,
      dropship.dropship_catalog_rules,
      dropship.dropship_vendor_selection_rules,
      dropship.dropship_vendor_variant_overrides,
      dropship.dropship_pricing_policies,
      dropship.dropship_ebay_store_category_assignments,
      dropship.dropship_ebay_listing_policy_overrides,
      dropship.dropship_listing_price_settings,
      dropship.dropship_vendor_listings,
      dropship.dropship_listing_push_job_items,
      dropship.dropship_package_profiles,
      shipping.variant_shipping_attrs,
      shipping.product_set_members,
      shipping.rate_rule_members,
      shipping.channel_packing_preferences,
      ebay.ebay_product_aspect_overrides,
      marketplace.listing_scopes,
      marketplace.listing_publication_members,
      marketplace.listing_verification_members,
      procurement.demand_event_lines,
      procurement.purchase_forecast_observations,
      procurement.vendor_products
    IN SHARE ROW EXCLUSIVE MODE
  `);

  const channelRows = rows(await tx.execute(sql`
    SELECT
      channel_row.id,
      channel_row.provider,
      channel_row.is_default,
      (
        SELECT connection.shop_domain
        FROM channels.channel_connections AS connection
        WHERE connection.channel_id = channel_row.id
        ORDER BY connection.updated_at DESC, connection.id DESC
        LIMIT 1
      ) AS shop_domain
    FROM channels.channels AS channel_row
    WHERE channel_row.id = ${input.channelId}
    LIMIT 1
  `));
  const channelRow = channelRows[0];
  const storedShopDomainValue = nullableText(channelRow?.shop_domain);
  const storedShopDomain = storedShopDomainValue === null
    ? null
    : normalizeShopifyAdminDomain(storedShopDomainValue);
  if (
    !channelRow
    || String(channelRow.provider).toLowerCase() !== "shopify"
    || nonnegativeInteger(channelRow.is_default, "channel default flag") !== 1
    || (storedShopDomain !== null && storedShopDomain !== input.shopDomain)
  ) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_MAPPING_STORE_CHANGED",
      "The Shopify channel or store connection changed after review. Refresh and try again.",
      409,
      {
        expectedShopDomain: input.shopDomain,
        currentShopDomain: storedShopDomain,
      },
    );
  }

  const local = await loadLocalEvidence(tx, inventoryPlanning, {
    channelId: input.channelId,
    shopDomain: input.shopDomain,
    shopifyProductId: input.request.shopifyProductId,
    canonicalProductId: input.request.canonicalProductId,
  });
  const lockedProductIds = [...new Set([
    ...local.ownerProductIds,
    input.request.canonicalProductId,
  ])].sort((left, right) => left - right);
  const lockedVariantIds = local.products.flatMap((product) =>
    product.variants.map((variant) => variant.id))
    .sort((left, right) => left - right);
  if (
    canonicalJson(lockedProductIds) !== canonicalJson(preliminaryProductIds)
    || canonicalJson(lockedVariantIds) !== canonicalJson(preliminaryVariantIds)
  ) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
      "Product ownership or package membership changed while consolidation locks were acquired. Refresh and try again.",
      409,
      {
        preliminaryProductIds,
        lockedProductIds,
        preliminaryVariantIds,
        lockedVariantIds,
      },
    );
  }
  const evidence = buildEvidence({
    local,
    remoteProductExists: input.remoteProductExists,
    remoteProductTitle: input.remoteProductTitle,
    remoteVariantProductIds: input.remoteVariantProductIds,
  });
  const plan = buildShopifyProductConsolidationPlan(evidence);
  if (plan.previewHash !== input.request.expectedPreviewHash) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
      "Product, inventory, dependency, or Shopify evidence changed after review. Refresh and try again.",
      409,
      {
        expectedPreviewHash: input.request.expectedPreviewHash,
        currentPreviewHash: plan.previewHash,
      },
    );
  }
  if (!plan.canApply) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_BLOCKED",
      "The reviewed product family still has blocking dependencies.",
      409,
      { blockers: plan.blockers },
    );
  }

  const variants = new Map(evidence.products.flatMap((product) =>
    product.variants.map((variant) => [variant.id, variant] as const)));
  const affectedVariantIds = [...variants.keys()].sort((left, right) => left - right);
  const beforeQuantities = await loadQuantitySnapshot(tx, affectedVariantIds);
  const drafts = await invalidateInventoryPlanningDrafts(inventoryPlanning, {
    client: tx,
    expectedDrafts: evidence.products.flatMap((product) =>
      product.draftTransformationModelId === null
        ? []
        : [{ productId: product.id, draftModelId: product.draftTransformationModelId }]),
    externalProductId: input.request.shopifyProductId,
    canonicalProductId: input.request.canonicalProductId,
    requestHash: input.requestHash,
    idempotencyKey: input.request.idempotencyKey,
    actor: input.actor,
    reason: input.request.reason,
    occurredAt: input.now,
  });

  const moves = plan.actions.filter((action) => action.action === "move");
  const retired = plan.actions.filter(
    (action) => action.action === "retire_duplicate",
  );
  const archived = plan.actions.filter(
    (action) => action.action === "archive_inactive",
  );
  const replacements = new Map(retired.map((action) => [
    action.sourceVariantId,
    action.targetVariantId,
  ]));

  for (const action of moves) {
    const movedRows = rows(await tx.execute(sql`
      UPDATE catalog.product_variants
      SET product_id = ${plan.canonicalProductId}, updated_at = ${input.now}
      WHERE id = ${action.sourceVariantId}
        AND product_id = ${action.sourceProductId}
        AND is_active = true
      RETURNING id
    `));
    if (movedRows.length !== 1) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
        "A retained source variant changed after review. Refresh and try again.",
        409,
        { variantId: action.sourceVariantId },
      );
    }
  }

  const movedVariantIds = moves.map((action) => action.sourceVariantId)
    .sort((left, right) => left - right);
  const reparentedLocationRows = movedVariantIds.length === 0
    ? []
    : rows(await tx.execute(sql`
      UPDATE warehouse.product_locations
      SET product_id = ${plan.canonicalProductId}, updated_at = ${input.now}
      WHERE product_variant_id = ANY(${sqlIntegerArray(movedVariantIds)})
      RETURNING id
    `));
  const reparentedAssetRows = movedVariantIds.length === 0
    ? []
    : rows(await tx.execute(sql`
      UPDATE catalog.product_assets
      SET product_id = ${plan.canonicalProductId}
      WHERE product_variant_id = ANY(${sqlIntegerArray(movedVariantIds)})
      RETURNING id
    `));

  const updatedParentVariantIds: number[] = [];
  for (const action of plan.actions.filter((candidate) =>
    candidate.action === "retain" || candidate.action === "move")) {
    const variant = variants.get(action.sourceVariantId);
    if (!variant || variant.parentVariantId === null) continue;
    const targetParentVariantId = replacements.get(variant.parentVariantId)
      ?? variant.parentVariantId;
    if (targetParentVariantId === variant.parentVariantId) continue;
    const parentRows = rows(await tx.execute(sql`
      UPDATE catalog.product_variants
      SET parent_variant_id = ${targetParentVariantId}, updated_at = ${input.now}
      WHERE id = ${variant.id}
        AND parent_variant_id IS NOT DISTINCT FROM ${variant.parentVariantId}
      RETURNING id
    `));
    if (parentRows.length !== 1) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
        "A retained variant hierarchy changed after review. Refresh and try again.",
        409,
        { variantId: variant.id },
      );
    }
    updatedParentVariantIds.push(variant.id);
  }

  for (const action of [...retired, ...archived].sort(
    (left, right) => left.sourceVariantId - right.sourceVariantId,
  )) {
    const retiredRows = rows(await tx.execute(sql`
      UPDATE catalog.product_variants
      SET is_active = false,
          shopify_variant_id = NULL,
          shopify_inventory_item_id = NULL,
          updated_at = ${input.now}
      WHERE id = ${action.sourceVariantId}
        AND product_id = ${action.sourceProductId}
      RETURNING id
    `));
    if (retiredRows.length !== 1) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
        "A duplicate source variant changed after review. Refresh and try again.",
        409,
        { variantId: action.sourceVariantId },
      );
    }
  }

  const detachedVariantIds = [...retired, ...archived]
    .map((action) => action.sourceVariantId)
    .sort((left, right) => left - right);
  const detachedFeedRows = detachedVariantIds.length === 0
    ? []
    : rows(await tx.execute(sql`
      UPDATE channels.channel_feeds
      SET channel_product_id = NULL,
          channel_variant_id = NULL,
          channel_inventory_item_id = NULL,
          is_active = 0,
          last_synced_qty = NULL,
          consecutive_push_failures = 0,
          quarantined_at = NULL,
          quarantine_reason = NULL,
          updated_at = ${input.now}
      WHERE channel_id = ${input.channelId}
        AND channel_type = 'shopify'
        AND product_variant_id = ANY(${sqlIntegerArray(detachedVariantIds)})
      RETURNING id
    `));
  const resetListingRows = detachedVariantIds.length === 0
    ? []
    : rows(await tx.execute(sql`
      UPDATE channels.channel_listings
      SET external_product_id = NULL,
          external_variant_id = NULL,
          external_url = NULL,
          sync_status = 'error',
          sync_error = 'Shopify identity retired by an audited local product-family consolidation.',
          updated_at = ${input.now}
      WHERE channel_id = ${input.channelId}
        AND product_variant_id = ANY(${sqlIntegerArray(detachedVariantIds)})
      RETURNING id
    `));

  const archivedProductRows = plan.sourceProductIds.length === 0
    ? []
    : rows(await tx.execute(sql`
      UPDATE catalog.products
      SET shopify_product_id = NULL,
          is_active = false,
          status = 'archived',
          updated_at = ${input.now}
      WHERE id = ANY(${sqlIntegerArray(plan.sourceProductIds)})
        AND id <> ${plan.canonicalProductId}
      RETURNING id
    `));
  const archivedProductIds = archivedProductRows
    .map((row) => positiveInteger(row.id, "archived product id"))
    .sort((left, right) => left - right);
  if (canonicalJson(archivedProductIds) !== canonicalJson(plan.sourceProductIds)) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_PREVIEW_STALE",
      "The source product set changed during consolidation.",
      409,
      { expectedProductIds: plan.sourceProductIds, archivedProductIds },
    );
  }

  const afterQuantities = await loadQuantitySnapshot(tx, affectedVariantIds);
  if (canonicalJson(beforeQuantities) !== canonicalJson(afterQuantities)) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_QUANTITY_INVARIANT_FAILED",
      "Inventory quantities changed during metadata-only product consolidation.",
      500,
      { variantIds: affectedVariantIds },
    );
  }

  const remainingOwners = await loadOwnerProductIds(
    tx,
    input.channelId,
    input.request.shopifyProductId,
  );
  const invalidSourceVariants = plan.sourceProductIds.length === 0
    ? []
    : rows(await tx.execute(sql`
      SELECT id
      FROM catalog.product_variants
      WHERE product_id = ANY(${sqlIntegerArray(plan.sourceProductIds)})
        AND is_active = true
      ORDER BY id
    `));
  const misplacedMovedVariants = movedVariantIds.length === 0
    ? []
    : rows(await tx.execute(sql`
      SELECT id
      FROM catalog.product_variants
      WHERE id = ANY(${sqlIntegerArray(movedVariantIds)})
        AND product_id <> ${plan.canonicalProductId}
      ORDER BY id
    `));
  if (
    canonicalJson(remainingOwners) !== canonicalJson([plan.canonicalProductId])
    || invalidSourceVariants.length > 0
    || misplacedMovedVariants.length > 0
  ) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_INVARIANT_FAILED",
      "The local product family did not converge to one canonical owner.",
      500,
      {
        remainingOwnerProductIds: remainingOwners,
        activeSourceVariantIds: invalidSourceVariants.map((row) => row.id),
        misplacedMovedVariantIds: misplacedMovedVariants.map((row) => row.id),
      },
    );
  }

  const result = shopifyProductConsolidationResultSchema.parse({
    contractVersion: 1,
    channelId: input.channelId,
    shopDomain: input.shopDomain,
    shopifyProductId: input.request.shopifyProductId,
    previewHash: plan.previewHash,
    canonicalProductId: plan.canonicalProductId,
    sourceProductIds: [...plan.sourceProductIds],
    movedVariantIds,
    retiredVariantIds: retired.map((action) => action.sourceVariantId)
      .sort((left, right) => left - right),
    archivedVariantIds: archived.map((action) => action.sourceVariantId)
      .sort((left, right) => left - right),
    updatedParentVariantIds: updatedParentVariantIds.sort(
      (left, right) => left - right,
    ),
    archivedProductIds,
    invalidatedDraftModelIds: [...drafts.invalidatedModelIds],
    replacementDraftModelIds: [...drafts.replacementModelIds],
    reparentedLocationCount: reparentedLocationRows.length,
    reparentedAssetCount: reparentedAssetRows.length,
    detachedFeedCount: detachedFeedRows.length,
    resetListingCount: resetListingRows.length,
    completedAt: input.now.toISOString(),
  } satisfies ShopifyProductConsolidationResult);
  const insertedRows = rows(await tx.execute(sql`
    INSERT INTO channels.shopify_product_consolidation_commands (
      channel_id,
      shopify_product_id,
      canonical_product_id,
      source_product_ids,
      idempotency_key,
      request_hash,
      preview_hash,
      operator,
      reason,
      evidence,
      plan,
      result,
      created_at,
      completed_at
    ) VALUES (
      ${input.channelId},
      ${input.request.shopifyProductId},
      ${plan.canonicalProductId},
      ${JSON.stringify(plan.sourceProductIds)}::jsonb,
      ${input.request.idempotencyKey}::uuid,
      ${input.requestHash},
      ${plan.previewHash},
      ${input.actor},
      ${input.request.reason},
      ${JSON.stringify(evidence)}::jsonb,
      ${JSON.stringify(plan)}::jsonb,
      ${JSON.stringify(result)}::jsonb,
      ${input.now},
      ${input.now}
    )
    RETURNING *
  `));
  if (insertedRows.length !== 1) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_PRODUCT_CONSOLIDATION_COMMAND_NOT_RECORDED",
      "The product-consolidation command could not be recorded",
      500,
    );
  }
  const command = parseCommand(insertedRows[0]);
  await persistAuditEvent(tx, {
    actor: input.actor,
    action: "catalog.shopify_product_family_consolidated",
    target: `shopify.product:${input.request.shopifyProductId}`,
    changes: {
      before: evidence,
      after: result,
    },
    context: {
      commandId: command.id,
      channelId: input.channelId,
      idempotencyKey: input.request.idempotencyKey,
      requestHash: input.requestHash,
      previewHash: plan.previewHash,
      reason: input.request.reason,
      remoteMutationPerformed: false,
      inventoryQuantityMutationPerformed: false,
    },
  }, { timestamp: input.now, emitStructuredLog: false });
  return { command, idempotentReplay: false };
}

function isTransactionContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return ["40001", "40P01", "55P03"].includes(String(error.code));
}

export function createShopifyProductConsolidationRepository(
  database: typeof db = db,
  inventoryPlanning: CatalogConsolidationInventoryPlanningPort =
    new PostgresCatalogConsolidationInventoryPlanningRepository(),
): ShopifyProductConsolidationRepository {
  return {
    loadLocalEvidence: (input) => database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      return loadLocalEvidence(tx, inventoryPlanning, input);
    }),
    findCommand: (idempotencyKey) => findCommand(database, idempotencyKey),
    async applyConsolidation(input) {
      try {
        return await database.transaction((tx) =>
          applyConsolidationInTransaction(tx, input, inventoryPlanning));
      } catch (error: unknown) {
        if (error instanceof ShopifyMappingReconciliationError) throw error;
        if (isTransactionContention(error)) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_PRODUCT_CONSOLIDATION_BUSY",
            "Inventory or catalog state was busy. No consolidation was applied; refresh and retry.",
            409,
          );
        }
        throw error;
      }
    },
  };
}
