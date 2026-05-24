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

Current phase: Phase 8 - Purchasing Recommendation Engine Foundation

Current objective:

- Unify reorder analysis, purchasing KPIs, and auto-draft eligibility behind one
  explainable recommendation engine.
- Keep PO creation downstream of recommendation generation so autopilot can run
  in review-only or draft-producing modes.
- Make every recommendation and skip decision visible enough for the later
  demand forecast engine to plug into this boundary.

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

### 2026-05-17 - Phase 2 Slice 3: Lifecycle-Derived Next Actions

Scope:

- Added a central PO lifecycle summary builder that derives resolved physical
  status, allowed legacy/physical/financial transitions, terminal state, and
  operator next actions from the same lifecycle tables used by command
  validation.
- Exposed that lifecycle summary on both PO list and PO detail API responses so
  admin UI callers can stop re-implementing status-machine logic in component
  conditionals.
- Included route metadata, target statuses, destructive/dialog flags, and
  required permission metadata for lifecycle actions such as submit, approve,
  send, acknowledge, mark shipped/in-transit/arrived, create receipt, cancel,
  close, and close-short.
- Migrated the PO detail header actions and quick-action rail to use the
  backend-derived next-action list with legacy client-side fallbacks for older
  deployments.
- Preserved the existing solo-mode approval setting and vendor-acknowledgment
  setting as UI-level display choices while moving status eligibility to the
  lifecycle service.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-lifecycle-actions.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-close.service.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/po-phase2-api.test.ts`
- Passed: `npx tsc --noEmit --pretty false`

Remaining risk:

- The action contract now identifies valid status actions, but the route
  handlers still call individual service methods instead of a single command
  dispatcher. That command boundary remains the next hardening step.
- Financial actions are represented only as allowed transitions for now. Add
  invoice/payment next-action derivation once AP command boundaries are moved
  behind the same lifecycle contract.

Next step:

- Continue Phase 2 by introducing an explicit PO lifecycle command dispatcher
  so routes, audit events, and next-action derivation share one command
  vocabulary end to end.

### 2026-05-17 - Phase 2 Slice 4: PO Lifecycle Command Dispatcher

Scope:

- Added `PoLifecycleCommand` as the shared command vocabulary behind the
  previously exposed next-action IDs.
- Added `purchasing.executeLifecycleCommand(...)` to dispatch submit,
  return-to-draft, approve, send, send-to-vendor, acknowledge, physical movement
  commands, create receipt, cancel, close, and close-short through one service
  boundary.
- Kept the existing implementation methods intact for now, but moved HTTP
  status/action routes to call the command dispatcher instead of directly
  choosing individual service methods.
- Preserved current route URLs, permissions, request payloads, response status
  behavior for create receipt, and existing audited transition/event behavior.
- Added service tests for command-dispatched physical movement, acknowledgment
  payload handling, and unknown command rejection.
- Updated route tests to verify physical movement endpoints dispatch command
  IDs and payloads through the shared command boundary.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/po-lifecycle-actions.service.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-lifecycle-actions.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-close.service.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/po-phase2-api.test.ts`
- Passed: `npx tsc --noEmit --pretty false`

Remaining risk:

- The dispatcher is now the route boundary, but some commands still perform
  status/history writes and event writes as separate service operations. The
  next hardening step is to move high-risk commands into transactional command
  handlers where the audit event, status history, and PO patch commit together.
- AP invoice/payment actions are still outside the PO lifecycle command
  vocabulary; they should get their own command boundary before demand
  forecasting starts depending on financial state.

Next step:

- Continue Phase 2 by making the most consequential lifecycle commands
  transactional end to end, starting with cancel/void and close/close-short
  because they alter line state as well as PO state.

### 2026-05-17 - Phase 2 Slice 5: Transactional Lifecycle Commands

Scope:

- Moved `cancel`, `close`, and `closeShort` onto caller-owned DB transactions
  for their consequential writes.
- `cancel` now commits open-line cancellation patches, PO physical cancellation,
  `po_status_history`, and the `cancelled` event together.
- `close` now commits the close patch, status history, and `closed` event
  together after the existing three-way-match gate passes.
- `closeShort` now commits remaining line close-short patches, the
  short-closed PO patch, status history, and `closed_short` event together.
- Preserved existing public route behavior, lifecycle validation, close-match
  blocking, and post-cancel best-effort past-due exception detection.
- Added focused coverage proving these command paths no longer split line
  writes, status/history writes, and audit-event writes across separate storage
  calls.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/po-lifecycle-actions.service.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-lifecycle-actions.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-close.service.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/po-phase2-api.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Remaining risk:

- Generic movement commands (`mark_shipped`, `mark_in_transit`, `mark_arrived`,
  and `acknowledge`) still use the storage helper followed by a separate event
  write. Those are lower risk than cancel/close because they do not also patch
  PO lines, but they should eventually move behind the same transaction helper.
- AP invoice/payment actions remain outside the PO lifecycle command boundary.

Next step:

- Continue Phase 2 by either transactionalizing the remaining movement commands
  or starting the AP command-boundary pass, depending on whether we want to
  finish physical lifecycle atomicity before moving into financial lifecycle.

### 2026-05-17 - Phase 2 Slice 6: Physical Lifecycle Atomicity

Scope:

- Moved `transitionPhysical` onto the shared transaction helper so physical PO
  movement writes the PO patch, `po_status_history`, and mapped `po_events`
  row atomically.
- This makes `send`, `acknowledge`, `mark_shipped`, `mark_in_transit`,
  `mark_arrived`, and any direct physical transition caller inherit the same
  transactional audit behavior.
- Folded submit, auto-approve, return-to-draft, approve, and solo-mode
  auto-approve status/event writes into the same transaction helper as well.
- Preserved public routes, command IDs, lifecycle validation, and the
  non-blocking post-transition exception detection hooks.
- Scanned the procurement module for remaining PO lifecycle status-history
  writes. Remaining status writes are either financial/AP state
  (`transitionFinancial`) or receipt reconciliation, which belongs to the AP
  and receiving phases rather than the Phase 2 physical lifecycle closeout.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/dual-track.service.test.ts server/modules/procurement/__tests__/unit/po-lifecycle-actions.service.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts server/modules/procurement/__tests__/unit/po-lifecycle-actions.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-close.service.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/po-phase2-api.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Phase 2 closeout:

- PO lifecycle routes now dispatch through `executeLifecycleCommand`.
- UI next actions are derived by the lifecycle service instead of local status
  branching.
- Physical lifecycle commands write PO state, status history, and audit events
  through one transaction path.
- Financial/AP state and receipt reconciliation are intentionally deferred to
  Phase 7 and Phase 3 respectively.

Next step:

- Move to Phase 3: receiving orchestration, starting with receipt close and PO
  reconciliation drift prevention.

### 2026-05-17 - Phase 3 Slice 1: Receiving Close Reconciliation Boundary

Scope:

- Promoted PO receipt reconciliation from a fire-and-forget-style follow-up into
  a structured receiving orchestration result.
- `reconcilePurchaseOrderReceipt` now reports applied rows, idempotent existing
  receipt rows, unresolved skipped rows, auto-match count, and explicit issue
  details.
- `ReceivingService.close` now returns the PO reconciliation outcome as part of
  the close response.
- PO-linked receiving close now rejects incomplete reconciliation with a 409
  orchestration error instead of allowing unmatched or ambiguous receiving lines
  to disappear into logs.
- Idempotent close retries remain safe: an existing `po_receipts` row counts as
  reconciled and does not re-post inventory or fail the close.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/receiving.routes.test.ts server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Remaining risk:

- Inventory posting and PO reconciliation are still not one shared database
  transaction. This slice makes reconciliation failure visible and retry-safe,
  but the next Phase 3 slice should move toward an explicit recovery record or
  deeper transaction boundary for the inventory/PO close pair.
- Receipt close route idempotency uses the existing HTTP idempotency middleware;
  create-receipt idempotency already reuses an active existing draft/open
  receipt, but needs race-condition coverage around simultaneous create calls.

Next step:

- Continue Phase 3 by adding stronger idempotency/concurrency protection around
  create receipt and close receipt, then add recovery/exception records for any
  reconciliation failure that occurs after inventory posting.

### 2026-05-18 - Phase 3 Slice 2: Receiving Idempotency and Recovery Visibility

Scope:

- Serialized `createReceiptFromPO` with a PO-scoped advisory transaction lock so
  simultaneous create-receipt calls for the same PO run through one
  create-or-reuse decision at a time.
- Kept active receipt reuse as the first behavior, and added a second active
  receipt lookup after a unique create conflict so concurrent callers can safely
  reuse the receipt created by the winner instead of failing.
- Added `receipt_reconciliation_failed` as a PO exception kind, with a migration
  that extends the existing `po_exceptions` kind check constraint.
- Wired receiving close reconciliation failures into the PO exception system:
  missing reconciliation service, no reconciliation result, incomplete
  reconciliation, and thrown reconciliation errors now record a visible PO
  exception before the close returns a 409 orchestration error.
