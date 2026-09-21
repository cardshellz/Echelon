# Shopify voided and replacement labels

## Scope and status

The channel correction handles a void after the shipping owner records it. A voided label cannot
send a new fulfillment. If its fulfillment already reached Shopify, the worker
cancels only the matching package, verifies the result, and then lets the exact
replacement use the existing label-time fulfillment path.

Implementation and local tests are complete. Deployment and a real Shopify
void/relabel acceptance check are not proven by these tests. No production data,
inventory quantities, emails, or historical backfills were changed during this
implementation. Unrelated catalog work was preserved in a separate checkout.

## Void discovery follow-up (2026-09-21)

Production readback after PR #1516 demonstrated a separate intake gap: ShipStation
shipment `460595426` was voided and replaced by `460686839` for the combined
orders #63261 / #63300. Echelon still stored the original as active, and both
Shopify orders retained tracking `877510065050` instead of `877520887962`.
The five other voids returned by the same recent ShipStation query, for #63268,
were already recorded as voided in Echelon. This does **not** establish that all
voids fail, or that ShipStation sent a void notification. The documented
`SHIP_NOTIFY` trigger is outbound-label creation, not a guaranteed void event.
Both shipment shapes share intake; receiving a replacement must also refresh
known prior labels rather than depend on a separate notification for the void.

### Immediate replacement-label check

`processShipNotify` now refreshes related active labels before observing and
allocating the incoming outbound label. The shipping-owned read port reuses the
indexed source/request/engine relationship discovery and exact provider order
identity. It excludes the incoming label itself, returns and already-recorded
voids. No SKU, order-number, default-store or quantity-based void inference is used.

The provider read uses each prior label's actual order ID (which can differ from
the new label's order after combining/recreating shipments). Standalone labels
are looked up by tracking but still require an exact provider label ID match.
Only confirmed provider `voidDate` evidence enters the existing void observer
before the incoming label's commercial processing. An active split sibling is
left untouched. Provider read/identity/observation failures fail the webhook and
use the existing durable webhook retry path; they cannot authorize a guessed void.

The refresh is bounded to 50 candidate labels, five pages per provider order,
and ten cached order/tracking scopes per webhook. No database connection is held
across HTTP calls. First labels with no known related active label incur no
additional provider read. This runs on notification intake, not a WMS page load.

### Periodic safety net

The follow-up adds `shipstation-label-reconciliation.*` in OMS:

- A separate scheduler starts after 30 seconds and checks every five minutes.
  This remains necessary for a void with no replacement or a missed creation event;
  replacements no longer wait for the next scheduled scan to discover known voids.
  It respects `DISABLE_SCHEDULERS` and `SHIPSTATION_LABEL_RECONCILIATION_DISABLED`.
