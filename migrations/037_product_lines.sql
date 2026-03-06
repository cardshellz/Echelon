-- Product lines: backend catalog groupings for channel gating
-- A product line is an operational category (e.g., "Trading Card Supplies")
-- distinct from Shopify collections (which are customer-facing merchandising).
--
-- Run manually: psql $DATABASE_URL -f migrations/037_product_lines.sql

-- Product lines master table
CREATE TABLE IF NOT EXISTS product_lines (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Many-to-many: which products belong to which product lines
CREATE TABLE IF NOT EXISTS product_line_products (
  id SERIAL PRIMARY KEY,
  product_line_id INTEGER NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(product_line_id, product_id)
);

-- Many-to-many: which product lines are available on which channels
CREATE TABLE IF NOT EXISTS channel_product_lines (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  product_line_id INTEGER NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(channel_id, product_line_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_plp_product_id ON product_line_products(product_id);
CREATE INDEX IF NOT EXISTS idx_plp_product_line_id ON product_line_products(product_line_id);
CREATE INDEX IF NOT EXISTS idx_cpl_channel_id ON channel_product_lines(channel_id);
CREATE INDEX IF NOT EXISTS idx_cpl_product_line_id ON channel_product_lines(product_line_id);

-- Seed: create a default product line and assign ALL existing products + channels
-- This ensures nothing breaks — everything that exists today is gated under one line.
INSERT INTO product_lines (code, name, description, sort_order)
VALUES ('TRADING_CARD_SUPPLIES', 'Trading Card Supplies', 'Card sleeves, toploaders, boxes, and accessories', 0)
ON CONFLICT (code) DO NOTHING;

-- Assign all existing products to the default line
INSERT INTO product_line_products (product_line_id, product_id)
SELECT pl.id, p.id
FROM product_lines pl, products p
WHERE pl.code = 'TRADING_CARD_SUPPLIES'
  AND NOT EXISTS (
    SELECT 1 FROM product_line_products plp
    WHERE plp.product_line_id = pl.id AND plp.product_id = p.id
  );

-- Assign the default line to all existing active channels
INSERT INTO channel_product_lines (channel_id, product_line_id)
SELECT c.id, pl.id
FROM channels c, product_lines pl
WHERE pl.code = 'TRADING_CARD_SUPPLIES'
  AND c.status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM channel_product_lines cpl
    WHERE cpl.channel_id = c.id AND cpl.product_line_id = pl.id
  );
