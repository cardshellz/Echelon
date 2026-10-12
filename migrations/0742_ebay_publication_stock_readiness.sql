-- Review/apply stock enrollment shares a transaction with the saved listing
-- command. It never changes source/model/policy or invents provider evidence.
CREATE TABLE inventory.ebay_publication_readiness_applications (
  command_key uuid PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE RESTRICT,
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  request_hash varchar(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  actor varchar(100) NOT NULL CHECK(actor=btrim(actor) AND actor<>''),
  occurred_at timestamptz NOT NULL,
  source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),
  review jsonb NOT NULL CHECK(jsonb_typeof(review)='object'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object')
);
CREATE TRIGGER ebay_publication_readiness_applications_immutable BEFORE UPDATE OR DELETE
ON inventory.ebay_publication_readiness_applications FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE INDEX ebay_publication_readiness_product_idx ON inventory.ebay_publication_readiness_applications(channel_id,product_id,occurred_at DESC);
CREATE TABLE inventory.ebay_publication_readiness_rejections (
  command_key uuid PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE RESTRICT,
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  actor varchar(100) NOT NULL CHECK(actor=btrim(actor) AND actor<>''),
  context_hash varchar(64) NOT NULL CHECK(context_hash ~ '^[a-f0-9]{64}$'),
  code varchar(100) NOT NULL CHECK(btrim(code)<>''),
  message varchar(1000) NOT NULL CHECK(btrim(message)<>''),
  occurred_at timestamptz NOT NULL
);
CREATE TRIGGER ebay_publication_readiness_rejections_immutable BEFORE UPDATE OR DELETE
ON inventory.ebay_publication_readiness_rejections FOR EACH ROW EXECUTE FUNCTION inventory.guard_publication_membership_evidence();
CREATE FUNCTION inventory.guard_ebay_publication_readiness_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ebay-stock:' || NEW.command_key::text,0));
  IF (TG_TABLE_NAME='ebay_publication_readiness_applications' AND EXISTS(SELECT 1 FROM inventory.ebay_publication_readiness_rejections WHERE command_key=NEW.command_key))
    OR (TG_TABLE_NAME='ebay_publication_readiness_rejections' AND EXISTS(SELECT 1 FROM inventory.ebay_publication_readiness_applications WHERE command_key=NEW.command_key)) THEN
    RAISE EXCEPTION 'eBay stock publication command already has an immutable outcome' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ebay_publication_readiness_command_guard BEFORE INSERT ON inventory.ebay_publication_readiness_applications
FOR EACH ROW EXECUTE FUNCTION inventory.guard_ebay_publication_readiness_command();
CREATE TRIGGER ebay_publication_readiness_rejection_command_guard BEFORE INSERT ON inventory.ebay_publication_readiness_rejections
FOR EACH ROW EXECUTE FUNCTION inventory.guard_ebay_publication_readiness_command();
