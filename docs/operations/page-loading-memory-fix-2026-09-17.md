# Page-loading memory fix — 2026-09-17

## What is confirmed

The production incident log at `2026-09-17T12:58:36.670423Z` reported
`FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`.
The process exited with status 134 and Heroku reported it crashed. `package.json`
starts the web process with `--max-old-space-size=384`.

The pre-fix `registerChannelRoutes`, `GET /api/wms/orders`, called
`orderMethods.getOrdersWithItems()` without a database limit. That method loaded
all WMS order headers and all their lines. The route searched, counted, sorted,
and sliced the resulting arrays in JavaScript. `Orders.tsx` requested a new list
on every search keystroke. Failed reads defaulted to empty arrays and zero counts.

The raw item loader also grouped rows using `wms_order_id`, while the actual
column is `order_id` (`shared/schema/orders.schema.ts`, `orderItems`). The new
read model uses typed column mapping and tests the returned `orderId` and
`pickedQuantity` fields against PostgreSQL.

The supplied `[Replen evaluate]` messages originate in
`ReplenishmentUseCases.evaluateReplenNeed` in
`server/modules/inventory/application/replenishment.use-cases.ts`. The picking
queue calls `PickingUseCases._buildReplenPredictions`, which calls
`predictReplenAfterPick` for pending lines. `Picking.tsx` polls every 15 seconds.
The prediction passes a hypothetical post-pick quantity as `currentQtyOverride`;
the evaluation messages themselves are not evidence of inventory movements.

The follow-up crash-prevention pass found that `server/index.ts` wrapped
`res.json` and retained every JSON body until the response's `finish` event.
Error bodies were also serialized a second time before truncating the log text.
The replacement `createHttpRequestLogger` records bounded request metadata only,
including completion/disconnection, without retaining or serializing bodies.

## Likely explanation versus what is not proven

**Hypothesis:** overlapping full-history WMS list requests were an immediate
memory-pressure trigger. Several such requests were outstanding at the crash.
No heap profile was captured, so exclusive attribution to this path, or to log
output, is not proven. This patch removes the demonstrated unsafe read pattern;
it does not claim that every possible cause of memory exhaustion is eliminated.

## Changes and boundaries

| Surface | Result |
| --- | --- |
| WMS Orders | `OrderListRepository.page` counts/filters/pages in PostgreSQL, then loads only that page's lines. Maximum 250 orders; UI pages of 100. Read-only repeatable-read transaction keeps counts, headers and lines consistent. |
| Slow WMS reads | A transaction-local five-second statement timeout cancels blocked/slow list SQL and rolls back. The setting never persists on a pooled connection. |
| Concurrent page loading | `limitPageRead` permits four heavy page handlers per web process across WMS Orders, legacy Orders, Picking, OMS Orders, Order History, Inventory History, Outbound Shipments, and the channel-allocation grid. Surplus requests receive `503 PAGE_READ_BUSY` with `Retry-After: 1` before database work; there is no unbounded waiting queue. |
| Error/disconnection under load | Admission stays occupied until the handler settles, not until the browser disconnects. Parallel page-read groups settle all their queries before propagating an early failure, avoiding premature release while sibling reads continue. |
| HTTP logging across the app | `createHttpRequestLogger` logs method, bounded path, status, duration and completion. No response object capture or second error-body serialization. Correlated application error logs remain. |
| OMS / history page parameters | Maximum 200 rows; malformed, oversized and overflowing page/offset requests return 400 before reads. The separate, existing 1,000-row history-export contract is unchanged. |
| Inventory History enrichment | Fetches only the page's referenced variant/location IDs, rather than loading the entire catalog and bin list for enrichment. |
| Legacy `/api/orders` | Same bounded reader; array response retained. `X-Total-Count` and a next-page `Link` expose continuation. |
| Maintenance callers | `scanOrderBatches` uses 100-order keyset batches and an initial high-water ID. Location reconciliation, fulfillment-status sync, and historical picking-log backfill no longer load lifetime history. |
| Order History SKU search | Matching lines remain in PostgreSQL through correlated `EXISTS`, rather than sending every matching order ID to Node. |
| Picking queue | Concurrent requests for the same warehouse scope share only the in-flight load. Equal variant/bin/quantity previews are evaluated once per load. Nothing is cached after the read settles. |
| Picking history | The former 24-hour Done filter is replaced by an all-date History view. `PickingHistoryRepository.page` searches order number/customer/SKU in SQL, returns 50 orders per UI page (maximum 100), and hydrates only those orders' lines and latest recorded picker. Its read-only transaction has a five-second statement timeout and the shared admission limit. No archive is loaded into the active queue. |
| Replenishment logs | Routine evaluation, threshold, source-selection and preview messages use structured debug logs. Actual task/action/error logs remain. No replenishment rules are changed. |
| WMS / OMS Orders, Order History, Inventory History, Picking | Visible failure/retry states; first-load failures do not masquerade as successful empty lists. Existing data is explicitly marked stale after a failed refresh. |
| Main application pages | `PageDataHealth` in `AppShell` warns about active React Query failures that lack their own error display. Errors from unmounted or disabled queries are excluded. No automatic retry storm. |
| Shared query client | Passes React Query's abort signal to `fetch`. WMS/OMS/history searches debounce; the touched custom fetchers also consume cancellation signals. |

