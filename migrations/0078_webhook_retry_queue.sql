CREATE TABLE IF NOT EXISTS oms.webhook_retry_queue (
    id SERIAL PRIMARY KEY,
    provider VARCHAR(50) NOT NULL,
    topic VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_retry_queue_status_next_retry ON oms.webhook_retry_queue(status, next_retry_at) WHERE status = 'pending';
