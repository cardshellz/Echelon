-- LOCAL DRAFT ONLY: no PR identity has been allocated; not release-discovered.
-- After PR publication is authorized, allocate the actual migration and preserve
-- these SQL bytes. Requires channels.channel_connections, identity.users and
-- public.audit_events. Never install this from application boot.
CREATE TABLE channels.shopify_oauth_authorizations (
  operation_id uuid PRIMARY KEY,
  state_hash varchar(64) NOT NULL,
  actor_id varchar NOT NULL,
  session_hash varchar(64) NOT NULL,
  config_fingerprint varchar(64) NOT NULL,
  shop_domain varchar(255) NOT NULL,
  channel_id integer NOT NULL,
  connection_id integer NOT NULL,
  connection_fingerprint varchar(64) NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'issued',
  attempt_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  error_code varchar(100),
  CONSTRAINT shopify_oauth_authorizations_hashes_chk CHECK (
    state_hash ~ '^[a-f0-9]{64}$' AND session_hash ~ '^[a-f0-9]{64}$'
    AND config_fingerprint ~ '^[a-f0-9]{64}$' AND connection_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT shopify_oauth_authorizations_shop_chk CHECK (shop_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.]myshopify[.]com$'),
  CONSTRAINT shopify_oauth_authorizations_expiry_chk CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CONSTRAINT shopify_oauth_authorizations_error_chk CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,99}$'),
  CONSTRAINT shopify_oauth_authorizations_status_chk CHECK (
    status IN ('issued','exchanging','succeeded','exchange_unknown','failed','superseded')),
  CONSTRAINT shopify_oauth_authorizations_lifecycle_chk CHECK (
    (status = 'issued' AND attempt_id IS NULL AND started_at IS NULL AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'exchanging' AND attempt_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND attempt_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NOT NULL AND error_code IS NULL)
    OR (status IN ('failed','exchange_unknown') AND attempt_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NOT NULL AND error_code IS NOT NULL)
    OR (status = 'superseded' AND completed_at IS NOT NULL AND error_code IS NOT NULL
      AND ((attempt_id IS NULL AND started_at IS NULL) OR (attempt_id IS NOT NULL AND started_at IS NOT NULL)))),
  CONSTRAINT shopify_oauth_authorizations_times_chk CHECK (
    (started_at IS NULL OR (started_at >= created_at AND started_at < expires_at))
    AND (completed_at IS NULL OR completed_at >= coalesce(started_at, created_at)))
);
CREATE UNIQUE INDEX shopify_oauth_authorizations_state_uq ON channels.shopify_oauth_authorizations(state_hash);
CREATE UNIQUE INDEX shopify_oauth_authorizations_attempt_uq ON channels.shopify_oauth_authorizations(attempt_id);
CREATE UNIQUE INDEX shopify_oauth_authorizations_active_connection_uq ON channels.shopify_oauth_authorizations(connection_id)
  WHERE status IN ('issued','exchanging');
CREATE INDEX shopify_oauth_authorizations_expiry_idx ON channels.shopify_oauth_authorizations(expires_at);

-- Bindings never change after issuance. Attempt ownership is assigned exactly once;
-- neither expiry nor provider uncertainty authorizes reclaiming an old challenge.
CREATE FUNCTION channels.guard_shopify_oauth_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'issued' THEN
      RAISE EXCEPTION 'Shopify authorization must start issued' USING ERRCODE = '23514';
    END IF;
    -- These IDs are immutable historical snapshots, not permanent foreign keys.
    -- Verify existence atomically at issuance without blocking normal later deletion
    -- or losing evidence needed to settle an already dispatched provider attempt.
    PERFORM 1 FROM identity.users WHERE id = NEW.actor_id FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shopify authorization actor does not exist' USING ERRCODE = '23503';
    END IF;
    PERFORM 1 FROM channels.channel_connections
      WHERE id = NEW.connection_id AND channel_id = NEW.channel_id FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shopify authorization connection does not belong to channel' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.operation_id, NEW.state_hash, NEW.actor_id, NEW.session_hash, NEW.config_fingerprint,
      NEW.shop_domain, NEW.channel_id, NEW.connection_id, NEW.connection_fingerprint, NEW.created_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.operation_id, OLD.state_hash, OLD.actor_id, OLD.session_hash, OLD.config_fingerprint,
      OLD.shop_domain, OLD.channel_id, OLD.connection_id, OLD.connection_fingerprint, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'Shopify authorization binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status = 'issued' AND NEW.status IN ('exchanging','superseded'))
      OR (OLD.status = 'exchanging' AND NEW.status IN ('succeeded','exchange_unknown','failed','superseded'))) THEN
    RAISE EXCEPTION 'Invalid Shopify authorization transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'exchanging' AND (NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
    RAISE EXCEPTION 'Shopify authorization attempt is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shopify_oauth_authorizations_guard
  BEFORE INSERT OR UPDATE ON channels.shopify_oauth_authorizations
  FOR EACH ROW EXECUTE FUNCTION channels.guard_shopify_oauth_authorization();

-- Additive protection: existing procurement/receiving audit functions and triggers
-- stay untouched. Ordinary unrelated audit rows retain their existing behavior.
CREATE FUNCTION public.guard_shopify_oauth_audit_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM public.audit_events WHERE starts_with(action, 'channels.shopify_oauth.')) THEN
      RAISE EXCEPTION 'Shopify authorization audit history cannot be truncated' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF starts_with(OLD.action, 'channels.shopify_oauth.') THEN
    RAISE EXCEPTION 'Shopify authorization audit history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF starts_with(NEW.action, 'channels.shopify_oauth.') THEN
      RAISE EXCEPTION 'Existing audit rows cannot become Shopify authorization history' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER shopify_oauth_audit_history_immutable
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_shopify_oauth_audit_history();
CREATE TRIGGER shopify_oauth_audit_history_truncate_immutable
  BEFORE TRUNCATE ON public.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_shopify_oauth_audit_history();
