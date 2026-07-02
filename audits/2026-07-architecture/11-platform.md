# Audit 11 — Platform Layer & Small Modules (Echelon)

Auditor scope: `server/db.ts`, `migrations/`, route-registration layer, `server/middleware`, `server/storage`, `server/services`, `server/platform`, `server/infrastructure`, `server/instrumentation`, `server/websocket.ts`, small modules (catalog, identity, integrations, notifications, subscriptions, sync, shopify, wms), module-architecture consistency, logging.
Method: direct file reads + two delegated deep scans (small modules; route-layer writes). All claims carry file:line evidence per CLAUDE.md §1. Items that could not be verified are marked **INSUFFICIENT EVIDENCE** or **HYPOTHESIS**.

---

## 1. PLATFORM MAP

```
server/
  index.ts            1,593 LOC  Bootstrap + composition + ~10 inline schedulers/reconcilers + inline webhook route + boot-time data repair (see §3, §6)
  db.ts               1,077 LOC  Pool + drizzle + runStartupMigrations() — untracked DDL/DML on every boot (§2)
  routes.ts             116 LOC  Pure route-registration manifest (clean) + 3 seed calls at registration time
  websocket.ts          145 LOC  ws server, session-authenticated upgrade, user fan-out (clean, console.* logging)
  migrate.ts             40 LOC  DEAD legacy bootstrap (creates ancient product_locations/users tables) — no script references it
  seed.ts                34 LOC  DEAD demo seed (Nike/Adidas sneaker SKUs in a card-supplies business)
  static.ts / vite.ts  19/58 LOC Static + dev server glue (fine)
  middleware/idempotency.ts  70 LOC  Idempotency-Key middleware (design flaws, §6-R5)
  routes/               8 files + ebay/ dir: shopify.routes (1,762), ebay-settings (674), ebay-listing-rules (571), oms.routes (366), pick-priority (333), diagnostics (299), ebay-oauth (196), middleware (49)
  storage/base.ts         4 LOC  Re-export barrel of db + whole schema + drizzle operators (a god-import, not an abstraction)
  services/index.ts     344 LOC  THE composition root — factory-injected service container (§5, best DI artifact in repo)
  platform/observability/  logger.ts, log-context.ts (ALS correlation), errors.ts (transient/permanent/fatal), report-error.ts (+1 unit test) — well-built, ~unused (§5)
  infrastructure/       auditLogger.ts (46), scheduler-config.ts (37, tested), scheduler-lock.ts (94, tested — pg advisory-lock runner)
  instrumentation/      metrics.ts (140, tested) — console.log "metric=" counters
  jobs/                 auto-draft + procurement-health escalation (tested)
  scripts/              one-off codemods checked in: fix_routes.ts, fix_all_routes.ts, fix_esc.cjs, test_mark_shipped.ts … (dead weight)
  modules/              16 modules, ~225k LOC (see §4/§5)
```

DB connection surfaces: 4 separate pools — app pool (`db.ts:33`, max 20, `PG_POOL_MAX`), migration pool (`db.ts:48`, max 1, per-boot), session pool (`index.ts:103`, max 2), advisory-lock pool (`scheduler-lock.ts:80`, max 2). All use `ssl: { rejectUnauthorized: false }` (`db.ts:23`, `index.ts:105`, `scheduler-lock.ts:82`, `migrations/run-migrations.ts:22`) — TLS cert verification disabled on a financial DB (37 occurrences of `rejectUnauthorized` repo-wide).

---

## 2. DB/DDL DISCIPLINE — db.ts vs migrations/ (key section)

### 2.1 What runs on every boot (`runStartupMigrations()`, db.ts:46–1077)

`server/index.ts:417` calls it before service wiring on every dyno boot. It is NOT tracked in `_migrations` and is NOT read-only. Categories:

**DDL (CREATE TABLE / ALTER / INDEX), touching at least 8 schemas** — wms, inventory, channels, catalog, ebay, oms, procurement, warehouse, plus unqualified statements that land in `public` via search_path:
- wms: returns lifecycle + `wms.return_items` (db.ts:73–94), `wms.line_fulfillments` mirror of migration 103 (db.ts:106–128), `wms.combined_order_groups` (db.ts:136–168), engine-agnostic + held columns on `wms.outbound_shipments` (db.ts:636–647), unique dedup indexes (db.ts:363–367, 1056–1062).
- inventory: `voided_at` soft-delete column (db.ts:328), `chk_variant_qty_non_negative NOT VALID` (db.ts:331–341), reserve/receipt dedup unique indexes (db.ts:343–384), `inventory.cost_adjustment_log` (db.ts:908–922), inventory_lots COGS + mills columns (db.ts:791–825).
- oms: full `oms.oms_orders`/`oms_order_lines`/`oms_order_events` CREATEs (db.ts:472–546), ShipStation/engine columns (db.ts:628–639), webhook columns (db.ts:1012–1014).
- channels/catalog/ebay/procurement/warehouse: allocation tables (db.ts:200–235), product_lines (db.ts:241–295), product_types + seed (db.ts:395–425), ebay rules/mappings/aspects (db.ts:431–727), pricing rules (db.ts:730–751), demand_events (db.ts:1018–1047), per-warehouse location-code unique constraint swap (db.ts:302–318).
- public (unqualified CREATE): `order_line_costs` (db.ts:888–901), `subscription_billing_log` / `subscription_events` / `selling_plan_map` — the latter with an FK `REFERENCES plans(id)` that resolves through search_path to shellz-owned `membership.plans` (db.ts:955–1007).

