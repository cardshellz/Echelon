# Historical shipment cost-link repair

## User flow

On a shipment, choose **Edit shipment**, include the linked receipt, enter the
correct pieces, and select **Restore missing transfer and repacking cost links**.
The PO and shipment cost warnings also provide **Review transfer and repacking
links**, which opens that same form on the affected line. This entry only opens
the draft; it cannot approve or post anything.

The preview shows shipment and receipt quantities, the unchanged shipment charge,
each proposed transfer/repacking connection, and product, packaging, shipment and
linked order costs before and after for each affected lot. Quantities can already
be correct: the same command supports repairing the missing links alone.

An active administrator with purchasing approval permission checks the recorded
history and pieces per case/pack, supplies a reason, and approves once. The
transaction saves the quantity amendment, cost links, cost applications and audit
result together. It never creates stock movements, sales, historical COGS
postings, or inventory expense postings. Existing order cost rows change only
when their sale has recorded shipment evidence.

## Read-only trace: S260714003536, 2026-10-21

The linked records are shipment 89 / line 134, PO-20260520-002 / line 191, and
receipt **RCV-20260723-001**, receipt 229 / line 2703. The October receipt is a
different delivery. The recorded shipment still has 20,000 pieces, 20 cartons,
and $1,298.38 of shipment charges. The requested correction is 200,000 pieces in
the same 20 received handling units. No live correction was posted during this
development trace.

The original receipt movement 48317 identifies lot 1926. The candidate history is:

| Recorded history | Proposed cost connection |
| --- | --- |
| Transfer 48321, 20 cases, same timestamp and destination lot | 1926 → 1927 |
| Case break 48322/48323: one case became 10 packs; approved count 423 / movement 48331 adds 90 packs | 1927 → 1928 (10 packs) + 1930 (90 packs), sharing one case's cost |
| Approved count 421 / movements 48330 and 48329 reclassify 19 cases | 1927 → 1929 |
| Eleven recorded one-case-to-100-pack operations | 1929 → 1968, 2029, 2136, 2208, 2247, 2285, 2370, 2439, 2507, 2611, 2715 |

There are **14 proposed operations / 15 missing edges**, affecting **23 lots**
including seven existing output layers. Those existing links include split pack
outputs and are preserved. Matching records are candidates for administrator
confirmation, not a claim that today's catalog proves the original case size.
The approval explicitly confirms 10,000 pieces per case and 100 pieces per pack.

Four quantity gaps remain after these candidate connections: lot 1930 has three
packs, lot 1929 three cases, lot 1968 fifteen packs, and lot 2029 eight packs with
no linked destination. That is **three cases and 26 packs**. The existing records
do not establish that these goods were sold or lost. Their exact cost remains
unassigned and visible; approving the supported links does not expense it.

The trace found **383 existing order-cost records** in this graph. Applying the
same sale-evidence rule as the implementation verifies 382. The other record is
12865: five packs from lot 2507 on cancelled order 207590 / item 318935. Its
existing amount is preserved. The UI links the issue to that order.

`completed` is a picking state, not proof of shipment
(`shared/enums/order-status.ts`, `TERMINAL_WMS_DEMAND_STATUSES`). For completed
orders in this trace, actual outbound shipment-item coverage supplies the proof.
The repair does not infer a sale from an empty lot or from completed picking.

## Ownership and controls

- `proposeCostLinks` is the pure candidate planner. It requires matching product,
  variant, location, movement time, quantity and exact piece conservation. An
  unrelated unlinked receipt remains a competing source. Ambiguity is retained
  for review, never resolved by FIFO or SKU alone.
- `readCostLinkHistory` loads and bounds the complete candidate evidence, locks
  lots, movements, count approvals and existing order records, and fingerprints
  it. Count decisions and original movement records are retained in the immutable
  amendment evidence.
- `restoreCostLinks` runs within the existing quantity correction transaction.
  It records missing receipt origins and contribution edges through the inventory
  owners, then invokes the existing supplier and shipment cost application paths.
- `restoreHistoricalCostAllocation` reassigns only previously unassigned financial
  intervals. It appends reversals and replacement allocations, preserving original
  history and exact sub-cent remainders. It cannot take cost already assigned to
  stock or orders.
- `hasVerifiedCostSale` accepts the canonical shipped-order status or complete
  authoritative outbound coverage of the exact order item. Cancelled orders,
  incomplete coverage, queued/label-only shipments, voided shipments, replacements
  and pending provider membership do not establish that sale.
- `reviewRepairedOrderCosts` preserves unverified order-cost rows, includes the
  source order/shipment evidence in the cost application's immutable audit, and
  returns structured issues. The policy is retained on the receipt and enforced
  on later cost updates. Restoring shipment evidence permits a normal cost retry;
  the transfer/repacking links do not require another approval.
- Remaining quantity gaps keep their warnings after the links are repaired. The
  shared cost issue records that the source history was already reviewed, so PO
  and shipment views do not send the admin back through the same approval.
- Existing active-admin authorization, preview fingerprint, source locks,
  idempotent financial-command receipt, rollback, and shared cost-status readers
  remain the command's authority. The exact preview is recomputed before commit;
  changed history rejects the whole correction.

No migration or shipment-specific production SQL update is required.

## Validation

The disposable-PostgreSQL cases cover a complete 23-lot shape, existing split
operations, exact conservation of 12,983,800 cost mills ($1,298.38), unchanged
physical transactions/stock/order quantities, retained real gaps, a repair after
quantities were already corrected, released historical financial holds, explicit
admin confirmation, stale evidence rollback, competing approvals, replay and
verified shipment coverage. Unit tests exercise ambiguous/invalid history and
sale-evidence exclusions. Browser tests cover combined correction, before/after,
direct PO-to-repair navigation, durable approval history and uncertain-response
retry on desktop and mobile.

Local tests establish implementation behavior. Deployment and a live admin's
approval of the proposed history remain separate acceptance steps.
