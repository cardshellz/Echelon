# Shopify voided and replacement labels

## Scope and status

This change closes the canonical Shopify void/relabel gap. A voided label cannot
send a new fulfillment. If its fulfillment already reached Shopify, the worker
cancels only the matching package, verifies the result, and then lets the exact
replacement use the existing label-time fulfillment path.

Implementation and local tests are complete. Deployment and a real Shopify
void/relabel acceptance check are not proven by these tests. No production data,
inventory quantities, emails, or historical backfills were changed during this
implementation. Unrelated catalog work was preserved in a separate checkout.

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
