# Procurement and WMS Hardening Plan

Last updated: 2026-05-16

Status: planning document. This is not an implementation record and does not
claim that any phase below is complete.

## Purpose

This plan defines the path to harden the procurement, receiving, landed cost,
accounts payable, purchasing recommendation, and WMS handoff flows into a
scalable operating system.

The target is not just a cleaner admin UI. The target is an enterprise-grade
workflow where:

- purchase recommendations are explainable and reliable
- purchase orders have one authoritative lifecycle
- receiving cannot silently drift from PO or inventory state
- landed cost flows into inventory valuation and financial reporting
- AP invoices, payments, and PO balances reconcile
- WMS fulfillment and replenishment consume clean procurement data
- operators see clear next actions instead of needing scripts or database fixes
- automation is allowed only behind idempotency, audit, and exception guardrails

Demand forecasting comes after the purchasing backbone is reliable. The forecast
engine should plug into one purchasing recommendation system, not create a
second ordering authority.

## Guiding Standards

Use `docs/AGENT-CODING-STANDARDS.md` as the standard for every implementation
phase.

Key rules for this work:

- Trace first. Verify current UI, API, service, schema, and downstream behavior
  before changing it.
- Do not guess. Findings and fixes must reference exact files, functions,
  routes, tables, and operational behavior.
- Keep one source of truth for each business decision.
- Make dangerous actions idempotent and safe to retry.
- Prefer explicit errors and operator-visible exceptions over silent fallback.
- Use integer money units only. Preserve cents and mills precision where the
  system already supports it.
- Keep picker and warehouse workflows low-friction, but do not let UI clicks be
  the authority for system-owned inventory or replenishment decisions.
- Preserve existing URLs where possible. Split route files behind stable APIs
  instead of forcing a UI rewrite just to clean up backend structure.

## Current System Map

The procurement admin surface currently spans:

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

The backend is concentrated in a large procurement route module that handles
vendors, receiving, replenishment, purchasing intelligence, purchase orders,
PO lifecycle actions, inbound shipments, landed costs, AP, notifications, and
settings. This should be split, but only after authority boundaries are clear.

Core procurement data includes:

- vendors
- vendor products
- purchase orders
- purchase order lines
- PO status history
- PO revisions
- PO receipts
- receiving orders
- receiving lines
- inbound shipments
- inbound shipment lines
- freight costs
- freight allocations
- landed cost snapshots
- landed cost adjustments
- vendor invoices
- invoice PO links
- invoice lines
- invoice attachments
- AP payments
- AP payment allocations
- reorder exclusions
- auto-draft runs
- PO events
- PO exceptions

Downstream effects include:

- inventory posting from receiving
- inventory lots and cost valuation
- WMS available-to-pick supply
- replenishment triggers after receiving
- channel inventory sync
- reorder analysis and on-order supply
- AP invoice/payment rollups
- order profitability and product profitability reports

## Target Domain Boundaries

The final system should have these conceptual owners:

1. Supplier catalog
   - Vendors
   - Vendor products
   - Preferred vendor rules
   - MOQ, case pack, order UOM, lead time, currency, cost
   - Replacement or inactive supplier-product handling

2. Purchase order lifecycle
   - Drafting
   - Submit
   - Approve
   - Send to vendor
   - Vendor acknowledge
   - Shipped
   - In transit
   - Arrived
   - Receiving
   - Received
   - Close short
   - Close
   - Cancel
   - Void when appropriate

3. Receiving orchestration
   - Receipt creation
   - Receiving line edits
   - Putaway validation
   - Inventory posting
   - PO line reconciliation
   - PO receipts
   - Replenishment and channel sync side effects
   - Receiving exceptions

4. Inbound shipments and landed cost
   - Shipment lifecycle
   - PO line linking
   - Packing list import
   - Freight, duty, tax, and fee allocation
   - Provisional vs finalized cost
   - Push-to-lots
   - Late landed cost adjustment handling

5. Accounts payable
   - Vendor invoices
   - PO invoice linking
   - Invoice lines
   - Three-way match
   - Disputes
   - Payments
   - Voids
   - Outstanding PO balance

6. Purchasing recommendation engine
   - Reorder analysis
   - Auto-draft runs
   - Exclusion rules
   - Supplier constraints
   - Skipped item reasons
   - Recommendation explanation
   - Optional PO creation after review or policy approval

7. Demand forecast engine
   - Demand history
   - Channel mix
   - Seasonality
   - Promotions
   - Stockout suppression
   - Free gift and coupon behavior
   - Lead-time adjusted recommended supply
   - Forecast confidence and review threshold

8. Monitoring and admin controls
   - Stuck workflow checks
   - Drift checks
   - Operator queues
   - Automation settings
   - Autopilot guardrails

## Phase 0: Baseline and Review Frame

