import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  const sql = `
CREATE TABLE IF NOT EXISTS "channel_asset_overrides" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "channel_id" integer NOT NULL,
  "catalog_asset_id" integer NOT NULL,
  "url_override" text,
  "alt_text_override" varchar(500),
  "position_override" integer,
  "is_included" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "channel_connections" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "channel_id" integer NOT NULL,
  "shop_domain" varchar(255),
  "access_token" text,
  "refresh_token" text,
  "webhook_secret" varchar(255),
  "api_version" varchar(20),
  "scopes" text,
  "expires_at" timestamp,
  "last_sync_at" timestamp,
  "sync_status" varchar(20) DEFAULT 'never',
  "sync_error" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "channel_feeds" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "variant_id" integer NOT NULL,
  "channel_type" varchar(30) DEFAULT 'shopify' NOT NULL,
  "channel_variant_id" varchar(100) NOT NULL,
  "channel_product_id" varchar(100),
  "channel_sku" varchar(100),
  "is_active" integer DEFAULT 1 NOT NULL,
  "last_synced_at" timestamp,
  "last_synced_qty" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "channel_listings" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "channel_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "external_product_id" varchar(100),
  "external_variant_id" varchar(100),
  "external_sku" varchar(100),
  "external_url" text,
  "last_synced_qty" integer,
  "last_synced_price" integer,
  "last_synced_at" timestamp,
  "sync_status" varchar(20) DEFAULT 'pending',
  "sync_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "channel_pricing" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "channel_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "price" integer NOT NULL,
  "compare_at_price" integer,
  "cost" integer,
  "currency" varchar(3) DEFAULT 'USD' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "channel_product_overrides" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "channel_id" integer NOT NULL,
  "catalog_product_id" integer NOT NULL,
  "title_override" varchar(500),
  "description_override" text,
  "bullet_points_override" jsonb,
  "category_override" varchar(200),
  "tags_override" jsonb,
  "is_listed" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "channel_variant_overrides" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "channel_id" integer NOT NULL,
  "variant_id" integer NOT NULL,
  "name_override" varchar(500),
  "sku_override" varchar(100),
  "barcode_override" varchar(100),
  "weight_override" integer,
  "is_listed" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Migration 009: Add channel_id to channel_feeds
ALTER TABLE channel_feeds ADD COLUMN IF NOT EXISTS channel_id INTEGER;
  `;

  try {
    await pool.query(sql);
    console.log("✅ All missing tables created successfully");
    
    // Verify
    const res = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'channel_%' ORDER BY tablename");
    console.log("Channel tables now:", res.rows.map((r: any) => r.tablename));
  } catch (err: any) {
    console.error("❌ Error:", err.message);
  }
  
  await pool.end();
}
main();
