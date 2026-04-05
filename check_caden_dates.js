import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function run() {
  const result = await pool.query(`
    SELECT m.email, s.status, s.billing_interval, s.cycle_ends_at, sc.next_billing_date, sc.status as contract_status, s.next_billing_date as sub_next_billing_date
    FROM membership.members m
    LEFT JOIN membership.member_subscriptions s ON m.id = s.member_id
    LEFT JOIN membership.subscription_contracts sc ON sc.member_id = m.id
    WHERE m.email ILIKE '%cadman5610%'
  `);
  console.log("DB RESULT:");
  console.log(JSON.stringify(result.rows, null, 2));
  process.exit(0);
}
run();