Goal: establish the current-state map before code changes.

Review:

- procurement UI routes and menu structure
- backend route inventory
- service ownership and large modules
- procurement, inventory, WMS, AP, and reporting schema touchpoints
- current tests
- current dirty worktree
- recent replenishment hardening patterns worth reusing

Deliverables:

- current-state map
- initial risk list
- agreed phase order

Exit criteria:

- no major procurement surface is unaccounted for
- we know which code paths create, mutate, receive, cost, invoice, and pay POs
- we have a safe implementation order

## Phase 1: Domain Boundaries and Route Split Plan

Goal: decide where ownership lives before moving files.

Review:

- which endpoints belong to PO lifecycle
- which endpoints belong to receiving
- which endpoints belong to supplier catalog
- which endpoints belong to inbound shipments and landed cost
- which endpoints belong to AP
- which endpoints belong to purchasing intelligence
- which endpoints are currently using mismatched permissions

Implementation direction:

- keep URLs stable
- create smaller route modules only around clear domains
- keep route handlers thin
- move business rules into services and command handlers

Recommended route modules:

- `vendors.routes.ts`
- `vendor-products.routes.ts`
- `purchase-orders.routes.ts`
- `receiving.routes.ts`
- `inbound-shipments.routes.ts`
- `landed-cost.routes.ts`
- `ap.routes.ts`
- `purchasing-intelligence.routes.ts`
- `procurement-settings.routes.ts`

Exit criteria:

- a route belongs to exactly one domain module
- each route calls a clear service function
- no route directly owns multi-step business orchestration

## Phase 2: PO Lifecycle Backbone

Goal: create one authoritative PO lifecycle.

Problems to resolve:

- legacy `status` still competes with `physicalStatus` and `financialStatus`
- some paths use the newer physical transition helper
- other paths still update status directly
- audit history exists but is not uniformly used
- PO lifecycle actions are not consistently idempotent

Target model:

- `physicalStatus` owns goods movement
- `financialStatus` owns invoice/payment state
- legacy `status` is derived or synchronized for compatibility only
- every lifecycle transition goes through one state machine
- every transition writes history and an event
- invalid transitions return actionable errors

Scope:

- submit
- return to draft
- approve
- send
- send to vendor
- acknowledge
- mark shipped
- mark in transit
- mark arrived
- enter receiving
- received
- close short
- close
- cancel
- void

Deliverables:

- `purchase-order-lifecycle.service.ts`
- centralized transition table
- route handlers delegating to lifecycle service
- tests for valid transitions
- tests for invalid transitions
- tests for audit/history rows
- tests for legacy status compatibility

Exit criteria:

- no PO lifecycle action updates status outside the lifecycle service
- all physical transitions use the same path
- financial transitions are separated from physical transitions
- UI can render a PO's next valid actions from the lifecycle state

## Phase 3: Receiving Orchestration

Goal: prevent inventory, receiving, and PO drift.

Problems to resolve:

- receiving close posts inventory and closes the receipt transactionally
- PO reconciliation can happen after that transaction
- PO reconciliation failure may be logged instead of blocking or surfacing
- duplicate receipt creation is possible if the user retries
- receiving close side effects are spread across receiving, purchasing,
  inventory, channel sync, and replenishment services

Target command:

`closeReceivingAndReconcilePo(receivingOrderId, userId, idempotencyKey)`

This command should own:

- close validation
- line completeness checks
- putaway location validation
- inventory posting
- case-break posting
- receiving line status updates
- receiving order close
- PO line received and damaged quantity updates
- PO receipt records
- PO physical status transition
- exception creation for unmatched, over, short, or wrong product receipt
- after-commit channel sync
- after-commit replenishment checks

Design principle:

Do not let inventory become correct while the PO remains wrong. Either the whole
authoritative reconciliation succeeds, or the operator gets a visible exception.

Deliverables:

- `receiving-orchestration.service.ts`
- idempotent close receipt command
- shared transaction boundary or explicit recovery record
- visible exception when PO reconciliation cannot complete
- tests for retry
- tests for partial receipt
- tests for over receipt
- tests for unlinked receipt line
- tests for auto-match ambiguity
- tests for receiving close failure rollback or recovery behavior

Exit criteria:

- closing a receipt cannot silently fail PO reconciliation
- duplicate close attempts are safe
- duplicate receipt creation is prevented or intentionally reopens an existing
  draft receipt
- inventory transactions, receiving rows, PO rows, and PO receipts agree

## Phase 4: Idempotency and Concurrency

Goal: make every high-risk action safe to retry.

High-risk actions:

- create purchase order
- create purchase order with lines
- duplicate purchase order
- send purchase order
- submit, approve, send, acknowledge, cancel, close, close-short
- create receipt from PO
- close receipt
- discard receipt
- inbound shipment lifecycle actions
- import packing list
- allocate landed costs
- finalize landed costs
- push landed costs to lots
- create vendor invoice
- link PO to invoice
- import invoice lines from PO
- run invoice match
- approve invoice
- create AP payment
- void AP payment
- run auto-draft
- create PO from recommendation

Deliverables:

- consistent `Idempotency-Key` requirements on mutation routes
- command-level idempotency for service calls
- database uniqueness where natural keys exist
- tests for duplicate browser clicks
- tests for retry after timeout
- tests for concurrent requests

Exit criteria:

- repeated user actions do not duplicate receipts, costs, invoices, payments, or POs
- retry behavior returns the same result or a clear conflict
- every operator-facing mutation has a known retry contract

## Phase 5: Supplier Catalog and Vendor Terms

Goal: make recommendations source from trustworthy supplier data.

Review:

- vendor records
- active/inactive vendors
- vendor products
- preferred vendor selection
- product and variant mapping
- vendor SKU
- MOQ
- order multiple
- case pack
- order UOM
- unit cost
- currency
- lead time
- safety stock days
- payment terms
- replacement products
- disabled or excluded products

Deliverables:

- supplier catalog validation rules
- missing supplier data work queue
- preferred vendor conflict detection
- inactive vendor/product guardrails
- cost and currency normalization
- vendor lead-time audit
- UI indicators for recommendation blockers

Exit criteria:

- every recommendation can explain the vendor choice
- every recommendation can explain purchase UOM and quantity rounding
- items without supplier data are skipped with reasons, not silently ignored
- admin UI exposes missing data needed for autopilot

## Phase 6: Inbound Shipments and Landed Cost

Goal: make inventory valuation defensible.

Review:

- shipment lifecycle
- PO line linkage
- packing list import
- dimensional resolution
- freight costs
- duty and tax costs
- allocation basis
- finalized vs provisional cost
- landed cost snapshots
- adjustments
- push-to-lots behavior
- late freight invoice handling

Deliverables:

- one landed cost finalization command
- allocation explainability per PO line
- provisional cost visibility
- late cost adjustment workflow
- tests for allocation math
- tests for push-to-lots idempotency
- tests for partial shipment and multi-PO shipment

Exit criteria:

- received inventory has clear cost provenance
- freight/duty/tax allocations are reproducible
- late cost changes are auditable
- valuation and profitability reports agree with procurement/AP source data

## Phase 7: AP and Financial Controls

Goal: make PO cost, received cost, invoiced cost, and paid cost reconcile.

Review:

- vendor invoice lifecycle
- invoice line import from PO
- manual invoice lines
- PO invoice links
- three-way match
- disputes
- AP payment creation
- payment allocation
- payment voids
- overpayment and underpayment
- PO financial aggregates
- AP dashboard summary

Deliverables:

- AP state machine
- invoice match command
- PO financial aggregate recompute command
- payment allocation idempotency
- mismatch exception queue
- tests for payment void and recompute
- tests for disputed invoice
- tests for partial payment

Exit criteria:

- PO total, received total, invoiced total, paid total, and outstanding balance
  can be reconciled
- invoice mismatches block or warn according to policy
- financial reporting does not depend on stale denormalized fields

## Phase 8: Purchasing Recommendation Engine Foundation

Goal: unify reorder analysis and auto-draft into one explainable engine.

Problems to resolve:

- manual reorder analysis and auto-draft can diverge
- recommendation logic exists in more than one path
- auto-draft runs need consistent settings, exclusions, skipped reasons, and audit
- PO creation should be a downstream action, not mixed into recommendation logic

Target engine:

`generatePurchasingRecommendations(options)`

Inputs:

- current on-hand inventory
- reserved inventory
- available inventory
- recent demand
- open PO supply
- lead time
- safety stock
- vendor product data
- exclusions
- autopilot settings

Outputs:

- recommendation id
- product and variant
- preferred vendor
- current supply
- open PO supply
- demand basis
- lead-time basis
- recommended order qty
- order UOM
- estimated cost
- confidence
- skipped reason if not actionable
- explanation text for UI

Deliverables:

- single recommendation engine
- one auto-draft run path
- recommendation audit table or run detail payload
- skipped-reason taxonomy
- UI showing why each item is recommended or skipped
- tests for stockout, order now, order soon, excluded, no vendor, already on order

Exit criteria:

- manual UI and scheduled job use the same engine
- auto-draft can run without creating POs when configured for review-only
- every recommendation is explainable
- demand forecast can plug into this engine later

## Phase 9: Demand Forecast Engine

Goal: forecast demand accurately enough to drive purchasing recommendations.

Inputs:

- historical shipped demand
- channel-level demand
- stockout periods
- promotions
- coupon/free-gift behavior
- seasonality
- recent acceleration or slowdown
- returns and cancellations where relevant
- lead time
- supplier reliability
- open PO supply
- current inventory

Core rules:

- do not treat stockout periods as zero demand without adjustment
- separate free-gift demand from paid demand where needed
- handle 100 percent discount orders as real unit demand when they consume stock
- forecast confidence should influence automation level
- low-confidence forecasts should create review recommendations, not automatic POs

Deliverables:

- forecast model interface
- demand history table or materialized view
- forecast run history
- forecast confidence output
- recommendation engine integration
- UI for forecast explanation
- tests for stockout suppression, promo spikes, free gifts, and seasonality

Exit criteria:

- recommendations can be demand-driven instead of only velocity-driven
- users can see why demand was forecast
- low-confidence recommendations are visibly flagged

## Phase 10: Admin UI Hardening

Goal: make operators know what to do next.

UI improvements:

- PO detail next-action panel
- supplier setup gap panel
- receiving close blockers
- receipt reconciliation exceptions
- landed cost finalization status
- AP match status
- skipped recommendation queue
- autopilot settings
- run history
- health dashboard

Principles:

- show exact blockers
- show recommended action
- show source data
- do not hide critical workflow behind scripts
- keep dense admin screens operational, not decorative

Exit criteria:

- an operator can run purchasing, receiving, landed cost, and AP workflows from UI
- skipped automation cases are visible and actionable
- admin settings are clearly active, inactive, or planned

## Phase 11: Monitoring and Autopilot Guardrails

Goal: allow automation without silent drift.

Health checks:

- duplicate draft POs for same vendor/day
- stale draft POs from auto-draft
- sent POs with no vendor acknowledgement
- acknowledged POs past expected ship date
- arrived shipments not received
- open receipts not closed
- receipt closed but PO not reconciled
- PO received but invoice missing beyond expected terms
- invoice mismatch unresolved
- AP payment failed or voided
- landed cost provisional too long
- vendor product missing cost, lead time, MOQ, or UOM
- recommendation skipped due to missing supplier data
- forecast anomaly

Deliverables:

- procurement health monitor
- admin health dashboard
- notification policies
- automation stop conditions
- runbooks for each health item

Exit criteria:

- autopilot creates clear work queues
- operators are alerted before drift becomes financial or fulfillment damage
- critical automation can pause itself when guardrails fail

## Phase 12: Backfills, Migrations, and Cleanup

Goal: clean historical data after authoritative paths are fixed.

Backfills may include:

- PO physical and financial statuses
- stale legacy status values
- receipt to PO line links
- missing PO receipt records
- landed cost snapshots
- AP aggregates
- supplier catalog metadata
- auto-draft run history
- recommendation exclusions
- old exceptions

Rules:

- do not backfill before the forward path is fixed
- every backfill should be dry-run first
- every execute should report changed row counts and sample records
- avoid destructive cleanup unless there is a reversible audit record

Exit criteria:

- historical data matches the new invariants
- health monitors are clean or only show intentional review items
- operators no longer need manual DB clears for normal workflow recovery

## Recommended Walkthrough Order

Work in this order:

1. PO lifecycle backbone
2. Receiving orchestration
3. Idempotency and concurrency
4. Supplier catalog and vendor terms
5. Inbound shipments and landed cost
6. AP and financial controls
7. Purchasing recommendation engine foundation
8. Demand forecast engine
9. Admin UI hardening
10. Monitoring and autopilot guardrails
11. Backfills and cleanup

This order keeps the system safe. Forecasting and autopilot should not be built
on top of ambiguous PO, receiving, landed cost, or AP behavior.

## First Implementation Slice

The first code slice should be narrow and high leverage:

1. Create a PO lifecycle service boundary.
2. Route all PO physical lifecycle actions through one transition path.
3. Add idempotency to high-risk PO lifecycle actions.
4. Add tests proving legacy status compatibility.
5. Do not change the UI unless needed for accurate next actions.

The second slice should be:

1. Create a receiving orchestration service boundary.
2. Make receipt close and PO reconciliation authoritative.
3. Add idempotency to create receipt and close receipt.
4. Surface reconciliation failures as exceptions instead of swallowed logs.
5. Add tests for retry, partial receipt, and reconciliation failure.

## Definition of Done for the Program

The hardening program is complete when:

- each domain has one service owner
- all critical mutations are idempotent
- PO lifecycle is one state machine
- receiving cannot drift from PO or inventory state
- landed costs are traceable into inventory valuation
- AP can reconcile PO, invoice, payment, and outstanding balances
- purchasing recommendations are explainable
- forecast output feeds the recommendation engine, not direct PO mutation
- UI exposes blockers and next actions
- monitoring catches stuck or drifting workflows
- historical data has been backfilled to match the new invariants

