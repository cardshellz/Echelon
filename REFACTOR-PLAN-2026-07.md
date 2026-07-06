# Echelon Refactor Plan — Working Draft for Review

> Companion to `ARCHITECTURE-AUDIT-2026-07.md`. This is the **discussion document**: every work
> item is PR-sized, has an ID we can reference (P0.1, P1.2, …), and every place where you need to
> make a call is marked **⚖ DECISION**. Nothing here is built yet.
>
> Sizes: **S** = ≤1 day, **M** = 2-4 days, **L** = ~1 week+. Risk = production blast radius of the
> change itself (not of leaving it unfixed).

---

## At a glance

| ID | Item | Size | Risk | Depends on | Decision needed |
|----|------|------|------|-----------|-----------------|
| P0.1 | Reservation integrity (4 sub-PRs) | L | Med | — | D5 |
| P0.2 | Remove all DML from db.ts boot | M | Low | — | — |
| P0.3 | Engine-cancel discrimination + reconciler guards | M | Med | — | — |
| P0.4 | Close legacy/combined SHIP_NOTIFY inserts | M | Med | — | — |
| P0.5 | Refund atomicity + cancel ordering | S | Low | — | — |
| P0.6 | Restore eBay real-time intake | M | Med | — | — |
| P0.7 | Kill `\|\| 'paid'` default / WMS write from OMS webhook | S | Med | — | — |
| P0.8 | Inventory correctness cluster (6 fixes) | M | Med | — | — |
| P0.9 | Retry discipline (4 fixes) | M | Low | — | — |
| P1.1 | Shipment status state machine | M | Med | P0.3 | — |
| P1.2 | OMS order status state machine | L | Med | — | — |
| P1.3 | Enforce warehouse_status chokepoint | M | Med | P1.1 | D1 |
| P1.4 | Typed module interfaces (kill `as any`) | M | Low | — | — |
| P1.5 | Job registry + advisory locks + re-entrancy | M | Low | — | — |
| P1.6 | Single webhook durability contract | M | Med | — | — |
| P1.7 | Evict index.ts reconcilers into modules | M | Low | P1.1, P1.2 | — |
| P2.1 | CI writer-ratchet | M | Low | — | — |
| P2.2 | Route-layer write eviction (83 sites, batched) | L | Med | P2.1 | D3 |
| P2.3 | Table-by-table single-writer migration | XL | Med | P1.x, P2.1 | D1 |
| P3.1 | Channel intake port + Zod contracts | L | Med | P1.6 | — |
| P3.2 | Dropship convergence onto OMS/inventory APIs | M | Med | P0.1, P3.1 | D5 |
| P3.3 | Shipping engine port completion | L | Med | P1.1 | D4 |
| P3.4 | Legacy `shipstation_*` identity retirement | M | High | P3.3 | D4 |
| P3.5 | Push-after-pick gate | M | **High (workflow)** | P1.1 | **D2** |
| P3.6 | Returns lifecycle | L | Med | — | **D6** |
| P3.7 | Hold model unification | M | Med | P0.2 | D7 |
| P4.1 | Migration authority consolidation | M | Med | P0.2 | — |
| P4.2 | Structured logger + correlation rollout | L | Low | — | — |
| P4.3 | Module layering normalization | L | Low | P2.3 | — |
| P4.4 | Subscriptions repair or extraction | M | Low | — | **D8** |
| P4.5 | Small hygiene batch | S | Low | — | — |

---

## Phase 0 — Stop active loss

Ship as independent PRs; no shared refactoring; each is revertible alone. Every PR carries unit
tests for the specific failure mode plus a regression test that reproduces the bug first.

### P0.1 — Reservation integrity (split into 4 PRs)

**P0.1a — Dropship acceptance stops raw-reserving.**
Today: `dropship-order-acceptance.repository.ts:866-891` raw-UPDATEs `reserved_qty` + hand-writes
a ledger row with order refs that don't resolve to `wms.orders`; WMS sync then reserves again;
nothing ever releases the first one. *(Prod-confirmed 2026-07-02.)*
Change depends on **⚖ DECISION D5** (below). Under D5-option-A (recommended): delete the raw
reserve entirely; acceptance validates ATP (read-only check, which it already does) and the single
reservation happens at WMS sync exactly like every other order. Under D5-option-B: acceptance
reserves through `inventoryCore.reserveInventory` with the OMS order/line ids, and the WMS-sync
reserve step is taught to *adopt* (release-and-replace in one tx) an existing acceptance-time
reservation instead of stacking a second one.
Tests: acceptance→sync→cancel end-to-end asserts net reservation delta 0 after cancel and exactly
1× after sync; replay/double-submit asserts no double count.

