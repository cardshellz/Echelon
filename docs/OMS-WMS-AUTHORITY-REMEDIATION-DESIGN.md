# OMS/WMS Authority Remediation Design

## Status

Proposed design record.

This document captures the remediation plan for the OMS/WMS/ShipStation flow after repeated live incidents showed that recovery and reconciliation paths can create or mutate operational fulfillment state without a strong paid line authority boundary.

## Problem Statement

The current system has useful idempotency and reconciliation pieces, but the authority model is too loose:

- OMS order lines can be created from channel update payloads.
- WMS can materialize missing OMS lines into WMS order items and shipment items.
- ShipStation notify can create WMS shipment rows when it cannot match by `shipstation_order_id`.
- Descriptive channel line fields can be degraded as they move from channel payload to OMS to WMS to ShipStation.
- Some critical lineage is maintained by application convention instead of database-enforced constraints.

The result is a system that can repair common drift, but also has too many places where operational truth can be inferred rather than proven.

## Evidence From Current Code

The following code paths motivated this design:

- `server/modules/oms/oms-webhooks.ts`
  - `orders/updated` can insert new OMS lines when a line id appears in the update payload.
  - Existing lines can be updated from raw Shopify `item.title`, which can degrade the richer Shopify line name.

- `server/modules/oms/oms.service.ts`
  - `LineItemData` carries `title` and `variantTitle`, but not the full channel line `name`, even though `oms.oms_order_lines.name` exists.

- `server/modules/oms/wms-sync.service.ts`
  - Initial OMS to WMS sync maps OMS lines into `wms.order_items`.
  - Existing WMS orders can reconcile missing OMS lines into WMS items and add those items to planned shipments.

- `shared/schema/orders.schema.ts`
  - `wms.order_items.oms_order_line_id` exists as an integer column, but is not modeled as a required foreign key to `oms.oms_order_lines`.

- `server/modules/oms/shipstation.service.ts`
  - `pushShipment` posts a ShipStation order from WMS shipment state.
  - `processShipNotify` resolves by `shipstation_order_id`, then falls back to parsed `orderKey`.
  - The fallback path can create `shipstation_split` shipment rows.

These are not individually wrong features. The problem is that they are not all guarded by the same authority model.

## Design Goal

Make it impossible for OMS, WMS, reconciliation, or ShipStation callbacks to create fulfillable work unless that work is tied to a paid, authorized channel line quantity.

The target model:

1. Channel payloads are immutable evidence.
2. OMS lines represent commercial authority.
3. WMS items represent consumed fulfillment authority.
4. Shipments represent physical fulfillment attempts against WMS items.
5. External callbacks can update known fulfillment records, but cannot create new business truth unless the source proof is complete.

## Non-Goals

- This design does not replace Shopify, eBay, or ShipStation integrations.
- This design does not eliminate reconciliation; it changes reconciliation from mutation-first to proof-first.
- This design does not require all historical data to be perfect before new invariants are introduced. Historical drift should be classified and quarantined.
- This design does not solve every inventory ledger issue. It defines the OMS/WMS authority boundary that inventory operations must obey.

## Core Concepts

### Channel Fact

A raw event or order snapshot from Shopify, eBay, or another channel.

Properties:

- Immutable.
- Dedupe by provider event identity or deterministic idempotency key.
- Stores the original payload required to re-derive channel facts.
- Does not directly authorize WMS work by itself.

### OMS Line Authority

The commercial source of truth for what can be fulfilled.

An OMS line should answer:

- Which channel produced this line?
- Which channel line id does it map to?
- Which channel product or variant id does it map to?
- What SKU and display name did the channel provide?
- What quantity is paid?
- What quantity is fulfillable?
- What quantity is cancelled or refunded?
- Which source event authorized the current fulfillable quantity?

### WMS Materialization

The act of turning authorized OMS line quantity into warehouse work.

WMS should only materialize:

```
available_to_materialize = fulfillable_qty - wms_materialized_qty
```

WMS should not materialize a line because it merely exists in an update payload.

### Shipment Authority

A shipment is a physical fulfillment attempt against existing WMS shipment items.

ShipStation can confirm or update a shipment only when the callback maps to known WMS shipment item keys or a provably safe split of them.

## Required Invariants

### OMS Invariants

- One OMS order per `(channel_id, external_order_id)`.
- One OMS line per `(order_id, external_line_item_id)` when a channel line id exists.
- OMS line display name preserves the richest channel-provided line name.
- OMS line fulfillable quantity cannot exceed paid quantity minus cancelled/refunded quantity.
- Update payload presence alone cannot increase fulfillable quantity.

