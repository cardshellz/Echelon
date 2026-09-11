-- Millimeters remain canonical. Preserve thousandth-inch input exactly:
-- 8 inches = 203.2 mm, not 203 mm. Existing integer measurements are unchanged;
-- names/codes are not evidence of a box's measured dimensions.
ALTER TABLE shipping.box_catalog
  ALTER COLUMN length_mm TYPE numeric(14,4),
  ALTER COLUMN width_mm TYPE numeric(14,4),
  ALTER COLUMN height_mm TYPE numeric(14,4),
  ALTER COLUMN outer_length_mm TYPE numeric(14,4),
  ALTER COLUMN outer_width_mm TYPE numeric(14,4),
  ALTER COLUMN outer_height_mm TYPE numeric(14,4),
  ADD CONSTRAINT shipping_box_dimension_range_chk CHECK (
    length_mm <= 2147483647 AND width_mm <= 2147483647 AND height_mm <= 2147483647
    AND (outer_length_mm IS NULL OR outer_length_mm <= 2147483647)
    AND (outer_width_mm IS NULL OR outer_width_mm <= 2147483647)
    AND (outer_height_mm IS NULL OR outer_height_mm <= 2147483647)
  );

-- Do not truncate a measured outer dimension when the pack plan is persisted.
-- Historical zero/unknown parcel dimensions remain zero, not invented sizes.
ALTER TABLE shipping.pack_plan_parcels
  ALTER COLUMN length_mm TYPE numeric(14,4),
  ALTER COLUMN width_mm TYPE numeric(14,4),
  ALTER COLUMN height_mm TYPE numeric(14,4),
  ADD CONSTRAINT shipping_parcel_dimension_range_chk CHECK (
    length_mm BETWEEN 0 AND 2147483647
    AND width_mm BETWEEN 0 AND 2147483647
    AND height_mm BETWEEN 0 AND 2147483647
  );