- Preserved inventory-posting behavior and idempotent closed-receipt retry
  semantics from Slice 1.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/po-exceptions.service.test.ts server/modules/procurement/__tests__/unit/receiving.routes.test.ts server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Remaining risk:

- Inventory posting and PO reconciliation still do not share one database
  transaction. This slice makes the failure explicit, idempotent, and visible
  for recovery; a deeper transaction boundary can be considered after the rest
  of receiving orchestration is stabilized.

Next step:

- Continue Phase 3 by hardening receiving variance and landed-cost touchpoints
  that feed PO/AP accuracy, then move into the demand and purchasing
  recommendation engine once the purchasing system is operationally reliable.

### 2026-05-18 - Phase 3 Slice 3: Receiving PO State and Variance Controls

Scope:

- Kept PO dual-track physical status aligned when receipt reconciliation updates
  the legacy PO receiving status.
- Partial receipt reconciliation now writes both `status = partially_received`
  and `physicalStatus = receiving`.
- Full receipt reconciliation now writes both `status = received` and
  `physicalStatus = received`, preserving the existing receipt audit history.
- Reused the existing `detectQtyVariance` exception detector after reconciliation
  moves a PO to fully received, so over-receipts become visible through the
  established `qty_over`/`qty_short` PO exception path instead of a second
  receiving-only variance mechanism.
- Extended reconciliation results with the PO status update that was applied, so
  callers and tests can distinguish no-op retries from actual PO state movement.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/dual-track.service.test.ts server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/receiving.routes.test.ts server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts server/modules/procurement/__tests__/unit/po-exceptions.service.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check`

Next step:

- Continue Phase 3 by tightening receiving close blockers and cost provenance
  around provisional landed costs, then move into the dedicated inbound shipment
  and landed cost phase once receiving state is fully stable.

### 2026-05-18 - Phase 3 Slice 4: Receiving Cost Provenance Guards

Scope:

- Preserved inbound shipment linkage on inventory receipt lots even when landed
  costs have already been finalized, so finalized shipment receipts remain
  traceable back to the inbound shipment.
- Marked shipment-linked receipts as provisional when landed cost is missing or
  lookup fails, keeping PO/receiving-line cost as the temporary value without
  presenting it as final landed cost.
- Kept domestic typed-line allocation behavior unchanged for receipts that are
  not tied to inbound shipments.
- Added focused receiving close coverage for finalized landed cost, pending
  landed cost, and landed-cost lookup failure provenance.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/receiving.routes.test.ts server/modules/procurement/__tests__/unit/receiving-orchestration.service.test.ts server/modules/procurement/__tests__/unit/receiving-semantics.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/dual-track.service.test.ts server/modules/procurement/__tests__/unit/po-exceptions.service.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check` with Windows line-ending warnings only.

Next step:

- Run the receiving cost provenance tests and typecheck, then continue into the
  dedicated inbound shipment and landed cost phase once this receiving guard is
  merged.

### 2026-05-18 - Phase 6 Slice 1: Landed Cost Push Provenance Guards

Scope:

- Started the inbound shipment and landed cost phase after receiving close
  provenance was stabilized.
- Changed landed-cost push-to-lots to use finalized landed cost snapshots as the
  source of truth instead of mutable inbound shipment line cost fields.
- Kept push-to-lots idempotent for already-finalized lots, and added explicit
  skipped reasons when provisional lots cannot be safely updated.
- Prevented same-variant shipment lines with different finalized landed costs
  from being pushed by variant-only matching, because the current inventory lot
  schema does not retain purchase order line identity.
- Blocked landed-cost push for cancelled shipments.
- Added unit coverage for finalized snapshot push, missing finalized snapshot,
  and ambiguous same-variant cost cases.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check` with Windows line-ending warnings only.

Next step:

- Run landed-cost push tests and typecheck, then continue Phase 6 with
  allocation/finalization idempotency and operator visibility around skipped
  landed-cost pushes.

### 2026-05-18 - Phase 6 Slice 2: Landed Cost Finalization Idempotency

Scope:

- Restricted landed-cost finalization to shipments in `costing` or `closed`
  status, matching the operator lifecycle and preventing premature snapshot
  finalization.
- Made repeated landed-cost finalization idempotent when the recomputed
  snapshots match the existing finalized snapshots, avoiding delete/recreate
  churn and timestamp drift.
- Preserved closed-shipment late-cost behavior: changed closed costs still
  create landed cost adjustments and refresh snapshots.
- Added focused service coverage for invalid status, no-op retry, and changed
  closed-cost adjustment behavior.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check` with Windows line-ending warnings only.

Next step:

- Continue Phase 6 with operator visibility for skipped landed-cost pushes and
  then tighten allocation explainability/status reporting in the inbound
  shipment UI/API.

### 2026-05-18 - Phase 6 Slice 3: Landed Cost Push Operator Visibility

Scope:

- Added an operator-facing push-to-lots action in the inbound shipment
  allocation tab for shipments in `costing` or `closed` status.
- Surfaced the push result inline, including updated/skipped counts, total
  provisional lots checked, and per-lot skipped reasons.
- Preserved the backend landed-cost push result contract and added route
  coverage for skipped reasons.
- Kept the push endpoint as the source of truth for whether lots were updated
  or skipped.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`
- Passed: `npx tsc --noEmit --pretty false`
- Passed: `git diff --check` with Windows line-ending warnings only.

Next step:

- Continue Phase 6 by tightening allocation explainability/status reporting in
  the inbound shipment UI/API, then move toward landed-cost health monitoring.

### 2026-05-18 - Phase 6 Slice 4: Inbound Allocation Explainability

Scope:

- Added a read-only allocation status endpoint for inbound shipments that
  reports overall allocation health, effective vs allocated cost, blockers,
  warnings, and per-cost allocation state.
- Reused the same allocation method and basis-resolution helpers for both
  allocation execution and status reporting, keeping operator visibility aligned
  with the actual allocation engine.
- Flagged unallocated costs, stale line allocations, allocation total
  mismatches, and even-split basis fallbacks as explicit operator-visible
  signals.
- Wired the inbound shipment allocation tab to the status endpoint and surfaced
  status, cost totals, issue messages, method source, basis total, and per-cost
  allocation state.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`
- Passed: `npx tsc --noEmit --pretty false`

Next step:

- Continue Phase 6 with landed-cost health monitoring so stale provisional lots,
  finalized-but-not-pushed shipments, and allocation warning states are visible
  outside a single shipment detail page.

### 2026-05-18 - Phase 6 Slice 5: Landed Cost Health Monitoring

Scope:

- Added a procurement landed-cost health endpoint that scans costing/closed
  inbound shipments and reports allocation blockers, allocation warnings,
  missing finalized landed-cost snapshots, finalized costs that still need to
  push to provisional lots, and stale provisional lots left after shipment
  close.
- Reused the allocation status read model from Slice 4 so shipment-list health
  and shipment-detail allocation explainability stay aligned.
- Surfaced landed-cost health on the Inbound Shipments page with critical and
  warning counts, issue category totals, and issue rows that link directly to
  the affected shipment detail.
- Added unit coverage for stale provisional lots, finalized-not-pushed
  shipments, and the health route contract.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`
- Passed: `npx tsc --noEmit --pretty false`

Next step:

- Continue Phase 6 by deciding whether landed-cost health should remain
  read-only or gain targeted one-click recovery actions for safe cases such as
  finalized costs ready to push to lots.

### 2026-05-18 - Phase 6 Slice 6: Landed Cost Health Safe Recovery Action

Scope:

- Added a one-click recovery action to the Inbound Shipments landed-cost health
  panel for health items whose action is `push_costs_to_lots`.
- Reused the existing `POST /api/inbound-shipments/:id/push-costs-to-lots`
  endpoint so lot updates and skipped-reason handling remain owned by the
  landed-cost push service.
- Refreshed landed-cost health and inbound shipment list data after a recovery
  push, and surfaced the updated/skipped outcome in the operator toast.
- Kept non-safe health items as review-only links into shipment detail.

Verification:

- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`
- Passed: `npx tsc --noEmit --pretty false`

Next step:

- Continue Phase 6 by reviewing whether remaining landed-cost health issue
  types need additional guardrail copy, admin filters, or escalation into the
  procurement dashboard.

### 2026-05-18 - Phase 6 Slice 7: Procurement Dashboard Landed Cost Escalation

Scope:

- Surfaced landed-cost health on the Purchasing Dashboard when the shared
  health read model reports a warning or critical state.
- Reused `/api/procurement/landed-cost-health` so dashboard escalation,
  inbound shipment health, and shipment detail review stay aligned.
- Added compact command-center counts for allocation blockers, allocation
  warnings, pending finalization, finalized costs ready to push, and stale
  provisional lots.
