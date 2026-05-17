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

### 2026-05-16 - Phase 1 Slice 2: Receiving Idempotency and PO Reconciliation

Scope:

- Made `POST /api/purchase-orders/:id/create-receipt` require
  `Idempotency-Key`.
- Updated PO detail, receiving, and inbound shipment UI entry points to send a
  fresh idempotency key when creating a PO receipt.
- Added service-level idempotency for `createReceiptFromPO`: when an active
  draft/open/receiving/verified receipt already exists for the PO, the service
  returns that receipt instead of creating another header and line set.
- Added a procurement storage lookup for receiving orders by purchase order.
- Made `ReceivingService.close` retry-safe for already-closed receipts by
  rerunning PO reconciliation without reposting inventory.
- Removed the swallowed PO reconciliation failure after inventory posting.
  Reconciliation errors now surface to the caller, so operators see that the
  receipt needs retry/repair instead of leaving silent PO drift.
- Made `onReceivingOrderClosed` skip receiving lines that already have a
  `po_receipts` row, preventing duplicate close/retry attempts from
  double-incrementing PO line received quantities.
- Guarded repeated PO status transitions so reconciliation replay does not add
  duplicate status-history rows when the PO is already received/closed.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/dual-track.service.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts`

Environment note:

- This slice was developed in clean worktree
  `C:\Users\owner\Echelon-procurement-next` because the main workspace had
  unrelated dirty OMS/currency files that overlapped the new `origin/main`.
  The worktree uses a local `node_modules` junction to the main checkout for
  verification only.

Remaining risk:

- PO line update plus `po_receipts` insert are now replay-safe after a
  successful reconciliation, but they still are not one database transaction.
  A failure between line update and receipt insert remains a deeper atomicity
  gap to handle when we extract full receiving orchestration.

Next step:

- Open the receiving idempotency/reconciliation PR.
- Then move to the next meaningful chunk: receiving orchestration extraction
  plus PO close/close-short alignment with the lifecycle boundary.

### 2026-05-16 - Phase 1 Slice 3: Atomic PO Receipt Reconciliation

Scope:

- Extracted PO receipt reconciliation into
  `server/modules/procurement/purchase-order-receipt-reconciliation.service.ts`.
- Kept the existing `createPurchasingService(...).onReceivingOrderClosed`
  public API stable, but made it delegate to the reconciliation service instead
  of carrying receipt matching, PO line mutation, receipt insert, total
  recalculation, and status advancement inline.
- Added `procurementStorage.reconcilePoReceiptLine(...)` as the single storage
  boundary for applying a receiving line to a PO line.
- Made the PO line received/damaged quantity update and `po_receipts` insert a
  single database transaction.
- Kept receipt replay idempotent by returning the existing receipt when the
  receiving-line receipt already exists, including duplicate-key races against
  `po_receipts_po_line_rcv_line_idx`.
- Preserved legitimate zero-cost receiving lines during PO receipt
  reconciliation and carried receipt cost in both cents and mills.
- Exported the reconciliation service from the procurement module boundary.
- Updated dual-track receiving tests to assert the transactional reconciliation
  call instead of the old separate line-update and receipt-insert calls.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/dual-track.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`

Remaining risk:

- `ReceivingService.close` still coordinates inventory posting and PO
  reconciliation as two high-level phases. This slice makes the PO
  reconciliation write atomic, but the broader receiving orchestration still
  needs a dedicated owner before we split route files further.

Next step:

- Run the broader targeted procurement verification set, then open the
  reconciliation PR.
- After merge, continue with receiving orchestration ownership and PO
  close/close-short alignment.

### 2026-05-16 - Phase 1 Slice 4: Receiving Close Ownership and PO Close Alignment

Scope:

- Added `server/modules/procurement/receiving-orchestration.service.ts` as the
  receiving-side owner for mapping closed receiving lines into PO
  reconciliation input and delegating PO-linked receipts to purchasing.
- Kept `ReceivingService.close` behavior stable, but moved its PO
  reconciliation handoff through the orchestration boundary instead of keeping
  that mapping inline in the service class.
- Added `server/modules/procurement/purchase-order-close.service.ts` as the PO
  close boundary for standard close, close-short status patching, and remaining
  line close-short patches.
