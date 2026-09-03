BEGIN;

ALTER TABLE inventory.availability_claim_commands
  DROP CONSTRAINT availability_claim_commands_type_chk;

ALTER TABLE inventory.availability_claim_commands
  ADD CONSTRAINT availability_claim_commands_type_chk CHECK (
    command_type IN (
      'claim', 'release', 'cancel', 'execute', 'handoff_build', 'execute_build',
      'pick', 'pick_observation', 'unpick'
    )
  );

COMMENT ON COLUMN inventory.availability_claim_commands.command_type IS
  'Canonical command discriminator. pick_observation is an explicit picker-attested same-warehouse location correction followed by an atomic claim pick; it never creates net on-hand.';

COMMIT;
