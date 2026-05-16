# Procurement and WMS Hardening Log

This log preserves working context for the procurement and WMS hardening program.
Update it before major context compaction, after each PR, and whenever a durable
decision or operational finding should survive the chat thread.

Planning reference: `docs/PROCUREMENT-WMS-HARDENING-PLAN.md`

## Note-Taking Protocol

For each phase, capture:

- date
- scope
- code areas reviewed
- decisions made
- implementation PRs
- verification commands
- production or operational evidence
- remaining risks
- next step

Keep notes factual. Distinguish verified code behavior from proposals and from
live operational observations.

## Program Status

Started: 2026-05-16

Current phase: Phase 1 - Domain Boundaries and Route Split Plan

Current objective:

- Establish the first implementation boundary for procurement hardening.
- Begin with PO lifecycle and receiving orchestration because those flows can
  create inventory, PO, AP, and reporting drift.

## Baseline Decisions

- Demand forecasting comes after the purchasing backbone is reliable.
- The forecast engine should feed a single purchasing recommendation engine.
- The purchasing recommendation engine should not directly mutate POs unless an
  autopilot policy explicitly allows it.
- Route monoliths should be split incrementally behind stable URLs.
- File splitting is not the goal by itself; one authoritative owner for each
  business decision is the goal.
- The first behavioral boundary should be PO lifecycle plus receiving close.
- Receiving close must not allow inventory to become correct while PO
  reconciliation silently fails.
- High-risk operator actions must become idempotent and safe to retry.
- Admin UI should show blockers and next actions without requiring database or
  script knowledge.

## Current Evidence Snapshot

The current procurement admin surface includes:

- purchasing dashboard
- purchase orders
- purchase order edit/detail workflows
- reorder analysis
- receiving
- suppliers
- inbound shipments
- landed cost and cost dashboard
- inventory history
- AP dashboard
- vendor invoices
- AP payments
- procurement settings

Initial code map:

- `client/src/App.tsx`
- `client/src/components/layout/AppShell.tsx`
- `client/src/pages/PurchasingDashboard.tsx`
- `client/src/pages/PurchasingView.tsx`
- `client/src/pages/PurchaseOrders.tsx`
- `client/src/pages/PurchaseOrderEdit.tsx`
- `client/src/pages/PurchaseOrderDetail.tsx`
- `client/src/pages/Receiving.tsx`
- `client/src/pages/Suppliers.tsx`
- `client/src/pages/InboundShipments.tsx`
- `client/src/pages/InboundShipmentDetail.tsx`
- `client/src/pages/APDashboard.tsx`
- `client/src/pages/APInvoices.tsx`
- `client/src/pages/APInvoiceDetail.tsx`
- `client/src/pages/APPayments.tsx`
- `client/src/pages/CostDashboard.tsx`
- `client/src/pages/InventoryHistory.tsx`
- `client/src/pages/ProcurementSettings.tsx`
- `server/modules/procurement/procurement.routes.ts`
- `server/modules/procurement/purchasing.service.ts`
- `server/modules/procurement/receiving.service.ts`
- `server/modules/procurement/shipment-tracking.service.ts`
- `server/modules/procurement/ap-ledger.service.ts`
- `server/modules/procurement/procurement.storage.ts`
- `shared/schema/procurement.schema.ts`
- `shared/schema/inventory.schema.ts`
- `shared/schema/warehouse.schema.ts`
- `shared/schema/orders.schema.ts`

## Known Initial Risks

1. Procurement routes are too broad.
   - The route module currently mixes vendors, receiving, replenishment,
     operations, purchasing intelligence, POs, inbound shipments, landed cost,
     AP, notifications, and settings.

2. PO lifecycle authority is split.
   - A dual-track `physicalStatus` / `financialStatus` model exists.
   - Some newer paths use the physical transition helper.
   - Several older paths still update legacy `status` directly.

3. Receiving close can drift from PO reconciliation.
   - Inventory posting and receiving close happen transactionally.
   - PO reconciliation can happen after the transaction and be logged instead
     of made authoritative.

4. Receipt creation can be retried into duplicates.
   - The create-receipt-from-PO endpoint does not consistently require
     idempotency.
   - UI callers can invoke it without an idempotency key.

5. Purchasing recommendation authority is split.
   - Reorder analysis and auto-draft have more than one execution path.
   - Forecasting should not be added until this is unified.

6. Permissions and idempotency are inconsistent.
   - Some procurement-intelligence routes use inventory permissions.
   - Several high-risk lifecycle mutations do not have a consistent retry
     contract.

## Phase 1 Work Queue

1. Define route module boundaries.
2. Define service ownership boundaries.
3. Identify every PO lifecycle mutation and its current authority path.
4. Identify every receiving mutation and its current authority path.
5. Identify required idempotency keys and natural database uniqueness.
6. Produce the first implementation slice.

## Phase 1 Exit Criteria

- We know exactly which routes move into each domain module.
- We know which service owns each business action.
- We know the first PR scope and what it must not touch.
- We have a checklist for tests and verification.

## Checkpoints

### 2026-05-16 - Program Start

Created the durable hardening plan and this progress log.

Next step:

- Start Phase 1 by mapping PO lifecycle and receiving route/service ownership
  into a concrete split plan.

### 2026-05-16 - Phase 1 Initial Route and Service Ownership Map

Scope:

- Read-only mapping of purchase order and receiving routes.
- Read-only mapping of purchasing and receiving service functions.

Purchase order route groups currently inside `procurement.routes.ts`:

- PO list/preload/detail:
  - `GET /api/purchase-orders`
  - `GET /api/purchase-orders/new-preload`
  - `GET /api/purchase-orders/:id`
