-- Match the shared eBay policy ID contract and existing Catalog override columns.
-- Widening preserves every saved value; it does not select or repair a policy.
ALTER TABLE ebay.ebay_category_mappings
  ALTER COLUMN fulfillment_policy_override TYPE varchar(100),
  ALTER COLUMN return_policy_override TYPE varchar(100),
  ALTER COLUMN payment_policy_override TYPE varchar(100);
