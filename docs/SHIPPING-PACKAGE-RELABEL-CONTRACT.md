# Package-scoped label replacement

## Identity and quantity contract

An order line is not a physical package. A source shipment item can supply
several independently labeled portions. The commercial quantity belongs to the
physical item allocation; a replacement label transfers that allocation without
creating demand, changing inventory, or fulfilling its quantity a second time.

`scopeLabelReplacementPredecessors` scopes candidates by source identity and
exact provider order identity when available. The shared WMS shipment header and
provider order key discover related evidence, but do not prove which package is
being replaced. Selection retains the complete candidate package; it is not
authorization to write. Missing exact provider lineage retains the alternatives
for the existing uniqueness/quantity checks rather than choosing an arbitrary
old label. Combined orders with distinct source lines keep the existing path.

`reconcileEbayLabelReplacement` is the existing shared Shopify/eBay owner entry
point (the historical name is retained for compatibility). Before a transfer it
still requires:

- Exact unchanged quantities and complete coverage of the prior physical package.
- Projected, persisted void evidence and no confirmed carrier possession.
- No other pending label claiming the same physical allocation. Unrelated
  source lines and independently identified split packages are not competitors.
- Settlement of in-flight channel commands; Shopify cancellation and readback
  must complete before replacement fulfillment is authorized.
- One transactional, idempotent, append-only quantity transfer. Existing
  deferred PostgreSQL conservation/provenance constraints remain unchanged.

`readFulfillmentRequestAllocation` preserves exclusive legacy provenance and
package-portion replacement provenance as separate fields. A portion is a replay
only for the same provider package and source. Sibling portions still count
against the same reservation and paid quantity; they are not mistaken for
attempts to change an immutable package.

The audit entry records the matching contract version, old/new label and provider
order identities, prior physical package, source line, and quantity delta. All
stock, picking records, original allocations, and successful channel commands
remain unchanged.

## Bounds and unresolved evidence

An admission reads at most 501 effective candidate items and 101 unmaterialized
related labels (one overflow sentinel each). The supported limits are 500 items
and 100 candidate labels. Overflow is explicit review, never a truncated match.
Candidate label histories retain the existing 500-event bound. Provider calls
remain outside the admission transaction. No work is added to UI read paths.

Missing/conflicting lineage, competing claims, changed quantities, incomplete
packages, and carrier-possession conflicts stay in review. Splitting or merging
an already allocated package into changed quantities requires a separate
allocation plan; this change does not weaken the existing conservation contract.

## Regression coverage

The migration-backed shipping integration suite exercises four one-unit packages
from one line plus a different line under the same WMS header/order key, using
distinct provider order IDs. Real admission, quantity transfers, cancellation,
and channel worker execution run against disposable PostgreSQL and mocked
Shopify. Assertions cover exact five tracking updates, per-line quantities,
reverse arrival order, concurrent distinct/duplicate admissions, delayed voids,
transaction rollback, replay, and repeated relabel. Ambiguous lineage and genuine
competing labels must make no transfers. Existing Shopify/eBay combined-order,
carrier, correction failure, and immutable-audit regressions are also retained.

## Deployment and acceptance

This is code only: no migration, historical data rewrite, inventory adjustment,
or notification-policy change. Tests do not constitute production acceptance.

Previously reviewed replacements are not automatically made retryable by a
deployment. For a historical case such as 63268, first take a fresh read-only
snapshot of ShipStation labels, allocations, completed Shopify cancellations,
and current Shopify fulfillments. Preview the exact replacement commands and
obtain approval before replay through the normal owner API. Use the existing
silent repair policy for historical backfill; do not manually mark an order
fulfilled or bypass provider readback.

Independently verify the resulting Shopify line quantities and active tracking
numbers; replay once more to confirm no duplicate command, fulfillment, or
quantity transfer. Forward acceptance also requires a real label/void/relabel
observation traversing the webhook or sweeper and channel worker after deployment.
