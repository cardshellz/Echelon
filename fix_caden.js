import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function fix() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get .club plan ID
    const planRes = await client.query("SELECT id FROM membership.plans WHERE name = '.club'");
    if(planRes.rows.length === 0) throw new Error("No .club plan found");
    const clubPlanId = planRes.rows[0].id;

    // 2. Get member
    const memRes = await client.query("SELECT id FROM membership.members WHERE email ILIKE '%cadman5610%'");
    if(memRes.rows.length === 0) throw new Error("No cadman found");
    const memberId = memRes.rows[0].id;

    // 3. Update member
    await client.query("UPDATE membership.members SET plan_id = $1, tier = 'standard' WHERE id = $2", [clubPlanId, memberId]);

    // 4. Update member_subscriptions
    await client.query("UPDATE membership.member_subscriptions SET plan_id = $1, billing_interval = 'yearly', amount_paid_cents = 9900 WHERE member_id = $2", [clubPlanId, memberId]);

    // 5. Update subscription_contracts
    await client.query("UPDATE membership.subscription_contracts SET plan_id = $1 WHERE member_id = $2", [clubPlanId, memberId]);

    await client.query('COMMIT');
    console.log("Successfully fixed Caden Price's membership.");

  } catch (e) {
    await client.query('ROLLBACK');
    console.error("Error:", e);
  } finally {
    client.release();
    process.exit(0);
  }
}

fix();
