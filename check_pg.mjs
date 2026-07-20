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
  const res = await client.query("SELECT DISTINCT category FROM catalog.products WHERE is_active = true");
  console.log("Categories:", res.rows);
  const typeRes = await client.query("SELECT DISTINCT product_type FROM catalog.products WHERE is_active = true");
  console.log("Product Types:", typeRes.rows);
  await client.end();
}

run();
