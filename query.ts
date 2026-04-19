import { db } from './server/db';
import { sql } from 'drizzle-orm';
import fs from 'fs';

async function run() {
  try {
    const res = await db.execute(sql.raw("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name ASC"));
    fs.writeFileSync('c:/tmp/output.json', JSON.stringify(res.rows, null, 2));
    process.exit(0);
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
}
run();
