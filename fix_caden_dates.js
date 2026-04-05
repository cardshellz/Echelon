import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function run() {
  const nextYear = new Date('2027-04-02T00:00:00Z');
  
  await pool.query(`
    UPDATE membership.member_subscriptions 
    SET cycle_ends_at = $1, next_billing_date = $1
    WHERE member_id = (SELECT id FROM membership.members WHERE email ILIKE '%cadman5610%')
  `, [nextYear]);

  await pool.query(`
    UPDATE membership.subscription_contracts
    SET next_billing_date = $1, current_cycle_start_date = $2, current_cycle_end_date = $1
    WHERE member_id = (SELECT id FROM membership.members WHERE email ILIKE '%cadman5610%')
  `, [nextYear, new Date('2026-04-02T00:00:00Z')]);

  console.log("Successfully backfilled Caden's billing dates for 2027.");
  process.exit(0);
}
run();