- Routed `purchasing.close` and `purchasing.closeShort` through the close
  boundary while preserving existing 3-way match gate behavior and existing
  close-short line updates.
- Exported the new close and receiving orchestration helpers from the
  procurement module boundary.
- Added focused unit tests for close patch construction, close-short patch
  construction, receiving reconciliation mapping, PO-linked reconciliation
  delegation, and zero-cost receiving line preservation.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchase-order-close.service.test.ts server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Remaining risk:

- Inventory posting and PO reconciliation are still separate high-level phases
  inside receiving close. The PO reconciliation write is atomic from Slice 3,
  and this slice gives the handoff an owner, but a future receiving
  orchestration slice still needs to formalize the full close command,
  side-effect order, operator retry result, and route ownership.

Next step:

- Open the receiving close ownership PR.
- After merge, continue into route/API ownership: split stable receiving and PO
  route handlers behind the existing URLs, or first add operator-visible
  receiving reconciliation retry/status endpoints if the UI needs that before
  route splitting.

### 2026-05-16 - Phase 1 Slice 5: Receiving Route Ownership Split

Scope:

- Added `server/modules/procurement/receiving.routes.ts` as the receiving route
  owner while preserving the existing receiving URLs and handler behavior.
- Moved receiving order, receiving line, complete-all, close, open, create
  variant, bulk import, and draft discard route registrations out of the main
  procurement route monolith.
- Left `registerPurchasingRoutes(app)` as the public procurement route entry
  point and mounted the receiving registrar from there, so callers and app
  startup do not change.
- Kept the existing duplicated `DELETE /api/receiving/:id` registration order
  intact during the move rather than changing delete semantics inside a route
  ownership slice.
- Added a focused receiving route smoke test for list/vendor enrichment and
  close orchestration, including notification and post-receiving replenishment
  checks.

Verification:

- Passed: `npx vitest run server/modules/procurement/__tests__/unit/receiving.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/receipt-discard.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Remaining risk:

- The broader procurement route file is still too large. This slice moves the
  receiving surface first because receiving service boundaries are now in
  place. PO, shipment tracking, AP, exceptions, and notification routes still
  need their own ownership passes.

Next step:

- Open the receiving route split PR.
- After merge, continue route/API ownership with purchase-order route grouping
  or operator-visible receiving reconciliation retry/status, depending on which
  UI workflow needs the next hardening pass.

### 2026-05-16 - Phase 1 Slice 6: Purchase Order Route Ownership Split

Scope:

- Added `server/modules/procurement/purchase-order.routes.ts` as the core PO
  route owner while preserving existing purchase-order, PO exception,
  procurement settings, PO document, PO email, PO receipt, and PO payment URLs.
- Left `registerPurchasingRoutes(app)` as the public procurement route entry
  point and mounted the PO registrar from the same location in the route order.
- Moved the route-level dependencies for PO exception counts, document
  rendering, email sending, AP payment lookup, idempotent create/send actions,
  and related-user enrichment out of the procurement route monolith with the
  handlers that use them.
- Kept shipment-owned PO views (`/api/purchase-orders/:id/shipments`) and
  invoice-owned PO views (`/api/purchase-orders/:id/invoices`) in the main file
  for now because those belong with inbound shipment and AP route ownership
  passes.

Verification:

- Passed: `npx vitest run server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-close.service.test.ts server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Remaining risk:

- The PO route file is now an owner, but it is still broad: CRUD, line edits,
  lifecycle transitions, exception actions, documents, email, receipts, and PO
  settings live together. That is acceptable for this ownership split, but the
  next hardening pass should separate high-risk commands from read/document
  endpoints once the remaining monolith route groups are extracted.

Next step:

- Open the purchase-order route split PR.
- After merge, continue route/API ownership with vendor catalog and approval
  settings, then inbound shipment and AP route groups.

### 2026-05-16 - Phase 1 Slice 7: Vendor Catalog and Purchasing Admin Route Split

Scope:

- Added `server/modules/procurement/purchasing-admin.routes.ts` as the owner for
  supplier catalog and purchasing admin routes adjacent to purchase orders.
