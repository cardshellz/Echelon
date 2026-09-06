import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import type { ListingShippingEstimateContext, ListingShippingEstimateContextReader } from "../application/dropship-listing-shipping-estimate-service";
import { mapProcessingConfig } from "./dropship-order-processing.repository";

interface EstimateContextRow {
  vendor_id: number;
  store_connection_id: number;
  vendor_status: string;
  entitlement_status: string;
  store_status: string;
  config: Record<string, unknown> | null;
}

export class PgListingShippingEstimateContextReader implements ListingShippingEstimateContextReader {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadForMember(memberId: string, storeConnectionId: number): Promise<ListingShippingEstimateContext | null> {
    // Resolve ownership in the query. Never accept a vendor ID or warehouse from the browser.
    const result = await this.dbPool.query<EstimateContextRow>(
      `SELECT v.id AS vendor_id, sc.id AS store_connection_id,
              v.status AS vendor_status, v.entitlement_status,
              sc.status AS store_status, sc.config
       FROM dropship.dropship_vendors v
       INNER JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
       WHERE v.member_id = $1 AND sc.id = $2
       LIMIT 1`,
      [memberId, storeConnectionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    // Same origin and legacy config precedence used by automatic order processing.
    const config = mapProcessingConfig(row.config);
    return {
      vendorId: row.vendor_id,
      storeConnectionId: row.store_connection_id,
      vendorStatus: row.vendor_status,
      entitlementStatus: row.entitlement_status,
      storeStatus: row.store_status,
      defaultWarehouseId: config.defaultWarehouseId,
      warehouseConfigError: config.warehouseConfigError,
    };
  }
}
