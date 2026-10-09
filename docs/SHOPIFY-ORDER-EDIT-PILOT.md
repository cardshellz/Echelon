# Shopify same-order edit pilot

This is a staff-only pilot at **Orders → Order editor pilot** (`/order-edits`).
It edits the existing Shopify order. The storefront, customer account pages,
Orderify entry points, and the existing return/refund flow are unchanged.

## Controls and ownership

- Every request requires an Echelon staff session and current `orders:edit`
  permission. Saving settings also requires `settings:edit`.
- Settings are per Shopify connection. The pilot starts disabled; an administrator
  chooses the payment window before enabling edits. Disabling new edits does not
  stop reconciliation of existing operations.
- The warehouse cutoff is the start of picking, including previous pick activity.
  Existing labels, combined orders, unsupported shipment providers, and ambiguous
  ShipStation identities block an edit.
- A durable operation owns the fulfillment hold. Manual warehouse and ShipStation
  holds are preserved. Confirmation, payment, refund and recovery evidence are
  recorded before fulfillment can resume.

The new persistence has explicit module ownership, enforced by the writer ratchet:

- `modules/order-edits` owns `oms.order_edit_operations`,
  `oms.order_edit_settings`, and `oms.order_edit_events`. Other modules append
  audit evidence through `appendOrderEditAudit` inside their existing transaction.
- `modules/oms` owns `oms.order_edit_paid_projections` and
  `oms.order_edit_provider_holds`, alongside the existing OMS order/line projection
  and ShipStation integration. The ingress guard queues provider reconciliation
  through `enqueueShipStationHoldSyncInTransaction`; it cannot write the retry
  queue directly.
- `modules/wms` owns the `wms.orders.order_edit_operation_id` mutation commands.
  Acquisition and release compare ownership, preserve manual holds, and run in
  the caller's locked transaction. Release proof, terminal state, and audit remain
  one atomic commit. The pilot adds no new writer to `wms.orders`.

## Staff flow

1. Select the Shopify connection. **Pilot settings** opens automatically while
   staff editing is disabled. Choose **Payment window (hours)**, check
   **Enable staff order edits for this Shopify connection**, and select
   **Save settings**. The saved status and payment window appear above the form.
   A disabled order also offers **Configure staff editing** to open and focus
   these settings. Staff without settings permission must ask an administrator.
   Saving enabled settings unlocks eligible order fields without reloading;
   a failed save does not enable a disabled connection. This setting does not
   grant customer access.
   Decimal hours are supported: `0.5` means 30 minutes and `1.25` means 75
   minutes. The API and stored setting retain whole-minute precision; invalid
   values or fractional-minute durations are rejected instead of rounded.
2. Search for an exact order number, with or without `#`. Existing active edits
   appear with **Resume edit**, including after closing the original browser tab.
3. Adjust quantities or select **Search or browse products**. Search by product
   name or SKU, or choose a category and expand a product to pick its actual
   pack, box or case SKU. Review the Shopify-calculated
   total before applying the change. The review compares original and proposed
   product prices, named product discounts, shipping charges and discounts, tax,
   and the final total. Payment history shows payments and refunds already
   recorded on the current order; a proposed change is not a payment. A quote
   holds fulfillment but does not commit the order edit or issue a refund.
4. Confirm once. If an extra balance is due, use Shopify's hosted payment link.
   The order remains held until payment and downstream contents are verified.
5. For a reduction, the pilot reconciles its own automatic refund to the supported
   original tender. It does not issue a return refund or restock inventory.
6. If an additional balance remains wholly unpaid when the saved deadline expires,
   the worker attempts to restore the original order contents. Partial payment,
   uncertain payment, changed contents or ambiguous refund results require review.

**Check status** reconciles the saved operation. It does not start another commit.
An unsubmitted quote can be cancelled after verifying the original order. A
submitted edit cannot be cancelled as though nothing happened.

Older saved operations retain their original evidence and display. For an
unsubmitted edit blocked by the former discount restriction, cancel that saved
edit and create a fresh quote after deploying discount support. Do not replace
its stored baseline or remove its hold directly in the database.

## Product discovery

