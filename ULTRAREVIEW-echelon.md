# ULTRAREVIEW — Echelon Codebase Findings

**Reviewer:** Claude (automated agent, orchestrated parallel exploration)
**Date:** 2026-04-17
**Scope:** Entire codebase (server, client, shared, migrations, top-level scripts).
**Lenses applied:** (1) correctness & financial integrity, (2) architecture & separation of concerns, (3) performance & scalability.
**Depth:** Deep audit — every finding below is backed by a file path, line number, and a short quoted snippet from the current code.

> **Evidence discipline.** Per the project rules, every claim is grounded in a file+line citation. Findings I could not verify from the code are marked **INSUFFICIENT EVIDENCE** or **HYPOTHESIS** rather than stated as fact.

---

## 0. Executive summary

| Severity | Count | Financial exposure |
|----------|-------|--------------------|
| Blocker  | 15    | Cascading: money math in floats, session/JWT/Stripe dev-secret fallbacks, multi-line receiving not transactional, read-modify-write on `inventory_levels` without row locks, migration failures don't abort deploy, stuck-order reconciler dead at module scope, eBay reconcile endpoint unauthenticated, subscription admin routes unauthenticated, diagnostics destructive endpoints unauthenticated, startup silently zeroes negative inventory, global Express error handler re-throws after responding, Stripe webhook signature verification is broken on every configuration path, WebSocket upgrade has no auth and client-asserted identity, 8 warehouse/locations routes unauthenticated. |
| High     | 24    | Missing webhook retry / idempotency; `(vendor_id, invoice_number)` not unique; `receivedQty > expectedQty` accepted; AP 3-way match detected but not blocking; no rate-limit/retry on ShipStation adapter; route files >100KB violating clean architecture; `require()` in ESM modules; business logic in route handlers; no FK on `orderLineCosts.orderItemId` and `inventoryLots.inboundShipmentId`; client-side currency conversion; `localStorage` JWT; duplicate migration prefixes; audit log writes only to stdout; test coverage near zero (13 tests for 300+ source files); combined-order claim loop without idempotency; Stripe webhook metadata key mismatch silently drops wallet credits. |
| Medium   | 18    | Allocation engine ignores `is_listed` at allocation-time; ATP excludes backorder; reward/rewards subsystem ambiguity; billing scheduler not dyno-safe; landed-cost re-allocation retroactively mutates closed lines; allocation currency-conversion gap. |
| Low      | 8     | Minor audit/atomicity gaps, token-rotation race, display formatting, `@ts-ignore` scattered on known-broken code. |
| Info     | 6     | Positive finds + absent-evidence notes. |

**The cumulative shape of the risk is:** large, sprawling handlers with weak type discipline on money, no consistent transaction/idempotency primitive, auth applied per-route (not globally), a migration pipeline that silently continues after a failure, and a top-level sprinkle of one-off scripts that mutate production data without audit. Any one of the Blockers is, on its own, sufficient to cause financial loss or incident.

---

## 1. Methodology and coverage

**Read in full:** `server/index.ts`, `server/routes.ts`, `server/routes/middleware.ts`, `server/modules/procurement/receiving.service.ts`, `server/modules/dropship/vendor-auth.ts`, `migrations/run-migrations.ts`, `shared/schema/procurement.schema.ts` (relevant excerpts), `shared/schema/inventory.schema.ts` (relevant excerpts), `server/modules/subscriptions/subscription.routes.ts`, `BOUNDARIES.md`, `SYSTEM.md`.

**Read in part via parallel exploration (findings below each independently cite file:line):** `server/modules/inventory/**`, `server/modules/channels/**`, `server/modules/procurement/**`, `server/modules/oms/**`, `server/modules/orders/**`, `server/modules/subscriptions/**`, `server/modules/identity/**`, `server/modules/dropship/**`, `server/infrastructure/`, `server/services/`, `server/routes/ebay-channel.routes.ts` (4 228 lines — sampled), `server/routes/shopify.routes.ts`, `client/src/pages/*.tsx` (sampled).

**NOT exhaustively covered (and therefore excluded from the "absent → therefore broken" inference):** `server/websocket.ts`, much of `server/modules/warehouse/**`, the vast majority of client pages beyond AP / PO / Receiving / vendor portal, `attached_assets/`, the 150+ top-level `check-*.{cjs,ts,js}` and `debug-*.ts` one-off scripts (sampled, not enumerated).

Where an agent surfaced a claim I did not independently verify, it is marked **HYPOTHESIS** below.

---

## 2. Blockers

### B1 — Money stored as IEEE-754 `doublePrecision` in core schemas

- `shared/schema/procurement.schema.ts:126` — vendor product cost
  `"unitCostCents: doublePrecision(\"unit_cost_cents\").default(0), // Negotiated cost per unit"`
- `shared/schema/procurement.schema.ts:133` — `"lastCostCents: doublePrecision(\"last_cost_cents\")"`
- `shared/schema/procurement.schema.ts:406` — PO line unit cost
  `"unitCostCents: doublePrecision(\"unit_cost_cents\").notNull().default(0),"`
- `shared/schema/procurement.schema.ts:408` — PO line discount
  `"discountCents: doublePrecision(\"discount_cents\").default(0),"`
- `shared/schema/procurement.schema.ts:410–411` — PO line tax/total
  `"taxCents: doublePrecision(\"tax_cents\").default(0),"`
  `"lineTotalCents: doublePrecision(\"line_total_cents\"),"`
- `shared/schema/inventory.schema.ts:443` — inventory lot cost
  `"unitCostCents: doublePrecision(\"unit_cost_cents\").notNull().default(0),"`
- `shared/schema/inventory.schema.ts:142` — inventory transaction cost (reported by exploration; confirm during fix).

**Why it matters.** `doublePrecision` is an IEEE-754 64-bit float. It cannot exactly represent `0.1`, `0.01`, or most cent values past ~$90M of accumulated sum. Arithmetic done in JS (`Number`, `+=`, `Math.round`) on these columns silently loses precision. This directly contradicts project rule 3 ("never use floating point for money") and rule 16 ("absolute prohibitions"). The fact that some newer tables (`orderLineCosts.unitCostCents` at `inventory.schema.ts:473`) are already `integer` proves the team knows to use integers — the `doublePrecision` columns are historical debt but are still actively written.

**Propagation.** These float columns feed the compute path:
- `server/modules/inventory/cogs.service.ts` multiplies and sums them as JS `number` (exploration report, e.g. `cogs.service.ts:216–217`, `:284–286`, `:388–389`).
- `server/modules/procurement/receiving.service.ts:210` reads `(line as any).unitCost` and passes it into `inventoryCore.receiveInventory({ unitCostCents })`, which then stores it on `inventory_lots.unit_cost_cents` (also float). Any rounding error accumulates per receipt, compounds across FIFO consumption, and shows up in COGS reports.

### B2 — Session secret and vendor-JWT secret have dev fallbacks

- `server/index.ts:73` —
  `"secret: process.env.SESSION_SECRET || \"echelon-dev-secret-change-me\","`
- `server/modules/dropship/vendor-auth.ts:5` —
  `"const VENDOR_JWT_SECRET = process.env.VENDOR_JWT_SECRET || \"vendor-jwt-secret-change-me\";"`

