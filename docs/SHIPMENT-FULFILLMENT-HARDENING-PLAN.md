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

### Shipping Provider Label

A provider label proves that a carrier label exists. It does not prove that a package left the warehouse.

Authority:

- Stable identity `(provider, provider_label_id)`.
- Provider order id/key and normalized tracking number.
- Append-only label observations and void evidence.
- Many-to-many links to authorized shipment requests, engine orders, physical shipments, or legacy shipment rows.

A carrier event may match only a known provider label. Tracking intake cannot invent a label.

### Carrier Tracking Event

A carrier tracking event is provider-authenticated evidence about a label lifecycle. Only an unambiguous event that proves carrier possession or later movement may become dispatch authority after a separately approved cutover.

Label creation, shipment information sent, electronic advice, and awaiting pickup are pre-dispatch states.

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
6. A channel fulfillment command is unique by `(channel_provider, oms_order_id, physical_shipment_id, channel_fulfillment_scope_key)`.
7. Multiple physical shipments may reference one shipping-engine order.
8. One physical shipment may contain a subset of shipment-request items.
9. Retries must re-read by canonical idempotency key before writing.
10. Channel tracking pushes must be driven only by physical shipments with mapped items.
11. The planner is the only code path that can create shipment requests.
12. Shipping adapters can confirm, void, label, or ship requested work, but cannot create commercial authority.
13. Every critical state transition must preserve who, what, when, before state, after state, and idempotency key.
14. Label creation is not physical dispatch.
15. Verified webhook receipts, carrier events, label links, and match attempts are immutable evidence.
16. Carrier tracking cannot create or infer an unknown provider label.
17. One shipping-engine order may combine multiple shipment requests.
18. One physical shipment may contain authorized items from multiple OMS orders; package ownership is derived from its item allocations.
19. Every channel command item must reference the exact physical-shipment item that authorized it.
20. External attempts are append-only evidence; terminal commands cannot be reopened in place.

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
- nullable legacy `shipment_request_id` compatibility pointer
- `provider`
- `command_key`
- `provider_order_id`
- `provider_order_key`
- `provider_status`
- `request_payload_hash`
- `last_sync_at`
- `created_at`
- `updated_at`

### `wms.shipping_engine_order_requests`

- `id`
- `shipping_engine_order_id`
- `shipment_request_id`
- `relationship_type`
- `created_at`

This join is authoritative. It permits one provider order to combine requests and permits a request to be represented by more than one provider order when an explicit split or replacement workflow authorizes that shape.

### `wms.physical_shipments`

- `id`
- `shipping_engine_order_id`
- nullable legacy `shipment_request_id` compatibility pointer
- `provider`
- `provider_physical_shipment_id`
- `tracking_number`
- `carrier`
- `service`
- `ship_date`
- `status`

The exact request and OMS-order membership of a package is derived through `physical_shipment_items.shipment_request_item_id`, never from the compatibility pointer.

### `oms.channel_fulfillment_pushes`

- `id`
- `oms_order_id`
- `physical_shipment_id`
- `channel_provider`
- `channel_fulfillment_scope_key`
- `command_key`
- `request_hash`
- leased retry state
- terminal provider acknowledgement

### `oms.channel_fulfillment_push_items`

- `channel_fulfillment_push_id`
- `physical_shipment_item_id`
- `oms_order_line_id`
- `channel_order_line_id`
- `quantity_pushed`

### `oms.channel_fulfillment_push_attempts`

Append-only evidence for every provider attempt, including the immutable request hash, outcome, provider response identity, classified error, correlation, and causation.
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

### `wms.shipping_provider_labels` and evidence ledgers

