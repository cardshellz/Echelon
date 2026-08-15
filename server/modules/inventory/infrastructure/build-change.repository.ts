import { sql } from "drizzle-orm";

type QueryDb = {
  execute: (query: unknown) => Promise<{ rows: any[] }>;
};

export class BuildChangeRepository {
  constructor(private readonly db: QueryDb) {}

  async listAffectedVariantIds(buildOrderId: number): Promise<number[]> {
    const result = await this.db.execute(sql`
      SELECT output_variant_id AS variant_id
      FROM inventory.build_orders
      WHERE id = ${buildOrderId}
      UNION
      SELECT component_variant_id AS variant_id
      FROM inventory.build_order_components
      WHERE build_order_id = ${buildOrderId}
      ORDER BY variant_id
    `);
    return result.rows.map((row) => Number(row.variant_id));
  }
}

export function createBuildChangeRepository(db: QueryDb): BuildChangeRepository {
  return new BuildChangeRepository(db);
}
