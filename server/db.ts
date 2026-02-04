import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
const { Pool } = pkg;
import * as schema from "@shared/schema";

const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Database connection string must be set. Provide EXTERNAL_DATABASE_URL or DATABASE_URL.",
  );
}

// Always use SSL for external/production databases
// Heroku and most cloud databases require SSL connections
const useSSL = process.env.EXTERNAL_DATABASE_URL || process.env.NODE_ENV === "production";

export const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });

// Run startup migrations to ensure schema is up to date
export async function runStartupMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // Check if combined_order_groups table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'combined_order_groups'
      )
    `);
    
    if (!tableCheck.rows[0].exists) {
      // Create the full table structure
      await client.query(`
        CREATE TABLE combined_order_groups (
          id SERIAL PRIMARY KEY,
          group_code VARCHAR(20) UNIQUE NOT NULL,
          customer_name TEXT NOT NULL,
          customer_email TEXT,
          shipping_address TEXT,
          shipping_city TEXT,
          shipping_state TEXT,
          shipping_postal_code TEXT,
          shipping_country TEXT,
          address_hash VARCHAR(64),
          order_count INTEGER DEFAULT 0 NOT NULL,
          total_items INTEGER DEFAULT 0 NOT NULL,
          total_units INTEGER DEFAULT 0 NOT NULL,
          status VARCHAR(20) DEFAULT 'active' NOT NULL,
          created_by VARCHAR,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        )
      `);
      console.log("Created combined_order_groups table");
    } else {
      // Table exists, add any missing columns
      const columnsToAdd = [
        { name: 'group_code', sql: "ADD COLUMN group_code VARCHAR(20) UNIQUE" },
        { name: 'customer_name', sql: "ADD COLUMN customer_name TEXT DEFAULT 'Unknown'" },
        { name: 'customer_email', sql: "ADD COLUMN customer_email TEXT" },
        { name: 'shipping_address', sql: "ADD COLUMN shipping_address TEXT" },
        { name: 'shipping_city', sql: "ADD COLUMN shipping_city TEXT" },
        { name: 'shipping_state', sql: "ADD COLUMN shipping_state TEXT" },
        { name: 'shipping_postal_code', sql: "ADD COLUMN shipping_postal_code TEXT" },
        { name: 'shipping_country', sql: "ADD COLUMN shipping_country TEXT" },
        { name: 'order_count', sql: "ADD COLUMN order_count INTEGER DEFAULT 0" },
        { name: 'total_items', sql: "ADD COLUMN total_items INTEGER DEFAULT 0" },
        { name: 'total_units', sql: "ADD COLUMN total_units INTEGER DEFAULT 0" },
      ];
      
      for (const col of columnsToAdd) {
        const colCheck = await client.query(`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'combined_order_groups' AND column_name = $1
          )
        `, [col.name]);
        
        if (!colCheck.rows[0].exists) {
          await client.query(`ALTER TABLE combined_order_groups ${col.sql}`);
          console.log(`Added ${col.name} column to combined_order_groups`);
        }
      }
      console.log("Checked combined_order_groups table structure");
    }

    // Add combined_group_id column if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'orders' AND column_name = 'combined_group_id'
        ) THEN
          ALTER TABLE orders ADD COLUMN combined_group_id INTEGER REFERENCES combined_order_groups(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    console.log("Checked/added combined_group_id column");

    // Add combined_role column if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'orders' AND column_name = 'combined_role'
        ) THEN
          ALTER TABLE orders ADD COLUMN combined_role TEXT;
        END IF;
      END $$;
    `);
    console.log("Checked/added combined_role column");
    
  } catch (error) {
    console.error("Error running startup migrations:", error);
  } finally {
    client.release();
  }
}