The picker uses the selected connection's published, active Shopify products.
Categories are that store's existing product types. Product/pack relationships use
Shopify product and variant IDs; SKU strings are labels, not a guessed hierarchy.
Name search targets the parent product title and SKU search targets its variants.
Each search term is a prefix, so partial names and SKU prefixes are supported.
Categories, products and options all support pagination.

Catalog reads are authenticated GET requests. They do not create edit operations,
change holds, adjust inventory or send financial commands. Discovery results are
cached briefly for the current staff member and connection; stale search results
are hidden immediately while the next search loads. Errors offer a read-only
retry. Duplicate or unavailable variants cannot be added. The displayed unit
price is before discounts: preview and financial review still verify current
pricing, stock, discount eligibility, shipping and tax independently.

Local tests cover name/SKU queries, category and SKU pagination, parent identity,
stock restrictions, literal query construction, stale responses, retries and
desktop/mobile entry into the existing review flow. Live catalog search and
publication/category coverage must also be checked on the deployed connection.

## Pilot boundaries

- USD, domestic US physical orders only; Shopify and warehouse eligibility are
  rechecked. Orders with prior refunds or unsupported promotion/tender/lineage
  combinations fail closed.
- Shipping is recalculated for revised items using current checkout rates and
  eligible shipping benefits. Address editing is not included.
- Existing-line pricing is verified; added products use verified current member
  pricing when applicable. Native order-wide percentage and fixed discount codes are
  supported alongside verified shipping benefits, including free shipping.
  Shopify's exact line allocations determine net prices and totals; rounded
  discounted unit prices are not multiplied to invent a line total.
  Product-specific codes, scripts, unverified automatic product
  discounts, and orders with nonzero tax included in prices require staff review.
  The pilot does not assume a promotion is still valid.
- An edit requiring extra payment cannot completely remove an original line;
  restoring that line's identity on expiry has not been proven. Partial quantity
  reductions are supported. Emptying the entire order is rejected.
- This pilot does not request order-update or refund emails. Other independently
  configured Shopify apps and automations are outside that notification setting.
- A ShipStation shipment must have a verified provider identity before editing;
  an ambiguous create response is not proof that no remote order exists.

## Discount calculation and evidence

`priceOrderEditDiscounts` is a pure domain engine. All money is validated integer
cents; percentage arithmetic and penny allocation use `BigInt`. Only the original
order's accepted discounts enter the engine. There is no new coupon entry or
second rewards redemption in the editor.

1. Verified product and member discounts establish each eligible item subtotal.
2. Existing order percentages use that same subtotal, without compounding.
   A native per-line allocation must equal one of the two adjacent integer cents
   around the exact percentage. This covers the captured Shopify rounding; it is
   not a tolerance for an arbitrary difference in order totals.
3. Each fixed code has one original credit budget across the order. Quantity
   growth cannot multiply it. Removal must preserve that budget on the remaining
   eligible items. Shopify's distribution is accepted only if the budget and all
   item bounds reconcile exactly.
4. Shipping is reconciled separately; tax comes from Shopify. The final financial
   quote must reconcile every item allocation, discount, shipping amount and tax
   to the order total. Commit readback verifies the same per-code amounts and
   original rule identities before fulfillment can resume.

The review displays each proven percentage code and fixed credit separately,
including their before/after money amounts. Older saved operations or original
allocations that include quantities removed by a prior edit retain their verified
aggregate display rather than invented per-code amounts. Enriching old evidence
does not prevent cancelling an unchanged unsubmitted edit.

Shopify cannot edit existing order-level discount codes, and some fixed codes
retain allocations instead of redistributing when an item is removed. The engine
rejects lost or duplicated fixed credit before commit. It also rejects edits that
leave unused credit, or require choosing priority between multiple capped fixed
credits. Automatic settlement of unused Shellz rewards points is not implemented:
that requires a command owned by the rewards ledger, proven original redemption
identity, a capped settlement budget and retry-safe audit. A code name is not proof
of a rewards redemption. The editor does not mint a replacement discount or add a
manual compensating credit, which could bypass the original combination rules.

