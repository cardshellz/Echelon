# System Boundaries — Echelon

> Every system calls INTO the next system's public interface. Never reach into another system's tables directly.

---

## Principle

Each function:
- Does **ONE thing**
- Trusts **ONE upstream input** (the source of truth for that decision)
- Writes **ONE output**
- Does **NOT** re-derive what another service already knows
- Does **NOT** inner join across tables owned by another system

---

## Two kinds of boundary — pick the right pattern

The principle "depend on an interface, never on internals; one owner per concern" is universal.
The **mechanism** depends on what sits on the other side. Do not make everything a swappable port.

### External integration → PORT + ADAPTER
The other side is a **third party we don't control and might replace** (shipping engine,
sales channels — Shopify/eBay, payment, marketplace APIs). It is *untrusted* and
*interchangeable*. Give it:
- a **canonical vocabulary** owned by us (e.g. a `ShipmentEvent`, a canonical order shape),
- an **adapter** per provider that translates the vendor's model to ours (anti-corruption),
- **no vendor-specific identifiers or field names leaking past the adapter** into our core
  tables or logic (e.g. no `shipstation_order_id` in domain SQL — use a generic
  `(engine, engine_ref)` and let the adapter map it).

Multiple adapters may coexist. ShipStation is one adapter behind a `ShippingEngine` port;
each sales channel is an adapter behind the OMS ingest core.

### Internal domain → PUBLISHED MODULE INTERFACE (one owner, no swap)
OMS, WMS, Catalog, Procurement are domains **we build and own**. We will never "plug in a
different WMS." They get:
- **one stable public interface** (the calling surface other systems use),
- **one owner per table** — no other system writes it; no raw cross-schema SQL; no cross-boundary
  inner joins,
- **NO swappable-adapter machinery.** That is speculative generality (YAGNI) and adds indirection
  on the money/inventory path for a swap that will never happen.

`reserveForOrder()` is the canonical example: WMS's single published entry point, called by OMS,
never reimplemented or bypassed with raw `inventory_levels` writes.

> A clean internal interface still leaves the door open to later split a domain into its own
> deployable service cheaply — that is the interface's value, achieved **without** building
> port/adapter indirection now.

**Rule of thumb:** if you could plausibly buy/replace it from a vendor → port + adapter.
If we build and own it → published interface, one owner, no swap.

---

## Systems

### OMS (Order Management System)
**Owns:** Order lifecycle — create, status transitions, cancel, return authorization
**Tables:** `oms_orders`, `oms_order_lines`, `oms_order_events`
**Ingests from:** Shopify (webhook/bridge), eBay (webhook/polling), future channels
**Calls:** `reservation.reserveOrder()` after order creation (WMS boundary)
**Pushes:** Tracking back to origin channel after shipment confirmation

**Does NOT:**
- Touch `inventory_levels` — ever
- Compute ATP or availability
- Know about bins, locations, or warehouses
- Manage picking, packing, or shipping operations

---

### WMS (Warehouse Management System)
**Owns:** Physical inventory, bin locations, picks, packs, ships, receives, cycle counts, replen, case breaks
**Tables:** `inventory_levels`, `inventory_transactions`, `warehouse_locations`, `product_locations`, `inventory_lots`, `picking_logs`, `replen_tasks`, `replen_rules`, `cycle_counts`, `cycle_count_items`
**Exposes:** 
- `inventoryCore` — receive, adjust, pick, ship, transfer, break/assemble
- `reservationService` — ATP-gated reservation (single entry point)
- `atpService` — fungible ATP calculation (read-only)

**Does NOT:**
- Know about channels, Shopify, eBay, or any external platform
- Know about order ingestion or channel routing
- Push data to external systems (that's Channel Sync's job)

---

### Reservation Service (inside WMS)
**Single entry point:** `reserveForOrder(productId, variantId, qty, orderId, orderItemId)`
**Gates on:** Fungible ATP from `atpService.getAtpPerVariant()`
**Writes to:** `inventory_levels.reserved_qty` on the variant's assigned bin
**Called by:** OMS (after order creation), order-sync-listener (Shopify orders)

**Rules:**
- ATP is the ONLY gate — if ATP says yes, the reserve succeeds
- Does not check bin-level physical stock — ATP already accounts for fungible pool
- Partial reserves allowed — reserves what's available, notifies on shortfall
- Never reimplemented — all reservation paths go through this one function

---

### Channel Sync (Inventory Allocation + Push)
**Owns:** Allocation rules, sync orchestrator, channel adapters (Shopify, eBay)
**Tables:** `channels`, `channel_connections`, `channel_feeds`, `channel_sync_log`, `channel_allocation_rules`, `channel_warehouse_assignments`, `sync_settings`
**Reads from:** `atpService` (fungible ATP), `inventory_levels` (warehouse-scoped quantities)
**Pushes to:** Shopify, eBay, future channels

**Triggers sync when:** ATP changes (receive, adjust, reserve, unreserve)
**Skips sync when:** ATP unchanged from `last_synced_qty`
**Safety net:** Scheduled sweep every 15 minutes

**Does NOT:**
- Modify `inventory_levels` — ever
- Create orders or reservations
- Know about picking, packing, or warehouse operations

---

### Catalog (Product Master)
**Owns:** Products, variants, types, hierarchy, images, pricing
**Tables:** `products`, `product_variants`, `product_types`, `product_assets`, `product_collections`, `product_lines`
**Source of truth for:** SKU → variant mapping, units_per_variant, hierarchy_level, parent relationships

