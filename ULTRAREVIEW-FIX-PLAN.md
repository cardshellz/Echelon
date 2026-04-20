# ULTRAREVIEW — Prioritized Fix Plan

Companion to `ULTRAREVIEW.md`. Every `B#/H#/M#/L#` reference below points back to the finding of the same ID in that report.

- **Philosophy:** financial-audit grade. Ship the smallest, safest change that closes the specific risk; do not refactor unrelated code in the same PR. Every fix must be transactional where money/inventory moves, idempotent where it can be retried, and covered by at least one test before merge.
- **Legend for each fix:**
  - **What:** the concrete code change
  - **Files:** primary files touched (non-exhaustive)
  - **Effort:** S (≤ ½ day), M (½–3 days), L (1–2 weeks), XL (2+ weeks / multi-PR)
  - **Risk:** probability the fix itself introduces regressions
  - **Tests required:** minimum bar before merging
  - **Depends on:** earlier fixes that must land first

---

## Executive sequencing

| Tier | When | What lands | Deliverable |
|------|------|------------|-------------|
| **P0-a** | Day 0 (today/tomorrow) | Hot-patch one-line blockers | `B3, B9, B10, L6` |
| **P0-b** | Week 1 | Close all public/insecure routes + webhook auth | `B2, B4, B5, B6, B12, B13, B14, B15, H19, H20, H22, H23, L1` |
| **P0-c** | Week 2–3 | Transactional + locked money paths | `B7, B8, B11` |
| **P0-pre-d** | Week 3–4 | Test-safety-net gate | `H25` (see P0-pre-d below) |
| **P0-d** | Week 4–7 | Money-type migration | `B1` (feature branch, phased) |
| **P1** | Month 2 | High findings | `H1–H18, H21, H24, H26` |
| **P2** | Month 3–4 | 18 Medium findings | `M1–M18` |
| **P3** | Backlog | Hygiene | `L1–L8` |

Rationale: P0-a are ≤10-line patches with near-zero regression risk and high blast-radius upside (crash every N minutes, auth bypass fallback secrets). P0-b closes the auth holes a grep has already proven exist, including the Stripe webhook (which is broken on every configuration path — see B12) and the `/ws` endpoint (no auth, spoofable identity). P0-c makes the receiving/inventory paths safe under concurrency. **New gate P0-pre-d** — a test-scaffolding pass — sits between P0-c and the money-type migration, because H25 proved the repo has 13 tests against 300+ source files; B1 cannot ship safely without a real property-test suite for money math.

A hard blocker on P0-b is a permanent production deploy gate: once `SESSION_SECRET`, `VENDOR_JWT_SECRET`, `STRIPE_SECRET_KEY`, and `STRIPE_DROPSHIP_WEBHOOK_SECRET` are required (no fallback), the next boot without them set in Heroku will crash. Verify the config-vars are set in every environment *before* the PR merges.

---

## P0-a — Hot patches (Day 0)

These are surgical, ≤10-line changes that remove known correctness holes with minimal regression risk. Ship independently; do not bundle with other work.

### P0-a-1 · B3 — Move `setInterval` eBay reconciler inside the startup IIFE

- **What:** Cut the block at `server/index.ts:514–566` and paste it immediately before the IIFE's closing `})();` so the `services` and `logger` references it uses are actually in scope. Also guard with `process.env.DISABLE_SCHEDULERS === 'true'` short-circuit so `NODE_ENV=test` and single-purpose scripts don't boot the scheduler.
- **Files:** `server/index.ts`
- **Effort:** S (≤ 30 min)
- **Risk:** Low. The code currently throws on every tick, so any working path is strictly better. Keep the same cadence (`setInterval(..., 5 * 60 * 1000)`).
- **Tests required:**
  - Unit: spin up the IIFE in a test harness with `DISABLE_SCHEDULERS=true` and assert `setInterval` is not registered.
  - Manual: boot once with flag off, assert first tick does not throw (check log line).
- **Depends on:** none.

### P0-a-2 · B9 — Stop re-throwing after `res.json(...)` in the global error handler

- **What:** In `server/index.ts:459`, delete the `throw err;` statement that follows the JSON response. Log the error instead and return. Re-throwing after `res.json()` corrupts the HTTP/1.1 keepalive state and in some configurations crashes the worker.
- **Files:** `server/index.ts`
- **Effort:** S (≤ 15 min)
- **Risk:** Low — current behavior is strictly worse (double-response / crash). Confirm no upstream handler depends on the re-throw (grep for `process.on('uncaughtException')` wiring).
- **Tests required:**
  - Unit: mount a test route that throws; assert status code + JSON body; assert no unhandled rejection.
- **Depends on:** none.

### P0-a-3 · B10 — Remove the startup negative-inventory zeroing mutation

- **What:** Delete the `UPDATE inventory_levels SET qty_on_hand = 0 WHERE qty_on_hand < 0` (or equivalent — `server/index.ts:479`-area) call that runs on boot. Replace with a read-only warning log and a row into a new `startup_inventory_anomalies` table (schema below) so anomalies are surfaced, not silently erased.
- **Files:** `server/index.ts`; new migration `migrations/XXXX_startup_inventory_anomalies.sql`.
- **Effort:** S (½ day including the tiny migration).
- **Risk:** Low. The mutation is destroying audit evidence today; turning it into a log is safer.
- **Tests required:**
  - Unit: seed a row with `qty_on_hand = -5`, boot the startup hook, assert row unchanged and anomaly row written.
- **Depends on:** none. (Coordinates with B11: once locking is in, negatives should be impossible.)