**P0.1b — Order-scoped, idempotent release.**
Today: `releaseOrderReservation` (`channels/reservation.service.ts:369-384`) releases
`min(item.qty, level.reservedQty)` from any level of the variant; three callers
(`oms-webhooks.ts:390`, `wms-sync.service.ts:722`, `inventory.routes.ts:1068`) can each fire →
double-release drains other orders' reservations.
Change: release becomes ledger-driven — compute this order's open reservation as
`SUM(reserve) - SUM(unreserve)` for `(order_id, order_item_id)` from `inventory_transactions`, and
release exactly that (clamped ≥0). A second call releases 0. Route all three callers through it.
Tests: double-call = no-op; release-after-edit; concurrent release under lock.

**P0.1c — Reconciler cancels release reservations.**
Today: hourly sweep (`index.ts:914-916`) and `OMS_FINAL_WMS_ACTIVE`
(`oms-flow-reconciliation.service.ts:1026`) call status-only `cancelOrder()`
(`order-status-core.ts:214-229`).
Change: introduce `wmsApi.cancelOrder(orderId, reason)` that transitions status AND releases via
P0.1b in one transaction; both reconcilers and the webhook cascade call it. This becomes the only
WMS-order cancel entrypoint (pre-work for P1.3).

**P0.1d — Data repair: sweep leaked reservations + lot counters.**
Script (dry-run default, like your existing remediation scripts): find `reserve` transactions with
no matching `unreserve` whose order is terminal (`shipped`/`cancelled`) or whose `order_id` doesn't
exist in `wms.orders`; also stale `picked_qty` with no open shipment; reconcile
`inventory_levels.reserved_qty` and `inventory_lots.qty_reserved` down, writing ledgered
`unreserve` rows. Report first, apply after your review. *(The 2026-07-02 manual fix covered one
variant; this generalizes it.)*
**⚖ DECISION D9:** run once, or keep as a scheduled reconciler with alerting until P0.1a-c soak?
Recommendation: run once now, re-run read-only weekly during soak, alert on non-zero drift.

### P0.2 — Remove all DML from `db.ts` boot path — **M**

Delete from `runStartupMigrations()`: the hold wipe (`db.ts:668`), the `inventory_levels` DELETE
with no ledger entry (`:550`), shipment-status rewrites (`:639-657`), `oms_orders` repair (`:632`),
lot-cost UPDATEs (`:802-885`). Each that is still needed becomes a numbered, tracked migration that
runs once; the rest are deleted. Also: replace the swallow-all try/catch (`:1071-1073`) with
fail-fast on DDL and remove startup DDL that duplicates tracked migrations (defer full
consolidation to P4.1 — this PR only stops the *data* mutations).
Tests: boot twice against a seeded DB → assert zero row diffs between boots.

### P0.3 — Engine-cancel discrimination + reconciler guards — **M**

- `cancelOrder` returns a discriminated state (`cancelled | already_cancelled | already_shipped |
  not_found`) instead of `alreadyInState: true` for two opposite outcomes
  (`shipstation.service.ts:3210-3217`).
- Hourly reconcile (`index.ts:948-955`): only mark shipped on `already_shipped`; never on
  `already_cancelled`.
- `SHIPMENT_SHIPPED_OMS_OPEN` predicate excludes final OMS states (`cancelled`, `refunded`)
  (`oms-flow-reconciliation.service.ts:310-312`) — those become a `requires_review` bucket
  instead of an auto-flip.
- Every reconciler UPDATE in `index.ts:948-960, 1263-1311` gains a status predicate in the WHERE
  (no unguarded terminal transitions after network calls).
Tests: cancelled-order + already-cancelled-engine-order scenario asserts no resurrection; the
606-shipment TOCTOU scenario as a regression test.

### P0.4 — Close remaining SHIP_NOTIFY creation paths — **M**

- Legacy path: replace the INSERT at `shipstation.service.ts:2745-2750` with resolve-or-flag
  (same `requires_review` pattern as the V2 fix in `1fa0d30`).
- Combined-shipment path: stop INSERTing synthetic `queued` children (`:1531-1544`) — resolve to
  existing children or flag.
- Add the unique constraint the `ON CONFLICT DO NOTHING` pretends exists (migration; dedupe
  existing duplicates first — the audit found this inflates fulfillment sums).
