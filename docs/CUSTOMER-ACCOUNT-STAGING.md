# Customer account staging integration

This adds a storefront transport for the existing order edit engine and customer returns services. The theme assets are built with `npx vite build --config vite.customer-account.config.ts` and copied to the `cardshellz/cardshellz-theme` staging branch. The intended unpublished Shopify theme is **174740308127**. Do not publish it or copy these changes to the live theme during staging testing.

The Shopify customer account templates render their own orders immediately. Order numbers open the native order details page. Re-order uses the existing theme cart executor with the selected order's available variants. Edit and address actions appear only after warehouse eligibility is verified. Return intake appears only when the canonical return policy and delivery evidence allow at least one item. Existing return labels remain accessible through the owned return history, independently of new-return eligibility.

## Backend enablement

The exact `/api/returns/shopify/proxy/account` suffix is registered before the existing returns proxy router. It verifies the existing Echelon app's Shopify HMAC, shop, customer, path and timestamp on every request. Shopify forwards POST bodies and strips cookies, so staff cookies and Liquid IDs never authorize it. Inputs use a bounded JSON envelope; no new query parameters or Shopify credentials are exposed in the theme.

Leave `CUSTOMER_RETURN_CUSTOMER_ACCESS` unchanged. This gateway is separately default-off. Configure the following **non-secret** Echelon config value only after choosing testers:

```json
{"themeId":"174740308127","shops":{"card-shellz.myshopify.com":{"customerIds":["REPLACE_WITH_APPROVED_SHOPIFY_CUSTOMER_ID"]}}}
```

The variable is `CUSTOMER_ACCOUNT_STAGING_CONFIG`. IDs must be positive numeric strings, unique within the shop, with at most 50 testers. The example placeholder is intentionally invalid. An absent config denies all staging customers; an invalid config denies requests with a configuration error. Only the signed customer in that allowlist can access their own orders and their own edit operations. The theme ID selects the intended rollout but is not authentication or evidence of a preview session.

The existing connection's order edit setting and payment window still apply. Customer quotes, commits, payments, refunds, recovery, picking holds, discounts, club pricing and shipping calculations are delegated to the existing services. No browser financial calculation authorizes an edit. The existing administration endpoints retain staff permissions.

Migration `0745_customer_account_order_edit_actor.sql` preserves staff user foreign keys while adding channel/external-customer audit columns for Shopify shoppers. A customer operation must match its certified baseline's channel and customer. Audit rows remain append-only and are written in the same transaction as the operation. Customers are never inserted into the staff user table.

## Verification and cutover boundaries

- Unit/HTTP tests exercise valid and invalid signatures, anonymous requests, wrong stores/paths, stale proofs, tester allowlists, account switching, foreign orders/operations, command keys and transport confinement.
- Real PostgreSQL tests apply the migration verbatim and exercise audit identity, database constraints, immutable history and concurrent edits alongside existing financial hold tests.
- Theme browser fixtures exercise desktop/mobile account actions, grouped quantities, collapsed calculations, membership blocking notices and lost-response recovery. These use deterministic mocked backend responses and do not prove deployed Shopify payments or postage.
- The deployed authenticated roundtrip must verify forwarded Origin/custom headers, account A versus B, picking and delivery gates, quote/apply/payment/recovery, existing label downloads and theme isolation.

Memberships stay visible in the available catalog but cannot be added through order editing. Attempting to add one shows the existing separate-purchase explanation. No membership checkout flow is introduced. These changes do not request customer order-update/refund emails or publish the customer returns portal.

Rollback the staging theme branch to its preserved pre-feature commit and unset `CUSTOMER_ACCOUNT_STAGING_CONFIG`. Keep the additive audit migration so any customer edit evidence remains readable. Unsetting access does not stop the existing recovery worker from resolving an already committed operation.

Shopify proxy behavior: https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