- Moved vendor product CRUD, vendor catalog bulk upsert, vendor catalog search,
  approval tier CRUD, and reorder-to-PO creation out of the procurement route
  monolith while preserving existing URLs and route behavior.
- Kept `registerPurchasingRoutes(app)` as the public procurement route entry
  point and mounted the admin registrar immediately after purchase-order routes
  to preserve route order.
- Left purchasing dashboard, reorder analysis, auto-draft settings, inbound
  shipment, landed cost, and AP routes in the remaining route file for later
  ownership slices.
- Added focused route coverage for vendor product filters, bulk vendor catalog
  normalization, and approval tier reads.

Verification:

- Passed: `npx vitest run server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving.routes.test.ts server/modules/procurement/__tests__/unit/bulk-upsert-catalog.service.test.ts server/modules/procurement/__tests__/unit/catalog-search.storage.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Remaining risk:

- The purchasing admin route owner is intentionally pragmatic: supplier catalog,
  approval tiers, and reorder-to-PO creation are grouped because they are all
  small PO-adjacent admin endpoints. Future hardening can split supplier
  catalog from approval settings if either surface grows materially.

Next step:

- Open the vendor catalog / purchasing admin route split PR.
- After merge, continue route/API ownership with inbound shipment and landed
  cost routes, then AP invoice/payment routes.

### 2026-05-16 - Phase 1 Slice 8: Inbound Shipment and Landed Cost Route Split

Scope:

- Added `server/modules/procurement/inbound-shipment.routes.ts` as the owner
  for inbound shipment tracking, shipment line import/dimension routes,
  landed-cost rows, shipment-cost AP bridge routes, allocation/finalization,
  and PO-to-shipment cross references.
- Preserved the existing inbound shipment, shipment cost, allocation, and
  `/api/purchase-orders/:id/shipments` URLs while mounting the new registrar
  from `registerPurchasingRoutes(app)` at the same point in route order.
- Removed shipment-tracking route dependencies from the main procurement route
  file so the remaining monolith no longer owns shipment lifecycle endpoint
  wiring.
- Kept shipment-cost AP bridge endpoints with inbound shipments for now because
  operators reach those actions from the shipment landed-cost workflow.
- Added focused route coverage for shipment list filter parsing, delivered
  notification emission, PO-line import request parsing, and cost enrichment
  delegation.

Verification:

- Passed: `npx vitest run server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/add-lines-from-po.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts`
- Passed: `npx tsc --noEmit --pretty false`

Remaining risk:

- The new route owner is still a broad shipment/lifecycle/cost owner. That is
  intentional for this extraction slice; future hardening should split AP
  invoice/payment ownership and then tighten shipment command/read boundaries
  once all large route groups have first-class owners.

Next step:

- Open the inbound shipment route split PR.
- After merge, continue route/API ownership with AP invoice/payment routes,
  then decide whether the remaining reports/notifications surface should stay
  in the public procurement route registrar or move into narrower owners.

### 2026-05-16 - Phase 1 Slice 9: AP Invoice and Payment Route Split

Scope:

- Added `server/modules/procurement/ap-ledger.routes.ts` as the owner for AP
  vendor invoice, invoice line, invoice attachment, AP payment, PO invoice
  cross-reference, and AP summary endpoints.
- Preserved existing AP URLs and mounted the AP registrar immediately after
  inbound shipment routes, keeping the prior shipment-to-AP route order.
- Removed AP service, route-level idempotency, and attachment upload
  dependencies from the main procurement route registrar.
- Kept shipment-cost AP bridge endpoints with inbound shipments because those
  actions are part of the landed-cost workflow; this AP owner covers direct
  invoice/payment ledger workflows.
- Added focused route coverage for invoice filter parsing, invoice creation
  date/user normalization, PO invoice reads, AP payment posting, and AP summary
  delegation.

Verification:

- Passed: `npx vitest run server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Remaining risk:

- The AP route owner still groups invoice, payment, attachment, PO invoice
  lookup, and summary routes. That is acceptable while the route monolith is
  being dismantled; future hardening should split command endpoints from read
  endpoints and attach explicit retry/audit semantics around invoice/payment
  writes.

Next step:

- Open the AP route split PR.
- After merge, finish route/API ownership by deciding whether procurement
  reports, notifications, replenishment admin, and auto-draft settings remain
  in the public procurement registrar or move into smaller route owners.

