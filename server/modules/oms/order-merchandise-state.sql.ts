import { sql, type SQL } from "drizzle-orm";
import { channelMerchandiseAuthorityChannels } from "./channel-merchandise-rollout";

function channelMerchandiseChannelIdsSql(): SQL {
  return sql`ARRAY[${sql.join(
    channelMerchandiseAuthorityChannels().map((id) => sql`${id}`),
    sql`, `,
  )}]::integer[]`;
}

/** Read/projection gate only: existing quantity and payment authority still
 * govern picking and dispatch. A financial refund is not a physical stop for
 * enabled channels; voided payment remains blocked on every channel. */
export function omsWarehouseFinancialStopSql(
  channelId: SQL,
  financialStatus: SQL,
): SQL {
  return sql`(COALESCE(${financialStatus}, '') = 'voided'
    OR (COALESCE(${financialStatus}, '') = 'refunded'
      AND NOT (COALESCE(${channelId}, 0) = ANY(${channelMerchandiseChannelIdsSql()}))))`;
}

/** One boundary for cancellation workers during the explicitly scoped rollout.
 * Enabled channels require commercial cancellation; disabled channels retain
 * their legacy financial stop until their own acceptance and activation. */
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
  const channelIds = channelMerchandiseChannelIdsSql();
  const financialStatuses = options.legacyFinancialStatuses ?? [];
  const financial = financialStatuses.length
    ? sql`OR ${relation}.financial_status IN (${sql.join(
        financialStatuses.map((value) => sql`${value}`),
        sql`, `,
      )})`
    : sql``;
  return sql`(${relation}.status='cancelled'
    ${options.includeShipped ? sql`OR ${relation}.status='shipped'` : sql``}
    OR (NOT (${relation}.channel_id=ANY(${channelIds}))
      AND (${relation}.status='refunded' ${financial})))`;
}
