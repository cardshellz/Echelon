# Instant account history

This implementation has not been deployed. It changes a derived account display
and removes historical zero-quantity lines from the editable cart. It does not
patch orders, payments, rewards, points or inventory balances.

## Current order lines

`OrderEditService.order` returns only lines with positive current quantity.
The source snapshot, financial evidence and recovery audit retain removed lines.
`OrderDraft` independently filters older cached responses, including its quantity
state, change plan and product-picker exclusions. Customers may still reduce a
current line to zero; that draft change remains visible until applied. The normal
quote path validates active source identities through `resolveOrderEditLinePlan`
before creating an attempt or asking Shopify to prepare a calculated order.

## Request path and authority

`CustomerAccountOrderQueriesService.summaries({saved:true})` reads
`PostgresAccountNativeSummaries`, the existing local OMS/WMS context reader and
the existing payment/delivery/return progress owners. It never calls Shopify.
`/account/overview` returns that result, saved order options and the verified
session in one signed storefront request. The original endpoints remain for
older deployed themes. The new bundle never falls back to the slow provider
endpoint when a saved lookup fails.

`ShopifyOrderEditProvider.accountNativeByIds/accountNativePage` retain Shopify's
`currentTotalPriceSet` using `shopifyMoneyBagCents`. They do not reconstruct
prices, subtract refunds or begin calculated edits. The existing USD-only money
contract remains unchanged. Unsupported source data is retained as a versioned per-order error and is not
displayed as verified money. It cannot stall valid purchases in the same page.
Neither an older valid response nor an older error can overwrite newer evidence.
Coverage checks include these exceptions; no amount is guessed or converted.

The table is keyed by channel and native Shopify order ID, with no OMS foreign
key. Historical purchases therefore have the same lookup path. Reads recheck
connection/shop/customer/reference bindings. Native owner changes, including a
removed customer, revoke the prior owner's cache access. A cold request may queue
only purchases already verified for that customer in the native read model or owned in OMS; a shopper cannot create arbitrary provider
lookup jobs by submitting made-up IDs. Historical coverage comes from the scan.

All edit, cancellation, reward and return commands retain their existing fresh
authorization and domain checks. Cached options do not grant permission.

## Maintenance, concurrency and recovery

`AccountNativeSummariesWorker` shares the existing account maintenance scheduler.
Only enabled account shops and active Shopify connections are scanned. A SQL
lease coordinates dynos. Each sweep processes at most 20 priority IDs, one
100-order update page and one 100-order historical page. Historical pages have
a durable 30-second cadence; update pages have a separate 15-second cadence. Source exceptions retry
with a 15-minute backoff, and verified historical owners can request recovery
without an OMS row or a change to their purchase.