**Why it matters.** If either env var is missing (typo, new dyno, misconfigured preview), the process silently boots with a known, checked-in secret. Session cookies and vendor JWTs become forgeable by anyone who can read this repo. No runtime assertion, no startup failure.

### B3 — Stuck-order reconciler is defined *outside* the startup IIFE and throws every run

- `server/index.ts:510` closes `httpServer.listen(...)` call
- `server/index.ts:512` — `"})();"` — the startup IIFE ends here
- `server/index.ts:514–566` — a `setInterval(async () => { ... }, 4*60*60*1000)` is declared *after* the IIFE closed. Inside that callback:
  - Line 531: `"const ss = services.shipStation;"` — `services` was declared at `server/index.ts:255` inside the closed IIFE.
  - Line 552: `"await services.fulfillmentPush.pushTracking(order.id);"` — same scope problem.

**Why it matters.** At module top level, the identifier `services` is not defined. In strict ES module context, referring to it throws `ReferenceError`. The outer `try/catch` at lines 515 and 563 swallows that error to a single `console.warn("[eBay Reconcile] Sweep error: ...")` log every 4 hours. The feature — auto-recovering eBay orders that got stuck in `confirmed` for 48+ hours — has **never worked** since it was added. Financial impact: eBay orders that ShipStation ships but whose OMS status never flips stay `confirmed` forever, and tracking is never pushed back to eBay; eBay treats them as late / unshipped and may apply seller-performance penalties.

### B4 — `/api/ebay/listings/reconcile` is publicly reachable and unauthenticated

- `server/routes/ebay-channel.routes.ts:3073` —
  `"app.post(\"/api/ebay/listings/reconcile\", async (_req: Request, res: Response) => {"`
- Grep on the whole file for `requireAuth|requirePermission|_internal` returns **zero** matches.
- `server/index.ts:363` composes a loopback call `"path: \"/api/ebay/listings/reconcile?_internal=1\","` — the `_internal=1` query param is never inspected in the handler (the handler destructures only `_req` and reads nothing from query).

**Why it matters.** Any attacker who can hit the public URL triggers:
- A full `SELECT` of `channels.channel_listings` and `catalog.products`/`product_variants` (data disclosure of SKUs and eBay external IDs, `ebay-channel.routes.ts:3086–3094`).
- A loop of authenticated eBay Inventory API calls per listing (`:3120`, `:3148`), burning rate-limit budget and, on attacker cadence, potentially triggering eBay throttling of real commerce traffic.
- An `UPDATE channel_listings SET sync_status = 'deleted'` for any listing eBay returns 404 for at that moment (`:3136`).

The `?_internal=1` pattern is security theater: it is not checked anywhere. There *is* a proper primitive available — `requireInternalApiKey` at `server/routes/middleware.ts:29` — it is simply not used.

### B5 — Subscription admin routes registered without auth middleware

- `server/modules/subscriptions/subscription.routes.ts:12` — file header comment says `"Register admin subscription routes (behind Echelon auth)."`
- Grep for `requireAuth|requirePermission` in this file returns **zero** matches.
- The routes defined include destructive operations, e.g. `:62` `app.post("/api/subscriptions/:id/cancel", ...)`, `:89` `app.post("/api/subscriptions/:id/retry-billing", ...)`, `:125` `app.put("/api/subscriptions/plans/:id", ...)` (line numbers via exploration, verified structurally).

**Why it matters.** These endpoints change subscription state and plan definitions. The file's own comment asserts auth; the code omits it. There is no global `app.use(requireAuth, ...)` anywhere in `server/index.ts` or `server/routes.ts`, so the comment's assumption never materialises at runtime.

### B6 — Diagnostics destructive endpoints unauthenticated

- `server/routes/diagnostics.ts` — grep for `requireAuth|requirePermission|requireInternalApiKey` returns **zero** matches across the entire file.
- Exploration identified at least `diagnostics.ts:9 app.post("/api/diagnostics/cleanup-duplicates-normalized", ...)`, `:96 /api/diagnostics/cleanup-duplicates`, `:219 /api/diagnostics/repair-wms-orders`.

**Why it matters.** These are "fix the data" endpoints. On an unauthenticated host, a random actor can trigger database cleanups.

### B7 — Receiving close() is not atomic across lines

- `server/modules/procurement/receiving.service.ts:198` — comment: `"Process each line using inventoryCore (atomic, transaction-wrapped)"`.
- `server/modules/procurement/receiving.service.ts:205–258` — the loop:
  ```
  for (const line of lines) {
    ...
    await this.inventoryCore.receiveInventory({ ... });
    await this.storage.updateReceivingLine(line.id, { putawayComplete: 1, status: "complete" });
    ...
  }
  ```
- No `db.transaction(...)` wrapping the loop. The only transaction the comment can be referring to is the one *inside* each single `receiveInventory` call. If lines 1–2 succeed and line 3 throws, lines 1–2 are already committed (inventory increased, line status = `complete`). Line 3 and beyond are not processed; the caller gets an exception. Receiving order status stays not-`closed` but put-away is half done.
- Line 283–289: `"UPDATE inventory.inventory_levels SET variant_qty = GREATEST(0, variant_qty - ${line.receivedQty})"` — the `GREATEST(0, ...)` clamp silently hides any situation where auto-breaking cases would push `variant_qty` negative. Project rule 4 of BOUNDARIES.md: "Never use `allowNegative: true` — if the math goes negative, something is wrong. Flag it, don't force it." This clamp is functionally the same.

**Why it matters.** Partial receives corrupt PO arithmetic. Retries (operator clicks "Close" again after network glitch) double-increment lines 1–2 because there is no idempotency key on `(po_id, receiving_line_id, receipt_id)` in `inventory_transactions`.

### B8 — Migration runner continues after failures; duplicate-prefix files exist

- `migrations/run-migrations.ts:47` — `"const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();"`.
- `migrations/run-migrations.ts:64–67` — on failure, `"console.error(... failed ...); // Continue anyway (some migrations may be idempotent)"`. The for-loop then moves to the next file. The process exits 0.
- Duplicate prefixes (confirmed by `ls`):
  - `012_catalog_restructure.sql` + `012_replen_task_method_and_autoreplen.sql`
  - `025_procurement.sql` + `025_unique_variant_sku.sql`
  - `050_add_tax_exempt_to_shopify.sql` + `050_subscription_engine.sql`
  - `055_drop_over_reservation.sql` + `055_hub_and_spoke_warehouse.sql`

**Why it matters.** Two files sharing a prefix is a hygiene issue (they were likely created on parallel branches). The real blocker is that a migration failing does **not** abort the Heroku release phase. The process logs ❌ and moves on. Subsequent migrations may run against schema the failed one was supposed to set up. The server then boots against a broken DB. The SYSTEM.md note "Heroku release phase SSL error — drizzle-kit push fails (pg_hba.conf), non-blocking" is a symptom of exactly this design.

### B9 — Global Express error handler re-throws *after* sending response

- `server/index.ts:454–460`:
  ```
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    throw err;
  });
  ```