- Linked each surfaced health item to the affected inbound shipment detail and
  kept safe recovery actions owned by the Inbound Shipments health panel.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`

Next step:

- Continue Phase 6 by deciding whether shipment list filters are enough for
  landed-cost follow-up, then move to the next procurement/WMS hardening area if
  no additional guardrails are needed.

### 2026-05-18 - Phase 6 Slice 8: Landed Cost Follow-Up Filters

Scope:

- Added landed-cost follow-up filters to the Inbound Shipments list so
  operators can narrow shipments by any issue, severity, allocation issue,
  pending finalization, ready-to-push landed costs, or stale provisional lots.
- Reused the existing landed-cost health read model for filter counts and
  shipment issue badges, keeping the table aligned with the health panel and
  procurement dashboard escalation.
- Increased the health query limit on the inbound shipment list to match the
  shipment list page size used for follow-up.
- Added landed-cost issue badges to mobile cards and the desktop table so
  affected shipments remain visible after filtering or searching.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase1.test.ts server/modules/procurement/__tests__/unit/shipment-invoices-phase2.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts`

Next step:

- Phase 6 now has provenance guards, idempotent finalization, operator push
  visibility, allocation explainability, health monitoring, safe recovery,
  dashboard escalation, and list follow-up filters. Move to the next
  procurement/WMS hardening area unless live testing exposes another
  landed-cost operational gap.

### 2026-05-18 - Phase 7 Slice 1: AP Ledger Command Boundary

Scope:

- Started Phase 7 after landed-cost Phase 6 by introducing a shared AP ledger
  command vocabulary for invoice approval, invoice dispute, invoice void,
  payment record, and payment void.
- Added `executeApLedgerCommand(...)` as the service entry point for AP
  lifecycle mutations while preserving the existing underlying invoice and
  payment behavior.
- Routed the existing AP invoice/payment mutation URLs through the command
  boundary without changing public URLs, permissions, or current idempotency
  requirements.
- Centralized command-level required-id and required-reason validation through
  `ApLedgerError`, keeping route error handling consistent for command calls.
- Expanded AP route coverage to assert invoice and payment mutations dispatch
  through the shared command boundary.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts`

Next step:

- Continue Phase 7 by making AP command side effects more atomic and
  operator-visible, starting with invoice status transitions and payment voids
  because they alter invoice balances and PO financial aggregates.

### 2026-05-18 - Phase 7 Slice 2: AP Ledger Atomic Side Effects

Scope:

- Made AP ledger side-effect helpers transaction-aware so invoice balance
  recalculation and PO financial aggregate recomputation can run on the same
  client as the mutation that triggered them.
- Wrapped invoice approval, invoice dispute, invoice void, payment recording,
  and payment voiding in transactions so status, allocation, invoice balance,
  and PO aggregate writes commit or roll back together.
- Deferred PO exception detection hooks until after transaction commit, keeping
  aggregate writes atomic while preserving overpaid and past-due monitoring.
- Added focused AP service coverage proving payment record and payment void
  side effects flow through one transaction before detection hooks run.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 7 by making AP ledger outcomes more operator-visible, starting
  with command responses and admin surfaces that should show which invoices,
  payments, and linked POs were affected by a mutation.

### 2026-05-18 - Phase 7 Slice 3: AP Ledger Command Outcomes

Scope:

- Added `apLedgerOutcome` metadata to AP command responses, including command,
  entity type/id, affected invoice ids, affected payment ids, affected linked
  PO ids, and a concise operator message.
- Kept existing response compatibility by attaching outcome metadata to the
  normal invoice/payment JSON rather than replacing route payloads with a new
  envelope.
- Returned the command outcome from payment void routes instead of a bare
  `{ ok: true }` response.
- Surfaced affected linked POs in AP invoice detail, AP payments, and PO detail
  success toasts after invoice/payment mutations.
- Expanded AP service and route tests to prove command outcome metadata is
  produced and passed through to clients.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 7 by adding AP command history/audit visibility for recent
  mutations so operators can review what changed after the toast disappears.

### 2026-05-18 - Phase 7 Slice 4: AP Ledger Command Audit History

Scope:

- Added durable AP command audit entries for invoice approval, invoice dispute,
  invoice void, payment record, and payment void outcomes.
- Reused the shared `audit_events` table instead of creating AP-only history,
  keeping AP command visibility aligned with the existing application audit
  model.
- Added `GET /api/ap/command-events` so operators can retrieve recent AP
  command history without depending on transient success toasts.
- Added a Recent AP Activity panel to AP Payments showing when the command ran,
  which command ran, who ran it, the operator message, and affected linked POs.
- Expanded AP service and route tests to prove command outcomes write audit
  rows and that the new read endpoint returns recent command events.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`

Next step:

- Finish validating this slice with the broader procurement/AP regression set,
  then continue Phase 7 by deciding whether AP command idempotency/retry
  protection needs its own slice before moving from AP hardening into the next
  procurement engine area.

### 2026-05-18 - Phase 7 Slice 5: AP Invoice Command Idempotency

Scope:

- Required idempotency keys for AP invoice approval, invoice dispute, and
  invoice void routes so all AP command-bound financial mutations now share
  retry protection at the HTTP boundary.
- Kept the existing AP payment create and payment void idempotency behavior
  unchanged.
- Updated the AP invoice detail UI to send a fresh idempotency key with
  approve, dispute, and void commands.
- Invalidated recent AP command history after invoice and payment commands so
  the Recent AP Activity panel refreshes after command mutations.
- Expanded AP route coverage to assert all five AP command mutations register
  idempotency protection.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts`
- Passed: `git diff --check`

Next step:

- Phase 7 now has a shared AP command boundary, atomic side effects, operator
  command outcomes, command audit history, and idempotency protection for the
  command mutations. Continue by reviewing whether invoice creation/editing
  needs the same command treatment, or move into the next procurement engine
  area if AP lifecycle hardening is sufficient for the forecast/purchasing
  foundation.

### 2026-05-18 - Phase 7 Slice 6: AP Invoice Creation Idempotency

Scope:

- Required idempotency keys for manual vendor invoice creation so browser
  retries cannot create duplicate supplier invoices.
- Required idempotency keys for shipment-cost invoice creation, covering the
  landed-cost to AP bridge.
- Updated all current invoice creation UI entry points to send idempotency
  keys: AP Invoices, PO detail invoice creation, and shipment cost invoice
  creation.
- Left invoice header edits outside this slice because `PATCH
  /api/vendor-invoices/:id` reapplies the same field update rather than
  creating duplicate financial records.
- Expanded AP and inbound shipment route tests to assert idempotency coverage
  on invoice creation paths.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts`
- Passed: `git diff --check`

Next step:

- Finish validating this slice with the broader procurement/AP regression set,
  then either harden AP invoice line/link writes or close Phase 7 and move into
  the next procurement engine area for forecasting and purchasing
  recommendations.

### 2026-05-18 - Phase 7 Slice 7: AP Invoice Line and PO-Link Idempotency

Scope:

- Required idempotency keys for duplicate-prone AP invoice line writes:
  linking a PO to an invoice, importing lines from a PO, and adding a manual
  invoice line.
- Updated AP invoice detail to send idempotency keys for PO-link and manual
  line-add actions.
- Made `importLinesFromPO(...)` skip PO lines that are already present on the
  invoice so repeated link/import calls cannot duplicate PO-backed invoice
  lines even outside the browser retry path.
- Left invoice line edits, line deletes, and invoice matching outside this
  slice because they reapply or remove existing state rather than creating
  duplicate financial rows.
