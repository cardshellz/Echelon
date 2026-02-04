-- Migration: Order Combining Feature
-- Date: 2026-02-04
-- Description: Adds tables and columns for combining multiple orders to the same address

-- Step 1: Create the combined_order_groups table (if it doesn't exist)
CREATE TABLE IF NOT EXISTS combined_order_groups (
  id SERIAL PRIMARY KEY,
  group_code VARCHAR(20),
  customer_name TEXT DEFAULT 'Unknown',
  customer_email TEXT,
  shipping_address TEXT,
  shipping_city TEXT,
  shipping_state TEXT,
  shipping_postal_code TEXT,
  shipping_country TEXT,
  address_hash VARCHAR(64),
  order_count INTEGER DEFAULT 0,
  total_items INTEGER DEFAULT 0,
  total_units INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  created_by VARCHAR,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Step 2: Add any missing columns to combined_order_groups (safe to run multiple times)
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS group_code VARCHAR(20);
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS customer_name TEXT DEFAULT 'Unknown';
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_address TEXT;
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_city TEXT;
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_state TEXT;
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_postal_code TEXT;
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS shipping_country TEXT;
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS order_count INTEGER DEFAULT 0;
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS total_items INTEGER DEFAULT 0;
ALTER TABLE combined_order_groups ADD COLUMN IF NOT EXISTS total_units INTEGER DEFAULT 0;

-- Step 3: Add combined_group_id column to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS combined_group_id INTEGER REFERENCES combined_order_groups(id) ON DELETE SET NULL;

-- Step 4: Add combined_role column to orders table  
ALTER TABLE orders ADD COLUMN IF NOT EXISTS combined_role TEXT;

-- Step 5: Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_orders_combined_group_id ON orders(combined_group_id);
CREATE INDEX IF NOT EXISTS idx_combined_order_groups_status ON combined_order_groups(status);
CREATE INDEX IF NOT EXISTS idx_combined_order_groups_address_hash ON combined_order_groups(address_hash);

-- Verification queries:
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'combined_order_groups';
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name IN ('combined_group_id', 'combined_role');
