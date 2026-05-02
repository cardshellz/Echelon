CREATE INDEX IF NOT EXISTS dropship_audit_severity_created_idx
  ON dropship.dropship_audit_events(severity, created_at);

CREATE INDEX IF NOT EXISTS dropship_audit_event_type_created_idx
  ON dropship.dropship_audit_events(event_type, created_at);

CREATE INDEX IF NOT EXISTS dropship_audit_store_created_idx
  ON dropship.dropship_audit_events(store_connection_id, created_at)
  WHERE store_connection_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dropship_listing_job_vendor_status_idx
  ON dropship.dropship_listing_push_jobs(vendor_id, status, updated_at);

CREATE INDEX IF NOT EXISTS dropship_tracking_push_vendor_status_idx
  ON dropship.dropship_marketplace_tracking_pushes(vendor_id, status, updated_at);