- Expanded AP route and service coverage for idempotency registration and
  repeated PO-line import behavior.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts`
- Passed: `git diff --check`

Next step:

- Finish validating this slice with the broader procurement/AP regression set,
  then close Phase 7 unless another concrete AP lifecycle duplicate or drift
  gap appears.

### 2026-05-18 - Phase 8 Slice 1: Purchasing Recommendation Engine Foundation

Scope:

- Started Phase 8 after closing AP lifecycle hardening by adding a shared
  `generatePurchasingRecommendations(...)` engine for reorder classification,
  recommendation quantities, UOM rounding, vendor visibility, confidence, skip
  reasons, and explanation text.
- Wired purchasing KPIs, reorder analysis, the legacy direct auto-draft endpoint,
  the purchasing dashboard read model, and the scheduled auto-draft job through
  the shared engine instead of duplicating reorder math in each path.
- Enriched the reorder read query with preferred vendor id/name, vendor unit
  cost, and vendor lead time so recommendation output can explain vendor choice
  and use vendor-specific lead time when present.
- Kept PO creation downstream: the engine only emits recommendations and
  actionable/skipped decisions; existing PO creation paths still own draft PO
  mutation.
- Added focused engine and route coverage for explainable order-now output,
  exclusion skips, no-vendor auto-draft blocking, and direct auto-draft item
  selection.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 8 by adding persistent recommendation run/audit detail or
  review-only auto-draft mode, whichever is the next largest blocker to making
  autopilot purchasing explainable.

### 2026-05-18 - Phase 8 Slice 2: Recommendation Run Detail Audit Payload

Scope:

- Added a compact recommendation run detail payload builder for auto-draft and
  recommendation runs.
- Persisted recommendation detail into `auto_draft_runs.summary_json`,
  including lookback, settings, recommendation summary, status counts, skipped
  reason counts, top actionable recommendations, top skipped recommendations,
  and downstream PO mutations.
- Updated the scheduled auto-draft job to store the recommendation detail on
  success and preserve whatever detail was generated on error.
- Updated the legacy direct auto-draft endpoint to create an auto-draft run
  record, persist the same recommendation detail payload, and return the run id
  and detail in the response.
- Exposed `summaryJson` and skipped-on-order counts through the purchasing
  dashboard read model, then surfaced the latest actionable recommendation in
  the dashboard's Nightly Auto-Draft panel.
- Added focused coverage for run-detail payload shape and direct auto-draft
  persistence.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 8 with review-only auto-draft mode so autopilot can generate
  auditable recommendations without mutating POs.

### 2026-05-18 - Phase 8 Slice 3: Review-Only Auto-Draft Mode

Scope:

- Added an explicit `auto_draft_mode` warehouse setting with `draft_po` as the
  default/current behavior and `review_only` as the non-mutating recommendation
  run mode.
- Added schema and migration coverage for the new setting, including a database
  check constraint for the allowed modes.
- Updated the scheduled auto-draft job and legacy direct auto-draft endpoint to
  honor review-only mode by generating and persisting recommendation run detail
  without creating or updating purchase orders.
- Kept review-only runs operationally visible by storing recommendation detail,
  counts, skipped reasons, settings, and empty PO mutations in
  `auto_draft_runs.summary_json`.
- Added the admin settings control in the purchasing exclusion/rules modal and
  surfaced the latest run mode on the purchasing dashboard.
- Preserved partial settings updates so changing one auto-draft setting does not
  reset the other settings.
- Added route coverage for the review-only direct endpoint behavior and mode
  validation.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 8 with recommendation run history/listing or deeper skipped
  reason review so purchasing recommendations can be audited before enabling
  stronger autopilot behavior.

### 2026-05-19 - Phase 8 Slice 4: Recommendation Run History

Scope:

- Added a bounded recent auto-draft/recommendation run read model so operators
  can audit more than the latest run.
- Added `getRecentAutoDraftRuns(...)` storage support with a 50-run cap and a
  normalized `/api/purchasing/auto-draft/runs` endpoint.
- Normalized run history fields for UI use, including run mode, actionable
  count, PO mutation count, top actionable recommendation, top skipped
  recommendation, and error message.
- Updated the purchasing dashboard's Nightly Auto-Draft panel to show the five
  most recent runs and refresh that history after a manual run starts.
- Added route coverage for run-history limit clamping and normalized response
  shape.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 8 by tightening skipped-reason review and recommendation
  explainability before enabling stronger autopilot behavior.

### 2026-05-19 - Phase 8 Slice 5: Skipped-Reason Review Signals

Scope:

- Added structured recommendation review signals to the purchasing
  recommendation engine so actionable and skipped recommendations carry a
  stable operator action, severity, label, and detail.
- Corrected skip-reason ordering so open PO coverage is classified as
  `already_on_order` instead of being buried under generic non-actionable
  status.
- Persisted review signals in recommendation run detail for both actionable and
  skipped recommendation samples.
- Added a Recommendation Review Queue to the reorder analysis page that shows
  blocked recommendations with concrete operator actions such as assign vendor,
  review open PO, or review exclusion.
- Expanded focused engine and run-detail coverage for create-PO, assign-vendor,
  review-exclusion, and review-open-PO signals.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 8 by improving recommendation confidence inputs and demand
  forecast provenance before stronger autopilot behavior is enabled.

### 2026-05-19 - Phase 8 Slice 6: Forecast Provenance and Confidence Factors

Scope:

- Added structured forecast provenance to purchasing recommendations so each
  recommendation records demand window, demand quality, lead-time source,
  safety-stock source, and order-UOM source.
- Added explicit confidence factors explaining why confidence is high, medium,
  or low instead of only returning the summary confidence label.
- Tightened confidence scoring so no recent demand, thin demand history,
  default lead time, and missing preferred vendor lower recommendation
  confidence before stronger autopilot behavior is enabled.
- Persisted forecast provenance and confidence factors in recommendation run
  detail summaries for later audit and run-history inspection.
- Surfaced confidence and forecast basis in the reorder analysis table so
  operators can see whether recommendations are based on stable demand, thin
  demand, and vendor/product/default lead time.
- Expanded focused engine and run-detail coverage for normal and thin-history
  recommendation provenance.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`

Next step:

- Continue Phase 8 by hardening demand forecast input quality and seasonality
  signals before moving purchasing recommendations closer to autopilot.

### 2026-05-19 - Phase 8 Slice 7: Demand Input Quality and Trend Signals

Scope:

- Extended the reorder analysis source query to return prior-period demand,
  order-count sample size, active demand days, and latest demand timestamp.
- Added demand trend classification to the purchasing recommendation engine so
  recommendations can distinguish stable, rising, falling, new, and no-recent
  demand against the prior lookback window.
- Tightened demand quality classification so single-order or single-day demand
  samples are treated as thin history even when total units are non-zero.
- Folded demand sample size and prior-period trend into confidence factors and
  confidence scoring before stronger autopilot behavior is enabled.
- Persisted the expanded demand basis in forecast provenance and surfaced the
  sample/trend summary in reorder analysis.
- Expanded focused engine coverage for stable demand provenance and falling
  demand confidence downgrade.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`

Next step:

- Continue Phase 8 by hardening supplier cost and lead-time quality controls so
  recommendation confidence can account for stale or provisional vendor data.

### 2026-05-19 - Phase 8 Slice 8: Supplier Cost and Lead-Time Quality Signals

Scope:

- Extended reorder analysis supplier inputs with preferred vendor product id,
  mills cost, last purchase cost, last purchased timestamp, and vendor product
  updated timestamp.
- Added supplier cost source and cost quality classification to purchasing
  recommendations so confidence can distinguish current configured cost,
  stale cost, unverified cost age, last-purchase fallback, and missing cost.
- Tightened recommendation confidence so high confidence now requires a
  preferred vendor, vendor-specific lead time, and current configured vendor
  cost before stronger autopilot behavior is enabled.
- Persisted supplier basis in recommendation run detail and surfaced cost
  quality in reorder analysis forecast basis text.
- Expanded focused engine coverage for mills-precision current cost and stale
  last-purchase cost fallback.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`

Next step:

- Continue Phase 8 by adding an operator-facing quality summary or gating
  policy for high-confidence review-only recommendations before enabling any
  broader auto-draft behavior.

### 2026-05-19 - Phase 8 Slice 9: Autopilot Quality Gate Summary

Scope:

- Added a shared recommendation quality gate that marks only high-confidence
  actionable recommendations as auto-draft eligible.
- Updated direct auto-draft to use the shared quality gate for PO mutations
  while keeping medium and low confidence actionable recommendations visible
  for operator review.
- Added summary counts for high, medium, and low confidence recommendations,
  auto-draft eligible recommendations, and actionable recommendations requiring
  review.
- Persisted quality gate detail in recommendation run summaries for audit and
  run-history inspection.
- Surfaced an Autopilot Quality Gate summary on reorder analysis so operators
  can see what can draft automatically versus what needs review.
- Expanded focused engine, route, and run-detail tests for quality gate
  behavior.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 8 by adding explicit approval policy controls for when the
  quality gate can move from review-only recommendation visibility to PO draft
  creation.

### 2026-05-19 - Phase 8 Slice 10: Scheduled Autopilot Approval Policy

Scope:

- Added a shared auto-draft approval policy helper so direct auto-draft and the
  scheduled job use the same high-confidence quality gate.
- Corrected the scheduled auto-draft job so it creates or updates draft POs
  only for recommendations that pass the quality gate, while medium and low
  confidence actionable recommendations remain in the run detail for review.
- Exposed the fixed `high_confidence_only` approval policy through auto-draft
  settings so the active autopilot rule is visible to admin clients.
- Added API validation for unsupported approval policies rather than silently
  accepting future or invalid mutation modes.
- Surfaced eligible/review counts in the purchasing dashboard run summary and
  explained the quality gate policy in the reorder exclusions/settings modal.
- Added focused scheduled-job coverage proving only gate-passing
  recommendations create PO lines.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Wrap Phase 8 by reviewing the remaining auto-draft and recommendation
  surfaces for any legacy path that can still mutate POs outside the shared
  recommendation engine, then move into Phase 9 demand forecast foundations.

### 2026-05-19 - Phase 8 Slice 11: Recommendation PO Mutation Wrap Audit

Scope:

- Audited remaining purchasing recommendation and auto-draft mutation surfaces
  after the scheduled approval-policy gate landed.
- Found one legacy endpoint, `/api/purchasing/create-po-from-reorder`, that
  accepted arbitrary posted reorder items and called `createPOFromReorder`
  directly, bypassing recommendation confidence, skipped reasons, exclusions,
  and the active approval policy.
