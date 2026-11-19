import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  parseShipmentFact, ShipmentFactError, shipmentFactContentHash, shipmentVoidFactSchema,
  type ShipmentFact, type ShipmentVoidFact,
} from "./shipment-fact.domain";

export interface RecordedShipment {
  shipmentId: number;
  /** False when the same fact was already saved (a safe replay). */
  created: boolean;
}

export interface ShippedUnits {
  omsOrderLineId: number;
  shippedQuantity: number;
}

const idRow = z.object({ id: z.coerce.number().int().positive().safe() });
const existingRow = idRow.extend({ content_hash: z.string() });
const shippedRow = z.object({
  oms_order_line_id: z.coerce.number().int().positive().safe(),
  shipped_quantity: z.coerce.number().int().min(0).safe(),
});

/**
 * The only writer of `shipping.shipments`, `shipping.shipment_items` and
 * `shipping.shipment_voids`. Those tables are add-only (the database rejects
 * UPDATE and DELETE), so every method either inserts or reports what is there.
 */
export class ShipmentFactRepository {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  /**
   * Save a shipment fact. Idempotent on (engine, engineShipmentId): saving the
   * same report again returns the existing shipment. A different report for an
   * already-saved shipment is a conflict and is never applied.
   */
  async record(raw: ShipmentFact): Promise<RecordedShipment> {
    const fact = parseShipmentFact(raw);
    const contentHash = shipmentFactContentHash(fact);
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO shipping.shipments
           (engine, engine_shipment_id, ship_date, carrier, service_code, tracking_number, source, content_hash)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8)
         ON CONFLICT (engine, engine_shipment_id) DO NOTHING
         RETURNING id`,
        [fact.engine, fact.engineShipmentId, fact.shipDate, fact.carrier, fact.serviceCode, fact.trackingNumber,
          fact.source, contentHash],
      );
      if (inserted.rows.length === 0) {
        const existing = existingRow.parse((await client.query(
          "SELECT id, content_hash FROM shipping.shipments WHERE engine=$1 AND engine_shipment_id=$2",
          [fact.engine, fact.engineShipmentId],
        )).rows[0]);
        if (existing.content_hash !== contentHash) {
          throw new ShipmentFactError(
            "SHIPMENT_FACT_CONFLICT",
            "The engine reported different contents for a shipment that is already recorded.",
            { engine: fact.engine, engineShipmentId: fact.engineShipmentId, shipmentId: existing.id },
          );
        }
        return { shipmentId: existing.id, created: false };
      }
      const shipmentId = idRow.parse(inserted.rows[0]).id;
      if (fact.items.length > 0) {
        await client.query(
          `INSERT INTO shipping.shipment_items
             (shipment_id, line_number, channel_line_ref, oms_order_line_id, sku, quantity, purpose)
           SELECT $1, item.line_number, item.channel_line_ref, item.oms_order_line_id, item.sku, item.quantity, item.purpose
           FROM jsonb_to_recordset($2::jsonb) AS item(
             line_number integer, channel_line_ref text, oms_order_line_id bigint, sku text, quantity integer, purpose text)
           ORDER BY item.line_number`,
          [shipmentId, JSON.stringify(fact.items.map((item) => ({
            line_number: item.lineNumber, channel_line_ref: item.channelLineRef,
            oms_order_line_id: item.omsOrderLineId, sku: item.sku, quantity: item.quantity, purpose: item.purpose,
          })))],
        );
      }
      return { shipmentId, created: true };
    });
  }

  /**
   * Record that the engine voided a shipment. Idempotent: a shipment is voided
   * at most once. Returns whether this call recorded the void.
   */
  async recordVoid(raw: ShipmentVoidFact): Promise<{ shipmentId: number; created: boolean }> {
    const parsed = shipmentVoidFactSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ShipmentFactError("SHIPMENT_FACT_INVALID", "Shipment void is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const fact = parsed.data;
    return this.transaction(async (client) => {
      const shipment = (await client.query(
        "SELECT id FROM shipping.shipments WHERE engine=$1 AND engine_shipment_id=$2",
        [fact.engine, fact.engineShipmentId],
      )).rows[0];
      if (!shipment) {
        throw new ShipmentFactError("SHIPMENT_FACT_NOT_FOUND", "Cannot void a shipment that is not recorded.", {
          engine: fact.engine, engineShipmentId: fact.engineShipmentId,
        });
      }
      const shipmentId = idRow.parse(shipment).id;
      const inserted = await client.query(
        `INSERT INTO shipping.shipment_voids (shipment_id, void_date) VALUES ($1,$2::date)
         ON CONFLICT (shipment_id) DO NOTHING RETURNING shipment_id`,
        [shipmentId, fact.voidDate],
      );
      return { shipmentId, created: inserted.rows.length > 0 };
    });
  }

  /**
   * Units shipped for each requested purchased line: the units of that line in
   * packages that shipped and were not voided. Lines with nothing shipped are
   * returned with zero. Read-only.
   */
  async shippedUnits(omsOrderLineIds: readonly number[]): Promise<ShippedUnits[]> {
    const ids = z.array(z.number().int().positive().safe()).max(10_000).parse(omsOrderLineIds);
    if (ids.length === 0) return [];
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT requested.id AS oms_order_line_id, COALESCE(shipped.shipped_quantity, 0) AS shipped_quantity
         FROM unnest($1::bigint[]) AS requested(id)
         LEFT JOIN shipping.shipped_units_by_order_line shipped ON shipped.oms_order_line_id = requested.id
         ORDER BY requested.id`,
        [[...new Set(ids)]],
      );
      return z.array(shippedRow).parse(result.rows).map((row) => ({
        omsOrderLineId: row.oms_order_line_id, shippedQuantity: row.shipped_quantity,
      }));
    } finally {
      client.release();
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { destroy = true; }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}
