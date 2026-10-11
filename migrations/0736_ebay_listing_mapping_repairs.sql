-- Local mapping repair receipts; no provider, quantity, price or ACK mutation.
CREATE TABLE channels.ebay_listing_mapping_repairs (
  command_key uuid PRIMARY KEY REFERENCES channels.ebay_listing_sync_commands(command_key),
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  connection_id integer NOT NULL REFERENCES channels.channel_connections(id),
  product_id integer NOT NULL REFERENCES catalog.products(id),
  environment text NOT NULL CHECK(environment IN ('production','sandbox')),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  review_hash text NOT NULL CHECK(review_hash ~ '^[a-f0-9]{64}$'),
  actor text NOT NULL CHECK(length(btrim(actor)) BETWEEN 1 AND 200),
  before_identity jsonb NOT NULL CHECK(jsonb_typeof(before_identity)='object'),
  after_identity jsonb NOT NULL CHECK(jsonb_typeof(after_identity)='object'),
  -- A compatible existing job retains its original source snapshot (including
  -- old group hints/optional snapshots); the canonical enqueue owner validates
  -- equivalence. Audit that exact queue identity separately from observed truth.
  queued_identity jsonb NOT NULL CHECK(jsonb_typeof(queued_identity)='object'),
  before_rows jsonb NOT NULL CHECK(jsonb_typeof(before_rows)='array' AND jsonb_array_length(before_rows) BETWEEN 1 AND 250),
  after_rows jsonb NOT NULL CHECK(jsonb_typeof(after_rows)='array' AND jsonb_array_length(after_rows)=jsonb_array_length(before_rows)),
  observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object'),
  job_id uuid NOT NULL REFERENCES channels.ebay_listing_sync_jobs(id),
  applied_at timestamptz NOT NULL,
  owner_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX ebay_listing_mapping_repairs_product ON channels.ebay_listing_mapping_repairs(channel_id,product_id,applied_at DESC);
CREATE TRIGGER ebay_listing_mapping_repairs_immutable BEFORE UPDATE OR DELETE ON channels.ebay_listing_mapping_repairs
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_listing_mapping_repairs_no_truncate BEFORE TRUNCATE ON channels.ebay_listing_mapping_repairs
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE FUNCTION channels.check_ebay_listing_mapping_repair_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid=918427 AND objid=hashtext('listing:'||NEW.channel_id::text||':'||NEW.product_id::text)::oid
      AND objsubid=2 AND mode='ExclusiveLock' AND granted)
    OR NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_commands command JOIN channels.ebay_listing_sync_jobs job ON job.id=command.job_id
      WHERE command.command_key=NEW.command_key AND command.job_id=NEW.job_id AND command.actor=NEW.actor
        AND job.identity=NEW.queued_identity AND job.channel_id=NEW.channel_id AND job.connection_id=NEW.connection_id
        AND job.product_id=NEW.product_id)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.after_rows) final_row
      LEFT JOIN channels.channel_listings current_row ON current_row.channel_id=NEW.channel_id
        AND current_row.product_variant_id=(final_row->>'product_variant_id')::integer
      WHERE current_row.product_variant_id IS NULL OR to_jsonb(current_row) IS DISTINCT FROM final_row)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.before_rows) prior
      FULL JOIN jsonb_array_elements(NEW.after_rows) final_row ON prior->>'product_variant_id'=final_row->>'product_variant_id'
      WHERE prior IS NULL OR final_row IS NULL
        OR (prior-'external_sku'-'external_variant_id'-'external_product_id'-'external_url'-'updated_at')
          IS DISTINCT FROM (final_row-'external_sku'-'external_variant_id'-'external_product_id'-'external_url'-'updated_at')) THEN
    RAISE EXCEPTION 'Mapping repair must preserve local work and commit its exact owned follow-up and audit receipt together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER ebay_listing_mapping_repair_complete AFTER INSERT ON channels.ebay_listing_mapping_repairs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION channels.check_ebay_listing_mapping_repair_complete();

-- A refused review is a terminal command outcome too. This fences slower
-- concurrent requests whose provider reads finish after a refusal was shown.
CREATE TABLE channels.ebay_listing_mapping_rejections (
  command_key uuid PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  product_id integer NOT NULL REFERENCES catalog.products(id),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  review_hash text NOT NULL CHECK(review_hash ~ '^[a-f0-9]{64}$'),
  actor text NOT NULL CHECK(length(btrim(actor)) BETWEEN 1 AND 200),
  error_code text NOT NULL CHECK(length(error_code) BETWEEN 1 AND 100),
  error_message text NOT NULL CHECK(length(error_message) BETWEEN 1 AND 1000),
  rejected_at timestamptz NOT NULL
);
CREATE INDEX ebay_listing_mapping_rejections_product ON channels.ebay_listing_mapping_rejections(channel_id,product_id,rejected_at DESC);
CREATE TRIGGER ebay_listing_mapping_rejections_immutable BEFORE UPDATE OR DELETE ON channels.ebay_listing_mapping_rejections
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE TRIGGER ebay_listing_mapping_rejections_no_truncate BEFORE TRUNCATE ON channels.ebay_listing_mapping_rejections
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_availability_claim_evidence_mutation();
CREATE FUNCTION channels.guard_ebay_listing_mapping_command_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
    AND classid=918427 AND objid=hashtext('command:'||NEW.command_key::text)::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted)
    OR (TG_TABLE_NAME IN ('ebay_listing_mapping_repairs','ebay_listing_sync_commands','ebay_listing_sync_admission_failures') AND EXISTS(SELECT 1 FROM channels.ebay_listing_mapping_rejections WHERE command_key=NEW.command_key))
    OR (TG_TABLE_NAME='ebay_listing_mapping_rejections' AND (
      EXISTS(SELECT 1 FROM channels.ebay_listing_sync_commands WHERE command_key=NEW.command_key)
      OR EXISTS(SELECT 1 FROM channels.ebay_listing_sync_admission_failures WHERE command_key=NEW.command_key))) THEN
    RAISE EXCEPTION 'A mapping command must have one exclusively owned immutable result' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ebay_listing_mapping_repairs_command_guard BEFORE INSERT ON channels.ebay_listing_mapping_repairs
  FOR EACH ROW EXECUTE FUNCTION channels.guard_ebay_listing_mapping_command_outcome();
CREATE TRIGGER ebay_listing_mapping_rejections_command_guard BEFORE INSERT ON channels.ebay_listing_mapping_rejections
  FOR EACH ROW EXECUTE FUNCTION channels.guard_ebay_listing_mapping_command_outcome();

CREATE TRIGGER ebay_listing_sync_commands_mapping_rejection_guard BEFORE INSERT ON channels.ebay_listing_sync_commands
  FOR EACH ROW EXECUTE FUNCTION channels.guard_ebay_listing_mapping_command_outcome();
CREATE TRIGGER ebay_listing_sync_admission_mapping_rejection_guard BEFORE INSERT ON channels.ebay_listing_sync_admission_failures
  FOR EACH ROW EXECUTE FUNCTION channels.guard_ebay_listing_mapping_command_outcome();