The historical picking-log backfill no longer invents a random scan/manual
method: that nullable field is omitted when historical evidence does not establish
it. The backfill was **not run**. Existing audit records were not rewritten.

No schema migrations, production configuration changes, deployments, stock
adjustments, shipment repairs, or provider fulfillment writes were performed for
this patch. The earlier owner-approved web restart was a separate incident action.
The active pick queue's owner-guarded self-healing protections remain. Completed
orders no longer ride along in its polling response; historical browsing uses a
separate read-only endpoint and pauses active-queue polling. Returning to the
queue resumes normal loading. History never runs replenishment or repairs.

## Cross-page audit and limits

- OMS `listOrders` in `server/modules/oms/oms.service.ts` already applies SQL
  `LIMIT/OFFSET` before line hydration. Its first-load error display was missing.
- `getInventoryTransactions` in
  `server/modules/inventory/infrastructure/inventory.repository.ts` already
  applies database pagination. Its first-load error display was missing.
- `registerOutboundShipmentRoutes` in
  `server/modules/shipping-engine/outbound-shipments.routes.ts` already validates
  a maximum page size of 200. Its UI already distinguishes errors from empty
  results; cancellation was added to its fetcher.
- Picking's active queue is not arbitrarily truncated. Its separate History view
  is paginated across all dates, including later-shipped/cancelled orders and
  released/unpicked orders with recorded picking evidence. Search is over the
  whole matching database cohort, not just the displayed page.
- History cards show current line quantities, recorded completion, and the last
  item-pick activity's actor/time. They do not invent scan evidence from a shipped
  header, total audit deltas as if they were additional units, or reconstruct
  missing/deleted records. Existing detailed administrative logs are unchanged.
- The legacy channel-inventory grid still loads its catalog/allocation cohort
  before filtering. The internal orders integration export can also request a
  large history. These are different contracts from page-level WMS history, and
  neither has been proven to cause this incident. They were not silently capped.
- The shared warning covers surfaced React Query failures, not imperative fetches
  or existing code that catches failures and returns a success-shaped default.
  A page warning does not make otherwise unavailable data authoritative.

## Assumptions, compatibility and failure modes

- Bucket semantics, channel/warehouse/source scope, case-insensitive substring
  search, and legacy status filters are preserved and tested. `%`, `_`, quotes
  and backslashes are literal WMS search input, not wildcard/SQL instructions.
- Ordering is deterministic for equal timestamps using the order ID as a tie
  breaker. Offset pages can still move as orders change; administrative scans
  use keysets specifically to avoid skipping rows that leave a status set.
- An external consumer of the old unbounded `/api/orders` array must follow the
  next-page `Link`. No in-repository list consumer was found relying on that
  endpoint to return lifetime history.
- Database failures propagate to an error response, not a fabricated empty
  result. Clearing an in-flight queue read on rejection permits the next retry.
- Browser cancellation stops obsolete fetches; it does not promise cancellation
  of SQL already executing on the server. Bounded hydration prevents those reads
  from retaining a lifetime-sized result in web memory.