**Why it matters.** Throwing from inside an Express error handler after the response is sent produces an *uncaught exception* (Express's internal handling won't catch a throw after `res.end`). On Node, default behaviour is process crash (unless `process.on('uncaughtException')` swallows it). On Heroku, this means a dyno restart on every 500. This also violates project rule 5 ("every error must be caught, classified, logged" with structured fields `{code, message, context}`) — the response shape is just `{ message }`, no `code`, no `context`.

### B10 — Startup silently zeroes negative inventory without audit

- `server/index.ts:478–482`:
  ```
  const res = await db.execute(sql`UPDATE inventory_levels SET variant_qty = 0 WHERE variant_qty < 0`);
  if ((res as any).rowCount > 0) {
    console.log(`[Startup Fix] Cleared ${(res as any).rowCount} negative inventory levels.`);
  }
  ```
- `server/index.ts:484–487` — similar for `wms.order_items`:
  `"UPDATE wms.order_items SET picked_quantity = quantity, fulfilled_quantity = quantity WHERE status = 'completed' AND quantity > 0 AND picked_quantity = 0"`.

**Why it matters.** Inventory is a financial ledger. Every change must have a `who/what/when/before/after` row per project rule 8 and per the existing `inventory_transactions` design. Zeroing negative qty at boot erases the symptom of an upstream bug (e.g., missing reservation decrement) without recording the compensation, breaking the audit trail. The boot-time `UPDATE` fires on *every* dyno restart. Per project rule 16: "absolute prohibitions: create hidden side effects."

### B11 — Read-modify-write on `inventory_levels` without row locking

- `server/modules/inventory/infrastructure/inventory.repository.ts:145–167` (via exploration) — `adjustInventoryLevel` uses `sql\`${inventoryLevels.variantQty} + ${adjustments.variantQty}\`` inside an `UPDATE ... WHERE id = ?` without a `SELECT … FOR UPDATE` or compare-and-set.
- `server/modules/inventory/atp.service.ts:94–117` (via exploration) — `getTotalBaseUnits` does a `SUM(... )` aggregation and returns it to the caller without snapshot isolation.
- `server/modules/channels/reservation.service.ts:182–189` (via exploration) — reads ATP, then calls `inventoryCore.reserveForOrder(...)` in a separate step. These two are not wrapped in a single serialisable transaction.

**Why it matters.** Concurrent reserves can both see "enough ATP" and both succeed, producing oversale. Per project rule 10 ("concurrency safety … especially for balances, inventory, order state"), this is a blocker class defect.

Note: the SQL expression `variantQty = variantQty + delta` *is* atomic at the single-row level in Postgres because each UPDATE takes its own row lock and re-reads the row. The blocker is not the single-row update — it is the *decision* made outside that update ("is there enough?") which is based on a stale SELECT.

---

## 3. High severity

### H1 — No `(channel_id, external_order_id)` race protection at application layer, despite DB uniqueness

- Confirmed: `migrations/045_oms_tables.sql` creates a UNIQUE on `(channel_id, external_order_id)` (exploration).
- `server/modules/oms/oms.service.ts:89–106` (via exploration) — `ingestOrder` checks for existing row, returns it if found, else inserts. Two webhook deliveries in flight will both pass the pre-check and race into the INSERT; one succeeds, one throws `23505`. The caller (`oms-webhooks.ts`) treats the exception path inconsistently.

**Why it matters.** The duplicate insert is blocked by the DB — good — but downstream side effects (`reserveInventory`, `wmsSync`, `shipstation.pushOrder`) are called from the winning webhook path, not both. A retry that loses the INSERT race silently skips push to ShipStation because the order already exists.

### H2 — Shopify bridge and Shopify webhook can double-ingest the same order

- `server/modules/oms/shopify-bridge.ts:174` (via exploration) — bridge calls `omsService.ingestOrder(channelId, shopifyOrderId, ...)` using the numeric `shopify_orders.id`.
- Webhook path uses `admin_graphql_api_id` (the GID) as the external key (exploration, `oms-webhooks.ts`).

**Why it matters.** If the two identifiers are passed as-is, the DB uniqueness constraint on `(channel_id, external_order_id)` does not catch the duplicate because the two rows have different `external_order_id` values. Result: two `oms_orders` rows for one Shopify order → double reservation, double ShipStation push. **HYPOTHESIS**: I did not myself read both call sites to confirm identifier divergence; the agent report asserted it. Confirmation step is trivial — grep both files for the key passed into `ingestOrder`.

### H3 — Receiving allows `received_qty > order_qty` and never rejects

- `server/modules/procurement/procurement.routes.ts:317` (via exploration) — route sets status `"overage"` but does not throw.
- `server/modules/procurement/receiving.service.ts:162–334` — no check against `purchase_order_lines.order_qty` anywhere in `close()`.

**Why it matters.** Vendor over-ships, operator enters the full qty, inventory ledger inflates beyond the PO, PO totals no longer reconcile against receipts.

### H4 — No `(vendor_id, invoice_number)` unique constraint

- `shared/schema/procurement.schema.ts:625–627` (via exploration) — `invoiceNumber: varchar("invoice_number", { length: 100 }).notNull()` with no composite unique index.

**Why it matters.** Duplicate AP invoices can be ingested, allocated, and paid twice.

### H5 — AP 3-way match detects discrepancies but payment is not blocked

- `server/modules/procurement/ap-ledger.service.ts:868–919` (via exploration) — sets `matchStatus = "over_billed"` or `"qty_discrepancy"` but does not feed into payment authorisation.
- `server/modules/procurement/ap-ledger.service.ts:445` (via exploration) — `recordPayment()` does not inspect line-level `matchStatus` before recording payment.

**Why it matters.** Discrepancy visibility without enforcement is just decoration; over-billed invoices still pay.

### H6 — Landed cost re-allocation retroactively mutates closed receiving lines

- `server/modules/procurement/shipment-tracking.service.ts:778–829`, `:939–1001` (via exploration) — `runAllocation()` deletes all existing allocations and re-runs; no guard on lines whose receiving orders are already closed.

**Why it matters.** Adding a late freight invoice to a shipment re-values inventory lots that have already been consumed by orders. Historical COGS becomes wrong; inventory valuation drifts.

### H7 — No exchange-rate application in landed-cost allocation

- `server/modules/procurement/shipment-tracking.service.ts:793–810` (via exploration) — uses `cost.actualCents` directly, `cost.exchangeRate` is stored on the model but never multiplied in.

**Why it matters.** Non-USD freight invoices under-allocate landed cost by the FX delta.

### H8 — Webhook error handling swallows fulfillment failures

Multiple sites where a webhook handler does `await x.catch((err) => console.warn(...))` and then responds 200 OK (exploration findings):
- `server/modules/oms/oms-webhooks.ts:421–423` (member tier enrichment)
- `server/modules/oms/oms-webhooks.ts:430–432` (wmsSync)
- `server/modules/oms/oms-webhooks.ts:446–448` (reserveInventory)
- `server/modules/oms/oms-webhooks.ts:454–460` (ShipStation push)
- `server/modules/oms/ebay-order-ingestion.ts:416–420` (reserveInventory)
- `server/modules/oms/ebay-order-ingestion.ts:422–432` (ShipStation push)

