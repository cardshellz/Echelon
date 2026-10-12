-- Listing selection owns inclusion. This journal records only exact mapping
-- preparation and canonical publication work; historical membership stays intact.
CREATE TABLE inventory.publication_mapping_preparations (
  idempotency_key varchar(120) PRIMARY KEY CHECK (btrim(idempotency_key)<>''),
  publication_target_id integer NOT NULL REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT,
  request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  actor varchar(100) NOT NULL CHECK(actor=btrim(actor) AND actor<>''),
  occurred_at timestamptz NOT NULL,
  review jsonb NOT NULL CHECK(jsonb_typeof(review)='object'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object')
);
CREATE TRIGGER publication_mapping_preparations_immutable BEFORE UPDATE OR DELETE
ON inventory.publication_mapping_preparations FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE TRIGGER publication_mapping_preparations_no_truncate BEFORE TRUNCATE
ON inventory.publication_mapping_preparations FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE INDEX publication_mapping_preparations_target_idx
ON inventory.publication_mapping_preparations(publication_target_id,occurred_at DESC);
