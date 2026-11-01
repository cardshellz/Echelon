# Native storefront returns page

The standalone customer UI can run at `/pages/start-a-return` inside the Shopify
theme, using `client/src/customer-account/return-portal.entry.tsx`. It reuses
`CustomerWorkspace` and the existing signed account proxy transport. There is no
iframe and no new return, postage, refund or inventory command owner.

## Boundary and compatibility

- Liquid supplies the current theme and customer IDs as strings, or null for a
  guest. These select the UI only. The account HTTP boundary independently
  verifies Shopify's HMAC, shop, timestamp, customer, origin, allowed theme and
  session key on every request.
- The additional logical `GET /returns/order-options` mapping calls the same
  customer-scoped cached choices service as the standalone endpoint. It does
  not fan out to carrier or Shopify order inspections for the chooser.
- Guest sign-in stays on Shopify with a same-store return URL. Native-page
  sign-out uses Shopify's logout route, not the standalone app session endpoint.
- Return selection, review, durable label requests, retries, history and PDF
  downloads use the existing canonical clients through the signed proxy.
- Existing server workflows/history remain available after the origin change.
  Selecting an order restores its existing saved request before permitting a
  new request. Do not copy or replay old browser commands during launch.
- Existing app-hosted and embedded-account portals remain compatible.

## Build and release order

1. Deploy the additive signed chooser mapping before updating the theme.
2. Build `npx vite build --config vite.customer-return-portal.config.ts` from a
   saved source revision. Copy only `csz-return-portal.js` and
   `csz-return-portal.css` to the companion theme assets and record SHA-256 hashes.
3. Add `sections/main-return-portal.liquid` and
   `templates/page.return-portal.json`. Preserve the existing account bundle,
   layouts, settings, policy page, header and footer files.
4. Verify the unpublished theme using an existing page with
   `?preview_theme_id=174740308127&view=return-portal`. Shopify's documented
   alternate-template view parameter avoids changing the page's live template.
5. After production theme sync, create the Shopify page `start-a-return`, assign
   the `return-portal` template and verify guest/signed-in reads. Then update only
   Footer Support > Start a Return to the new storefront URL. Do not publish the
   entire staging theme or point the footer at the backend app.
6. Verify the published page's address, navigation, signed-in chooser, existing
   return history and guest sign-in destination. Do not submit a real return or
   purchase a label for release verification.

## Failures and rollback

Configuration errors render a visible contact/reload notice without sending an
unscoped request. A verified missing Shopify session offers sign-in; service
failures offer retry. Existing workflow recovery handles uncertain commands.
If the theme is released before the additive backend mapping, the chooser read
will fail; deployment order is required. If rollback is necessary, revert the
footer destination to the previous working portal; retain existing durable
requests and authorizations. No customer records require migration or repair.

## Verification

The compiled native IIFE is tested on desktop/mobile for guest routing, identity
configuration, signed-in choices/history, packing/review, lost-response recovery
without browser storage, protected downloads, no iframe, no external backend
navigation, scoped typography and preservation of the store frame. Signed HTTP
tests reject guest/substituted identities, wrong origin, invalid cursors, extra
query/body fields and writes to the chooser. These are synthetic tests; live
carrier purchases are excluded from release verification.