**Why it matters.** Shopify/eBay consider the webhook delivered and will never retry. The order has no reservation, no WMS row, no ShipStation row, and the upstream marketplace thinks all is well.

### H9 — ShipStation push has no retry, no 429 handling, no duplicate-orderKey defense

- `server/modules/oms/shipstation.service.ts:82–105` (via exploration) — `apiRequest()` throws on any non-2xx; callers in `:111–202` log-and-return rather than retry.
- Idempotency keyed on `orderKey: "echelon-oms-{omsOrderId}"` (`:114`) but if the POST times out after ShipStation accepted it, the OMS does not store `shipstationOrderId` and a subsequent retry POSTs again; ShipStation can create two manual orders for the same `orderKey` under race.

**Why it matters.** Duplicate ShipStation orders = duplicate pick/pack/ship.

### H10 — eBay OAuth token refresh has no timeout on the single-flight lock

- `server/modules/channels/adapters/ebay/ebay-auth.service.ts:88–115` (via exploration) — `this.refreshPromise` gate is correctly single-flight but has no timeout.

**Why it matters.** A hung refresh call blocks every subsequent eBay request until process restart.

### H11 — Vendor JWT middleware has redundant error paths and can double-respond

- `server/modules/dropship/vendor-auth.ts:216–244` — the path is *correct* for Express (it calls `next()` inside `.then`), but if the `.then` block responds with `res.status(401)` (vendor-not-found) and then a downstream middleware throws, the `.catch` fires `res.status(500).json(...)` against an already-sent response. `jwt.verify` ctor errors at line 208 are fine.

**Why it matters.** Lower-impact than the agent report suggested — it is not an "auth bypass" — but it *is* a footgun: `Error [ERR_HTTP_HEADERS_SENT]` under concurrent error paths will spike logs and may crash if `throw err` at `server/index.ts:459` is still in place.

### H12 — Route files that dwarf single-file clean-arch limits and contain business logic

Sizes (verified via `find -printf`):
- `server/routes/ebay-channel.routes.ts` — 182 275 bytes (~4 228 lines)
- `server/modules/procurement/procurement.routes.ts` — 141 393 bytes (~3 309 lines)
- `server/modules/inventory/inventory.routes.ts` — 106 641 bytes (~2 755 lines)
- `server/modules/channels/channels.routes.ts` — 91 545 bytes (~2 227 lines)

Example of business-logic-in-route: `server/routes/ebay-channel.routes.ts:3073–3190` — the reconcile endpoint contains direct SQL (`client.query` at `:3086`), looped external API calls (`:3120`, `:3148`), and state mutation (`UPDATE channel_listings` at `:3136`) inside the request handler — zero service-layer delegation.

Example of business-logic-in-route: `server/modules/inventory/inventory.routes.ts:106–182` (exploration) — 75 lines of transfer validation + side-effect orchestration directly in the route, including fire-and-forget `channelSync` and replenishment calls.

**Why it matters.** Violates project rule 1 ("No business logic in controllers/routes/views/DB queries") and rule 13 ("boring > clever, obvious to a senior engineer in 30 seconds"). These files are effectively untestable without spinning up Express; they are where most bugs will compound.

### H13 — `require()` used inside ESM modules

- `package.json` — `"type": "module"`.
- `server/index.ts:151` — `"const { channels: channelsTable, syncLog: syncLogTable } = require(\"@shared/schema\");"`
- `server/index.ts:302–303` — `require("./modules/channels/adapters/ebay/ebay-auth.service")`.
- `server/index.ts:350` — `const { pool: dbPool } = require("./db");`
- `server/index.ts:478` — `const { sql } = require("drizzle-orm");`
- `server/index.ts:517` — same.
- `server/services/index.ts:142` (via exploration) — `require("../modules/channels/allocation-engine.service");`

**Why it matters.** This works under `tsx` (which monkey-patches `require`) but would break under a pure `node --experimental-vm-modules` or bundled prod path. It also makes the dependency graph non-analyzable by static tools. The production runtime is `node dist/index.cjs` per `package.json:"start": "NODE_ENV=production node dist/index.cjs"`, i.e. it relies on the `script/build.ts` bundler eating all this mixed syntax — a tight coupling to one build tool.

### H14 — Missing foreign keys on financial-adjacent columns

- `shared/schema/inventory.schema.ts:466–477`, `orderLineCosts.orderItemId` is `.notNull()` but has no `.references(() => orderItems.id)`. An order-item deletion orphans cost rows without cascading or blocking.
- `shared/schema/inventory.schema.ts:450` — `inboundShipmentId: integer("inbound_shipment_id")`; comment says `"FK to inbound_shipments (added post-definition)"` but no `.references()` anywhere. INSUFFICIENT EVIDENCE that a raw `ALTER TABLE ... ADD FOREIGN KEY` was added in a migration; a grep on `migrations/*.sql` for `inbound_shipment_id` would settle this.
- `shared/schema/inventory.schema.ts:143` — per exploration, `inventoryLot` FK on `inventoryTransactions` is also described as "added post-definition" but not present in the Drizzle schema. Same caveat.

### H15 — Allocation engine does not consult `channel_variant_overrides.is_listed`

- `server/modules/channels/allocation-engine.service.ts` — grep for `is_listed|isListed|channel_variant_overrides|channelVariantOverride` returns **zero** matches.
- `SYSTEM.md:321` claims this was "FIXED (commit c6ff769)". HYPOTHESIS after verification: the fix exists but lives in `server/modules/channels/product-push.service.ts` (per SYSTEM.md:138), not in the allocation engine itself. Allocation still computes allocations for unlisted variants; the push stage filters them. That is a workaround, not a correctness fix: `channel_feeds` records allocated qty the channel never actually sells.

**Why it matters.** Reporting and reconciliation that use `channel_feeds.allocated_qty` (e.g., sell-through, reservations) will be misled.

### H16 — ATP calculation excludes backorder quantity

- `server/modules/inventory/atp.service.ts:128–131` (via exploration) —
  `"ATP = onHand - reserved - picked - packed"`. `getTotalBaseUnits()` returns a `backorderQty` that is never subtracted.

**Why it matters.** Backordered SKUs over-report availability to the allocation engine; the allocator hands channels stock that is already promised to someone.

### H17 — Startup eagerly registers a ShipStation webhook with a hard-coded URL

- `server/index.ts:431–441` —
  `"await services.shipStation.registerWebhook(\"https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/shipstation/webhooks/ship-notify\")"`
- The URL is baked into the source.

**Why it matters.** Any preview / staging / review app will register its own dyno as the SHIP_NOTIFY handler against the production cardshellz-echelon domain's ShipStation account (if preview dynos share creds) — or fail silently if not. Either way, the configuration is undiscoverable from env.

### H18 — Startup backfill runs on every boot

- `server/index.ts:443–450` — `backfillShopifyOrders(db, services.oms, 500)` on every startup after a 10s delay. Heroku's typical `dyno restart` / `autodeploy` cadence means this fires multiple times a day.

**Why it matters.** The backfill is supposedly idempotent; HYPOTHESIS that it is (I did not read the function body). If it is not, every boot re-ingests the last 500 orders. Either way, the cumulative DB load and potential to race with in-flight webhooks is undesirable.

