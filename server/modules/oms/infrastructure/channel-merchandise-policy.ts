import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  CHANNEL_MERCHANDISE_PROVIDER,
  usesChannelMerchandiseQuantities,
} from "../domain/channel-merchandise-policy";

const channelIdSchema = z.number().int().positive().max(2_147_483_647);
const providerRowsSchema = z
  .array(z.object({ provider: z.string().min(1) }))
  .length(1);

export type ChannelMerchandiseCapabilityReader = (
  channelId: number,
) => boolean | Promise<boolean>;

export class ChannelMerchandiseProviderUnavailable extends Error {
  readonly code = "CHANNEL_MERCHANDISE_PROVIDER_UNAVAILABLE";
  constructor(readonly channelId: number, cause: unknown) {
    super("The order's sales-channel provider could not be verified.", { cause });
  }
}

/** Resolve persisted provider identity, never environment flags or channel IDs.
 * Missing/unreadable identity must not fall back to refund-based cancellation. */
export async function readChannelMerchandiseCapability(
  database: { execute(statement: SQL): Promise<{ rows: unknown[] }> },
  rawChannelId: number,
): Promise<boolean> {
  const channelId = channelIdSchema.parse(rawChannelId);
  try {
    const result = await database.execute(sql`
      SELECT provider FROM channels.channels WHERE id=${channelId}
    `);
    const [channel] = providerRowsSchema.parse(result.rows);
    return usesChannelMerchandiseQuantities(channel.provider);
  } catch (cause) {
    throw new ChannelMerchandiseProviderUnavailable(channelId, cause);
  }
}

/** SQL projection of the same provider capability for bounded worker/read queries. */
export function channelMerchandiseCapabilitySql(channelId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM channels.channels merchandise_channel
    WHERE merchandise_channel.id=${channelId}
      AND merchandise_channel.provider=${CHANNEL_MERCHANDISE_PROVIDER})`;
}
