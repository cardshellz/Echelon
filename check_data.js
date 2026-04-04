import pg from 'pg';
const { Client } = pg;
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    await client.connect();
    
    console.log("--- LATEST REPLEN TASKS OF ANY KIND ---");
    const test = await client.query(`SELECT id, status, "qtyTargetUnits", "triggeredBy", "replenMethod", "createdAt", "qtyCompleted" FROM replen_tasks ORDER BY id DESC LIMIT 5`);
    console.table(test.rows);

    await client.end();
  } catch(e) {
    console.error("DB Query error", e);
    process.exit(1);
  }
}
run();
