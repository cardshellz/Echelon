import { Pool } from 'pg';
import 'dotenv/config';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function findPriority() {
  try {
    const res = await pool.query("SELECT name, tier, tier_level, features FROM plans");
    console.log("Plan Data (Checking for priority logic):");
    res.rows.forEach(plan => {
      console.log(`- Plan: ${plan.name} (Tier: ${plan.tier}, Level: ${plan.tier_level})`);
      console.log(`  Features: ${JSON.stringify(plan.features)}`);
    });
  } catch (err) {
    console.error("Error querying 'plans':", err);
  } finally {
    await pool.end();
  }
}

findPriority();
