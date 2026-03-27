-- Backfill member tiers with historically accurate data
-- Sets tier based on subscription active at time of order

WITH order_tier_lookup AS (
  SELECT DISTINCT ON (o.id)
    o.id as order_id,
    p.name as tier_name
  FROM oms_orders o
  JOIN members m ON LOWER(o.customer_email) = LOWER(m.email)
  JOIN member_subscriptions ms ON ms.member_id = m.id
  JOIN plans p ON p.id = ms.plan_id
  WHERE 
    -- Subscription was active during order date
    o.ordered_at >= ms.cycle_started_at
    AND (o.ordered_at < ms.cycle_ends_at OR ms.cycle_ends_at IS NULL)
    -- Include all statuses (active, cancelled, expired) - they were valid during their cycle
  ORDER BY 
    o.id,
    -- If multiple subscriptions match, pick most recent start (in case of overlaps)
    ms.cycle_started_at DESC,
    -- Tiebreaker: prefer active status
    CASE WHEN ms.status = 'active' THEN 0 ELSE 1 END
)
UPDATE oms_orders
SET member_tier = order_tier_lookup.tier_name
FROM order_tier_lookup
WHERE oms_orders.id = order_tier_lookup.order_id
  AND (oms_orders.member_tier IS NULL OR oms_orders.member_tier != order_tier_lookup.tier_name);

-- Show results
SELECT 
  COUNT(*) as total_updated,
  member_tier,
  COUNT(*) as count_per_tier
FROM oms_orders
WHERE member_tier IS NOT NULL
GROUP BY member_tier
ORDER BY member_tier;

-- Show stats
SELECT 
  COUNT(*) as total_orders,
  COUNT(member_tier) as has_tier,
  COUNT(*) - COUNT(member_tier) as no_tier,
  ROUND(100.0 * COUNT(member_tier) / COUNT(*), 2) as pct_with_tier
FROM oms_orders;
