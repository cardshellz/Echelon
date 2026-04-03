import { db, sql } from "../server/storage/base";
import "dotenv/config";

async function run() {
  const dbNameRow = await db.execute<{current_database: string}>(sql`SELECT current_database();`);
  const dbName = dbNameRow.rows[0]?.current_database;
  if (dbName) {
    console.log(`Setting search_path for ${dbName}...`);
    await db.execute(sql.raw(`ALTER DATABASE "${dbName}" SET search_path TO "$user", public, wms, catalog, membership, oms, dropship;`));
    console.log("Success!");
  }
  process.exit(0);
}
run();
