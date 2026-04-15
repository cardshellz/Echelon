-- Migration 053: Shopify Schema
-- Creates the shopify schema with collections and collection-product join table

CREATE SCHEMA IF NOT EXISTS shopify;

-- Shopify collections (synced from Shopify)
CREATE TABLE IF NOT EXISTS shopify.shopify_collections (
  id                    SERIAL PRIMARY KEY,
  shopify_collection_id VARCHAR(100) NOT NULL UNIQUE,
  title                 VARCHAR(500) NOT NULL,
  handle                VARCHAR(255),
  description           TEXT,
  collection_type       VARCHAR(20) NOT NULL DEFAULT 'smart',  -- 'smart' | 'custom'
  rules                 JSONB,                                  -- Smart collection rules from Shopify
  sort_order            VARCHAR(30) DEFAULT 'best-selling',
  published_at          TIMESTAMP,
  last_synced_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Product ↔ collection join table
CREATE TABLE IF NOT EXISTS shopify.shopify_collection_products (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES shopify.shopify_collections(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  position      INTEGER DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS scp_collection_product_idx
  ON shopify.shopify_collection_products (collection_id, product_id);

CREATE INDEX IF NOT EXISTS scp_product_idx
  ON shopify.shopify_collection_products (product_id);
