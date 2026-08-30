import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  VARIANT_SALES_ELIGIBILITIES,
  VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE,
  type VariantSalesEligibility,
} from "@shared/catalog/variant-sales-eligibility";

export { VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE };

export type VariantSalesEligibilityBlocker =
  | "shopify_mapping"
  | "dropship_enabled"
  | "active_channel_feed"
  | "channel_listing"
  | "channel_allocation_configuration"
  | "active_channel_availability"
  | "dropship_listing"
  | "active_marketplace_publication"
  | "pending_inventory_publication"
  | "open_customer_order";

export class VariantSalesEligibilityError extends Error {
  readonly code = "VARIANT_INTERNAL_ONLY_DEPENDENCIES";
  readonly statusCode = 409;

  constructor(readonly blockers: readonly VariantSalesEligibilityBlocker[]) {
    super(
      blockers.length > 0
        ? `Remove customer-facing variant dependencies before marking it internal-only: ${blockers.join(", ")}`
        : "The variant cannot be marked internal-only.",
    );
    this.name = "VariantSalesEligibilityError";
  }
}

const salesEligibilityPayloadSchema = z.object({
  salesEligibility: z.enum(VARIANT_SALES_ELIGIBILITIES).optional(),
}).strict();

export function coerceVariantSalesEligibilityOnPayload(
  input: unknown,
): { salesEligibility?: VariantSalesEligibility } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(source, "salesEligibility")) return {};
  const parsed = salesEligibilityPayloadSchema.safeParse({
    salesEligibility: source.salesEligibility,
  });
  if (!parsed.success) {
    throw Object.assign(
      new Error("salesEligibility must be either sellable or internal_only"),
      { statusCode: 400 },
    );
  }
  return parsed.data;
}

interface ExistingVariantSalesIdentity {
  id: number;
  salesEligibility: VariantSalesEligibility;
  shopifyVariantId: string | null;
  shopifyInventoryItemId: string | null;
  dropshipEligible: boolean | null;
}

export function assertVariantSalesIdentityCompatible(input: {
  salesEligibility: VariantSalesEligibility;
  shopifyVariantId: string | null | undefined;
  shopifyInventoryItemId: string | null | undefined;
  dropshipEligible: boolean | null | undefined;
}): void {
  if (input.salesEligibility !== "internal_only") return;
  const blockers: VariantSalesEligibilityBlocker[] = [];
  if (input.shopifyVariantId || input.shopifyInventoryItemId) blockers.push("shopify_mapping");
  if (input.dropshipEligible === true) blockers.push("dropship_enabled");
  if (blockers.length > 0) throw new VariantSalesEligibilityError(blockers);
}

interface SqlExecutor {
  execute(statement: unknown): Promise<unknown>;
}

interface ExposureRow {
  active_channel_feed: boolean;
  channel_listing: boolean;
  channel_allocation_configuration: boolean;
  active_channel_availability: boolean;
  dropship_listing: boolean;
  active_marketplace_publication: boolean;
  pending_inventory_publication: boolean;
  open_customer_order: boolean;
}

/**
 * Serialize and validate the sellable -> internal-only transition.
 *
 * The same advisory namespace is acquired by database triggers on every
 * customer-facing writer, so the dependency snapshot and catalog update cannot
 * race a listing/feed/allocation insert.
 */
export async function assertVariantSalesEligibilityTransitionAllowed(
  executor: SqlExecutor,
  existing: ExistingVariantSalesIdentity,
  next: VariantSalesEligibility,
): Promise<void> {
  if (existing.salesEligibility === next || next !== "internal_only") return;

  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE},
      ${existing.id}
    )
  `);

  const blockers: VariantSalesEligibilityBlocker[] = [];
  if (existing.shopifyVariantId || existing.shopifyInventoryItemId) {
    blockers.push("shopify_mapping");
  }
  if (existing.dropshipEligible === true) blockers.push("dropship_enabled");

  const result = await executor.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM channels.channel_feeds f
        WHERE f.product_variant_id = ${existing.id} AND f.is_active = 1
      ) AS active_channel_feed,
      EXISTS (
        SELECT 1 FROM channels.channel_listings l
        WHERE l.product_variant_id = ${existing.id}
      ) AS channel_listing,
      (
        EXISTS (
          SELECT 1 FROM channels.channel_reservations r
          WHERE r.product_variant_id = ${existing.id}
        ) OR EXISTS (
          SELECT 1 FROM channels.channel_variant_overrides o
          WHERE o.product_variant_id = ${existing.id} AND o.is_listed <> 0
        ) OR EXISTS (
          SELECT 1 FROM channels.channel_allocation_rules r
          WHERE r.product_variant_id = ${existing.id}
        )
      ) AS channel_allocation_configuration,
      EXISTS (
        SELECT 1 FROM channels.channel_variant_availability_sync a
        WHERE a.product_variant_id = ${existing.id} AND a.desired_active = true
      ) AS active_channel_availability,
      EXISTS (
        SELECT 1 FROM dropship.dropship_vendor_listings l
        WHERE l.product_variant_id = ${existing.id}
      ) OR EXISTS (
        SELECT 1 FROM dropship.dropship_vendor_variant_overrides o
        WHERE o.product_variant_id = ${existing.id}
      ) AS dropship_listing,
      EXISTS (
        SELECT 1
        FROM marketplace.listing_publication_members m
        JOIN marketplace.listing_publications p ON p.id = m.publication_id
        WHERE m.product_variant_id = ${existing.id}
          AND m.disposition = 'included'
          AND p.status IN ('planned', 'staged', 'active')
      ) AS active_marketplace_publication,
      EXISTS (
        SELECT 1 FROM inventory.inventory_publication_outbox o
        WHERE o.product_variant_id = ${existing.id}
          AND o.state NOT IN ('verified', 'dead_letter', 'superseded', 'cancelled')
      ) AS pending_inventory_publication,
      (
        EXISTS (
          SELECT 1
          FROM wms.order_items oi
          JOIN wms.orders o ON o.id = oi.order_id
          JOIN catalog.product_variants pv ON pv.sku = oi.sku
          WHERE pv.id = ${existing.id}
            AND o.warehouse_status NOT IN ('shipped', 'completed', 'cancelled', 'voided')
            AND oi.status <> 'cancelled'
            AND oi.fulfilled_quantity < oi.quantity
        ) OR EXISTS (
          SELECT 1
          FROM oms.oms_order_lines ol
          JOIN oms.oms_orders o ON o.id = ol.order_id
          WHERE ol.product_variant_id = ${existing.id}
            AND o.status NOT IN ('shipped', 'delivered', 'cancelled', 'refunded')
        )
      ) AS open_customer_order
  `);
  const row = rowsOf<ExposureRow>(result)[0];
  if (!row) {
    throw new Error("Variant sales eligibility dependency query returned no row");
  }
  for (const blocker of [
    "active_channel_feed",
    "channel_listing",
    "channel_allocation_configuration",
    "active_channel_availability",
    "dropship_listing",
    "active_marketplace_publication",
    "pending_inventory_publication",
    "open_customer_order",
  ] as const) {
    if (row[blocker]) blockers.push(blocker);
  }

  if (blockers.length > 0) throw new VariantSalesEligibilityError(blockers);
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
