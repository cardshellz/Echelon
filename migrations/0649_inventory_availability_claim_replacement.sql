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
  'Same-order predecessor replaced by this claim in one serializable release-and-replan transaction.';

COMMENT ON COLUMN inventory.availability_claim_commands.command_type IS
  'Canonical command discriminator. replace atomically supersedes one expected active claim, releases only its open ownership, and reserves its same-order successor.';

COMMIT;
