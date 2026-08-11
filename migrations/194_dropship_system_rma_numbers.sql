CREATE SEQUENCE IF NOT EXISTS dropship.dropship_rma_number_seq AS bigint;

DO $$
DECLARE
  existing_next bigint;
  sequence_next bigint;
BEGIN
  SELECT COALESCE(
    MAX(substring(rma_number FROM '^RMA-([0-9]{1,18})$')::bigint),
    0
  ) + 1
    INTO existing_next
    FROM dropship.dropship_rmas
   WHERE rma_number ~ '^RMA-[0-9]{1,18}$';

  SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END
    INTO sequence_next
    FROM dropship.dropship_rma_number_seq;

  PERFORM setval(
    'dropship.dropship_rma_number_seq',
    GREATEST(existing_next, sequence_next),
    false
  );
END
$$;

CREATE OR REPLACE FUNCTION dropship.next_rma_number()
RETURNS varchar
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'RMA-' || lpad(value::text, GREATEST(8, length(value::text)), '0')
    FROM (
      SELECT nextval('dropship.dropship_rma_number_seq') AS value
    ) generated;
$$;

ALTER TABLE dropship.dropship_rmas
  ALTER COLUMN rma_number SET DEFAULT dropship.next_rma_number();