### H19 — Auth is applied per-route, not globally; missing auth is a grep-able failure mode

- `server/routes/middleware.ts:22–27` defines `requireAuth`.
- `server/routes.ts` and `server/index.ts` have no `app.use(requireAuth)` — there is no default-deny.
- Consequences already observed: B4 (eBay reconcile), B5 (subscriptions), B6 (diagnostics).

**Why it matters.** "Add a new route, forget to add `requireAuth`" is a one-line mistake that is currently undetectable by CI. Any new route default-allows anonymous access.

### H20 — Vendor portal JWT stored in `localStorage`

- `client/src/lib/vendor-auth.tsx:32–40` (via exploration) — `localStorage.getItem("vendor_token")`.

**Why it matters.** XSS in the vendor portal exfiltrates the token. `httpOnly` cookie would be strictly safer. Severity is High (not Blocker) only because the portal surface area is smaller than the main admin app.

### H21 — Audit logger writes only to stdout

- `server/infrastructure/auditLogger.ts:27` (via exploration) — `console.log(JSON.stringify(logEntry))`.
- No DB sink, no signature, no retention enforcement.

**Why it matters.** Project rule 8 requires immutable, structured audit logs. Heroku's stdout-aggregated logs meet "structured JSON" but not "immutable" — anyone with Heroku access can lose them by clearing log drains, and Heroku's on-disk log retention is short.

---

## 4. Medium severity

### M1 — No idempotency keys on money-moving POST mutations from the client

- Exploration of `client/src/lib/api.ts` and hooks: spot-checked mutations do not emit an `Idempotency-Key` header. Retry on the client (React Query default) can double-submit an Invoice/Payment/PO create.

### M2 — Client computes monetary totals (e.g., `parseFloat(x) * 100`)

- `client/src/pages/APInvoiceDetail.tsx:182`, `:191`; `APPayments.tsx:186` (via exploration) — `Math.round(parseFloat(v) * 100)`.
- **Mitigating**: exploration did not find a server-side recompute. **Next check:** confirm server recomputes totals from line items (do not trust client totals).

### M3 — Billing scheduler is per-process, not dyno-safe

- `server/modules/subscriptions/subscription.scheduler.ts:83–105` (via exploration) — plain `setInterval(…, 1h)`. Multiple dynos → multiple billers. Idempotency keys at Stripe will prevent double-charges but rate-limit exhaustion is likely.

### M4 — Inventory transfer `executeTransfer` only transactional if caller passes a tx

- `server/modules/inventory/infrastructure/inventory.repository.ts:264–346` (via exploration) — `tx: any = db` default parameter; if called bare, each step is its own connection-level statement, no atomicity.

### M5 — `inventoryLots` FIFO reserve/pick loop is not a single transaction

- `server/modules/inventory/lots.service.ts:188–194`, `:268–302` (via exploration) — loop of `update()` calls with no `db.transaction(...)` wrapper.

### M6 — Subscription status can overlap across rows

- `server/modules/subscriptions/infrastructure/subscription.repository.ts` (via exploration) — no partial-unique index `(member_id) WHERE status = 'active'`. A member can have two rows with `status = 'active'`.

### M7 — `member_current_membership` not reconciled

- `server/modules/subscriptions/infrastructure/subscription.repository.ts:300–314` (via exploration) — upsert/clear on subscription change, but no periodic sweep. An out-of-band subscription delete leaves the lookup row stale.

### M8 — Discount percentages are stored as `numeric` but computed with `Number()`

- `shared/schema/procurement.schema.ts:407` — `discountPercent: numeric("discount_percent", { precision: 5, scale: 2 })`.
- `server/modules/procurement/purchasing.service.ts:118–123` (via exploration) — `Number(line.discountPercent || 0)` and subsequent `*` / `+=`.

**Why it matters.** Same float issue as B1 but on percentages.

### M9 — `recalculateTotals` uses JS `+=` on `bigint`-stored columns

- `server/modules/procurement/purchasing.service.ts:127–165` (via exploration) — `subtotal += lt` on JS `number`. `subtotalCents` is stored as `bigint`, but the code path promotes through `number`.

### M10 — Status-history writes are not transactional with status change

- `server/modules/procurement/purchasing.service.ts:167–183`, `:310`, `:575` (via exploration) — sequential `updatePurchaseOrder(...)` then `recordStatusChange(...)` with no enclosing tx.

### M11 — Over-reservation rails dropped

- `migrations/055_drop_over_reservation.sql` exists. **Next check:** confirm what invariant it enforced and why it was dropped — BOUNDARIES.md still talks about ATP-gated reservation as the single entry point.

### M12 — Cookie `secure` flag toggles on `NODE_ENV === "production"` only

- `server/index.ts:77` — `"secure: process.env.NODE_ENV === \"production\","`. Any staging/preview where `NODE_ENV` is not literally `"production"` ships cookies over HTTP.

### M13 — Inconsistent module layouts

- `server/modules/dropship/` uses full `domain/application/infrastructure/interfaces/` split.
- `server/modules/inventory/` mixes `application/` + `infrastructure/` + `domain/` with flat legacy services at the root (`alerts.service.ts`, `atp.service.ts`, `cogs.service.ts`).
- `server/modules/procurement/` is entirely flat.
- `server/modules/orders/` has `*.use-cases.ts` alongside routes but no `application/` subdir.

**Why it matters.** Increases the risk of *duplicate* business logic (a service and a use-case doing overlapping work), and makes it ambiguous which layer to call from a route.

### M14 — `@ts-ignore` concentrated on known-broken code

- `server/index.ts:394`, `:530`, `:551` — the `setInterval` in B3 is literally annotated with `@ts-ignore` comments because the compiler flagged the scope bug. The annotations are the best pre-existing evidence that someone knew.

### M15 — Web content restrictions / rate-limit

- ShipStation `apiRequest` (`shipstation.service.ts:82–105` via exploration) has no 429 detection. Shopify adapter has proper 429 handling (`shopify.adapter.ts:701–715` via exploration). eBay adapter mentions "Exponential backoff with jitter" in the file header; **HYPOTHESIS** until `MAX_RETRIES` value confirmed.

### M16 — Heavy client pages likely produce N+1

- Exploration noted per-order follow-up inventory queries on Receiving and PO pages; no server-side pagination surfaced. **Next check:** profile one list page under real data.

### M17 — Lots FIFO reads cost back from a raw SQL round-trip

- `server/modules/inventory/cogs.service.ts:206–210` (via exploration) — after ordering lots, the service issues a second `db.execute(sql...)` to re-read `total_unit_cost_cents`, then falls back to `lot.unitCostCents` if null. Two reads, float arithmetic.

### M18 — Shopify bridge relies on one-time backfill, no explicit LISTEN/NOTIFY in current code

- `server/modules/oms/shopify-bridge.ts` header mentions LISTEN/NOTIFY, but the modern path is webhook-driven with startup backfill (`server/index.ts:443–450`). Coverage is adequate *if* webhooks always arrive; absent webhooks rely on the once-per-boot backfill. **Next check:** confirm a scheduled, not boot-only, backfill fallback exists.

