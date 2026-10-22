# Customer order management panel

The account table has one **Manage order** control per order. Its panel presents
existing order details, editing, address changes, reorder, shipment tracking and
returns vertically. Whole-order cancellation is a separate confirmation within
that panel. Payment/fulfillment status belongs to the status column, not an edit
restriction beneath action buttons.

## Owners and contracts

- `CustomerOrderPanel` delegates edits/returns to the existing account modal,
  address/tracking to native theme links, and reorder to the existing theme
  handler. The reorder handler emits its error to the panel; there is no second
  cart implementation.
- `presentCustomerOrderFulfillment` projects canonical warehouse partitions.
  Unknown evidence is unavailable; it never infers picking from an edit refusal.
  Stopped warehouse work is labelled **Picking stopped** unless Shopify confirms
  the order itself is cancelled. When warehouse evidence is unavailable, the
  table and panel preserve the known native Shopify fulfillment label.
  Financial labels come from the existing settlement presentation owner.
- `managementVersion=v1` opts strict account/staff clients into new fulfillment
  and cancellation metadata. Older open tabs retain their original DTO shape.
- Signed Shopify ownership, staging gates, staff grants and same-origin command
  checks remain at their existing HTTP boundaries. Customer status reads cannot
  invoke financial reconciliation or accept a staff actor.

## Cancellation lifecycle

`OrderCancellationService` implements full cancellation as a strategy over the
existing order-operation store, advisory order lock, warehouse/provider holds,
reconciliation worker and append-only audit. It does not create an edit quote,
submit an edit with zero-priced merchandise, or issue a separate refund.

1. Review is read-only. It binds the current native order revision, remaining
   original-method refund and Club's canonical consumed/earned-point plan.
2. Confirm persists approval and one request identity before provider work.
   The existing order lock excludes a competing edit/cancellation. Holds are
   acquired only after approval; warehouse, order and reward evidence is checked
   again before the durable submission intent.
3. Only the confirmation command calls Shopify `orderCancel`. Its
   `OrderCancelJobResult` is observed through `node`; retries never resend that
   financial command. Unknown responses preserve ownership. An explicit refusal
   or failed job releases only this request's hold after proving the native
   order is unchanged and no cancellation has previously been observed.
4. Completion requires cancellation, final payment/refund transactions and the
   exact approved refund delta without an extra capture. Club verifies native
   cancellation/refund, disables original used codes, then returns consumed
   points through `processOrderCancellation` and its normal ledger transaction.
   Existing unused credits are excluded; original debits and expiry remain.
   Earned points use the existing refund/cancellation cap.
5. Existing Shopify cancellation webhook/reconciliation owners release inventory
   and cancel warehouse/provider shipments. The cancellation strategy verifies
   those facts; it does not become another inventory/status writer. Purchased
   line history is preserved. The operation, audit and hold release commit
   atomically after a fresh proof, including provider cancellation readback.

The existing staff operation link recognizes cancellation records. Authorized
staff can inspect/recheck the saved request; this exposes no second cancellation,
manual points adjustment or unverified hold-release command.

## Failure and availability policy

- The browser saves approval before POST, retains its identity through timeout
  and reload, and observes progress automatically. A pre-submission revision
  refusal requires a new review and explicit approval.
- Retry appears for actual request/status failures. Uncertain submission retries
  retain the same identity. Manual-review conflicts show the saved reference.
- Online cancellation uses the existing enabled, US physical-order, fully paid
  pre-pick scope. An active update, unsettled payment/refund or legacy warehouse
  `pending` row requires the existing flow to finish or staff assistance. The
  canonical cancellation cascade does not transition legacy `pending` rows;
  this UI does not add another warehouse-status writer to bypass that limit.
- Provider ambiguity, identity changes, inconsistent rewards and financial
  evidence fail closed. Refund/provider delays cannot report completion early.
- Disabling new submissions does not disable reconciliation of saved requests.

## Verification and release

The source test suites cover signed ownership, staff permissions/origin, strict
DTO compatibility, durable replay, concurrent confirmation, lost replies,
asynchronous refusal, refunds, rewards outages, hold cleanup and worker restart.
The existing PostgreSQL warehouse suite additionally exercises cancellation
proofs and transactional completion. Club's PostgreSQL CI suite covers consumed
points conservation, concurrent replay, code disablement and projection rollback.

The theme suite runs the compiled bundle with the actual Liquid templates and
native reorder methods. It covers desktop/390px/320px drawer geometry, keyboard
focus, existing editor/payment/rewards/returns paths, cancellation review/Keep,
double confirmation, reload recovery and failure-only retries.

`scripts/verify-order-cancellation-staging.ts` requires the exact Shopify
development store `cardshellz-staging.myshopify.com`. It creates tagged synthetic
resources, exercises the real provider's cancellation/refund job, verifies zero
remaining balance and deletes only its own resources. Its report is written to
`.codex-artifacts/order-cancellation-staging.json`. It accepts no live-store
domain, production order ID or real Club balance. A manual test payment proves
native cancellation/refund semantics, not credit-card settlement latency.

Release Club first, Echelon second, then the pinned account bundle/templates to
unpublished theme **174740308127**. Shared-service release approval is separate
from local/CI acceptance. Verify that theme's account pages read-only afterward;
never confirm a cancellation, edit, reward, charge or refund on a real order as
part of this acceptance.
