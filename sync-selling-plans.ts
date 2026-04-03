import "dotenv/config";
import { pool } from "./server/db";

async function run() {
  console.log("Synchronizing selling plans from membership.selling_plan_map to public.selling_plan_groups...");
  
  try {
    const res = await pool.query("SELECT * FROM membership.selling_plan_map");
    const newPlans = res.rows;
    console.log(`Found ${newPlans.length} selling plans in Echelon's map.`);

    for (const p of newPlans) {
      const planIdStr = String(p.plan_id);
      await pool.query("DELETE FROM public.selling_plan_groups WHERE plan_id = $1", [planIdStr]);
      
      await pool.query(`
        INSERT INTO public.selling_plan_groups 
        (plan_id, name, shopify_selling_plan_group_id, shopify_selling_plan_id, merchant_code, billing_interval, is_active)
        VALUES ($1, $2, $3, $4, \'default\', $5, true)
        ON CONFLICT (shopify_selling_plan_group_id) DO UPDATE SET
          plan_id = EXCLUDED.plan_id,
          name = EXCLUDED.name,
          shopify_selling_plan_id = EXCLUDED.shopify_selling_plan_id,
          billing_interval = EXCLUDED.billing_interval
      `, [
        planIdStr,
        p.plan_name,
        p.shopify_selling_plan_group_gid,
        p.shopify_selling_plan_gid,
        p.billing_interval
      ]);
      console.log(`✅ Synced plan ${p.plan_name} (${planIdStr}) -> ${p.shopify_selling_plan_gid}`);
    }
    
    console.log(`\nSuccessfully synced ${newPlans.length} plans to Storefront DB!`);
  } catch (err) {
    console.error("Error syncing plans:", err);
  } finally {
    await pool.end();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
