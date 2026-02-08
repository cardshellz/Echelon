-- Migration 005: Add reorder/purchasing settings to products
--
-- leadTimeDays: How many days from placing a PO to receiving goods (default 120)
-- safetyStockQty: Buffer stock above lead-time demand (default 0, kept as stub)

ALTER TABLE products ADD COLUMN lead_time_days integer NOT NULL DEFAULT 120;
ALTER TABLE products ADD COLUMN safety_stock_qty integer NOT NULL DEFAULT 0;
