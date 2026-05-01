import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipCartonizedPackage } from "../domain/shipping-quote";
import type {
  DropshipShippingRateProvider,
  DropshipShippingRateRequest,
  DropshipShippingRateResult,
  DropshipShippingZoneMatch,
} from "../application/dropship-shipping-rate-provider";

const CACHED_RATE_TABLE_PROVIDER = {
  name: "cached_admin_rate_table",
  version: "1",
} as const;

interface ZoneRuleRow {
  id: number;
  zone: string;
}

interface RateRow {
  rate_table_id: number;
  carrier: string;
  service: string;
  currency: string;
  rate_cents: string | number;
}

export class CachedRateTableDropshipShippingRateProvider implements DropshipShippingRateProvider {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async quoteRates(input: DropshipShippingRateRequest): Promise<DropshipShippingRateResult> {
    const client = await this.dbPool.connect();
    try {
      const zone = await findZoneWithClient(client, input);
      if (!zone) {
        throw new DropshipError(
          "DROPSHIP_SHIPPING_ZONE_REQUIRED",
          "Active dropship shipping zone data is required before quoting shipping.",
          {
            warehouseId: input.warehouseId,
            destinationCountry: input.destination.country,
            destinationRegion: input.destination.region,
            destinationPostalCode: input.destination.postalCode,
          },
        );
      }

      const rates = [];
      for (const carton of input.packages) {
        const row = await findRateForPackageWithClient(client, {
          warehouseId: input.warehouseId,
          zone: zone.zone,
          carton,
          quotedAt: input.quotedAt,
        });
        if (row) {
          rates.push({
            packageSequence: carton.packageSequence,
            rateTableId: row.rate_table_id,
            carrier: row.carrier,
            service: row.service,
            currency: row.currency,
            rateCents: Number(row.rate_cents),
          });
        }
      }

      return {
        zone,
        rates,
        provider: CACHED_RATE_TABLE_PROVIDER,
      };
    } finally {
      client.release();
    }
  }
}

async function findZoneWithClient(
  client: PoolClient,
  input: DropshipShippingRateRequest,
): Promise<DropshipShippingZoneMatch | null> {
  const result = await client.query<ZoneRuleRow>(
    `SELECT id, zone
     FROM dropship.dropship_zone_rules
     WHERE origin_warehouse_id = $1
       AND destination_country = $2
       AND is_active = true
       AND (destination_region IS NULL OR UPPER(destination_region) = $3)
       AND (postal_prefix IS NULL OR $4 LIKE UPPER(postal_prefix) || '%')
     ORDER BY priority DESC,
              LENGTH(COALESCE(postal_prefix, '')) DESC,
              (destination_region IS NULL) ASC,
              id ASC
     LIMIT 1`,
    [
      input.warehouseId,
      input.destination.country,
      input.destination.region,
      input.destination.postalCode,
    ],
  );
  const row = result.rows[0];
  return row ? { zoneRuleId: row.id, zone: row.zone } : null;
}

async function findRateForPackageWithClient(
  client: PoolClient,
  input: {
    warehouseId: number;
    zone: string;
    carton: DropshipCartonizedPackage;
    quotedAt: Date;
  },
): Promise<RateRow | null> {
  const result = await client.query<RateRow>(
    `SELECT
       rt.id AS rate_table_id,
       rt.carrier,
       rt.service,
       rt.currency,
       rr.rate_cents
     FROM dropship.dropship_rate_table_rows rr
     INNER JOIN dropship.dropship_rate_tables rt ON rt.id = rr.rate_table_id
     WHERE rt.status = 'active'
       AND rt.effective_from <= $1
       AND (rt.effective_to IS NULL OR rt.effective_to > $1)
       AND rr.destination_zone = $2
       AND (rr.warehouse_id = $3 OR rr.warehouse_id IS NULL)
       AND rr.min_weight_grams <= $4
       AND rr.max_weight_grams >= $4
       AND ($5::text IS NULL OR LOWER(rt.carrier) = LOWER($5))
       AND ($6::text IS NULL OR LOWER(rt.service) = LOWER($6))
     ORDER BY (rr.warehouse_id IS NULL) ASC,
              rr.rate_cents ASC,
              rt.effective_from DESC,
              rt.id ASC,
              rr.id ASC
     LIMIT 1`,
    [
      input.quotedAt,
      input.zone,
      input.warehouseId,
      input.carton.weightGrams,
      input.carton.requestedCarrier,
      input.carton.requestedService,
    ],
  );
  return result.rows[0] ?? null;
}
