CREATE TABLE IF NOT EXISTS procurement.landed_cost_adjustments (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  inbound_shipment_line_id integer NOT NULL REFERENCES procurement.inbound_shipment_lines(id) ON DELETE CASCADE,
  purchase_order_line_id integer NOT NULL REFERENCES procurement.purchase_order_lines(id),
  adjustment_amount_cents bigint NOT NULL,
  reason text NOT NULL,
  created_by varchar(255) REFERENCES identity.users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now() NOT NULL
);
