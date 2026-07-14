-- Migration 136: Durable, replay-safe results for financial HTTP commands.
--
-- This ledger is deliberately scoped more narrowly than the legacy
-- idempotency_keys table. The same caller-provided key may be reused for a
-- different actor, route, or resource, but never for a different request in
-- the same command scope. Completed HTTP responses are retained exactly as
-- JSONB plus their status code so a retry never repeats a financial mutation.

CREATE TABLE IF NOT EXISTS public.financial_command_results (
  id BIGSERIAL PRIMARY KEY,
  actor_type VARCHAR(40) NOT NULL,
  actor_id VARCHAR(200) NOT NULL,
  method VARCHAR(10) NOT NULL,
  route_template VARCHAR(300) NOT NULL,
  resource_key VARCHAR(300) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  command_name VARCHAR(120) NOT NULL,
  contract_version INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'claimed',
  lease_token VARCHAR(100),
  lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  http_status INTEGER,
  response_body JSONB,
  result_type VARCHAR(100),
  result_id VARCHAR(200),
  next_attempt_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  last_error_message VARCHAR(1000),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,

  CONSTRAINT financial_command_results_actor_type_chk CHECK (
    actor_type IN ('user', 'service', 'system')
  ),
  CONSTRAINT financial_command_results_actor_id_chk CHECK (
    actor_id = btrim(actor_id) AND actor_id <> ''
  ),
  CONSTRAINT financial_command_results_method_chk CHECK (
    method IN ('POST', 'PUT', 'PATCH', 'DELETE')
  ),
  CONSTRAINT financial_command_results_route_template_chk CHECK (
    route_template = btrim(route_template)
    AND route_template LIKE '/%'
    AND position('?' IN route_template) = 0
  ),
  CONSTRAINT financial_command_results_resource_key_chk CHECK (
    resource_key = btrim(resource_key) AND resource_key <> ''
  ),
  CONSTRAINT financial_command_results_idempotency_key_chk CHECK (
    idempotency_key = btrim(idempotency_key) AND idempotency_key <> ''
  ),
  CONSTRAINT financial_command_results_request_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT financial_command_results_command_name_chk CHECK (
    command_name = btrim(command_name)
    AND command_name ~ '^[a-z][a-z0-9_.:-]*$'
  ),
  CONSTRAINT financial_command_results_contract_version_chk CHECK (
    contract_version > 0
  ),
  CONSTRAINT financial_command_results_status_chk CHECK (
    status IN ('claimed', 'succeeded', 'rejected', 'retryable', 'dead')
  ),
  CONSTRAINT financial_command_results_attempt_count_chk CHECK (
    attempt_count > 0
  ),
  CONSTRAINT financial_command_results_result_identity_chk CHECK (
    (result_type IS NULL AND result_id IS NULL)
    OR (
      result_type = btrim(result_type)
      AND result_type <> ''
      AND result_id = btrim(result_id)
      AND result_id <> ''
    )
  ),
  CONSTRAINT financial_command_results_time_order_chk CHECK (
    updated_at >= created_at
    AND expires_at > created_at
    AND (lease_expires_at IS NULL OR (
      lease_expires_at > updated_at AND lease_expires_at <= expires_at
    ))
    AND (next_attempt_at IS NULL OR (
      next_attempt_at >= updated_at AND next_attempt_at < expires_at
    ))
    AND (completed_at IS NULL OR (
      completed_at >= created_at
      AND completed_at <= updated_at
      AND completed_at < expires_at
    ))
  ),
  CONSTRAINT financial_command_results_lifecycle_chk CHECK (
    (
      status = 'claimed'
      AND lease_token IS NOT NULL
      AND btrim(lease_token) <> ''
      AND lease_expires_at IS NOT NULL
      AND next_attempt_at IS NULL
      AND completed_at IS NULL
      AND http_status IS NULL
      AND response_body IS NULL
      AND result_type IS NULL
      AND result_id IS NULL
      AND last_error_code IS NULL
      AND last_error_message IS NULL
    ) OR (
      status = 'succeeded'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NULL
      AND completed_at IS NOT NULL
      AND http_status BETWEEN 200 AND 299
      AND response_body IS NOT NULL
      AND last_error_code IS NULL
      AND last_error_message IS NULL
    ) OR (
      status = 'rejected'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NULL
      AND completed_at IS NOT NULL
      AND http_status BETWEEN 400 AND 499
      AND response_body IS NOT NULL
      AND result_type IS NULL
      AND result_id IS NULL
      AND last_error_code IS NOT NULL
      AND btrim(last_error_code) <> ''
      AND last_error_message IS NOT NULL
      AND btrim(last_error_message) <> ''
    ) OR (
      status = 'retryable'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NOT NULL
      AND completed_at IS NULL
      AND http_status IS NULL
      AND response_body IS NULL
      AND result_type IS NULL
      AND result_id IS NULL
      AND last_error_code IS NOT NULL
      AND btrim(last_error_code) <> ''
      AND last_error_message IS NOT NULL
      AND btrim(last_error_message) <> ''
    ) OR (
      status = 'dead'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND next_attempt_at IS NULL
      AND completed_at IS NOT NULL
      AND http_status IS NULL
      AND response_body IS NULL
      AND result_type IS NULL
      AND result_id IS NULL
      AND last_error_code IS NOT NULL
      AND btrim(last_error_code) <> ''
      AND last_error_message IS NOT NULL
      AND btrim(last_error_message) <> ''
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_command_results_scope_uidx
  ON public.financial_command_results (
    actor_type,
    actor_id,
    method,
    route_template,
    resource_key,
    idempotency_key
  );

CREATE INDEX IF NOT EXISTS financial_command_results_claimed_lease_idx
  ON public.financial_command_results (lease_expires_at, id)
  WHERE status = 'claimed';

CREATE INDEX IF NOT EXISTS financial_command_results_retry_due_idx
  ON public.financial_command_results (next_attempt_at, id)
  WHERE status = 'retryable';

CREATE INDEX IF NOT EXISTS financial_command_results_expires_idx
  ON public.financial_command_results (expires_at, id);

CREATE INDEX IF NOT EXISTS financial_command_results_result_idx
  ON public.financial_command_results (result_type, result_id)
  WHERE result_type IS NOT NULL AND result_id IS NOT NULL;

-- CHECK constraints validate every individual state. This trigger additionally
-- protects invariants that depend on the previous version of a row: command
-- identity is immutable, attempts are monotonic, transitions are directed,
-- and terminal response/diagnostic evidence can never be rewritten.
CREATE OR REPLACE FUNCTION public.guard_financial_command_result_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.actor_type,
    NEW.actor_id,
    NEW.method,
    NEW.route_template,
    NEW.resource_key,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.command_name,
    NEW.contract_version,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.actor_type,
    OLD.actor_id,
    OLD.method,
    OLD.route_template,
    OLD.resource_key,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.command_name,
    OLD.contract_version,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Financial command scope, request hash, command name, and contract version are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('succeeded', 'rejected', 'dead') THEN
    RAISE EXCEPTION 'Terminal financial command results are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count
     OR NEW.attempt_count > OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Financial command attempt_count must advance monotonically by at most one'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'claimed'
     AND NEW.status NOT IN ('claimed', 'succeeded', 'rejected', 'retryable', 'dead') THEN
    RAISE EXCEPTION 'Invalid financial command transition from claimed to %', NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'retryable'
     AND NEW.status NOT IN ('claimed', 'dead') THEN
    RAISE EXCEPTION 'Invalid financial command transition from retryable to %', NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.attempt_count <> OLD.attempt_count AND NEW.status <> 'claimed' THEN
    RAISE EXCEPTION 'Financial command attempts may advance only when a command is claimed'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.attempt_count = OLD.attempt_count + 1
     AND OLD.status = 'claimed'
     AND OLD.lease_expires_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'An active financial command lease cannot be reclaimed'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.attempt_count = OLD.attempt_count + 1
     AND OLD.status = 'retryable'
     AND OLD.next_attempt_at > transaction_timestamp() THEN
    RAISE EXCEPTION 'A financial command retry cannot be claimed before next_attempt_at'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'retryable'
     AND NEW.status = 'claimed'
     AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'Reclaiming a retryable financial command must advance attempt_count'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'claimed' AND NEW.status = 'claimed' THEN
    IF NEW.attempt_count = OLD.attempt_count
       AND NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
      RAISE EXCEPTION 'Renewing a financial command lease cannot replace its token'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.attempt_count = OLD.attempt_count + 1
       AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN
      RAISE EXCEPTION 'Reclaiming an expired financial command lease requires a new token'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS financial_command_results_update_guard
  ON public.financial_command_results;

CREATE TRIGGER financial_command_results_update_guard
BEFORE UPDATE ON public.financial_command_results
FOR EACH ROW
EXECUTE FUNCTION public.guard_financial_command_result_update();

COMMENT ON TABLE public.financial_command_results IS
  'Durable idempotency, lease, retry, and exact HTTP replay ledger for financial commands.';
COMMENT ON COLUMN public.financial_command_results.request_hash IS
  'Lowercase SHA-256 of the canonical HTTP payload identity; excludes internal command name/version so completed results survive compatible deployments.';
COMMENT ON COLUMN public.financial_command_results.response_body IS
  'Exact JSON response body replayed with http_status for succeeded or rejected commands.';
COMMENT ON COLUMN public.financial_command_results.last_error_message IS
  'Sanitized, bounded operator-safe diagnostic; never store secrets or raw upstream payloads.';
