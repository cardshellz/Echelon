# Fulfillment provider connections

Fulfillment provider connections are shipping-owned credentials and account
boundaries. They are intentionally separate from:

- customer-facing service levels;
- carrier accounts and methods discovered inside a provider account;
- checkout pricing; and
- channel or dropship activation.

The routing identity is:

`provider connection -> provider carrier account -> service code`

This prevents two provider accounts that expose the same carrier service code
from becoming interchangeable by accident.

## Installed providers

The application registry initially installs the ShipStation V2 adapter. A new
provider requires an adapter that implements credential verification and method
catalog discovery, followed by registration in
`server/modules/shipping-engine/infrastructure/fulfillment-provider-registry.ts`.
It does not require a new routing table or provider enum migration.

## Credentials

Migration `0643_shipping_fulfillment_provider_connections.sql` creates one
system-managed ShipStation connection backed by `SHIPSTATION_V2_API_KEY`. This
preserves existing routing after deployment.

Admin-managed credentials are encrypted with AES-256-GCM before persistence.
Configure both of these deployment values before using **Connect provider** or
**Replace key** in Shipping settings:

- `SHIPPING_PROVIDER_CREDENTIAL_ENCRYPTION_KEY`: exactly 32 bytes encoded as
  base64 or 64 hexadecimal characters;
- `SHIPPING_PROVIDER_CREDENTIAL_KEY_ID`: a non-secret key version label. It
  defaults to `shipping-provider-credential-key-v1`.

Credentials are write-only through the API and are never returned to the
browser, audit snapshots, or application logs. Changing the key material
without re-encrypting stored credentials makes those credentials unreadable;
the key id makes that failure explicit.

## Operational controls

- A new or replacement credential is verified against the provider before the
  transaction stores it.
- Every successful mutation has an idempotency key, optimistic connection
  revision, and append-only before/after audit event.
- A connection cannot be disabled while an active service-level method refers
  to it.
- Replacing a credential is rejected if the replacement no longer exposes an
  active routed method.
- Routing saves lock each selected connection and recheck its revision after
  catalog discovery, so a concurrent credential or status change cannot create
  a stale route.
- Catalog discovery can remain available through healthy connections when a
  different connection is unavailable.
- This connection layer does not buy labels or connect dropship orders to the
  routing resolver. Those are separate activation steps.
