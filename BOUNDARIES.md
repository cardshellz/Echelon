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
6. **If you're not sure, ask.** Don't build a workaround.

---

*Last updated: 2026-03-20*