**DML — data mutation on every boot (the sharpest violation of read-boot discipline):**
- `DELETE FROM inventory.inventory_levels` "zombie cleanup" (db.ts:549–564). All-zero rows only, but it is a hard DELETE on the WMS-owned inventory table with **no `inventory_transactions` ledger entry** — a write outside `inventoryCore`, contradicting BOUNDARIES.md ("`inventory_levels`… mutate via `inventoryCore`", BOUNDARIES.md:156) and CLAUDE.md §10 append-only auditability.
- Backfills/repairs that rewrite financial columns: engine-ref backfills (db.ts:632, 639), held-flag retirement UPDATEs on `wms.outbound_shipments` that force rows to `shipped`/`cancelled` (db.ts:656–668), lot cost cents→mills backfill (db.ts:833–847), and a **historical lot-cost repair UPDATE recomputing po/packaging mills from PO lines** (db.ts:858–885). These are one-time migrations living permanently in boot code.
- Seeds: product_lines + assignment to all products/channels (db.ts:277–295), product_types (db.ts:406–425), sync_settings default row (db.ts:579–583).

### 2.2 Error handling: the "one big try/catch"

Everything after the two specially-wrapped blocks runs inside a single try/catch that logs and continues (`catch (error) { console.error("Error running startup migrations:", error); }`, db.ts:1071–1073). The runbook itself documents the failure mode: *"the first failure silently skips every later statement"* (DB-ROLE-SEPARATION-RUNBOOK.md:45–47). The two hardened blocks (returns lifecycle db.ts:72–98; line_fulfillments db.ts:105–132) each have their own try/catch precisely because a stray unqualified index statement used to abort the rest — evidence the pattern has already bitten (db.ts:66–71 comment). This is a **silent-failure design** on schema-critical code, violating CLAUDE.md §6.

### 2.3 Conflict with migrations/ and the runbook

- **Deliberate mirroring:** migration 103's header says re-running is a no-op "and the server/db.ts startup-fallback mirror" (migrations/103_line_fulfillments_ledger.sql:14–15); 0575's header cross-references the db.ts index (0575_inventory_ledger_immutability.sql:10–12). So dual-authority is intentional (dev DB is empty per CLAUDE.md). But large parts of db.ts have **no migration counterpart** (combined_order_groups columns db.ts:158–168, zombie DELETE, mills repair, held retirement, seeds) — meaning a fresh DB built only from `migrations/` differs from one built by boot, and vice versa. Schema truth is split across two files with no diff tooling.
- **Runbook compliance:** Phase 1 was executed — membership DDL removed with a NEVER-reintroduce comment (db.ts:943–952), migration-049 shopify_orders DDL removed (db.ts:778–786). Good. **Residual runbook risk:** `subscription_billing_log`/`subscription_events`/`selling_plan_map` are still created at boot with FKs into `membership.member_subscriptions`/`plans` (db.ts:955–1007). They are Echelon-owned public tables (not in the §2b transfer list) so DDL succeeds post-flip only if the REFERENCES grant (runbook §2c) exists — a boot-order coupling to grants applied manually.
- **Hardening items from the runbook still open:** `drizzle.config.ts` has **no `tablesFilter`** (drizzle.config.ts:1–17; runbook line 186–189 calls this out). Mitigation exists: `scripts/release.sh:11` gates drizzle push behind `RUN_DRIZZLE_PUSH_ON_RELEASE` defaulting to false — but if ever set true, the push runs `--force` with `yes ''` piped in (release.sh:14–19), the auto-drop scenario the runbook describes.
- **Different env var for tracked vs boot DDL:** `run-migrations.ts:14` uses `DATABASE_URL` only; `db.ts:6` prefers `EXTERNAL_DATABASE_URL`. If both are set and differ (the documented dev situation — CLAUDE.md: "uses the EXTERNAL database… the dev database is empty"), release-phase migrations and boot DDL target **different databases**. **INSUFFICIENT EVIDENCE** on prod config values; must be verified on the Heroku app.

### 2.4 migrations/ numbering discipline

