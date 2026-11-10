# Account session and history pagination

`CustomerOrderPanelLoader` treats a missing connection during successful session
initialization as pending, rather than comparing the cached display's connection
against `null`. Cached data cannot initialize an edit, address change, cancellation
or return before the authenticated session is adopted. Real access failures and
connection/OMS identity mismatches after adoption still fail visibly.

`ShopifyOrderEditProvider.accountNativePage` delegates progress to
`advanceAccountNativeScan`. Discovery chooses an ID range boundary, then re-reads
that entire range with Shopify's opaque page cursors. Unordered rows are valid;
duplicates, out-of-range IDs and non-advancing cursors fail explicitly. The lower
ID boundary advances only after the range is exhausted. A range is split and
replayed after 10,000 records, before Shopify's documented 25,000-object limit.
An observed split pivot avoids repeatedly bisecting empty, sparse ID space. All
ID comparisons use `BigInt`; a sample never establishes that other IDs are absent.

`PostgresAccountNativeSummaries` stores independent, versioned history and delta
checkpoints bound to the connection and exact delta window. Existing numeric
checkpoints remain unchanged for compatibility with an overlapping old release.
An in-flight delta also retains its own start time and update window, so an older
worker cannot advance those underneath it. The new scan starts from the beginning, preserving cached facts; this deliberately
revisits rows that the previous seek might have skipped. Facts commit before
progress advances, and the existing lease fences cursor writes. A failure may
replay a page but cannot checkpoint its unread successor. Delta coverage advances
only at completion and retains the existing scan-start overlap.

Validation uses fictional purchases, mocked Shopify HTTP, disposable PostgreSQL,
and browser fixtures. It includes 26,001 adversarially ordered purchases, exact
large IDs, a lost checkpoint, a provider failure, legacy checkpoint restart,
foreign-owner rejection and concurrent lease fencing. Main-theme tests cover
desktop/mobile cached-session adoption, a real connection mismatch and a failed
session read followed by retry. No live customer commands are used.

Deployment requires the additive checkpoint migration before the backend reader,
then the companion main-theme bundle. Existing scheduler limits and access scopes
remain in force. Re-reading history adds bounded provider reads until coverage
completes; it does not edit purchase, payment, inventory or rewards records. Hosted
production acceptance and historical scan completion require post-release checks;
local staging acceptance does not establish either.

## Cold historical purchases

`CustomerAccountOrderQueriesService.savedNative` keeps warm reads database-only.
For missing purchases it uses one bounded native Shopify summary query for only
the missing IDs. It verifies customer, channel, shop, ID and order reference;
there is no pricing calculation, warehouse inspection or edit preparation.
`ShopifyOrderEditProvider.readOrderSummaries` retains validated, source-versioned
facts through the existing cache owner so subsequent reads need no provider call.

This also recovers purchases without an OMS row. Previously their absence from
both OMS and the saved cache meant the ownership-gated refresh queue could not
enqueue them; retrying only reread the same missing facts until the store-wide
scan reached them. The queue's ownership gate remains unchanged. A failed cold
lookup preserves every known total, reports a classified error and permits the
same normal read to recover on retry. Customer API contracts and theme assets
are unchanged; this correction requires only a backend release.
