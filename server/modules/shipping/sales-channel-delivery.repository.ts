import type { Pool } from "pg";
import { z } from "zod";
import { packageHistoryHash } from "./package-history.domain";
import {
  salesChannelDeliveryEvidenceSchema,
  type SalesChannelDeliveryEvidence,
} from "./sales-channel-delivery.domain";

export interface SalesChannelDeliveryEvidenceStore {
  append(evidence: readonly SalesChannelDeliveryEvidence[]): Promise<void>;
}
export class PostgresSalesChannelDeliveryEvidenceStore
  implements SalesChannelDeliveryEvidenceStore
{
  constructor(private readonly pool: Pick<Pool, "query">) {}
  async append(raw: readonly SalesChannelDeliveryEvidence[]): Promise<void> {
    const evidence = z
      .array(salesChannelDeliveryEvidenceSchema)
      .max(201)
      .parse(raw);
    if (!evidence.length) return;
    const first = evidence[0];
    if (
      evidence.some(
        (event) =>
          event.omsOrderId !== first.omsOrderId ||
          event.channelId !== first.channelId ||
          event.externalOrderId !== first.externalOrderId ||
          event.externalCustomerId !== first.externalCustomerId ||
          event.providerReference !== first.providerReference ||
          event.trackingNumber !== first.trackingNumber ||
          event.fulfillmentId !== first.fulfillmentId ||
          event.nativeRevision !== first.nativeRevision ||
          event.providerObservationHash !== first.providerObservationHash,
      )
    )
      throw new Error("SALES_CHANNEL_DELIVERY_BATCH_MISMATCH");
    // One statement is atomic. The exact owner is checked again after provider
    // reads; immutable source hashes are rechecked against current history on read.
    const rows = evidence.map((e) => {
      const { observedAt: _observedAt, ...immutableEvent } = e;
      return { ...e, proofHash: packageHistoryHash(immutableEvent) };
    });
    const result = await this.pool.query(
      `WITH incoming AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS e("omsOrderId" bigint,"channelId" bigint,"externalOrderId" text,
        "externalCustomerId" text,"providerReference" text,"trackingNumber" text,"fulfillmentId" text,
        "nativeRevision" text,"providerObservationHash" text,"canonicalStatus" text,"occurredAt" timestamptz,
        "observedAt" timestamptz,"proofHash" text)
    ), verified AS (SELECT e.* FROM incoming e JOIN oms.oms_orders o ON o.id=e."omsOrderId" AND o.channel_id=e."channelId"
      AND replace(o.external_order_id,'gid://shopify/Order/','')=e."externalOrderId"
      AND (e."externalCustomerId" IS NULL OR replace(o.external_customer_id,'gid://shopify/Customer/','')=e."externalCustomerId"))
    INSERT INTO wms.sales_channel_delivery_evidence(oms_order_id,channel_id,external_order_id,provider_reference,tracking_number,
      fulfillment_id,native_revision,provider_observation_hash,canonical_status,occurred_at,observed_at,proof_hash,proof,actor)
    SELECT e."omsOrderId",e."channelId",e."externalOrderId",e."providerReference",e."trackingNumber",e."fulfillmentId",
      e."nativeRevision",e."providerObservationHash",e."canonicalStatus",e."occurredAt",e."observedAt",e."proofHash",
      ($1::jsonb->(ordinality-1)::int)-'proofHash','system:shipping-status-capture'
    FROM verified e JOIN jsonb_array_elements($1::jsonb) WITH ORDINALITY source(value,ordinality)
      ON source.value->>'proofHash'=e."proofHash"
    ON CONFLICT(proof_hash) DO NOTHING RETURNING proof_hash`,
      [JSON.stringify(rows)],
    );
    // A retry may insert zero rows. Distinguish that from an owner reassignment.
    if ((result.rowCount ?? 0) < new Set(rows.map((e) => e.proofHash)).size) {
      const existing = await this.pool.query(
        `SELECT proof_hash FROM wms.sales_channel_delivery_evidence WHERE proof_hash=ANY($1::text[])`,
        [rows.map((e) => e.proofHash)],
      );
      if (existing.rows.length !== new Set(rows.map((e) => e.proofHash)).size)
        throw new Error("SALES_CHANNEL_DELIVERY_OWNER_CHANGED");
    }
  }
}
