-- The service performer uses the same vendor directory as the AP counterparty,
-- while retaining an independent identity and the name recorded on the charge.
-- Historical names are intentionally not matched or backfilled to vendor IDs.
ALTER TABLE procurement.inbound_freight_costs
  ADD COLUMN IF NOT EXISTS performed_by_vendor_id integer;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'procurement.inbound_freight_costs'::regclass
      AND conname = 'inbound_freight_costs_performed_by_vendor_id_vendors_id_fk'
  ) THEN
    ALTER TABLE procurement.inbound_freight_costs
      ADD CONSTRAINT inbound_freight_costs_performed_by_vendor_id_vendors_id_fk
      FOREIGN KEY (performed_by_vendor_id) REFERENCES procurement.vendors(id)
      ON DELETE SET NULL;
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS inbound_freight_costs_performed_by_vendor_idx
  ON procurement.inbound_freight_costs(performed_by_vendor_id);

COMMENT ON COLUMN procurement.inbound_freight_costs.performed_by_vendor_id
  IS 'Vendor that performed the service; independent of vendor_id, the invoice counterparty';
COMMENT ON COLUMN procurement.inbound_freight_costs.performed_by_name
  IS 'Recorded performer name, retained for historical text entries and vendor renames or deletions';
