BEGIN;

ALTER TABLE inventory.availability_claims
  ADD COLUMN supersedes_claim_id BIGINT;

ALTER TABLE inventory.availability_claims
  ADD CONSTRAINT availability_claims_id_order_uq UNIQUE (id, order_id),
  ADD CONSTRAINT availability_claims_supersedes_same_order_fk
    FOREIGN KEY (supersedes_claim_id, order_id)
    REFERENCES inventory.availability_claims(id, order_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT availability_claims_supersedes_chk CHECK (
    supersedes_claim_id IS NULL OR supersedes_claim_id <> id
  );

CREATE UNIQUE INDEX availability_claims_supersedes_claim_uq
  ON inventory.availability_claims (supersedes_claim_id)
  WHERE supersedes_claim_id IS NOT NULL;

CREATE OR REPLACE FUNCTION inventory.validate_availability_claim_replacement_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  predecessor_order_id INTEGER;
  predecessor_revision INTEGER;
  predecessor_status VARCHAR(30);
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.supersedes_claim_id IS DISTINCT FROM OLD.supersedes_claim_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.revision IS DISTINCT FROM OLD.revision
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'availability_claims_replacement_lineage_immutable_chk',
      MESSAGE = 'canonical claim replacement lineage is immutable';
  END IF;

  IF NEW.supersedes_claim_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT predecessor.order_id, predecessor.revision, predecessor.status
    INTO predecessor_order_id, predecessor_revision, predecessor_status
  FROM inventory.availability_claims AS predecessor
  WHERE predecessor.id = NEW.supersedes_claim_id;

  IF NOT FOUND OR predecessor_order_id <> NEW.order_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'availability_claims_supersedes_same_order_fk',
      MESSAGE = 'replacement claim predecessor must belong to the same order';
  END IF;
  IF predecessor_status <> 'superseded' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'availability_claims_supersedes_status_chk',
      MESSAGE = 'replacement claim predecessor must already be superseded in this transaction';
  END IF;
  IF predecessor_revision + 1 <> NEW.revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'availability_claims_supersedes_revision_chk',
      MESSAGE = 'replacement claim must immediately follow its predecessor revision';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'availability_claims_supersedes_status_chk',
      MESSAGE = 'replacement claim must begin in the active state';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER availability_claims_replacement_lineage_guard
BEFORE INSERT OR UPDATE OF supersedes_claim_id, order_id, revision
ON inventory.availability_claims
FOR EACH ROW EXECUTE FUNCTION inventory.validate_availability_claim_replacement_lineage();

ALTER TABLE inventory.availability_claim_commands
  DROP CONSTRAINT availability_claim_commands_type_chk;

ALTER TABLE inventory.availability_claim_commands
  ADD CONSTRAINT availability_claim_commands_type_chk CHECK (
    command_type IN (
      'claim', 'replace', 'release', 'cancel', 'execute', 'handoff_build',
      'execute_build', 'pick', 'pick_observation', 'unpick'
    )
  );

COMMENT ON COLUMN inventory.availability_claims.supersedes_claim_id IS
  'Same-order, immediately preceding claim revision replaced by this claim in one serializable release-and-replan transaction.';

COMMENT ON COLUMN inventory.availability_claim_commands.command_type IS
  'Canonical command discriminator. replace atomically supersedes one expected active claim, releases only its open ownership, and reserves its same-order successor.';

COMMIT;
