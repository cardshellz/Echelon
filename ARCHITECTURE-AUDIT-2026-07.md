# Echelon Architecture Audit — July 2026

**Scope:** entire codebase (~152k LOC server-side, 16 modules, 211 tables, 976 write sites swept).
**Goal:** single source of truth for every state and action; plug-and-play seams for sales channels,
inbound dropship (partners routing orders TO Echelon), and a future in-house shipping engine;
modular-monolith target shape.
**Deliverable:** ranked findings + target ownership map + phased refactor roadmap. **No production
code was changed in this audit.**

**Method.** Twelve parallel subsystem audits (channel intake, OMS core, OMS→WMS sync, shipping
engine seam, WMS ops, inventory, procurement, dropship, writer-topology matrix, background jobs,
platform, prior-docs reconciliation), each producing a full evidence-cited report — committed under
`audits/2026-07-architecture/`. Every claim in this document carries a `file:line` citation from
those reports. Confidence labels: **[PROD-CONFIRMED]** = verified against production data during
this audit; **[CORROBORATED]** = independently found by ≥2 audit passes; **[CITED]** = single-pass
finding with exact citation, not independently re-verified.

---

## 1. Executive summary

The system's **foundations are better than its reputation with itself**: money is integer
cents/mills nearly everywhere, order ingestion is constraint-backed and transactional, the
inventory ledger core uses row locks and atomic increments, pushShipment idempotency is strong, and
dropship — the largest module — is architecturally sound at intake. Of ~95 previously documented
issues, ~55 are verifiably fixed.

The systemic defect is exactly what this audit was commissioned to find: **almost no piece of hot
state has a single writer.**

- **41 of 211 tables are multi-writer.** `wms.order_items` has **7 writing modules** (45 sites),
  `wms.outbound_shipments` **6 modules** (47 sites, 21 touching `status`), `inventory.inventory_levels`
  **6 modules**, `wms.orders` **5 modules** (48 sites), `oms.oms_orders` **5 modules**.
- **83 write sites live directly in route/controller files** (15 files) — including hard DELETEs of
  WMS orders (`server/routes/diagnostics.ts:73,130`) and raw INSERTs of `status='shipped'` shipments
  (`server/routes/shopify.routes.ts:412`).
- **`server/index.ts` is a shadow application layer**: ~850 lines of inline reconcilers holding 20
  raw UPDATEs on order/shipment state, explicitly forbidden by BOUNDARIES.md.
- **`server/db.ts` is a second, untracked schema-and-data authority** that mutates production data
  on every boot — including wiping all line-item holds (`db.ts:668`) and hard-deleting inventory
  level rows with no ledger entry (`db.ts:550`) — inside a swallow-all try/catch (`db.ts:1071-1073`).
- **19 recurring background loops** (12+ mutating financial state) with only 9 taking the advisory
  lock; two reconcilers compose to **resurrect cancelled orders as shipped** (§3, F6).

**Live proof.** During this audit a production incident (SKUs `EG-SLV-STD-5PCK-B500` /
`EG-SLV-STD-5PCK-C10000` stuck in Shopify) was root-caused to the exact defect class the audit had
already flagged: the dropship acceptance path raw-reserves inventory outside `reserveForOrder()`,
the WMS sync then reserves again, no release path exists for the first reservation, and the leaked
counter strangled the shared ATP pool — the ledger showed 15+ orphan `reserve` rows referencing
order_ids that do not exist in `wms.orders`. **[PROD-CONFIRMED]**

The cure is not a rewrite. The target modules already exist and one of them
(`server/modules/wms`, 799 LOC) is already the exemplar pattern — invariant-guarded, advisory-locked,
transactional write primitives. The roadmap (§5) converges every writer onto per-state chokepoints,
then locks the door with a CI ratchet so the topology can never silently regress.

---

## 2. Current-state writer topology

Full matrix (all 211 tables, every writing module, site-level citations):
`audits/2026-07-architecture/09-writer-matrix.md` + `matrix.json`.

### 2.1 Critical multi-writer tables (top of 41)

