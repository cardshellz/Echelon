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
  name: "basic_catalog_package_cartonization",
  version: "2",
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
        `SELECT pv.id AS product_variant_id,
                pv.weight_grams,
                pv.length_mm,
                pv.width_mm,
                pv.height_mm,
                COALESCE(pp.ship_alone, false) AS ship_alone,
                pp.default_carrier,
                pp.default_service,
                pp.default_box_id,
                pp.max_units_per_package
         FROM catalog.product_variants pv
         LEFT JOIN dropship.dropship_package_profiles pp
           ON pp.product_variant_id = pv.id
          AND pp.is_active = true
         WHERE pv.id = ANY($1::int[])
           AND pv.weight_grams > 0
           AND pv.length_mm > 0
           AND pv.width_mm > 0
           AND pv.height_mm > 0`,
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
