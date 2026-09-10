import type { Pool } from "pg";
import { resolveDropshipOmsChannelIdWithClient } from "./dropship-order-intake.repository";

/** Same identity as order intake; a quote may precede initial OMS setup. An
 * explicitly invalid binding or ambiguous channel must never fall back. */
export async function resolveDropshipPackagingChannel(
  pool: Pool,
): Promise<number | null> {
  try {
    return await resolveDropshipOmsChannelIdWithClient(pool);
  } catch (error) {
    if (
      (error as { code?: string }).code ===
      "DROPSHIP_OMS_CHANNEL_CONFIG_REQUIRED"
    )
      return null;
    throw error;
  }
}