### P0-a-4 · L6 — Delete the dead HMAC-bypass branch

- **What:** Remove the code path that short-circuits HMAC validation when `NODE_ENV !== 'production'` (or similar). Dead code around conditional HMAC checks invites a future regression where an env var leaks `production` and disables verification.
- **Files:** grep for `hmac` / `NODE_ENV` together in `server/modules/channels/shopify-webhooks.ts`, `server/routes/shopify.routes.ts` — location cited in ULTRAREVIEW §L6.
- **Effort:** S.
- **Risk:** Low — removing dead code.
- **Tests required:** existing webhook signature tests must keep passing; add a negative test that a request with an invalid HMAC is rejected in every NODE_ENV.
- **Depends on:** none.

---

## P0-b — Close all public/insecure routes (Week 1)

### P0-b-1 · B2 — Remove default secrets and fail-fast on missing env

- **What:** Replace `const VENDOR_JWT_SECRET = process.env.VENDOR_JWT_SECRET || "vendor-jwt-secret-change-me";` (`server/modules/dropship/vendor-auth.ts:5`) and the session-secret equivalent (`server/index.ts:73`) with a `requireEnv("VENDOR_JWT_SECRET")` helper that throws at boot if unset. Set both in Heroku config-vars for every environment *before* merging. Rotate both secrets after merge (since the defaults may have been deployed).
- **Files:** `server/index.ts`, `server/modules/dropship/vendor-auth.ts`, new `server/lib/requireEnv.ts`.
- **Effort:** S (code) + operational coordination (config-var rollout + rotation).
- **Risk:** Medium — a missed env set in any environment will crash the app at boot. Mitigate by deploying the env var in every environment in a separate PR *before* the code change.
- **Tests required:**
  - Unit: `requireEnv` throws with a useful message when var is missing.
  - Integration: boot with var unset → process exits with non-zero code and a clear log line.
  - Manual: verify Heroku `heroku config -a echelon` has both vars in prod, staging, review apps.
- **Depends on:** none.

### P0-b-2 · B4 — Auth the eBay reconcile route

- **What:** Add `requireInternalApiKey` (for scheduler callers) *or* `requireAuth + requirePermission("channels:reconcile")` (for admin UI) to `app.post("/api/ebay/listings/reconcile", ...)` at `server/routes/ebay-channel.routes.ts:3073`. The `_internal=1` query param is not auth; delete it.
- **Files:** `server/routes/ebay-channel.routes.ts`, `server/index.ts` (scheduler caller), `server/routes/middleware.ts` (if new permission added).
- **Effort:** S.
- **Risk:** Low, but misconfigured scheduler will start 401-ing — ensure the scheduler uses an internal API key, not a session cookie.
- **Tests required:**
  - Unit: unauthenticated request → 401.
  - Unit: internal key header → 200.
  - Manual: scheduler's next tick logs success.
- **Depends on:** P0-a-1 (B3) so the scheduler actually runs after it's re-auth'd.

### P0-b-3 · B5 — Auth subscription admin routes

- **What:** Mount `requireAuth` + `requirePermission("shellz:admin")` (or the existing equivalent) at the router level in `server/modules/subscriptions/subscription.routes.ts`. The file's header comment already claims "behind Echelon auth" but the middleware is absent.
- **Files:** `server/modules/subscriptions/subscription.routes.ts`, possibly `server/routes.ts` where it's mounted.
- **Effort:** S.
- **Risk:** Low. Any currently unauthenticated caller (there should be none in prod) will break — inventory that with a log pass first.
- **Tests required:**
  - Unit: each admin mutation route returns 401 unauthenticated, 403 with non-admin user, 200 with admin.
- **Depends on:** none.

### P0-b-4 · B6 — Auth diagnostics destructive endpoints

- **What:** Apply `requireInternalApiKey` to any diagnostics route that mutates state (e.g., re-seed, re-run migrations, reset caches). Move them under `/api/_internal/*` and deny externally at the router prefix.
- **Files:** `server/routes/diagnostics.routes.ts` (or wherever the endpoints live per ULTRAREVIEW §B6), `server/routes.ts`.
- **Effort:** S.
- **Risk:** Low.
- **Tests required:** request without internal key → 401. With key → expected behavior.
- **Depends on:** none.

### P0-b-5 · H19 — Default-deny auth posture

- **What:** After P0-b-1..4 land, add a test/CI gate that fails the build if any route handler is registered without passing through a listed auth middleware. Implementation: an `app.use` hook that records routes and an end-of-file check against an allowlist of public routes (health, webhooks, login).
- **Files:** new `server/routes/auth-audit.ts`, small CI script.
- **Effort:** M.
- **Risk:** Low — it's a lint, not a runtime behavior change.
- **Tests required:** unit test that adds an unprotected route and asserts the audit fails.
- **Depends on:** B4, B5, B6 landed (else it will fail immediately).

### P0-b-6 · H20 — Move vendor JWT out of `localStorage`

- **What:** Serve the vendor session via an HttpOnly, Secure, SameSite=Lax cookie instead of a token in `localStorage`. Back-end already has `cookie-parser`; add a `/vendor/session` endpoint that sets the cookie, a `clearCookie` on logout, and adapt `requireVendorAuth` to read from `req.cookies.vendor_session`.
- **Files:** `server/modules/dropship/vendor-auth.ts`, `client/src/pages/vendor/*` (login/logout), remove `localStorage` reads.
- **Effort:** M.
- **Risk:** Medium — auth flow change; coordinate logout-on-deploy.
- **Tests required:**
  - Unit: cookie set on successful login, cleared on logout.
  - Integration: XHR with HttpOnly cookie passes; request without cookie 401s.
  - Manual: verify cookie is Secure in prod (requires M12/CSRF review).
