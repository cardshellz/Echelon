# Split packages consume existing order-line requests

## Root cause and correction

`materializePhysicalPackage` previously created a shipment request for every new
legacy shipment row. `findOrCreateRequestItem` then counted the new child quantity
as additional requested demand. That is wrong when label-time fulfillment has
already created a request for the entire ordered line.

Example: four paid units, one canonical request for four, and one unit already
shipped. Three more one-unit packages consume the remaining three requested
units. They do not make the requested quantity seven.

`resolveFulfillmentRequestAllocation` now decides whether a physical item uses an
existing request or needs genuinely unrequested units. It preserves these checks:

- Exact replay keeps the immutable physical-item/request-item association.
- An exact original legacy item can consume a portion of its larger request.
- A child item can consume a unique request's remaining quantity only when the
  active plan, OMS order/line, WMS order/item, warehouse and persisted
  shipping-order membership match. Neither SKU similarity nor a nullable split
  root is used to invent identity.
- Multiple remaining requests are ambiguous, not an instruction to choose one.
- Cancelled/review requests are not reused. Request cancellations reduce net
  requested units, not the current paid/order authority.
- Effective physical quantities include both legacy and package-allocation
  provenance, including append-only quantity adjustments. Per-request and
  per-plan-line paid limits remain enforced.
- A package with both an already-requested line and a new line can reuse one
  request and create the other atomically.

The existing immutable physical item records its actual child shipment item,
order line, quantity and selected request. Commands retain the actual package's
tracking, item identities and notification intent. No new table, migration,
inventory writer, provider bypass or manually rewritten source pointer is needed.

## Transactions and previews

The writer retains the shipping identity and canonical plan/line locks until
commit. Request rows are locked before deciding available quantity. Physical
items are inserted before processing the next item, so later decisions see
consumed quantities. Combined-package line processing has a stable lock order.
Failures after physical insertion or command creation roll back the whole
package, including any parent-order alias inserted earlier in the transaction.

The read-only `validatePhysicalPackageIdentity` compatibility API now loads the
same item context and runs the same request-allocation decision. It is not just
a header check. It does not reserve capacity, simulate writes using rollback, or
prove Shopify will accept a later request. The writer rechecks current state;
the provider adapter independently validates current channel/package state.

## Verification and deployment boundary

The regression suite builds the observed 44-package / 18-order / 19-line shape
using the real label/allocation materializer to create the original full-line
requests and one-unit physical items. It covers 46 backfill units, a twenty-unit
line shipped across twenty packages, and a mixed existing/new-line package.
Concurrent backfills create only one command per package. The real Shopify
adapter runs against a mocked transport and receives the exact package tracking
and line quantities with `notifyCustomer: false`; replay does not create another
fulfillment. Inventory, WMS fulfilled quantities and allocation ledger counts
remain unchanged. Separate tests cover last-unit contention, late rollback,
changed warehouse/parent membership, cancellation, ambiguity and invalid input.

On 2026-09-16 at 01:45 UTC, the unmerged fix's read-only database validation passed
all 44 previously approved production packages. That validation performed no
database writes or Shopify calls. It is not evidence of deployed code or a
completed production backfill.

After this change is merged and its exact commit is verified in the deployed
release, refresh provider evidence for the same approved scope, execute the
existing silent backfill workflow, and verify the resulting Shopify tracking and
line quantities. Keep already-correct packages and separately held/review
commands excluded. Do not increase paid quantities, shrink existing requests,
change inventory or retry held commands to force completion.
