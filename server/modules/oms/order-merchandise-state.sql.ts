import { sql, type SQL } from "drizzle-orm";
import { channelMerchandiseCapabilitySql } from "./infrastructure/channel-merchandise-policy";

/** Read/projection gate only: existing quantity and payment authority still
 * govern picking and dispatch. A financial refund is not a physical stop for
 * Shopify channels; voided payment remains blocked on every channel. */
export function omsWarehouseFinancialStopSql(
  channelId: SQL,
  financialStatus: SQL,
): SQL {
  return sql`(COALESCE(${financialStatus}, '') = 'voided'
    OR (COALESCE(${financialStatus}, '') = 'refunded'
      AND NOT (${channelMerchandiseCapabilitySql(channelId)})))`;
}

/** Shopify cancellation workers require commercial cancellation. Providers
 * without the merchandise adapter retain their existing financial stop. */
export function omsWarehouseCancellationSql(
  alias: string,
  options: {
    legacyFinancialStatuses?: readonly string[];
    includeShipped?: boolean;
  } = {},
): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias))
    throw new Error("Invalid internal OMS query alias.");
  const relation = sql.identifier(alias);
  const usesChannelQuantities = channelMerchandiseCapabilitySql(sql`${relation}.channel_id`);
  const financialStatuses = options.legacyFinancialStatuses ?? [];
  const financial = financialStatuses.length
    ? sql`OR ${relation}.financial_status IN (${sql.join(
        financialStatuses.map((value) => sql`${value}`),
        sql`, `,
      )})`
    : sql``;
  return sql`(${relation}.status='cancelled'
    ${options.includeShipped ? sql`OR ${relation}.status='shipped'` : sql``}
    OR (NOT (${usesChannelQuantities})
      AND (${relation}.status='refunded' ${financial})))`;
}
