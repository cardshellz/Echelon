import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function run() {
  const result = await pool.query(`SELECT * FROM membership.subscription_events ORDER BY created_at DESC LIMIT 5`);
  fs.writeFileSync('c:/Users/owner/Echelon/event_payload.json', JSON.stringify(result.rows, null, 2));
  console.log("Dumped last 5 events.");
  process.exit(0);
}
run();
