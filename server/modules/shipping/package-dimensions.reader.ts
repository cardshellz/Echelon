import type { Pool } from "pg";
import { z } from "zod";
import type { StoredShippingPackageDimensions } from "@shared/shipping/package-dimensions";
import { resolveShippingPackageDimensions } from "./package-dimensions.domain";

const inputSchema = z.object({
  provider: z.literal("shipstation"),
  providerPhysicalShipmentId: z.string().regex(/^[1-9]\d*$/).max(16).refine(value => Number.isSafeInteger(Number(value))),
  trackingNumber: z.string().min(1).max(200).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)),
}).strict();
export type ShippingPackageDimensionIdentity = z.infer<typeof inputSchema>;
const factsSchema = z.object({ labelStatus: z.string(), labelDirection: z.string(), trackingNumber: z.string(),
  recorded: z.boolean(), measurement: z.unknown(), evidence: z.unknown() }).strict();

/** Shipping's published read surface. The caller must first verify the package's
 * allocation to its order; a SKU, plan or customer-supplied tracking is not proof.
 * Uses immutable observed measurements, never current carton/catalog dimensions. */
export class ShippingPackageDimensionsReader {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async read(raw: ShippingPackageDimensionIdentity): Promise<StoredShippingPackageDimensions> {
    const input = inputSchema.parse(raw);
    const result = await this.pool.query(`SELECT label.label_status AS "labelStatus",label.label_direction AS "labelDirection",label.tracking_number AS "trackingNumber",
        label.metadata ? 'packageDimensions' AS recorded,
        label.metadata->'packageDimensions' AS measurement,event.sanitized_payload->'packageDimensions' AS evidence
      FROM wms.shipping_provider_labels label
      LEFT JOIN wms.shipping_provider_label_events event ON event.shipping_provider_label_id=label.id
        AND event.event_hash=label.metadata #>> '{packageDimensions,eventHash}'
      WHERE label.provider=$1 AND label.provider_label_id=$2`, [input.provider, input.providerPhysicalShipmentId]);
    if (result.rows.length === 0) return resolveShippingPackageDimensions(null, input.trackingNumber);
    if (result.rows.length !== 1) return { status: "unusable" };
    const facts = factsSchema.parse(result.rows[0]);
    return resolveShippingPackageDimensions({ ...facts, measurement: facts.measurement, evidence: facts.evidence }, input.trackingNumber);
  }
}
