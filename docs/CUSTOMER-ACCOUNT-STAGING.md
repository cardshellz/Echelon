# Customer account staging integration

This adds a storefront transport for the existing order edit engine and customer returns services. The theme assets are built with `npx vite build --config vite.customer-account.config.ts` and copied to the `cardshellz/cardshellz-theme` staging branch. The intended unpublished Shopify theme is **174740308127**. Do not publish it or copy these changes to the live theme during staging testing.

The Shopify customer account templates render their own orders immediately. Order numbers open the native order details page. Re-order uses the existing theme cart executor with the selected order's available variants. Edit and address actions appear only after warehouse eligibility is verified. Return intake appears only when the canonical return policy and delivery evidence allow at least one item. Existing return labels remain accessible through the owned return history, independently of new-return eligibility.

## Backend enablement

The exact `/api/returns/shopify/proxy/account` suffix is registered before the existing returns proxy router. It verifies the existing Echelon app's Shopify HMAC, shop, customer, path and timestamp on every request. Shopify forwards POST bodies and strips cookies, so staff cookies and Liquid IDs never authorize it. Inputs use a bounded JSON envelope; no new query parameters or Shopify credentials are exposed in the theme.

Leave `CUSTOMER_RETURN_CUSTOMER_ACCESS` unchanged. This gateway is separately default-off. Enable signed-in customers of the configured shop with the following **non-secret** Echelon config value:

```json
{"themeId":"174740308127","shops":{"card-shellz.myshopify.com":{"enabled":true}}}
```

The variable is `CUSTOMER_ACCOUNT_STAGING_CONFIG`. An absent config denies all staging customers; an invalid config denies requests with a configuration error. An enabled shop admits every independently signed-in Shopify customer. Application services restrict each customer to their own orders, edit operations and returns. The theme ID selects the intended rollout but is not authentication or evidence of a preview session. The shared API is available to authenticated customers once enabled; only the staging theme renders its new UI.

The account gateway accepts the configured storefront origin and the exact HTTPS myshopify origin from the independently verified Shopify principal. Shopify serves theme-editor previews on that shop host. Other stores, HTTP, alternate ports, opaque origins and missing/invalid command headers remain rejected. Failed origin checks log only bounded origin/header classifications, never raw headers or signed query parameters. Bootstrap errors render in the theme's status slot near the account heading; older themes without that slot retain the inline fallback.

The existing connection's order edit setting and payment window still apply. Customer quotes, commits, payments, refunds, recovery, picking holds, discounts, club pricing and shipping calculations are delegated to the existing services. No browser financial calculation authorizes an edit. The existing administration endpoints retain staff permissions.

Availability inspections use a repeatable-read, read-only database snapshot; hold, release and apply commands retain their locked verification. A failed per-order action lookup offers **Retry order actions** without bypassing eligibility. Storefront requests have a 25-second deadline including the response body. A timed-out mutation remains uncertain and is checked using its existing operation reference rather than automatically replayed. Once cancellation is confirmed, a failed fresh-order read keeps the cancelled review closed, blocks reviewing stale order data, and offers **Retry order** while allowing the dialog to close. A failed quote with no calculated quote does not display a legacy-shipping warning. Unclassified account failures log a bounded underlying error code when supplied, without SQL, credentials or customer data.

Migration `0745_customer_account_order_edit_actor.sql` preserves staff user foreign keys while adding channel/external-customer audit columns for Shopify shoppers. A customer operation must match its certified baseline's channel and customer. Audit rows remain append-only and are written in the same transaction as the operation. Customers are never inserted into the staff user table.

## Verification and cutover boundaries

Customer order edits use one editable form. **Apply changes** prepares the native edit and compares its verified items, quantities, product/coupon breakdown, shipping service, shipping/tax totals and payment/refund amount with the preview the customer approved. Only an exact match proceeds to the existing commit command. Different or incomplete evidence keeps the verified total in the same form and requires another explicit Apply. Drafts, previews and quote preparation do not hold warehouse work. Changing quantities, products or codes invalidates the saved verification through the existing cancellation command. Invalid codes preserve the accepted selection. Staff retain their existing review screen.

Known preparation failures keep the customer's selections visible and offer Retry changes without a status loop. A lost quote reply still reuses its original request key. An uncertain commit or cancellation still uses operation reconciliation; it is never automatically repeated. Expired verifications cannot be applied. These UI changes neither skip backend eligibility checks nor change payment/refund idempotency.

### Preparation diagnostics

Find the customer's **Edit reference** in structured application logs. `order_edit_requires_attention` includes the operation ID, connection/OMS order IDs, actor fingerprint, injected-clock timestamp and failing preparation phase (`warehouse_inspection`, `shopify_quote`, `quote_identity`, or `quote_persist`). `order_edit_quote_preflight_failure` adds the provider phase: current-order read, eligibility, promotion/variant pricing, native edit begin/item changes, shipping/coupon/tax verification, recovery-lineage validation, refund preflight or response validation. Hold cleanup failures use `unsubmitted_hold_release`. No preparation phase acquires a warehouse hold.

