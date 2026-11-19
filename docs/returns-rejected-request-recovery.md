# Customer return recovery

## Customer interaction

A return that could not finish shows one **Try again** action. Customers do not see Check status, Retry saved request, Prepare or recover labels, or a separate rejection-to-review action. Loading is shown only while a request is in flight. Completed returns retain their label downloads and normal navigation.

Try again resumes the original saved request. If the server confirms that the request was rejected before authorization, the same action clears the local recovery receipt through its existing owner and reloads current return items. There is no second rejection-screen click. Old selections and source revisions are discarded; a new key is created only after the customer reviews the new selection and explicitly requests labels.

Unknown outcomes retain their original key and request. An absent server command can replay the identical submitted request under that key. An accepted return continues its reviewed boxes; uncertain label attempts receive at most one reconciliation call per explicit action. A still-uncertain result stops the loop. The existing backend remains responsible for deciding whether recovery is GET-only or a new label purchase is allowed.

Opening or reloading the portal reads saved results only. It never enters the preparation or purchase loop. Duplicate recovery clicks are coalesced while a request is in flight. Response identities and parcel counts are checked before any further preparation call. A failed local receipt clear cannot begin a fresh lookup or discard the original key.

## Validation and limits

Unit tests cover lost responses, same-key retries, multiple boxes, bounded reconciliation, duplicate clicks, response identity changes, session changes and storage failures. Browser tests cover both the standalone portal and the compiled account modal on desktop and mobile, including the exact expired-request-to-fresh-review sequence with one click.

All test orders, carrier responses, labels and receiving receipts are synthetic. No real order, return, label purchase, refund, inventory or points command is part of validation. Server eligibility, pricing, receiving ownership and purchase-reconciliation rules stay in place.

The source app and companion customer-account bundle must both be released for their respective surfaces to receive the change. The companion theme targets the existing unpublished staging theme; it must not publish the live Shopify theme implicitly.

## Source transaction failure and label preparation

`oms.customer_order_actions_source_changed` used an unqualified PL/pgSQL variable named `source` inside queries of tables that also have a `source` column. The `return_item` branch reads `wms.returns`, and the `receipt_child` branch reads fulfillment receipts. PostgreSQL raises `42702` before these source transactions can commit. The forward migration qualifies that variable with a block label while preserving every invalidation branch and trigger. It updates the function only; it does not repair or rewrite customer records.

The connected three-shipment/two-return-box test now includes the canonical action-projection migration and its real source triggers. Previously that fixture omitted those triggers. The migration regression temporarily restores the original function in a disposable transaction, proves the receiving insert fails with `42702`, rolls it back, reapplies the correction twice, and proves receiving still queues its parent-order invalidation.

Submission failures report an allowlisted cause code and the failed boundary (settings, inspection, preparation, rate quote, intake, or label status), tied to the original command key and canonical order. Exception messages, SQL, addresses and carrier payloads are excluded. Unknown outcomes still retain their original command for safe recovery; diagnostics do not authorize a replacement or a new purchase.

During active work the portal says **Getting your return label** (or **labels** for multiple boxes). Retry instructions stay hidden while that work is in flight. A failed attempt has the existing single **Try again** action. Source and compiled theme assets both need release before the account modal changes.
