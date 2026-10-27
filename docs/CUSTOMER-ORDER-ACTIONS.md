# Customer order action lookup

The account page loads `/account/order-actions` alongside the existing native
financial summaries after authenticated bootstrap. It is a bounded, owned local
lookup for the visible page. Opening or reopening Manage order does not read
Shopify, ShipStation, edit eligibility or the complete return inspection.
Historical OMS display references may omit Shopify's leading `#`; comparisons
normalize that display prefix while retaining the exact external order ID and
current customer/channel ownership checks.

`oms.customer_order_actions` is derived presentation evidence, never the source
of truth for order quantities, money, warehouse work, return claims or permission.
The existing edit/cancellation/return services remain the decision owners. Their
fresh review and command checks are unchanged. Native financial summaries take
precedence over older action evidence in the panel header.

## Maintenance and concurrency

The normal background scheduler seeds missing orders for the already-enabled
customer-account shops in bounded batches; it does not inspect unrelated shops.
Two inspections can execute at once in each process. Work is leased with
`FOR UPDATE SKIP LOCKED`, so different processes cannot claim the same order.
Provider calls happen outside database transactions. A five-minute lease recovers
interrupted workers; no work is leased ahead of its available execution slots.
Due refreshes of already-populated panels take precedence over the initial
historical backfill, which otherwise starts at negative infinity and could
starve every existing panel.

Source triggers only append this module's invalidation events. They do not calculate
eligibility, lock the derived row or modify their source records. Events are committed or
rolled back with the order, line, warehouse, claim, fulfillment, delivery,
catalog-weight and configuration changes that caused them. Relinking invalidates
both parents. Reads immediately reject evidence with a pending event. The worker
coalesces events into generation changes. Completion checks the lease, pending
events, generation and current owner; a late
inspection cannot replace newer evidence.

Active/otherwise editable orders are refreshed at least once a minute. Returnable
orders are refreshed within five minutes, including external updates whose local
event has not arrived. Closed/ineligible orders are revisited daily. The exact
return-window boundary shortens these deadlines even without an event. Local
events invalidate immediately. The browser only polls the local lookup while a
projection is pending or expires; it never requests background provider work.

Independent inspection failures do not discard the other capability's verified
result. Known permanent faults wait for a source/configuration change. Transient
faults use bounded backoff and stop after five attempts for that generation;
source invalidation clears the failure and permits new inspection. Structured
logs identify the order and phase without provider bodies, addresses or secrets.
An unavailable, expired or invalidated projection cannot enable unknown actions.

## Original return packages

Verified original package measurements are retained separately in
`returns.customer_return_box_measurements`. Each measurement is bound to the
channel, original package identity and a fingerprint of tracking and all retained
contents. Local package/label provenance is still rechecked before reuse. Mixed,
voided, unattributable or changed packages do not inherit unrelated measurements.
Only the background inspector retains measurements; customer GET paths do not
write them. A missing measurement falls back to the existing exact provider
lookup; a cache outage is reported and does not suppress that fallback.

The existing unique-covering-box rule supplies the default. The customer sees
"Using your original shipping box", its dimensions and "Change box". That action
opens prefilled editable dimensions. Custom dimensions lose the original-box
claim and are validated normally. Missing or ambiguous original evidence asks
for the customer's actual package rather than inventing a size.

## Release and acceptance

1. Deploy the migration and backend first. This starts read-model maintenance,
   not order editing, return submission, refunds, label purchases or points work.
2. Check worker failure logs and lookup coverage for the staging account before
   releasing the companion bundle. Initial historical backfill is asynchronous;
   do not equate a merged backend with a fully warmed account.
   For bounded release warming, run `npx tsx scripts/warm-customer-order-actions.ts
   --order-id=INTERNAL_OMS_ID --actor=OPERATOR_ID` first as a dry run, then append
   `--execute`. Repeated `--order-id` values select at most 20 unique IDs;
   `--passes` is bounded to 1–10. This uses the same leased inspector, respects
   enabled shops and retry deadlines, and writes only derived lookup/measurement
   state. It does not start the application or recovery schedulers.
3. Deploy the rebuilt account assets only to unpublished theme 174740308127.
4. Verify that opening an already-loaded panel sends no eligibility/provider
   requests and displays its actions without waiting for them. The target is
   p95 under 250 ms for the authenticated lookup; local measurements are not a
   production latency guarantee.
5. Verify original and custom package display read-only. Use synthetic fixtures
   for review/submission/recovery; do not invent dimensions for a real order.

Tests cover read-only lookup, customer isolation, source transaction rollback,
concurrent leases, expiry, superseded completion, permanent/bounded failures,
package provenance, desktop/mobile instant panel reopening, default/custom box
dimensions, review retries and existing payment/cancellation behavior.
