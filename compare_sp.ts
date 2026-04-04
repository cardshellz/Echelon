import 'dotenv/config';
import { listSellingPlanGroups } from './server/modules/subscriptions/selling-plan.service.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function run() {
  console.log("=== LIVE SHOPIFY SELLING PLANS ===");
  try {
    const liveGroups = await listSellingPlanGroups();
    liveGroups.forEach(group => {
      console.log(`Group: ${group.name} (${group.id})`);
      group.sellingPlans?.edges?.forEach((e: any) => {
        console.log(`  Plan: ${e.node.name} -> ${e.node.id}`);
      });
    });

    console.log("\n=== DATABASE SELLING PLAN MAP ===");
    const result = await pool.query("SELECT plan_name, shopify_selling_plan_gid FROM membership.selling_plan_map");
    result.rows.forEach(r => {
      console.log(`  DB Plan: ${r.plan_name} -> ${r.shopify_selling_plan_gid}`);
    });

  } catch(e) {
    console.error(e);
  }
  process.exit(0);
}
run();