| Table | Modules writing | Sites | Worst offenders |
|---|---|---|---|
| `wms.order_items` | **7** | 45 | oms (17), orders (20), inventory, catalog, wms, index.ts, routes/ |
| `wms.outbound_shipments` | **6** | 47 | oms (16), orders (10), index.ts (11), db.ts (4), routes/ (2) |
| `inventory.inventory_levels` | **6** | 17 | inventory (12), channels, catalog (DELETE), dropship (raw), db.ts (DELETE), scripts |
| `wms.orders` | **5** | 48 | orders (36), oms (7), index.ts, routes/diagnostics (DELETE) |
| `oms.oms_orders` | **5** | 26 | oms (18), index.ts (4), orders (2), dropship (INSERT), db.ts |
| `oms.oms_order_events` | 4 | 39 | append-only upheld, but 4 writers incl. dropship + index.ts |
| `inventory.inventory_transactions` | 5 | 9 | channels + dropship + routes/ + scripts bypass inventory core |
| `inventory.inventory_lots` | 3 | 26 | procurement raw-revalues (`shipment-tracking.service.ts:1646`), db.ts backfills |
| `oms.order_item_costs` | 3 | 7 | COGS ledger rewritten in place from 3 modules |

### 2.2 Hot-column writer counts

- `wms.orders.warehouse_status`: **≥13 distinct mutation sites**, two functions each claiming to be
  the sole writer (`order-status-core.ts:177` — guarded CAS — vs `shipment-rollup.ts:843/876`),
  plus unguarded bypasses that can regress `shipped→ready` and reset picked qty **without restoring
  inventory** (`orders.storage.ts:939-955`), resurrect cancelled orders (`orders.storage.ts:1147-1171`),
  and raw OMS-side writes (`oms-webhooks.ts:1736`, `wms-sync.service.ts:806/1047`). [CORROBORATED]
- `wms.outbound_shipments.status`: **21 mutation sites**; terminal-state guards are read-then-write,
  not atomic (`shipment-rollup.ts:239→278, 371→425`) — the exact class behind the 606-shipment
  cancellation incident memorialized at `index.ts:1069-1076`. [CORROBORATED]
- `oms.oms_orders.status` / `financial_status`: 11+ writers across 3 modules + `index.ts`; only 3
  use guarded `UPDATE … WHERE status`. No state machine exists. [CITED]
- Reservation quantity (`inventory_levels.reserved_qty`): four writer families — inventory core
  (correct), channels reservation service (direct ledger insert `reservation.service.ts:509`,
  phantom `adjustLevel` call at `:504`), dropship acceptance (raw SQL
  `dropship-order-acceptance.repository.ts:866-891`), and scripts. [PROD-CONFIRMED]

---

## 3. Ranked findings

### P0 — active financial-loss mechanisms (fix first)

