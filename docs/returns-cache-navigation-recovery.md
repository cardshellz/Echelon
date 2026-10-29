# Return navigation during action-cache refresh

## Problem and code trace

An invalidated order-action projection is a pending display refresh, not a rejected return. `PostgresOrderActionProjectionStore.read` deliberately omits snapshots whose generation is stale. `CustomerOrderPanelLoader` previously translated that state into `loading`, and `CustomerOrderPanel` rendered a disabled Return items button. The customer could not enter the normal return lookup until the background queue reached the order.

The background projection remains a bounded local lookup on account-page and panel rendering. This change does not enqueue work from a display read, increase provider traffic for opening a panel, or use stale eligibility as submission authority.

## Normal flow

- A ready projection keeps the existing immediate, preloaded selection flow.
- If the projection is missing, refreshing or failed, a known owned order can open the normal return lookup explicitly. Native summary and action identities must agree. Existing sign-in and cancelled-order navigation restrictions remain.
- `CustomerWorkspace` loads that exact order through `CustomerReturnTransport.order`. The transport checks the response order ID and the existing server owner checks customer ownership, policy and quantities.
- Lookup failures show a retry in the same return window. The existing account transport bounds the request at 25 seconds. Review and submission still use the original fresh checks.
- A persisted unknown request takes precedence over a new lookup. A definitively rejected request can be left using the existing finish action, after which the customer can start again without waiting for the projection queue. No idempotency record is rewritten or automatically resubmitted.
- The shipped-order panel no longer announces an options refresh when the customer can enter returns. The standalone empty-state copy also no longer claims confirmed delivery is required.

## Validation

The compiled account bundle passed 26 desktop/mobile browser cases covering the ready path, invalidation with no panel-open provider calls, refreshing and failed projections, immediate modal opening, failed lookup and successful retry/review, fresh policy exclusions, mismatched response identity, old definitive rejection recovery and preservation of unknown saved requests. Existing packing, layout, original-box, review and lost-response cases remain in the same run.

All 183 existing account, cancellation, projection and customer-return-session unit tests passed. Client TypeScript checks passed. The full returns browser suite passed 169 cases, with three existing device-specific skips. All shipping/provider traffic and command effects in browser tests are synthetic.

## Assumptions, risks and failure modes

The signed account response or verified native summary must provide a canonical OMS order ID. Missing or conflicting identities do not gain a return capability. A navigation affordance is not evidence that items meet policy; fresh exclusions remain visible in selection, and no automatic review, submission or label purchase occurs.

The background queue continues normal processing. This repair removes its ability to prevent return navigation; it does not change worker ordering, rewrite a customer's order or reset an old command. A provider outage can still delay the explicitly requested lookup, with bounded failure and retry. Unknown submission outcomes must still be reconciled under the original key before starting another return.

The storefront consumes a compiled Shopify-theme asset. Delivering this change therefore requires the companion theme bundle and source manifest, not only an Echelon backend deployment. Source/browser tests do not prove that an unpublished or published Shopify theme has received those assets. Production diagnostics remain private; all test orders, policies, requests and shipping services are synthetic. No real order, points, inventory, payment, refund, return or label-purchase command is part of this work.
