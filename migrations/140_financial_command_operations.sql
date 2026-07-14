-- Migration 140: Operational controls for the durable financial-command ledger.
--
-- A dead command remains immutable unless an operator creates a matching audit
-- record and grants exactly one additional attempt. The original request is
-- still identified only by its hash: re-arming never invents or changes a
-- payload, and the caller must resend the same idempotency key and request.

ALTER TABLE public.financial_command_results
  ADD COLUMN IF NOT EXISTS attempt_limit INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.financial_command_results
  DROP CONSTRAINT IF EXISTS financial_command_results_attempt_limit_chk,
  DROP CONSTRAINT IF EXISTS financial_command_results_recovery_count_chk;

ALTER TABLE public.financial_command_results
  ADD CONSTRAINT financial_command_results_attempt_limit_chk CHECK (
    attempt_limit BETWEEN 1 AND 100
    AND attempt_count <= attempt_limit
  ),
  ADD CONSTRAINT financial_command_results_recovery_count_chk CHECK (
    recovery_count BETWEEN 0 AND 95
  );

CREATE TABLE IF NOT EXISTS public.financial_command_recoveries (
  id BIGSERIAL PRIMARY KEY,
  command_result_id BIGINT NOT NULL REFERENCES public.financial_command_results(id) ON DELETE CASCADE,
  recovery_number INTEGER NOT NULL,
  operator_id VARCHAR(200) NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  prior_attempt_count INTEGER NOT NULL,
  prior_attempt_limit INTEGER NOT NULL,
  prior_error_code VARCHAR(100) NOT NULL,
  prior_error_message VARCHAR(1000) NOT NULL,
  prior_completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT financial_command_recoveries_number_chk CHECK (recovery_number > 0),
  CONSTRAINT financial_command_recoveries_operator_chk CHECK (
    operator_id = btrim(operator_id) AND operator_id <> ''
  ),
  CONSTRAINT financial_command_recoveries_reason_chk CHECK (
    reason = btrim(reason) AND length(reason) BETWEEN 10 AND 1000
  ),
  CONSTRAINT financial_command_recoveries_attempts_chk CHECK (
    prior_attempt_count > 0
    AND prior_attempt_limit >= prior_attempt_count
  ),
  CONSTRAINT financial_command_recoveries_error_chk CHECK (
    prior_error_code = btrim(prior_error_code) AND prior_error_code <> ''
    AND prior_error_message = btrim(prior_error_message) AND prior_error_message <> ''
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_command_recoveries_command_number_uidx
  ON public.financial_command_recoveries (command_result_id, recovery_number);

CREATE INDEX IF NOT EXISTS financial_command_recoveries_created_idx
  ON public.financial_command_recoveries (created_at DESC, id DESC);

-- Replace migration 136's update guard. The existing transition rules remain;
-- the only new terminal-state exception is a dead-to-retryable transition
-- backed by the exact recovery record inserted in the same transaction.
CREATE OR REPLACE FUNCTION public.guard_financial_command_result_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  is_audited_recovery BOOLEAN := FALSE;
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

  IF OLD.status = 'dead' AND NEW.status = 'retryable' THEN
    is_audited_recovery := (
      NEW.attempt_count = OLD.attempt_count
      AND NEW.attempt_limit = OLD.attempt_limit + 1
      AND NEW.recovery_count = OLD.recovery_count + 1
      AND EXISTS (
        SELECT 1
        FROM public.financial_command_recoveries recovery
        WHERE recovery.command_result_id = OLD.id
          AND recovery.recovery_number = NEW.recovery_count
          AND recovery.prior_attempt_count = OLD.attempt_count
          AND recovery.prior_attempt_limit = OLD.attempt_limit
          AND recovery.prior_error_code = OLD.last_error_code
          AND recovery.prior_error_message = OLD.last_error_message
          AND recovery.prior_completed_at = OLD.completed_at
      )
    );
  END IF;

  IF OLD.status IN ('succeeded', 'rejected')
     OR (OLD.status = 'dead' AND NOT is_audited_recovery) THEN
    RAISE EXCEPTION 'Terminal financial command results are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(NEW.attempt_limit, NEW.recovery_count)
     IS DISTINCT FROM ROW(OLD.attempt_limit, OLD.recovery_count)
     AND NOT is_audited_recovery THEN
    RAISE EXCEPTION 'Financial command recovery budget changes require an audited dead-command recovery'
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

  IF OLD.status = 'dead'
     AND NEW.status <> 'retryable' THEN
    RAISE EXCEPTION 'Invalid financial command transition from dead to %', NEW.status
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

COMMENT ON COLUMN public.financial_command_results.attempt_limit IS
  'Current maximum attempts. Starts at five; each audited operator recovery grants exactly one more.';
COMMENT ON COLUMN public.financial_command_results.recovery_count IS
  'Number of audited dead-command recoveries granted to this immutable command identity.';
COMMENT ON TABLE public.financial_command_recoveries IS
  'Immutable operator audit evidence captured before granting one exact retry of a dead financial command.';
