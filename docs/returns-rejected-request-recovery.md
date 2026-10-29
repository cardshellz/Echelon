# Recovering a definitively rejected return request

## Proven code path

`CustomerReturnCommandSession` restores the browser's saved command and calls its status endpoint. `CustomerReturnSubmissionService.status` reads the immutable server receipt; `completed` replays a definitive rejection without running current intake or creating a return. The receipt's historical reason is not a fresh eligibility decision.

The previous account-navigation fix made the return entry available during a cache refresh, but this terminal screen still offered Check status and Back to your orders. Rechecking a definitive rejection cannot turn it into a new request. The old allocation-error guidance also incorrectly told customers that original shipment records were still required.

## Normal recovery

The terminal screen identifies the saved result as an earlier attempt and offers **Review return items**. It removes the ineffective Check status action only for definitive rejections. Other outcomes keep their existing status/retry controls.

The recovery action is available only when the server has confirmed rejection, the request has no authorization ID and no request is running. It uses the existing `commands.finish` owner to clear the local recovery receipt. If that write fails, the saved request remains and no fresh lookup starts. The server receipt, original key and original error code are never rewritten.

After successful local clearing, the existing authenticated order lookup reloads current items for the account's requested order, or the saved request's order in the standalone portal. Old selections, package drafts and source revisions are discarded. Current policy, quantity, ownership and shipping checks still apply. A new submission gets a new key only after the customer chooses items, reviews the result and explicitly requests labels.

Unknown and accepted outcomes cannot use this action. Their original recovery identities remain intact, preventing duplicate return or label creation. The standalone chooser and existing Back to your orders action remain available through their normal owners.

The shared allocation-rejection guidance no longer asserts an original-shipment prerequisite. It describes the failed request and directs the customer to fresh item review. This changes public guidance, not stored rejection evidence or business rules.

## Validation and limits

The 34 compiled-account desktop/mobile cases passed, including direct recovery with ready and refreshing cache projections, current source revisions, explicit new-key submission, lookup retry, storage failure and preservation of unknown outcomes. Existing back/close, layout, packing and lost-response cases remain covered. All 204 account, customer-return-session and submission-service unit tests passed, including immutable replay of the old rejection with no intake, provider quote or label call. Client TypeScript checks also passed. The full returns browser run and server-test typecheck are reported separately against the published PR head before release.

Tests use synthetic customer data and shipping ports. No real order, points, inventory, payment, refund, return or label-purchase command was submitted. Production lookup and status evidence was read-only. The existing Back to your orders action was also used on a confirmed-rejected browser attempt, followed by reopening the fresh selection form with quantity zero. That normal UI action cleared only the local recovery receipt; the server history was preserved. A source deployment alone does not replace the Shopify account bundle; the companion staging theme must also receive the tested assets. Live label purchase and financial acceptance are not part of this validation.
