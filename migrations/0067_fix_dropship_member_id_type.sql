-- Fix dropship_vendors.shellz_club_member_id type to VARCHAR
-- Cannot add FK constraint - members table is in external Shellz Club database
ALTER TABLE dropship_vendors 
ALTER COLUMN shellz_club_member_id TYPE VARCHAR(255);
