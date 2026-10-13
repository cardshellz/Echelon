# Exact shipment cost totals

Shipment charges are separate from the supplier's contractual PO charges.
The PO's shipment summary reads only its allocated share of each linked,
non-cancelled shipment. A missing allocation or unsupported currency produces
an incomplete combined total. Confirmed charge evidence uses the same supplier
invoice resolver as cost application. Estimates and inventory application
failures remain visible.

## Financial authority

Amounts remain integer cents or integer 1/10,000-dollar units (the existing
mill columns). Migration 751 adds nullable product, packaging and landed
extended totals plus the original variant quantity to inventory lots.
These totals own financial calculations. Rounded per-unit fields remain
compatibility/display mirrors.

For a component amount T, original quantity Q and interval [s,s+n), allocation
is floor(T*(s+n)/Q)-floor(T*s/Q). Adjacent complete intervals conserve T.
The existing sealed base-piece allocator and stock cost allocator share this
integer primitive. No user-entered rounding adjustment is required.

Immutable quantity allocations identify financial portions of each lot.
Positive allocations occupy intervals; explicitly linked reversals release
them; references carry the same intervals through return or output evidence
without consuming a second physical quantity. The existing inventory owners
continue to own physical stock, reservations and command retry identity.

Financial applications, picks and transformations use the existing graph lock
before lot locks and the caller's transaction. Source applications record the
actor, timestamp, before/after component evidence, exact target amount and COGS
delta. COGS records retain extended component totals and their quantity
allocation. Valuation reads remaining intervals in one consistent snapshot.
Dispatch, unpick and cutover checks accept exact component totals only when
quantity allocation evidence is present; legacy rows retain their original
quantity-times-unit-rate validation.

## Historical records and rollout

Apply migration 751 before running this application version. It does not blindly
backfill historical costs or change physical inventory. Historical positions
are established from recorded consumption, transformation and explicitly
linked reversal/return quantities, ordered deterministically. Missing quantity
history, conflicting operation intervals, manual component protections and
unsupported source evidence remain review results.

After deployment, an authorized purchasing approver can retry **Push Costs to
Lots** on the affected shipment. The changed application fingerprint creates
the exact-total application and a repeated successful request replays it.
Review the application result and PO summary after retrying. Shipment closure
can complete independently of a financial application; its UI now reports
review or retry results explicitly.

This change neither approves invoices nor creates payments, rewrites supplier
PO totals, accepts purchasing variances or automatically repairs live records.
