-- Reinspect derived return-option failures under the corrected purchase-date
-- authority. No order, fulfillment, payment, inventory or rewards row is changed.
-- Bounded failures otherwise wait for a source change even after code is fixed.
-- Use the normal transactional dirty queue and leased inspector for every order;
-- do not repair one historical order or assume any failed return is eligible.
INSERT INTO oms.customer_order_action_invalidations (oms_order_id)
SELECT projection.oms_order_id
FROM oms.customer_order_actions projection
WHERE projection.last_error_code = 'ORDER_ACTION_PARTIAL_INSPECTION_FAILED'
  AND projection.snapshot ->> 'returnFailed' = 'true'
  AND NOT EXISTS (
    SELECT 1 FROM oms.customer_order_action_invalidations dirty
    WHERE dirty.oms_order_id = projection.oms_order_id
  )
ORDER BY projection.oms_order_id;