- Provider labels are unique by `(provider, provider_label_id)` and remain separate from dispatch.
- One label may have immutable links to multiple shipment requests, engine orders, physical shipments, or legacy rows.
- Label observations are append-only lifecycle evidence.
- Carrier events are append-only normalized provider evidence, unique by `(provider, event_hash)`.
- Every authenticated carrier webhook records an immutable receipt containing the exact request bytes, authentication attestation, key identifier, verification timestamp, and their hashes before payload normalization begins.
- Each parser run appends an immutable normalized or rejected outcome. A receipt remains recoverable even if normalization or event persistence fails later.
- Match attempts are append-only; an unmatched event remains durable and is retried by reconciliation without provider redelivery.

### `wms.carrier_tracking_subscriptions` and enrollment attempts

- Tracking enrollment is unique by `(tracking_provider, carrier_code, normalized_tracking_number)`, not by order or label.
- Multiple provider labels may link to one tracking subscription because duplicate label artifacts can refer to the same parcel identity.
- Only active or unknown ShipStation labels with a provider-supplied carrier code are eligible. Voided and superseded labels are not enrolled.
- The mutable subscription projection uses `pending`, `processing`, `active`, `retry`, and `review` states with a lease for concurrent workers.
- Every provider attempt is append-only and records its request evidence, bounded response evidence, exact outcome, timestamps, and HTTP status.
- Retry delay is deterministic exponential backoff. Exhausted or non-retryable failures require review instead of being silently discarded.

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
- Unique `shipping_provider_labels(provider, provider_label_id)`.
- Exactly one target per provider-label link row while allowing one label to have many link rows.
- Unique immutable carrier event identity `(provider, event_hash)`.
- Immutable provider-label events, provider-label links, authenticated webhook receipts, carrier events, and carrier match attempts.

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

- Record provider label creation separately from physical dispatch.
- Ingest ShipStation `track` webhooks through the dedicated custom-header secret and retain a deterministic HMAC attestation over the exact raw request bytes.
- Persist the exact authenticated request receipt before normalization, then append the parser outcome and normalized carrier event transactionally before acknowledging the webhook.
- Reconcile the durable event to provider labels asynchronously; a matching failure must not cause loss or repeated delivery of already verified evidence.
- Match by exact provider label identity first and normalized tracking only as a fallback.
- Do not create provider labels from carrier events.
- Treat label creation and electronic advice as not dispatched.
- Treat confirmed carrier possession or later movement as dispatch evidence.
- Resolve physical shipment by `(provider, provider_physical_shipment_id)`.
- If found, update idempotently.
- If not found, resolve its shipping-engine order and shipment request.
- Map items by provider line item key first.
- Allow SKU/quantity fallback only when deterministic and logged.
- If mapping is ambiguous, create review exception and do not mutate inventory or channel fulfillment state.

Deliverables:

- Append-only provider-label, label-link, authenticated-webhook-receipt, carrier-event, and match-attempt tables.
- Shadow ingestion and reconciliation that cannot change live fulfillment or inventory state.
- Control Tower exceptions for unlinked labels, unmatched or ambiguous events, unparsed or rejected authenticated receipts, voided-label movement, uncertain dispatch, and labels without acceptance scans.
- ShipStation SHIP_NOTIFY writes `physical_shipments`.
- Split shipments create multiple physical shipments under one shipping-engine order.
- Existing `wms.outbound_shipments` tracking mutation becomes compatibility state only.

Exit gate:

- Authenticated webhook replay is idempotent, exact request bytes remain independently auditable, and malformed or unauthenticated requests are rejected.
- Shadow evidence agrees with known provider and carrier outcomes for a defined observation window.
- A separate reviewed cutover makes confirmed carrier movement authoritative; this phase does not silently flip authority.
- Duplicate webhook replay is a no-op.
- Multiple tracking numbers from one ShipStation order are accepted.
- Same SKU split across packages is handled by request-item references, not SKU guessing.

### Phase 6: Channel Fulfillment Push Rewrite

Goal: push tracking to Shopify/eBay from physical shipment authority only.

Rules:

