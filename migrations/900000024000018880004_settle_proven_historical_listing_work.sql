
-- Resolve only already-proven historical pairs using exactly the guarded rule.
-- The migration write fence prevents a concurrent continuation changing a failure
-- between its snapshot and the immutable settlement receipt. No provider work runs.
LOCK TABLE channels.ebay_listing_sync_jobs IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO channels.ebay_listing_sync_settlements(failed_job_id,replacement_job_id,before_record,actor,resolved_at)
SELECT failed.id,replacement.id,to_jsonb(failed),'system:listing-lifecycle',replacement.updated_at
FROM channels.ebay_listing_sync_jobs failed
JOIN LATERAL (
  SELECT candidate.id,candidate.updated_at FROM channels.ebay_listing_sync_jobs candidate
  WHERE candidate.identity_hash=failed.identity_hash AND candidate.channel_id=failed.channel_id
    AND candidate.connection_id=failed.connection_id AND candidate.product_id=failed.product_id
    AND candidate.operation='sync' AND candidate.state='completed' AND candidate.created_at>=failed.created_at
    AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=candidate.id AND e.revision=candidate.revision
      AND e.event='stage_completed' AND e.evidence->>'key'='verification' AND e.evidence->>'preparedIntentHash'=candidate.verification_intent_hash)
  ORDER BY candidate.created_at,candidate.id LIMIT 1
) replacement ON true
WHERE failed.operation='sync' AND failed.state='needs_attention'
  AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=failed.id AND e.event='stage_started' AND e.evidence->>'key'='prepare_listing')
  AND NOT EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=failed.id AND e.event IN ('stage_started','stage_completed')
    AND (e.evidence->>'key' IS DISTINCT FROM 'prepare_listing' OR e.event='stage_completed'))
ON CONFLICT(failed_job_id) DO NOTHING;
