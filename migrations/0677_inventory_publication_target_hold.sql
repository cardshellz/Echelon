-- Publication hold on a live canonical inventory publication target.
--
-- A held target stays live: quantities are still planned, enqueued and sent,
-- but every SKU quantity it publishes is zero for as long as the hold stands.
-- The first use is Dropship vendor standing: a vendor whose wallet funding was
-- declined is paused, and every store connection they own is held so their
-- marketplace listings show nothing for sale until the balance is restored.
-- A hold is not a stop (migration 0652 / target-stop): a stopped target
-- publishes nothing and leaves whatever stock the marketplace already shows.
--
-- The three columns move together: all null (no hold) or all set. Releasing a
-- hold clears them. Every hold and release bumps the target revision, so an
-- operator command carrying a stale revision is refused like any other change.

ALTER TABLE inventory.inventory_publication_targets
  ADD COLUMN hold_reason VARCHAR(120),
  ADD COLUMN held_at TIMESTAMPTZ,
  ADD COLUMN held_by VARCHAR(100);

ALTER TABLE inventory.inventory_publication_targets
  ADD CONSTRAINT inventory_publication_targets_hold_chk CHECK (
    (hold_reason IS NULL AND held_at IS NULL AND held_by IS NULL)
    OR (
      hold_reason IS NOT NULL
      AND hold_reason = btrim(hold_reason)
      AND hold_reason <> ''
      AND held_at IS NOT NULL
      AND held_by IS NOT NULL
      AND held_by = btrim(held_by)
      AND held_by <> ''
    )
  );