- Physical shipment with mapped items triggers channel fulfillment push.
- One command per physical shipment, OMS order, channel, and channel fulfillment scope.
- A combined physical package fans out into independent commands for every represented OMS order.
- Retry claims by command id under a lease and re-reads the immutable request snapshot.
- Every command item retains its physical-shipment-item provenance.
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
| Two OMS orders combined into one package | Two plans, two requests, one engine order linked to both requests, one physical shipment, two independent channel commands |
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
- Active linked labels without confirmed carrier possession after the configured operating threshold.
- Carrier events that are unmatched, ambiguous, or tied to a voided label.
- Carrier events missing their immutable authenticated ingress receipt.
- Authenticated webhook receipts with no parse outcome or a rejected latest parse.

## Carrier Tracking Rollout

1. Deploy the additive tables, authenticated endpoint, provider-label observation, reconciliation sweep, and Control Tower projections in shadow mode.
2. Configure ShipStation's `track` webhook to the authenticated Echelon endpoint after the deployment is healthy.
3. Observe authentication failures, immutable-receipt completeness, label-link coverage, match ambiguity, and carrier status classification without changing fulfillment or inventory.
4. Compare shadow carrier evidence with known handoffs and delivered packages for a defined observation window.
5. Approve a separate authority-cutover change that derives dispatch from confirmed carrier possession.
6. Keep a Control Tower exception for active labels that lack carrier acceptance after the configured operating threshold.

The shadow deployment intentionally leaves existing `SHIP_NOTIFY` fulfillment behavior unchanged. That preserves backward compatibility while the new evidence path is proven.

### ShipStation activation contract

The existing ShipStation V1 integration uses `ssapi.shipstation.com`, Basic authentication, and the `SHIP_NOTIFY` webhook. That webhook reports shipment creation/completion; it does not provide the authenticated carrier-movement stream required for physical-dispatch authority.

Carrier movement uses the ShipStation application V2 API `track` webhook contract under the same production ShipStation account. That API calls Echelon at:

`/api/shipping/webhooks/shipstation/track`

ShipStation V2 supports operator-defined webhook headers. Registration configures a dedicated `x-echelon-shipstation-tracking-secret` header. Echelon compares that value in constant time, then records a deterministic HMAC of the exact request bytes. Neither the webhook secret nor the full-access V2 API key is persisted in the receipt or emitted by the configuration command.

ShipStation documents the `data` object on an `API_TRACK` envelope as optional. If it is absent, Echelon retains the exact authenticated receipt, validates that `resource_url` identifies the configured HTTPS `/v2/tracking` endpoint, and schedules an authenticated hydration lookup. The webhook request never waits for that provider lookup. A leased scheduler fetches the direct tracking snapshot, enforces the authenticated carrier/tracking identity, appends the normalized event and hydration attempt atomically, and applies bounded retry or review state. Echelon never follows an arbitrary callback URL and never infers dispatch from the URL alone.

After deploying this shadow implementation, configure the subscription explicitly:

```powershell
heroku config:set SHIPSTATION_TRACKING_WEBHOOK_URL=https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/shipping/webhooks/shipstation/track -a cardshellz-echelon
heroku run "npx tsx scripts/configure-shipstation-tracking-webhook.ts --dry-run" -a cardshellz-echelon
heroku run "npx tsx scripts/configure-shipstation-tracking-webhook.ts --execute" -a cardshellz-echelon
```

`SHIPSTATION_V2_API_KEY` and `SHIPSTATION_TRACKING_WEBHOOK_SECRET` must already be present in Heroku config. Generate the V2 key from the production ShipStation account's **Settings -> Account -> API Settings -> V2** page. Generate the webhook secret independently with at least 32 random printable characters; never reuse or transmit the V2 API key as a callback header. ShipStation currently documents the V2 key as full account access, so neither value belongs in source control, command output, or support messages. Both webhook registration and per-label enrollment use the documented `https://api.shipstation.com/v2` environment. The configuration script is dry-run by default, creates only when no exact authenticated `track` subscription exists, redacts all header values from output, and refuses to delete or overwrite a different, unauthenticated, or duplicate subscription. A conflict requires operator review in ShipStation before rerunning the script.

