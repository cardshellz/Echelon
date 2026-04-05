-- Convert specific legacy string values to their numeric string equivalents
UPDATE orders SET priority = '9999' WHERE priority = 'rush';
UPDATE orders SET priority = '500' WHERE priority = 'high';
UPDATE orders SET priority = '100' WHERE priority = 'normal';

-- Drop default so Postgres doesn't try to cast the old string default
ALTER TABLE orders ALTER COLUMN priority DROP DEFAULT;

-- Ensure all remaining are castable to integers (defaulting to 100 if any bizarre string sneaks in)
UPDATE orders SET priority = '100' WHERE priority !~ '^-?[0-9]+$';

-- Alter the column to REAL INTEGER type, converting current string representations to integer
ALTER TABLE orders ALTER COLUMN priority TYPE INTEGER USING priority::integer;

-- Ensure default value is correctly established 
ALTER TABLE orders ALTER COLUMN priority SET DEFAULT 100;
ALTER TABLE orders ALTER COLUMN priority SET NOT NULL;