- Removed that mutation path by returning `410 Gone` with guidance to use the
  purchasing recommendation engine auto-draft endpoints instead.
- Added route coverage proving the legacy endpoint does not call the
  purchasing service.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/jobs/__tests__/unit/auto-draft.job.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Move into Phase 9 demand forecast foundations now that recommendation-driven
  PO mutation paths are bounded by the shared engine and approval gate.

### 2026-05-19 - Phase 9 Slice 1: Demand Forecast Basis Foundation

Scope:

- Added a dedicated purchasing demand forecast engine for the existing
  recent-order velocity model instead of leaving demand quality and trend logic
  embedded inside PO recommendation generation.
- Standardized forecast provenance with an explicit
  `recent_order_velocity_v1` method, version, source, lookback window, usage,
  prior-period usage, demand sample counts, active demand days, latest demand
  timestamp, demand quality, and demand trend.
- Updated purchasing recommendations to consume the shared forecast basis while
  preserving the current reorder math, review signals, quality gate, and
  auto-draft policy behavior.
- Added focused unit coverage for forecast basis normalization, no-demand vs
  thin-history classification, trend classification, and recommendation
  provenance.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 9 by exposing richer forecast diagnostics in the operator
  recommendation/run-detail surfaces before changing the forecast algorithm
  itself.

### 2026-05-19 - Phase 9 Slice 2: Forecast Diagnostics Operator Surface

Scope:

- Added aggregate forecast diagnostics to purchasing recommendation run detail
  so each auto-draft run records forecast method counts, demand quality counts,
  demand trend counts, total period usage, average daily usage, and latest
  demand timestamp.
- Exposed those diagnostics through normalized auto-draft run history responses
  so the dashboard can summarize why a run's recommendations were trusted or
  held for review.
- Updated the purchasing dashboard auto-draft card and recent-run list to show
  the forecast model, dominant demand quality, dominant trend, and total demand
  sample instead of only PO mutation counts.
- Expanded reorder-analysis forecast basis text to include the explicit
  forecast method and average daily usage while preserving existing confidence,
  supplier, and lead-time signals.
- Added focused run-detail and route coverage for forecast diagnostics in saved
  recommendation audit payloads.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check`

Next step:

- Continue Phase 9 by separating forecast input quality controls from PO
  recommendation confidence, so operators can see whether bad demand data,
  sparse history, missing lead time, or supplier cost risk is what blocked
  autopilot.

### 2026-05-19 - Phase 9 Slice 3: Forecast Input Quality Controls

Scope:

- Added structured recommendation quality controls independent of the existing
  confidence score, covering demand input quality, demand trend risk, missing
  vendor lead time, missing vendors, and supplier cost freshness/source risk.
- Added `autopilotBlockers` to each recommendation and run-detail summary so
  high-confidence policy failures are explainable without reverse-engineering
  confidence factors.
- Updated the quality gate detail to name the primary blocker when an actionable
  recommendation is held for review, while preserving the existing
  high-confidence-only auto-draft behavior.
- Surfaced blocker summaries in reorder analysis and auto-draft run history so
  operators can see whether demand data, lead time, vendor setup, or supplier
  cost risk caused the hold.
- Expanded recommendation engine and run-detail tests around thin history,
  falling demand, missing vendor, supplier cost fallback, and saved run-detail
  blocker payloads.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`

Next step:

- Continue Phase 9 by rolling these quality controls into API-level forecast
  diagnostics and then evaluate the next forecast engine improvement, likely
  richer demand windows or seasonality handling, without changing PO mutation
  behavior first.

### 2026-05-19 - Phase 9 Slice 4: API Quality-Control Diagnostics

Scope:

- Expanded saved purchasing forecast diagnostics with aggregate quality-control
  and autopilot-blocker counts by code, area, and severity.
- Added an item count for recommendations carrying autopilot blockers so the
  API can distinguish a single noisy blocker from broad forecast input risk.
- Preserved recommendation and PO mutation behavior; this slice only makes the
  existing blocker data visible at the run-summary/API layer.
- Updated auto-draft run normalization coverage so recent-run API responses keep
  the new blocker diagnostics intact for dashboard consumers.
- Updated the purchasing dashboard auto-draft card and recent-run summaries to
  show the top quality blocker alongside forecast model, demand quality, demand
  trend, and demand sample size.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`

Next step:

- Continue Phase 9 by adding the first non-mutating forecast engine improvement,
  likely side-by-side short/standard window demand diagnostics or seasonality
  candidates, before allowing the recommendation math itself to change.

### 2026-05-19 - Phase 9 Slice 5: Demand Window Diagnostics

Scope:

- Added a non-mutating short-window demand diagnostic beside the existing
  standard lookback forecast so operators can see short-term acceleration or
  deceleration before the recommendation math changes.
- Extended the procurement reorder data query with seven-day demand usage,
  prior seven-day usage, order count, active demand days, and latest short-window
  demand timestamp.
- Added forecast-engine window comparison output with acceleration ratio and
  signal while preserving the existing standard-window forecast basis as the
  only input to reorder-point math.
- Persisted short-window demand quality, short-window trend, and acceleration
  signal counts in saved run-detail forecast diagnostics.
- Surfaced the acceleration signal in purchasing forecast basis text and
  dashboard run summaries so operators can compare standard demand quality with
  current short-term movement.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`

Next step:

- Continue Phase 9 by adding seasonality or longer-baseline candidate
  diagnostics, still read-only, before deciding whether the PO recommendation
  engine should use anything beyond the current standard velocity model.

### 2026-05-19 - Phase 9 Slice 6: Demand Baseline Diagnostics

Scope:

- Added a non-mutating long-window demand baseline beside the existing
  standard and short demand windows so operators can see whether current
  velocity is above, near, or below a broader sales baseline before forecast
  math changes.
- Extended the procurement reorder data query with long-window usage, prior
  long-window usage, order count, active demand days, latest demand timestamp,
  and a widened demand scan horizon that covers the longest comparison window.
- Added forecast-engine baseline ratio and signal output while preserving the
  standard-window forecast basis as the only input to reorder-point and
  auto-draft decisions.
- Persisted long-window demand quality, long-window trend, and baseline signal
  counts in saved recommendation run-detail forecast diagnostics.
- Surfaced the baseline signal in purchasing forecast basis text and dashboard
  run summaries so operators can compare short-term acceleration with the
  longer demand baseline.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 9 by adding true seasonality or supplier-cycle diagnostics on
  top of the now-visible short/standard/long demand windows, still without
  mutating PO recommendation math until the diagnostics prove useful.

### 2026-05-19 - Phase 9 Slice 7: Demand Seasonality Diagnostics

Scope:

- Added a non-mutating seasonal demand comparison beside the existing
  short, standard, and long forecast windows so operators can see whether
  current velocity is above, near, or below the same calendar-period demand
  window from one year earlier.
- Extended the procurement reorder data query with same-period-prior-year
  usage, prior seasonal usage, order count, active demand days, latest seasonal
  demand timestamp, and a widened demand scan horizon that covers the seasonal
  comparison window.
- Added forecast-engine seasonal ratio and signal output while preserving the
  standard-window forecast basis as the only input to reorder-point and
  auto-draft decisions.
- Persisted seasonal demand quality, seasonal trend, and seasonality signal
  counts in saved recommendation run-detail forecast diagnostics.
- Surfaced the seasonality signal in purchasing forecast basis text and
  dashboard run summaries so operators can compare short-term acceleration,
  long-baseline drift, and calendar-period seasonality before changing
  recommendation math.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed after fixture correction: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Initial broad procurement run hit a transient `bad port` failure in `purchasing-admin.routes.test.ts`; rerunning that file passed.
- Passed on rerun: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 9 by adding supplier-cycle diagnostics or a read-only
  recommendation-candidate score that uses the now-visible demand signals for
  operator review before any PO mutation behavior changes.

### 2026-05-20 - Phase 9 Slice 8: Supplier Cycle Diagnostics

Scope:

- Added read-only supplier-cycle diagnostics to each purchasing recommendation
  so operators can see open PO coverage, past-due inbound supply, and receipt
  recency beside demand forecast signals.
- Classified supplier cycle signals as open supply past due, open supply
  covers the reorder cycle, partial open supply, recent receipt, aging receipt,
  stale receipt, or missing supplier-cycle data without changing recommendation
  status, confidence, quality gates, or auto-draft behavior.
- Persisted supplier-cycle signal counts, past-due open PO count, and average
  supply coverage ratio in saved recommendation run-detail forecast diagnostics.
