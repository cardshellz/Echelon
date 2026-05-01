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

const BASIC_DROPSHIP_CARTONIZATION_ENGINE = {
  name: "basic_db_package_profile_cartonization",
  version: "1",
} as const;

interface PackageProfileRow {
  product_variant_id: number;
  weight_grams: number;
  length_mm: number;
  width_mm: number;
  height_mm: number;
  ship_alone: boolean;
  default_carrier: string | null;
  default_service: string | null;
  default_box_id: number | null;
  max_units_per_package: number | null;
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

    return {
      packages: cartonizeDropshipItems({
        items: input.items,
        packageProfiles,
        boxes,
      }),
      engine: BASIC_DROPSHIP_CARTONIZATION_ENGINE,
      warnings: [],
    };
  }

  private async listPackageProfiles(productVariantIds: readonly number[]): Promise<DropshipPackageProfile[]> {
    if (productVariantIds.length === 0) {
      return [];
    }

    const client = await this.dbPool.connect();
    try {
      const result = await client.query<PackageProfileRow>(
        `SELECT product_variant_id, weight_grams, length_mm, width_mm, height_mm,
                ship_alone, default_carrier, default_service, default_box_id,
                max_units_per_package
         FROM dropship.dropship_package_profiles
         WHERE product_variant_id = ANY($1::int[])
           AND is_active = true`,
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
    weightGrams: row.weight_grams,
    lengthMm: row.length_mm,
    widthMm: row.width_mm,
    heightMm: row.height_mm,
    shipAlone: row.ship_alone,
    defaultCarrier: row.default_carrier,
    defaultService: row.default_service,
    defaultBoxId: row.default_box_id,
    maxUnitsPerPackage: row.max_units_per_package,
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
