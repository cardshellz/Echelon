import pg from 'pg';

async function run() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required.");
  }
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    await client.query("DELETE FROM catalog.products WHERE id = 102");
    console.log("Deleted");
  } catch(e) {
    console.log(e.message);
  }
  await client.end();
}

run();
