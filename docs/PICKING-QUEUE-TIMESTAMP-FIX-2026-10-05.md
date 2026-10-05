# Picking queue timestamp failure - 2026-10-05

Reviewed and patched against origin/main `4d12a17f6c5c2bc308231fb45feaadf1724fe129`. This is a separate follow-up to merged PR #1672.

## Confirmed execution path

1. `orderMethods.getPickQueueOrders` (`server/modules/orders/orders.storage.ts:386`) executes raw SQL selecting `o.started_at AS claimed_at` (line 414). Drizzle's raw node-postgres session leaves PostgreSQL TIMESTAMP values as text (`node_modules/drizzle-orm/node-postgres/session.js:24-32`).
2. The mapper previously assigned this raw text directly to `startedAt` (now corrected at `orders.storage.ts:539`). PostgreSQL's space-separated timestamp is not an ISO datetime accepted by the picker response contract (`shared/types/picker-order.ts:5-8,41`).
3. `PickingUseCases.loadPickQueue` (`server/modules/orders/picking.use-cases.ts:3975`) plans items and calls `validatePickerOrder` (line 4048). A non-null raw `startedAt` raises a Zod `invalid_string` error at that field. The queue route catches this and returns 500 for the entire queue (`server/modules/orders/picking.routes.ts:159-171`).

The patch reuses `orders.startedAt.mapFromDriverValue` to decode the recorded timestamp using the existing column's UTC semantics (`shared/schema/orders.schema.ts:168`; Drizzle `pg-core/columns/timestamp.js:32-33`). Null remains null; the validator stays strict. This read path performs no writes, invents no timestamp and changes no quantities, claims, holds, picks, costs, replenishment policy or migration.

## Evidence and validation

- A guarded read-only connection against current database inputs reproduced `ZodError`, path `startedAt`, code `invalid_string` before the patch. The same source trace succeeded afterward. The connection verified `default_transaction_read_only=on`, used an 8-second statement timeout, and ran only queue read/planning ports. Replenishment prediction was controlled to return null; assembly delegation was omitted. This was not an authenticated production HTTP request or a deployment verification.
- New integration cases exercise the actual registered HTTP queue route, authentication gate, use case, validator, raw repository and disposable PostgreSQL (`server/modules/orders/__tests__/integration/order-list.integration.test.ts:109-156`). The ready/unclaimed case passes before and after; the in-progress/claimed case returns 500 before and 200 after. An offset timestamp is asserted as the exact UTC instant with milliseconds. Both cases verify order and line rows remain unchanged, and unauthenticated requests return 401.
- Those HTTP cases use a catalog-backed, non-inventory-tracked fixture line; picker/channel display and prediction ports are controlled. They prove the timestamp contract, not every physical source-planning or replenishment branch.
- Focused validation: 29 tests across five files passed, including all 17 real PostgreSQL order-list tests and the existing forward-only OMS pick-status checks. Both application and protected server-test TypeScript checks passed. All 34 picking hold/control browser cases passed on desktop/mobile. Browser API responses are mocked; the HTTP/PostgreSQL tests cover the real server path separately.
- Initial validation exhausted the default TypeScript heap and exposed missing dependencies in the shared primary install; one initial browser run timed out. The isolated worktree received its own unchanged-lockfile `npm ci`; final checks used that install and an 8-GB TypeScript heap. No test was excluded or assertion relaxed.

The prior SQL and mocked-browser checks did not exercise a claimed PostgreSQL timestamp through the actual HTTP response validator. The new regression closes that specific gap and is included in the existing PostgreSQL CI manifest (`scripts/ci/postgres-test-manifest.ts:13`).

## Operational limits

GitHub records a successful deployment of base commit `4d12a17f6c5c2bc308231fb45feaadf1724fe129`; that record is not proof of endpoint health. Heroku log access was unavailable in this session. This patch has not been merged or deployed, and production queue recovery remains unverified until it is deployed and the authenticated queue is checked.

The dirty primary checkout and recovery worktree were preserved with matching branch/status/content snapshots (10 modified primary files and 3,697 recovery files). The original October 1 report was unchanged. No incident recovery was rerun. The remaining lot/cost findings and F11 unresolved-cost policy are outside this fix.