- **Depends on:** B2 (VENDOR_JWT_SECRET must be real).

### P0-b-7 · L1 — DB SSL

- **What:** Replace `rejectUnauthorized: false` on the pg client with Heroku's documented cert verification path (download the root cert bundle or accept Heroku's SNI cert). If Heroku Postgres still does not support strict verification on your plan, document the deviation in `SECURITY.md` and keep this item open.
- **Files:** `server/infrastructure/db.ts` (wherever pg.Pool is constructed).
- **Effort:** S (investigation) + S (change) — can get blocked by Heroku constraints.
- **Risk:** Low in functional risk; may require operator action.
- **Tests required:** DB connect on boot in staging/prod.
- **Depends on:** none.

### P0-b-8 · B12 + H22 — Rewrite Stripe webhook handler end-to-end

- **What:** Replace the handler at `server/modules/dropship/vendor-portal.routes.ts:526–630` with a correct implementation:
  1. Mount the route with `express.raw({ type: "application/json" })` middleware ahead of the global `express.json()` parser (or a narrow path-scoped route registration before the global parser). The handler must receive a `Buffer` in `req.body`, unmodified.
  2. Require `STRIPE_WEBHOOK_SECRET` (or `STRIPE_DROPSHIP_WEBHOOK_SECRET`) at boot via the `requireEnv` helper from P0-b-1. No fallback, no "trust the payload" branch.
  3. Call `stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], WEBHOOK_SECRET)` with the raw buffer. On any `StripeSignatureVerificationError`, return 400 and log.
  4. Move the idempotency guard *inside* the DB transaction: `INSERT INTO dropship_stripe_events(event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id` — if no row returned, the event was already processed; return 200. Add a migration for `dropship_stripe_events(event_id TEXT PRIMARY KEY, received_at TIMESTAMPTZ DEFAULT now())`.
  5. Add a unique constraint `(reference_type, reference_id)` on `dropship_wallet_ledger` as a DB-level second belt.
  6. On `walletService.creditWallet(...)` returning `{success:false}`, respond with HTTP 500 so Stripe retries. Do not return 200 on failure.
  7. Fix the metadata key mismatch: standardize on `dropship_vendor_id` everywhere — update `vendor-portal.routes.ts:563` and `:569` to read `metadata.dropship_vendor_id`, *or* update `stripe.client.ts:51–54` to write `vendor_id`. Either way, both sides must agree. Add a test fixture that exercises a real Stripe checkout session through the ingest path.
  8. Delete the unused `server/modules/dropship/interfaces/http/webhook.controller.ts` file so the latent `"whsec_mock"` fallback can't be wired up by accident (B15).
- **Files:** `server/modules/dropship/vendor-portal.routes.ts`, `server/modules/dropship/infrastructure/stripe.client.ts`, new migration, `server/modules/dropship/wallet.service.ts` (transaction boundary), delete `server/modules/dropship/interfaces/http/webhook.controller.ts`, `server/index.ts` (mount order).
- **Effort:** M (2–3 days inc. tests).
- **Risk:** Medium. Mount-order mistakes with `express.raw` vs `express.json` are the most common bug class here; write a test that asserts `req.body` is a Buffer at the handler boundary.
- **Tests required:**
  - Unit: signature verification succeeds against a Stripe-signed test fixture, fails on tampered payload, fails when secret is wrong.
  - Unit: duplicate `event.id` → second invocation no-ops via ON CONFLICT.
  - Unit: `creditWallet` failure → 500 response (not 200).
  - Integration: end-to-end with Stripe CLI (`stripe listen --forward-to localhost:5000/api/webhooks/stripe-dropship`) against the real handler in a local env.
  - Regression: a checkout session created by `stripe.client.createFundingSession()` and then replayed through the webhook credits the correct vendor.
- **Depends on:** P0-b-1 (B2) for `requireEnv`.

### P0-b-9 · B13 + H23 — Authenticate the WebSocket upgrade and bind to the HTTP session

