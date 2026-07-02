# Shipment and Fulfillment Hardening Plan

## Purpose

This document codifies the plan to harden the OMS/WMS/shipping/channel-fulfillment flow so split shipments, retries, provider outages, and future shipping-engine changes do not keep creating order-specific repairs.

The goal is an auditable, provider-agnostic fulfillment model:

- OMS order lines remain the commercial source of truth.
- WMS fulfillment plans decide what operational work is authorized.
- Shipping engines receive shipment requests and return physical shipment events.
- Sales channels receive tracking updates from physical shipments.
- Retries are idempotent at each boundary.

This is not a ShipStation-only design. ShipStation is the current shipping adapter, but the target shape must support a future internal shipping engine without changing OMS/WMS authority boundaries.

## Current Code Evidence

The current system overloads one WMS table as multiple concepts.

- `shared/schema/orders.schema.ts:416` defines `wms.outbound_shipments`.
- `shared/schema/orders.schema.ts:420` stores `external_fulfillment_id` on that shipment row.
- `shared/schema/orders.schema.ts:439-441` store ShipStation order id, ShipStation order key, and Shopify fulfillment id on that same row.
- `shared/schema/orders.schema.ts:476` defines `wms.outbound_shipment_items`.

The current OMS-to-WMS sync creates shipment rows during order sync.

- `server/modules/oms/wms-sync.service.ts:49` gates shipment creation with `WMS_SHIPMENT_AT_SYNC`.
- `server/modules/oms/wms-sync.service.ts:55` gates WMS-originated ShipStation push with `PUSH_FROM_WMS`.
- `server/modules/oms/wms-sync.service.ts:308` creates shipment work during WMS sync when shippable items exist.
- `server/modules/oms/wms-sync.service.ts:441` calls `createShipmentForOrder`.
- `server/modules/oms/wms-sync.service.ts:480-492` pushes that WMS shipment to ShipStation.
- `server/modules/oms/wms-sync.service.ts:557` reconciles existing WMS order lines and can append missing lines to shipment state.

The current shipment-plan helper creates one planned shipment row for a WMS order.

- `server/modules/wms/create-shipment.ts:170` defines `createShipmentForOrder`.

The current ShipStation adapter uses WMS shipment ids as ShipStation order keys and uses WMS shipment item ids as ShipStation line item keys.

- `server/modules/oms/shipstation.service.ts:87-131` parses Echelon order keys.
- `server/modules/oms/shipstation.service.ts:2977` builds `orderKey = echelon-wms-shp-${shipmentId}`.
- `server/modules/oms/shipstation.service.ts:3019` sends `lineItemKey = wms-item-${item.id}`.
- `server/modules/oms/shipstation.service.ts:3066` writes ShipStation identity back onto `wms.outbound_shipments`.

The current SHIP_NOTIFY path resolves, mutates, and can create WMS shipment rows from ShipStation events.

- `server/modules/oms/shipstation.service.ts:1026` resolves WMS shipment for ShipStation notify.
- `server/modules/oms/shipstation.service.ts:1071` ensures split shipment rows from ShipStation events.
- `server/modules/oms/shipstation.service.ts:1124-1149` can repair a parent shipment mapping to an incoming ShipStation order id.
- `server/modules/oms/shipstation.service.ts:1163` inserts split rows using ShipStation order identity.
- `server/modules/oms/shipstation.service.ts:1814` processes ShipStation SHIP_NOTIFY v2.
- `server/modules/oms/shipstation.service.ts:1869` applies the event to a resolved shipment.

The current warehouse router is order-level, not line-level or multi-FC planning.

- `server/modules/orders/fulfillment-router.service.ts:20` defines the routing context.
- `server/modules/orders/fulfillment-router.service.ts:59` routes an order to one warehouse.
- `server/modules/orders/fulfillment-router.service.ts:151` assigns one warehouse to an order.

## Current Structural Problem

`wms.outbound_shipments` is currently being used as all of these at once:

