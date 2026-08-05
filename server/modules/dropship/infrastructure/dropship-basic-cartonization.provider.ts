import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipCartonizationProvider,
  DropshipCartonizationRequest,
  DropshipCartonizationResult,
} from "../application/dropship-cartonization-provider";
import {
  cartonizeDropshipItems,
  type DropshipBoxCatalogEntry,
  type DropshipPackageProfile,
} from "../domain/shipping-quote";
import { CARTONIZE_ENGINE } from "../../cartonization/domain/cartonize";

const BASIC_DROPSHIP_CARTONIZATION_ENGINE = CARTONIZE_ENGINE;

// catalog.product_variants weight/dim columns are numeric(10,2) since
// migration 184; the pg driver returns numerics as strings, so the SELECT
// casts to float8 to keep row types numeric end-to-end.
interface PackageProfileRow {
  product_variant_id: number;
  sku: string | null;
  weight_grams: number | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  shipping_group_code: string | null;
  ships_in_own_container: boolean;
  max_units_per_package: number | null;
  default_carrier: string | null;
  default_service: string | null;
  default_box_id: number | null;
}

interface BoxRow {
  id: number;
  code: string;
  name: string;
  length_mm: number;
  width_mm: number;
  height_mm: number;
  tare_weight_grams: number;
  max_weight_grams: number | null;
  is_active: boolean;
}

export class BasicDropshipCartonizationProvider implements DropshipCartonizationProvider {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async cartonize(input: DropshipCartonizationRequest): Promise<DropshipCartonizationResult> {
    const productVariantIds = input.items.map((item) => item.productVariantId);
    const [packageProfiles, boxes] = await Promise.all([
      this.listPackageProfiles(productVariantIds),
      this.listActiveBoxes(),
    ]);

    const result = cartonizeDropshipItems({
      items: input.items,
      packageProfiles,
      boxes,
    });

    return {
      packages: result.packages,
      engine: BASIC_DROPSHIP_CARTONIZATION_ENGINE,
      warnings: result.warnings.map(formatPackagingWarning),
      packagingWarnings: result.warnings,
    };
  }

  private async listPackageProfiles(productVariantIds: readonly number[]): Promise<DropshipPackageProfile[]> {
    if (productVariantIds.length === 0) {
      return [];
    }

    const client = await this.dbPool.connect();
    try {
      // Physical facts come from catalog.product_variants (canonical source);
      // dropship.dropship_package_profiles supplies only channel defaults
      // (carrier/service/box) via LEFT JOIN. Variants with incomplete package
      // data deliberately flow through — the domain degrades them to
      // weight-only packages with warnings instead of blocking the quote.
      const result = await client.query<PackageProfileRow>(
        `SELECT pv.id AS product_variant_id,
                pv.sku,
                pv.weight_grams::float8 AS weight_grams,
                pv.length_mm::float8 AS length_mm,
                pv.width_mm::float8 AS width_mm,
                pv.height_mm::float8 AS height_mm,
                sg.code AS shipping_group_code,
                pv.ships_in_own_container,
                pv.max_units_per_package,
                pp.default_carrier,
                pp.default_service,
                pp.default_box_id
         FROM catalog.product_variants pv
         INNER JOIN catalog.products p
           ON p.id = pv.product_id
         LEFT JOIN catalog.shipping_groups sg
           ON sg.id = p.shipping_group_id
         LEFT JOIN dropship.dropship_package_profiles pp
           ON pp.product_variant_id = pv.id
          AND pp.is_active = true
         WHERE pv.id = ANY($1::int[])`,
        [productVariantIds],
      );
      return result.rows.map(mapPackageProfileRow);
    } finally {
      client.release();
    }
  }

  private async listActiveBoxes(): Promise<DropshipBoxCatalogEntry[]> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<BoxRow>(
        `SELECT id, code, name, length_mm, width_mm, height_mm,
                tare_weight_grams, max_weight_grams, is_active
         FROM dropship.dropship_box_catalog
         WHERE is_active = true
         ORDER BY id ASC`,
      );
      return result.rows.map(mapBoxRow);
    } finally {
      client.release();
    }
  }
}

function mapPackageProfileRow(row: PackageProfileRow): DropshipPackageProfile {
  return {
    productVariantId: row.product_variant_id,
    sku: row.sku,
    weightGrams: row.weight_grams,
    lengthMm: row.length_mm,
    widthMm: row.width_mm,
    heightMm: row.height_mm,
    shippingGroupCode: row.shipping_group_code,
    shipsInOwnContainer: row.ships_in_own_container,
    maxUnitsPerPackage: row.max_units_per_package,
    defaultCarrier: row.default_carrier,
    defaultService: row.default_service,
    defaultBoxId: row.default_box_id,
  };
}

function mapBoxRow(row: BoxRow): DropshipBoxCatalogEntry {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    lengthMm: row.length_mm,
    widthMm: row.width_mm,
    heightMm: row.height_mm,
    tareWeightGrams: row.tare_weight_grams,
    maxWeightGrams: row.max_weight_grams,
    isActive: row.is_active,
  };
}

function formatPackagingWarning(warning: {
  code: string;
  reason: string;
  productVariantIds: number[];
  message: string;
}): string {
  return `${warning.code}:${warning.reason} variants=[${warning.productVariantIds.join(",")}] ${warning.message}`;
}
