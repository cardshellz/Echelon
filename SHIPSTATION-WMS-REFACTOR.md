# ShipStation → WMS Refactor

## Summary

Refactored the ShipStation integration to route through WMS (Warehouse Management System) instead of OMS (Order Management System). ShipStation is a warehouse/fulfillment tool and should only communicate through the WMS layer.

### Changes

**1. Push originates from WMS (`wms-sync.service.ts`)**
- Added `shipStation` and `omsService` to `WmsSyncServices` interface
- After WMS order creation (step 8), if ShipStation is configured, fetches the full OMS order and pushes to ShipStation
- Push happens immediately after WMS order creation — no delay vs. the old flow

**2. Removed direct OMS → ShipStation push (`oms-webhooks.ts`)**
- Removed the `pushOrder` call from the `orders/paid` webhook handler (was ~line 478)
- WMS sync now handles the push via `wmsSyncService.syncOmsOrderToWms()`

**3. Removed redundant eBay direct pushes (`ebay-order-ingestion.ts`)**
- Removed `pushOrder` calls from the eBay polling handler, reingest function, and webhook handler
- eBay orders already go through `wmsSyncService.syncOmsOrderToWms()` which now handles the push

**4. ShipStation SHIP_NOTIFY updates WMS first (`shipstation.service.ts`)**
- Rewrote `processShipNotify` to be WMS-first:
  - Looks up WMS order by `oms_fulfillment_order_id` (now matches `source IN ('oms', 'ebay')`, was `'ebay'` only)
  - Checks WMS status for idempotency (was checking OMS)
  - Updates WMS `warehouse_status = 'shipped'`, `completed_at`, `tracking_number`, `tracking_url`
  - Marks WMS order items as completed
  - Then derives OMS status (shipped, tracking synced) as secondary action
  - Legacy path retained for orders without WMS rows (direct inventory deduction)

**5. Reconcile reads from WMS (`index.ts`)**
- Changed the hourly ShipStation reconcile to query `wms.orders JOIN oms.oms_orders` instead of querying `oms.oms_orders` directly
- Reconcile now looks at WMS `warehouse_status` for decision-making
- Uses WMS `tracking_number` and `completed_at` for the ShipStation markAsShipped call
- Stamps `shipstation_reconciled_at` on the OMS row (unchanged)

**6. Services wiring (`services/index.ts`)**
- Pass `shipStation` and `omsService` to `WmsSyncService` constructor

### Untouched (intentional)
- **Dropship vendor-order-polling.ts**: Creates WMS orders directly (not via wmsSync), keeps its own pushOrder call
- **OMS schema `shipstation_order_id`**: Kept on `oms.oms_orders` — pushOrder stores it there, picking routes reference it
- **OrderKey format**: `echelon-oms-{omsOrderId}` preserved for backward compatibility
- **Shopify fulfillments/update webhook**: Already updates both WMS and OMS (commit 0ce513a)

## Assumptions

1. **WMS orders exist before ShipStation push**: The push happens after WMS order creation in `syncOmsOrderToWms`, so the WMS row always exists at push time
2. **OMS order data is complete at push time**: `pushOrder` needs customer, shipping, and line item data from the OMS order. Assumed `omsService.getOrderById()` returns a fully populated order at the time of WMS sync
3. **`source IN ('oms', 'ebay')` covers all WMS order sources**: The SHIP_NOTIFY WMS lookup now matches both OMS-synced and eBay-direct orders. If other sources are added, they need to be included
4. **Reconcile JOIN is reliable**: The `wms.orders.oms_fulfillment_order_id → oms.oms_orders.id` JOIN assumes all WMS orders linked to ShipStation have a valid OMS link
5. **Dropship orders don't go through wmsSync**: The dropship path creates WMS orders directly, so its pushOrder call must remain

## Risks

1. **Race condition on WMS push**: If `syncOmsOrderToWms` succeeds but the ShipStation push fails, the order won't be in ShipStation until the hourly reconcile catches it. The old flow had the same risk (push from OMS could also fail). Mitigation: hourly reconcile as safety net
2. **eBay webhook path**: The eBay webhook handler still uses `createWmsOrderFromEbay` (legacy direct-write), not `wmsSync`. Orders that only come through the webhook (not polling) won't get the immediate ShipStation push. They'll be caught by the hourly reconcile. Impact: low — eBay polling is the primary ingestion path
3. **WMS source filter change**: `processShipNotify` now matches `source IN ('oms', 'ebay')` instead of just `'ebay'`. If a WMS order exists with a different source but the same `oms_fulfillment_order_id`, it could be matched incorrectly. Risk is minimal since `oms_fulfillment_order_id` is unique per OMS order

## Test Coverage

- **TypeScript compilation**: `tsc --noEmit` passes with zero errors
- **Manual testing needed**:
  1. Create a Shopify order → verify it appears in ShipStation (via WMS push, not OMS push)
  2. Ship in ShipStation → verify WMS order marked shipped, OMS order marked shipped, tracking synced
  3. Hourly reconcile → verify it picks up WMS-shipped orders and syncs to ShipStation
  4. eBay order → verify it reaches ShipStation via wmsSync path
  5. Cancel flow → verify ShipStation cancel still works
  6. Dropship order → verify it still reaches ShipStation (unchanged path)

## Failure Modes

| Failure | Impact | Mitigation |
|---------|--------|------------|
| ShipStation API down during push | Order not in ShipStation immediately | Hourly reconcile catches it |
| WMS sync fails | No WMS order, no ShipStation push | Order stuck in OMS; manual intervention or sync recovery |
| OMS getOrderById returns null | ShipStation push skipped in wmsSync | Log warning; reconcile won't find shipstation_order_id |
| processShipNotify: WMS order not found | Falls back to legacy OMS-only path | Works for old orders without WMS rows |
| processShipNotify: duplicate webhook | Skipped via WMS status check (`warehouse_status = 'shipped'`) | Idempotent |
| Reconcile JOIN fails (orphaned WMS order) | Order not reconciled | OMS<->WMS reconcile loop catches status divergence |
| Dropship push fails | Dropship order not in ShipStation | No automatic recovery; manual check needed |
