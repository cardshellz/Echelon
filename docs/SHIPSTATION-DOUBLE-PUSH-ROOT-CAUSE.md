# ShipStation double push: root cause and invariants

Incident class: one Echelon shipment ends up with two ShipStation orders under
the same `orderKey` (`echelon-wms-shp-<shipmentId>`). Seen on #58408 and #62452.
When an operator then cancels the duplicate in ShipStation, Echelon may be
linked to the cancelled order; the surviving order self-repairs only at ship
time (see "Recovery" below).

## Two defects, both required to be fixed

### 1. `apiRequest` replayed non-idempotent writes after a 429

`server/modules/oms/shipstation.service.ts` used to sleep `X-Rate-Limit-Reset + 1`
seconds after any 429 and re-send the identical request, including
`POST /orders/createorder` with no `orderId`. A 429 leaves the first attempt's
outcome unknown to us, and ShipStation's orderKey upsert is not a reliable dedup
under that pattern. The replay could mint a second order.

Fix: `server/modules/oms/shipstation-api-request.ts`. Read-only methods replay;
mutations replay only when the call site opts in with `{ replaySafe: true }`
because the request is an idempotent upsert addressed by an explicit `orderId`.
A keyed create that hits a 429 is sent exactly once and surfaces a transient
`ShipStationRateLimitError`; the durable retry ladder re-drives the push later,
where `getOrderByKey` adopts whatever the first attempt created. Every request
now carries an abort timeout (`SHIPSTATION_REQUEST_TIMEOUT_MS`, default 60s).

### 2. Session advisory locks over the pooled `db` handle serialized nothing

`db = drizzle(pool)` checks out an arbitrary connection per statement.
`pg_advisory_lock` is session-scoped and re-entrant within a session, and
pg-pool hands idle clients out LIFO. A second concurrent push usually landed on
the connection the first push had just released, "acquired" instantly, and both
took the CREATE path. Unlocks could land on a third connection, stranding the
lock.

Fix: `server/infrastructure/session-advisory-lock.ts` pins one client for the
whole critical section (acquire inside `BEGIN / SET LOCAL lock_timeout /
pg_advisory_lock / COMMIT`, run, unlock on the same client, destroy the client
if the unlock fails). Applied to `pushShipment`, `appendShipmentItems`, the
SHIP_NOTIFY combined-child insert, `createShipmentForOrder` (session path), and
`late-order-shipment-coverage` (session path).

## Invariants

- Never run `SELECT pg_advisory_lock(...)` through the pooled `db` handle. Use
  `pg_advisory_xact_lock` inside a transaction, or the pinned-client runner.
- Never replay a ShipStation mutation after a 429 unless it carries an explicit
  provider id. New `POST` call sites default to "not replay-safe".
- A push holds a pinned pool connection for its HTTP calls. Keep HTTP bounded.

## Recovery for an existing duplicate

When the surviving ShipStation order ships, SHIP_NOTIFY links the label to the
shipment by orderKey and the carrier-tracking dispatcher runs
`resolveShipmentByOrderKey`, which adopts the shipped order id and stamps
`review_reason = shipstation_duplicate_order_key_repaired`. Until then a row
linked to the cancelled order is only flagged `engine_cancelled_order_active`
by Reconcile V2 (hourly) and appears in the Control Tower's
`SHIPMENT_REQUIRES_REVIEW` bucket.

## Operational notes

- A sustained 429 storm now costs retry-ladder cycles on creates instead of a
  35-second in-process sleep. First retry is ~5 minutes, then 2/4/8/16 minutes,
  dead-letter after 5 attempts. ShipStation's window is one minute, so a storm
  that long has not been observed.
- Namespace 918407 is shared with an OMS order id (`wms-sync.service.ts`) and a
  shipment item id (`inventory.use-cases.ts`). That is false contention only.
