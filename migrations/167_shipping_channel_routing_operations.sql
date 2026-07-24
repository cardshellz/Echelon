-- Operational lifecycle guards for canonical channel shipping policies.
--
-- Policy and destination-scope edits use an integer compare-and-swap token so
-- concurrent admin sessions cannot silently overwrite one another. A channel
-- and business purpose may have only one editable draft at a time.

ALTER TABLE shipping.destination_scopes
  ADD COLUMN lock_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE shipping.destination_scopes
  ADD CONSTRAINT shipping_destination_scope_lock_version_chk
  CHECK (lock_version > 0);

ALTER TABLE shipping.channel_policies
  ADD COLUMN lock_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE shipping.channel_policies
  ADD CONSTRAINT shipping_channel_policy_lock_version_chk
  CHECK (lock_version > 0);

ALTER TABLE shipping.channel_policies
  DROP CONSTRAINT shipping_channel_policy_lifecycle_chk;

ALTER TABLE shipping.channel_policies
  ADD CONSTRAINT shipping_channel_policy_lifecycle_chk
  CHECK (
    (
      status = 'draft'
      AND activated_by IS NULL
      AND activated_at IS NULL
      AND retired_at IS NULL
    )
    OR (
      status = 'active'
      AND activated_by IS NOT NULL
      AND activated_at IS NOT NULL
      AND retired_at IS NULL
    )
    OR (
      status = 'retired'
      AND retired_at IS NOT NULL
      AND (
        (
          activated_by IS NULL
          AND activated_at IS NULL
        )
        OR (
          activated_by IS NOT NULL
          AND activated_at IS NOT NULL
          AND retired_at >= activated_at
        )
      )
    )
  );

CREATE UNIQUE INDEX shipping_channel_policy_draft_idx
  ON shipping.channel_policies(channel_id, purpose)
  WHERE status = 'draft';

COMMENT ON COLUMN shipping.destination_scopes.lock_version IS
  'Optimistic concurrency token incremented by every admin mutation.';

COMMENT ON COLUMN shipping.channel_policies.lock_version IS
  'Optimistic concurrency token incremented by every draft or lifecycle mutation.';
