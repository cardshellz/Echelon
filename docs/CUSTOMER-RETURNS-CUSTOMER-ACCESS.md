# Customer returns: Echelon-owned Shopify sign-in

Shopify authenticates the customer; Echelon verifies that identity and owns order access, policy resolution, returns, and labels. The Club application is not in the sign-in path. Refunds remain manual in Shopify, and the existing `/return-portal` administrator preview remains available.

## Identity and browser binding

1. Echelon `/customer-returns/start` resolves one approved shop and creates a five-minute challenge bound to the initiating browser session. An optional shop hint selects a login destination only; it grants no identity.
2. The configured storefront proxy forwards directly to Echelon `/api/returns/shopify/proxy`. Echelon verifies Shopify's HMAC over the original query, the exact configured shop and proxy path, bounded timestamp, and customer identity. It uses only the signing secret explicitly configured for that shop's proxy-owning Shopify app. Only `shop`, `logged_in_customer_id`, `timestamp`, `path_prefix`, `signature`, and optional `state` are accepted, each once. Unknown parameters are rejected because Shopify's separator-free signature format can otherwise admit ambiguous interpretations. Do not add tracking or redirect parameters to this authentication URL.
3. A guest returns to Shopify login with the same challenge and configured storefront path. A signed-in customer receives a form that posts the original signed proof, encoded as base64url, to Echelon's fixed callback. No Club token or intermediary JWT is issued or accepted.
4. Shopify strips cookies from proxy requests. The callback therefore only relays the bounded proof through a same-origin JSON request; it cannot authenticate a customer itself. That request retains the private staff gate, verifies the Shopify proof again, checks the initiating browser, and atomically consumes the challenge. Replay, tampering, wrong browser/shop/path, and expiration fail closed. Expiry is checked again after database waits.
5. The verified shop must resolve to exactly one approved, active retail Shopify channel and connection. The Echelon customer session lasts 30 minutes. Each request rechecks this mapping. Returns logout removes that session; Shopify logout does not immediately revoke a previously issued Echelon session.

Every customer workspace request includes its expected opaque `X-Return-Session` partition. The server checks it before reading or executing anything, so an old tab cannot silently use a different account's ambient cookie. This partition is not an authentication credential. Keeping its storage secret stable preserves uncertain submission recovery across reauthentication and this migration.

Order selection, inspection, review, submission, retries, RMA status, history, and downloads retain canonical order ownership. Both local snapshots and Shopify's order snapshot verify the customer. Missing or ambiguous ownership blocks access; email and order-number resemblance never supply it. Customer UI cannot select a channel, warehouse, carrier, or policy.

The order list checks at most ten candidates per page, with at most two concurrent inspections. Unverifiable orders are excluded with an explicit incomplete-check message while other verified orders remain available. History is separately paginated and remains available when current new-return eligibility or policy changes.

## Configuration

The public Shopify route is a signature verifier and proof relay only. No order or label access is granted there. Leave `CUSTOMER_RETURN_CUSTOMER_ACCESS` unset during private testing; only its exact value `enabled` opens the customer surface. This change does not set it or publish customer-facing links.

Configure these Echelon values through the normal secret/configuration process:

- `CUSTOMER_RETURN_PUBLIC_ORIGIN`: exact HTTPS Echelon origin, without a path or query.
- `CUSTOMER_RETURN_SHOPIFY_DOMAINS`: existing approved canonical Shopify shop list.
- `CUSTOMER_RETURN_SHOPIFY_APPS`: JSON map from canonical shop to `{ "proxyUrl": "https://store.example.com/apps/echelon-returns", "secretEnv": "CUSTOMER_RETURN_SHOPIFY_CLIENT_SECRET" }`. Each proxy URL identifies one Shopify proxy root, with no query, credentials, fragment, or custom port. The old member-portal proxy is rejected.
- The environment variable named by each `secretEnv`: the actual client secret of the Shopify app that owns that proxy. A webhook secret or unrelated Admin API app credential is not evidence of proxy identity. There is no implicit global-secret fallback or search through other shops' secrets.
- `CUSTOMER_RETURN_STORAGE_SECRET`: stable secret used only for the opaque browser recovery partition. To preserve existing private-test recovery, retain the previous value here or leave this unset while the legacy `CUSTOMER_RETURN_HANDOFF_SECRET` supplies the same value. That legacy value is never accepted as a Shopify signature or JWT login key.

`CUSTOMER_RETURN_LOGIN_URLS`, Club's handoff enablement setting, and Club-issued JWTs are no longer used. This is an intentional authentication cutover: in-progress old login attempts must restart, while existing Echelon sessions and saved return requests remain usable if the storage partition key is retained.

No database migration or ownership backfill is required. Existing challenge and canonical-command tables continue to enforce single consumption and immutable order identity.

## Verified Shopify configuration and proposed route

The September 29 read-only check identified the installed Echelon Shopify app (Dev Dashboard app `313871204353`). Its active version had proxy permissions and no configured proxy. The existing Echelon environment's public client ID differed from this app's public client ID, so do not assume the generic `SHOPIFY_API_SECRET` belongs to it.

Proposed app-proxy configuration, to apply after deploying this endpoint and binding the correct app secret:

- Prefix: `apps`
- Subpath: `echelon-returns`
- Proxy URL: `https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/returns/shopify/proxy`
- Storefront entry: `https://www.cardshellz.com/apps/echelon-returns`

Preserve the active app version's existing scopes, redirect URLs, and other settings when adding this proxy. Do not repoint the Club app's existing member-portal proxy. Verify Shopify's resulting storefront path rather than assuming the proposed path was accepted unchanged.

## Private validation

1. Deploy the Echelon change, configure the actual Echelon Shopify app secret and direct proxy, and retain the Echelon staff gate. Confirm anonymous `/customer-returns` still requires staff authentication.
2. Sign into Echelon as an authorized administrator. Use Test customer sign-in from `/return-portal` in the same browser as the intended Shopify customer login.
3. Confirm the roundtrip uses the dedicated storefront proxy and Echelon only. Verify that Club can be unavailable without preventing this route. A nonmember customer must be able to sign in.
4. Confirm the picker lists only that account's approved-shop eligible orders. Another customer's canonical order ID must be unavailable. The order determines policy automatically.
5. Select items, pack one or multiple boxes, and review. Only an explicit create/generate action may create a return or purchase postage. Page reads, history, and pending-request restoration must not purchase anything.
6. Interrupt a submission response and reload or sign in again. The exact saved command UUID and quantities must remain intact. Explicit retry/progress resumes that intent.
7. Verify history and owned label downloads still work after new-return eligibility expires, and account changes in another tab reject stale requests.
8. Confirm customers remain blocked until public launch is separately authorized. Do not publish store links or enable customer access as part of this migration.

## Evidence limits

Local signature, HTTP, lifecycle, and regression tests do not prove the deployed Shopify proxy or an authenticated customer roundtrip. Production customer-ID coverage, authenticated login, and real label purchase require separate live verification. Earlier Club server errors did not establish their cause and are not a dependency of this direct design.

Shopify reference: https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