### WMS Invariants

- Every OMS-origin WMS item must reference a valid OMS line.
- WMS materialized quantity cannot exceed OMS line fulfillable quantity.
- One WMS item per `(wms_order_id, oms_order_line_id)` unless an explicit split model says otherwise.
- WMS cannot create shippable work for unpaid, cancelled, refunded, or non-shipping line quantity.

### Shipment Invariants

- Every outbound shipment item must reference a valid WMS order item.
- Shipment item quantity cannot exceed remaining shippable WMS item quantity unless explicitly marked as an exception.
- One physical shipment identity must not map to multiple active WMS shipment rows.
- One WMS shipment must not create multiple active ShipStation orders.
- ShipStation split rows are allowed only when ShipStation item keys and quantities prove a real split.

### External Integration Invariants

- Every external write uses a durable idempotency key.
- ShipStation create order is protected by a per-shipment lock and a re-read before POST.
- Shopify fulfillment push is idempotent per WMS shipment and fulfillment line set.
- eBay tracking push is idempotent per order line and tracking event.
- Reconciliation never creates new fulfillable work without complete proof.

## Proposed Data Model Changes

### OMS Line Authority Fields

Add fields directly to `oms.oms_order_lines` or a companion authority table:

```
source_event_id
source_topic
source_payload_id
channel_line_id
channel_product_id
channel_variant_id
channel_display_name
paid_qty
fulfillable_qty
cancelled_qty
refunded_qty
wms_materialized_qty
authorization_status
authorized_at
authorized_by_event_id
```

Recommended status values:

```
seen
authorized
partially_cancelled
cancelled
partially_refunded
refunded
blocked_review
```

### WMS Lineage Constraints

Add or tighten:

```
wms.order_items.oms_order_line_id NOT NULL for source = 'oms'
foreign key wms.order_items.oms_order_line_id -> oms.oms_order_lines.id
unique active index on (order_id, oms_order_line_id)
```

### Shipment Idempotency Constraints

Add or tighten:

```
unique non-null wms.outbound_shipments.shipstation_order_id
guard active shipstation_order_key mappings
guard active shipment rows per WMS order unless explicit split/combined source applies
```

The exact partial indexes need to account for legitimate cancelled, voided, split, and combined rows.

## Proposed Phases

### Phase 1: Stop New Unsafe Mutations

Purpose: reduce live risk quickly without a large data migration.

Changes:

- Add per-shipment lock around ShipStation `pushShipment`.
- Re-read `wms.outbound_shipments` inside the lock before calling ShipStation.
- Re-use an existing `shipstation_order_id` when the shipment is pushed again so ShipStation updates the known order instead of creating another one.
- Preserve full channel line display name from Shopify `line.name`.
- Prevent `orders/updated` from downgrading display names.
- Harden ShipStation notify fallback:
  - same `orderKey`
  - same `wms-item-*` line keys
  - same quantities
  - single-line/full-quantity case
  should repair or review, not create a fake split row.

Acceptance criteria:

- Concurrent `pushShipment(shipmentId)` posts to ShipStation once.
- Shopify variant wording such as `Case of 750` cannot be lost.
- ShipStation same-key duplicate notify cannot create a second active WMS shipment.
- Real ShipStation split behavior remains supported when item keys and quantities prove a split.

### Phase 2: Add OMS Line Authority

Purpose: separate channel facts from fulfillable commercial authority.

Changes:

- Add authority fields to OMS lines or a companion table.
- Classify inbound channel events by what they can authorize:
  - create/paid can authorize initial paid quantity.
  - update can refresh channel facts and addresses.
  - edited-order paid evidence can authorize newly added quantity.
  - cancel/refund reduces or blocks fulfillable quantity.
- Stop treating update-payload line presence as enough to create fulfillable work.

Acceptance criteria:

- An update webhook can record a seen line without making it fulfillable.
- A paid edit can increase fulfillable quantity with an auditable source event.
- Cancel/refund events reduce fulfillable quantity before WMS materialization.

### Phase 3: Make WMS Materialization Consume Authority

Purpose: WMS cannot create work unless OMS authority allows it.

Changes:

- Replace "missing OMS line" reconciliation with "unmaterialized authorized quantity" reconciliation.
- WMS sync consumes `fulfillable_qty - wms_materialized_qty`.
- WMS sync updates `wms_materialized_qty` transactionally with item creation.
- Reconciliation creates review exceptions when requested materialization exceeds authority.

Acceptance criteria:

- WMS cannot create items for unpaid or unauthorized lines.
- WMS cannot materialize more units than OMS authorizes.
- Retried sync is idempotent and does not double-materialize.

### Phase 4: Enforce Database Constraints

Purpose: move invariants out of comments and into the database.

Changes:

- Add foreign key from WMS items to OMS lines.
- Add unique constraints for OMS line and WMS item lineage.
- Add non-null/partial constraints for OMS-origin WMS lines.
- Add unique non-null ShipStation order id constraint.
- Add safe active-key constraint for ShipStation order keys.
- Add quantity check constraints where possible.

Acceptance criteria:

- Invalid lineage writes fail at the database layer.
- Duplicate active ShipStation identity mappings fail at the database layer.
- Existing historical drift is quarantined before constraints are validated.

### Phase 5: Replace Reconciliation Behavior

Purpose: reconciliation should classify drift before mutating state.

Changes:

- Introduce reconciliation classifications:
  - `safe_auto_repair`
  - `manual_review`
  - `hard_block`
  - `historical_ignore`
- Require proof rules for every auto-repair.
- ShipStation-originated records can update known shipments, but cannot create new fulfillment work from unmatched data.
- Shopify/eBay fulfillment drift is repaired only when line authority and shipment evidence agree.

Acceptance criteria:

- Unmapped ShipStation callbacks create review exceptions.
- Safe repairs have explicit rule names and audit events.
- No reconciler silently creates fulfillable WMS work.

### Phase 6: Backfill And Quarantine Historical Drift

Purpose: make production data compatible with the new model.

Changes:

- Backfill OMS line authority from raw payloads and existing OMS rows.
- Classify existing WMS rows by lineage quality.
- Identify WMS items without valid OMS lines.
- Identify duplicate ShipStation order keys/order ids.
- Auto-repair only rows with complete proof.
- Quarantine ambiguous rows with review reasons.

Acceptance criteria:

- No active OMS-origin WMS item lacks valid OMS line authority.
- No active shipment has ambiguous ShipStation identity.
- Historical rows that cannot be proven are visible as exceptions.

### Phase 7: Conformance Tests And Monitoring

Purpose: stop regressions.

Test scenarios:

- Shopify `orders/updated` arrives before paid.
- Shopify paid/create arrives twice.
- Shopify edit adds unpaid line.
- Shopify edit adds paid line.
- Shopify cancel before pick.
- Shopify cancel after label.
- Refund before shipment.
- Refund after shipment.
- WMS sync retries after partial failure.
- Concurrent ShipStation push for same WMS shipment.
- ShipStation notify for duplicate order id with same order key.
- Legitimate ShipStation split.
- Combined shipment.
- eBay order ingest, cancel, tracking push.

Monitoring:

- Count active WMS items without OMS authority.
- Count active shipments without ShipStation identity after threshold.
- Count duplicate ShipStation keys.
- Count reconciliation manual reviews by rule.
- Count line-authority over-materialization attempts.

Acceptance criteria:

- CI proves every state transition.
- Dashboards expose drift before it causes fulfillment or financial damage.

## Rollout Strategy

Recommended order:

1. Phase 1 PR: immediate risk reduction.
2. Phase 2 PR: line authority schema and Shopify authorization logic.
3. Phase 3 PR: WMS consumes only authorized quantity.
4. Phase 4 PR: database constraints after backfill readiness checks.
5. Phase 5 PR: reconciliation proof model.
6. Phase 6 scripts: production backfill and quarantine.
7. Phase 7 PR: conformance suite and monitoring.

Avoid shipping Phase 4 constraints before Phase 6 dry runs prove production can pass or be quarantined safely.

## Operational Runbooks Needed

- Order authority trace by order number.
- OMS line authority trace by channel line id.
- WMS materialization trace by WMS order id.
- ShipStation duplicate key repair.
- Reconciliation exception triage.
- Backfill dry-run and execute procedure.

## Open Questions

- What exact Shopify event sequence should authorize paid edited-order lines?
- What eBay payload fields represent paid line authority and ship-by date?
- Which historical WMS rows should remain visible in normal UI versus exception-only views?
- Which ShipStation split cases are operationally valid and should remain automatic?
- Should authority fields live on `oms.oms_order_lines` or in a separate append-only authority ledger?

## Decision Log

- WMS should not treat OMS line existence as enough to create fulfillment work.
- Channel update payloads are evidence, not automatic fulfillment authorization.
- Reconciliation must be proof-first.
- ShipStation is not a source of commercial order truth.
- Database constraints should enforce core lineage once historical data is classified.
