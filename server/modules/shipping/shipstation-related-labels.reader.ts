import type { Pool } from "pg";
import { z } from "zod";
import {
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
} from "./package-allocation-authority-discovery.query";

const MAX_RELATED_LABELS = 50;
const providerId = z.string().regex(/^[1-9]\d*$/).refine(value => Number.isSafeInteger(Number(value)));
const selectionSchema = z.object({
  providerLabelId: providerId,
  providerOrderId: providerId.nullable(),
  sourceWmsShipmentItemIds: z.array(z.number().int().positive().max(2_147_483_647)).max(500),
});
const identitySchema = z.object({
  providerLabelId: providerId,
  providerOrderId: providerId.nullable(),
  trackingNumber: z.string().trim().min(1).max(200),
});

export type ShipStationRelatedLabelIdentity = z.infer<typeof identitySchema>;
export interface ShipStationRelatedLabelReader {
  findRelatedActiveLabels(selection: z.infer<typeof selectionSchema>): Promise<readonly ShipStationRelatedLabelIdentity[]>;
}

/** Read-only shipping-owner port. Relationships locate candidates for a provider
 * refresh; they do not establish that a label is void or grant item authority. */
export function createShipStationRelatedLabelReader(pool: Pick<Pool, "connect">): ShipStationRelatedLabelReader {
  return {
    async findRelatedActiveLabels(rawSelection) {
      const selection = selectionSchema.parse(rawSelection);
      if (selection.sourceWmsShipmentItemIds.length === 0 && selection.providerOrderId === null) return [];
      const db = await pool.connect();
      try {
        let discoveredIds: string[] = [];
        if (selection.sourceWmsShipmentItemIds.length > 0) {
          const discovery = await db.query(PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
            [selection.sourceWmsShipmentItemIds, PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES + 1]);
          discoveredIds = discovery.rows.flatMap(row => row.shipping_provider_label_id === null
            ? [] : [providerId.parse(row.shipping_provider_label_id)]);
          if (discoveredIds.length > PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES) {
            throw Object.assign(new Error("Related label discovery exceeded its bounded scope"),
              { code: "SHIPSTATION_RELATED_LABEL_LIMIT" });
          }
        }
        // Reuse the indexed source/request/engine relationships, including combined
        // packages. Exact provider order identity also finds not-yet-linked labels.
        // Do not match SKU, order number, tracking alone, or an assumed store.
        const result = await db.query(`SELECT
          provider_label_id AS "providerLabelId", provider_order_id AS "providerOrderId",
          tracking_number AS "trackingNumber"
        FROM wms.shipping_provider_labels
        WHERE provider = 'shipstation' AND label_direction = 'outbound' AND label_status = 'active'
          AND provider_label_id <> $1
          AND (id = ANY($2::bigint[]) OR provider_order_id = $3::text)
        ORDER BY id LIMIT $4`,
        [selection.providerLabelId, discoveredIds, selection.providerOrderId, MAX_RELATED_LABELS + 1]);
        if (result.rows.length > MAX_RELATED_LABELS) {
          throw Object.assign(new Error("Related label refresh exceeded its bounded scope"),
            { code: "SHIPSTATION_RELATED_LABEL_LIMIT" });
        }
        return result.rows.map(row => identitySchema.parse(row));
      } finally {
        // Candidate discovery ends before any provider request starts.
        db.release();
      }
    },
  };
}