- Surfaced supplier-cycle signal summaries in the purchasing dashboard run
  detail and per-item forecast text in the purchasing admin views.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts`

Next step:

- Continue Phase 9 with a read-only recommendation-candidate score that combines
  demand diagnostics, supplier-cycle diagnostics, and quality gates for operator
  review before any changes to PO mutation behavior.

### 2026-05-20 - Phase 9 Slice 9: Recommendation Candidate Score

Scope:

- Added a read-only recommendation candidate score to each purchasing
  recommendation, combining demand diagnostics, supply/reorder status,
  supplier-cycle diagnostics, confidence, and quality controls into a visible
  0-100 review signal.
- Classified each recommendation into strong candidate, review candidate,
  watch, or blocked bands without changing reorder quantity, recommendation
  status, confidence, quality gates, auto-draft eligibility, or PO mutation
  behavior.
- Persisted recommendation candidate band counts, average candidate score, and
  strong-candidate count in saved recommendation run-detail diagnostics.
- Surfaced the score and band in purchasing forecast text and dashboard run
  summaries so operators can compare candidate strength before any future
  automation behavior uses these signals.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`

Next step:

- Continue Phase 9 with operator-facing review controls around high-scoring
  candidate recommendations, still keeping PO mutation behavior unchanged until
  the score has been reviewed against live purchasing results.

### 2026-05-20 - Phase 9 Slice 10: Candidate Review Controls

Scope:

- Added read-only candidate-band filters to the reorder analysis table so
  operators can isolate strong candidates, review candidates, watch items, and
  blocked recommendations without changing recommendation math.
- Added a Candidate Score Review queue for the highest-scoring strong and
  review candidate items, including demand, supply, and readiness score
  breakdowns for quick operator review.
- Added a sortable Candidate column to Inventory Burn Telemetry with score,
  band, and component score visibility beside the existing forecast basis and
  quality gate context.
- Kept this slice UI-only: no PO mutation behavior, reorder quantity logic,
  quality gates, or auto-draft eligibility changed.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Review candidate-score behavior against live purchasing output, then decide
  whether candidate-score approval thresholds should become guarded admin
  settings before any score-driven PO draft behavior is enabled.

### 2026-05-20 - Phase 9 Slice 11: Candidate Score Threshold Settings

Scope:

- Added persisted candidate score band thresholds to warehouse settings with
  defaults matching the existing read-only behavior: review candidate at 60 and
  strong candidate at 80.
- Added migration constraints so candidate score thresholds stay within 0-100
  and the review threshold cannot exceed the strong threshold.
- Extended `/api/purchasing/auto-draft-settings` to return and validate the
  candidate score thresholds, and added the controls to the existing purchasing
  exclusions/settings modal.
- Updated recommendation candidate banding to use the configured thresholds
  while keeping PO mutation behavior unchanged: auto-draft eligibility still
  uses the existing high-confidence quality gate.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 9 by reviewing whether candidate score should remain
  diagnostics-only or be introduced as an explicit, disabled-by-default
  auto-draft approval policy after live threshold behavior is validated.

### 2026-05-20 - Phase 9 Slice 12: Candidate Score Approval Policy

Scope:

- Added an explicit disabled-by-default auto-draft approval policy,
  `high_confidence_and_strong_candidate`, while preserving
  `high_confidence_only` as the default behavior.
- Stored and validated the approval policy in warehouse purchasing settings,
  including migration constraints and API normalization.
- Wired the approval policy through purchasing settings UI, run-history
  normalization, and auto-draft execution.
- Updated the stricter policy to require both the existing high-confidence
  quality gate and a strong candidate score band before any PO draft mutation.
- Added regression coverage proving the stricter policy blocks auto-draft PO
  creation when an item is high-confidence but only a review candidate.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 9 by making approval-policy outcomes more operator-visible in
  run history and dashboard review surfaces before considering any default
  behavior change.

### 2026-05-21 - Phase 9 Slice 13: Approval Policy Visibility

Scope:

- Added approval-policy diagnostics to recommendation run details so each
  auto-draft run records quality-gate eligible, active-policy approved,
  active-policy held, and draft-mutation eligible counts separately.
- Added candidate-band breakdowns for recommendations approved by the active
  policy versus held by the active policy.
- Stored a compact held-by-policy recommendation sample in run details so
  operators can see which SKU was high-confidence but failed the stricter
  strong-candidate approval rule.
- Extended recent auto-draft run normalization to return approval-policy
  counts, diagnostics, and the top held recommendation.
- Surfaced approval policy, policy-approved count, policy-held count, and
  draft-mutation eligible count on the purchasing dashboard without changing
  recommendation math, quality gates, or PO mutation behavior.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/jobs/__tests__/unit/auto-draft.job.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`

Next step:

- Continue Phase 9 by adding a read-only approval-policy impact summary to
  manual reorder analysis so operators can preview strict-policy effects before
  running auto-draft.

### 2026-05-21 - Phase 9 Slice 14: Reorder Approval Policy Impact Preview

Scope:

- Added a read-only `approvalPolicyImpact` payload to
  `/api/purchasing/reorder-analysis` so manual review can preview the active
  auto-draft approval policy before an auto-draft run is executed.
- Applied only the active approval policy and candidate-score thresholds to the
  manual preview; PO mutation behavior and the existing reorder-analysis item
  set remain unchanged.
- Included quality-gate eligible, active-policy approved, active-policy held,
  and draft-mutation eligible counts in the manual preview.
- Included candidate-band breakdowns and compact held-recommendation samples so
  operators can see which high-confidence SKUs the stricter strong-candidate
  policy would keep out of draft PO mutation.
- Surfaced the approval-policy impact card on the Reorder Analysis page,
  including the active policy, approved count, held count, draft-eligible count,
  and held recommendation samples.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/jobs/__tests__/unit/auto-draft.job.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`

Next step:

- Validate the live Reorder Analysis approval-policy preview against current
  purchasing output, then close Phase 9 or move into the next hardening phase
  for supplier recommendation workflow and operator approval controls.

### 2026-05-21 - Phase 10 Slice 1: Supplier Setup Gap Panel

Scope:

- Added a read-only `/api/purchasing/supplier-setup-gaps` endpoint that reuses
  the existing purchasing recommendation engine and quality-control signals.
- Aggregated missing preferred vendor, missing supplier cost, last-purchase cost
  fallback, stale supplier cost, unverified supplier cost, default lead-time,
  and product lead-time fallback gaps into dashboard-ready counts.
- Returned compact SKU samples with the primary setup gap, preferred vendor,
  candidate score, quality gate, and recommended operator action.
- Added a supplier setup gap panel to the Purchasing Dashboard so operators can
  see vendor/cost/lead-time blockers before trusting auto-draft output.
- Kept this slice read-only: recommendation math, approval policy, auto-draft
  mutation behavior, and supplier records are unchanged.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 10 by adding a skipped recommendation queue/filter that lets
  operators review why recommendations were held, skipped, or blocked without
  digging through auto-draft run JSON.

### 2026-05-21 - Phase 10 Slice 2: Recommendation Review Queue

Scope:

- Added a read-only `/api/purchasing/recommendation-review-queue` endpoint that
  reuses the existing purchasing recommendation engine, quality gate, and active
  auto-draft approval policy.
- Classified recommendation output into skipped, held-by-policy, and
  quality-review-required queue items with reason, severity, candidate-score,
  supplier, quantity, and operator action metadata.
- Added reason, action, and candidate-band counts so the UI can explain why
  recommendations are not flowing into autopilot without requiring operators to
  inspect auto-draft run JSON.
- Replaced the Reorder Analysis skipped-only review card with a filterable
  recommendation review queue that can show skipped setup blockers, strict
  approval-policy holds, and quality-review candidates.
- Kept this slice read-only: recommendation math, approval policy, auto-draft
  mutation behavior, supplier records, and PO creation behavior are unchanged.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 10 with autopilot run-history action links or a PO detail
  next-action panel so operators can move from diagnostics into the exact
  supplier, recommendation, or PO workflow that needs cleanup.

### 2026-05-21 - Phase 10 Slice 3: Auto-Draft Run Action Links

Scope:

- Added read-only `recommendedActions` metadata to normalized
  `/api/purchasing/auto-draft/runs` responses.
- Derived action links from existing run diagnostics for vendor assignment,
  approval-policy holds, quality-review queues, open PO skips, purchasing
  exclusions, draft PO review, and run errors.
- Kept the action metadata presentation-only: auto-draft settings,
  recommendation math, approval policy, PO mutation behavior, and purchasing
  data are unchanged.
- Added recent-run action buttons to the Purchasing Dashboard so operators can
  jump from auto-draft diagnostics into suppliers, purchase orders, exclusions,
  or filtered Reorder Analysis views.
- Updated Reorder Analysis to honor `reviewQueue` query parameters so dashboard
  links can open the held-policy or quality-review queue directly.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 10 with a PO detail next-action panel for auto-draft POs, so
  operators can see why a draft exists and what review, send, receive, or AP
  step is next without reconstructing the purchasing state manually.

### 2026-05-21 - Phase 10 Slice 4: Auto-Draft PO Next Actions

Scope:

- Added read-only `autoDraftActionPlan` metadata to PO detail responses for
  auto-drafted purchase orders.
- Derived the action plan from the central PO lifecycle summary plus PO line
  count and open exception count, so the guidance does not create a second PO
  state machine.
