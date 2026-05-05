CREATE TABLE IF NOT EXISTS oms.webhook_inbox (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider varchar(50) NOT NULL,
  topic varchar(100) NOT NULL,
  event_id varchar(200) NOT NULL,
  idempotency_key varchar(300) NOT NULL,
  source_domain varchar(255),
  payload jsonb NOT NULL,
  headers jsonb,
  status varchar(20) NOT NULL DEFAULT 'received',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  first_received_at timestamptz DEFAULT NOW(),
  last_attempt_at timestamptz,
  processed_at timestamptz,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_inbox_idempotency_key_uidx
  ON oms.webhook_inbox (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_status_updated
  ON oms.webhook_inbox (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_provider_topic_event
  ON oms.webhook_inbox (provider, topic, event_id);
