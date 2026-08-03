-- One accepted provider event may have at most one runnable retry. The inbox
-- row is the durable provider-event identity; retry rows are delivery attempts.
-- Keep the oldest pending attempt and retain redundant rows as superseded
-- evidence instead of deleting operational history.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY source_inbox_id
      ORDER BY created_at ASC NULLS LAST, id ASC
    ) AS row_number
  FROM oms.webhook_retry_queue
  WHERE status = 'pending'
    AND source_inbox_id IS NOT NULL
)
UPDATE oms.webhook_retry_queue retry
SET
  status = 'success',
  last_error = CONCAT_WS(
    E'\n',
    NULLIF(retry.last_error, ''),
    'Superseded duplicate pending retry for the same webhook inbox event'
  ),
  updated_at = NOW()
FROM ranked
WHERE retry.id = ranked.id
  AND ranked.row_number > 1;

DROP INDEX IF EXISTS oms.uq_webhook_retry_pending_source_inbox;
CREATE UNIQUE INDEX uq_webhook_retry_pending_source_inbox
  ON oms.webhook_retry_queue(source_inbox_id)
  WHERE status = 'pending'
    AND source_inbox_id IS NOT NULL;
