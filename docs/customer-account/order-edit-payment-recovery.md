# Order-edit payment handoff and recovery

## Proven failure

The deployed theme bundle (SHA-256 `010edfff1e4f78a65642e174e7cbe3023584d67c6143985dbd5fa2873c43d011`)
matches the account build pinned to `64068e6bcf8565b052547b31e7920d8ecbfdd9d2`.
Its `CustomerOrderEditor.progress` treats `ORDER_EDIT_BUSY` as a definite error,
retains the old ready view and does not enable status observation. The error is
emitted by `PostgresOrderEditStore.withOrderLock` when another command owns the
order's advisory lock. No automatic checkout navigation follows successful Apply.

A read-only inspection of the reported operation found submission and a payment
URL, an outstanding balance until its configured deadline, and successful recovery
to the baseline after that deadline. Private order/audit details are retained only
under the ignored local `.codex-artifacts` directory. The holder of the lock at the
time of the screenshot is unknown; no browser network trace was available.

## Normal customer flow

1. The visible preview is approved once. `canConfirmOrderEditPreview` retains its
   exact cart, tax, discount, shipping and paid-balance comparison. A changed
   verified total requires another explicit approval.
2. Apply uses the existing operation ID and commit key. The existing financial
   service and worker still own submission, settlement and warehouse release.
3. A busy or uncertain reply moves to read-only observation of that same edit.
   Apply and Change items are hidden during observation. A read failure exposes
   one retry, which repeats only GET. It never resubmits commit or reconciliation.
4. The new `observationVersion=v1` read acquires the existing nonblocking lock to
   read a current document. If another command owns it, the response includes
   `commandInProgress:true`, even if the last saved status is still ready.
   Store failures remain failures; they are not represented as busy success.
5. The tab that explicitly applied this edit navigates to its verified HTTPS
   payment URL once payment is actually due and no payment error is present.
   It saves the existing customer/order-bound return hint before navigation.
   Opening an older unpaid edit never navigates automatically.
6. The existing account return flow loads the same operation and observes its
   completion. Completed/refunded/restored states cannot open stale payment URLs.

Manage order's Pay button now uses `useOrderPanelPayment` to read that owned
operation and open checkout directly. It does not mount the editor or ask for a
second payment click. In-flight commands and already-processing payments remain
under read-only observation; settled payments never open the old checkout.

`retainedOrderActions` keeps the last verified, identity-bound display separately
from the current lookup state. Background refreshes, failed reads and individual
owner outages keep known controls visible, including when the panel is closed
and reopened. A newly verified policy restriction replaces that display;
`not_managed` or mismatched identities remove it. The signed API and existing
command owners still decide whether an action is allowed when used. No stale
snapshot is sent back as command authority or stored in a new shared cache.

If a conflicting operation leaves the draft unsubmitted, observation returns to
the saved editable plan without automatically sending another Apply. Confirmed
expiry after Change items reloads the original order; a submitted/completed edit
is never described as a successful draft cancellation.

## Compatibility and release

Legacy strict clients receive their original DTO. Observation metadata is opt-in
only on the signed customer operation GET; staff transport defaults are preserved.
Deploy the backend before testing the new assets on unpublished staging theme
`174740308127`. No migration, production configuration change or historical order
patch is required. Promote only the two built account assets and their build pin.
Do not bundle the separate account-history preloading implementation.

## Validation and limits

Synthetic service tests hold the real application lock interface across concurrent
commands, verify a ready document stays busy, and read the original payment result
without submitting financial work. Signed HTTP tests cover opt-in negotiation and
session requirements. Actual built-theme desktop/mobile tests cover one-click
handoff, changed-total approval, lost replies, concurrent busy commands, failed
reads/retries, saved-plan recovery, and return from simulated payment.

The exact request/response sequence in the customer's old browser cannot be
reconstructed from the screenshot alone. No real edit, charge, refund, points
command or checkout submission was performed during diagnosis or acceptance.
The fix remains local until a separately reviewed release is deployed.
