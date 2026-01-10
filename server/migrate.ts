import { db, pool } from "./db";
import { sql } from "drizzle-orm";

async function migrate() {
  console.log("Creating tables in external database...");
  
  try {
    // Create product_locations table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "product_locations" (
        "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        "sku" varchar(100) NOT NULL UNIQUE,
        "name" text NOT NULL,
        "location" varchar(50) NOT NULL,
        "zone" varchar(10) NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      )
    `);
    console.log("✓ Created product_locations table");
    
    // Create users table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "username" text NOT NULL UNIQUE,
        "password" text NOT NULL
      )
    `);
    console.log("✓ Created users table");
    
    console.log("Migration complete!");
  } catch (error) {
    console.error("Migration error:", error);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

migrate();
