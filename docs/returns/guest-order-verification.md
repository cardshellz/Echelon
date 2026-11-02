# Guest order verification

## Customer flow

The existing store-hosted returns page offers guest lookup alongside Shopify sign-in. A shopper enters the order number and checkout email, verifies an eight-digit email code, and sees only that purchase and its existing returns. The existing chooser, item selection, box plan, review, durable label worker and protected download are reused. Previously created labels remain accessible after verification in another browser. Cancelled purchases are excluded from new-return choices; accepted return history remains accessible.

Account activation is optional. The guest return does not depend on registration, newsletter consent or account activation. An enabled Shopify customer receives a sign-in link. An inactive attached customer receives an activation URL for that exact Shopify customer. If Shopify has no attached customer, the optional registration link is for future purchases: this implementation neither reassigns the purchase nor claims that registration automatically attaches historical orders.

## Identity trace and proof

1. `CustomerReturnCustomerAuthService.storefrontShop` verifies Shopify's original signed proxy query, including shop, signed path and timestamp. A guest has an empty signed customer ID; this proves the storefront, not an order owner. The existing theme, shop, origin and command-header gate is reused.
2. `ShopifyGuestReturnPurchaseGateway.find` reads up to two exact OMS order-number matches in that channel. An ambiguous or missing match does not pick an arbitrary order. It reads the exact mapped Shopify order ID, verifies the returned shop, order ID, display number and checkout email, and retains Shopify's attached customer ID separately from the imported customer snapshot. It does not search for a customer by email.
3. `CustomerReturnGuestService.lookup` addresses email to the verified Shopify purchase email. Challenge IDs and browser bindings survive lost replies. Lookup responses disclose neither a customer ID nor whether an email matched. Email delivery is synchronous with a durable lease, not an exactly-once SMTP guarantee: uncertain delivery can resend the same code after the cooldown.
4. `PostgresCustomerReturnGuestStore.verify` locks the challenge, commits wrong attempts and caps attempts at five. An unverified code expires after ten minutes. A successful verification grants thirty minutes; correct retries replay the original grant without extending that lifetime. Grants are restricted to the channel and canonical OMS/Shopify purchase, not the customer's entire history. The application rechecks the local snapshot and exact Shopify purchase before accepting the grant.
5. `createGuestReturnServices` constructs the existing order-access service with its existing `kind: "order"` principal. Ownership SQL also restricts RMA, command, workflow and artifact reads to that order. A null imported customer cannot authorize all other guest purchases. The normal live inspection rechecks the verified Shopify email/customer evidence before accepting the return.
6. `ShopifyGuestReturnPurchaseGateway.account` reads the same purchase and passes `remote.customer.id` to `customerGenerateAccountActivationUrl`. It never invokes `customerCreate`, `orderUpdate`, customer merge, payment, refund, rewards or inventory APIs. Concurrent activation requests reuse one encrypted URL. If Shopify subsequently reports the account enabled, a retry offers sign-in instead.

Tests in `customer-return-guest-shopify.gateway.test.ts` assert the exact Shopify order/customer IDs, including a missing or stale imported customer link, a customer ID change, a changed email, missing customer, enabled account, activation replay and provider rejection. The PostgreSQL integration suite exercises actual transaction locks, leases, immutable audit evidence and the existing workflow repository/worker. Browser tests run compiled storefront assets on desktop and mobile with all external operations intercepted.

## Release prerequisites

This implementation has not been deployed. No real verification email, activation URL, return or label purchase was created during local staging tests. Real Shopify activation/mailbox acceptance remains a separate test with a designated synthetic purchase and inbox. No development-store purchase was established in this work.

The schema is allocated to Echelon PR #1984 at `migrations/900000048000019840001_customer_return_guest_verification.sql`, with allocator metadata and dependencies. Integration tests install that exact migration in an explicitly disposable loopback database. Before release:

1. Run migration validation, all required CI checks and the guest PostgreSQL suite from a fresh database.
2. Provision a separate random `CUSTOMER_RETURN_GUEST_SECRET` (at least 32 characters). It must differ from the Shopify app secrets and returns recovery-storage secret. Never commit or log it. Its deliberate rotation invalidates outstanding guest credentials.
3. Verify SMTP delivery configuration and the configured Shopify app's actual permissions. Purchase reads use the same pinned Admin API version and bounded transport as the existing return inspection. Activation requires `write_customers`; historical purchases require the approved historical-order read access. Missing activation permission must not prevent continuing a guest return.
4. Release the schema/backend first, then build the native return portal bundle and prepare the companion unpublished-theme asset update using the approved source commit. Do not overwrite account bundles, theme settings, unrelated files or the live theme as part of staging.
5. Native-provider acceptance remains deferred under the user's isolated-staging instruction. If later authorized with a designated synthetic purchase/inbox, verify guest lookup, email receipt, repeated verification, return history, activation and Shopify sign-in. Confirm the signed-in customer ID equals the customer ID already attached to that purchase. Registration for a purchase with no attached customer is not proof of a historical ownership link.

Shopify's activation API requires an existing customer and generates a one-time URL; see [the official API contract](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/customerGenerateAccountActivationUrl). A new URL invalidates an earlier one, which is why the explicit activation action is serialized and its result reused.

## Failure and retry behavior

- Wrong order/email: generic code response, no code sent to an arbitrary submitted email. Retry with corrected details or contact support.
- Expired code: request a new challenge. Resend keeps the original code until expiry; it does not reset attempts or prolong that code's lifetime.
- SMTP timeout: retain the same challenge and browser binding; a retry after the lease/cooldown can resend the same code. Duplicate delivery is possible; duplicate authentication grants are not created.
- Changed purchase email, attached Shopify customer or local identity snapshot: require verification again. No cross-order or cross-customer fallback is allowed.
- Lost label response: the existing saved request and backend worker own recovery. Signing out does not undo an explicitly submitted return request.
- Account activation permission/provider failure: show the failure in the optional account section; leave the verified guest return available.
- Missing OMS purchase mapping: do not fabricate canonical IDs or attach an unrelated customer. Diagnose/replay normal channel ingestion; this implementation does not introduce an order-specific repair endpoint.

All new writes are confined to returns-owned authentication tables and the existing explicit return workflow. Tests run only against disposable data; they do not alter customer orders, points, inventory balances or financial records.