- **What:** In `server/websocket.ts`:
  1. Accept the incoming HTTP `upgrade` request only when the session cookie resolves to an authenticated user. Implementation: use `http.Server.on('upgrade', handler)` with a custom handler that parses the session cookie via the same `connect-pg-simple` store used by Express, or pass `verifyClient` to `WebSocketServer` and look up the session there. Reject (`socket.destroy()`) any upgrade without a valid session.
  2. Delete the client-asserted `auth` message path at lines 23–34. Bind `ws.__userId` from the server-side session lookup, never from untrusted input.
  3. Scope `broadcastOrdersUpdated()` to an org/user predicate. If an "orders changed" ping is the only payload, at minimum filter recipients by whether they have the `orders:view` permission.
  4. Never let `broadcastToUser(userId, ...)` accept a client-supplied userId; require the caller to be an internal service path.
  5. Add `ws.ping()` every 25 s (inside Heroku's 55 s router timeout) and handle `pong` to drop dead sockets.
  6. Add a SIGTERM handler in `server/index.ts` that calls `wss.clients.forEach(ws => ws.close(1001))` and drains before `process.exit(0)`.
  7. Add a per-IP connection cap (`ws.set maxConnections` via `WebSocketServer` options or a Map-based limiter). Suggested default: 10 per IP.
  8. On the client (`client/src/pages/Picking.tsx:461–510` and `client/src/hooks/use-notifications.ts`), remove the `auth` message send entirely (auth is now via cookie at upgrade), and on reconnect rely on the cookie being present — if the cookie is missing, redirect to login.
- **Files:** `server/websocket.ts`, `server/index.ts`, client pages listed above.
- **Effort:** M (2–3 days).
- **Risk:** Medium. Session parsing at upgrade time is subtle — cross-origin fetches, CSRF token expectations, and WebSocket spec's "same-origin by default" behavior all need testing. Keep the change additive (add the gate; leave the existing broadcast surface working) and verify with a smoke test before removing the old `auth` message path.
- **Tests required:**
  - Unit: upgrade without cookie → 401 or socket destroy.
  - Unit: upgrade with valid cookie → `__userId` populated from session.
  - Unit: client-sent `{type:"auth",userId:"other"}` is ignored.
  - Integration: ping/pong keeps connection alive beyond 60 s.
  - Load: 100 connections from 5 IPs with cap=10 → 50 accepted, 50 rejected.
- **Depends on:** P0-b-1 (B2) for `SESSION_SECRET` guarantee.

### P0-b-10 · B14 — Auth the 8 unauthenticated warehouse/locations routes

- **What:** Add `requirePermission("inventory","view")` to the three GET handlers (`locations.routes.ts:17, 29, 46, 266`) and `requirePermission("inventory","edit")` to the four mutation handlers (`:88, :140, :185, :294`). The middleware is already imported at `locations.routes.ts:8`; this is a mechanical edit.
- **Files:** `server/modules/warehouse/locations.routes.ts`.
- **Effort:** S (≤ 1 hour).
- **Risk:** Low. Any caller that was hitting these without auth will break; inventory the callers first via access logs / metrics. The destructive bulk-import (`POST /api/locations/import/csv`) being currently public is the strongest argument to fix this immediately.
- **Tests required:**
  - Unit: unauthenticated GET/POST/PATCH/DELETE → 401.
  - Unit: authenticated without permission → 403.
  - Unit: authenticated with permission → 200.
- **Depends on:** none.

### P0-b-11 · B15 — Strip Stripe mock/empty secret fallbacks

- **What:** Three changes:
  1. `server/modules/dropship/infrastructure/stripe.client.ts:5` — replace `process.env.STRIPE_SECRET_KEY || "sk_test_mock"` with `requireEnv("STRIPE_SECRET_KEY")`.
  2. `server/modules/dropship/vendor-portal.routes.ts:529` — same change. Remove the duplicated Stripe instantiation; share a single module-level client exported from `stripe.client.ts`.
  3. Delete the unused `server/modules/dropship/interfaces/http/webhook.controller.ts` (its `"whsec_mock"` default is a latent hazard).
- **Files:** two .ts files modified, one deleted.
- **Effort:** S.
- **Risk:** Low, once `STRIPE_SECRET_KEY` is set in every env (P0-b-1 already covers this pattern).
- **Tests required:** boot without the env var → process exits non-zero.
- **Depends on:** P0-b-1 (B2) `requireEnv` helper.

---

## P0-c — Transactional + locked money paths (Weeks 2–3)

### P0-c-1 · B7 — Wrap `Receiving.close()` in `db.transaction()`

- **What:** In `server/modules/procurement/receiving.service.ts:162-334`, wrap the line-iteration (205-258) and the `qty` clamp (283-289) in a single `await db.transaction(async (tx) => { ... })`. Thread `tx` into every call that currently calls `db.*` inside the loop. Remove the `GREATEST(0, variant_qty - X)` clamp: if the subtraction would go negative, that's a receiving/inventory reconciliation bug; raise `ReceivingReconciliationError` and abort the transaction so the caller sees the discrepancy rather than silently zeroing it.
- **Files:** `server/modules/procurement/receiving.service.ts`, possibly `shared/schema/*` error type.
- **Effort:** M (1–2 days inc. tests).
- **Risk:** Medium. Past receiving closures that happened to hit negatives will now fail. Run a pre-flight report on current data to count how many historical negatives exist.
- **Tests required:**
  - Unit: a mid-loop failure leaves zero rows written (rollback proven).
  - Unit: negative-clamp path now raises `ReceivingReconciliationError` instead of clamping.
  - Integration: close an RO with 3 lines, verify single COMMIT and matching `inventory_transactions` count.
  - Property: close the same RO twice → second call is a no-op or rejects (idempotency).
- **Depends on:** none.

### P0-c-2 · B8 — Migration runner: fail-fast + unique filename enforcement

- **What:**
  1. In `migrations/run-migrations.ts:64-67`, change the error handler from "log & continue" to "log, rollback the open tx, exit non-zero". Heroku release phase will abort the deploy on failure — which is the correct outcome.
  2. Add a CI lint that fails if two files in `migrations/` share the same numeric prefix (currently 012, 025, 050, 055 collide).
  3. Rename each colliding pair to distinct prefixes and create a `schema_migrations` row with a content hash, not just filename, so a reordered rename doesn't silently re-run a migration.
- **Files:** `migrations/run-migrations.ts`, rename 8 files under `migrations/`, new `migrations/XXXX_migration_log_hash.sql` to add `content_hash` column.
- **Effort:** M.
- **Risk:** Medium. Renaming migration files is historically dangerous. Strategy: create new files with new content hashes; leave old filenames in place (they've already been applied by filename); the lint only prevents *future* collisions.
- **Tests required:**
  - Unit: bad SQL migration aborts with non-zero exit; good SQL migration commits.
  - Unit: duplicate-prefix lint rejects.
  - Manual: staging deploy with a deliberate broken migration fails the release phase cleanly.
- **Depends on:** none.

### P0-c-3 · B11 — `SELECT FOR UPDATE` around inventory-level read-modify-write

- **What:** Every site that reads `inventory_levels` and then writes back (allocation, adjustments, transfers, receiving) must do so inside a transaction with `SELECT ... FOR UPDATE` on the targeted rows. Introduce `InventoryRepository.lockForUpdate(variantId, locationId, tx)` and route all callers through it.
- **Files:** `server/modules/inventory/core.service.ts`, allocation engine, transfer service, receiving service (already being touched in B7), adjustments endpoint.
- **Effort:** L (1 week; many callers).
- **Risk:** Medium–High. Locking introduces contention; plan to smoke-test peak allocation under load in staging.
- **Tests required:**
  - Integration: two concurrent allocations on the same variant serialize correctly; no over-allocation.
  - Load: simulate 50 concurrent writes; assert no constraint violations / no negatives.
  - Property: N parallel receipts + M parallel allocations converge to the expected qty_on_hand.
- **Depends on:** B7 (receiving is in the set).

---

## P0-pre-d — Test-safety-net gate (Weeks 3–4)

This tier was added in the 2026-04-17 addendum after H25 confirmed the repo has 13 test files against 319 TS source files. P0-d (money-type migration) cannot land without a property-test suite for money math, because the migration's regression risk is concentrated precisely in the aggregates that the current suite does not cover.

### P0-pre-d-1 · H25 — Build a minimal safety net

- **What:**
  1. Fix `npm test` on a clean checkout. The sandbox failure was `@rollup/rollup-linux-x64-gnu` missing — confirm this reproduces on a fresh `npm install` on the deploy platform; add an explicit `optionalDependencies` pin or a CI step that re-installs native binaries.
  2. Wire `@vitest/coverage-v8` into `vitest.config.ts`. Baseline coverage report (expect <5% initially).
  3. Add a `test-db` Postgres container (docker-compose) and a fixture harness that runs `migrations/run-migrations.ts` before each integration suite.
  4. Write property tests for the money aggregates that B1 will migrate:
     - PO total (unit × qty, minus discount, plus tax, summed across lines).
     - AP invoice total + 3-way match delta.
     - Landed-cost allocation across lots (B1 writes here; the invariants are: per-lot allocation sums to total landed cost, non-negative per-lot, idempotent for same inputs).
     - Subscription renewal charge.
     - Reward accrual.
  5. Write integration tests for the P0-c happy paths:
     - `Receiving.close()` with three lines → single COMMIT, matching `inventory_transactions` rows, rollback on mid-loop failure.
     - Concurrent allocation on the same variant → serialized via `SELECT FOR UPDATE`, no over-allocation.
  6. Add a webhook idempotency smoke-test harness (Stripe CLI, Shopify test webhooks) that replays the same payload twice and asserts a single side effect.
  7. Publish a per-module coverage report (inventory/procurement/oms/warehouse/subscriptions/dropship) so the next audit can cite coverage by domain.
- **Files:** `vitest.config.ts`, new `server/__tests__/property/*.test.ts`, new `server/__tests__/integration/*.test.ts`, `docker-compose.test.yml`, CI workflow.
- **Effort:** L (1–2 weeks to reach "green baseline"). Effort budgeted separately from the fix tier because this is scaffolding, not a fix.
- **Risk:** Low on prod; high on velocity if the test DB setup is flaky. Invest in making the harness idempotent and fast (< 60 s for the property suite).
- **Tests required:** the tests *are* the deliverable. Exit criteria: `npm test` green, coverage ≥ 40% on money-adjacent modules (procurement, inventory, oms), all P0-c fixes covered end-to-end.
- **Depends on:** none — can run in parallel with P0-c.

---

## P0-d — Money-type migration (Weeks 4–7)

### P0-d-1 · B1 — Migrate `doublePrecision` money columns → `bigint` integer cents

Treat this as its own mini-project. Feature-branch + phased rollout.

- **What:**
  1. Catalog every money column currently typed `doublePrecision` (ULTRAREVIEW §B1 cites `vendor_products.unit_cost_cents`, `purchase_order_lines.{unit_cost_cents, discount_cents, tax_cents, line_total_cents}`, `inventory_lots.unit_cost_cents`). Add any others found.
  2. For each column, in order:
     - Write a migration that adds a new `*_cents_i8 bigint NOT NULL DEFAULT 0` column.
     - Backfill: `UPDATE t SET c_cents_i8 = ROUND(c_cents)::bigint` — the catch is that some values have fractional cents from past `doublePrecision` writes; reconcile those with finance first (dump a report of any row where `c_cents != ROUND(c_cents)`).
     - Dual-write phase: update all writers to populate both columns; readers prefer the new column; monitor drift for one deploy cycle.
     - Swap: a second migration drops the old column and renames `*_cents_i8` → `*_cents`.
  3. Update all Drizzle schemas to `bigint({ mode: "number" })` or `bigint({ mode: "bigint" })` (pick one convention); all JS math on money must be on `bigint` — `Number()` / `+=` are banned on money columns.
- **Files:** all of `shared/schema/procurement.schema.ts`, `shared/schema/inventory.schema.ts`, every service that reads or writes these columns, every PDF/report template, the client's order-summary math.
- **Effort:** XL (3–4 weeks for the full end-to-end; ~5 PRs).
- **Risk:** High. A partial migration that leaves a single float-math call site will corrupt totals. Mitigate with:
  - A lint rule that rejects `doublePrecision` in `shared/schema/*`.
  - A runtime invariant: every money column read returns a `bigint` (or `number` that passes `Number.isSafeInteger`).
- **Tests required:**
  - Property tests on all aggregate functions (PO total, AP invoice total, landed-cost allocation) with a generator producing up to $10M orders with tricky discount/tax combinations.
  - A golden-file diff of existing PO PDF outputs pre/post-migration (should be identical once backfill is reconciled).
  - Integration: create PO → receive → pay cycle; every intermediate total matches hand computation.
- **Depends on:** B7, B11 (transactional boundaries in place before changing types).

---

## P1 — High-severity findings (Month 2)

### P1-1 · H1 — App-layer race protection on `(channel_id, external_order_id)`

- **What:** Keep the DB unique index; additionally, use `INSERT ... ON CONFLICT (channel_id, external_order_id) DO NOTHING RETURNING *` in the ingestion path. If no row is returned, fetch the existing one and short-circuit as idempotent success.
- **Files:** `server/modules/oms/ingestion.service.ts`, Shopify and eBay ingestion adapters.
- **Effort:** M. Risk: Low. Tests: concurrent ingestion of the same external order → exactly one row. Depends on: none.

### P1-2 · H2 — Shopify bridge + webhook double-ingestion

- **What:** Single-writer guarantee: webhook ingestion uses the same `INSERT ... ON CONFLICT` from H1; the bridge polling job skips any order whose `external_order_id` already exists. Add a metric `oms.duplicate_ingest_avoided_total`.
- **Files:** Shopify webhook handler, Shopify bridge service.
- **Effort:** M. Depends on: H1.

### P1-3 · H3 — Reject `received_qty > order_qty` (or make it explicit)

- **What:** At the service boundary (`ReceivingService.receive(line, qty)`), reject if `already_received + qty > order_qty + over_receipt_tolerance`. Add a `over_receipt_tolerance_pct` config on PO (default 0). Operators can raise it per PO when a vendor legitimately over-ships.
- **Files:** `server/modules/procurement/receiving.service.ts`, schema add (`purchase_orders.over_receipt_tolerance_pct`), admin UI.
- **Effort:** M. Tests: boundary cases at tolerance=0, 5%, 20%. Depends on: B7.

### P1-4 · H4 — Unique `(vendor_id, invoice_number)` constraint

- **What:** Migration adds the unique index; AP upload path pre-checks and surfaces a user-friendly "duplicate invoice" error.
- **Files:** migration + `server/modules/procurement/ap.service.ts`.
- **Effort:** S. Risk: existing duplicates will block the migration — run a pre-flight `SELECT vendor_id, invoice_number, COUNT(*) FROM ap_invoices GROUP BY 1,2 HAVING COUNT(*) > 1`; reconcile with finance.

### P1-5 · H5 — Block payment when 3-way match flags a discrepancy

- **What:** `processPayment()` must refuse if `ap_invoice.match_status != 'matched'` unless `forceOverride=true` is passed with a justification logged to the audit trail.
- **Files:** `server/modules/procurement/ap.service.ts`.
- **Effort:** M. Tests: discrepancy path blocks; override path logs. Depends on: H4 (so duplicates aren't the discrepancy).

### P1-6 · H6 — Landed-cost re-allocation must not retroactively mutate closed lines

- **What:** Introduce `landed_cost_adjustments` append-only table. When landed cost changes after close, write an adjustment row rather than updating the original `inventory_lots.unit_cost_cents`. COGS reporting sums the adjustments.
- **Files:** new schema file + migration; `server/modules/procurement/landed-cost.service.ts`; reports.
- **Effort:** L. Depends on: B1 (consistent money types).

### P1-7 · H7 — FX handling in landed-cost allocation

- **What:** Require `currency` + `exchange_rate` on the invoice row; store landed cost in functional currency cents; never convert at read time unless explicitly reporting.
- **Files:** AP schema + landed-cost service.
- **Effort:** M. Depends on: H6.

### P1-8 · H8 — Webhook error handling that swallows fulfillment failures

- **What:** Replace the current catch-and-200 pattern with "respond 200 only after the row is durably enqueued for retry". Failed rows go to `webhook_retry_queue` with a dead-letter after N attempts; alerts on DLQ depth > 0.
- **Files:** Shopify/eBay/ShipStation webhook handlers.
- **Effort:** L. Tests: induced failure path enqueues a retry; DLQ path logs+pages.

### P1-9 · H9 — ShipStation push: retry + 429 handling + idempotency key

- **What:** Wrap calls in an exponential-backoff retrier (configurable max elapsed 5 minutes). Pass a stable `orderKey` (e.g., `oms_orders.id`) so a duplicate push is a no-op at ShipStation.
- **Files:** `server/modules/oms/shipstation.adapter.ts`.
- **Effort:** M.

### P1-10 · H10 — eBay OAuth single-flight lock timeout

- **What:** Add a `Promise.race` with a 30s timeout on the in-memory single-flight; on timeout, clear the lock so callers can retry.
- **Files:** `server/modules/channels/ebay-auth.ts`.
- **Effort:** S. Tests: a stuck refresh unblocks after 30s.

### P1-11 · H11 — Vendor JWT middleware: remove double-response path

- **What:** Consolidate the error branches in `requireVendorAuth` (`server/modules/dropship/vendor-auth.ts:201-251`) into a single `try/catch` so a handled error path doesn't fall through and also call `next()`.
- **Files:** `server/modules/dropship/vendor-auth.ts`.
- **Effort:** S. Tests: unit test that calls the middleware with malformed/expired/valid tokens and asserts exactly one `res.*` call path.

### P1-12 · H12 — Split 4k-line route files that contain business logic

- **What:** `server/routes/ebay-channel.routes.ts` (4228 lines) is the worst. Extract to `application/ebay/*.service.ts` with routes reduced to validation + `service.do()` + response. Do it file-by-file, route-by-route; each PR changes ≤ 200 lines and keeps existing tests green.
- **Files:** the large route files listed in ULTRAREVIEW §H12.
- **Effort:** XL. Risk: Low per-PR if done route-at-a-time. Do not combine with B1.

### P1-13 · H13 — Replace `require()` inside ESM modules

- **What:** Convert to top-level `import` (if always needed) or `await import(...)` (if conditional). Delete `createRequire` helpers.
- **Files:** `server/index.ts:151, 302-303, 350, 478, 517` + any other grep hits.
- **Effort:** S. Risk: Low.

### P1-14 · H14 — Add missing foreign keys on financial-adjacent columns

- **What:** Add `.references()` (Drizzle) and the DB FK for each column flagged (`inventory_lots.inbound_shipment_id`, `inventory_transactions.order_item_id`, etc.). Migrations must succeed against current data — write a pre-flight query to count orphans.
- **Files:** `shared/schema/inventory.schema.ts`, new migrations.
- **Effort:** M (per FK). Risk: Medium — orphan rows must be reconciled before the migration.

### P1-15 · H15 — Allocation consults `channel_variant_overrides.is_listed`

- **What:** Add the predicate to the allocation query; add a test fixture where a variant is explicitly unlisted and assert no allocation.
- **Files:** allocation engine in `server/modules/channels/*`.
- **Effort:** S.

### P1-16 · H16 — ATP includes backorder quantity

- **What:** Either fix ATP to subtract (backordered, committed) or explicitly document ATP as "physical available, ignoring backorder" and add a separate `ATP-backorder-aware` function for allocation.
- **Files:** `server/modules/inventory/atp.service.ts`.
- **Effort:** M.

### P1-17 · H17 — Hard-coded ShipStation webhook URL on startup

- **What:** Read from `SHIPSTATION_WEBHOOK_URL`. Skip registration entirely if unset.
- **Files:** `server/index.ts` boot section.
- **Effort:** S. Depends on: none.

### P1-18 · H18 — Stop running backfill on every boot

- **What:** Move the backfill to an idempotent one-shot script under `scripts/backfill/*` invoked via `heroku run`. On boot, only verify a `schema_migrations`-style marker is present; if missing, log a warning (do not run).
- **Files:** `server/index.ts` + new `scripts/backfill/*`.
- **Effort:** M.

### P1-19 · H21 — Audit logger to append-only store

- **What:** Pipe every call through `AuditLogger.write()` into an append-only `audit_events` table (plus stdout for real-time). Add a retention policy (7y recommended for finance).
- **Files:** new `server/infrastructure/audit.ts`, migration.
- **Effort:** M.

---

## P2 — Medium-severity findings (Months 3–4)

Covered tersely; each is independent unless noted.

- **M1 · Idempotency keys on money mutations:** Add `Idempotency-Key` header handling at the router level; store `(key, request_hash, response_body)` in an `idempotency_keys` table; replay on duplicate. **Effort:** M. **Risk:** Low.
- **M2 · Stop client-side monetary math:** Move `parseFloat(x) * 100` conversions to the server. **Effort:** M. **Depends on:** B1.
- **M3 · Dyno-safe billing scheduler:** Use a single-leader pattern (pg advisory lock or a cron dyno with a lock row) so only one worker runs billing. **Effort:** M.
- **M4 · `executeTransfer` always transactional:** Make the public API `transferInventory(args)` always open its own transaction; remove the "pass a tx" foot-gun. **Effort:** S.
- **M5 · Lots FIFO in a single transaction:** Wrap the reserve/pick loop. **Effort:** M. **Depends on:** B11.
- **M6 · Non-overlapping subscription status:** Add `EXCLUDE USING gist` constraint on `(subscription_id, active_range)` using `tstzrange`. **Effort:** M.
- **M7 · Reconcile `member_current_membership`:** Scheduled job + test. **Effort:** S.
- **M8 · Discount `numeric` vs. `Number()`:** Route through a `Decimal` class (decimal.js or pg `numeric` round-trip). **Effort:** M. **Depends on:** B1.
- **M9 · `bigint` math in `recalculateTotals`:** Switch to `bigint` arithmetic; remove `+=` on numeric columns. **Effort:** S. **Depends on:** B1.
- **M10 · Status-history atomic with status change:** Wrap both writes in the same tx. **Effort:** S.
- **M11 · Re-introduce over-reservation rails:** Add a check constraint `qty_reserved <= qty_on_hand` plus application-level reject. **Effort:** S.
- **M12 · Cookie `secure` always on in prod-like:** Drive off `TRUST_PROXY=true` + explicit config, not `NODE_ENV`. **Effort:** S.
- **M13 · Consistent module layout:** Normalize to `domain/application/infrastructure/interfaces`. **Effort:** L (multi-PR).
- **M14 · Eliminate `@ts-ignore`:** Turn each into a typed shim with a TODO issue linked. **Effort:** L.
- **M15 · Route-level rate limits:** Add `express-rate-limit` on public endpoints (login, webhooks). **Effort:** S.
- **M16 · Client N+1:** Batch fetch at the API layer; add `useQuery` composition. **Effort:** M.
- **M17 · Lots FIFO: avoid raw SQL cost back-fetch:** Use a single query with `RETURNING *`. **Effort:** S.
- **M18 · Shopify bridge LISTEN/NOTIFY or pg-boss:** Promote one-time backfill to continuous. **Effort:** M.

---

## P3 — Low / hygiene (Backlog)

- **L1 — DB SSL** — addressed in P0-b-7 above.
- **L2 — eBay token rotation race** — [COMPLETED] covered in H10 plus add DB-level single-writer. **Effort:** S.
- **L3 — `fmtMoney` float precision in PO PDF** — [COMPLETED] swapped for `Decimal`. **Effort:** S.
- **L4 — `VENDOR_JWT_EXPIRES_IN` default "24h"** — [ACCEPTED]; documented in `vendor-auth.ts`. **Effort:** 0.
- **L5 — Redundant `SELECT COUNT(*)`** — [COMPLETED] variables deleted from `channels.routes.ts`. **Effort:** S.
- **L6 — Dead HMAC bypass** — addressed in P0-a-4.
- **L7 — `parseFloat` on CSV `unit_cost`:** [COMPLETED] routed through `Decimal.js` in `bulkImportLines`. **Effort:** S. **Depends on:** B1.
- **L8 — `completeAllLines` backfill semantics:** [COMPLETED] added unit test pinning current behavior. **Effort:** S.

---

## Cross-cutting concerns

### Test coverage baseline to achieve before P0-d (B1) ships

1. Property test suite for every money aggregation (PO total, AP invoice, landed-cost allocation, subscription renewal, reward accrual).
2. Integration test covering the full PO → receive → pay happy path, with asserts on every intermediate monetary state.
3. Integration test for allocation under concurrency (serialization via `SELECT FOR UPDATE`).
4. Smoke test for Shopify + eBay webhook idempotency (same webhook delivered twice → one side-effect).

### Observability gates

- Add a structured-log field `audit_event=true` to every money/inventory mutation.
- Add metrics: `money_mutation_total{module,outcome}`, `allocation_conflict_total`, `webhook_retry_total{adapter,outcome}`, `receiving_close_rollback_total`.
- Dashboards: one per domain (procurement, inventory, channels).

### Rollback plan for each P0 change

- P0-a-1 (B3): revert commit; scheduler returns to "throw every 5 min" state (already broken, safe to revert).
- P0-a-2 (B9): revert; double-response crash returns (worse than current); prefer fixing forward.
- P0-a-3 (B10): revert; silent zeroing returns; prefer fixing forward.
- P0-b-*: revert individually; fallback is the prior unauthenticated state — **only safe to revert if the original route had no traffic**; check metrics first.
- P0-c-* and P0-d-*: feature-flag each behind `RECEIVING_ATOMIC=true`, `INVENTORY_LOCK=true`, `MONEY_I8=true`. Flip off in seconds if anomalies appear.

### PR hygiene required (per project CLAUDE-style rules)

Every PR for a fix above must include in its description:
- Summary of changes
- Assumptions made
- Risks
- Test coverage explanation
- Failure modes considered

---

## Known gaps / unverified items

**Closed in the 2026-04-17 addendum** — all five originally deferred areas were audited end-to-end. The resulting findings (B12–B15, H22–H26) are folded into this plan:
- Stripe webhook signature verification → B12, H22, B15 (verified)
- `websocket.ts` lifecycle → B13, H23 (verified)
- `warehouse/*` module → B14 (verified); H24 (agent-reported, not line-verified)
- Unit-test coverage percentage → H25 (verified; 13 tests vs 319 source files; `npm test` fails on fresh checkout due to missing optional rollup binary)
- Client pages beyond AP/PO/Receiving → H26 (agent-reported, not line-verified); no new BLOCKERS found in client pages

**Remaining unverified items (treat as HYPOTHESIS until re-read):**
- `server/modules/warehouse/bin-assignment.service.ts:134–199` — concurrent read-modify-write (MEDIUM).
- `server/modules/warehouse/warehouse.routes.ts:507–589` — bulk import without transaction (HIGH if confirmed; folded into B11 scope).
- `server/modules/warehouse/locations.routes.ts:294–384` — CSV import loop without transaction (HIGH if confirmed).
- Heroku-specific WebSocket timeout behaviour on the actual dyno.
- Unit-test suite runnability under a fresh `npm install` on the deploy platform (expected to pass, but not verified in this audit).

Re-verify these before implementing their fixes.

---

## Appendix — one-page triage

| ID | Severity | Effort | Tier | Starts blocked by |
|----|----------|--------|------|-------------------|
| B1 | Blocker | XL | P0-d | B7, B11, H25 |
| B2 | Blocker | S | P0-b | — |
| B3 | Blocker | S | P0-a | — |
| B4 | Blocker | S | P0-b | B3 (scheduler) |
| B5 | Blocker | S | P0-b | — |
| B6 | Blocker | S | P0-b | — |
| B7 | Blocker | M | P0-c | — |
| B8 | Blocker | M | P0-c | — |
| B9 | Blocker | S | P0-a | — |
| B10 | Blocker | S | P0-a | — |
| B11 | Blocker | L | P0-c | B7 |
| B12 | Blocker | M | P0-b | B2 |
| B13 | Blocker | M | P0-b | B2 |
| B14 | Blocker | S | P0-b | — |
| B15 | Blocker | S | P0-b | B2 |
| H22 | High | M | P0-b | B12 (same PR) |
| H23 | High | M | P0-b | B13 (same PR) |
| H24 | High | M | P1 | B11 (confirms scope) |
| H25 | High | L | P0-pre-d | — |
| H26 | High | S | P1 | M1 (idempotency keys) |
| H1–H21 | High | mixed | P1 | per-item |
| M1–M18 | Medium | mixed | P2 | per-item |
| L1–L8 | Low | S | P3 | — |