These boundaries follow [Shopify's order-edit rules](https://help.shopify.com/en/manual/fulfillment/managing-orders/editing-orders/considerations)
and [discount combination rules](https://help.shopify.com/en/manual/discounts/discount-combinations).

## Recovery and diagnostics

`oms.order_edit_operations` contains the current state, original snapshot,
accepted quote, deadlines and financial intent. `oms.order_edit_events` is an
append-only before/after audit. `oms.order_edit_provider_holds` records whether
ShipStation was already held. Logs use the `order_edit_*` event names with operation
identity and error code; credentials and hosted payment links are not logged.

The certified current contents are projected by the OMS owner with an immutable
before/after event. Historical purchased quantities remain intact. Scoped Shopify
ingestion guards protect that projection from older observations; normal
fulfillment and disposition commands retain their existing responsibilities.

Warehouse items do not have a `product_variant_id` column. Order-edit checks
resolve their independent catalog identity from `product_id` for catalog-mapped
rows or an unambiguous active SKU for legacy rows, then compare it with the
exact linked OMS line and inventory claim. Missing, ambiguous, or cross-order
lineage keeps fulfillment held. Both synchronization and release use the same
reader; regression fixtures must use the actual WMS column names.

The worker runs every 30 seconds without overlapping its own passes. Per-order
locking and persisted intent protect concurrent requests and restarts. Transport
errors retain retryable reconciliation; uncertain outcomes never authorize a
second blind commit. Refund retries retain the same persisted idempotency key and
are bounded by the provider's idempotency window.

Do not clear a hold, change a terminal state, replay a commit, or issue a second
refund by editing database rows. Resume the saved operation and inspect its
Shopify, OMS, WMS, allocation and ShipStation evidence. A manual-review state is
not permission to release fulfillment.

An unsubmitted edit can also be closed after the original order has finished
shipping. Cancellation verifies unchanged purchased quantities, prices, discounts,
payments and customer identity in Shopify; paid source quantities and completed
physical quantities in every shipped OMS/WMS partition; and shipped or cancelled
ShipStation orders across the full order-number scope. It reads ShipStation without
restoring or changing provider holds. The terminal edit state, removal of only its
owned warehouse edit lock, and before/after audit event commit together. Shipping,
manual holds, payments, inventory claims and fulfilled items are preserved.
Partial fulfillment, an attempted financial mutation, conflicting evidence or
active provider work still blocks this cancellation path. This cleanup does not
explain or repair how an order shipped while retaining its edit lock.

## Deployment and live acceptance

Apply migration `0723_shopify_order_edit_pilot.sql` before the new application
code serves requests. Confirm deployment and scheduler health before enabling a
connection. The migration enables no live-write setting.
Keep reconciliation running for existing edits when disabling the pilot. An
application rollback is not a substitute for resolving active holds.

Automated tests cover mocked Shopify behavior, UI journeys, picking/allocation
races, migration constraints and transactional rollback on an isolated PostgreSQL
database. They do not establish live mutation behavior.

Before customer rollout, perform supervised tests on explicitly selected orders:

1. An unpaid addition that expires: verify the same Shopify ID/number, restoration
   of original contents, exact inventory allocation, and preserved manual holds.
2. A paid addition: verify one additional payment, revised OMS/WMS/ShipStation
   contents, and release only after reconciliation.
3. A reduction: verify exactly one refund to the intended original tender and the
   correct remaining physical quantities.
4. A zero-balance change and an interrupted request: verify current paid authority,
   resumability, and no duplicate commit/refund.
5. A picking race, partial payment, or contradictory provider response: verify the
   edit is rejected or remains held with an actionable error.
6. An original percentage code plus a fixed reward: verify the percentage changes
   with eligible value, the fixed credit appears once, and the payment/refund
   difference matches the final total. Verify wholly unpaid expiry restores both
   the original contents and discount amounts. A removal that loses fixed value
   or leaves unused credit must be blocked before commit.

Record the order and operation IDs, before/after totals, provider transaction IDs,
warehouse partitions, allocation evidence and final status for each case. Customer
rollout and retiring Orderify remain separate work after these checks pass.
