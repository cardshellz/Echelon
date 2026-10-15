# Shipment cost reconciliation

The existing exception acceptance records a review decision only. It cannot
finish financial reconciliation. A correction must retain receipt and stock
history while giving every approved unresolved cost a durable financial
destination, with exact amounts, before/after evidence, approval authority,
transactional posting and safe retry behavior. A historical adjustment must
not invent an order, receive goods again, or change physical stock.

The implementation reuses the existing cost application, approval and durable
command owners. Real production investigation evidence stays local. Published
tests use synthetic records only.

## Implementation and validation

Work in progress. Production application requires a reviewed preview of the
specific correction. Existing saved charges and successful cost applications
are preserved.
