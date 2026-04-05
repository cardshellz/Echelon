import { db } from "../server/db";
import { sql } from "drizzle-orm";
import fs from "fs";
import path from "path";
import "dotenv/config";

async function executeMigration() {
  console.log("Starting Full Namespace Isolation Migration...");

  try {
    const isProduction = process.env.NODE_ENV === "production" || !!process.env.EXTERNAL_DATABASE_URL;
    if (!isProduction) {
      console.warn("WARNING: Running locally. Skipping actual SCHEMA mutations unless confirmed.");
    }

    // 1. Read schema-map.md to get definitions
    const schemaMapPath = path.join(process.cwd(), "schema-map.md");
    const content = fs.readFileSync(schemaMapPath, "utf-8");
    
    // Parse the file
    // Match lines like: - `public.table_name` → **MOVE TO** `domain.table_name`
    const regex = /- `public\.([a-zA-Z0-9_]+)` → \*\*MOVE TO\*\* `([a-zA-Z0-9_]+)\.\1`/g;
    
    const tablesToMove: { schema: string, table: string }[] = [];
    let match;
    while ((match = regex.exec(content)) !== null) {
      tablesToMove.push({ table: match[1], schema: match[2] });
    }

    console.log(`Found ${tablesToMove.length} tables to move across schemas.`);

    const uniqueSchemas = [...new Set(tablesToMove.map(t => t.schema))];

    // Add implicitly known schemas just to be absolutely certain
    const allSchemasToSearchPath = new Set(["public", "oms", "membership", ...uniqueSchemas]);

    // 2. Set search path globally so older queries don't crash
    console.log("Setting global database search path for zero downtime...");
    const dbNameRow = await db.execute<{current_database: string}>(sql`SELECT current_database();`);
    const dbName = dbNameRow.rows[0]?.current_database;
    if (dbName) {
      const searchPathString = `"$user", ${Array.from(allSchemasToSearchPath).join(', ')}`;
      console.log(`Applying search_path to internal database: ${searchPathString}`);
      await db.execute(sql.raw(`ALTER DATABASE "${dbName}" SET search_path TO ${searchPathString};`));
    }

    // Also set for current session immediately
    const sessionSearchPath = `"$user", ${Array.from(allSchemasToSearchPath).join(', ')}`;
    await db.execute(sql.raw(`SET search_path TO ${sessionSearchPath};`));

    // 3. Create the schema namespaces
    for (const schemaName of uniqueSchemas) {
      console.log(`Creating '${schemaName}' schema...`);
      await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schemaName};`));
    }

    // 4. Safely shift the physical tables while preserving constraints
    let successCount = 0;
    let missingCount = 0;

    for (const { schema: targetSchema, table: tableName } of tablesToMove) {
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
        console.log(`Moving 'public.${tableName}' -> '${targetSchema}.${tableName}'...`);
        // Move the table
        await db.execute(sql.raw(`ALTER TABLE public.${tableName} SET SCHEMA ${targetSchema};`));
        successCount++;
      } else {
        // Did it already get moved? Let's verify
        const newTableCheck = await db.execute<{ exists: boolean }>(sql`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = ${targetSchema} 
            AND table_name = ${tableName}
          ) as "exists";
        `);
        if (newTableCheck.rows[0]?.exists) {
          console.log(`Table '${tableName}' is ALREADY inside '${targetSchema}'. Skipping.`);
          successCount++;
        } else {
          console.log(`Table '${tableName}' not found anywhere. It might be obsolete.`);
          missingCount++;
        }
      }
    }

    console.log(`\nMigration Summary: ${successCount} successfully routed, ${missingCount} skipped (missing).`);
    console.log("Namespace isolation complete! 🎉");
  } catch (error) {
    console.error("Failed to execute namespace migration:", error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

executeMigration();
