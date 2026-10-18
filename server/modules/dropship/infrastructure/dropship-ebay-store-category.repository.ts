import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipEbayStoreCategoryAssignment,
  DropshipEbayStoreCategoryContext,
  DropshipEbayStoreCategoryRepository,
} from "../application/dropship-ebay-store-category-service";

interface StoreContextRow {
  vendor_id: number;
  store_connection_id: number;
  platform: string;
  status: string;
}

interface AssignmentRow {
  product_variant_id: number;
  store_category_ids: unknown;
  store_category_names: unknown;
  updated_at: Date;
}

export class PgDropshipEbayStoreCategoryRepository implements DropshipEbayStoreCategoryRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipEbayStoreCategoryContext | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreContextRow>(
        `SELECT vendor_id, id AS store_connection_id, platform, status
         FROM dropship.dropship_store_connections
         WHERE vendor_id = $1 AND id = $2
         LIMIT 1`,
        [input.vendorId, input.storeConnectionId],
      );
      return result.rows[0] ? mapStoreContext(result.rows[0]) : null;
    } finally {
      client.release();
    }
  }

  async listAssignments(input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds?: readonly number[];
  }): Promise<DropshipEbayStoreCategoryAssignment[]> {
    if (input.productVariantIds && input.productVariantIds.length === 0) {
      return [];
    }
    const client = await this.dbPool.connect();
    try {
      return await listAssignmentsWithClient(client, input);
    } finally {
      client.release();
    }
  }
}

async function listAssignmentsWithClient(
  client: PoolClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds?: readonly number[];
  },
): Promise<DropshipEbayStoreCategoryAssignment[]> {
  const params: unknown[] = [input.vendorId, input.storeConnectionId];
  const variantFilter = input.productVariantIds
    ? " AND product_variant_id = ANY($3::int[])"
    : "";
  if (input.productVariantIds) params.push(input.productVariantIds);
  const result = await client.query<AssignmentRow>(
    `SELECT product_variant_id, store_category_ids, store_category_names, updated_at
     FROM dropship.dropship_ebay_store_category_assignments
     WHERE vendor_id = $1 AND store_connection_id = $2${variantFilter}
     ORDER BY product_variant_id ASC`,
    params,
  );
  return result.rows.map(mapAssignment);
}

function mapStoreContext(row: StoreContextRow): DropshipEbayStoreCategoryContext {
  return {
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    status: row.status,
  };
}

function mapAssignment(row: AssignmentRow): DropshipEbayStoreCategoryAssignment {
  const storeCategoryIds = parseStringArray(row.store_category_ids, "store_category_ids");
  const storeCategoryNames = parseStringArray(row.store_category_names, "store_category_names");
  if (storeCategoryIds.length !== storeCategoryNames.length) {
    throw new Error("Persisted eBay Store category ids and names are inconsistent.");
  }
  return {
    productVariantId: row.product_variant_id,
    storeCategoryIds,
    storeCategoryNames,
    updatedAt: row.updated_at,
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 2) {
    throw new Error(`Persisted ${field} must be an array of at most two values.`);
  }
  const values = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Persisted ${field} must contain non-empty strings.`);
    }
    return item.trim();
  });
  if (new Set(values).size !== values.length) {
    throw new Error(`Persisted ${field} must contain unique values.`);
  }
  return values;
}