- Classified the next operator step across review, supplier send,
  acknowledgement/transit, receiving, invoice creation, payment, closeout, and
  exception-blocked states.
- Added a PO detail next-action panel for auto-drafted POs with a primary action
  button and compact checklist for review, supplier send, receiving, and AP
  closeout.
- Kept the slice presentation-only: recommendation math, approval policy,
  auto-draft mutation behavior, PO lifecycle mutations, receiving, invoices,
  and payments are unchanged.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 10 with stale auto-draft PO aging/escalation diagnostics, so
  auto-created POs that remain unreviewed, unsent, unreceived, or unpaid are
  visible before they become supplier or inventory drift.

### 2026-05-21 - Phase 10 Slice 5: Stale Auto-Draft PO Aging Diagnostics

Scope:

- Added a read-only stale auto-draft PO aging service that derives each PO's
  current operator stage from the existing `buildPoAutoDraftActionPlan` output
  instead of introducing a second PO state machine.
- Classified aging across review, supplier send, supplier follow-up, receiving,
  AP closeout, closeout, and exception-blocked stages with warning and critical
  thresholds.
- Added `/api/purchasing/auto-draft/stale-pos` to scan open auto-drafted POs,
  include open PO exception counts, and return dashboard-ready severity,
  counts, details, and PO action links.
- Added a Purchasing Dashboard panel for stale auto-drafted POs so operators can
  jump directly to the affected PO before autopilot-created purchasing work
  drifts out of review, receiving, or AP closeout.
- Kept the slice read-only: recommendation math, auto-draft mutation behavior,
  PO lifecycle commands, receiving, invoices, payments, and supplier data are
  unchanged.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 10 with configurable stale-PO thresholds or escalation
  notifications so aging policy can move from hard-coded diagnostics to
  operator-managed autopilot controls.

### 2026-05-21 - Phase 10 Slice 6: Configurable Stale PO Thresholds

Scope:

- Added `inventory.warehouse_settings` columns and constraints for stale
  auto-draft PO warning and critical thresholds across review, supplier send,
  supplier follow-up, receiving, AP closeout, exception-blocked, and closeout
  stages.
- Extended auto-draft settings storage and `/api/purchasing/auto-draft-settings`
  so the stale PO thresholds round-trip with the existing autopilot controls.
- Updated `/api/purchasing/auto-draft/stale-pos` to read configured thresholds
  before building diagnostics, while keeping diagnostics read-only.
- Added route validation to reject non-integer thresholds, out-of-range values,
  and warning thresholds greater than critical thresholds.
- Added the threshold editor to the existing purchasing controls modal so
  operators can tune aging policy without changing code.
- Kept this slice policy-only: auto-draft recommendation math, PO creation,
  lifecycle commands, receiving, invoices, payments, and notification behavior
  are unchanged.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 10 with escalation notifications for critical stale
  auto-draft POs, using these configured thresholds as the policy source.

### 2026-05-22 - Phase 10 Slice 7: Critical Stale Auto-Draft PO Escalations

Scope:

- Added a shared stale auto-draft PO aging row fetcher so the dashboard route
  and scheduler escalation path scan the same open auto-draft PO population.
- Added a critical stale auto-draft PO escalation service that builds a compact
  operator notification from the existing stale diagnostics and configured
  warning/critical thresholds.
- Added duplicate suppression by critical PO/stage signature so unchanged
  critical stale PO sets do not spam operators inside the cooldown window.
- Wired the daily/manual auto-draft job to run the escalation check after a
  successful recommendation run without failing PO creation if notification
  delivery has an issue.
- Seeded the `auto_draft_po_critical_stale` notification type with admin/lead
  defaults and added the Procurement notification category label.
- Kept this slice notification-only: recommendation math, auto-draft PO
  creation, PO lifecycle commands, receiving, invoices, payments, and stale
  threshold configuration behavior are unchanged.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/auto-draft-po-escalation.service.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/jobs/__tests__/unit/auto-draft.job.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-escalation.service.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- After merge, verify the notification type migration and one scheduler/manual
  auto-draft run in production. Then decide whether Phase 10 is complete or
  whether the dashboard should also show last escalation status/history.

### 2026-05-22 - Phase 11 Slice 1: Procurement Health Monitor Shell

Scope:

- Started Phase 11 by adding a read-only `/api/procurement/health` endpoint
  that aggregates existing procurement guardrails instead of inventing another
  health model.
- Reused stale auto-draft PO diagnostics and landed-cost health as the first
  two health sources, preserving their existing thresholds, counts, and action
  destinations.
- Added a small `buildProcurementHealthSummary` service that normalizes source
  statuses into a single critical/warning/healthy operator summary.
- Added a Purchasing Dashboard health monitor band that rolls active
  procurement drift signals into one status with direct links to the affected
  work queues.
- Kept the slice read-only: recommendation math, auto-draft behavior, PO
  lifecycle commands, receiving, landed-cost allocation, AP, and notification
  policies are unchanged.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/procurement-health.service.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-escalation.service.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-escalation.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.service.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 11 by adding more health sources into the same monitor, likely
  supplier setup gaps and in-flight PO supplier/receiving aging, before wiring
  broader stop conditions or notification policies.

### 2026-05-22 - Phase 11 Slice 2: Supplier Setup Gaps In Health Monitor

Scope:

- Extracted purchasing recommendation context loading into a shared helper so
  supplier setup diagnostics and the health monitor use the same defaults,
  exclusion rules, and product metadata inputs.
- Extracted the supplier setup gap builder into a shared service used by both
  `/api/purchasing/supplier-setup-gaps` and `/api/procurement/health`.
- Added supplier setup gaps as a first-class procurement health source with
  blocked recommendations counted as critical and review recommendations
  counted as warnings.
- Kept this slice read-only: forecast math, recommendation ranking, auto-draft
  PO behavior, PO lifecycle commands, receiving, landed-cost allocation, AP,
  and notification policies are unchanged.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/procurement-health.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-escalation.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.routes.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Continue Phase 11 by adding in-flight PO supplier/receiving aging into the
  same health monitor, then decide whether any of the health sources should get
  escalation notifications or hard stop conditions.

### 2026-05-22 - Phase 11 Slice 3: In-Flight PO Aging In Health Monitor

Scope:

- Added a read-only in-flight PO aging repository for non-auto-draft POs in
  supplier follow-up or receiving states, excluding cancelled, received, closed,
  and auto-draft POs so the existing auto-draft stale source remains distinct.
- Added an in-flight PO aging diagnostics service that reuses the existing
  stale PO threshold settings for supplier follow-up and receiving work.
- Added in-flight PO aging as a first-class `/api/procurement/health` source,
  counting stale supplier follow-up and stale receiving work as warning or
  critical based on the configured thresholds.
- Covered missing ETA, overdue ETA, and arrived-but-not-received cases without
  changing PO lifecycle commands, receiving behavior, forecast math,
  recommendation ranking, auto-draft PO creation, landed-cost allocation, AP,
  or notification policies.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/in-flight-po-aging.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-escalation.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.routes.test.ts server/modules/procurement/__tests__/unit/in-flight-po-aging.service.test.ts`
- Passed: `git diff --check` with CRLF normalization warnings only.

Next step:

- Decide whether Phase 11 needs escalation notifications or hard stop
  conditions for critical health sources, or move into the next procurement
  hardening phase if the read-only monitor now covers the active operational
  drift sources.

### 2026-05-22 - Phase 11 Slice 4: Critical Procurement Health Escalation

Scope:

- Added a procurement health critical escalation service that turns the existing
  aggregate health summary into a compact operator notification when any health
  source is critical.
- Dedupe is based on the critical-source signature, so repeated checks do not
  spam operators unless the critical source mix or counts change, or a caller
  explicitly forces a resend.
- Added the `procurement_health_critical` notification type with admin and lead
  defaults enabled and picker defaults disabled.
- Added a guarded manual `POST /api/procurement/health/escalation` endpoint
  that reuses the same summary builder as the dashboard and returns both the
  health summary and send/suppression result.
- Kept this slice notification-only: no hard stops, no recommendation math
  changes, no auto-draft PO behavior changes, and no receiving, landed-cost, AP,
  or supplier lifecycle mutations.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/procurement-health-escalation.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-escalation.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.routes.test.ts server/modules/procurement/__tests__/unit/in-flight-po-aging.service.test.ts server/modules/procurement/__tests__/unit/procurement-health-escalation.service.test.ts`

Next step:

- Move out of Phase 11 only after deciding whether the health escalation should
  be called from a scheduled job; otherwise start the next procurement phase
  around forecast recommendation auditability and operator acceptance workflow.

### 2026-05-22 - Phase 11 Slice 5: Scheduler-Callable Procurement Health Escalation

Scope:

- Extracted procurement health summary loading out of the Express route into a
  shared service, so the dashboard, manual escalation endpoint, and scheduled
  checks all use the same health source math.
- Added a scheduler-oriented procurement health escalation job that loads the
  aggregate health summary and calls the existing deduped critical notification
  sender.
