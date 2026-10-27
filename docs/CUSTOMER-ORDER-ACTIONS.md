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
One available slot prefers due published evidence; another prefers unbuilt
history. Either lane can use otherwise-idle capacity. Neither a busy refresh
queue nor initial backfill can starve the other.

Source triggers only append this module's invalidation events. They do not calculate
eligibility, lock the derived row or modify their source records. Events are committed or
rolled back with the order, line, warehouse, claim, fulfillment, delivery,
catalog-weight and configuration changes that caused them. Relinking invalidates
both parents. Reads immediately reject evidence with a pending event. The worker
coalesces events into generation changes. Completion checks the lease, pending
events, generation and current owner; a late
inspection cannot replace newer evidence.

Active/otherwise editable orders are scheduled for refresh after one minute;
returnable orders after five minutes; closed/ineligible orders daily. Scheduling
a provider refresh does not make unchanged, verified navigation evidence unusable.
Its separate hard validity is bounded to 24 hours and the exact return-window
boundary. Local source events invalidate immediately. A visible page polls only
the local lookup every 30 seconds (five seconds while pending), so it observes
those invalidations without starting provider work. Existing fresh review and
command owners, rather than this presentation evidence, authorize every mutation.

Independent inspection failures do not discard the other capability's verified
result. Known permanent faults wait for a source/configuration change. Transient
faults use bounded backoff and stop after five attempts for that generation;
source invalidation clears the failure and permits new inspection. Structured
logs identify the order and phase without provider bodies, addresses or secrets.
An unavailable, expired or invalidated projection cannot enable unknown actions.

### Purchase-date authority

The returns inspector verifies exact channel, connection, order, customer and
purchased-line identities. A replicated OMS order date is not an identity key:
legacy imports can retain the local receipt time. The freshly verified Shopify
`createdAt` owns the displayed purchase date and return-window calculation.
`processedAt` and OMS `ordered_at` do not override that source. Both observations
remain validated and bound into the review revision; changed evidence during a
read or between selection and review still requires a new review.

The purchase-date correction release invalidates previously failed derived return
inspections through the existing dirty queue. This includes stopped retries, so
the normal worker can rebuild their options without an order-specific repair.
Healthy entries and edit-only failures are not requeued by that migration.

## Original return packages

Verified original package measurements are retained separately in
`returns.customer_return_box_measurements`. Each measurement is bound to the
channel, original package identity and a fingerprint of tracking and all retained
contents. Local package/label provenance is still rechecked before reuse. Mixed,
voided, unattributable or changed packages do not inherit unrelated measurements.
Only the background inspector retains measurements; customer GET paths do not
write them. A missing measurement falls back to the existing exact provider
lookup; a cache outage is reported and does not suppress that fallback.

These are verified return-package measurements, not a complete inbound shipment
measurement feed. `CanonicalShipmentEvent` currently has no dimensions contract,
and `physical_shipments` has no typed dimension columns. The inbound adapter maps
shipment identity, tracking, service, cost and items, without measurements.
Shipping pack-plan dimensions describe the plan and must not be treated as an
observed original package. A historical order without canonical purchased-line
and package allocation links cannot acquire a verified original box through its
display number or SKU alone.

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
