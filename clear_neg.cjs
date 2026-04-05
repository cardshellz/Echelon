const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  try {
    await client.connect();
    
    console.log("Checking for negative inventory levels...");
    const negLots = await client.query('SELECT * FROM inventory_levels WHERE variant_qty < 0');
    console.table(negLots.rows);
    
    if (negLots.rows.length > 0) {
      console.log(`Found ${negLots.rows.length} negative inventory rows. Setting them to 0.`);
      await client.query('UPDATE inventory_levels SET variant_qty = 0 WHERE variant_qty < 0');
      console.log("Updated successfully.");
    } else {
      console.log("No negative inventory found in inventory_levels.");
    }
    
    console.log("Checking for negative in replen_tasks qtyTargetUnits?");
    const tasks = await client.query(`SELECT * FROM replen_tasks WHERE status = 'pending' ORDER BY id DESC LIMIT 5`);
    console.table(tasks.rows);

  } catch(e) {
    console.error(e);
  } finally {
    client.end();
  }
}
run();