Tests: replayed legacy SHIP_NOTIFY creates zero rows; combined shipment with missing child flags
review instead of inserting.

### P0.5 — Refund atomicity + cancel ordering — **S**

- `refund_amount_cents` becomes `SET refund_amount_cents = refund_amount_cents + ${delta}` with a
  per-refund idempotency marker in the same tx (`oms-webhooks.ts:2189→2275`).
- Move the `status='cancelled'` write (`:2004`) to *after* `cancelOrderCascade` (`:2014`), or make
  the early-return guard (`:1994`) check cascade completion, so retries actually retry.
- Derive `financial_status='refunded'` from cumulative refunded vs order total, not per-payload
  (`:2232-2234`).

### P0.6 — Restore eBay real-time intake — **M**

- Move `/api/ebay/webhooks/order` out from behind session auth (`index.ts:526-527`); verify eBay's
  challenge + notification signature instead.
- Persist-then-ACK through the webhook inbox (mirror the Shopify path `oms-webhooks.ts:1440-1473`)
  and enqueue retry on failure instead of ACKing 200 (`ebay-order-ingestion.ts:472-480`).
- Backstop while soaking: widen the poller to also sweep `lastmodifieddate` so late cancels/refunds
  (>4h) are caught even without webhooks.

### P0.7 — `orders/updated` stops forging payment state — **S**

Remove the `financial_status = payload.financial_status || 'paid'` default and the direct
`warehouse_status pending→ready` write (`oms-webhooks.ts:1725-1744`). Missing field = no change.
The WMS effect goes through the sync service (which owns that transition) — interim step until
P1.3 formalizes the interface.

### P0.8 — Inventory correctness cluster — **M** (one PR, six isolated fixes)

1. Break/assembly: thread the outer tx into both `adjustInventory` calls via `withTx`
   (`break-assembly.use-cases.ts:160-198,263-300`; `inventory.use-cases.ts:477`).
2. Delete the phantom `inventoryCore.adjustLevel` call path (`reservation.service.ts:504`) — dead
   at runtime, a TypeError when reached.
3. Remove `allowNegative: true` (`inventory.use-cases.ts:1172`) — shortfall flags instead of
   forcing negative.
4. Receipt 23505 catch: rethrow so the enclosing tx rolls back
   (`inventory.use-cases.ts:174-178`); the route's Idempotency-Key already gives the caller a
   clean replay.
5. `getAtpBaseByWarehouse` subtracts picked+packed (`atp.service.ts:167`) to match `getAtpBase`
   (`:130`) and `getDirectVariantAtpByWarehouse` (`:205`). *(Prod-confirmed overstatement.)*
   Note: this will lower pushed channel quantities by currently-picked stock — expected and
   correct; flag to ops.
6. Lot recosts write mills + cents together (`cogs.service.ts:295-306,432-439,1000-1006,1153-1161`).

### P0.9 — Retry discipline — **M**

1. Dead-letter is terminal: re-seeders (`oms-flow-reconciliation.service.ts:460-467,694-708`)
   dedupe against ALL non-pending statuses; dead rows need explicit manual requeue.
2. Fix inverted classification in Reconcile V2 (`index.ts:1486-1494`): SS 429/timeout = transient
   (retry), not quarantine.
3. Sync-recovery stops re-pushing `requires_review`/held shipments (`sync-recovery.service.ts:180-209`).
4. Worker claims with `FOR UPDATE SKIP LOCKED` (copy `dropship-order-processing-runner.ts:76-113`).

---

## Phase 1 — Chokepoints (build the doors)

### P1.1 — Shipment status state machine — **M**

One `transitionShipmentStatus(shipmentId, from[], to, ctx)` in `modules/wms`: atomic
`UPDATE … SET status=$to WHERE id=$id AND status = ANY($from)` returning the row; explicit
transition matrix (planned→queued→labeled→shipped; cancelled/voided terminal; shipped terminal).
Replace the read-then-write mark-helpers (`shipment-rollup.ts:239→278, 371→425`,
`fulfillment.service.ts:653-660`). Callers get a discriminated result (`transitioned | blocked_by(<state>)`)
— no boolean ambiguity. Audit event per transition with correlation ids.

### P1.2 — OMS order status state machine — **L**

Same pattern for `oms_orders.status` + `financial_status`: `transitionOmsOrderStatus()` with an
explicit matrix (incl. which transitions are channel-driven vs engine-driven vs reconciler-driven).
The 11+ current writers migrate onto it; the 4 duplicated OMS-derive SQL blocks
(`shipstation.service.ts:2419-2450,2853-2869`; `index.ts:1371-1428`) collapse into one
`recordShipmentOutcome()` API that WMS/engine code calls instead of writing `oms_orders`.

