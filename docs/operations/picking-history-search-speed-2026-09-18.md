# Picking history search responsiveness

## Scope and confirmed findings

- `PickingHistoryRepository.page` previously evaluated its historical search
  separately for the total and the selected page. It now shares one ID/sort-key
  CTE between those consumers and hydrates only the selected page.
- `PickingHistory` previously kept the prior query's result during its 300 ms
  debounce. That could leave a prior "no matches" message visible while the user
  was already searching for another order. The observer now changes immediately;
  only sending the new request is debounced.
- Pending searches have prominent, query-specific feedback. An empty result is
  shown only after a successful completed read. Superseded requests are cancelled.
- A stalled history request times out after 10 seconds with a visible retry path.
  The existing read-only transaction, five-second SQL timeout, page-size limit,
  admission control, all-date search semantics and channel/warehouse scopes remain.

## Validation

- Real PostgreSQL 17, disposable synthetic database: 60,000 historical orders,
  180,000 lines and 180,000 pick events. The same order-number search measured
  164 ms before and 87 ms after the single-pass change; a subsequent run with the
  other tests active measured 94 ms. These are local repository-read timings,
  not production/browser latency or a service-level guarantee.
- 35 tests pass across the order/history PostgreSQL integration suite, history
  HTTP contract, and client history reader. Coverage includes scoped/old records,
  pagination and empty pages, literal search characters, concurrent bounded reads,
  SQL timeout rollback, cancelled requests, malformed responses and client timeout.
- 38 desktop/mobile browser tests pass, including progress during debounce,
  delayed responses, stale-response isolation, timeout/retry, both picking modes,
  shrinking pages, and pausing the active queue while browsing history.
- Application and client-test TypeScript checks pass.

## Limits and deployment check

No production records, fulfillment states, schema, or configuration were changed.
The original long production wait was not captured as an HTTP/database trace;
these changes remove confirmed redundant work and misleading pending-search UI,
but do not establish that every source of production latency has been eliminated.

After deployment, repeat the #62770 search from Picking > History on a fresh page,
confirm the searching indicator appears as soon as typing begins, and measure the
actual history request under normal operator load. A timeout/error must remain an
error with Retry, never be presented as "no history". Do not run an unbounded
archive read or modify pick/shipment records as part of this check.