Error output is bounded to name/code, redacted message, eight stack frames, validation paths/codes and a limited cause chain. Full errors, SQL statements/parameters, snapshots, headers and credentials are not serialized. Database errors retain SQLSTATE and frames while suppressing row-bearing messages. Browser responses retain customer-facing messages and the operation reference. Correlate both log events with the saved operation/audit history before deciding on recovery; a generic error alone does not identify its root cause.

Local fixtures establish failure handling, not the cause of a past production failure. Deploy the backend diagnostics and staging bundle, then capture the next authorized attempt's reference and matching phase/cause. Do not replay a production quote or apply/refund command solely to generate logs without authorization.

On October 15, 2026, preparation diagnostics isolated a `quote_persist` validation failure for a quantity-only customer request carrying `discountCodes: []`. The provider schema emitted that optional field before `changes`/`additions`; the store compared raw JSON text with a projection placing it last. A disposable PostgreSQL regression reproduced the rejection despite equal plan values. Both service and store now use the existing canonical JSON serializer for plan equality, preserving array order, exact values, legacy omission and the existing request hash. Different plans still fail with the diagnostic path `quote.plan`. No pricing, coupon rules or native commit behavior changes. That persistence fix does not itself retry previously failed attempts; the owned resume flow below prepares them again without submitting them.

### Reopening a saved edit

The signed customer identity is passed into order eligibility. Only that actor's current operation can exempt its own warehouse hold; other holds, picking, shipment, and identity blockers remain enforced. Address changes stay unavailable while an edit is active.

Reopening an interrupted, failed or expired unsubmitted edit calls the owned `POST /order-edits/operations/:id/resume` command. It reuses the operation ID, request key/hash and saved plan. Under the existing order lock it first cleans up any legacy draft hold, then checks current ownership, connection settings, fresh Shopify identity/revision and eligibility, records `quote_preparation_resumed`, and calculates a new quote without holding fulfillment. Successful duplicate resumes return the current valid quote. Submitted commit/refund/recovery evidence cannot enter preparation. Resume never commits an order or moves money.

### Submission-only warehouse holds

Apply persists `submission_started` (`committing`, with no Shopify financial intent yet), then atomically checks the warehouse cutoff and acquires its dedicated hold. A picker that wins this race prevents submission. After a fresh Shopify revision check, `commit_intent` is persisted before invoking the provider write. Payment, refund, recovery and unknown submission outcomes retain the existing reconciliation protection.

A failed acquisition, stale order, or explicit `OrderEditCommitNotSentError` releases only this operation's hold. The worker also handles interrupted pre-send attempts and legacy failed-quote holds, including `review_required`. It never retries the Shopify commit. Unsubmitted cleanup verifies durable financial intent and paid-projection evidence, restores only provider holds with this operation's active receipt, and saves local release, receipt retirement, operation state and immutable audit together. Manual order/shipment holds and preexisting provider holds remain intact. A provider outage retains ownership for cleanup retry; an unknown Shopify commit response is not proof that nothing was submitted.

Migration `900000010000018180001_order_edit_submission_holds.sql` makes new warehouse partitions inherit holds only from approved submission/financial states and records provider receipt retirement. It does not clear any production holds directly. A newer-source conflict with a previously certified edit remains owned by that submitted edit, not a newly opened draft. Deploy the additive migration and backend before staging theme PR #151. Do not roll the backend back to draft-time acquisition without accounting for this trigger change.

The customer form waits for the saved plan before initializing quantities. A successful resume exposes the verified total for an explicit Apply; repeated failures retain selections and offer Retry changes. A lost resume reply uses status reconciliation without automatically resending or applying the edit. Preparation diagnostics remain active, with uncaught resume failures tagged `phase: resume`. Deploy the backend resume endpoint before the matching staging theme bundle. Real Shopify application/payment remains a separate acceptance step.

- Unit/HTTP tests exercise valid and invalid signatures, anonymous requests, wrong stores/paths, stale proofs, shop enablement, account switching, foreign orders/operations, command keys and transport confinement.
- Real PostgreSQL tests apply the migration verbatim and exercise audit identity, database constraints, immutable history and concurrent edits alongside existing financial hold tests.
- Theme browser fixtures exercise desktop/mobile account actions, grouped quantities, collapsed calculations, membership blocking notices and lost-response recovery. These use deterministic mocked backend responses and do not prove deployed Shopify payments or postage.
- The deployed authenticated roundtrip must verify forwarded Origin/custom headers, account A versus B, picking and delivery gates, quote/apply/payment/recovery, existing label downloads and theme isolation.

Memberships stay visible in the available catalog but cannot be added through order editing. Attempting to add one shows the existing separate-purchase explanation. No membership checkout flow is introduced. These changes do not request customer order-update/refund emails or publish the customer returns portal.

Rollback the staging theme branch to its preserved pre-feature commit and unset `CUSTOMER_ACCOUNT_STAGING_CONFIG`. Keep the additive audit migration so any customer edit evidence remains readable. Unsetting access does not stop the existing recovery worker from resolving an already committed operation.

Shopify proxy behavior: https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
