-- A reviewed eBay listing update or rebuild that ADDS a size.
--
-- Stock for a size is only sent to eBay when Channels says the size is selected,
-- and that needs either a saved eBay identity or a first-publication job
-- (channel-stock-selection.domain.ts). A size being added to an existing listing
-- has neither: its identity is saved only after the change succeeds. This row is
-- the durable record that an operator reviewed the change that adds it, so its
-- stock can be linked before the first eBay write and every quantity write during
-- the change is admitted.
--
-- One open row per size and channel. It is closed when the change is applied
-- (the saved listing identity then carries the selection), when the change is
-- refused before anything is sent to eBay, or when a newer review replaces it.
CREATE TABLE channels.ebay_listing_change_intents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  connection_id integer NOT NULL REFERENCES channels.channel_connections(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  kind text NOT NULL,
  external_listing_id text NOT NULL,
  sku text NOT NULL,
  review_token text NOT NULL,
  actor text NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  close_reason text,
  CONSTRAINT ebay_listing_change_intents_kind_check CHECK (kind IN ('listing_update','listing_rebuild')),
  CONSTRAINT ebay_listing_change_intents_review_token_check CHECK (review_token ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ebay_listing_change_intents_actor_check CHECK (length(btrim(actor)) BETWEEN 1 AND 200),
  CONSTRAINT ebay_listing_change_intents_listing_check CHECK (length(btrim(external_listing_id)) BETWEEN 1 AND 100),
  CONSTRAINT ebay_listing_change_intents_sku_check CHECK (length(btrim(sku)) BETWEEN 1 AND 100),
  CONSTRAINT ebay_listing_change_intents_close_check CHECK (
    (closed_at IS NULL AND close_reason IS NULL)
    OR (closed_at IS NOT NULL AND close_reason IS NOT NULL AND close_reason IN ('applied','refused','superseded')))
);

CREATE UNIQUE INDEX ebay_listing_change_intents_open_variant_idx
  ON channels.ebay_listing_change_intents(channel_id, product_variant_id) WHERE closed_at IS NULL;
CREATE INDEX ebay_listing_change_intents_open_product_idx
  ON channels.ebay_listing_change_intents(channel_id, product_id) WHERE closed_at IS NULL;

-- Opening or closing one changes the size's stock selection, so the product is
-- replanned like every other selection source (migration 0743). Not gated, as for
-- channels.ebay_listing_sync_jobs: these writes happen inside a listing workflow.
CREATE TRIGGER publication_selection_invalidation
  AFTER INSERT OR DELETE OR UPDATE OF closed_at ON channels.ebay_listing_change_intents
  FOR EACH ROW EXECUTE FUNCTION inventory.notify_publication_selection_change('variant','closed_at');
