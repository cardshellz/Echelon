-- Echelon currently has no PO/AP foreign-exchange conversion authority.
-- Fail closed instead of interpreting foreign-currency integer amounts as USD COGS.

DO $$
DECLARE
  non_usd_purchase_orders bigint;
  non_usd_vendor_invoices bigint;
  non_usd_ap_payments bigint;
BEGIN
  SELECT COUNT(*) INTO non_usd_purchase_orders
  FROM procurement.purchase_orders
  WHERE currency IS DISTINCT FROM 'USD';

  SELECT COUNT(*) INTO non_usd_vendor_invoices
  FROM procurement.vendor_invoices
  WHERE currency IS DISTINCT FROM 'USD';

  SELECT COUNT(*) INTO non_usd_ap_payments
  FROM procurement.ap_payments
  WHERE currency IS DISTINCT FROM 'USD';

  IF non_usd_purchase_orders > 0
    OR non_usd_vendor_invoices > 0
    OR non_usd_ap_payments > 0
  THEN
    RAISE EXCEPTION
      'Cannot enforce USD purchasing authority: % non-USD/null POs, % invoices, % payments',
      non_usd_purchase_orders,
      non_usd_vendor_invoices,
      non_usd_ap_payments;
  END IF;
END
$$;

ALTER TABLE procurement.purchase_orders
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN currency SET NOT NULL;

ALTER TABLE procurement.vendor_invoices
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN currency SET NOT NULL;

ALTER TABLE procurement.ap_payments
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN currency SET NOT NULL;

ALTER TABLE procurement.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_currency_usd_chk,
  ADD CONSTRAINT purchase_orders_currency_usd_chk CHECK (currency = 'USD');

ALTER TABLE procurement.vendor_invoices
  DROP CONSTRAINT IF EXISTS vendor_invoices_currency_usd_chk,
  ADD CONSTRAINT vendor_invoices_currency_usd_chk CHECK (currency = 'USD');

ALTER TABLE procurement.ap_payments
  DROP CONSTRAINT IF EXISTS ap_payments_currency_usd_chk,
  ADD CONSTRAINT ap_payments_currency_usd_chk CHECK (currency = 'USD');

COMMENT ON COLUMN procurement.purchase_orders.currency IS
  'USD reporting currency. Add an explicit immutable FX-rate authority before permitting other currencies.';
COMMENT ON COLUMN procurement.vendor_invoices.currency IS
  'USD reporting currency. Add an explicit immutable FX-rate authority before permitting other currencies.';
COMMENT ON COLUMN procurement.ap_payments.currency IS
  'USD reporting currency. Add an explicit immutable FX-rate authority before permitting other currencies.';
