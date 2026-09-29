# Customer returns access and private validation

This change connects a Shopify customer login to the existing Echelon returns engine. It does not enable public customer access or change refund authority. Staff still apply refunds manually in Shopify. The existing `/return-portal` administrator preview remains separate.

## Identity and order authority

1. The Club application's new `/api/app-proxy/returns` entry validates Shopify's documented proxy signature, signed shop, timestamp, and customer identity. It does not require Club membership. The bridge is disabled by default.
2. Echelon `/customer-returns/start` resolves the approved login destination and creates a five-minute challenge bound to the initiating browser session. Shop input here is only a navigation hint; it never grants order access.
3. The bridge returns a 90-second, purpose-specific signed grant through a POST form to the fixed Echelon callback. Grants contain the verified shop/customer and challenge, never an authoritative browser-supplied channel.
4. The callback relays the grant through a same-origin JSON request. Only that second request can redeem it, after browser binding and the private staff gate are verified. PostgreSQL atomically consumes the challenge; wrong browser, wrong shop, expiry, and replay fail closed. Expiry is rechecked after asynchronous work.
5. Echelon maps the verified shop to exactly one configured Shopify channel and connection. The customer session expires after 30 minutes. Each request rechecks the shop mapping. Explicit returns logout removes this session; a Shopify logout does not currently revoke an already issued Echelon session immediately.
6. The opaque browser-storage partition is stable for the same shop/customer across reauthentication. It is not a credential. A handoff-secret rotation changes this partition and invalidates existing customer sessions; accepted returns remain available through My returns after signing in again.

Every workspace request also carries its expected `X-Return-Session` partition. The server compares it with the verified current session before reading or executing anything. Signing into a different account in another tab cannot silently apply a stale tab's saved request to that account. Session discovery and the login exchange are the only exceptions.

Order lists and direct selection require the canonical channel/customer pair. Canonical OMS order IDs remain attached to inspection, review, submission, and retry. Both local snapshots enforce ownership, and the Shopify snapshot independently confirms the current customer. Missing/ambiguous ownership blocks access; email or order-number resemblance never supplies it.

The eligible-order list evaluates at most ten candidates per page with at most two concurrent inspections. A provider or identity-verification failure excludes that candidate and reports an incomplete check while preserving other verified eligible orders. Empty eligible pages retain their continuation cursor. My returns is separately paginated and remains available when current policy/window/eligibility would block a new return.

New customer submission commands bind an immutable OMS order FK before acquisition. Existing staff commands remain unbound and staff-only. Every customer command replay, resume, RMA status, label progression, and PDF download checks exact ownership. Public response contracts omit channel settings and provider download URLs. Shipping and claims still use the existing transactional intake and provider recovery logic.

## Configuration and rollout

Deploy the paired Club handoff change and this Echelon change; Echelon migrations 256 and 257 are additive. Migration 256 binds new customer commands to canonical orders. Migration 257 creates ephemeral login challenges. Expired challenges older than 24 hours are removed in bounded batches during new challenge creation. No historical customer ownership is inferred or backfilled.

Configure these values through the normal deployment secret/configuration process:

- Both applications: `CUSTOMER_RETURN_HANDOFF_SECRET`, the same dedicated random secret of 32–1024 characters. It must be separate from membership/session/API secrets.
- Both applications: `CUSTOMER_RETURN_PUBLIC_ORIGIN`, the exact HTTPS Echelon customer-portal origin, without a path or query.
- Club: `CUSTOMER_RETURN_SHOPIFY_DOMAIN`, the exact installed `*.myshopify.com` shop; existing `SHOPIFY_API_SECRET` verifies proxy signatures. `CUSTOMER_RETURN_HANDOFF_ENABLED=true` enables only the bridge.
- Echelon: existing `CUSTOMER_RETURN_SHOPIFY_DOMAINS` approval list and `CUSTOMER_RETURN_LOGIN_URLS`, a JSON mapping from each approved canonical Shopify domain to its HTTPS storefront proxy URL ending in `/returns`. For the observed store the proxy path is `/apps/member-portal/returns`; do not infer another store's path.
- Leave Echelon `CUSTOMER_RETURN_CUSTOMER_ACCESS` unset during private testing. Only the exact value `enabled` opens the customer surface publicly; this change does not set it. Private access requires a freshly authorized Echelon administrator as well as the Shopify customer login.

The anonymous callback can only show a sign-in relay; it cannot disclose orders or establish a session without the browser-bound challenge and gates. No customer-facing links are published by this Echelon change. Enabling the Club bridge for a private canary does not bypass Echelon's administrator gate.

## Private canary

1. Sign into Echelon as an authorized administrator. Use **Test customer sign-in** from the private preview or open `/customer-returns` on the configured origin.
2. Sign into the intended Shopify customer account in the same browser and complete the handoff. No Club subscription or membership row should be necessary.
3. Confirm the eligible-order picker only lists that account's approved-shop orders. Orders without confirmed eligible quantities should not appear. Confirm another customer's canonical order ID returns the same unavailable response as an unknown ID.
4. Select an order, pack one or multiple boxes, and review. Confirm the correct channel's policy/shipping settings apply without a channel/store selector.
5. An explicit create/generate action creates a real return and can purchase real postage when that policy's shipping is enabled. Reading a page, restoring a pending request, or viewing My returns must not purchase postage.
6. Simulate an interrupted response and reload. The saved request must retain the exact command UUID and quantities. Reauthentication must preserve its recovery partition. Only explicit retry/progress commands may resume work.
7. Confirm existing returns and label downloads remain accessible after their new-return eligibility expires. A second customer or another shop must not be able to read them.
8. Confirm signed-out and non-admin browsers remain blocked until launch is separately approved. Customer rollout requires deliberate link publication and the Echelon access setting; neither is performed here.

## Evidence limits

Source and local tests do not prove a live customer handoff or carrier label purchase. The inspected deployed Club revision matched its source, and the public member-portal entry presented Shopify login. No authenticated Shopify customer canary or new postage purchase was performed during implementation. Production customer-ID coverage and historical numeric/GID consistency require the separately approved aggregate read-only diagnostic; missing ownership must remain blocked until verified.
