-- The shared lifecycle retains dispatch uncertainty separately from scheduling.
ALTER TABLE marketplace.listing_member_retirements
  ADD COLUMN dispatch_status text NOT NULL DEFAULT 'none' CHECK(dispatch_status IN ('none','unknown','accepted','authorized')),
  ADD COLUMN dispatch_key uuid,
  ADD COLUMN verification_attempts integer NOT NULL DEFAULT 0 CHECK(verification_attempts>=0),
  ADD COLUMN recovery_required boolean NOT NULL DEFAULT false;
CREATE TABLE marketplace.listing_member_recovery_commands (
  command_key uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES marketplace.listing_member_retirements(id),
  actor text NOT NULL CHECK(length(btrim(actor)) BETWEEN 1 AND 100),
  review_hash text NOT NULL CHECK(review_hash ~ '^[a-f0-9]{64}$'),
  before_record jsonb NOT NULL,
  observation jsonb NOT NULL,
  authorized_at timestamptz NOT NULL
);
CREATE TRIGGER listing_member_recovery_commands_immutable BEFORE UPDATE OR DELETE
  ON marketplace.listing_member_recovery_commands FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence();

ALTER TABLE marketplace.listing_member_recovery_commands ADD COLUMN owner_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE FUNCTION marketplace.guard_listing_member_recovery_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM marketplace.listing_member_retirements r WHERE r.id=NEW.operation_id
    AND to_jsonb(r)=NEW.before_record AND (r.recovery_required OR r.state='retiring')
    AND r.state NOT IN ('retired','superseded') AND NEW.observation->'identity'=r.identity
    AND jsonb_typeof(NEW.observation->'retired')='boolean'
    AND NEW.owner_transaction_id=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Member recovery requires the exact retained state and fresh identity observation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_member_recovery_command_guard BEFORE INSERT ON marketplace.listing_member_recovery_commands
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_member_recovery_command();
CREATE FUNCTION marketplace.check_listing_member_recovery_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM marketplace.listing_member_retirements r
    JOIN marketplace.listing_member_retirement_events e ON e.operation_id=r.id AND e.version=r.version
    WHERE r.id=NEW.operation_id AND r.dispatch_status='authorized' AND r.dispatch_key=NEW.command_key
      AND r.state='pending' AND NOT r.recovery_required AND r.version=(NEW.before_record->>'version')::int+1
      AND e.actor=NEW.actor AND e.after_state=to_jsonb(r)) THEN
    RAISE EXCEPTION 'Recovery authorization and audited scheduling must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER listing_member_recovery_complete AFTER INSERT ON marketplace.listing_member_recovery_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION marketplace.check_listing_member_recovery_complete();
CREATE FUNCTION marketplace.guard_listing_member_recovery_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.dispatch_status='authorized' AND OLD.dispatch_status<>'authorized')
    OR (OLD.recovery_required AND NOT NEW.recovery_required AND NEW.state NOT IN ('retired','superseded')) THEN
    IF NOT EXISTS(SELECT 1 FROM marketplace.listing_member_recovery_commands c WHERE c.operation_id=OLD.id
      AND c.command_key=NEW.dispatch_key AND c.before_record=to_jsonb(OLD) AND c.owner_transaction_id=pg_current_xact_id()) THEN
      RAISE EXCEPTION 'Removal recovery requires its immutable authorization' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_member_recovery_transition BEFORE UPDATE ON marketplace.listing_member_retirements
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_member_recovery_transition();