1. Internal planned shipment.
2. ShipStation order/request identity.
3. Physical shipment/tracking identity.
4. Shopify fulfillment push state.
5. Reconciliation repair target.
6. Split-shipment representation.

That shape is unsafe because a shipping engine order and a physical package are not the same thing.

ShipStation can produce multiple physical shipments from one ShipStation order. A future internal shipping engine will also need to support one internal shipment request producing multiple packages. Therefore the canonical idempotency key for a physical shipment cannot be the provider order id or WMS shipment row id. It must be the physical shipment event identity.

## Not Proven Yet

These items require schema review, live data review, or implementation tracing before final migration decisions:

- Whether every current ShipStation split event includes reliable `lineItemKey` values.
- Whether every provider can supply a stable physical shipment id.
- Whether eBay fulfillment/tracking APIs need a different fulfillment-push item granularity than Shopify.
- Whether current combined-order child behavior should remain as-is or move into explicit plan/request relationships.
- Whether any UI currently depends directly on overloaded `wms.outbound_shipments` fields.

## Target Concepts

### OMS Order

Commercial order from Shopify, eBay, dropship, or another channel.

Authority:

- Channel order id.
- Channel line ids.
- Paid/refunded/cancelled state.
- Customer-entered shipping address.
- Product SKU and purchased quantity.

### WMS Order

Warehouse work representation for an OMS order.

Authority:

- Operational status.
- Assigned warehouse or fulfillment path.
- Pick/pack/ship workflow state.

### Fulfillment Plan

The internal decision of how an OMS/WMS order should be fulfilled.

Authority:

- Which OMS/WMS lines are authorized for fulfillment.
- Which warehouse, dropship vendor, 3PL, or backorder path owns each line.
- Why the line is routed that way.

### Shipment Request

An internal request to ship a set of fulfillment-plan lines.

Authority:

- Internal shipment-request identity.
- Requested lines and quantities.
- Destination address snapshot.
- Service level, priority, hold state, and routing metadata.

This is not a physical shipment and not a tracking event.

### Shipping Engine Order

Provider-specific representation created in ShipStation or a future internal shipping engine.

Authority:

- Provider name.
- Provider order id.
- Provider order key/reference.
- Request payload hash.
- Last provider sync state.

### Physical Shipment

Actual shipped package or provider shipment event.

Authority:

- Provider physical shipment id.
- Tracking number.
- Carrier/service.
- Ship date.
- Package-level status.

This is the source for channel tracking pushes.

### Channel Fulfillment Push

Tracking update sent back to Shopify, eBay, or another sales channel.

Authority:

- Channel provider.
- Channel fulfillment id or equivalent.
- Physical shipment id.
- Channel line item quantities pushed.
- Push status and retry state.

## Required Invariants

1. No fulfillable work can exist without an authorized OMS/WMS line reference.
2. A shipping adapter must not invent product lines.
3. A shipment request is not a physical shipment.
4. A shipping-engine order is not a physical shipment.
5. A physical shipment is unique by `(provider, provider_physical_shipment_id)`.
6. A channel fulfillment push is unique by `(channel_provider, physical_shipment_id)`.
7. Multiple physical shipments may reference one shipping-engine order.
8. One physical shipment may contain a subset of shipment-request items.
9. Retries must re-read by canonical idempotency key before writing.
10. Channel tracking pushes must be driven only by physical shipments with mapped items.
11. The planner is the only code path that can create shipment requests.
12. Shipping adapters can confirm, void, label, or ship requested work, but cannot create commercial authority.
13. Every critical state transition must preserve who, what, when, before state, after state, and idempotency key.

## Proposed Tables

The exact schema should be finalized in migrations during implementation, but the target ownership should be:

### `wms.fulfillment_plans`

- `id`
- `oms_order_id`
- `wms_order_id`
- `plan_status`
- `planner_version`
- `created_at`
- `updated_at`

### `wms.fulfillment_plan_lines`

