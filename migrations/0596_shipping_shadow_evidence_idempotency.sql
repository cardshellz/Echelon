-- Shadow evidence is append-only and retry-safe. The key is namespaced by
-- evidence kind so independent comparison workflows cannot collide.
CREATE UNIQUE INDEX IF NOT EXISTS shipping_quote_snapshots_shadow_evidence_key_uniq
  ON shipping.quote_snapshots (
    (request_payload->>'evidenceKind'),
    (request_payload->>'evidenceKey')
  )
  WHERE source = 'shadow'
    AND request_payload ? 'evidenceKind'
    AND request_payload ? 'evidenceKey';
