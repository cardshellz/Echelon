# eBay saved-policy read recovery

## Confirmed failure path

`DropshipEbayListingPolicyOverrideService.listForMember` joined saved database assignments with `DropshipEbayListingSetupService.getForMember` using `Promise.all`. A provider discovery failure therefore rejected the entire response, including policies already saved in our database. `EbayDropshipListingSetupDirectory.fetchResource` classified temporary HTTP failures as retryable but previously did not retry them. The portal query defaults also disabled retries.

The reported text, "eBay did not return the connected store's listing setup", comes from the directory's unsuccessful HTTP response branch other than 401/403. A simulated 503 reproduced it. This does **not** establish that the original production response was 503; that response was no longer available in retained logs.

## Changes and authority boundaries

- Authenticated `GET /api/dropship/ebay/listing-policy-overrides/:storeConnectionId/saved` returns database defaults and assignments, explicitly marked `verification: not_checked`. `listSavedForMember` validates member/store ownership and its response contract. It does not discover eBay policies, refresh credentials, or validate publishing.
- `getSavedSelectionForMember` uses the existing listing-config read path, including its existing default-config initialization behavior. No new migration or financial write path was added.
- `EbayListingPolicyOverridePanel` displays saved choices independently of a shared live setup query. Failed checks retain the table, disable policy saves, and invalidate reviewed preview state. Unknown labels appear as saved policy IDs, not invented names or missing configuration.
- `retryEbaySetupRead` retries only safe GET transport failures and HTTP 429/500/502/503/504, up to three attempts. Each attempt has a five-second timeout; retry delays are bounded. A long Retry-After is surfaced instead of retried prematurely. Bounds apply per resource/page, not to the entire paginated discovery operation.
- Auth/permission failures, invalid JSON and oversized responses are not transient retries. Final failures include a diagnostic reference; structured logs allowlist resource/status/provider identifiers and exclude credentials and raw provider bodies.
- Existing policy mutations still load live setup. Publication still uses the fresh fulfillment-policy guard in `dropship-ebay-listing-push.provider.ts`. Displayed saved state is never publication authority.

## Verification and remaining limits

Regression coverage includes initial and later provider outages, manual recovery without a browser reload, shared-query deduplication, corrupt/wrong-store saved responses, cross-vendor denial, no policy writes during failed checks, bounded retries, and preservation of database revisions/audit. Browser journeys mock provider-facing API responses; PostgreSQL tests use a separate localhost disposable database.

Transient provider errors can still outlast the retry budget. Saved values remain visible, but changes/publishing must wait for successful verification. This fix does not prevent eBay outages, alter actual revoked permissions, install durable log storage, or prove deployed recovery. No production settings, tokens, or listings were changed while implementing it.

After deployment, open Catalog for the connected store and use Refresh policies. Confirm saved defaults/overrides remain visible, labels resolve after successful verification, editing recovers without a hard browser refresh, and a new preview is required before queueing. On any failure, retain the displayed support reference for log correlation.