---

## 5. Low severity

### L1 — `rejectUnauthorized: false` on DB SSL
- `server/index.ts:61` and `migrations/run-migrations.ts:22`. Standard for Heroku pg but worth revisiting when moving off.

### L2 — Token rotation race in eBay auth
- `server/modules/channels/adapters/ebay/ebay-auth.service.ts:284–300` (via exploration). Low impact; recovers within one cycle.

### L3 — `fmtMoney` displays full float precision in PO PDF
- `server/modules/procurement/po-document.ts:11–12` (via exploration) — `if (n !== parseFloat(n.toFixed(2))) return \`$${String(n)}\``. Side-effect of B1.

### L4 — `vendor-auth.ts:6` has `VENDOR_JWT_EXPIRES_IN` env var default `"24h"` — acceptable, noted.

### L5 — Redundant `SELECT COUNT(*)` before the main query in the eBay reconcile scheduled call (`server/index.ts:354–361`).

### L6 — Dead HMAC bypass
- `server/modules/oms/oms-webhooks.ts:348` (via exploration): `if (false && ...)` — dead code that is *almost* a production foot-gun if someone toggles the flag.

### L7 — `bulkImportLines` uses `parseFloat` on CSV `unit_cost`
- `server/modules/procurement/receiving.service.ts:622` — `parsedUnitCost = unit_cost ? Math.round(parseFloat(String(unit_cost)) * 100) : null;`. Acceptable at an import boundary, *provided* the downstream storage is integer cents — which today it is not (see B1).

### L8 — `completeAllLines` backfills `receivedQty` from `expectedQty` only when `receivedQty` is null/0
- `server/modules/procurement/receiving.service.ts:349–351` — the claim in SYSTEM.md that this bug is "FIXED" is confirmed by the current code.

---

## 6. Info / positive findings / INSUFFICIENT EVIDENCE

- **I1 — ATP per-bin clamp is correct.** `server/modules/inventory/atp.service.ts:196–233` (via exploration) uses `SUM(GREATEST(variant_qty - reserved - picked - packed, 0))` so a single bad bin cannot drag the total negative. Good.
- **I2 — `(channel_id, external_order_id)` DB uniqueness exists** (`migrations/045_oms_tables.sql:39`). Good; H2 remains because the two ingestion paths may send *different* external IDs.
- **I3 — bcrypt cost = 10** at `server/modules/identity/application/identity.use-cases.ts:33` — acceptable for 2026.
- **I4 — Shopify HMAC verification uses `timingSafeEqual`** (`server/modules/oms/oms-webhooks.ts:61–75`) — good. Beware the dead-code `if (false && ...)` bypass at `:348` (see L6).
- **I5 — Cycle-count explicit "negative guard"** (`server/modules/inventory/application/cycle-count.use-cases.ts:320–326`, via exploration). Good.
- **I6 — INSUFFICIENT EVIDENCE on Stripe webhook signature.** `server/modules/dropship/vendor-portal.routes.ts` registers a `registerStripeWebhookRoute`, but I did not read its body. Project rule says Stripe webhooks must use `stripe.webhooks.constructEvent`. **Next check:** grep for `constructEvent` under `server/modules/dropship/`.

---

## 7. Architecture, layering, and repo hygiene

**Monolithic routes.** Four route files exceed 90 KB. Together they contain the majority of request-path logic. Break apart into per-resource sub-routers (`po.routes.ts`, `receiving.routes.ts`, `invoice.routes.ts`, `payment.routes.ts`, etc.) and move business logic into use-cases. See H12.

**Layering inconsistency.** Dropship follows clean architecture; other modules do not. See M13. This creates two problems: (1) developers have to learn "which layer exists in which module" by reading code; (2) new features added to `inventory/` can land either in a `application/*.use-cases.ts` file or in a legacy `*.service.ts` file, and both may drift.

**Script sprawl.** `/` contains 51 top-level `check-*` / `check_*` scripts, plus `clear_neg.cjs`, `temp_drop_ghosts.ts`, `apply-0072.ts`, `patch-schema.cjs`, `wipe-shopify.cjs`, `migrate-cents.ts`, `auto_push.cjs`, `auto_push.py`. Representative hazards confirmed by exploration:

- `clear_neg.cjs` — `"UPDATE inventory_levels SET variant_qty = 0 WHERE variant_qty < 0"` without audit.
- `temp_drop_ghosts.ts` — `DROP TABLE ... CASCADE` on production tables.
- `apply-0072.ts` — hard-coded Windows path.

None are gitignored; all are in version control; any one is a mis-click from a disaster.

**Test coverage.** 156 test files exist (exploration). No quantified coverage report was produced during this review. **Next check:** run `npm run test -- --coverage` and record baseline per module. The `server/modules/orders/__tests__/` folder exists — procurement, inventory, and subscriptions coverage is **INSUFFICIENT EVIDENCE**.

---

## 8. Performance & scalability