**F1. Reservation system has four writers and leaks stock. [PROD-CONFIRMED]**
Dropship acceptance raw-reserves (`dropship-order-acceptance.repository.ts:866`, ledger row with
order refs that don't resolve to `wms.orders`); WMS sync reserves the same demand again
(`wms-sync.service.ts:568-580`; dedup at `inventory.use-cases.ts:564-575` can't see the raw row);
**no release path exists** for the acceptance-time reservation. Confirmed live 2026-07-02: variant
207 carried 5 leaked reserved cases (50,000 base units) suppressing the entire product's Shopify
ATP. Compounding: `releaseOrderReservation` is non-idempotent and unscoped — releases
`min(item.qty, level.reservedQty)` from ANY level of the variant (`channels/reservation.service.ts:369-384`)
with three independent callers → double-release drains *other* orders' reservations (oversell);
reconciler cancels call status-only `cancelOrder()` with **no release at all** (`index.ts:914-916`,
`oms-flow-reconciliation.service.ts:1026`, `order-status-core.ts:214-229`); order-edit
release+re-reserve is a silent no-op leaving edited orders unreserved (`wms-sync.service.ts:1443-1447`).

**F2. Every deploy wipes all line-item holds. [CORROBORATED]**
`db.ts:668` (`SET held=false WHERE held=true`) runs in startup migrations on every boot
(`index.ts:417`) on a stale "no writer" assumption — but `line-item-hold.ts:64-70` writes it, and
the pushShipment refusal (`shipstation.service.ts:3473-3482`) is the only ship-blocker. Restart =
held lines become shippable. Same boot path hard-DELETEs `inventory.inventory_levels` rows with no
ledger entry (`db.ts:550`) and rewrites shipment statuses (`db.ts:639-657`).

**F3. Cancelled/refunded orders can be resurrected as shipped. [CORROBORATED]**
`cancelOrder` on the engine returns `alreadyInState: true` for both already-cancelled AND
already-shipped (`shipstation.service.ts:3210-3217`). The hourly reconcile reads that as
terminal→shipped and marks shipments of a cancelled OMS order `shipped` (`index.ts:948-955`); the
15-min `SHIPMENT_SHIPPED_OMS_OPEN` detector (predicate admits `cancelled`/`refunded`,
`oms-flow-reconciliation.service.ts:310-312`) then flips the cancelled OMS order to
`shipped/fulfilled` (`:1131-1149`) and queues channel tracking pushes. Runner-up in the same class:
unguarded cancel after a network call (`index.ts:957-960`).

**F4. SHIP_NOTIFY can still create WMS shipment rows (two paths). [CORROBORATED]**
Commit `1fa0d30` closed the V2 path only. The legacy path INSERTs a `shipped` row per notification
with `ON CONFLICT DO NOTHING` backed by **no unique constraint** (`shipstation.service.ts:2745-2750`
— replays create duplicate shipped rows that inflate fulfillment sums); the combined-shipment path
INSERTs synthetic `queued` children (`:1531-1544`). Both contradict the file's own "WMS is the sole
creator" invariant.

**F5. Refund handling: lost-update race + self-defeating retry. [CITED]**
`refund_amount_cents` computed read-modify-write in JS (`oms-webhooks.ts:2189→2260-2275`) — two
concurrent refunds silently lose one amount. The cancel handler writes `status='cancelled'`
(`:2004`) *before* the cascade (`:2014`); a cascade failure makes the retry early-return
("already cancelled", `:1994`) so reservations never release. Cumulative partial refunds never
reach `financial_status='refunded'` (`:2232-2234`).

**F6. eBay real-time intake is dead; late cancels have no path. [CITED]**
`/api/ebay/webhooks/order` sits behind session `requireAuth` → 401 for eBay (`index.ts:526-527`);
intake rides a 5-min poller with a 4-hour creation window (`ebay-order-ingestion.ts:35-37,235`) —
cancels/refunds >4h after order creation are never ingested. The handler also ACKs 200 on failure
with no retry enqueue (`:472-480`).

**F7. Shopify `orders/updated` can mark unpaid work paid/ready in WMS. [CITED]**
OMS webhook raw-writes `wms.orders` setting `financial_status = payload.financial_status || 'paid'`
and `warehouse_status pending→ready` (`oms-webhooks.ts:1725-1744`) — a payload merely *omitting*
the field releases work as paid. Also a direct BOUNDARIES.md violation (WMS-owned columns).

**F8. Inventory correctness cluster. [CITED, except where noted]**
(a) Break/assembly is not atomic — outer tx never passed to `adjustInventory`, each leg commits
separately; failed credit after committed decrement vanishes units
(`break-assembly.use-cases.ts:160-198,263-300` vs `inventory.use-cases.ts:477`).
(b) Phantom method: `inventoryCore.adjustLevel(...)` doesn't exist; wired `as any` → TypeError on
the orphan-reallocation path (`reservation.service.ts:504`, `services/index.ts:82-92`).
(c) `allowNegative: true` live at `inventory.use-cases.ts:1172` (absolute prohibition; currently
reachable only via a null-service route — still remove).
(d) Receipt double-post: 23505 catch returns without rollback, committing the duplicate level
increment (`inventory.use-cases.ts:174-178`; migration 0578's preflight shows it happened).
(e) Per-warehouse ATP ignores picked/packed (`atp.service.ts:167` vs `:130`, `:205`) — channel
pushes overstate availability by picked-not-shipped stock. **[PROD-CONFIRMED** during the SKU
incident: pushed quantities matched the buggy formula exactly**]**
(f) COGS cents/mills split-brain: 4 of 5 lot-recost paths update only `*_cents` while pick-time
COGS reads mills first (`cogs.service.ts:295-306,432-439,1000-1006,1153-1161` vs `lots.service.ts:387`).
(g) Lot↔level drift root cause: `convertSku`, transfers, CSV import, backfill mutate levels+ledger
but never lots; `transferLots` resets `receivedAt` corrupting FIFO.

**F9. Retry discipline inverts or never terminates. [CITED]**
Dead-letter is not terminal for `delayed_tracking_push`/`shopify_fulfillment_push` — re-seeders
dedupe only `status='pending'` → permanent failures loop forever in 5-attempt bursts
(`oms-flow-reconciliation.service.ts:460-467,694-708`). Reconcile V2 *inverts* classification: a
transient SS 429/timeout permanently quarantines a live shipment (`index.ts:1486-1494`).
Sync-recovery re-pushes `requires_review`/held shipments every 15 min with no guard
(`sync-recovery.service.ts:180-209`). Worker lacks `FOR UPDATE SKIP LOCKED` → two dynos
double-dispatch the same rows (`webhook-retry.worker.ts:1798-1807`); the correct pattern already
exists in-repo (`dropship-order-processing-runner.ts:76-113`).

### P1 — structural writer-control violations (the systemic fix)

- No OMS status state machine (11+ writers). Target: one guarded `transitionOmsOrderStatus()`.
- `warehouse_status` ≥13 writers / shipment `status` 21 sites with TOCTOU guards (§2.2).
- `index.ts` inline reconcilers raw-writing `oms_orders`/`outbound_shipments` (20 sites) —
  BOUNDARIES.md:169-171 explicitly forbids this.
- 83 route-layer write sites across 15 files (worst: `catalog.routes.ts` 22, `ebay/*` ~40,
  `diagnostics.ts` inline hard-deletes, `pick-priority.routes.ts` writing `membership.plans` —
  a shellz-owned schema).
- Cross-module raw writes: procurement revalues `inventory.inventory_lots` + rewrites
  `oms.order_item_costs` with swallowed failures (`shipment-tracking.service.ts:1645-1675`);
  channels backfill writes inventory + catalog directly (`catalog-backfill.service.ts:867-1019`);
  catalog DELETEs level rows unledgered (`catalog.storage.ts:237-238`); WMS writes
  `oms.oms_orders.status='shipped'` (`fulfillment.service.ts:522-532`).
- `as any` DI wiring lets consumers declare phantom interfaces (root mechanism of F8b and the
  historical C7 incident). One exported typed `InventoryCore` interface converts this bug class
  into compile errors.
- Three overlapping hold models (order int / item bool+`held` flag / priority=-1) cleared by five
  paths including the boot wipe (F2).

### P2 — seam gaps (blocking your growth plan)

**Shipping engine (own-engine readiness).** The port exists but "C9 complete" ≠ engine-agnostic:
`normalizeWebhook` is a stub returning `[]` (`shipstation.adapter.ts:211-219`); live SHIP_NOTIFY
normalization uses a second, parallel event type inside the vendor service; `upsertShipment`
ignores the canonical payload and re-reads the DB via `ss.pushShipment` (`adapter.ts:118-124`).
**44 non-test files reference ShipStation**; 10 unconditional call sites bypass the port
(`oms.routes.ts:300,353`; `sync-recovery.service.ts:199`; `oms-webhooks.ts:374-385,1419,2136,2323,2332`;
`wms-sync.service.ts:1711,1796`); 2 independent SS API clients exist (`shipstation-sweeper.ts:150-167`,
`scripts/test_mark_shipped.ts`); vendor vocabulary is baked into durable state
(`shipped_via_shipstation` events, `shipstation_*` retry topics, raw SS status words in
`EngineOrderState.status`). Legacy identity re-key (Phase 3) never done: `engine_shipment_ref`
stores the orderKey (`shipstation.service.ts:3828`), legacy columns carry 223 refs + 8 COALESCE
fallbacks, and the "post-soak" drop has no exit criterion.

**Channel intake (new channels + inbound dropship).** The canonical `ChannelOrder`/`receiveOrder`
adapter port is dead code (`channel-adapter.interface.ts:102,294`); production uses bespoke
mappers with zero runtime Zod validation; four different webhook durability contracts coexist
(inbox-then-ACK / inline no-inbox / inline+queue / ACK-then-`setImmediate`). A new channel costs
~400-600 lines of copied choreography today. Dropship's verdict is **keep-and-refactor, not
rewrite**: intake/wallet/quote staging is sound (integer cents + CHECK constraints, DB-level
double-submit protection, single-tx acceptance with row locks, HMAC persist-before-ACK webhooks,
69 test files); the rot is ~200 lines at the convergence point — raw INSERT into
`oms.oms_orders/lines/events` instead of `ingestOrder` (`dropship-order-acceptance.repository.ts:728,816,791`)
and the F1 raw reservation — plus direct `channels.channels` config writes and a replayable OAuth
state token (no nonce).

**Returns loop never closes.** `wms.return_items` rows are created `status='expected'`
(`oms-webhooks.ts:956-968`) and have zero readers/writers elsewhere — returned goods never
re-enter inventory or close the financial loop.

**Push-before-pick gate (state-machine Phase 4) never landed.** Orders still push to the engine at
WMS-sync pre-pick (`wms-sync.service.ts:612-629`); the #658 ship-before-pick fallback self-labels
"removable once pick-before-push is enforced" (`shipstation.service.ts:1592`).

### P3 — platform hygiene

- `db.ts` (1,077 lines): second migration authority, duplicates ~15 tracked migrations, contains
  DDL/DML with no migration counterpart, and has a swallow-all catch. Boot and release
  migrations now both use `DATABASE_URL`. Two interleaved migration
  numbering series with 43 numeric collisions, lexicographic ordering.
- Structured logger exists but is imported by one file; ~1,600 raw `console.*` across four logging
  systems. Correlation IDs are ad-hoc JSON.
- Module layering ~35% consistent; 11 of 16 modules flat; `modules/wms` is the template.
- Subscriptions: fake transactions (tx opened, repositories use global `db`), `Date.now()` PKs on
  billing rows, zero tests. Catalog: 4.3k LOC, zero tests, 8-table `cascadeSkuRename` with no tx.
- `rejectUnauthorized: false` on all four DB pools; idempotency middleware permanently 409s a
  crashed request (`middleware/idempotency.ts:37-43`); `oms_order_events` FK `onDelete: cascade`
  can purge audit history; eBay listing-push passes a pg `PoolClient` where drizzle is expected →
  `dbArg.insert is not a function` (`ebay-listings.routes.ts:329` → `ebay-sync-helpers.ts:34`) and
  stamps `synced` after failed eBay writes (`:604-615`).

---

## 4. Target architecture (modular monolith)

One deployable. Hard internal contracts. Each table has exactly **one owning module**; everyone
else calls the owner's published, typed interface. `modules/wms` is the proven in-repo template
for write primitives (invariant guards + advisory locks + transactions).

### 4.1 Ownership map (target)

| State | Owner (sole writer) | Everyone else uses |
|---|---|---|
| `oms.*` (orders, lines, events, costs) | `modules/oms` | `omsApi.ingestOrder / applyEdit / applyRefund / transitionStatus / recordShipmentOutcome` |
| `wms.orders`, `order_items` | `modules/wms` (absorb `modules/orders` order-state writes) | `wmsApi.syncOrder / cancelOrder / holdLine / recordPick` |
| `wms.outbound_shipments`, items | `modules/wms` shipment state machine | `wmsApi.createShipment / applyShipmentEvent(CanonicalShipmentEvent)` |
| `inventory.*` (levels, ledger, lots, reservations) | `modules/inventory` | `inventoryCore.*` + `reserveForOrder/releaseForOrder` (order-scoped, idempotent) |
| `catalog.*` | `modules/catalog` | `catalogApi.*` (channels backfill + eBay routes migrate) |
| `channels.*` (config, feeds, listings, sync log) | `modules/channels` | `channelsApi.*` (dropship config migrates) |
| `procurement.*` | `modules/procurement` | costs flow OUT via `inventoryCore.finalizeLotLandedCost` + `cogsService` |
| `dropship.*` | `modules/dropship` | intake converges via `omsApi.ingestOrder` (tx-composable) |
| `membership.*` | shellz-club app (external) | read-only here (runbook Phase 2+) |

### 4.2 Seams

- **Intake port:** one `ChannelOrderAdapter` registry (revive `channel-adapter.interface.ts`),
  Zod-validated `ChannelOrder` contract, one `ingestAndRoute()` use-case, one durability contract
  (inbox-persist-then-ACK) for *every* inbound event including SHIP_NOTIFY. Shopify, eBay, Amazon,
  and **each dropship partner feed** are then one adapter file each.
- **Shipping engine port:** WMS-owned `applyShipmentEvent` consuming `CanonicalShipmentEvent`;
  real `normalizeWebhook` in the adapter; payload-driven `upsertShipment`; engine-neutral
  vocabulary in durable state; identity via `engine_order_ref`/`engine_shipment_ref` only. Your
  own engine then = one new adapter + credential config.
- **State machines as chokepoints:** `transitionOmsOrderStatus`, `transitionWarehouseStatus`
  (exists — enforce), `transitionShipmentStatus` — all atomic guarded UPDATEs
  (`WHERE status IN (…)`) returning the discriminated outcome (no more `alreadyInState` ambiguity).
- **Job registry:** every background loop registers with mandatory advisory lock, re-entrancy
  guard, owned-state declaration, and terminal dead-letter semantics. One reconciliation authority
  per state pair.

### 4.3 The ratchet (harden **for all time**)

The writer matrix (`matrix.json`) becomes a **CI baseline**: a test re-runs the write-site scan and
fails if any table gains a writer outside its owner, any `*.routes.ts` gains a DB write, or a
`sql.raw`/cross-schema write appears outside the owning module. Plus dependency-cruiser rules for
module imports and a lint ban on `as any` service injection. Violations become build failures, not
audit findings — that is the permanent enforcement mechanism.

---

## 5. Roadmap

**Phase 0 — stop active loss (≈1-2 weeks, independent PRs).**
0.1 Reservation integrity: dropship acceptance → `reserveForOrder` (or stage + release on WMS-sync
handoff, one tx); order-scoped idempotent release (release only what the order's ledger holds);
release-on-cancel in both reconcilers; data repair script for orphan reserves + lot counters
(dry-run first — the 2026-07-02 manual release fixed variant 207 only).
0.2 Delete all DML from `db.ts` boot path (hold wipe, level DELETE, shipment rewrites, lot-cost
UPDATEs) → one-time tracked migrations.
0.3 Discriminate engine-cancel outcomes; exclude final orders from `SHIPMENT_SHIPPED_OMS_OPEN`;
status-guard every reconciler UPDATE (`index.ts:948-960,1263-1311`).
0.4 Close legacy + combined SHIP_NOTIFY inserts (same `requires_review` pattern as V2); add the
missing unique constraint behind the `ON CONFLICT`.
0.5 Refunds: atomic `SET refund_amount_cents = refund_amount_cents + X`; move cancelled-status
write after the cascade; cumulative refund derivation.
0.6 eBay webhook: un-auth + signature-verify + inbox/retry; poller window as backstop.
0.7 Kill `|| 'paid'` default; route the `orders/updated` WMS effects through the WMS interface.
0.8 Inventory cluster: tx-thread break/assembly; delete phantom `adjustLevel` path; remove
`allowNegative:true`; rethrow receipt 23505; fix `getAtpBaseByWarehouse` to subtract picked/packed;
mills-first recost writes.
0.9 Retry: terminal dead-letters; fix inverted classification in Reconcile V2; `FOR UPDATE SKIP
LOCKED` in the worker (copy the dropship runner pattern).

**Phase 1 — chokepoints (≈2-4 weeks).** The three state machines; typed `InventoryCore`/`WmsApi`/
`OmsApi` interfaces (kill `as any`); job registry + advisory locks everywhere; single durability
contract for webhooks; evict `index.ts` reconcilers into modules.

**Phase 2 — writer migration (≈4-8 weeks, mechanical, matrix-driven).** Move the 83 route writes
behind services; collapse each multi-writer table onto its owner per §4.1 (the matrix JSON is the
work list); land the **CI ratchet** the moment each table reaches single-writer, so it can never
regress.

**Phase 3 — seams (parallelizable with Phase 2).** Intake port + dropship convergence (~200-line
surgical fix, per the dropship report); shipping-engine port completion (normalizeWebhook,
payload-driven upsert, close the 10 bypasses, neutral vocabulary) → then define soak exit criteria
and drop legacy `shipstation_*` columns; push-after-pick gate; returns lifecycle.

**Phase 4 — platform hygiene.** Migration consolidation + `tablesFilter`; structured logger +
correlation context rollout; module layering normalization on the `modules/wms` template;
subscriptions/catalog test debt + fake-tx fix; TLS verification on DB pools; dead-code removal.

**Sequencing logic:** stop the bleeding → build the doors → walk writers through the doors → lock
the doors (ratchet) → make every future capability (channel N+1, dropship partner N+1, own engine)
a one-adapter bolt-on.

---

## 6. Prior-docs reconciliation (what this supersedes)

Of ~95 documented items: ~55 fixed, ~22 still open, ~12 partial (full ledger:
`audits/2026-07-architecture/12-docs-reconciliation.md`). The five most consequential still-open
items are folded into the roadmap: push-before-pick gate (Phase 3), legacy engine identity re-key +
column drop (Phase 3), returns reconcile (Phase 3), lot↔level drift remediation (Phase 0.8/2),
shortfall hold/backorder (Phase 1). Worst doc-vs-code contradiction: BOUNDARIES.md's "every
reservation goes through `reserveForOrder()`" vs the dropship raw reserve — now prod-confirmed.
`WMS_ARCHITECTURE.md` describes a wave/batch/tote flow that has never existed and should be
rewritten or retired; `FULFILLMENT_STATE_DESIGN.md` (cited by migration 103) is missing from the
repo.

---

## 7. Assumptions, risks, coverage (per CLAUDE.md §15)

**Assumptions (labeled):** line numbers reflect the working tree at commit `1fa0d30`; production
schema matches `shared/schema` + migrations (db.ts drift is itself a finding); [CITED] findings
were verified by one audit pass with exact citations but not adversarially re-verified — spot-check
before acting on any single [CITED] item; repo-root one-off scripts were out of scope but contain
production writes.

**Risks of the roadmap:** Phase 2 migrations touch live financial paths — each table migration
needs its own tests + a soak window; the CI ratchet must land *with* each migration or regressions
re-accumulate; several Phase 0 fixes change reconciler behavior that current operations may
implicitly depend on (e.g., loops that today "fix" states will stop — pair each with an alert).

**Coverage:** all 16 modules, platform, jobs, routes, schema, migrations, and 30+ design docs.
NOT covered: frontend (reviewed only as API consumer), repo-root scripts, production data beyond
the 2026-07-02 incident, `membership.*` internals (owned by shellz-club).

**Failure modes if roadmap is deferred:** reservation leaks keep accruing (oversell + suppressed
channel ATP); every deploy re-wipes holds; the next duplicate-SS-order or reconciler race
resurrects/regresses order state; own-engine build inherits 44-file vendor coupling and re-implements
~450 lines of push guards.