**Does NOT:**
- Know about inventory levels or stock quantities
- Know about orders or channels
- Manage pricing rules (those are per-channel, owned by Channel Sync)

---

### Procurement
**Owns:** Purchase orders, vendors, receiving, accounts payable
**Tables:** `purchase_orders`, `purchase_order_lines`, `receiving_orders`, `receiving_lines`, `vendors`, `vendor_products`, `vendor_invoices`, `ap_payments`, `po_receipts`, `po_status_history`

**Handoff to WMS:** When a receiving order is closed, calls `inventoryCore.receiveInventory()` for each line
**Does NOT:**
- Manage post-receive inventory
- Know about channels or orders
- Directly modify `inventory_levels` (goes through `inventoryCore`)

---

## Source of truth — sole-writer matrix

**OMS owns the ORDER. WMS owns FULFILLMENT** (warehouse state + shipments + physical inventory).
**The shipping engine EXECUTES shipments but owns no truth.** Exactly one module writes each table;
every cross-boundary change is a **request through the owner's interface — in both directions —
never a direct write.**

| State | Sole writer | Others may |
|-------|-------------|------------|
| `oms.oms_orders`, `oms_order_lines`, `oms_order_events` | **OMS** | read; request status change / append events via OMS interface |
| `wms.orders.warehouse_status` (+ picker, on_hold, completed_at), `wms.order_items` | **WMS** | read; request via WMS interface |
| `wms.outbound_shipments` + `outbound_shipment_items` (shipment lifecycle) | **WMS** | read; request create/cancel via WMS shipment interface |
| `inventory.inventory_levels`, `inventory_transactions` | **WMS** (`inventoryCore` only) | read via `atpService`; mutate via `inventoryCore` |
| `channels.*` | **Channel Sync** | read |
| products / variants | **Catalog** | read |
| POs / receiving / vendors | **Procurement** | hand off via `inventoryCore.receiveInventory()` |
| external shipping-engine order (e.g. ShipStation) | **none** — executor only; truth = `wms.outbound_shipments` | command via the `ShippingEngine` port |

Note: `outbound_shipments` is a **WMS** table — WMS *is* the rightful owner and writer of
shipments. The violations to eliminate are (a) other systems (OMS/channels/routes) writing
`wms.*` directly, and (b) the reverse leak where WMS/reconcilers/engine code write `oms_orders`
directly.

**Directional contract:**
- **OMS → WMS:** reserve + create/cancel shipment via WMS interfaces. OMS never writes `wms.*`.
- **WMS → OMS:** shipment shipped/cancelled → WMS calls an OMS interface so **OMS** transitions
  `oms_orders.status`. WMS/reconcilers never write `oms_orders` directly.
- **WMS → engine / engine → WMS:** command via the port; inbound events are normalized and applied
  by WMS to `wms.outbound_shipments`.

---

## Handoff Points

```
Channel → OMS
  Order ingested → oms_orders created → reservation.reserveOrder() called

OMS → WMS  
  Order confirmed → reservation.reserveOrder() → order queued for picking

WMS → Channel Sync
  ATP changes (receive/adjust/reserve/unreserve) → notifyChange → orchestrator pushes to channels

WMS → OMS
  Shipment confirmed → OMS updates order status → OMS pushes tracking to channel

Procurement → WMS
  Receiving closed → inventoryCore.receiveInventory() called
```

---

## ATP Sync Decision Tree

```
Inventory mutation occurs
  ↓
Is it an ATP-changing event? (receive, adjust, reserve, unreserve)
  → YES: notifyChange fires → orchestrator computes ATP → compare to last_synced_qty
           → Changed: push to Shopify
           → Same: skip
  → NO (pick, ship, transfer, break, assemble): no sync triggered
  
Safety net: scheduled sweep every 15 min catches anything missed
```

---

## What Triggers ATP Changes

| Event | ATP Effect | Sync? |
|-------|-----------|-------|
| Receive | ATP goes up (more stock) | ✅ Yes |
| Adjust | ATP changes (correction) | ✅ Yes |
| Reserve | ATP goes down (committed to order) | ✅ Yes |
| Unreserve | ATP goes up (order cancelled/released) | ✅ Yes |
| Pick | No change (already reserved) | ❌ No |
| Ship | No change (already reserved) | ❌ No |
| Transfer | No change (same fungible pool) | ❌ No |
| Case break | No change (same fungible pool) | ❌ No |
| Assemble | No change (same fungible pool) | ❌ No |

---

## Rules for New Code

1. **Before writing to a table, check: does this system own that table?** If not, call the owning system's interface.
2. **Before computing availability, ask: does ATP already know this?** If yes, call `atpService`.
3. **Before checking stock at a location, ask: does this need a `product_locations` join?** Probably not — `inventory_levels` tells you where stock IS.
4. **Never use `allowNegative: true`** — if the math goes negative, something is wrong. Flag it, don't force it.
5. **Every reservation goes through `reserveForOrder()`** — no raw SQL, no reimplementation.
6. **Pick the right boundary pattern** (see "Two kinds of boundary"): external/replaceable →
   port + adapter with a canonical vocabulary; internal/owned → published interface, one owner,
   no swappable-adapter machinery. No vendor-specific identifiers leak past an adapter.
7. **If you're not sure, ask.** Don't build a workaround.

---

*Last updated: 2026-05-30*