### P1.3 — Enforce the warehouse_status chokepoint — **M**

`transitionOrderStatus` (`order-status-core.ts`) already has the guarded CAS — the work is
eliminating the 11 bypasses: `releaseOrder` (`orders.storage.ts:939-955` — must also restore
inventory or refuse post-pick), `updateOrderProgress` (`:1147-1171` — no resurrection of
cancelled), the ops-branch arbitrary status (`:1017-1026` via `channels.routes.ts:488`),
`combining.markGroupShipped` (`:996-999`), OMS-side raw writes, `diagnostics.ts:267`. Also fix the
phantom `wms.orders.status` column write (`orders.storage.ts:1411` — column doesn't exist).
**⚖ DECISION D1:** where does WMS order state live long-term? `modules/orders` (12.5k LOC,
operational logic) vs `modules/wms` (799 LOC, the clean write-primitive template). Recommendation:
write primitives move to `modules/wms`, `modules/orders` keeps workflow/orchestration and calls
them — no big-bang merge.

### P1.4 — Typed module interfaces — **M**

Export real interfaces (`InventoryCore`, `WmsApi`, `OmsApi`, `ChannelsApi`) from each module;
composition root (`services/index.ts`) drops every `as any` (e.g. `:92`); `db: any` becomes typed.
Deletes the phantom-method bug class (F8b, historical C7) at compile time. Ban `as any` on service
injection via lint.

### P1.5 — Job registry — **M**

Every loop registers: name, cadence, advisory-lock key (mandatory), states it may write, dead-letter
policy. Wrap the five unlocked heavy reconcilers (`index.ts:405,890,977,1588` + boot repairs).
Boot one-shots move to run-once scripts (gated by a `schema_migrations`-style ledger), not
every-deploy code. `/api/sync/status`-style page lists all registered jobs + last run + lock state.

### P1.6 — Single webhook durability contract — **M**

One rule: **persist to inbox → ACK → process from inbox** for every inbound event. Migrate:
SHIP_NOTIFY (`index.ts:433-473`), fulfillments (`shopify.routes.ts:1587-1701`), products/update's
ACK-then-`setImmediate` (`:1454-1471`), eBay (from P0.6). The inbox worker is the only processor.

### P1.7 — Evict index.ts reconcilers — **M**

The ~850 lines of inline reconcile/repair (`index.ts:846-1580`) move into their owning modules as
registered jobs (P1.5) calling chokepoints (P1.1-P1.3). `index.ts` ends as pure composition:
wire services, register routes, register jobs. The `(db as any).__fulfillmentPush` smuggling
(`:483-490`) is replaced by explicit constructor injection.

---

## Phase 2 — Writer migration + the ratchet

### P2.1 — CI writer-ratchet — **M** (land BEFORE the migrations it protects)

- Adapt the audit's scanner (`audits/2026-07-architecture/matrix.json` was generated by it) into
  `scripts/writer-ratchet.ts` + a committed `writer-baseline.json`.
- CI fails if: a table gains a writing module not in baseline; any `*.routes.ts` gains a write; a
  schema-qualified raw write appears outside the owning module.
- Shrinking the baseline is a one-line PR celebrated in review; growing it requires explicit
  justification in the diff.
- Add dependency-cruiser rules for cross-module imports (no deep imports into another module's
  `infrastructure/`).

### P2.2 — Route-layer write eviction — **L** (batched by file)

83 sites / 15 files, worst first: `catalog.routes.ts` (22 sites → catalog.service),
`ebay/*` (~40 sites → a proper eBay listing service under `modules/channels`), `diagnostics.ts`
(hard-deletes + tx-void → guarded admin service with audit events), `shopify.routes.ts:412,647`
(raw shipped-shipment INSERTs → wmsApi), `pick-priority.routes.ts` (incl. the write to
shellz-owned `membership.plans` — should be an API call to shellz-club or dropped).
**⚖ DECISION D3:** `diagnostics.ts` powers manual repair. Keep as guarded admin endpoints
(service-layer, audited, permission-gated) or retire in favor of scripts? Recommendation: keep,
but every action becomes a service call that writes an audit event — ops needs these.

### P2.3 — Table-by-table single-writer migration — **XL** (the long march)

Order: `inventory.inventory_levels`/`inventory_transactions` (financial core) →
`wms.outbound_shipments`+items → `wms.orders`/`order_items` → `oms.oms_orders`/lines/events →
`inventory.inventory_lots`/`oms.order_item_costs` (costing) → catalog/channels config tables.
Per table: enumerate writers from the matrix → move each behind the owner's API → shrink baseline
→ soak. Each table is its own PR series; nothing merges without the ratchet entry shrinking.

---

## Phase 3 — Seams (the growth enablers)

### P3.1 — Channel intake port — **L**

Revive `channel-adapter.interface.ts` as the real contract: `ChannelOrderAdapter` with
`verifyWebhook / normalizeOrder(raw) → ChannelOrder / normalizeCancel / normalizeRefund`, a Zod
`ChannelOrder` schema validated at the boundary, and one `ingestAndRoute()` use-case owning all
post-ingest choreography (dedup → ingest → sync → events). Shopify + eBay migrate onto it;
adapter-conformance test suite runs against every registered adapter. Success criterion: a new
channel = 1 adapter file + config row + conformance tests green.

### P3.2 — Dropship convergence — **M**

Per the dropship report's verdict (keep architecture, fix convergence): acceptance calls a
tx-composable `omsApi.ingestOrder` instead of raw INSERTs
(`dropship-order-acceptance.repository.ts:728,816,791`); reservation per P0.1a; channel config
writes move behind `channelsApi` (`dropship-oms-channel-config.repository.ts:248-350`); OAuth
state gains nonce/one-time-use; the eBay intake provider drops its duplicated token/paging code in
favor of `channels/adapters/ebay`. Partner feeds thereby become intake-port adapters (P3.1) —
dropship keeps owning wallet/quote/entitlement.

### P3.3 — Shipping engine port completion — **L**

1. WMS-owned `applyShipmentEvent(CanonicalShipmentEvent)` — extract from shipstation.service's
   3,033-line closure; the adapter's `normalizeWebhook` becomes real (currently a stub returning
   `[]`, `shipstation.adapter.ts:211-219`); the parallel `ShipmentEvent` type merges into
   `CanonicalShipmentEvent`.
