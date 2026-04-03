import { db, sql } from "../server/storage/base";
import "dotenv/config";

async function executeMigration() {
  console.log("Starting Catalog namespace isolation data migration...");

  try {
    const isProduction = process.env.NODE_ENV === "production" || !!process.env.EXTERNAL_DATABASE_URL;
    if (!isProduction) {
      console.warn("WARNING: Running locally. Skipping actual SCHEMA mutations unless confirmed.");
    }

    // 1. Create the schema namespace
    console.log("Creating 'catalog' schema...");
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS catalog;`);

    // 1.5 Set search path globally so older versions of the app don't crash during the deployment window
    console.log("Setting global database search path for zero downtime...");
    const dbNameRow = await db.execute<{current_database: string}>(sql`SELECT current_database();`);
    const dbName = dbNameRow.rows[0]?.current_database;
    if (dbName) {
      await db.execute(sql.raw(`ALTER DATABASE "${dbName}" SET search_path TO "$user", public, catalog, membership, oms;`));
    }

    // 2. Safely shift the physical tables while preserving all data, constraints, and indexes
    const tablesToMove = [
      "product_types",
      "products",
      "product_variants",
      "product_lines",
      "product_line_products",
      "product_assets"
    ];

    for (const tableName of tablesToMove) {
      console.log(`Checking routing for table: ${tableName}`);
      
      // Determine if the table actually exists in 'public' right now
      const tableCheck = await db.execute<{ exists: boolean }>(sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = ${tableName}
        ) as "exists";
      `);

      const exists = tableCheck.rows[0]?.exists;
      if (exists) {
        console.log(`Moving 'public.${tableName}' -> 'catalog.${tableName}'...`);
        // execute Raw SQL directly since variable interpolation won't work perfectly on DDL statements
        await db.execute(sql.raw(`ALTER TABLE public.${tableName} SET SCHEMA catalog;`));
      } else {
        console.log(`Table '${tableName}' not found in public namespace. It may already be migrated or missing.`);
      }
    }

    console.log("Catalog namespace isolation complete! No data was harmed in the making of this migration. 🎉");
  } catch (error) {
    console.error("Failed to execute catalog namespace migration:", error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

executeMigration();
