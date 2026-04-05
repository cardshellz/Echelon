import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function run() {
  const result = await pool.query("SELECT * FROM membership.members WHERE email ILIKE '%cadman%'");
  console.log("Member Result:", result.rows);
  process.exit(0);
}
run();