2. `upsertShipment` becomes payload-driven (stops re-reading the DB via `ss.pushShipment`,
   `adapter.ts:118-124`); push guards/dedup live WMS-side so any engine inherits them.
3. Close the 10 port-bypass call sites; delete the sweeper's private SS client
   (`shipstation-sweeper.ts:150-167`); neutralize vendor vocabulary in durable state
   (`shipped_via_shipstation` events, `shipstation_*` retry topics, raw SS status words).
4. Decompose shipstation.service.ts into: vendor HTTP client / push adapter / webhook normalizer —
   everything else moves to WMS/OMS owners.
Success criterion: your own engine = implement the adapter interface + config. Nothing else.

### P3.4 — Legacy `shipstation_*` identity retirement — **M, High risk**

Backfill `engine_shipment_ref` to the real engine shipment id (today it stores the orderKey,
`shipstation.service.ts:3828`); remove dual-writes; remove the 8 COALESCE fallbacks; drop columns.
**⚖ DECISION D4 — define the soak exit criterion now** (it's been "post-soak" for months with no
gate). Proposal: 30 consecutive days where 100% of SHIP_NOTIFY resolutions matched on engine refs
without touching a legacy column (add a counter metric in P3.3), then drop.

### P3.5 — Push-after-pick gate — **M, HIGH workflow impact**

