import type { Pool } from "pg";
import { z } from "zod";
import { customerReturnDimensionsSchema, type CustomerReturnBoxOption } from "@shared/returns/customer-return-parcel";
import type { CustomerReturnBoxMeasurements } from "../application/customer-return-box-measurements.ports";
import { projectCustomerReturnOriginalBoxCandidates, customerReturnBoxSourceFingerprint } from "../application/customer-return-live-packaging";
import type { CustomerReturnLocalInspectionSnapshot } from "../application/customer-return-local-inspection.ports";

const keySchema = z.object({ channelId: z.number().int().positive().safe(), boxId: z.string().regex(/^box-[a-f0-9]{64}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Writes are called by the background projection worker only. Customer reads
 * can reuse saved facts but cannot persist a provider lookup as a GET side effect. */
export class PostgresCustomerReturnBoxMeasurements implements CustomerReturnBoxMeasurements {
  constructor(private readonly pool: Pick<Pool, "query">) {}
  async read(raw: Parameters<CustomerReturnBoxMeasurements["read"]>[0]) {
    const key = keySchema.parse(raw);
    const result = await this.pool.query(`SELECT dimensions FROM returns.customer_return_box_measurements
      WHERE channel_id=$1 AND box_id=$2 AND source_fingerprint=$3`, [key.channelId, key.boxId, key.sourceFingerprint]);
    return result.rows.length === 1 ? customerReturnDimensionsSchema.parse(result.rows[0].dimensions) : null;
  }
  async retain(local: CustomerReturnLocalInspectionSnapshot, boxes: readonly CustomerReturnBoxOption[], now: Date): Promise<void> {
    z.date().parse(now);
    const candidates = projectCustomerReturnOriginalBoxCandidates(local);
    for (const box of boxes) {
      const source = candidates.find(candidate => candidate.id === box.id);
      if (!source) throw new Error("RETURN_BOX_MEASUREMENT_SOURCE_MISMATCH");
      const key = keySchema.parse({ channelId: local.shop.channelId, boxId: box.id, sourceFingerprint: customerReturnBoxSourceFingerprint(source) });
      const dimensions = customerReturnDimensionsSchema.parse(box.dimensions);
      await this.pool.query(`INSERT INTO returns.customer_return_box_measurements(channel_id,box_id,source_fingerprint,dimensions,verified_at)
        VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(channel_id,box_id) DO UPDATE SET
        source_fingerprint=EXCLUDED.source_fingerprint,dimensions=EXCLUDED.dimensions,verified_at=EXCLUDED.verified_at`,
      [key.channelId, key.boxId, key.sourceFingerprint, JSON.stringify(dimensions), now]);
    }
  }
}
