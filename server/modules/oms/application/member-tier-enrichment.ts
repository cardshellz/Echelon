/**
 * Member Tier Enrichment
 *
 * Lightweight service to populate oms_orders.member_tier from Shellz Club
 * Only stores tier at time of order (historical snapshot for analytics)
 */

import { db as echelonDb, pool as shellzClubDb } from "../../../db";
import { omsOrders } from "../../../../shared/schema/oms.schema";
import { eq, isNull } from "drizzle-orm";
import { logger } from "../../../platform/observability/logger";

interface MemberTierLookup {
  tier: string | null;
}

/**
 * Look up member's current tier by email
 */
async function getMemberTierByEmail(email: string): Promise<string | null> {
  if (!email) return null;

  try {
    const result = await shellzClubDb.query<MemberTierLookup>(`
      SELECT p.name as tier
      FROM membership.members m
      JOIN member_current_membership mcm ON mcm.member_id = m.id
      JOIN membership.plans p ON p.id = mcm.plan_id
      WHERE LOWER(m.email) = LOWER($1)
      AND mcm.status = 'active'
      LIMIT 1
    `, [email]);

    return result.rows[0]?.tier || null;
  } catch (err) {
    logger.error("oms.member_tier_enrichment", { message: `Failed to lookup tier for ${email}:`, error: err });
    return null;
  }
}

/**
 * Enrich an OMS order with member tier
 * Non-blocking - logs errors but doesn't fail order ingestion
 */
export async function enrichOrderWithMemberTier(orderId: number, customerEmail: string): Promise<void> {
  if (!customerEmail) {
    logger.info("oms.member_tier_enrichment", { message: `[Member Tier] Order ${orderId} - no customer email, skipping enrichment` });
    return;
  }

  try {
    const tier = await getMemberTierByEmail(customerEmail);

    if (tier) {
      await echelonDb
        .update(omsOrders)
        .set({ memberTier: tier })
        .where(eq(omsOrders.id, orderId));

      logger.info("oms.member_tier_enrichment", { message: `[Member Tier] Order ${orderId} enriched: ${tier}` });
    } else {
      logger.info("oms.member_tier_enrichment", { message: `[Member Tier] Order ${orderId} - ${customerEmail} is not a member` });
    }
  } catch (err) {
    logger.error("oms.member_tier_enrichment", { message: `[Member Tier] Failed to enrich order ${orderId}:`, error: err });
    // Non-blocking - don't throw
  }
}

/**
 * Backfill member tiers for existing orders
 * Run once to populate historical data
 */
export async function backfillMemberTiers(limit = 100): Promise<number> {
  logger.info("oms.member_tier_enrichment", { message: `[Member Tier] Starting backfill (limit: ${limit})` });

  const ordersToEnrich = await echelonDb
    .select({ id: omsOrders.id, customerEmail: omsOrders.customerEmail })
    .from(omsOrders)
    .where(isNull(omsOrders.memberTier))
    .limit(limit);

  let enriched = 0;

  for (const order of ordersToEnrich) {
    if (order.customerEmail) {
      await enrichOrderWithMemberTier(order.id, order.customerEmail);
      enriched++;
    }
  }

  logger.info("oms.member_tier_enrichment", { message: `[Member Tier] Backfill complete: ${enriched}/${ordersToEnrich.length} enriched` });
  return enriched;
}