### 2026-05-17 - Phase 1 Slice 10: Reports and Notifications Route Split

Scope:

- Added `server/modules/procurement/procurement-report.routes.ts` as the owner
  for financial/procurement report endpoints under `/api/reports/*`.
- Added `server/modules/notifications/notifications.routes.ts` as the owner
  for core user notification, notification preference, unread-count, and
  notification-type endpoints.
- Preserved the existing public URLs and mount order by registering the new
  report owner before inbound shipment/AP routes and the notification owner
  before the remaining purchasing dashboard routes.
- Removed report and notification handler blocks from
  `server/modules/procurement/procurement.routes.ts`, reducing the remaining
  registrar by another broad read/notification surface without changing
  purchasing behavior.
- Added focused route coverage for report pagination/totals/service delegation
  and notification user scoping, read mutation, and preference validation.

Verification:

- Passed: `npx vitest run server/modules/procurement/__tests__/unit/procurement-report.routes.test.ts server/modules/notifications/__tests__/unit/notifications.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/procurement-report.routes.test.ts server/modules/notifications/__tests__/unit/notifications.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts`

Remaining risk:

- The procurement report route owner still depends on legacy reporting methods
  in `procurementStorage`. That is acceptable for this ownership slice because
  the routes are read-only; deeper financial-report hardening should validate
  source-of-truth boundaries, costing semantics, and export/report permissions.
- Core notifications are now owned by the notifications module, but still mount
  from the procurement registrar for order preservation during the monolith
  split. A later route bootstrap cleanup can register this owner directly from
  `server/routes.ts`.

Next step:

- Finish Phase 1 route/API ownership with replenishment admin/task routes and
  the purchasing recommendation/auto-draft surface. Those are the last large
  handler groups still sitting inside the remaining procurement route registrar.

### 2026-05-17 - Phase 1 Slice 11: Replenishment Route Owner Split

Scope:

- Added `server/modules/inventory/replenishment.routes.ts` as the route owner
  for replenishment tier defaults, SKU rules, location replen configs, CSV
  upload/template endpoints, and replenishment task CRUD/execute/exception
  actions under the existing `/api/replen/*` URLs.
- Preserved existing replenishment behavior by mechanically moving the route
  block out of `server/modules/procurement/procurement.routes.ts` and mounting
  it from `registerPurchasingRoutes(app)` at the same point after receiving
  routes.
- Exported `registerReplenishmentRoutes` from the inventory module so route
  ownership matches table/service ownership: replen rules, tier defaults,
  location replen configs, replen tasks, and replenishment use cases already
  belong to inventory.
- Added focused route coverage for enriched replen rule reads, manual task
  creation through the unified auto-execute decision path, and the guard that
  prevents marking tasks completed without using the execute path that moves
  inventory.

Verification:

- Passed: `npx vitest run server/modules/inventory/__tests__/unit/replenishment.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/inventory/__tests__/unit/replenishment.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/procurement-report.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`

Remaining risk:

- This slice intentionally does not redesign replenishment behavior. The new
  owner still contains legacy CSV parsing and admin/task handlers in one route
  file. Later replen hardening can split config/admin routes from task command
  routes if either surface grows.
- `registerPurchasingRoutes(app)` still mounts the inventory replenishment
  route owner for URL/order preservation while Phase 1 dismantles the old
  procurement route monolith. A later bootstrap cleanup can register the owner
  directly from `server/routes.ts`.

Next step:

- Finish Phase 1 by extracting the purchasing recommendation/auto-draft
  surface from the remaining procurement route registrar. That is the last
  large procurement-specific handler group before deeper purchasing-engine
  hardening begins.

### 2026-05-17 - Phase 1 Slice 12: Purchasing Recommendation Route Split

Scope:

- Added `server/modules/procurement/purchasing-recommendation.routes.ts` as the
  owner for purchasing KPI, reorder-analysis, velocity lookback, dashboard,
  exclusion-rule, product reorder-exclusion, auto-draft run/status, and
  auto-draft settings endpoints.
- Preserved existing public URLs and route order by exposing two registrars:
  one for the KPI/reorder-analysis routes that already mounted before internal
  sync endpoints, and one for dashboard/exclusion/auto-draft admin routes that
  already mounted after notifications.