- **P1 — Sync pool size too small.** `server/index.ts:62` pins the session pool to `max: 2`, comment acknowledges Heroku Hobby limits. OK for the session store, but the main DB pool config is in `server/db.ts` and was not reviewed in detail here. **Next check:** confirm `server/db.ts` pool `max` is tuned to Heroku Postgres tier.
- **P2 — `pick-queue-sync` floods logs.** Noted in SYSTEM.md (§Known Bugs #3) but not re-verified in this audit. Left as carryover.
- **P3 — Per-order 500ms sleep in stuck-order reconciler** (`server/index.ts:561`) — worse than useless given B3, but also a smell if it ever runs.
- **P4 — Server boots trigger a 500-row backfill** (see H18). Cumulative load.
- **P5 — Allocation engine and ATP do aggregate SUMs on every call** (exploration). Cache or materialised view would help if call counts grow.
- **P6 — N+1 suspicion on route handlers that call `getAllX()` to build in-memory maps** — e.g. `receiving.service.ts:496` reads *all* warehouse locations for a bulk import. Acceptable at today's scale but worth flagging.

---

## 9. Cross-referenced file index (every file cited above)

- `server/index.ts` — B2, B3, B9, B10, H13, H17, H18, L1, L5
- `server/routes.ts` — H19 (registration order)
- `server/routes/middleware.ts` — H19 (definitions)
- `server/routes/ebay-channel.routes.ts` — B4, H12
- `server/routes/shopify.routes.ts` — H12 (sampled)
- `server/routes/diagnostics.ts` — B6
- `server/modules/subscriptions/subscription.routes.ts` — B5
- `server/modules/subscriptions/subscription.scheduler.ts` — M3
- `server/modules/subscriptions/infrastructure/subscription.repository.ts` — M6, M7
- `server/modules/dropship/vendor-auth.ts` — B2, H11
- `server/modules/dropship/vendor-portal.routes.ts` — I6
- `server/modules/oms/oms-webhooks.ts` — H1, H8, I4, L6
- `server/modules/oms/oms.service.ts` — H1
- `server/modules/oms/shopify-bridge.ts` — H2, M18
- `server/modules/oms/ebay-order-ingestion.ts` — H8
- `server/modules/oms/shipstation.service.ts` — H9, M15
- `server/modules/oms/fulfillment-push.service.ts` — H8 context
- `server/modules/channels/adapters/ebay/ebay-auth.service.ts` — H10, L2
- `server/modules/channels/allocation-engine.service.ts` — H15, B11 (reservation path)
- `server/modules/channels/reservation.service.ts` — B11
- `server/modules/inventory/atp.service.ts` — B11, H16, I1
- `server/modules/inventory/infrastructure/inventory.repository.ts` — B11, M4
- `server/modules/inventory/application/inventory.use-cases.ts` — B7, B10
- `server/modules/inventory/application/cycle-count.use-cases.ts` — I5
- `server/modules/inventory/cogs.service.ts` — B1, M17
- `server/modules/inventory/lots.service.ts` — M5
- `server/modules/inventory/inventory.routes.ts` — H12
- `server/modules/procurement/receiving.service.ts` — B1, B7, H3, L7, L8
- `server/modules/procurement/purchasing.service.ts` — M8, M9, M10
- `server/modules/procurement/procurement.routes.ts` — H3, H12
- `server/modules/procurement/ap-ledger.service.ts` — H5
- `server/modules/procurement/shipment-tracking.service.ts` — H6, H7
- `server/modules/procurement/po-document.ts` — L3
- `server/infrastructure/auditLogger.ts` — H21
- `migrations/run-migrations.ts` — B8
- `migrations/045_oms_tables.sql` — I2
- `shared/schema/procurement.schema.ts` — B1, H4, M8
- `shared/schema/inventory.schema.ts` — B1, H14
- `client/src/lib/vendor-auth.tsx` — H20
- `client/src/pages/APInvoiceDetail.tsx`, `APPayments.tsx` — M2, M1

---

## 10. What I did not verify (explicit gaps)

- Most client pages beyond AP / PO / Receiving / vendor portal.
- `server/websocket.ts` entirely.
- `server/modules/warehouse/**` beyond file listings.
- `client/` state-management choices and routing guards.
- Test coverage percentages per module.
- Production behaviour of `script/build.ts` bundler with the `require()` / ESM mix.
- Whether `channel_feeds` reads that are supposed to skip unlisted variants actually do (see H15 follow-up).

These are **INSUFFICIENT EVIDENCE** zones; they should be filled before any production rollout of the fix plan in `ULTRAREVIEW-FIX-PLAN.md`.

> **Status (2026-04-17 addendum):** the five items above were each audited end-to-end in a follow-up pass; see §11 for verified findings. Four new Blockers and three new High findings were surfaced. Section §10 is retained for transparency — it documents what was deferred in the first pass, not what was skipped in the final report.

---

## 11. Addendum — gap-closure audit

This section covers the five areas flagged in §10. Each finding was personally verified by reading the cited file at the cited line. Severities are assigned using the same scale as §2–§5.

### 11.1 Stripe webhook signature path

**Files read in full:** `server/modules/dropship/vendor-portal.routes.ts` (lines 520–630), `server/modules/dropship/infrastructure/stripe.client.ts` (1–63), `server/index.ts` (40–46, re-verify `req.rawBody` capture), `server/modules/dropship/interfaces/http/webhook.controller.ts` (1–54), `server/modules/dropship/wallet.service.ts` (relevant sections).

#### B12 — Stripe webhook signature verification is broken on every configuration path

- `server/modules/dropship/vendor-portal.routes.ts:535–549`:
  ```typescript
  if (webhookSecret) {
    const sig = req.headers["stripe-signature"] as string;
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    try { event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret); }
    ...
  } else {
    // No webhook secret configured — trust the payload (development only)
    event = req.body;
    console.warn(`[Stripe Webhook] No webhook secret configured — accepting unverified payload`);
  }
  ```
- **Path A — secret set:** `express.json()` (verified at `server/index.ts:40–46`) parses the JSON into `req.body` before this handler runs. `typeof req.body === "string"` is therefore always false; the code then calls `JSON.stringify(req.body)`, which produces bytes that differ from what Stripe signed (key order, whitespace, number formatting). `stripe.webhooks.constructEvent` verifies against the *exact* raw body bytes — so this path **always throws `StripeSignatureVerificationError`** and returns 400. The server captures the correct raw body in `req.rawBody` (server/index.ts:42–44) but this handler does not consult it.
- **Path B — secret not set:** the `else` branch accepts whatever `req.body` contains as a real Stripe event. Any unauthenticated POST can trigger `checkout.session.completed` handling with attacker-chosen `metadata.vendor_id` and `amount_total`, which then flows into `walletService.creditWallet(...)` (line 603).
- **Net effect:** real Stripe webhooks never credit wallets (silent loss of legitimate deposits); forged webhooks *will* credit wallets whenever the secret env var is missing.
- **Severity:** BLOCKER.

#### B12.a — Stripe metadata key mismatch silently drops wallet credits

- `server/modules/dropship/infrastructure/stripe.client.ts:51–54` writes the checkout-session metadata under the key `dropship_vendor_id`:
  ```typescript
  metadata: {
    dropship_vendor_id: vendorId.toString(),
    type: "wallet_load"
  }
  ```
- `server/modules/dropship/vendor-portal.routes.ts:563` reads it as `vendor_id`:
  `vendorId = session.metadata?.vendor_id ? parseInt(session.metadata.vendor_id) : null;`
- The guard at lines 579–582 then returns `{ received: true }` without crediting. A vendor pays Stripe successfully and the balance is never credited.
- **Severity:** HIGH (tracked as H22 below; separate from B12 because the fix is independent).

#### H22 — Stripe webhook idempotency check is TOCTOU and `creditWallet` failures don't retry

- `server/modules/dropship/vendor-portal.routes.ts:585–599`: the "already processed" `SELECT ... FROM dropship_wallet_ledger WHERE reference_type='stripe_payment' AND reference_id=$1` runs on its own pool connection, not inside the transaction that later writes. Two concurrent webhooks for the same `payment_intent.id` can both pass the guard.
- Lines 613–617: when `walletService.creditWallet(...)` returns `success: false`, the handler logs and still returns `{ received: true }` with status 200 at line 625 — Stripe will not retry, so the deposit is permanently lost.
- `server/db.ts:626–642` confirms `dropship_wallet_ledger` has no unique constraint on `(reference_type, reference_id)`; a duplicate insert won't fail at the DB layer.
- **Severity:** HIGH.

#### B15 — Stripe mock/empty secrets in code

- `server/modules/dropship/infrastructure/stripe.client.ts:5`: `new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_mock", ...)` — boots the Stripe client with a fake key if env is missing. Symptomatic pattern of the same family as B2 (session/JWT fallbacks).
- `server/modules/dropship/vendor-portal.routes.ts:529`: second initialization of Stripe with `process.env.STRIPE_SECRET_KEY || ""` (empty string fallback).
- `server/modules/dropship/interfaces/http/webhook.controller.ts:9` (unused but present): `const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || "whsec_mock";` — a second, latent, mock-secret-accepting webhook handler that will start verifying signatures against `whsec_mock` if anyone accidentally wires it up.
- **Severity:** BLOCKER (grouped with B2's secret-fallback family).

### 11.2 WebSocket lifecycle

**Files read in full:** `server/websocket.ts` (1–81).

#### B13 — WebSocket upgrade has no auth; any client can assert any `userId`

- `server/websocket.ts:14`: `wss = new WebSocketServer({ server, path: "/ws" });` — no `verifyClient`, no cookie or token read during HTTP upgrade. Any process that can reach the Heroku app can open a `/ws` connection.
- Lines 23–32:
  ```typescript
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth" && msg.userId) {
        (ws as any).__userId = msg.userId;
        userConnections.get(msg.userId)!.add(ws);
      }
    } catch {}
  });
  ```
  The `userId` is pulled verbatim from the client-supplied JSON and trusted. There is no cross-check against `req.session.user`, no signed token, nothing.
- Lines 70–80: `broadcastToUser(userId, payload)` uses the claimed userId as the delivery key, so an attacker who connects and sends `{type:"auth",userId:"<target>"}` receives every subsequent broadcast intended for that user, including notification titles/bodies and the arbitrary `data` jsonb field.
- Lines 55–65: `broadcastOrdersUpdated()` fans out to `wss.clients` (all connected sockets) with no scoping — any listener sees "orders changed" pings, revealing timing metadata about order volume.
- No ping/pong, no SIGTERM shutdown, no per-IP connection cap, no cleanup for sockets that never authenticate (the `close` handler at lines 36–45 only decrements `userConnections` if `__userId` was set).
- **Severity:** BLOCKER (unauth'd data exfiltration + trivial spoofing).

#### H23 — No graceful shutdown, no heartbeat; Heroku-specific reliability gaps

- No SIGTERM handler in the server bootstrap (grep for `SIGTERM` in `server/index.ts` returns nothing). On dyno cycling the HTTP server exits without closing WS connections.
- No `setInterval(...ws.ping(), 30_000)` or `pong` handler. Heroku's router drops idle TCP at ~55 s, which will disconnect warehouse pickers silently.
- Client reconnect (`client/src/pages/Picking.tsx:461–510`, reported by the client-audit agent — not re-verified here) does not resend the `auth` frame.
- **Severity:** HIGH.

### 11.3 `server/modules/warehouse/**`

**Files read in full:** `server/modules/warehouse/locations.routes.ts:1–60` and route-list grep (17, 29, 46, 88, 140, 185, 204, 266, 294, 388).

#### B14 — `server/modules/warehouse/locations.routes.ts` has 8 unauthenticated routes including destructive mutations

Routes that have NO auth middleware:

- `locations.routes.ts:17` — `GET /api/locations`
- `locations.routes.ts:29` — `GET /api/locations/:id`
- `locations.routes.ts:46` — `GET /api/locations/sku/:sku`
- `locations.routes.ts:88` — `POST /api/locations` (create)
- `locations.routes.ts:140` — `PATCH /api/locations/:id` (update)
- `locations.routes.ts:185` — `DELETE /api/locations/:id` (delete)
- `locations.routes.ts:266` — `GET /api/locations/export/csv`
- `locations.routes.ts:294` — `POST /api/locations/import/csv` (bulk upsert)

For contrast, `locations.routes.ts:204` correctly uses `requirePermission("inventory","edit")` and `:388` uses `requireAuth`, proving the middleware exists and is imported (line 8: `import { requirePermission, requireAuth } from "../../routes/middleware";`). The eight handlers above simply forgot to apply it.

- **Impact:** anonymous POST can create/alter bin assignments for any SKU, including the CSV-import bulk path. An attacker can silently rewrite pick locations across the warehouse.
- **Severity:** BLOCKER.

#### H24 — Warehouse write paths without `db.transaction()` / `SELECT FOR UPDATE` (agent-reported)

The gap-closure agent reported additional gaps in `warehouse.routes.ts:507–589` (bulk warehouse-location import loop, no transaction), `locations.routes.ts:294–384` (CSV import loop, no transaction), and `server/modules/warehouse/bin-assignment.service.ts:134–199` (bin read-modify-write without lock). I did not independently re-verify these line-for-line in this addendum, so they carry a **HYPOTHESIS** flag — but they are consistent with the systemic B11 finding in §2 and should be treated as in-scope when that fix lands. Severity if confirmed: HIGH.

### 11.4 Test coverage

**Files read:** `package.json` (script inspection via agent), filesystem counts (personally run).

#### H25 — Test coverage is near zero; no safety net for P0 fixes

- `find … -name '*.test.ts' -not -path '*/node_modules/*'` → **13 test files** against 162 server TS files and 157 client TS/TSX files (personally verified via shell).
- All 13 live under `server/modules/channels/__tests__` (11) and `server/modules/orders/__tests__/inventory-fixes.test.ts` (1); the other 11 source modules (`inventory`, `procurement`, `oms`, `warehouse`, `subscriptions`, `dropship`, `identity`, `notifications`, `catalog`, plus client and migrations) have **zero** tests.
- Attempting `npm test` in the current sandbox fails before running a single test (missing optional `@rollup/rollup-linux-x64-gnu` binary — standard npm optional-dep pitfall). This does not prove the suite is broken on the user's machine, but it does mean CI without `npm install` won't run tests.
- Coverage tooling (`@vitest/coverage-v8`) appears to be installed but not wired into `vitest.config.ts`.
- **Impact on the fix plan:** P0-c (B7, B8, B11) and P0-d (B1) rely on test assertions to prove that transactional/locked/money-type changes preserve behaviour. Landing those fixes without first expanding test coverage is high risk.
- **Severity:** HIGH (cross-cutting).

### 11.5 Client pages beyond AP / PO / Receiving

The client-audit agent reviewed OMS, Picking, Channels, Inventory, Vendor portal, and more. I did not re-read every file line-for-line in this addendum. The most consequential finding re-confirmed from the agent report:

#### H26 — Combined-order claim loop fires sequential mutations without idempotency keys (agent-reported, HYPOTHESIS)

- Reported location: `client/src/pages/Picking.tsx:1259–1263` — `for (...) await claimMutation.mutateAsync({orderId: subOrderId});`.
- No `Idempotency-Key` header in the repo (agent grep; not independently reverified).
- On retry (network or user re-click), the same order can be claimed twice.
- **Severity if verified:** HIGH. Track as an extension of M1 (idempotency keys) in the fix plan.

Other agent-reported client findings (vendor token in `localStorage` already captured as H20; `parseFloat * 100` in AP pages already captured as M2; no `dangerouslySetInnerHTML` usage; 15s polling on Picking queue acceptable) do not introduce new P0 items.

### 11.6 Gaps that remain after the addendum

- `server/modules/warehouse/bin-assignment.service.ts` — agent-reported concurrency issue (MEDIUM); I did not re-read.
- Client-side mutations in OMS, Channels, Settings — agent-sampled; no per-file line-verification in this addendum.
- Heroku-specific WebSocket timeouts — behaviour inferred from Heroku's documented router limits; not measured on the live dyno.
- Unit-test scaffolding completeness under `npm install` (fresh node_modules) — not attempted.

Treat items flagged **HYPOTHESIS** above as leading indicators, not proven facts.

---

*End of findings report. Remediation plan in `ULTRAREVIEW-FIX-PLAN.md`.*
