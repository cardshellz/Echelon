-- Migration: Order Combining Feature
-- Date: 2026-02-04
-- Description: Adds tables and columns for combining multiple orders to the same address

-- Step 1: Create the combined_order_groups table
CREATE TABLE IF NOT EXISTS combined_order_groups (
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
);

-- Step 2: Add combined_group_id column to orders table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'combined_group_id'
  ) THEN
    ALTER TABLE orders ADD COLUMN combined_group_id INTEGER REFERENCES combined_order_groups(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Step 3: Add combined_role column to orders table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'combined_role'
  ) THEN
    ALTER TABLE orders ADD COLUMN combined_role TEXT;
  END IF;
END $$;

-- Step 4: Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_orders_combined_group_id ON orders(combined_group_id);
CREATE INDEX IF NOT EXISTS idx_combined_order_groups_status ON combined_order_groups(status);
CREATE INDEX IF NOT EXISTS idx_combined_order_groups_address_hash ON combined_order_groups(address_hash);

-- Verification query (run this to confirm changes applied):
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'orders' AND column_name IN ('combined_group_id', 'combined_role');
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'combined_order_groups';
