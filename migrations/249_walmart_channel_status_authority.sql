-- Completed Walmart setup uses the existing channel lifecycle, like other
-- connections. The old setup left verified channels in pending_setup forever.
-- Explicit operator pauses remain pauses. This changes no stock or order rows.
WITH activated AS (
  UPDATE channels.channels c SET status='active',updated_at=CURRENT_TIMESTAMP
  FROM channels.walmart_connections wc
  JOIN channels.channel_connections cc ON cc.id=wc.connection_id AND cc.channel_id=wc.channel_id
  WHERE c.id=wc.channel_id AND c.provider='walmart' AND c.status='pending_setup'
  RETURNING c.id
)
INSERT INTO channels.walmart_connection_events(channel_id,actor,event_type,before_state,after_state,occurred_at)
SELECT id,'migration:249','channel_setup_completed',
  '{"channelStatus":"pending_setup"}'::jsonb,'{"channelStatus":"active"}'::jsonb,CURRENT_TIMESTAMP
FROM activated;