Configuring the global `track` webhook is necessary but is not enough for existing labels. Each active `(carrier_code, tracking_number)` tuple must also be enrolled through `POST /v2/tracking/start`; the provider confirms enrollment only with HTTP 204. Echelon performs that enrollment through the leased subscription state machine above. It never guesses a carrier from tracking-number syntax.

The five-minute reconciliation scheduler first hydrates missing webhook payloads, then prepares and enrolls at most 25 due subscriptions per sweep. Provider work uses row leases, append-only attempt ledgers, deterministic retry, and a batch lease long enough to cover the bounded serialized request workload. Existing labels can be inspected and enrolled with the bounded operator command:

```powershell
heroku run "npx tsx scripts/enroll-shipstation-carrier-tracking.ts --dry-run" -a cardshellz-echelon
heroku run "npx tsx scripts/enroll-shipstation-carrier-tracking.ts --execute --limit=25 --batches=10" -a cardshellz-echelon
```

The command is dry-run by default, refuses execute mode without the V2 API key, paces provider requests, and cannot change fulfillment or inventory. Control Tower separately exposes missing carrier codes, missing or delayed enrollment, exhausted enrollment failures, delayed or exhausted webhook hydration, unauthenticated or rejected webhook evidence, ambiguous matches, voided-label movement, and active labels with no carrier acceptance after the configured window. `CARRIER_ACCEPTANCE_GRACE_MINUTES` defaults to `1080` (18 hours), accepts 60 through 10080 minutes, and starts from the later of label observation or successful tracking enrollment so rollout delay does not create false exceptions.

Activation is proven only after all of these are true:

1. The registration command reports `created` or `already_configured` for the exact Echelon URL.
2. Authenticated receipts and normalized parse outcomes appear for live tracking callbacks.
3. Control Tower shows no sustained receipt, authentication, parser, label-link, or ambiguity failures.
4. Shadow classifications agree with known carrier pickups for the agreed observation window.

## Fulfillment Authority Cutover Status

The provider-neutral authority cutover was implemented on 2026-07-22. The runtime now:

- Materializes immutable physical shipments and exact physical-shipment item lineage.
- Creates one durable channel command per OMS order, physical shipment, provider, and channel scope.
- Records the physical fact and command outbox in one transaction.
- Claims commands under leases, records append-only attempts, and retries classified transient failures.
- Ingests Shopify and eBay fulfillment evidence through immutable receipts before projection.
- Projects OMS fulfillment from canonical physical-shipment items instead of legacy shipment aggregates.
- Enforces current line authority, terminal commercial state, provider ownership, and blocking review decisions before channel writeback.
- Uses explicit dependencies for callbacks, retries, reconcilers, and sweepers; the legacy direct channel-fulfillment service and hidden database service locators are retired.
- Provides a dry-run-first historical backfill that leaves ambiguous lineage in review instead of guessing.

Compatibility boundaries remain intentionally explicit:

- Existing WMS outbound shipment rows are still accepted as source records while native shipment planning migrates to the canonical plan/request model.
- Shopify, eBay, and ShipStation API clients remain infrastructure adapters behind the canonical authority.
- Carrier-possession authority remains a separate rollout described above.
- Multi-FC planning and any future service extraction remain later architecture phases; they do not change the canonical contracts or idempotency keys established here.

Production rollout requires the additive migration followed by a reviewed dry run of:

```powershell
npx tsx scripts/backfill-channel-fulfillment-authority.ts --dry-run --limit=25
```

Only execute the backfill after the dry-run classifications are accepted. Historical rows that cannot be mapped exactly must remain review exceptions; they must not be repaired by SKU, order-level totals, or inferred package ownership.
