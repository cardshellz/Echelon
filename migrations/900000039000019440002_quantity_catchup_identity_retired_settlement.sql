-- quantity_catchup_identity_retired_settlement: a second settlement basis
-- (Channels PR5, PLAN-CH-v3 section 6 "Wake matching", M2, V3-13).
--
-- A parked catch-up row whose provider item is no longer linked, while its
-- size is now linked to another item (a relink, or the same Shopify item saved
-- in its other id form), is settled instead of published: the new link's own
-- outbox row carries the quantity. Its receipt goes to the existing
-- append-only inventory.quantity_publication_catchup_settlements
-- (900000016000018560001) with basis 'identity_retired'.
--
-- Schema only: the basis CHECK is widened; the immutability trigger and every
-- existing receipt are unchanged (all existing rows are 'catalog_archived', so
-- the wider CHECK validates them). No UPDATE, INSERT or DELETE.

ALTER TABLE inventory.quantity_publication_catchup_settlements
  DROP CONSTRAINT quantity_publication_catchup_settlements_basis_check,
  ADD CONSTRAINT quantity_publication_catchup_settlements_basis_check
    CHECK (basis IN ('catalog_archived', 'identity_retired'));
