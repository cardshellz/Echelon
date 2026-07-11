# Dropship Carrier Protection Policies

## Ownership

Carrier protection is an internal Card Shellz financial policy. It is separate from:

- the shipping insurance-pool funding percentage;
- marketplace/customer return policy;
- carrier claim proceeds;
- vendor retail profit, marketplace fees, and tax.

## Policy terms

Each policy version defines covered carrier events, wholesale merchandise and shipping reimbursement percentages, deductible, optional cap, event wait periods, damage-inspection requirements, payout trigger, claim-tracking requirement, and approval mode.

Policy versions are immutable after activation. Changes create a new version under the same `policy_key`. Activating a superseding version closes the prior version at the new version's start, allowing a gap-free scheduled transition. A policy with active assignment rules cannot be retired.

## Assignment precedence

Active assignment rules match channel, warehouse, carrier/service, destination, and shipment-value bounds. Matching is deterministic:

1. scoped rules before the default fallback;
2. higher priority first;
3. more-specific rule first when priorities tie;
4. lowest assignment ID as the stable final tie-breaker.

Only one default fallback may be effective at a time. Future defaults may be scheduled when their policy windows do not overlap. Resolution fails closed when no rule matches or the selected policy does not cover the carrier event.

## Financial invariants

- Calculations use integer cents and basis points.
- Merchandise basis is the affected wholesale-cost snapshot.
- Shipping basis is the affected shipment's charged-shipping snapshot.
- Vendor retail margin, marketplace fees, and taxes are never reimbursement inputs.
- Split orders cover only the affected shipment.
- A single physical shipment receives the full order-level shipping charge.
- A zero order-level shipping charge allocates zero to every shipment.
- For split orders with a positive shipping charge, each shipment receives a proportional share based on its captured positive label cost. Largest-remainder rounding with shipment-ID tie breaking guarantees that allocations sum exactly to the original order shipping charge.
- Label cost is an allocation weight only. It is never substituted for the amount charged to the vendor.
- Split-order allocation fails closed when any shipped package lacks a captured positive label cost.
- The allocation set includes every shipped WMS fulfillment row, even if item linkage is incomplete. Incomplete linkage may block a claim's merchandise calculation, but it must never silently remove a physical shipment from the shipping-charge denominator.
- Carrier-protection policy amounts currently support USD only. Claim intake rejects other currencies until policy thresholds, deductibles, and caps become currency-scoped.
- Once a carrier claim has a policy snapshot, its policy, event, financial inputs, and calculated credit cannot be rewritten.
- Approved credit may differ from calculated credit, but both values remain auditable.

## Claim intake

Carrier claim intake accepts shipment identity and event evidence, never caller-supplied money. It requires the WMS order to be fully shipped so the physical shipment set is final, resolves the accepted dropship economics snapshot, calculates affected wholesale cost from shipped quantities, creates or verifies every field in the immutable shipping-allocation set, resolves the effective policy, and freezes the proposed credit and currency.

Initial claim states are deterministic:

- `waiting_period` until the configured loss or misdelivery wait expires;
- `awaiting_inspection` when damage requires an RMA inspection;
- `awaiting_carrier_claim` when policy requires external carrier claim tracking;
- `pending_approval` once prerequisite evidence is complete.

## Admin API

- `GET /api/dropship/admin/carrier-protection`
- `POST /api/dropship/admin/carrier-protection/policies`
- `POST /api/dropship/admin/carrier-protection/policies/:policyId/activate`
- `POST /api/dropship/admin/carrier-protection/policies/:policyId/retire`
- `POST /api/dropship/admin/carrier-protection/assignments`
- `POST /api/dropship/admin/carrier-protection/assignments/:assignmentId/deactivate`
- `POST /api/dropship/admin/carrier-protection/resolve`
- `GET /api/dropship/admin/carrier-protection/claims`
- `POST /api/dropship/admin/carrier-protection/claims`

All mutation endpoints require admin permission and an idempotency key.

## Deferred execution work

Claim intake now resolves and snapshots the applicable policy, affected wholesale cost, allocated vendor shipping charge, and proposed credit. Approval transitions, carrier-payment reconciliation, wallet posting, and insurance-pool accounting remain a separate audited financial workflow.
