import { sql, type SQL } from "drizzle-orm";
import { channelMerchandiseAuthorityChannels } from "./channel-merchandise-rollout";

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
  const allowed = channelMerchandiseAuthorityChannels();
  const channelIds = sql`ARRAY[${sql.join(
    allowed.map((id) => sql`${id}`),
    sql`, `,
  )}]::integer[]`;
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
