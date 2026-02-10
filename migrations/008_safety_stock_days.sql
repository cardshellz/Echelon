-- Rename safety_stock_qty (units) to safety_stock_days (days of cover)
-- Safety stock as days of cover scales automatically with product velocity
ALTER TABLE products RENAME COLUMN safety_stock_qty TO safety_stock_days;

-- Update default from 0 to 7 (one week buffer is a reasonable starting point)
ALTER TABLE products ALTER COLUMN safety_stock_days SET DEFAULT 7;
