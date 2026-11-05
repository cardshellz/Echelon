-- LOCAL UNALLOCATED CANDIDATE. Not in the release runner's top-level migrations.
-- Allocate unchanged SQL + metadata only after an authorized draft PR exists.
-- New definitions do not grant any role access. Existing hashes/roles unchanged.
CREATE TABLE identity.staff_credentials (
  user_id varchar PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
  credential_version uuid NOT NULL DEFAULT gen_random_uuid(),
  must_change_password boolean NOT NULL DEFAULT false,
  last_operation_id uuid
);
INSERT INTO identity.staff_credentials(user_id) SELECT id FROM identity.users;
