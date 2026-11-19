-- Invoice and PO views share the immutable PO event approval record (227).
-- Scope this index to freight approvals; preserve all original events and money.
CREATE INDEX po_events_freight_invoice_approval_lookup_idx
  ON procurement.po_events ((payload_json#>>'{preview,invoiceId}'),actor_id,(payload_json->>'commandKey'),id DESC)
  WHERE event_type='freight_invoice_costs_approved';
