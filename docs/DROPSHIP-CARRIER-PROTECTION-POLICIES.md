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
- Once a carrier claim has a policy snapshot, its policy, event, financial inputs, and calculated credit cannot be rewritten.
- Approved credit may differ from calculated credit, but both values remain auditable.

## Admin API

- `GET /api/dropship/admin/carrier-protection`
- `POST /api/dropship/admin/carrier-protection/policies`
- `POST /api/dropship/admin/carrier-protection/policies/:policyId/activate`
- `POST /api/dropship/admin/carrier-protection/policies/:policyId/retire`
- `POST /api/dropship/admin/carrier-protection/assignments`
- `POST /api/dropship/admin/carrier-protection/assignments/:assignmentId/deactivate`
- `POST /api/dropship/admin/carrier-protection/resolve`

All mutation endpoints require admin permission and an idempotency key.

## Deferred execution work

This configuration foundation does not automatically create or pay a carrier claim. Claim intake must resolve a policy, snapshot it onto `dropship_carrier_claims`, calculate the proposed credit, and route the result through the existing wallet ledger in a separate audited financial workflow.
