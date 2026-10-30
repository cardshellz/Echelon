# Customer return recovery

## Customer interaction

A return that could not finish shows one **Try again** action. Customers do not see Check status, Retry saved request, Prepare or recover labels, or a separate rejection-to-review action. Loading is shown only while a request is in flight. Completed returns retain their label downloads and normal navigation.

Try again resumes the original saved request. If the server confirms that the request was rejected before authorization, the same action clears the local recovery receipt through its existing owner and reloads current return items. There is no second rejection-screen click. Old selections and source revisions are discarded; a new key is created only after the customer reviews the new selection and explicitly requests labels.

Unknown outcomes retain their original key and request. An absent server command can replay the identical submitted request under that key. An accepted return continues its reviewed boxes; uncertain label attempts receive at most one reconciliation call per explicit action. A still-uncertain result stops the loop. The existing backend remains responsible for deciding whether recovery is GET-only or a new label purchase is allowed.

Opening or reloading the portal reads saved results only. It never enters the preparation or purchase loop. Duplicate recovery clicks are coalesced while a request is in flight. Response identities and parcel counts are checked before any further preparation call. A failed local receipt clear cannot begin a fresh lookup or discard the original key.

## Validation and limits

Unit tests cover lost responses, same-key retries, multiple boxes, bounded reconciliation, duplicate clicks, response identity changes, session changes and storage failures. Browser tests cover both the standalone portal and the compiled account modal on desktop and mobile, including the exact expired-request-to-fresh-review sequence with one click.

All test orders, carrier responses, labels and receiving receipts are synthetic. No real order, return, label purchase, refund, inventory or points command is part of validation. This changes the customer interaction; it does not change server eligibility, pricing, receiving, or purchase-reconciliation rules.

The source app and companion customer-account bundle must both be released for their respective surfaces to receive the change. The companion theme targets the existing unpublished staging theme; it must not publish the live Shopify theme implicitly.