- It queries the [ShipStation V1 shipment list](https://www.shipstation.com/docs/api/shipments/list/)
  by **void date**, not label creation date, including exact item contents.
  V1 query boundaries use Pacific local time, matching the shared provider date contract.
- One run processes at most ten voids. Related orders are read sequentially, by
  exact provider order ID, with at most five pages of 100 labels each. HTTP reads
  have a ten-second timeout and no inline rate-limit sleeps. No connection is
  held across provider HTTP calls. This work does not run during a WMS page load.
- A fenced database lease and persisted page/window survive restarts. A failed
  read, observation, outbox insertion or checkpoint commit retains that page for
  retry. Concurrent workers cannot advance each other's progress.
- Voids are observed first; related labels then enter the **same** commercial
  fulfillment processing used by webhooks. This discovers void-only cases and
  reconsiders replacements that arrived before their predecessor void.
- Bootstrap checks the preceding 24 hours, with a two-minute provider settle
  delay. Completed scans overlap by 24 hours; an outage backlog advances in
  one-day windows. This is not an unbounded historical backfill. Very late
  provider visibility beyond the overlap requires a separately approved replay.
- Invalid identities, ambiguous dates, incomplete pages, changed contents and
  carrier-possession conflicts are not silently accepted. Failed/stalled
  discovery is visible in the **existing Operations Tower**, including its
  checkpoint error code. A persistently malformed page requires investigation;
  it is not skipped while reporting the scan successful.

Migration `0693_shipstation_label_reconciliation.sql` adds only the durable
checkpoint; OMS is its sole writer. Existing shipping evidence, channel outboxes,
correction receipts and inventory ownership remain unchanged. The same configured
V1 account is used as current webhook intake; supporting additional ShipStation
accounts requires account-scoped credentials and checkpoints, not a default-store
fallback. Shopify/eBay account selection remains with their existing channel owners.

This follow-up is implemented locally, **not deployed or applied to those orders**.
Provider GET verification was read-only. Deploy the migration before starting the
scheduler. Turning off its feature flag pauses discovery, not correction work
already enqueued. Existing carrier-possession checks and notification policy
remain in force; this is not a promise of silent customer notifications.

New regressions cover missed ordinary/combined voids, a replacement-only webhook
whose new label has never been recorded locally, no replacement, valid splits,
cross-provider-order source relationships, complete pagination, partial failure,
restart, concurrency and stale leases. Real PostgreSQL tests exercise discovery through provider observation,
Shopify correction intake and replacement fulfillment, and verify unchanged
inventory. External provider mutations remain mocked; actual correction of
#63261 / #63300 still requires production acceptance after deployment.

Follow-up validation: 2,079 unit tests across 160 files and all 122 tests in
the package-allocation PostgreSQL suite passed. Migration-prefix and writer
ownership guards passed, and `0693` was checked against freshly fetched main.
Application/server-test typechecks report only the shared dependency tree's
missing `@noble/hashes`, `@noble/curves`, and `@scure/bip32` modules (and the
resulting unknown-byte errors) in untouched Dropship files. Complete CI with
the lockfile-installed dependencies remains required before merge.

## Concrete execution path

1. `CarrierTrackingService.observeLabel` persists shipping-engine evidence.
   An outbound void also calls the channel-owned intake, including on replay.
   Intake failure propagates so webhook/poll retry can repair the gap between
   evidence persistence and outbox insertion. No Shopify call runs here.
2. `enqueueShopifyLabelVoids` inserts one durable work row per exact physical
   package and originating OMS order. It stops pending/retry Shopify creates
   for that voided package. Previously successful command history remains.
3. `claimCommands` excludes known voided/superseded labels for Shopify as well
   as eBay. `assertShopifyCommandLabelActive` checks a claimed Shopify command
   inside the order lock and again immediately before the remote create.
   Already-in-flight requests are settled by the correction worker.
4. `createShopifyLabelLifecycleService.runDueBatch` shares the canonical
   Shopify order lock, waits for a processing predecessor, and resolves the
   originating channel's account. It requires persisted void/content evidence
   and refuses automatic cancellation after confirmed carrier possession.
5. `readShopifyLabelPackages` reads the exact Shopify order, verifies collection
   completeness, and paginates candidate package line items.
   `planShopifyLabelCancellation` compares exact tracking, fulfillment IDs,
   order-line IDs, and quantities. Same-SKU siblings are not authority to cancel.
6. `cancelExactShopifyLabelPackage` cancels only the proven fulfillment IDs.
   A fresh independent read must show cancellation before the work completes.
   Completion/retry/review and the append-only attempt evidence commit together.
7. `reconcileEbayLabelReplacement` also admits explicitly all-Shopify packages.
   Its legacy name and `wms.ebay_label_replacement_work` relation are retained
   for compatibility. Shopify waits for every predecessor cancellation receipt,
   then reuses the exact allocation-transfer and conservation guarantees.
   eBay retains its existing whole-source quantity contract.
8. `materializePhysicalPackage` and `projectCanonicalCommandQuantities` retain
   the saved Shopify package-sized source quantities, not all items from an
   aggregate WMS shipment header. Carrier replay reuses those same commands.
   The replacement goes through ordinary account-scoped fulfillment creation.

The correction worker has its own single-flight lane on the existing worker
timer. Slow correction calls do not block the normal fulfillment batch; both
lanes still serialize writes for the same Shopify order.

## Safety, assumptions, and failure modes

- Shipping-engine label evidence remains the source for package identity.
  Label-time commercial fulfillment is separate from carrier possession.
- No SKU-only matching, default-store fallback, whole-order cancellation,
  inventory movement, or new review page is introduced.
- One unit from a multi-unit source can be relabeled without cancelling its
  active sibling. Changed quantities, ambiguous predecessors, mixed providers,
  or a Shopify fulfillment containing multiple tracking numbers require review.
- A timeout after Shopify accepts cancellation is retried by reading provider
  state first. A local receipt rollback likewise does not require another
  cancellation. Transient provider errors use bounded exponential retry;
  permanent conflicts or ten attempts enter the existing Operations Tower.
- An incomplete order read (including more than 100 fulfillments), invalid line
  pagination, or changed remote contents is not treated as absence or success.
- Pending work remains pending if its database read/commit fails. Errors are
  logged. This is not a claim that malformed historical records repair themselves.
- A void with no replacement cancels the exact voided package's commercial
  fulfillment but does not invent a replacement or change physical quantities.
- New migration `0692_shopify_label_lifecycle.sql` adds durable work, immutable
  scope/attempt constraints, and a Shopify-only partial-source provenance rule.
  It performs no historical selection or backfill. Existing labels require a
  new/replayed observation; this change does not sweep old Shopify orders.
- Apply the migration before the new worker code. The schema change is additive;
  an application rollback pauses new Shopify correction work. It cannot reverse
  remote cancellations already accepted by Shopify, so inspect pending work and
  provider state before a rollback or any manual repair.

Shopify cancellation reopens fulfillment-order quantities; the replacement then
uses the existing fulfillment notification policy. This is not a change to that
policy and does not promise silent cancellation. The cancellation mutation has
no `notifyCustomer` argument. See the
[Shopify fulfillmentCancel contract](https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCancel).

## Validation

- OMS unit suites, shipping label/carrier unit suites, migration-prefix guard,
  and table-writer ownership guard: 1,942 tests across 154 files passed.
- The complete package-allocation PostgreSQL suite passed all 115 tests against the actual
  migration-defined schema and owner transactions. Nine new Shopify scenarios
  cover unsent and sent predecessors, late void, split source/sibling replay,
  lost cancellation response, a command claimed before void, concurrent workers,
  receipt rollback, and changed provider contents. Existing eBay replacement
  regressions are included. Provider API calls are mocked.
- Full application/server-test typechecks are blocked locally by missing
  `@noble/hashes`, `@noble/curves`, and `@scure/bip32` modules in the shared
  dependency tree. Reported errors are in untouched Dropship files, not in the
  changed shipping/OMS code. The unrelated dependency install was not modified.

Before deployment, CI must pass with the repository's complete dependencies.
After deployment, use an explicitly approved test order to verify: label creates
exact Shopify fulfillment; void cancels only that package; replacement produces
the correct tracking and quantity; an active sibling stays unchanged; later
carrier evidence does not create another fulfillment. A local mocked-provider
test is not proof of production behavior.
