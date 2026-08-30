import type { Pool } from "pg";

import { pool as defaultPool } from "../../../db";
import type { DropshipAtpProvider } from "../application/dropship-selection-atp-service";
import type {
  DropshipMarketplaceRegistrationOwnerRepository,
  DropshipRegistrationProductAccessRecord,
  DropshipRegistrationStoreConnectionRecord,
  DropshipRegistrationVariantRecord,
} from "../application/dropship-marketplace-registration-owner-reader";
import { MarketplaceListingRegistrationError } from "../../marketplace-listings/domain/registration-errors";
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";

interface StoreConnectionRow {
  id: number;
  vendor_id: number;
  platform: DropshipRegistrationStoreConnectionRecord["platform"];
  status: string;
  connection_config: Record<string, unknown> | null;
  marketplace_config: Record<string, unknown> | null;
}

interface ProductAccessRow {
  product_id: number;
  can_list: boolean;
}

interface ProductVariantRow {
  id: number;
  product_id: number;
  sku: string | null;
  is_active: boolean;
  units_per_variant: number;
  requires_shipping: boolean;
  track_inventory: boolean | null;
}

/**
 * Owner-owned, read-only registration repository.
 *
 * `canList` is deliberately historical ownership access, not current catalog
 * eligibility: it is true only when this vendor/store already owns a local
 * Dropship listing row for a variant in the product and that row has a stored
 * provider listing or offer identity. Listing status, catalog active flags,
 * current selection rules, and current quantity do not revoke that access.
 * This allows registration to capture stale or archived live publications
 * without granting one vendor access to another vendor's product listing.
 */
export class PgDropshipMarketplaceRegistrationOwnerRepository
  implements DropshipMarketplaceRegistrationOwnerRepository
{
  constructor(
    private readonly atp: DropshipAtpProvider,
    private readonly dbPool: Pool = defaultPool,
  ) {}

  async loadStoreConnection(
    storeConnectionId: number,
  ): Promise<DropshipRegistrationStoreConnectionRecord | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreConnectionRow>(
        `SELECT sc.id,
                sc.vendor_id,
                sc.platform,
                sc.status,
                sc.config AS connection_config,
                slc.marketplace_config
         FROM dropship.dropship_store_connections sc
         LEFT JOIN dropship.dropship_store_listing_configs slc
           ON slc.store_connection_id = sc.id
          AND slc.platform = sc.platform
          AND slc.is_active = true
         WHERE sc.id = $1`,
        [storeConnectionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        vendorId: row.vendor_id,
        platform: row.platform,
        status: row.status,
        marketplaceIds: uniqueMarketplaceIds(
          row.connection_config,
          row.marketplace_config,
        ),
      };
    } finally {
      client.release();
    }
  }

  async loadProductAccess(input: {
    vendorId: number;
    storeConnectionId: number;
    productId: number;
  }): Promise<DropshipRegistrationProductAccessRecord | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<ProductAccessRow>(
        `SELECT p.id AS product_id,
                EXISTS (
                  SELECT 1
                  FROM dropship.dropship_vendor_listings dvl
                  INNER JOIN catalog.product_variants listed_variant
                    ON listed_variant.id = dvl.product_variant_id
                  WHERE dvl.vendor_id = $1
                    AND dvl.store_connection_id = $2
                    AND listed_variant.product_id = p.id
                    AND (
                      NULLIF(BTRIM(dvl.external_listing_id), '') IS NOT NULL
                      OR NULLIF(BTRIM(dvl.external_offer_id), '') IS NOT NULL
                    )
                ) AS can_list
         FROM catalog.products p
         WHERE p.id = $3`,
        [input.vendorId, input.storeConnectionId, input.productId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        vendorId: input.vendorId,
        productId: row.product_id,
        canList: row.can_list === true,
      };
    } finally {
      client.release();
    }
  }

  async loadAllProductVariants(input: {
    storeConnectionId: number;
    productId: number;
  }): Promise<readonly DropshipRegistrationVariantRecord[]> {
    const client = await this.dbPool.connect();
    let rows: readonly ProductVariantRow[];
    try {
      const result = await client.query<ProductVariantRow>(
        `SELECT pv.id,
                pv.product_id,
                pv.sku,
                pv.is_active,
                pv.units_per_variant,
                pv.requires_shipping,
                pv.track_inventory
         FROM catalog.product_variants pv
         WHERE pv.product_id = $1
           AND pv.sales_eligibility = 'sellable'
         ORDER BY pv.position ASC, pv.id ASC`,
        [input.productId],
      );
      rows = result.rows;
    } finally {
      client.release();
    }

    if (rows.length === 0) return [];
    const atpByProductId = await this.atp.getBaseAtpByProductIds([
      input.productId,
    ]);
    const baseAtp = normalizeBaseAtp(
      atpByProductId.get(input.productId) ?? 0,
      input.productId,
    );
    return rows.map((row) => ({
      id: row.id,
      productId: row.product_id,
      sku: row.sku,
      isActive: row.is_active,
      availableQuantity: isInventoryManagedVariant({
        requiresShipping: row.requires_shipping,
        trackInventory: row.track_inventory,
      }) ? variantAtp(baseAtp, row) : 0,
    }));
  }
}

function uniqueMarketplaceIds(
  ...configs: readonly (Record<string, unknown> | null)[]
): readonly string[] {
  const ids = new Set<string>();
  for (const config of configs) {
    if (!config) continue;
    addMarketplaceId(ids, config.marketplaceId);
    if (Array.isArray(config.marketplaceIds)) {
      for (const value of config.marketplaceIds) addMarketplaceId(ids, value);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function addMarketplaceId(target: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  if (normalized) target.add(normalized);
}

function normalizeBaseAtp(value: number, productId: number): number {
  if (!Number.isFinite(value)) {
    throw registrationOwnerError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_ATP_INVALID",
      "Inventory ATP returned a non-finite product quantity.",
      { productId },
    );
  }
  const normalized = Math.max(0, Math.floor(value));
  if (!Number.isSafeInteger(normalized)) {
    throw registrationOwnerError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_ATP_INVALID",
      "Inventory ATP exceeded the supported safe-integer range.",
      { productId },
    );
  }
  return normalized;
}

function variantAtp(baseAtp: number, row: ProductVariantRow): number {
  if (!Number.isSafeInteger(row.units_per_variant) || row.units_per_variant <= 0) {
    throw registrationOwnerError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_UNITS_PER_VARIANT_INVALID",
      "A catalog variant has invalid units-per-variant data.",
      { productVariantId: row.id, unitsPerVariant: row.units_per_variant },
    );
  }
  const quantity = Math.floor(baseAtp / row.units_per_variant);
  if (!Number.isSafeInteger(quantity)) {
    throw registrationOwnerError(
      "DROPSHIP_MARKETPLACE_REGISTRATION_QUANTITY_INVALID",
      "The derived variant ATP exceeded the supported safe-integer range.",
      { productVariantId: row.id },
    );
  }
  return quantity;
}

function registrationOwnerError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>,
): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(code, message, context);
}
