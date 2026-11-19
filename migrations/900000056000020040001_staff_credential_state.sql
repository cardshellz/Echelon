-- PR #2004: private staff credential generation and completion state.
-- Additive backfill only; preserves passwords, grants and assignments.
CREATE TABLE identity.staff_credentials (
  user_id varchar PRIMARY KEY,
  credential_version uuid NOT NULL DEFAULT gen_random_uuid(),
  must_change_password boolean NOT NULL DEFAULT false,
  last_operation_id uuid,
  CONSTRAINT staff_credentials_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES identity.users(id) ON DELETE CASCADE
);
INSERT INTO identity.staff_credentials(user_id) SELECT id FROM identity.users;