Today orders push to ShipStation at WMS-sync, pre-pick (`wms-sync.service.ts:612-629`) — the root
enabler of the ship-before-pick class (#658) and hold races.
**⚖ DECISION D2 — this changes warehouse workflow:** orders would appear in ShipStation only when
picked (or pick-complete). Impacts: label-purchase timing, your batch/wave habits, rate shopping
timing, and how ops sees the day's queue. Options:
- **A. Gate at pick-complete** (design intent, strongest correctness)
- **B. Gate at pick-start** (weaker, smaller workflow change)
- **C. Keep push-at-sync**, keep compensating fallbacks forever (status quo; the #658 fallback
  machinery stays)
Needs your call before design. If A/B: feature-flag per channel, pilot on low-volume first.

### P3.6 — Returns lifecycle — **L**

`wms.return_items` rows are written once (`oms-webhooks.ts:956-968`, `status='expected'`) and
never read again — returned goods never re-enter stock; refunds and restock are disconnected.
**⚖ DECISION D6 — scope:** (A) full receive-returns flow (scan → disposition → restock via
`inventoryCore` → close loop → optional refund trigger), or (B) minimal: reconcile expected
returns against refunds + manual restock UI. Recommendation: B now, A when volume justifies.

### P3.7 — Hold model unification — **M**

Three overlapping models (order `on_hold` int, item `on_hold` bool + shipment `held` flag,
priority=-1-as-hold) cleared by five paths. Target: one `holds` concept with holder, reason,
scope (order/line), released_by; picking + push + release all consult it; boot wipe already dead
(P0.2). **⚖ DECISION D7:** table-backed holds (auditable, my recommendation) vs keeping flags.

---

## Phase 4 — Platform hygiene

- **P4.1 Migration authority:** delete db.ts DDL that duplicates tracked migrations; single
  numbering series (renumber the 43 collisions); drizzle `tablesFilter` per the runbook; boot and
  release runner use the same env var. Fail-fast, no swallow-all.
- **P4.2 Logging:** adopt `server/platform/observability` everywhere (~1,600 console.* sites,
  mechanical/codemod-able); every log line carries `{oms_order_id, wms_order_id, shipment_id,
  channel_event_id, engine_ref}` per CLAUDE.md §10; DropshipLogger/AuditLogger fold in or wrap.
- **P4.3 Module layering:** normalize the 11 flat modules onto the `modules/wms` template
  (domain/application/infrastructure/interface) — do it opportunistically as P2.3 touches each.
- **P4.4 Subscriptions:** fix fake transactions (tx handles threaded to repositories),
  DB-generated PKs replacing `Date.now()`, tests — or **⚖ DECISION D8:** extract to shellz-club
  entirely (it's their domain; the dual-writer ambiguity with shellz webhooks argues for
  extraction).
- **P4.5 Small batch:** TLS verification on the four DB pools (`rejectUnauthorized: false`);
  idempotency middleware expiry (`middleware/idempotency.ts:37-43`); `oms_order_events` FK
  `onDelete: cascade` → `restrict`; fix the eBay listing-push PoolClient bug + don't stamp
  `synced` on failure; delete dead code (`migrate.ts`, `seed.ts`, `channel-adapter` dead paths,
  `scripts/fix_*` after P0.1d supersedes them).

---

## Decisions needed before/while building

| ID | Question | Options | My recommendation | Blocks |
|----|----------|---------|-------------------|--------|
| **D1** | Where do WMS order write-primitives live? | merge orders→wms / wms primitives + orders orchestration / status quo | wms primitives, orders orchestrates | P1.3, P2.3 |
| **D2** | Push to engine before or after pick? | pick-complete / pick-start / status quo | pick-complete, feature-flagged pilot | P3.5 |
| **D3** | Fate of diagnostics repair endpoints | guarded admin service / scripts only | guarded admin service + audit events | P2.2 |
| **D4** | Soak exit criterion for legacy SS columns | 30-day zero-legacy-hit metric / other | 30-day metric, added in P3.3 | P3.4 |
| **D5** | Dropship reservation semantics | A: reserve only at WMS sync / B: reserve at acceptance with handoff | A (simpler, one writer; acceptance keeps read-only ATP check) — B only if partners need a hard hold between acceptance and sync | P0.1a, P3.2 |
| **D6** | Returns scope | full receive flow / minimal reconcile | minimal now, full later | P3.6 |
| **D7** | Holds representation | holds table / status-quo flags | holds table | P3.7 |
| **D8** | Subscriptions module | repair in place / extract to shellz-club | extract | P4.4 |
| **D9** | Leak-repair cadence | one-time / recurring monitored | one-time + weekly read-only drift alert during soak | P0.1d |

## Sequencing & effort picture

- **Phase 0** is nine independent PRs — parallelizable, ~1-2 weeks of focused work, each shippable
  the day it's reviewed. Only P0.1a waits on D5.
- **Phase 1** is ~2-4 weeks; P1.1/P1.2/P1.4/P1.5 can start immediately after Phase 0 review begins.
- **Phase 2** is the long march (P2.3 spans weeks in the background) — but P2.1 (the ratchet) is
  small and should land **first**, freezing today's topology as the worst it will ever be.
- **Phase 3** items are independent of P2.3 and can interleave; P3.5 (push-after-pick) is the only
  one needing an operational decision + pilot.
- **Phase 4** is opportunistic filler between reviews.

Suggested first wave (after this discussion): **P2.1 (ratchet) + P0.2 + P0.5 + P0.7** (small, zero
decisions pending) while we settle **D5 and D2**, then the rest of Phase 0.
