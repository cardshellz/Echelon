-- 0556_sort_rank_widen.sql
-- Fix: sort_rank format H-B-PPPP-SSSSSS-AAAAAAAAAA is 26 chars, not 22.
-- VARCHAR(24) was too short. Widen to VARCHAR(32) for headroom.

ALTER TABLE wms.orders
  ALTER COLUMN sort_rank TYPE VARCHAR(32);
