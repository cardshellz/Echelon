import pg from 'pg';

async function run() {
  const client = new pg.Client({
    connectionString: "postgres://u4a9gsbuf4bqhd:p92818d8d1c346db908b07e5b8d88adb1f4f07617c652accec20a1cd9d181fb4c@cai49c2c9nhuub.cluster-czrs8kj4isg7.us-east-1.rds.amazonaws.com:5432/d4s0r6moem4ug8",
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