- Added `server/jobs/run-procurement-health-escalation.ts` and the
  `npm run procurement:health-escalation` command for Heroku Scheduler or
  manual ops execution.
- Supported optional env controls for the runner:
  `PROCUREMENT_HEALTH_ESCALATION_LIMIT`,
  `PROCUREMENT_HEALTH_ESCALATION_DEDUPE_HOURS`, and
  `PROCUREMENT_HEALTH_ESCALATION_FORCE`.
- Kept this slice notification-only and schedule-ready: it does not add a new
  in-process recurring scheduler, hard stops, recommendation math changes,
  auto-draft behavior changes, or receiving, landed-cost, AP, or supplier
  lifecycle mutations.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/procurement-health-escalation.job.test.ts server/modules/procurement/__tests__/unit/procurement-health-escalation.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.routes.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/jobs/__tests__/unit/auto-draft.job.test.ts server/jobs/__tests__/unit/procurement-health-escalation.job.test.ts server/modules/procurement/__tests__/unit/purchasing-admin.routes.test.ts server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts server/modules/procurement/__tests__/unit/purchase-order-lifecycle.service.test.ts server/modules/procurement/__tests__/unit/po-create-send.routes.test.ts server/modules/procurement/__tests__/unit/po-mark-transitions.routes.test.ts server/modules/procurement/__tests__/unit/receiving-mills.test.ts server/modules/procurement/__tests__/unit/po-close-3way-match.test.ts server/modules/procurement/__tests__/unit/inbound-shipment.routes.test.ts server/modules/procurement/__tests__/unit/shipment-tracking-landed-cost.test.ts server/modules/procurement/__tests__/unit/ap-ledger.routes.test.ts server/modules/procurement/__tests__/unit/ap-ledger-invoice-line-import.test.ts server/modules/procurement/__tests__/unit/ap-ledger-atomic-side-effects.test.ts server/modules/procurement/__tests__/unit/ap-ledger-record-payment.test.ts server/modules/procurement/__tests__/unit/ap-ledger-approve-invoice.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-aging.service.test.ts server/modules/procurement/__tests__/unit/auto-draft-po-escalation.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.service.test.ts server/modules/procurement/__tests__/unit/procurement-health.routes.test.ts server/modules/procurement/__tests__/unit/in-flight-po-aging.service.test.ts server/modules/procurement/__tests__/unit/procurement-health-escalation.service.test.ts`

Next step:

- Phase 11 can close after PR review. Start the next procurement hardening
  phase around forecast recommendation auditability and operator acceptance
  workflow, so recommendations become traceable decisions before more
  automation is added.

### 2026-05-22 - Recommendation Decision Audit Trail

Scope:

- Added a persistent `procurement.purchasing_recommendation_decisions` ledger for
  operator decisions on recommendation review queue items.
- Added read/write APIs for recommendation decisions and enriched the existing
  review queue response with each item's latest active decision plus decision
  counts for the filtered queue.
- Server-side decision recording reloads the current recommendation queue and
  snapshots the authoritative recommendation item, active approval policy, and
  lookback window instead of trusting client-provided recommendation details.
- Added Purchasing Dashboard controls to mark queue items reviewed, accepted for
  PO review, deferred, or dismissed, while keeping the existing navigation action
  intact.
- Kept this slice audit-only: no PO creation behavior, recommendation math,
  approval policy, supplier data, receiving, landed-cost, AP, or forecast model
  behavior changed.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`

Next step:

- Continue the operator acceptance workflow by deciding whether accepted
  recommendations should become an explicit PO review queue, a draft PO staging
  action, or a manual PO creation handoff with idempotency keys before any
  automatic mutation behavior is expanded.

### 2026-05-22 - Accepted Recommendation PO Review Queue

Scope:

- Added a read-only `/api/purchasing/recommendation-accepted-queue` endpoint that
  turns the latest active `accepted_for_po` decisions into an explicit PO review
  staging queue.
- The queue intersects accepted decisions with the current recommendation review
  queue and flags stale accepted snapshots when a recommendation is no longer
  present in the current engine output.
- Returned compact current/stale/vendor counts plus action metadata so operators
  can review accepted recommendations before any purchase order mutation.
- Added an Accepted PO Review Queue panel to the Purchasing Dashboard, showing
  accepted recommendation status, vendor, suggested quantity, candidate score,
  and whether the item is current or snapshot-only.
- Kept this slice review-only: no draft PO creation, recommendation math,
  approval policy, supplier data, receiving, landed-cost, AP, or forecast model
  behavior changed.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`

Next step:

- Add the explicit manual PO handoff from accepted recommendations, including
  idempotency protection and clear conflict behavior, before accepted decisions
  are allowed to mutate draft POs.

### 2026-05-22 - Accepted Recommendation Manual PO Handoff

Scope:

- Added an idempotent `/api/purchasing/recommendation-accepted-queue/create-po`
  mutation that hands selected accepted recommendations to the existing
  `createPOFromReorder` draft PO path.
- Kept the handoff explicit and operator-selected: stale accepted snapshots,
  missing products, missing variants, invalid quantities, and missing vendors
  are skipped with clear conflict reasons instead of mutating draft POs.
- Added the `po_handoff_created` recommendation decision state so successful
  handoffs leave an audit trail and drop out of the accepted PO review queue.
- Added a Purchasing Dashboard `Draft PO` action for current accepted queue
  items, sending an idempotency key and refreshing recommendation, accepted
  queue, dashboard, and reorder-analysis data after success.
- Kept this slice bounded to manual accepted-recommendation handoff: no
  automatic PO mutation expansion, recommendation math, approval policy,
  supplier setup, receiving, landed-cost, AP, or forecast model behavior
  changed.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`

Next step:

- After this handoff path is verified in PR review, continue the recommendation
  workflow by adding clearer operator history around accepted/handoff decisions
  or move into forecast-engine demand signal quality, depending on which gap is
  more urgent.

### 2026-05-22 - Forecast Demand Composition Signals

Scope:

- Kept zero-dollar stock-consuming orders and lines in purchasing demand usage
  so fully discounted orders and free gifts still inform replenishment and
  purchasing volume.
- Added paid, zero-revenue, and coupon-discount demand composition provenance
  from the WMS/OMS demand query into the forecast basis, recommendation item,
  run diagnostics, and dashboard summary.
- Added review controls for high zero-revenue or discounted/free demand mixes,
  lowering confidence to medium before autopilot can trust promotional demand.
- Filtered forecast demand to shippable order items, so non-shipping lines do
  not inflate physical purchasing demand.
- Kept this slice to recommendation quality and visibility: no PO creation
  behavior, approval policy, supplier setup, receiving, landed-cost, AP, or
  forecast model authority changed.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-demand-forecast.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.engine.test.ts server/modules/procurement/__tests__/unit/purchasing-recommendation.run-detail.test.ts`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `git diff --check`

Next step:

- After PR review, continue hardening recommendation acceptance history and
  forecast auditability before expanding any scheduled or automatic purchasing
  mutations.

### 2026-05-23 - Recommendation Decision History Visibility

Scope:

- Enriched the recommendation decision history endpoint with generated time,
  active/inactive counts, decision counts, kind counts, status counts, and the
  latest decision timestamp.
- Added a Purchasing View decision-history panel so reviewed, accepted,
  deferred, dismissed, and PO handoff decisions remain visible after items leave
  the active review or accepted queues.
- Refreshed decision history after recommendation decisions and accepted
  recommendation PO handoffs so the UI does not require a manual reload to show
  the audit trail.
- Kept this slice audit/read-model only: no recommendation math, approval
  policy, supplier data, PO creation rules, receiving, landed-cost, AP, or
  forecast model authority changed.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `git diff --check`

Next step:

- Continue forecast auditability by giving run history deeper drilldown/search,
  or move into forecast input backfills once operator decision traceability is
  sufficient.

### 2026-05-23 - Recommendation Run History Drilldown

Scope:

- Normalized bounded recommendation samples for each auto-draft run across
  actionable, approval-policy-held, and skipped recommendations.
- Added Purchasing Dashboard recent-run search over run id, status, mode,
  approval policy, forecast diagnostics, sample SKUs, product names, vendor
  names, quality controls, and autopilot blockers.
- Expanded recent-run cards beyond the single top recommendation so operators
  can see additional held, orderable, and skipped samples before opening deeper
  analysis screens.
- Kept this slice audit/read-model only: no recommendation math, approval
  policy, supplier data, PO creation rules, receiving, landed-cost, AP, or
  forecast model authority changed.

Verification:

- Passed: `npx tsc --noEmit --pretty false`
- Passed: `$env:DATABASE_URL='postgres://test:test@localhost:5432/test'; npx vitest run server/modules/procurement/__tests__/unit/purchasing-recommendation.routes.test.ts`
- Passed: `git diff --check`

Next step:

- Continue forecast auditability into forecast input backfills and stockout or
  demand-suppression visibility once run-level drilldown is verified.