- PO header:
  - `PATCH /api/purchase-orders/:id`
  - `PATCH /api/purchase-orders/:id/incoterms-charges`
  - `DELETE /api/purchase-orders/:id`
- PO lines:
  - `GET /api/purchase-orders/:id/lines`
  - `GET /api/purchase-orders/:id/shippable-lines`
  - `POST /api/purchase-orders/:id/lines`
  - `POST /api/purchase-orders/:id/lines/bulk`
  - `PATCH /api/purchase-orders/lines/:lineId`
  - `DELETE /api/purchase-orders/lines/:lineId`
- PO lifecycle:
  - `POST /api/purchase-orders/:id/submit`
  - `POST /api/purchase-orders/:id/return-to-draft`
  - `POST /api/purchase-orders/:id/approve`
  - `POST /api/purchase-orders/:id/send`
  - `POST /api/purchase-orders/:id/send-to-vendor`
  - `POST /api/purchase-orders/:id/mark-shipped`
  - `POST /api/purchase-orders/:id/mark-in-transit`
  - `POST /api/purchase-orders/:id/mark-arrived`
  - `POST /api/purchase-orders/:id/acknowledge`
  - `POST /api/purchase-orders/:id/cancel`
  - `POST /api/purchase-orders/:id/void`
  - `POST /api/purchase-orders/:id/close`
  - `POST /api/purchase-orders/:id/close-short`
- PO receiving bridge:
  - `POST /api/purchase-orders/:id/create-receipt`
  - `GET /api/purchase-orders/:id/receipts`
- PO audit/attachments/related records:
  - `GET /api/purchase-orders/:id/history`
  - `GET /api/purchase-orders/:id/exceptions`
  - `POST /api/purchase-orders/:id/exceptions`
  - `GET /api/purchase-orders/:id/payments`
  - `GET /api/purchase-orders/:id/revisions`
  - `GET /api/purchase-orders/:id/document`
  - `POST /api/purchase-orders/:id/send-email`
  - `GET /api/purchase-orders/:id/shipments`
  - `GET /api/purchase-orders/:id/invoices`

Receiving route groups currently inside `procurement.routes.ts`:

- receiving header:
  - `GET /api/receiving`
  - `GET /api/receiving/:id`
  - `POST /api/receiving`
  - `PATCH /api/receiving/:id`
  - `DELETE /api/receiving/:id`
  - `POST /api/receiving/:id/open`
  - `POST /api/receiving/:id/close`
- receiving lines:
  - `GET /api/receiving/:orderId/lines`
  - `POST /api/receiving/:orderId/lines`
  - `PATCH /api/receiving/lines/:lineId`
  - `POST /api/receiving/lines/:lineId/create-variant`
  - `POST /api/receiving/:orderId/complete-all`
  - `DELETE /api/receiving/lines/:lineId`
  - `POST /api/receiving/:orderId/lines/bulk`
- receiving discard:
  - `DELETE /api/receiving-orders/:id/discard`

Service functions currently carrying PO lifecycle and receiving bridge logic:

- `purchasing.service.ts`
  - `recalculateTotals`
  - `transitionPhysical`
  - `transitionFinancial`
  - `createPO`
  - `submit`
  - `returnToDraft`
  - `approve`
  - `send`
  - `sendToVendor`
  - `acknowledge`
  - `cancel`
  - `close`
  - `closeShort`
  - `createReceiptFromPO`
  - `onReceivingOrderClosed`
  - `createPOFromReorder`
  - `createPurchaseOrderWithLines`
- `receiving.service.ts`
  - `discardDraftReceivingOrder`
  - `open`
  - `close`
  - `completeAllLines`
  - `createVariantFromLine`

Phase 1 ownership direction:

- `purchase-orders.routes.ts` should own PO reads, header edits, lines, document,
  related PO records, and lifecycle endpoints.
- `purchase-order-lifecycle.service.ts` should own all lifecycle transitions.
- `receiving.routes.ts` should own receiving header and line endpoints.
- `receiving-orchestration.service.ts` should own close receipt plus PO
  reconciliation.
- `POST /api/purchase-orders/:id/create-receipt` is a bridge endpoint. It can
  remain URL-stable, but its service owner should be receiving orchestration or
  a PO-to-receipt command, not general route code.

Immediate implementation candidate:

- First PR should not move every procurement route.
- First PR should centralize PO lifecycle authority and make lifecycle route
  handlers thin.
- Second PR should centralize create-receipt and close-receipt orchestration.

### 2026-05-16 - Phase 1 Slice 1: PO Lifecycle Boundary

Scope:

- Extracted PO lifecycle transition rules into
  `server/modules/procurement/purchase-order-lifecycle.service.ts`.
- Routed `transitionPhysical`, `transitionFinancial`, `send`, `sendToVendor`,
  `acknowledge`, and `cancel` through the lifecycle boundary.
- Added compatibility handling for pre-dual-track POs where legacy `status`
  had advanced but `physicalStatus` still held the default `draft`.
- Exported the lifecycle boundary from `server/modules/procurement/index.ts`.
- Added focused lifecycle unit coverage.

Intentionally deferred:

- `close`, `closeShort`, and `onReceivingOrderClosed`.
- Receipt creation and receiving close orchestration.
- Route-file splitting.
- Create/send validation-order cleanup.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts`
- Known adjacent failure, left out of scope:
  `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/po-create-send.service.test.ts`
  still fails three tests because those test payloads omit `product_id`, so
  validation returns `lines[0].product_id is required` before reaching the
  quantity, unit-cost, or missing-vendor assertions.

Next step:

- Open the lifecycle-boundary PR, or continue directly into Phase 1 Slice 2:
  idempotent PO create-receipt plus receiving close orchestration.
