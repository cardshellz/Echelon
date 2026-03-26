-- Fix ship_to_country column - too short for full country names
ALTER TABLE oms_orders 
ALTER COLUMN ship_to_country TYPE VARCHAR(100);