185 `.sql` files, **two interleaved numbering series**: 3-digit legacy (001–105) and 4-digit (0000–0004 drizzle, 0063–0121, 0251, 0501, 0551, 0572–0581 dropship/phases). Facts:
- Runner sorts **lexicographically** (run-migrations.ts:44), so actual order is e.g. `005_ → 0063_…0067_ → 0069_ → 006_ → 0070_…` (verified by sort). Deterministic but non-chronological; whether a fresh DB replays in a dependency-valid order is untested. **HYPOTHESIS:** fresh-DB replay likely works only because most files are IF-NOT-EXISTS-idempotent and db.ts pre-creates missing pieces.
- Collision detection is **string-prefix-based** (run-migrations.ts:46–57): `101_` vs `0101_` (43 numeric-duplicate pairs exist, e.g. `101_warehouse_order_cutoff_on_warehouse.sql` vs `0101_dropship_shipping_admin_config.sql`; `063_`–`067_`, `069_`–`105_` all collide numerically with `00xx` files) are NOT flagged. The reported historical 101→102 renumber could not be confirmed from git (history squashed at merge ffbd5167); the collision-prone structure that would force such renumbers is confirmed. **INSUFFICIENT EVIDENCE** on the specific renumber event.
- `RENAMED_FILES` map (run-migrations.ts:25–30) heals four historical renames by rewriting `_migrations` rows — pragmatic, but shows filenames have churned under a filename-keyed tracker. The content-hash skip (run-migrations.ts:90) means two distinct migrations with byte-identical SQL would silently skip the second — a latent trap.
- Good properties: per-file `BEGIN/COMMIT` with `ROLLBACK` + fail-fast `process.exit(1)` (run-migrations.ts:101–112); `_migrations` tracking table with content hashes.

### 2.5 Rollback story

`migrations/reverse/` holds **11** reverse scripts for 185 forward migrations (058–066, 103, 105 only). There is no runner for them (no references in package.json or scripts/). Rollback is effectively "restore a backup" for ~94% of migrations. Given money columns changed in place (0074, 0576), that is thin for a financial system.

### 2.6 Verdict

**db.ts is the single largest architectural liability in the platform layer.** It is a second, untracked, silently-failing schema-and-data authority that runs as the app role on every boot, duplicates ~15 tracked migrations, mutates financial rows outside the ledger, and has already caused one cross-app production incident (2026-06-11, runbook:6–14) plus one 606-shipment data-loss incident from a sibling boot-repair job (documented in server/index.ts:1064–1076). The mitigation pattern (role separation, Path A comments) treats symptoms; the mechanism remains.

---

## 3. ROUTE-LAYER DISCIPLINE

### 3.1 Registration architecture

Two-stage: `server/index.ts` builds the container (`createServices(db)`, index.ts:423) and stashes it on `app.locals.services` (index.ts:424), registers webhooks needing pre-auth placement inline, then delegates to `registerRoutes()` (`server/routes.ts:54–116`) which is a clean, flat manifest of ~40 `registerXxxRoutes(app)` calls (routes.ts:63–113) — consistent function-registration pattern, with the eBay sub-app as `express.Router`s (`app.use(ebayConfigRouter)…`, routes.ts:102–106) as the only style deviation. Ordering is semantically load-bearing: webhook routes registered before auth (routes.ts:62–64), comment-documented.

Two blemishes at registration time:
- **Seeds run inside route registration**: `seedRBAC(); seedDefaultChannels(); seedAdjustmentReasons()` (routes.ts:58–60) — DB writes as a side effect of wiring HTTP routes, with empty-catch swallowing inside the seeds (identity.use-cases.ts:85,101,119,133,137 per module scan).
- **Service-locator-through-db hack:** services are smuggled to workers by monkey-patching the drizzle instance — `(db as any).__fulfillmentPush`, `__shipStationService`, `__shippingEngine`, `__wmsSyncService`, `__ebayWebhookReplay` (index.ts:483–490, 512–516). Hidden global state on the DB handle; invisible to types; violates CLAUDE.md §3 "no hidden state".

### 3.2 index.ts is itself a route+scheduler module (the biggest route-layer violation)

`server/index.ts` defines, inline in the bootstrap file:
- The ShipStation SHIP_NOTIFY webhook route (index.ts:433–473) — verification is decent (timing-safe compare index.ts:160–167, host allowlist index.ts:228–235, failure → enqueue retry then 500, correct per CLAUDE.md §6). But the secret is also accepted from the **query string and body** (index.ts:183–191) and is **appended to the registered webhook URL as `?secret=`** (index.ts:237–248) — secrets in URLs leak into logs/proxies.
- An admin re-ingest route (index.ts:531–547) with role check read from session inline.
- ~10 interval reconcilers/repair jobs containing **raw-SQL business writes to OMS and WMS tables**: eBay stuck-order sweep writing `oms.oms_orders.status='shipped'` directly (index.ts:856–863); OMS↔WMS reconcile cascading engine cancels and writing `wms.outbound_shipments.status` (index.ts:899–981); boot-time "data repair" force-completing `wms.order_items` and cancelling shipments (index.ts:987–1060); ShipStation Reconcile V2 updating `oms.oms_orders`, `oms_order_lines`, `oms_order_events` inline (index.ts:1371–1457). BOUNDARIES.md's directional contract says "WMS/reconcilers never write `oms_orders` directly" (BOUNDARIES.md:169–171) — these sweeps do exactly that, from the bootstrap file.
- A scheduler that calls the app's own HTTP endpoint over localhost with `INTERNAL_API_KEY` (index.ts:582–639) instead of calling the service — self-HTTP as an internal API.
- The disabled duplicate-shipment cleanup (index.ts:1064–1136) memorializes why this pattern is dangerous: it cancelled 606 already-shipped shipments (comment at index.ts:1069–1075).

