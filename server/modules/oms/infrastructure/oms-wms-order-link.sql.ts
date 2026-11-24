import { sql, type SQL } from "drizzle-orm";

export interface WmsOmsOrderLinkColumns {
  source: SQL;
  omsFulfillmentOrderId: SQL;
  legacySourceTableId: SQL;
}

/**
 * Resolves the internal OMS order id stored on a WMS order without casting the
 * indexed OMS primary key to text. The direct OMS reference is authoritative;
 * the numeric legacy reference is used only when the direct reference is absent
 * or invalid.
 * Non-numeric provider identifiers intentionally resolve to NULL.
 */
export function wmsOmsOrderIdSql(columns: WmsOmsOrderLinkColumns): SQL {
  return sql`CASE
    WHEN ${columns.source} = 'oms'
      AND ${columns.omsFulfillmentOrderId} ~ '^[0-9]+$'
      AND LENGTH(${columns.omsFulfillmentOrderId}) <= 18
      THEN (${columns.omsFulfillmentOrderId})::bigint
    WHEN ${columns.legacySourceTableId} ~ '^[0-9]+$'
      AND LENGTH(${columns.legacySourceTableId}) <= 18
      THEN (${columns.legacySourceTableId})::bigint
    ELSE NULL
  END`;
}

export function wmsOmsOrderLinkSql(omsOrderId: SQL, columns: WmsOmsOrderLinkColumns): SQL {
  return sql`${omsOrderId} = ${wmsOmsOrderIdSql(columns)}`;
}
