import fs from 'fs';
import { Client } from 'pg';
import 'dotenv/config';

const sql = fs.readFileSync('migrations/0002_concerned_darwin.sql', 'utf8');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await client.connect();
  console.log("Connected to DB.");
  const statements = sql.split('--> statement-breakpoint').map(s => s.trim()).filter(s => s);
  
  let count = 0;
  for (const stmt of statements) {
    if (stmt.includes('"wms"') || stmt.includes('"oms"') || stmt.includes('"membership"')) {
      try {
        await client.query(stmt);
        console.log("Successfully executed:", stmt.split('\n')[0]);
        count++;
      } catch (e: any) {
        if (!e.message.includes('already exists')) {
          console.error("Failed:", stmt.split('\n')[0], e.message);
        }
      }
    }
  }
  console.log(`Executed ${count} schema/table creation statements.`);
  await client.end();
}

run().catch(console.error);
