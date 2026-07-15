# Controlled Automatic-Purchasing Pilot Runbook

This runbook exercises one low-risk SKU through the automatic recommendation-to-PO
handoff without widening the scheduled job or creating a batch of POs. It does not
authorize a production mutation. The owner must review the preflight evidence and
explicitly approve execution.

## Safety contract

- Preflight is the default and is read-only. It does not create an auto-draft run,
  recommendation decision, PO, PO line, event, or handoff.
- Execution requires all three inputs: an exact SKU, `--execute`, and an attributable
  `--actor` value.
- Pilot execution is manual-only. Scheduler-triggered or unattributed pilot requests
  are rejected before a run is created.
- The SKU must match exactly one current recommendation. Zero or multiple matches fail
  closed.
- The recommendation must pass the current approval policy and all existing supplier,
  receive-configuration, quote, demand, and candidate-quality gates.
- `review_only` mode blocks execution.
- The pilot sends exactly one recommendation to the existing atomic handoff. That
  transaction can create at most one PO and one product line. A concurrently changed
  recommendation is skipped rather than drafted from stale evidence.
- The ordinary scheduler and existing Purchasing UI behavior are unchanged.

## 1. Deploy and select the candidate

Deploy the pilot-control change through the normal reviewed release process. Select a
real, low-risk SKU whose demand can be trusted and whose preferred vendor, vendor
product, receive variant, order UOM, quote basis, quote date, and quote validity are
known. Do not use a placeholder, gift card, donation, or duplicate catalog artifact.

Do not change the global approval policy to make a candidate pass.

## 2. Run read-only preflight

Run this on an authenticated application dyno, replacing `EXACT-SKU`:

```text
heroku run --app cardshellz-echelon "npm run procurement:automatic-purchasing-pilot -- --sku=EXACT-SKU"
```

The command exits `0` only when the candidate is eligible. An ineligible preflight
prints structured blockers and exits `2`. Save the JSON output with the change ticket
or pilot evidence.

Before approving execution, verify:

- `matchCount` is `1`, `eligible` is `true`, and `blockers` is empty;
- `autoDraftMode` and `approvalPolicy` are the intended production settings;
- product, receive variant, preferred vendor, and vendor-product IDs are exact;
- suggested order pieces and receive/order UOM fields are operationally correct;
- pricing basis matches the vendor quote;
- quoted unit mills and the normalized line economics are correct: base-piece unit
  mills, derived cents mirror, quoted extended mills, product-cost cents, and any
  deterministic pricing remainder;
- quote reference, quote date, and validity are correct;
- demand confidence, candidate score/band, quality gate, and autopilot blockers are
  acceptable; and
- the printed limits remain one PO and one PO line.

Preflight and execution each calculate a fresh recommendation. Execution returns its
own economics snapshot, so compare that result with the saved preflight and stop if a
material input changed.

## 3. Obtain explicit approval and execute once

After the owner approves the saved preflight, run the exact SKU once with a real
operator identifier. `OPERATOR-ID` must be the existing application user ID used by
the PO audit foreign keys, not an arbitrary display name or email address:

```text
heroku run --app cardshellz-echelon "npm run procurement:automatic-purchasing-pilot -- --sku=EXACT-SKU --execute --actor=OPERATOR-ID"
```

The result includes the run ID, created PO, execution-time economics, accepted
decision ID, handoff decision ID, PO ID, and PO-line ID. If the outcome is
`stale_snapshot_skipped`, do not assume a PO was created; re-run preflight and review
the changed recommendation. If the command output is interrupted or uncertain, query
the run and mapping before attempting any retry.

## 4. Verify durable database evidence

Use the IDs returned by execution. These queries are read-only; replace the angle-
bracket placeholders with integers from the result.

```sql
SELECT id, run_at, triggered_by, triggered_by_user, status,
       heartbeat_at, lease_expires_at, items_analyzed,
       pos_created, lines_added, error_message, finished_at
FROM public.auto_draft_runs
WHERE id = <RUN_ID>;

SELECT COUNT(DISTINCT h.purchase_order_id) AS purchase_order_count,
       COUNT(DISTINCT h.purchase_order_line_id) AS purchase_order_line_count
FROM procurement.purchasing_recommendation_po_handoffs h
JOIN procurement.purchasing_recommendation_decisions d
  ON d.id = h.accepted_decision_id
WHERE d.auto_draft_run_id = <RUN_ID>;

SELECT h.id AS handoff_id, h.recommendation_id, h.kind,
       h.accepted_decision_id, h.handoff_decision_id,
       h.purchase_order_id, h.purchase_order_line_id, h.created_by, h.created_at,
       accepted.source AS accepted_source, accepted.decision AS accepted_decision,
       handed.source AS handoff_source, handed.decision AS handoff_decision
FROM procurement.purchasing_recommendation_po_handoffs h
JOIN procurement.purchasing_recommendation_decisions accepted
  ON accepted.id = h.accepted_decision_id
JOIN procurement.purchasing_recommendation_decisions handed
  ON handed.id = h.handoff_decision_id
WHERE h.purchase_order_line_id = <PO_LINE_ID>;

SELECT po.id, po.po_number, po.vendor_id, po.status, po.physical_status,
       po.financial_status, po.source, po.auto_draft_date, po.created_by,
       line.id AS po_line_id, line.line_number, line.product_id,
       line.expected_receive_variant_id, line.vendor_product_id, line.sku,
       line.order_qty, line.unit_of_measure, line.units_per_uom,
       line.expected_receive_units_per_variant, line.pricing_basis,
       line.pricing_source, line.purchase_uom, line.purchase_uom_quantity,
       line.pieces_per_purchase_uom, line.quoted_unit_cost_mills,
       line.unit_cost_mills, line.unit_cost_cents, line.quoted_total_cents,
       line.total_product_cost_cents, line.line_total_cents,
       line.pricing_remainder_mills, line.quote_reference,
       line.quoted_at, line.quote_valid_until
FROM procurement.purchase_orders po
JOIN procurement.purchase_order_lines line ON line.purchase_order_id = po.id
WHERE po.id = <PO_ID> AND line.id = <PO_LINE_ID>;

SELECT id, po_id, event_type, actor_type, actor_id, payload_json, created_at
FROM procurement.po_events
WHERE po_id = <PO_ID>
ORDER BY id;
```

Required result: the run is terminal `success`, its lease is cleared, the count query
returns exactly one PO and one line, both immutable decision links exist, the PO line
matches the approved economics and receive configuration, and a `created` PO event
identifies the operator.

## 5. Complete the business lifecycle

Open the draft through the normal operator workflow. Either cancel it with a recorded
reason or, for an approved real purchase, process it through the ordinary approval,
vendor, receipt, invoice/landed-cost, and audit lifecycle. Do not fabricate receipts or
invoices merely to make the pilot appear complete.

Do not broaden automatic approval policy or unattended scheduling until the complete
business lifecycle is verified and the evidence below is reviewed.

## Evidence record

```text
Pilot date/time:
Owner approval reference:
Operator actor ID:
SKU:
Saved preflight artifact:
Auto-draft mode / approval policy:
Recommendation ID:
Product / receive variant IDs:
Vendor / vendor-product IDs:
Suggested pieces / UOM:
Pricing basis:
Quoted unit mills / cents mirror:
Line total:
Auto-draft run ID / terminal status:
Accepted decision ID:
Handoff decision ID:
Handoff ID:
PO ID / PO number:
PO-line ID:
Created-event ID:
Lifecycle outcome (cancelled or processed):
Receipt / invoice / landed-cost evidence, if applicable:
Exceptions or follow-up:
Final reviewer:
```
