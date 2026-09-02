BEGIN;

ALTER TABLE inventory.availability_claim_commands
  DROP CONSTRAINT availability_claim_commands_type_chk;

ALTER TABLE inventory.availability_claim_commands
  ADD CONSTRAINT availability_claim_commands_type_chk CHECK (
    command_type IN ('claim', 'release', 'cancel', 'execute', 'handoff_build', 'execute_build')
  );

COMMENT ON COLUMN inventory.availability_claim_commands.command_type IS
  'Canonical command identity. execute_build is distinct from package execution so identical-shaped commands cannot replay across operation authorities.';

COMMIT;