- A very large individual order, sustained high concurrency, or another expensive
  endpoint can still require separate capacity work. Do not equate passing these
  tests with a production heap profile or universal performance certification.
- The four-handler ceiling is conservative admission policy, not a measured
  universal safe memory threshold or a database-connection reservation. It can
  produce a visible retryable 503 during bursts. Writes, webhooks and health
  endpoints are not put behind this limiter. Background jobs and unlisted
  endpoints remain outside its scope. Normal production traffic must validate
  capacity after deployment; no absolute no-crash guarantee is claimed.
- HTTP access logs no longer include truncated response-body text. They retain
  status/timing/correlation metadata; detailed failures belong in the existing
  application error logs rather than customer response payloads.

## Validation

- Full unit command: `vitest run unit --maxWorkers=4`: **13,313 passed**, 39 skipped
  under the existing test configuration; no failures. One pre-existing source
  assertion was made CRLF-safe without relaxing its authority checks.
- Focused existing bucket, picking-discrepancy and replenishment regressions:
  **75 passed**.
- `order-list.integration.test.ts`: **11 PostgreSQL tests passed**, including all
  buckets/holds, search beyond page boundaries, channel/warehouse/source isolation,
  stable ordering, input validation, item mapping, changing-status keyset scans,
  Order History SKU filtering, and real locked-query timeout/rollback followed by
  successful reuse. These are current-column query tests, not a
  complete production migration/trigger replay.
- Picking-history cases include 2020 orders, shipment/cancellation/release,
  removed-line SKU evidence, duplicate order numbers across channels/warehouses,
  deterministic timestamp ties, read-only transactions, and missing audit fields.
- Picking-history load case: **60,000 old orders / 180,000 lines / 180,000 audit
  events / four concurrent reads**, with the **384 MB Node heap**. Every response
  contained 50 orders and 150 lines. Audit hydration returned at most one record
  per selected order. No production records or inventory repairs were involved.
- Load case: **60,000 synthetic orders / 180,000 lines / eight concurrent reads**
  using a **384 MB Node heap**. Every response contained exactly 100 headers and
  300 lines; each line query was restricted to 100 order IDs.
- HTTP overload tests hold a read open while issuing 20 competing page reads;
  these receive 503 while health and write handlers remain responsive. Separate
  tests check 100 rejected requests without starting more work, disconnects,
  failure cleanup, draining parallel failures, pagination bounds, wiring of all
  protected endpoints, metadata-only logging and bounded history enrichment.
- Final targeted stability run: **44 tests passed**, including the added
  parallel-failure draining regression after the full unit run.
- Shared-query cancellation/error/401 contract: **3 tests passed**.
- Desktop/mobile browser checks: **28 passed**, covering failed initial loads,
  retry, stale refreshes, debounced search, pagination, recovery when the current
  page becomes empty, and app-wide warning recovery/removal. Returning to a cached
  WMS page refreshes its membership and counts rather than keeping it fresh forever.
  Picking History is covered in both batch/single modes, including old-order
  search, read-only details, provider changes, page correction, refresh failure,
  and pausing/resuming the active queue poll while browsing historical records.
- Application, server-test and client-test TypeScript checks passed.
- Production client/server build passed. Existing large-client-bundle warnings
  remain; no blanket bundle-size claim is made.
- PostgreSQL and browser tests use isolated local synthetic/mock data. The new
  database suite and browser journeys are included in existing CI selection.

## After deployment

1. Confirm the deployed commit belongs to this branch/PR, not an unrelated PR
   number from another task.
2. Verify WMS Orders, exact order/SKU search, next/previous pages and the Picked
   bucket. Check browser/network results, not merely a successful homepage.
3. Verify Picking still shows pending work and unchanged replenishment guidance.
   Open History in either picking mode, search an older order such as #62770,
   inspect its read-only quantities, and check next/previous pages. Confirm the
   queue stops polling while browsing history and resumes on return.
4. Check web memory and fatal-error logs under normal operator traffic. Do not
   deliberately replay the old full-history query in production.
5. Keep the missing ShipStation-line investigation and any production repair
   separate. This page-loading change does not resolve shipment contents.
