import * as dotenv from "dotenv";

dotenv.config();
process.env.PGSSLMODE = "require";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function run() {
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");

  const tables = [
    "access_rules", "portal_config", "product_collections",
    "notification_templates", "back_in_stock_sends", "back_in_stock_subscriptions",
    "collection_alert_notification_queue", "collection_alert_settings", "collection_alert_subscriptions",
    "member_current_membership", "member_shopify_customer_ids", "member_stats",
    "subscription_billing_attempts", "subscription_contracts", "subscription_events",
    "subscription_ledger", "selling_plan_groups",
    "plan_collection_exclusions", "plan_earning_rules", "plan_feature_grants",
    "plan_features", "plan_medal_benefits", "plan_redemption_rules", "plan_variant_overrides",
    "earning_activities", "member_earning_events", "member_medal_achievements",
    "member_referrals", "medal_benefit_grants", "redemption_options",
    "reward_ledger", "reward_medals", "reward_overrides", "reward_redemptions",
    "social_accounts", "social_action_verifications", "social_verifications",
    "token_transactions", "marketplace_exclusions"
  ];

  console.log(`Starting to shift ${tables.length} tables to membership schema...`);

  for (const table of tables) {
    // Check if it exists in public
    const res = await db.execute(sql.raw(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = '${table}'
    `));

    if (res.rows.length === 0) {
      console.log(`Skipping ${table}: Not found in public schema. (Might already be moved)`);
      continue;
    }

    try {
      const q = `ALTER TABLE public."${table}" SET SCHEMA membership;`;
      console.log(`Executing: ${q}`);
      await db.execute(sql.raw(q));
      console.log(`Success: Moved ${table}`);
    } catch (e: any) {
      console.error(`Failed to move ${table}:`, e.message);
    }
  }

  console.log("Migration finished.");
  process.exit();
}
run();
