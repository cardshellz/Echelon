# Inventory cutover reconciliation handoff

## Purpose and boundaries

Legacy reservation logic can reserve against product-wide ATP and attach that
promise to the assigned picking bin, even when the bin is empty. An empty-bin
promise is accepted customer demand, not proof that a particular physical lot is
reserved there. The cutover must retain that demand without inventing lot custody.

This extension is part of the existing reviewed, transactionally fenced cutover.
It is not a background cleanup, generic reservation-release endpoint, new review
page, inventory count adjustment, or historical cost recovery tool. Deploying it
does not activate canonical authority or modify production reservations.

## Whole-position eligibility

`planCutoverReconstruction` classifies a position only when all of the following
are established by the captured owner evidence:

- On-hand and packed quantities are zero; the reserved counter is positive.
- All lots at that exact variant/location have zero on-hand and zero reservations.
- There is no independent build hold at the position.
- Every nonzero reservation belongs to an exact ready-order/pending-item owner
  in the same warehouse, for the same variant and full current ordered quantity.
- Those items have no picked/fulfilled quantity, cost records, build demand,
  shipment source, physical package, hold, or short reason.
- Each owner has one complete journal position, with known quantities and no
  picked or shipped balance. The entire owner sum equals the complete counter.
- No unknown journal evidence exists at that position.

The algorithm never chooses a convenient subset of orders to fit a counter.
Negative, orphaned, terminal, unknown and partially lot-backed evidence remains
blocked. Ownerless `reserve_move` history is retained as unknown at both source
and destination; it is not interpreted as an exact positive or negative owner.

An otherwise eligible proposal does not clear unrelated reconstruction blockers.
The complete census must be ready before any handoff can execute.

## Preview, execution and audit

1. Reconstruction preserves requested customer quantity, moves the qualifying
   promise into fresh demand, and records the complete proposed release with
   expected level counters and exact owner journal hashes.
2. Preview projects removal of those empty-bin promise counters in memory only.
   The existing canonical planner then applies the configured warehouse/location,
   conversion, safety and shared-capacity rules. Orders see earlier orders' new
   holds; they do not each plan against a fresh copy of the same stock.
3. Requested quantity is preserved even if supply cannot satisfy it. The ordinary
   claim shortfall remains explicit rather than disappearing or being invented as
   physical stock.
4. Publication preview uses the same release-plus-fresh-reservation projection.
   The existing final-review UI discloses the number of affected positions and
   order lines. Full release evidence is covered by the review hash.
5. Commit recaptures evidence under the exclusive admission fence, validates the
   reviewed evidence and planning impact, and calls the inventory-owning handoff
   port before persisting fresh claims.
6. The inventory owner locks exact levels/lots, rechecks counters, full journal
   ownership and absence of lot/build holds, then compare-and-sets each complete
   reservation counter. It appends owner-specific negative reservation deltas
   with zero on-hand movement, actor, reason, time, run and evidence provenance.
7. Releases, new reservations/claims, activation changes and the immutable
   reconstruction receipt share the caller's transaction. A downstream failure
   rolls everything back. The receipt contains release evidence and generated
   journal IDs; replay returns that receipt without repeating releases.

The handoff changes no on-hand, picked, packed or cost quantity. New physical
reservation allocations still go through the existing inventory owner and its
normal lot/cost validation; no FIFO history is fabricated.

## Repeated channel acknowledgments

The OMS reader still captures every non-processed receipt. It groups only ignored
receipts whose latest attempt is also ignored, has boolean `sourceEcho: true`,
matches the current attempt counter, has no error, and contains complete scoped
provider/channel/order/fulfillment/physical-package identities.

Each grouped acknowledgment **remains an inventory-reconciliation blocker**.
Grouping is not current package-content verification, shipment posting proof, or
COGS proof. Incomplete, processing, failed, mismatched and review attempts remain
individual blockers. Different channel/order/provider/package scopes never merge.

The group digest preserves full receipt membership and latest-attempt evidence.
JSONB is retained as database text inside the evidence envelope so bigint IDs and
provider numeric values above JavaScript's safe-integer range cannot hash as the
same rounded number. Group identities use a full scope hash, not truncated IDs.

## Historical shipment/cost exceptions

A shipped package with a missing original pick/cost record is not eligible for
this promise handoff. Allocation-backed physical items legitimately have null
legacy pointers; that does not make them unshipped demand. Inventory intents that
are shadow/disabled are not completed stock postings.

Do not retry shipping to manufacture historical evidence: an existing ship
journal can make replay return without restoring cost, while a missing ship
journal can permit a new debit from current stock. Original order/lot/cost lineage
must be established separately before proposing a historical repair.

## Verification and rollback expectations

- Unit coverage: exact eligibility, whole-position sums, malformed/unknown/moved
  ownership, sources/packages, terminal missing-cost cases, legal planning and
  preserved shortfall, cumulative supply, snapshot changes and immutable inputs.
- PostgreSQL coverage: owner query shapes, real promise audit/CAS, exact retry,
  downstream rollback, lot/owner/counter drift, both transfer endpoints, and
  publication-preview/commit parity.
- Receipt coverage: complete identity scopes, latest attempts/errors, malformed
  evidence, full digest changes, bounded subjects and adjacent bigint values.
- UI coverage: disclosed handoff counts, older review compatibility, no automatic
  activation, and existing stale-evidence/retry controls.

No migration or writer-baseline expansion is required. If deployment must be
rolled back before activation, the existing authority remains unchanged. After a
committed authority switch, do not undo these audit rows or restore old counters
by hand; use the established post-cutover operational recovery process.
