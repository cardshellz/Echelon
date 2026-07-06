# Audit 10 — Background Jobs & Reconcilers

Scope: `server/index.ts`, `server/jobs/**`, all `*scheduler*`/`*sweeper*`/`*monitor*`/`*reconcil*`/`*retry*`/`*queue*` under `server/modules/`, `server/infrastructure/scheduler-*`, `server/modules/sync/sync-recovery.service.ts`.
Method: every claim cites file:line. Statements not grounded in read code are labeled HYPOTHESIS or UNKNOWN.

---

## 1. JOB INVENTORY

Re-entrancy legend:
- **PG-lock** = `withAdvisoryLock` (server/infrastructure/scheduler-lock.ts:27-60, `pg_try_advisory_lock`, skips if held) — safe across processes/dynos.
- **in-proc flag** = module-level boolean — safe only within one process.
- **NONE** = nothing; overlapping runs possible both same-process (if run > interval) and across dynos. Note `httpServer.listen({... reusePort: true})` (server/index.ts:743) explicitly permits multiple processes on one port, so multi-process operation is an anticipated deployment shape.

### Recurring loops (in the web process)

| # | Job | File:line (start) | Trigger | Writes | Guards | Re-entrancy |
|---|-----|-------------------|---------|--------|--------|-------------|
| 1 | Echelon sync scheduler | server/index.ts:301-412 | boot-immediate, then `sync_settings.sweepIntervalMinutes` (default 15 min, index.ts:394-405) | `channel_sync_log` via `syncSettings.writeSyncLog` (:344-356); inventory qty pushed to Shopify/eBay (external) | global kill switch `globalEnabled` (:313); per-channel `sync_enabled`/`sync_mode` | **NONE** — `setInterval(() => runSweep(), …)` at :405 has no in-flight flag |
| 2 | eBay listing reconciliation | server/index.ts:557-659 | +2 min, then 30 min (:652-656) | `channels.channel_listings` (via internal HTTP POST `/api/ebay/listings/reconcile`, :587) | count of synced listings > 0; INTERNAL_API_KEY present | **in-proc flag** `reconcileRunning` (:558, 561-563) |
| 3 | Sync Recovery orchestrator | server/index.ts:685-693; server/modules/sync/sync-recovery.service.ts:229-262 | +120 s, then 15 min | stage 1: `shopify_orders`/`shopify_order_items` (via #5's `runReconciliationNow`); stage 2: `oms.oms_orders` via bridge ingest (sync-recovery.service.ts:128-133); stage 3: `wms.orders` via `wmsSync.backfillUnsynced` (:153-156); stage 4: pushes `planned` shipments to ShipStation (:180-209) | stage-4 SELECT filters **only** `status='planned' AND engine_order_ref IS NULL` (:182-186) — no `requires_review`, no `held`, no cancelled-OMS, no age gate | **in-proc flag** `isRunning` (:38, 58-69) |
| 4 | Shopify order reconciliation (+ cancellation sweep) | server/modules/orders/shopify-order-reconciliation.ts:493-521 | +3 min, then 15 min | `shopify_orders`, `shopify_order_items` (:250-317, `ON CONFLICT DO NOTHING`); `echelon_settings` watermark (:340-347); OMS via `bridgeShopifyOrderToOms` (:422); `wmsSyncService.reconcileCancellations()` (:481-491, internals not read) | skips `cancelled_at` orders (:410-413); 5-min overlap window (:377) | **in-proc flag** `isRunning` (:114, 362-367) |
| 5 | Shopify bridge LISTEN/NOTIFY listener | server/modules/oms/shopify-bridge.ts:263-311 | event-driven (`LISTEN shopify_order_ingested`, :307) | `oms.oms_orders` via `omsService.ingestOrder` (:186); enqueues `oms_wms_sync` retry rows (:188-193 comment) | ingestOrder idempotent (per file header claims) | n/a (event) |
| 6 | Billing scheduler | server/modules/subscriptions/subscription.scheduler.ts:89-115 | +2 min, then hourly | billing attempts to Shopify (external, idempotency key `billing-{contract}-{date}`, :41); `insertBillingLog`; `setBillingInProgress` | contract GID present; billing-in-progress cleared on failure (:69) | **PG-lock** 54321 |
| 7 | Webhook retry worker (DLQ) | server/modules/oms/webhook-retry.worker.ts:143-156 | boot-immediate, then 60 s | `oms.webhook_retry_queue`, `oms.webhook_inbox` mirror (:1710-1739); via dispatch: WMS shipments (create/push), SS orders, Shopify/eBay fulfillments, OMS webhooks via HTTP loopback (:1963-1989) | per-topic dispatch; `keepPending` on missing service handles | **in-proc flag** `retryWorkerRunInFlight` (:117-123). **No advisory lock, no `FOR UPDATE SKIP LOCKED` claim** — plain `SELECT … WHERE status='pending' LIMIT 50` (:1798-1807); two dynos would double-dispatch the same rows |
| 8 | Fulfillment sweeper (outbound repush) | server/modules/oms/fulfillment-sweeper.scheduler.ts:149-178 | +5 s, then hourly | re-pushes channel fulfillments (Shopify :121-135, eBay ebay.reconciler.ts:46-79); enqueues retry rows | window: shipped 1 h–7 d ago (:33-35) | **PG-lock** 8484 |
| 9 | Inbound fulfillment sweep | server/modules/oms/fulfillment-sweeper.scheduler.ts:85-147, 167-187 | +15 s, then hourly (offset +30 min) | WMS shipments via `applyChannelFulfillment` → `dispatchShipmentEvent` + `recomputeOrderStatusFromShipments` (channel-fulfillment.service.ts:87, 99) | OMS not shipped/cancelled, WMS not shipped/cancelled, ≤14 d (:98-100) | **PG-lock** 8485 |
| 10 | Cycle-count freeze guard | server/modules/inventory/cycle-count-freeze-guard.scheduler.ts:80-99 | +20 s, then 6 h | `inventory.cycle_counts` → completed; `warehouse_locations.cycle_count_freeze_id = NULL` (:60-70) | `in_progress` older than 3 d (configurable) | **PG-lock** 90210 |
| 11 | OMS flow reconciliation | server/modules/oms/oms-flow-reconciliation.service.ts:1193-1213 | +20 s, then 15 min | `wms.orders` (cancel/ship via order-status-core + raw `assigned_picker_id = NULL`, :1026-1031); **`oms.oms_orders` direct** (WMS_FINAL_OMS_OPEN :1069-1100, SHIPMENT_SHIPPED_OMS_OPEN :1131-1149); `oms_order_events`; enqueues 4 retry topics (:673-774) | detection queries with 10-min staleness gates; remediation limited to 10 samples/code/run (:26, 650) | **PG-lock** 918405 |
| 12 | OMS ops alert scheduler | server/modules/oms/oms-ops-alert.service.ts:144-164 | +45 s, then 5 min | none (Discord webhook only) | 30-min cooldown per signature | **PG-lock** 918406 |
| 13 | Dropship listing push worker | dropship-listing-push-job-runner.ts:113-152 | +5 s, then 10 s | `dropship.dropship_listing_push_jobs` + eBay listings | claimable = queued or stale-processing (:31-40); idempotency key per job (:158) | **PG-lock** 736204 |
| 14 | Dropship order processing worker | dropship-order-processing-runner.ts:249-299 | +5 s, then 10 s | `dropship.dropship_order_intake` (claims via `FOR UPDATE SKIP LOCKED`, :76-93), audit events, payment-hold expiry, cancellations | idempotency key per intake (:305) | **PG-lock** 736205 + row claim — best-in-repo pattern |
| 15 | Dropship eBay order intake worker | dropship-ebay-order-intake-runner.ts:29-74 | +5 s, then 5 min | dropship intake rows (poll vendor stores) | 4 h lookback / 15 min overlap | **PG-lock** 736206 |
| 16 | eBay order polling | server/modules/oms/ebay-order-ingestion.ts:192-214 | +30 s, then 5 min ("NON-NEGOTIABLE", :36) | `oms.oms_orders` via `ingestOrder` (idempotent per header); WMS via `syncOmsOrderToWms`; enqueues `oms_wms_sync` retries (:48, 60) | 4 h window (:37) | **NONE** (no lock, no flag) — safe only because ingest is idempotent |
| 17 | eBay fulfillment reconcile (stuck orders) | server/index.ts:815-894 | +5 s, then hourly (:890-891) | **`oms.oms_orders` direct raw UPDATE** `status='shipped', tracking…` (:856-863); tracking push via `fulfillmentPush.pushTracking` (:869); enqueues delayed-tracking retries (:250-257) | SELECT: channel 67, `status='confirmed'`, >2 h old, LIMIT 50 (:833-837); engine says shipped (:855) | **NONE** |
| 18 | OMS↔WMS reconcile | server/index.ts:899-981 | +15 s, then hourly (:977-978) | `wms.orders` via `markOrderShipped`/`cancelOrder` (:914-916) + raw `assigned_picker_id=NULL` (:918); engine cancel (:947); **raw `wms.outbound_shipments.status`** = 'shipped' (:949-955) or 'cancelled' (:957-960) | divergence WHERE: `oms.status IN ('cancelled','shipped','refunded') AND w.warehouse_status IN ('ready','in_progress','ready_to_ship','completed')` (:909-910); shipment cascade excludes shipped/`shipped_at IS NOT NULL` at SELECT time (:938-939) | **NONE** |
| 19 | ShipStation reconcile V1/V2 + engine queue sweeper | server/index.ts:1171-1592 | +30 s, then 10 min (:1588-1589) | V2: `wms.outbound_shipments` (status/requires_review/last_reconciled_at), engine markShipped/cancel (:1253, 1272), `dispatchShipmentEvent` + rollup (:1342-1354), **`oms.oms_orders` direct** (:1371-1380, 1423-1428), `oms.oms_order_lines` (:1381-1411), `oms_order_events`; enqueues tracking pushes (:1418). V1 (default when `RECONCILE_V2 !== "true"`, :1577): engine markShipped/cancel + `oms_orders.shipstation_reconciled_at` (:1559-1561). Sweeper (shipstation-sweeper.ts:150-344, only under V2 :1580-1582): `outbound_shipments.requires_review` (:86-93), `oms_order_events` review flags | V2 candidate WHERE :1196-1203 (engine ref present, status in queued/labeled/shipped, `last_reconciled_at` older than 1 h); "cancel is WMS-owned" review gate (:1242-1244) | **NONE** — 100 rows × ≥1 s rate-limit sleep (:1475) + 2 engine calls/row can approach or exceed the 10-min interval |
| 20 | WebSocket ping | server/websocket.ts:95 | interval | none (transport) | — | n/a |

### Boot one-shots (run on EVERY boot)

| # | Job | File:line | Writes |
|---|-----|-----------|--------|
| 21 | "One-time" data repair | server/index.ts:987-1060 (+12 s) | `wms.order_items` → completed + `fulfilled_quantity=quantity` + `picked_quantity=GREATEST(...)` (:989-998); cancel orphan planned/queued shipments (:1003-1013); zombie orders → `cancelOrder`/`completeOrder` (:1044-1052) |
| 22 | Duplicate shipment cleanup | server/index.ts:1077-1136 (+15 s) | gated OFF (`ENABLE_DUP_SHIPMENT_CLEANUP`, :1078). Header documents the incident: it previously **cancelled 606 already-shipped shipments** (:1069-1076) |
| 23 | Sort-rank recompute | server/index.ts:1140-1158 (+20 s) | `wms.orders.sort_rank` for ALL active orders + enqueues one `shipstation_sort_rank_sync` retry row per active order (:1146-1151) — repeats on every deploy/restart |
| 24 | Negative inventory check | server/index.ts:721-728 | read-only warning |
| 25 | SS webhook registration | server/index.ts:662-680 (+15 s) | external only (idempotent per comment) |

### Out-of-process (Heroku Scheduler one-off dynos)

| # | Job | File:line | Writes |
|---|-----|-----------|--------|
| 26 | Auto-draft PO job | server/jobs/run-auto-draft.ts:1-19 (daily 02:00 UTC); server/jobs/auto-draft.job.ts:41+ | draft `purchase_orders`, auto-draft run records |
| 27 | Procurement health escalation | server/jobs/run-procurement-health-escalation.ts; job at server/jobs/procurement-health-escalation.job.ts:44+ | escalation alerts (dedupe hours param) |

### Defined but not started
- `ScheduledSyncService` (server/modules/channels/scheduled-sync.service.ts:57-131) — factory exists (:253-257), default `enabled:false, dryRun:true` (:47-51); no boot call site found outside tests. Dormant duplicate of job #1.

**Totals: 19 recurring in-process loops (≥12 of which mutate financial state), 3 mutating boot one-shots, 2 external cron jobs. 9 loops hold PG advisory locks; the 5 heaviest OMS/WMS/engine reconcilers (#1, #17, #18, #19, plus boot repairs) have NO cross-process protection and #17/#18/#19 have no same-process protection either.**

---

## 2. OVERLAP ANALYSIS (writers per hot state, with concrete interleavings)

### 2.1 `oms.oms_orders.status` — SIX writers, three of them reconcilers writing raw SQL
Writers:
1. OMS webhook handlers (`registerOmsWebhooks`, server/index.ts:476-480 — internals out of scope, but they are the boundary-sanctioned writer per BOUNDARIES.md:168-170).
2. eBay fulfillment reconcile — raw `UPDATE oms.oms_orders SET status='shipped' … WHERE id=${order.id}` (server/index.ts:856-863). **No status guard in the UPDATE**; the `status='confirmed'` filter is only in the SELECT (:835), so a cancel processed between SELECT and UPDATE is overwritten (hours-stale candidate set, ≤50 rows, 500 ms sleep each — a real window).
3. ShipStation Reconcile V2 — raw UPDATE to shipped/partially_shipped (:1371-1380) and cancelled (:1423-1428).
4. OMS flow reconciliation — `WMS_FINAL_OMS_OPEN` raw UPDATE (oms-flow-reconciliation.service.ts:1069-1100) and `SHIPMENT_SHIPPED_OMS_OPEN` raw UPDATE (:1131-1149).
5. SHIP_NOTIFY webhook path (`updateOmsDerivedFromEvent` in shipstation.service.ts, mirrored per comment at server/index.ts:1360-1361).
6. Bridge/poll ingest (creates/updates via `ingestOrder`).

All of 2–4 violate BOUNDARIES.md:169-170 ("WMS/reconcilers never write `oms_orders` directly").

**Concrete fight A (CRITICAL — cancelled order resurrected as shipped by two loops):**
- `ShipStationService.cancelOrder` returns `{alreadyInState: true}` for **both** "already cancelled" (shipstation.service.ts:3210-3213) **and** "already shipped" (:3214-3217).
- Hourly OMS↔WMS reconcile, cancel cascade: for a cancelled OMS order it calls `engine.cancel(ref)` and on `alreadyInState` runs `UPDATE wms.outbound_shipments SET status='shipped' … WHERE id=… AND status NOT IN ('shipped','returned','lost')` (server/index.ts:948-955). If the SS order was **already cancelled** engine-side (ops cancelled it in the SS UI, or a previous sweep/dyno cancelled it), the WMS shipment is recorded **shipped** — with `shipped_at` still NULL and no tracking.
- 15-min OMS flow reconciliation then detects `SHIPMENT_SHIPPED_OMS_OPEN`: `os.status='shipped' AND oo.status NOT IN ('shipped','partially_shipped')` (oms-flow-reconciliation.service.ts:310-312) — `'cancelled'` **and** `'refunded'` both satisfy that NOT IN — and auto-remediates by `UPDATE oms.oms_orders SET status='shipped', fulfillment_status='fulfilled' …` (:1131-1149, driven by :624-632, :650-659).
- Net: loop 18 mislabels a shipment shipped; loop 11 then flips a **cancelled/refunded** order to **shipped/fulfilled**, and the `WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED` bucket (:331-377) will start queueing channel tracking pushes for it. This is exactly "A sets X, B reverts X" — the customer cancel is undone by the reconciler pair. The same two-way ambiguity exists in `markAsShipped` (returns `alreadyInState:true` when the SS order is *cancelled*, shipstation.service.ts:3155-3157).

**Concrete fight B (refunded → shipped overwrite):** `SHIPMENT_SHIPPED_OMS_OPEN` remediation overwrites `status='refunded'` with `'shipped'` whenever a shipment legitimately shipped (refund-after-ship). The WHERE (:1147) only excludes shipped/partially_shipped. A refund recorded by the OMS webhook is reverted by the 15-min loop; if anything re-stamps `refunded`, the loop flips it again — ping-pong with an `oms_order_events` row inserted per flip (:1153-1161).

### 2.2 `wms.orders.warehouse_status` — two modules both claiming sole-writer
- order-status-core.ts:2-6: "the sole guarded writer of warehouse_status".
- shipment-rollup.ts:5-8: "The only writer of `wms.orders.warehouse_status` (post-C16) is `recomputeOrderStatusFromShipments`".
Both claims coexist; actual writers: rollup recompute (SHIP_NOTIFY, Reconcile V2 :1351-1354, inbound sweep), OMS↔WMS reconcile (:915-916), OMS flow reconciliation (:1026-1027), zombie boot repair (:1046-1048). Mitigation: all funnel through the guarded transition matrix (order-status-core.ts:143-209), whose WHERE-clause optimistic lock makes concurrent duplicates converge; terminal states can't be exited (except cancelled→shipped "truth wins", :66-71). So this is duplicated authority, not active reversion — **except** that both #11 and #18 correct the *same* divergence class with different WHERE clauses (index.ts:909-910 includes `'completed'`; oms-flow :146-150 includes `'picking','packed'` + a 10-min age gate + `financial_status='refunded'`), i.e., two reconciliation authorities with drifting semantics for one state.

### 2.3 `wms.outbound_shipments.status` — rollup invariant broken by three raw writers
shipment-rollup.ts:4-6 declares the `markShipment*` helpers the only writers. Raw UPDATE writers found:
- OMS↔WMS reconcile: :949-955 (→shipped) and :957-960 (→cancelled). The →cancelled UPDATE is **unconditional** (`WHERE id = ${row.shipment_id}` only). TOCTOU: SELECT (:931-940) excludes shipped rows, then a network call to `engine.cancel` (:947) sits between SELECT and UPDATE; if SHIP_NOTIFY marks the shipment shipped in that window and the engine cancel raced ahead of SS's own state, the UPDATE clobbers `shipped` → `cancelled` — the exact bug class of the disabled dup-cleanup incident (:1069-1076).
- Reconcile V2 outbound: :1274-1279 (→shipped, guarded `NOT IN ('shipped','returned','lost')` — deliberately allows overwriting `cancelled`, "truth wins").
- Boot data repair: :1003-1013 (planned/queued → cancelled; guarded by `shipped_at IS NULL`).
- SS sweeper flags `requires_review` unconditionally by parsed shipment id (shipstation-sweeper.ts:86-93).

### 2.4 `requires_review` (dead-letter surface) — set by four writers, cleared by one
Set: Reconcile V2 review event (index.ts:1310-1318); Reconcile V2 **generic error path** (:1487-1494); SS sweeper (shipstation-sweeper.ts:86-93, 224-228); permanent push failure (webhook-retry.worker.ts:1659-1671). Cleared: SHIP_NOTIFY auto-clear for reason `inventory_deduction_missing_item_data` (shipstation.service.ts:1666-1670) — the permanent-push writer explicitly defends against this collision by overwriting that reason (webhook-retry.worker.ts:1653-1667). Fight: the V2 error path classifies **any non-DB-connection error** (SS 429, 5xx, fetch timeout) as review-worthy — its transient allowlist regex (:1486) covers only Postgres connection strings. A transient engine blip flags the shipment, which then (a) blocks `pushShipment` (shipstation.service.ts:3462-3472) and (b) blocks re-enqueue (webhook-retry.worker.ts:491-500) until a human clears it. Transient error → permanent quarantine: inverted classification.

### 2.5 Engine-side state (ShipStation order) — commanded by 5 paths
`pushShipment`/`upsertShipment`: event-driven wms-sync paths, retry worker (webhook-retry.worker.ts:1018-1023), sync-recovery stage 4 (sync-recovery.service.ts:197-209). `cancel`: OMS↔WMS reconcile (:947), Reconcile V2 (:1272), webhooks. `markShipped`: Reconcile V1 (:1544-1549) and V2 (:1253-1259). BOUNDARIES.md:160 says the engine "owns no truth", so idempotent re-commands are tolerable; the danger is fight A's misread of `cancel`'s return value, and V1 (the **default** path, :1577) marking SS shipped from `wms.orders.warehouse_status` while V2 logic reasons per-shipment — switching the flag changes which authority wrote engine state.

### 2.6 Channel fulfillment/tracking pushes — four re-pushers
(1) SHIP_NOTIFY hot path; (2) `delayed_tracking_push`/`shopify_fulfillment_push` queue rows (worker); (3) fulfillment sweeper direct repush (fulfillment-sweeper.scheduler.ts:59-67); (4) eBay fulfillment reconcile direct push (index.ts:869). Dedupe exists only among *pending queue rows* (`hasPendingRetryForScope`, webhook-retry.worker.ts:605-627); the two direct pushers bypass the queue. Mitigated by service-level idempotency: `pushShopifyFulfillment` returns `alreadyPushed` from the stored `shopify_fulfillment_id` (fulfillment-push.service.ts:854-875) and eBay push logs "already pushed … idempotent skip" (:714). Residual race: two dynos pushing the same shipment before the id is stamped (no advisory lock on #7/#8's direct path — #8 is locked, #7 is not cross-dyno).

### 2.7 Inventory / reservations
No background loop writes `inventory_levels` directly (grep across the audited files) — deductions flow through `dispatchShipmentEvent`/rollup. The boot item-fix (index.ts:989-998) does write `wms.order_items.picked_quantity`/`fulfilled_quantity` directly, falsifying pick history (see §4). Reservation release on reconciler-driven cancels was **not observed** in `cancelOrder` (order-status-core.ts:214-229 writes only status columns) — whether unreserve happens elsewhere on this path is UNKNOWN (flagged).

---

## 3. RETRY DISCIPLINE

**Queue:** `oms.webhook_retry_queue`, single worker (#7), 60 s poll, batch 50 (webhook-retry.worker.ts:1798-1807). Backoff `2^attempts` minutes, `MAX_ATTEMPTS=5`, then `status='dead'` + inbox mirror + `CRITICAL:` log line (:1562-1607). Manual requeue endpoint exists (`requeueDeadWebhookRetry`, :701-743). Pending-scope dedupe via `hasPendingRetryForScope` + partial unique indexes (`uq_webhook_retry_pending_*`, :13, 643-659).

**Permanent-error classification — exists for exactly one topic.** `SS_PUSH_INVALID_SHIPMENT` → immediate dead-letter + `requires_review` flag, comment explicitly citing CLAUDE.md §6 (webhook-retry.worker.ts:1033-1039, 1631-1674), and the enqueue chokepoint refuses flagged shipments (:482-500). Malformed payloads also dead immediately (e.g., :993-1001). Everything else — including deterministic 4xx from Shopify/eBay — is treated as transient for 5 attempts.

**The dead-letter is not terminal (re-seed loop).** All reconciler auto-queuers and `enqueue*` helpers dedupe only against `status='pending'`:
- `autoQueueStaleTrackingPushRetries` checks `status='pending'` (oms-flow-reconciliation.service.ts:694-708);
- `SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED` detection embeds `q.status='pending'` in its NOT EXISTS (:460-467);
- `hasPendingRetryForScope` filters `status='pending'` (webhook-retry.worker.ts:620-623).
Once a row dies after 5 attempts, the triggering condition (`no tracking_pushed event` / `shopify_fulfillment_id IS NULL`) still holds, so the 15-min reconciler inserts a **fresh** pending row: 5 attempts → dead → 15 min → 5 attempts → dead → … For `delayed_tracking_push` and `shopify_fulfillment_push` there is no `requires_review`-style circuit breaker, so a permanently failing push retries forever in 5-attempt bursts, emitting a `CRITICAL:` dead-letter alert every cycle. Only `shipstation_shipment_push` closes this loop (the comment at :482-489 documents precisely this hazard for its own topic).

**Sync-recovery stage 4 retries permanent failures forever.** Its SELECT (sync-recovery.service.ts:182-186) has no `requires_review`/`held` filter; `pushShipment` deterministically throws on flagged/held shipments (shipstation.service.ts:3462-3482), the catch logs and continues (:201-204), and the same ids are re-selected every 15 min indefinitely. Violates "never retry a permanent error"; also duplicates the properly-guarded remediation query in oms-flow-reconciliation.service.ts:921-958 (which does exclude `requires_review`/`held`).

**Worker concurrency:** no advisory lock and no row claiming (contrast dropship's `FOR UPDATE SKIP LOCKED`, dropship-order-processing-runner.ts:76-93). Two dynos both select the same 50 pending rows and double-dispatch (double `markasshipped`, double loopback webhook POSTs). The in-process `retryWorkerRunInFlight` flag (:117-123) only protects one process.

**Good patterns worth copying:** dropship workers (lock + SKIP LOCKED claim + idempotency key + stale-claim recovery with audit event, dropship-order-processing-runner.ts:66-113); the `SS_PUSH_INVALID_SHIPMENT` permanent path; heartbeat surfaces for worker and reconciler (webhook-retry.worker.ts:81-99; oms-flow-reconciliation.service.ts:32-46).

---

## 4. STARTUP REPAIR SCRIPTS (every boot)

1. **Item fix (index.ts:989-1002).** Sets `status='completed'`, `fulfilled_quantity = quantity`, `picked_quantity = GREATEST(picked_quantity, quantity)` for non-terminal items on orders whose `warehouse_status IN ('shipped','cancelled')`. Misfire on healthy data: for a **cancelled** order whose items were left `pending`, this stamps them *completed and fully fulfilled* — falsified fulfillment/pick history on cancelled orders (audit-trail violation: quantities recorded that were never picked). Original bug it patched ("wms_order_id column-name bug in SHIP_NOTIFY legacy paths", :983-985) is presumably fixed; the sweep still rewrites rows on every boot with no age bound and no audit event.
2. **Orphan shipment cancel (index.ts:1003-1017).** planned/queued shipments on shipped/cancelled orders → cancelled; guarded by `shipped_at IS NULL`. Reasonable, but unconditional-per-boot and races the pick flow at deploy time (an order legitimately transitions around boot; guards make this converge).
3. **Zombie sweep (index.ts:1021-1056).** Orders in ready/in_progress/partially_shipped/ready_to_ship with no pending shippable items → `completeOrder`, or `cancelOrder` if zero items exist. Misfire mode: an order whose items row(s) are created in a separate transaction/moment from the order row would be cancelled at the wrong instant. Whether order+items are atomic in `wmsSync` is UNKNOWN — CLAUDE.md §8 requires it, but I did not verify `syncOmsOrderToWms`.
4. **Dup-shipment cleanup (index.ts:1077-1136).** Correctly gated off; its header is the repo's own post-mortem for why destructive boot sweeps are dangerous (cancelled 606 shipped shipments; "A shipped shipment is TERMINAL"). Should be deleted, not gated.
5. **Sort-rank recompute (index.ts:1140-1158).** Rewrites `sort_rank` for every active order and enqueues one SS sync retry row per order on **every deploy**. Heroku restarts at least daily → daily full-fleet SS customField sync churn. Belongs behind a version/watermark check.
6. **Negative inventory check (index.ts:721-728).** Read-only; fine (P1-18 already extracted to `scripts/backfill/fix-dangling-order-items.ts`, :726 — the pattern to follow for the rest).

---

## 5. CORRECTNESS RISKS (ranked by financial impact)

- **CRITICAL-1 — `alreadyInState` ambiguity converts cancelled orders into shipped ones across two loops.** shipstation.service.ts:3210-3217 (cancel returns `alreadyInState:true` for already-*cancelled* too) + server/index.ts:948-955 (records `shipped`) + oms-flow-reconciliation.service.ts:310-312/1131-1149 (flips the cancelled/refunded OMS order to shipped/fulfilled). False revenue state; tracking pushes for cancelled orders; refund status destroyed.
- **CRITICAL-2 — No cross-process protection on the five heaviest reconcilers** (#1, #17, #18, #19 + boot repairs) and no row-claiming in the retry worker (webhook-retry.worker.ts:1798-1807) while `reusePort:true` (index.ts:743) anticipates multi-process. Concurrent sweeps double-cancel engine orders, double-dispatch retry rows, and interleave the §2.3 TOCTOU.
- **HIGH-3 — Dead-letter re-seed loop:** permanent channel-push failures retry forever in 5-attempt bursts (§3), spamming CRITICAL alerts (alert fatigue = missed real incidents) and hammering channel APIs. `shipstation_shipment_push` proves the fix pattern; the other two topics lack it.
- **HIGH-4 — Reconcile V2 transient/permanent inversion** (index.ts:1486-1494): only DB-connection errors are "transient"; any SS API hiccup permanently quarantines a live shipment (`requires_review=true`) that then requires a human to un-flag before it can ship.
- **HIGH-5 — Unconditional shipment-cancel UPDATE TOCTOU** (index.ts:957-960): can overwrite `shipped` → `cancelled` if SHIP_NOTIFY lands between SELECT and UPDATE; identical failure class to the 606-shipment incident the repo already suffered (:1069-1076).
- **HIGH-6 — Boot item-fix falsifies fulfillment on cancelled orders** (index.ts:989-1002): `fulfilled_quantity=quantity` on never-picked items; immutable-history principle (CLAUDE.md §10) violated silently on every boot.
- **MEDIUM-7 — Refunded→shipped overwrite** by `SHIPMENT_SHIPPED_OMS_OPEN` (oms-flow-reconciliation.service.ts:1147): legitimate for confirmed orders, destructive for refunded ones; needs `'refunded'` in the exclusion list or a refund-aware branch.
- **MEDIUM-8 — Two OMS↔WMS divergence authorities** (index.ts:899-981 hourly, unlocked vs oms-flow-reconciliation 15-min, locked) with drifting WHERE clauses; plus three reconcilers writing `oms_orders` raw in violation of BOUNDARIES.md:169-170.
- **MEDIUM-9 — Sync-recovery stage 4** (sync-recovery.service.ts:180-209): unguarded push loop; permanent-failure churn every 15 min; duplicates a guarded query that already exists.
- **MEDIUM-10 — Echelon sync scheduler has no single-flight** (index.ts:405): overlapping full-channel inventory sweeps can interleave read-compute-push cycles.
- **LOW-11 — eBay reconcile stale write** (index.ts:856-863, no status guard in UPDATE); **LOW-12 — sort-rank boot churn** (index.ts:1140-1158); **LOW-13 —** V1 reconcile still default (`RECONCILE_V2` flag, index.ts:1577) so the documented-better V2 + engine sweeper may not even be running.

---

## 6. REFACTOR RECOMMENDATIONS

1. **One reconciliation authority per state pair.** Fold index.ts's inline `runOmsWmsReconcile`, `runEbayReconcile`, and Reconcile V1/V2 into the advisory-locked `oms-flow-reconciliation` (or a sibling module), each divergence class owned by exactly one code path with one WHERE clause. index.ts should contain zero business SQL.
2. **Fix the `cancel` contract:** return a discriminated state (`{ state: 'cancelled' | 'already_cancelled' | 'already_shipped' | 'not_found' }`) instead of `alreadyInState: boolean`; only `already_shipped` may record `shipped`. Same for `markAsShipped`.
3. **Job registry:** a single `registerJob({name, intervalMs, lockId, disableEnv, run})` wrapper providing PG advisory lock, heartbeat, single-flight, structured run logs. Nine jobs already ad-hoc-implement pieces of this; #17/#18/#19 have none.
4. **Queue claiming:** adopt dropship's `FOR UPDATE SKIP LOCKED` + idempotency-key pattern (dropship-order-processing-runner.ts:76-113) for `webhook_retry_queue`.
5. **Terminal dead-letters:** reconciler auto-queuers must skip scopes with a `dead` row (or set a per-entity `requires_review`-style flag, as `shipstation_shipment_push` does) so `permanent → requires_review + STOP` holds for every topic.
6. **Shared error classifier** (`classifyError(err): transient|permanent|fatal`) replacing the one-off regex at index.ts:1486 and per-branch ad-hoc checks.
7. **Move boot repairs to `scripts/backfill/`** (precedent: index.ts:726) with run-once watermarks; delete the gated dup-cleanup entirely.
8. **Route all reconciler OMS writes through an OMS interface** (BOUNDARIES.md:168-171): `oms.markShippedFromWms(...)`, `oms.recordEngineShipment(...)` — no raw `UPDATE oms.oms_orders` outside the OMS module.
9. Guard sync-recovery stage 4 with the exact predicate set already written at oms-flow-reconciliation.service.ts:927-937 (`requires_review=false AND held=false AND age>15min AND OMS not final`) — or delete the stage in favor of the queue path.

## 7. UNKNOWNS / NOT VERIFIED

- `wmsSync.reconcileCancellations()` and `syncOmsOrderToWms()` internals (writes, transactionality of order+items insert) — not read; affects zombie-sweep risk (§4.3).
- Whether reservation release (`reserved_qty`) occurs on reconciler-driven cancels — `cancelOrder` itself doesn't (order-status-core.ts:214-229); the cascade may live in webhook handlers (out of scope here). If absent, reconciler cancels leak reservations.
- Production dyno count / whether multiple web processes actually run (severity multiplier for lock gaps); `RECONCILE_V2` and `DISABLE_SCHEDULERS` values in production config.
- Dropship `processIntake` attempt cap for `retrying` rows (dropship-order-processing-runner.ts:120-131 shows no cap in the claim query).
- `services.echelonOrchestrator.runFullSync` internals (job #1's actual write surface beyond sync_log).
- Exact writes of OMS webhook handlers (`oms-webhooks.ts`) — cited only as the sanctioned writer; a webhook-vs-reconciler interleaving audit of that file is a separate scope.
- `getOmsOpsHealth` (ops-health.service.ts) assumed read-only from its alert-only consumer; not read line-by-line.