Both scans seek by exact native ID strings. They never traverse one deep opaque
connection cursor, so history can pass the documented 25,000-object limit.
The update window retains its lower bound while paging and overlaps from scan
start on completion. Changes behind the ID seek are revisited next pass.
Historical access is explicitly verified before its first page. See Shopify's
[order filters](https://shopify.dev/docs/api/admin-graphql/latest/queries/orders),
[pagination limits](https://shopify.dev/docs/api/usage/pagination-graphql#pagination-limits)
and [granted scope reader](https://shopify.dev/docs/api/admin-graphql/latest/queries/currentAppInstallation).

Facts commit before cursor checkpoints. Newer Shopify timestamps win; conflicting
same-second observations replace a fact only when their read started after the
previous fact was received. Identical overlapping reads cannot move verification
time backwards. Checkpoints require the current unexpired lease. A lost lease,
timeout or database failure leaves replayable work, with a bounded retry delay.
No worker submits a financial, inventory, fulfillment or postage command.

The delta coverage checkpoint keeps unchanged old purchases fresh without
rewriting every historical row. If that checkpoint and an order's native read
are more than two minutes behind, the summary reports status unavailability and
queues an owned refresh. Known amounts are preserved rather than guessed.
Logs classify source/access/database failures without customer payloads.

## Storefront

`preload-entry.ts` runs on signed-in storefront pages. Its initial bundle is
approximately 35 KiB gzipped; the existing editor/returns bundle is approximately
196 KiB gzipped and loads separately on account pages. The saved order read starts
before the editor bundle downloads. The existing account stylesheet is loaded
without blocking the native order table.

The optional session-storage display cache expires after 30 seconds and is keyed
by store origin, actual theme, customer and exact page identities. It contains no
session key, address, payment credentials or command authority. Disabled or corrupt
storage falls back to the signed local read. The preload and full UI share one
validated in-memory request; they do not issue duplicate initial overview reads.

Native order links and known totals remain visible while an individual missing
fact refreshes. Cold misses have a bounded automatic lookup and an explicit retry
on failure. A malformed config, expired sign-in, script failure or options failure
has a recovery message. Payment settlement polling and focus/visibility refreshes
remain intact. A failed options lookup cannot remove verified native totals.
Malformed optional action evidence is isolated from strict purchase/money
validation. Missing-order recovery is keyed to the missing identity set, so a
loading/failed state change cannot abort its own read; retries remain bounded and
sequential. Retained option displays and the current same-tab payment flow from
main are preserved.

## Release sequence

1. Apply `migrations/900000054000020010001_customer_account_native_summaries.sql` through the normal migration release. Its metadata was allocated to backend PR #2001.
   The integration tests execute this exact forward-only DDL; there is no separate
   SQL template or second schema owner.
2. Run the required checks on the final PR head and deploy the backend/migration
   before changing the theme. Deployment starts read-model maintenance for the
   configured enabled stores; no live scan was run during this implementation.
3. Verify `backfill_complete`, recent `delta_covered_until`, no blocking error,
   and coverage for the customer's actual first and historical order pages. Monitor
   Shopify throttling/available read budget during warming; live API headroom is
   not established by synthetic HTTP tests.
   Do not infer all-history coverage from one successful order lookup.
4. Test the companion theme unpublished, including sign-in, history pagination,
   slow/failed reads, panel actions and cancellation/refund transitions.
5. Promote only the account assets, preload snippet, account/order templates and
   the single layout include. Preserve other live theme files/configuration.

Read-only readiness queries (after the approved deployment):

```sql
SELECT connection_id,backfill_complete,backfill_after,delta_since,
       delta_after,delta_covered_until,last_error_code
FROM oms.customer_account_native_cursors ORDER BY connection_id;

SELECT channel_id,count(*) AS rows,
       count(*) FILTER (WHERE fact IS NOT NULL) AS verified,
       count(*) FILTER (WHERE fact IS NULL) AS pending,
       count(*) FILTER (WHERE last_error_code IS NOT NULL OR source_error_code IS NOT NULL) AS failed
FROM oms.customer_account_native_summaries GROUP BY channel_id;
```

Production p95, actual granted historical scopes, historical currency/data coverage
and production cache coverage remain unverified. The 500 ms goal is measured only
in synthetic browser acceptance until a deployed measurement proves otherwise.

## Validation

The scoped unit/SQL run exercises over 1,000 cases, including 26,001 historical
purchases, native IDs beyond JavaScript's safe-number range, exact/invalid money,
ownership changes, equal-timestamp races, lost leases, retries and checkpoint
freshness. The SQL tests execute against a fresh, loopback-only disposable database.

The actual account IIFE/preload builds are exercised on desktop and mobile with
fictional HTTP providers. Timing acceptance holds the fresh response open and
withholds the large editor bundle, then verifies the warmed order display under
500 ms. This isolates display readiness from provider/editor completion. Native
Liquid-theme regression coverage also exercises account and inline order details,
access recovery and existing financial/return interactions.

The full typecheck uses the exact `image-size` and `sharp` versions already pinned
by main in an isolated validation directory, because the reused local dependency
installation lacks those two packages. No dependency manifest/lockfile changes
or broad money-storage migration are included.