- `id`
- `fulfillment_plan_id`
- `oms_order_line_id`
- `wms_order_item_id`
- `product_variant_id`
- `sku`
- `quantity_authorized`
- `quantity_cancelled`
- `quantity_shipped`
- `line_status`
- `authority_snapshot`

### `wms.shipment_requests`

- `id`
- `fulfillment_plan_id`
- `wms_order_id`
- `warehouse_id`
- `request_status`
- `hold_reason`
- `priority_rank`
- `ship_to_snapshot`
- `planner_reason`
- `created_at`
- `updated_at`

### `wms.shipment_request_items`

- `id`
- `shipment_request_id`
- `fulfillment_plan_line_id`
- `wms_order_item_id`
- `quantity_requested`
- `quantity_cancelled`
- `quantity_shipped`

### `wms.shipping_engine_orders`

- `id`
- `shipment_request_id`
- `provider`
- `provider_order_id`
- `provider_order_key`
- `provider_status`
- `request_payload_hash`
- `last_sync_at`
- `created_at`
- `updated_at`

### `wms.physical_shipments`

- `id`
- `shipping_engine_order_id`
- `shipment_request_id`
- `provider`
- `provider_physical_shipment_id`
- `tracking_number`
- `carrier`
- `service`
- `ship_date`
- `status`
- `raw_event_hash`
- `created_at`
- `updated_at`

### `wms.physical_shipment_items`

- `id`
- `physical_shipment_id`
- `shipment_request_item_id`
- `fulfillment_plan_line_id`
- `wms_order_item_id`
- `quantity_shipped`
- `provider_line_item_id`
- `provider_line_item_key`

### `oms.channel_fulfillment_pushes`

- `id`
- `channel_provider`
- `oms_order_id`
- `physical_shipment_id`
- `channel_fulfillment_id`
- `status`
- `attempt_count`
- `last_error`
- `created_at`
- `updated_at`

### `oms.channel_fulfillment_push_items`

- `id`
- `channel_fulfillment_push_id`
- `oms_order_line_id`
- `channel_order_line_id`
- `quantity_pushed`

## Constraints

Required database constraints:

- Unique active fulfillment plan per WMS order unless superseded.
- Foreign keys from plan lines to OMS/WMS lines.
- Unique `shipping_engine_orders(provider, provider_order_id)` when provider order id is present.
- Unique `shipping_engine_orders(provider, provider_order_key)` when provider order key is present.
- Unique `physical_shipments(provider, provider_physical_shipment_id)`.
- Unique `channel_fulfillment_pushes(channel_provider, physical_shipment_id)`.
- Check constraints preventing non-positive requested or shipped quantities.
- Check constraints preventing shipped quantity from exceeding authorized quantity unless explicitly exceptioned.

The current active uniqueness on ShipStation order id/key should not be the physical-shipment idempotency boundary after cutover.

## Phased Plan

### Phase 1: Architecture Doc and Conformance Tests

Goal: lock the expected behavior before changing runtime logic.

Deliverables:

- This plan document.
- Test fixtures for known failure shapes.
- Provider-agnostic conformance test matrix.
- No production behavior change.

Required tests:

- One Shopify order, one shipment, one tracking push.
- One Shopify order, one ShipStation order, multiple physical shipments.
- Same SKU split across multiple physical shipments.
- Multiple line items with the same SKU.
- Partial shipment followed by later shipment.
- Edited paid line after initial shipment plan.
- Cancel before shipping-engine push.
- Cancel after shipping-engine order exists.
- Refund after shipping.
- Duplicate webhook replay.
- Out-of-order shipment webhook.
- Provider outage and retry.
- Digital/non-shipping item mixed with physical item.
- eBay order tracking push.
- Combined order behavior.

Exit gate:

- Tests fail against the current unsafe shape where appropriate.
- Tests encode the desired target behavior without relying on ShipStation-specific names in core assertions.

### Phase 2: Add Canonical Tables Beside Existing Flow

Goal: add the new model without changing runtime behavior.

Deliverables:

- Migrations for canonical fulfillment/shipping tables.
- Read-only backfill script from existing WMS/ShipStation data.
- Integrity report comparing old overloaded state to new canonical state.

Exit gate:

- Backfill can run in dry-run and execute.
- Existing rows map deterministically or are classified as review exceptions.
- No current production writes are redirected yet.

### Phase 3: Fulfillment Planner V1

Goal: introduce the planner boundary while preserving current behavior.

V1 behavior:

- One order-level warehouse decision.
- One fulfillment plan per WMS order.
- One shipment request for all shippable items.
- No multi-FC split yet.
- No behavior change except audit/canonical rows.

Deliverables:

- `FulfillmentPlanner` domain/application interface.
- V1 implementation backed by the existing routing result.
- Tests proving V1 reproduces current one-FC behavior.

Exit gate:

- OMS-to-WMS sync creates canonical plan/request rows.
- Existing WMS flow still functions.
- No shipping adapter writes plan/request rows directly.

### Phase 4: Shipping Engine Adapter Boundary

Goal: make ShipStation a provider adapter, not core fulfillment logic.

Adapter contract:

- `createOrUpdateShippingOrder(request)`
- `getShippingOrder(providerOrderId)`
- `cancelShippingOrder(providerOrderId)`
- `holdShippingOrder(providerOrderId)`
- `releaseShippingOrder(providerOrderId)`
- `updateSortRank(providerOrderId, rank)`
- `ingestPhysicalShipment(event)`

Deliverables:

- `ShippingEngineAdapter` interface.
- ShipStation implementation behind that interface.
- Current ShipStation push writes to `shipping_engine_orders`.

Exit gate:

- Core WMS code depends on the adapter interface.
- ShipStation order id/key no longer act as the physical-shipment idempotency key.

### Phase 5: Physical Shipment Ingestion Rewrite

Goal: make SHIP_NOTIFY idempotent at the package/tracking level.

Rules:

- Resolve physical shipment by `(provider, provider_physical_shipment_id)`.
- If found, update idempotently.
- If not found, resolve its shipping-engine order and shipment request.
- Map items by provider line item key first.
- Allow SKU/quantity fallback only when deterministic and logged.
- If mapping is ambiguous, create review exception and do not mutate inventory or channel fulfillment state.

Deliverables:

- ShipStation SHIP_NOTIFY writes `physical_shipments`.
- Split shipments create multiple physical shipments under one shipping-engine order.
- Existing `wms.outbound_shipments` tracking mutation becomes compatibility state only.

Exit gate:

- Duplicate webhook replay is a no-op.
- Multiple tracking numbers from one ShipStation order are accepted.
- Same SKU split across packages is handled by request-item references, not SKU guessing.

### Phase 6: Channel Fulfillment Push Rewrite

Goal: push tracking to Shopify/eBay from physical shipment authority only.

Rules:

- Physical shipment with mapped items triggers channel fulfillment push.
- One push row per physical shipment/channel.
- Retry re-reads by physical shipment id.
- Shopify "no fulfillment order line item available" must be classified:
  - already fulfilled/idempotent,
  - line mismatch requiring review,
  - channel API failure requiring retry.

Deliverables:

- Provider-agnostic channel fulfillment push service.
- Shopify adapter.
- eBay adapter.
- Retry worker keyed by `channel_fulfillment_pushes.id`.

Exit gate:

- Partial Shopify fulfillment with later tracking works.
- Multi-package Shopify fulfillment works.
- eBay tracking push works.
- Replay does not create duplicate pushes.

### Phase 7: UI and Read Model Migration

Goal: make operational surfaces reflect canonical concepts.

UI/read model changes:

- WMS Orders shows fulfillment plan/request state.
- Picking shows shipment request state.
- Shipping page shows shipping-engine orders and physical shipments.
- OMS timeline shows channel fulfillment pushes.
- Exceptions page shows ambiguous provider events, unmapped physical shipments, and failed channel pushes.

Exit gate:

- Operators can distinguish ready-to-pick, in-progress, shipped package, and failed channel push.
- No UI depends on ShipStation-specific fields for generic fulfillment state.

### Phase 8: Cutover and Cleanup

Goal: stop writing overloaded state as authority.

Cutover sequence:

1. Dual-write old and new.
2. Compare old and new read models.
3. Flip reads to new canonical model.
4. Stop old authority writes.
5. Keep compatibility views for historical reports.
6. Remove or narrow unsafe unique constraints.
7. Retire old repair scripts that mutate overloaded shipment state.

Exit gate:

- Zero unexplained drift for a defined observation window.
- Production dashboards show no ambiguous physical shipment events.
- All live channel fulfillment pushes are traceable to physical shipment rows.

### Phase 9: Multi-FC and Future Engine Expansion

Goal: make fulfillment planning scalable without changing shipping or channel push boundaries.

Planner V2 can support:

- Multi-warehouse splits.
- SLA-based routing.
- Inventory availability routing.
- Cost-based carrier/service decisions.
- Backorder decisions.
- Dropship/3PL handoff.
- Internal shipping engine.

Exit gate:

- Multiple shipment requests can exist under one fulfillment plan.
- Each request can map to a different warehouse or fulfillment provider.
- Physical shipments and channel pushes still work without special cases.

## Test Matrix

| Shape | Expected Result |
| --- | --- |
| Single Shopify order, one package | One plan, one request, one engine order, one physical shipment, one Shopify push |
| Shopify order split into two packages | One plan, one request, one engine order, two physical shipments, two channel pushes |
| Same SKU in two packages | Physical shipment items map by request item keys, not SKU alone |
| Multiple order lines same SKU | Mapping remains line-authoritative |
| Partial shipment now, rest later | Channel gets first tracking for shipped subset, then second tracking later |
| Duplicate SHIP_NOTIFY | Existing physical shipment is updated/no-op, not duplicated |
| Out-of-order SHIP_NOTIFY | Event is accepted if request/order mapping is deterministic |
| Missing provider item keys | Deterministic fallback or review exception; no blind mutation |
| Cancel before push | Request cancelled; no engine order |
| Cancel after engine order | Engine order cancelled; request cancelled or held by policy |
| Void/relabel | Physical shipment is voided/replaced without duplicate inventory decrement |
| Shopify no remaining fulfillment order line | Classified as already fulfilled or mismatch, not generic dead retry |
| eBay tracking push | Same physical-shipment-driven channel push contract |
| Future internal shipping engine | Uses same `ShippingEngineAdapter` contract |

## Observability Requirements

Every critical state transition must log structured context:

- `run_id`
- `correlation_id`
- `oms_order_id`
- `wms_order_id`
- `fulfillment_plan_id`
- `shipment_request_id`
- `shipping_engine_order_id`
- `physical_shipment_id`
- `channel_fulfillment_push_id`
- provider name
- provider order id
- provider physical shipment id
- before status
- after status
- actor/system source
- idempotency key

Required dashboards:

- Physical shipments without mapped items.
- Physical shipments not pushed to channel after threshold.
- Channel push failures by reason.
- Duplicate provider physical shipment id attempts.
- Shipment requests with no shipping-engine order after threshold.
- Shipping-engine orders with multiple physical shipments.
- Provider events classified as review exceptions.

## Immediate Next PR

The next PR should be non-behavioral.

Scope:

- Add this plan document.
- Add conformance test scaffolding for the known failure shapes.
- Mark expected failures where the current overloaded model cannot satisfy the target invariant.

Do not:

- Drop production unique indexes yet.
- Rewrite SHIP_NOTIFY yet.
- Add provider-specific tables as the long-term model.
- Add another one-off ShipStation repair branch.

## First Implementation PR After Tests

After the conformance test PR is reviewed, the first behavior-changing PR should introduce the canonical tables and read-only backfill.

That gives us evidence before cutover:

- What maps cleanly.
- What is historical drift.
- What needs manual review.
- Which existing UI/report queries depend on overloaded shipment fields.