- Removed the last large purchasing recommendation/auto-draft handler group
  from `server/modules/procurement/procurement.routes.ts` without changing the
  legacy recommendation math, exclusion semantics, or auto-draft job dispatch.
- Added focused route coverage for KPI aggregation, reorder-analysis response
  shaping, and admin-triggered auto-draft dispatch.

Verification:

- Passed: `npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/procurement-report.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/inventory/__tests__/unit/replenishment.routes.test.ts`

Remaining risk:

- This slice intentionally preserves the current recommendation calculations,
  dynamic exclusion filtering, and auto-draft job trigger. Forecasting accuracy,
  supplier lead-time quality, demand signals, and recommendation explainability
  remain deeper purchasing-engine hardening work after route ownership is
  complete.
- The remaining procurement registrar still directly owns vendor CRUD, SLA/ops
  dashboard reads, and internal Archon sync endpoints. Those are smaller route
  groups; the next decision is whether to carve those into owners or move into
  service/command hardening for purchasing recommendations.

Next step:

- Review the now-small remaining `procurement.routes.ts` surface and decide
  whether to complete a final route-owner cleanup for vendor/SLA/ops/internal
  sync endpoints or begin the deeper purchasing recommendation engine hardening
  work.

### 2026-05-17 - Phase 2 Slice 1: Send Path Lifecycle Sync

Scope:

- Began PO lifecycle backbone hardening by tightening the highest-traffic send
  path used by inline PO creation and `/api/purchase-orders/:id/send-pdf`.
- Updated `sendPurchaseOrder` so the final send step uses
  `buildPhysicalTransitionChange` instead of directly setting only the legacy
  `status` column inside the transaction.
- Preserved the existing draft-to-approved-to-sent transactional behavior,
  approval-tier pending path, PO status history rows, and `sent_to_vendor`
  event emission.
- Ensured the send transaction now writes `physicalStatus: "sent"` alongside
  legacy `status: "sent"`, `sentToVendorAt`, and `orderDate`, preventing
  dual-track drift for new sent POs.
- Added focused service coverage for the lifecycle-backed send path and
  refreshed stale validation fixtures that omitted required `productId`.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/po-create-send.service.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/po-create-send.service.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-close.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Remaining risk:

- Submit, return-to-draft, approve, cancel, close, and close-short still need a
  fuller command-level lifecycle pass. This slice fixes the send drift first
  because it is the active PO creation/send path and the cleanest entry point
  into Phase 2.

Next step:

- Continue Phase 2 by centralizing the remaining PO lifecycle action handlers
  behind explicit command helpers and expanding invalid-transition/audit tests.

### 2026-05-17 - Phase 2 Slice 2: Lifecycle Action Audit Events

Scope:

- Continued PO lifecycle backbone hardening by making operator lifecycle
  actions write the immutable `po_events` stream consistently.
- Fixed the pending-approval submit branch to use
  `updatePurchaseOrderStatusWithHistory` instead of the plain PO update helper,
  so submitting into `pending_approval` now writes status history.
- Added lifecycle event emission for submit, auto-approve, approve,
  return-to-draft, solo-mode auto-approve, close, close-short, and generic
  physical transitions such as sent, acknowledged, shipped, in-transit,
  arrived, received, and cancelled.
- Kept the existing route URLs and operator behavior unchanged; this slice
  adds auditability and removes one direct status-history bypass.
- Updated the `po_events` schema comment so the documented event vocabulary
  matches the events emitted by the service.
- Added focused service coverage for pending-approval submit history/events,
  approval events, physical transition events, and close-short events.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/po-lifecycle-actions.service.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/po-lifecycle-actions.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.service.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-close.service.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts`

Remaining risk:

- Lifecycle event emission for most storage-backed actions is still a second
  write after `updatePurchaseOrderStatusWithHistory`; the send path remains the
  strongest pattern because it writes status, history, and event in one
  transaction. A later lifecycle command-service pass should move all actions
  to one command boundary.

Next step:

- Continue Phase 2 with explicit next-action derivation and command boundaries,
  then start replacing route/UI assumptions with the lifecycle service's valid
  action list.
