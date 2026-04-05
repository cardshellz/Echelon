import { Pool } from 'pg';
import 'dotenv/config';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function dumpPlans() {
  try {
    const res = await pool.query("SELECT name, tier, tier_level, features FROM plans ORDER BY tier_level DESC");
    console.log("FULL PLAN DUMP:");
    res.rows.forEach(plan => {
      console.log(`--- ${plan.name} ---`);
      console.log(`Tier: ${plan.tier} | Level: ${plan.tier_level}`);
      console.log(`Features: ${JSON.stringify(plan.features, null, 2)}`);
    });
  } catch (err) {
    console.warn("Error dumping plans:", err);
  } finally {
    await pool.end();
  }
}

dumpPlans();