None of these sweeps use the advisory-lock runner in `server/infrastructure/scheduler-lock.ts` — on >1 dyno they double-run. **HYPOTHESIS:** single-dyno deployment is what makes this safe today (db.ts:27 comment says "single web dyno").

### 3.3 Route files (platform-owned)

- `routes/diagnostics.ts` — mounted with `requireInternalApiKey` at prefix (diagnostics.ts:10) **and** `requireAuth` per handler (so internal callers with only the key are 401'd — contradictory middleware). Handlers contain destructive raw SQL: hard `DELETE FROM wms.order_items` / `wms.orders` de-dup endpoints **without a wrapping transaction** (diagnostics.ts:53–89, 114–141 — items deleted, then orders in a separate statement) and `sql.raw` with string-interpolated `parseInt` input (diagnostics.ts:265–274). Hard-deleting order rows also erases financial history (CLAUDE.md §10).
- `routes/pick-priority.routes.ts` — raw `db.execute` upserts of settings inside PATCH handler (pick-priority.routes.ts:182, 276–302). Non-financial, but the write-in-route pattern.
- `routes/oms.routes.ts` — largely disciplined: handlers resolve services from `app.locals` and delegate (oms.routes.ts:22–27, 32–39). Read paths pass `db` to service functions.
- `routes/shopify.routes.ts` (1,762 LOC) + eBay route files: see delegated scan below (eBay content itself audited elsewhere).
- `middleware/idempotency.ts` — see §6-R5.

### 3.4 Whole-app route scan (delegated, reconciled)

Inventory: **~61 route files, ≈30,400 LOC** (routes.ts hub 116; server/routes/* 7 files; server/routes/ebay/* 5 files incl. ebay-listings 1,913; 48 module `*.routes.ts` incl. 23 dropship interfaces/http; largest non-dropship: inventory.routes 2,835, catalog.routes 2,595, channels.routes 2,561, purchasing-recommendation 1,582, picking 1,328).

**Files with direct DB writes in route handlers** (write sites, reconciled for multiline drizzle chains):
catalog.routes.ts ~15 (products/shippingGroups/productCategories/productAssets CRUD, 2× raw `DELETE channels.channel_listings`, inline multi-table `db.transaction` @1706–1784) · diagnostics.ts 5 destructive · channels.routes.ts 6 (channelWarehouseAssignments/channelAllocationRules CRUD, Zod-validated, @2237, 2429–2510) · pick-priority.routes.ts 4 (**incl. `UPDATE membership.plans SET priority_modifier` @276** — a route in Echelon writing the shellz-owned membership schema — plus `channels.channels.sla_days` @293/302) · ebay-config.routes.ts ~4 (raw `pool.connect()` + BEGIN/COMMIT upsert loop @210–250) · shopify.routes.ts ~4 (see below) · ebay-settings.routes.ts 3 (`db.insert/update(channelConnections)` @78, 319, 360 — credentials persisted in route) · ebay-taxonomy 3 transactions · ebay-policies ~4 · ebay-listings 2 writes/24 reads (`UPDATE channel_listings SET sync_status='deleted'` @1843, 'ended' @1880) · ebay-listing-rules 1 (`UPDATE catalog.products SET product_type ... WHERE id = ANY($2)` @196) · ebay-pricing 1 · inventory.routes.ts 1 route-owned `db.transaction` @439 where the route computes the inventory delta (`targetQty - variantQtyBefore`) and owns the txn, with writes delegated to storage — the route decides.

**Worst single finding:** `shopify.routes.ts:411` — `INSERT INTO wms.outbound_shipments (..., status, source, ...) VALUES (..., 'shipped', 'shopify_external_fulfillment', ...)` under `pg_advisory_lock(918406, ...)` @402, a terminal-state shipment created directly in a route file, with supersede/cancel set-math via raw SQL @192–214 and status-gating logic @261–266 in the same file — status transitions and shipment selection living in the interface layer.

**Webhook discipline:** shopify.routes.ts fulfillment webhooks (@1587, 1656) verify HMAC then run the full WMS cascade **inline**, inserting into `webhookRetryQueue` only on unhandled throw (@1624, 1690) then 500 — process-inline-then-ack with DLQ-on-error, not the persist-to-inbox-first pattern CLAUDE.md §6 mandates. The disciplined counter-example exists in the same codebase: `server/modules/oms/oms-webhooks.ts` (registered index.ts:476) wraps processing in `markInboxSucceeded/markInboxFailed` receipts (@1614/1618, 1956/1960, 2027/2031, 2152/2156, 2355/2359). Legacy `orders/create|fulfilled|cancelled` webhooks in shopify.routes.ts are disabled stubs (@1710–1750, HMAC-verify then 200).

**Compliant files (all persistence delegated):** routes.ts hub, oms.routes.ts (services via app.locals, one read-only `db.execute` @331), ap-ledger.routes.ts (service + `requireIdempotency`), purchase-order, warehouse (44 storage.* calls), receiving, replenishment; dropship interfaces/http showed no direct db.* writes (use-case delegation), not individually opened.

**Input validation:** ~15 of ~61 route files (~25%) use Zod (`safeParse`) — concentrated in dropship interfaces/http, channels @2225, subscriptions, parts of procurement. ~75% trust raw `req.body` with at most manual guards (e.g. oms.routes.ts @247 destructures untyped; pick-priority casts `req.body as PickPriorityUpdate` @249). Contradicts CLAUDE.md §4/§5 for most of the surface.

### 3.5 Verdict

The registration manifest is clean, but "no business logic / no DB writes in routes" is **not** the codebase norm: the bootstrap file and the older/larger route files (catalog, diagnostics, shopify, ebay-settings/config/listing-rules, pick-priority, channels, inventory) decide and write directly — including cross-schema and cross-app (membership.plans) writes. Newer surfaces (oms.routes, dropship interfaces/http, ap-ledger with `requireIdempotency`, oms-webhooks' inbox receipts) prove the intended pattern exists and is followed by recent code; the violation set is legacy-shaped, not random.

---

## 4. SMALL-MODULE ASSESSMENTS

(Delegated deep scan, verified spot-wise; all file:line refs retained.)

**catalog (4,361 LOC, 0 tests)** — Product master + Shopify import + image sync + admin API. Flat layering at best: a 2,595-line `catalog.routes.ts` with 47 handlers holds real business logic and 9 direct-write sites — worst examples: inline multi-table remap transaction (catalog.routes.ts:1706–1780), raw cross-schema `DELETE FROM channels.channel_listings` (catalog.routes.ts:980, 2016), raw asset UPDATEs (catalog.routes.ts:2261–2445). `catalog.storage.ts` is a decent interface, but `cascadeSkuRename` performs 8 sequential cross-schema updates (OMS/WMS/procurement) **without a transaction** (catalog.storage.ts:455–472) — partial failure strands a SKU rename mid-flight across systems. `image-sync.service.ts:438–478` `pushToEbay()` is an admitted placeholder stub. `product-import.service.ts:219` carries a self-declared boundary violation (writes WMS `product_locations` directly). ~102 raw console.* calls, no structured logger, zero tests on 4.3k LOC that other modules (warehouse, channels, procurement, inventory) depend on. **Health: poor — highest-priority refactor target among small modules.**

**identity (624 LOC, 0 tests)** — Users/auth/RBAC + boot seeds. Best-layered small module: domain/application/infrastructure + routes; use-cases wrap repo calls in `db.transaction` (identity.use-cases.ts:29–61). Two defects: five `catch {}` empty blocks in seed paths swallow all errors, not just conflicts (identity.use-cases.ts:85, 101, 119, 133, 137); `/api/auth/me` silently degrades role/permission lookups to empty arrays (identity.routes.ts:57–59) — an auth read that hides failures. bcrypt + login rate limiting present. **Health: good, minus seed error-handling.**

**integrations (570 LOC, 0 tests)** — Pure Shopify REST adapter (fetch, HMAC verify with `timingSafeEqual`, integrations/shopify.ts:173–181), no DB, env-only credentials. Correct 429 retry handling (shopify.ts:382–386). Misnamed as generic "integrations" (it is Shopify-only) and overlaps conceptually with modules/shopify and the subscriptions Shopify adapter — three Shopify client stacks. **Health: fine internally; consolidation candidate.**

**notifications (618 LOC, tested)** — Notification fan-out + SMTP. Thin routes that genuinely delegate (notifications.routes.ts all handlers call the service); single-statement batch insert for recipients (notifications.service.ts:97). **Health: good; the model other small modules should follow.**

**subscriptions (2,128 LOC, 0 tests) — highest-risk module in this audit.** Billing engine writing to the shellz-club-owned `membership.*` schema (member/subscription/plan writes at subscription.repository.ts:234, 286, 315–349, 398–427, 446, 517; schema ownership per DB-ROLE-SEPARATION-RUNBOOK.md:19). Critical defects: (a) **fake transactions** — use-cases open `db.transaction(tx ⇒ …)` but the `storage.*` calls inside use the module-global `db`, so multi-step billing writes are NOT atomic (subscription.use-cases.ts:61–92, 159–180, 196–223, 244–255, 280–307 vs repository global-db usage) — direct CLAUDE.md §8 violation on money paths; (b) collision-prone hand-rolled PKs `String(Date.now()+Math.random()*1000)` on members/subscriptions/billing rows (subscription.repository.ts:235, 287, 447, 518); (c) billing log written into the wrong column (`member_subscription_id` → `contract_id`, repository.ts:448) and `String(undefined)` order ids (repository.ts:454), while a purpose-built `subscription_billing_log` table with a unique idempotency key sits unused; (d) **dual-writer ambiguity** — webhook routes are commented out ("shellz-club-app is now the canonical membership webhook listener", subscription.webhooks.ts:57–79) yet Echelon's `startBillingScheduler` still runs live (index.ts:768) against the same rows; the four webhook use-cases (~half the use-case file) are dead code, and `registerSubscriptionWebhookRoutes` (routes.ts:63) registers zero routes. One float spot: `(priceCents/100).toFixed(2)` (subscription.domain.ts:129), low risk. **Health: needs an owner decision (move billing wholly to shellz-club or wholly here) before any refactor.**

**sync (269 LOC, 0 tests)** — `SyncRecoveryService`: staged gap-recovery orchestrator with per-stage error isolation and re-entrancy guard (sync-recovery.service.ts:58–67, 96–220). `shopify-bridge-wrapper.ts` is a 6-line re-export existing solely to dodge import-order problems — a symptom of the oms module's tangle, not a real module. **Health: fine; barely a module.**

**shopify (88 LOC)** — Not a stub in the pejorative sense: a deliberate DI seam (`ShopifyAdminGraphQLClient` interface + default factory) used by OMS fulfillment push/webhooks/reconciler and production-wired in services/index.ts:240. Oddity: the "platform" Shopify GraphQL client lazily delegates **into `subscriptions/infrastructure/shopify.adapter`** (admin-gql-client.ts:82–85) — a generic client depending on a feature module, inverted layering. Belongs in a shared shopify-client module (or oms/). **Health: good code, wrong address.**

**wms (799 LOC + 949 test LOC)** — Three invariant-enforcing write primitives for `wms.orders` / `wms.outbound_shipments`: `insertWmsOrder` (insert-order.ts:22, runtime guards :52–69), `createShipmentForOrder`/`linkChildToParentShipment` (create-shipment.ts:198/435, advisory-lock idempotency :258–269, exhaustive validation :205–249), `holdLineItemWithSplit` (line-item-hold.ts:33, own transactions :38, 102). Consumed by orders.storage, oms/wms-sync, webhook-retry worker, channels routes. **No overlap with modules/orders** — it is the extracted low-level leaf both orders and oms call; the real ambiguity in the codebase is orders vs oms, not wms. Zero console.*; typed error classes. Weakness: `db: any`/`DbLike` typing (insert-order.ts:49). **Health: exemplary — the standard the rest should meet.**

---

## 5. CROSS-CUTTING CONCERNS

**Logging — the CLAUDE.md §10 "one structured logger" requirement is built and ~unadopted.** `server/platform/observability/` provides exactly the mandated logger (JSON lines with level/action/outcome/before/after/error_code, logger.ts:22–54), ALS correlation context carrying `{omsOrderId, wmsOrderId, shipmentId, channelEventId, engineRef}` (log-context.ts:4–11), error classification transient/permanent/fatal (errors.ts:44–57), and `reportError` with Discord alerting on permanent/fatal (report-error.ts:30–48). **Exactly one production file imports any of it: server/index.ts** (correlation middleware index.ts:84–88; global error handler index.ts:697–703; crash handlers index.ts:732–737). Measured distribution (non-test): oms 430 console / 0 logger; routes/ 218/0; inventory 185/0; channels 171/0; dropship 127 console / 81 calls to its **own** `DropshipLogger` port (dropship-ports.ts — a fourth logging system); procurement 104/3; catalog 102/0; orders 118/0; warehouse 80/0; index.ts 66; db.ts 40. Plus `AuditLogger` (infrastructure/auditLogger.ts — console JSON + fire-and-forget insert into `audit_events`, :34–44) and `metrics.incr` emitting `metric=` lines via console.log (instrumentation/metrics.ts:98). Net: ~1,600+ raw console.* sites, four parallel logging systems, correlation context effectively lost after the first `await` into any module that doesn't use ALS-aware logging.

**Config/env** — No central config module; `process.env` read at ~every use site. Good pieces: `SESSION_SECRET` is fail-fast (index.ts:95–97), scheduler kill-switches are systematic (`DISABLE_SCHEDULERS` + per-scheduler flags, scheduler-config.ts:8–21, used ~20× in index.ts). Bad pieces: cookie `secure` keyed to `TRUST_PROXY === "true"` rather than NODE_ENV (index.ts:124) — if TRUST_PROXY is unset in prod, session cookies go over non-secure attribute; magic `channel_id = 67` (eBay) hardcoded in index.ts:568, 833 and re-declared as a constant in at least catalog/image-sync.service.ts:16 and oms/shipstation.service.ts:25 (violates CLAUDE.md §13 no-magic-numbers, and is per-environment data living in code).

**Secrets** — No hardcoded credentials found in server/shared (pattern grep clean). Weaknesses: ShipStation webhook shared secret accepted via query/body and embedded into the registered callback URL (index.ts:183–191, 237–248); `rejectUnauthorized: false` everywhere (see §1); webhook secret optional outside production with a one-time warn (index.ts:202–217).

**WebSocket** (websocket.ts) — Session-authenticated upgrade (401 pre-handshake, :41–46), per-IP connection cap (:29–35), ping/pong keepalive tuned to Heroku (:95–101), graceful shutdown (:109–115). Minor: IP counter increments from a stale read captured before an async session parse (:30 vs :49) — undercount race; console.* logging; `BUILD_VERSION = Date.now()` (:10) is fine for cache-bust. Overall: solid.

**Storage abstraction** — `server/storage/base.ts` re-exports `db`, the entire schema, and drizzle operators in 4 lines; consumed by 10+ module files. It is a convenience god-import, not a boundary: any file importing it gets raw write access to every table in every schema, which is exactly how cross-boundary writes keep appearing. Per-module `*.storage.ts` files exist (catalog, orders, channels…) but sit on the same unrestricted base.

**DI/composition** — `createServices(db)` (services/index.ts:78–296) is a genuine composition root: factory functions, explicit dependency graph in the header comment, setter injection to break the channelSync↔orchestrator cycle (services/index.ts:169–177; sync.service.ts:94–105), and a typed `ServiceRegistry` (services/index.ts:299). Weaknesses: `db: any` parameter (:78), several `as any` casts on core services (:91–97, 243), a dead `inventorySource: null as any` entry (:109, 276), and an in-memory `setTimeout` debounce for inventory→channel sync that loses events on dyno restart (services/index.ts:180–217, fire-and-forget with console.warn). Dropship is the outlier with its own factories/registries under `infrastructure/` and constructor-injected ports (clock, logger) — the most complete DDD implementation in the repo. Barrel files: most modules have `index.ts` barrels; the replen circular-dep class of problem is still handled by ad-hoc means — lazy `import()` (sort-rank.ts:378, admin-gql-client.ts:79–85), dynamic imports in routes (sync-control.routes.ts:159), and setter injection (sync.service.ts:94–105). No import-cycle lint rule found. **INSUFFICIENT EVIDENCE** on the specific historical replen fix (git history squashed).

**Module layering consistency** (dir-structure check): full domain/application/infrastructure/interfaces → **dropship** only; partial (domain+application+infrastructure) → identity, inventory, subscriptions; infrastructure-only → warehouse; **flat service files** → catalog, channels, integrations, notifications, oms, orders, procurement, shipping, shopify, sync, wms. Two naming conventions for the same concepts coexist (`*.service.ts`+`*.storage.ts` vs `application/*.use-cases.ts`+`infrastructure/*.repository.ts`). The monolith is modular in folder names; consistency of internal shape is ~35%.

---

## 6. CORRECTNESS RISKS (ranked)

**R1 — Untracked boot-time DDL/DML in db.ts with swallow-all error handling.** Every boot can mutate schema and financial data (inventory_levels DELETE db.ts:549–564; shipment-status UPDATEs db.ts:656–668; lot-cost repair db.ts:858–885) as the app role, outside `_migrations`, with failures silently skipped (db.ts:1071–1073). Proven incident class (runbook:6–14; index.ts:1069–1075 documents 606 wrongly-cancelled shipments from the same pattern).

**R2 — subscriptions module: non-atomic billing writes + dual-writer with shellz-club.** `db.transaction` blocks that don't enroll the actual writes (subscription.use-cases.ts:61–92 et al.), Date.now()-based PKs on financial rows (repository.ts:235, 287, 447, 518), wrong-column billing log (repository.ts:448) — all with 0 tests, on shared membership money data.

**R3 — Reconcilers in index.ts write oms_orders/wms tables directly, unserialized across dynos.** Direct status writes (index.ts:856–863, 1371–1428) bypass OMS's interface (BOUNDARIES.md:169–171), don't use scheduler-lock, and can race the webhook/worker paths they reconcile against. Scale-out to 2 dynos doubles every sweep.

**R4 — Migration runner ordering + collision blind spot.** Lexicographic interleave of two numbering series (run-migrations.ts:44) with string-only collision detection (:46–57) makes "what runs when" non-obvious; hash-based skip (:90) can silently drop a legitimately duplicated migration body; fresh-environment replay order is unvalidated.

**R5 — Idempotency middleware races and dead-ends.** No unique-violation handling on the insert race (two concurrent same-key requests → PK error → generic 500, middleware/idempotency.ts:46–50); a request that dies before `res.json` leaves `responseBody` NULL forever → every retry gets 409 "in progress" permanently (:37–43) — the `expiresAt` column exists (shared/schema/audit.schema.ts:19) but is never written or checked; replay always returns 200 regardless of original status (:39); response persisted fire-and-forget (:54-60). This guards AP payments and vendor invoices (ap-ledger.routes.ts:49–330).

**R6 — Cookie/TLS posture.** `rejectUnauthorized: false` on all DB pools (§1); session cookie `secure` contingent on `TRUST_PROXY` env (index.ts:124); ShipStation secret in query strings (index.ts:183–191, 237–248).

**R7 — diagnostics endpoints hard-delete order history without transactions** (diagnostics.ts:53–141) behind a contradictory middleware stack (:10 vs :13 requireAuth).

**R7b — Route-layer writes into terminal financial state:** shopify.routes.ts:411 creates `status='shipped'` outbound shipments directly in a route; pick-priority.routes.ts:276 UPDATEs shellz-owned `membership.plans` from a route; ebay-settings.routes.ts:78/319/360 persists channel credentials in-route. ~75% of route files accept unvalidated `req.body` (§3.4).

**R8 — `allowNegative: true` in the 3PL sync path** (inventory/application/inventory.use-cases.ts:1172) — a listed Absolute Prohibition (CLAUDE.md §16); inventory module is another auditor's scope, flagged here because it was found during platform greps.

**R9 — Boot-order coupling:** `runStartupMigrations` failure is caught and boot continues (index.ts:416–420), so the app can serve traffic against a schema it just failed to prepare; combined with R1's silent skips, drift may only surface as runtime SQL errors.

---

## 7. REFACTOR RECOMMENDATIONS

1. **Freeze db.ts DDL.** Move every statement into numbered migrations (most already have counterparts); replace `runStartupMigrations()` with a schema-version assertion that refuses boot on mismatch (fail-fast, satisfies CLAUDE.md §6). For dev-empty-DB convenience, run the real migration runner at boot behind `RUN_MIGRATIONS_ON_BOOT=true` instead of a hand-maintained mirror. Delete the boot-time data repairs (zombie DELETE, held retirement, lot repair) after one final tracked migration performs them.
2. **Unify migration numbering.** Adopt one zero-padded 4-digit series going forward; make the collision check numeric (`parseInt(prefix)`), not string; add a CI step that replays all migrations against a scratch Postgres to validate fresh-DB order; generate reverse scripts as a PR requirement for destructive changes.
3. **Decide the subscriptions owner.** Either move billing entirely to shellz-club (delete Echelon's scheduler + repository writes) or repatriate the webhooks here — then fix the fake transactions (pass `tx` through the repository), replace Date.now() PKs with DB identities/UUIDs, and adopt the unused `subscription_billing_log` idempotency table. Tests before any of it.
4. **Evacuate index.ts.** Each inline reconciler/sweep becomes a module job (modules/oms/reconcilers, modules/orders) wrapped in `withAdvisoryLock` (infrastructure/scheduler-lock.ts:27) and using OMS/WMS interfaces (`order-status-core`, `shipment-rollup` are already imported — finish the job) instead of raw `UPDATE oms.oms_orders`. Replace `(db as any).__service` stashing with the ServiceRegistry.
5. **Adopt the observability platform.** Mechanical codemod: `console.error/warn` → `logger.error/warn` with action strings, module by module (start with oms's 430 and routes' 218); route dropship's `DropshipLogger` to the platform logger as its sink; make `reportError` the single alert path. Add an ESLint `no-console` rule with per-file opt-outs to hold the line.
6. **Kill `storage/base.ts` as a public surface.** Modules import their own schema slice; cross-module table access goes through the owning module's storage/interface (BOUNDARIES.md sole-writer matrix). This single change makes most future boundary violations grep-detectable.
7. **Catalog routes decomposition** (worst flat module): extract use-cases for remap/rename/import flows, wrap `cascadeSkuRename` in one transaction, delete the `pushToEbay` stub, and add the missing tests before touching behavior.
7b. **Converge webhooks on the inbox pattern.** shopify.routes.ts fulfillment webhooks and the SHIP_NOTIFY route should persist-to-inbox-then-2xx like oms-webhooks.ts already does (§3.4); move the shipment-supersede/terminal-insert logic out of shopify.routes.ts into the WMS interface (`modules/wms/create-shipment.ts` is the right home and already exists). Standardize Zod schemas at every route boundary (dropship's interfaces/http shows the house style).
8. **Small hygiene:** delete server/migrate.ts, server/seed.ts, server/scripts codemods; hoist `EBAY_CHANNEL_ID` to config; fix cookie `secure` to NODE_ENV-based; provision proper CA verification (Heroku supports `sslmode=verify-full` with the bundled cert) instead of `rejectUnauthorized: false`; add TTL sweep + unique-violation → 409 handling in idempotency middleware; merge the three Shopify client stacks (integrations, shopify, subscriptions/infrastructure) into one.

## 8. UNKNOWNS

- **Prod env values** — whether `EXTERNAL_DATABASE_URL` and `DATABASE_URL` point at the same DB on the Heroku app (determines whether release migrations and boot DDL diverge, §2.3); whether `TRUST_PROXY`, `RECONCILE_V2`, `RUN_DRIZZLE_PUSH_ON_RELEASE` are set. Requires `heroku config` — not verifiable from the repo.
- **Whether the role-separation flip (runbook Phases 2–4) has been executed** — the runbook is a plan; no marker in the repo proves the `shellz_club` credential exists. If not executed, db.ts's membership-FK CREATEs and subscriptions' membership writes run with full DDL-capable privileges.
- **The specific 101→102 renumber event** — git history is squashed at the initial merge (ffbd5167); the collision-prone structure is confirmed, the event itself is not.
- **Fresh-DB migration replay viability** — never exercised in CI as far as the repo shows; the interleaved ordering (§2.4) is only proven safe for already-migrated databases.
- **Dyno count** — all sweep-safety reasoning (R3) assumes one web dyno (db.ts:27 comment); Procfile doesn't constrain scale.
- **Whether `_migrations` on prod contains rows matching current filenames** — RENAMED_FILES healing implies past drift; actual table state unverifiable from code.
- **Whether storage/service methods called from the write-heavy routes internally enforce boundary rules** — out of this audit's scope (other auditors' modules); route-level evidence only.
- **ebay-listings.routes.ts** — 24 `client.query` calls; only 2 confirmed as writes; the remainder presumed reads but not individually verified (eBay is another auditor's scope).
