# Approved writer-ratchet registrations

The user explicitly approved these 11 owner registrations on 2026-09-27. The regenerated baseline adds exactly these pairs and removes none. The writer-ratchet suite passes all nine tests, including a regression that checks these owners across runtime code and operational scripts.

| Table | Registered owner | Purpose |
| --- | --- | --- |
| `channels.channel_pricing_rules` | `modules/channels` | Persist the existing shared channel pricing rule through the Channels owner |
| `marketplace.channel_listing_drafts` | `modules/marketplace-listings` | Revisioned explicit selections |
| `marketplace.channel_listing_reviews` | `modules/marketplace-listings` | Immutable reviewed publication snapshots |
| `marketplace.channel_listing_operations` | `modules/marketplace-listings` | Durable feed commands and outcomes |
| `marketplace.channel_listing_item_claims` | `modules/marketplace-listings` | Concurrent SKU ownership and proven-failure retries |
| `marketplace.channel_listing_publication_events` | `modules/marketplace-listings` | Immutable command/progress audit |
| `inventory.publication_membership_versions` | `modules/inventory-planning` | Audited selected/excluded variant versions |
| `inventory.publication_membership_heads` | `modules/inventory-planning` | Current reviewed membership |
| `inventory.publication_membership_applications` | `modules/inventory-planning` | Idempotent apply receipts |
| `inventory.publication_listing_setup_identities` | `modules/inventory-planning` | Permanent exact target/SKU/variant binding |
| `inventory.publication_listing_setup_scopes` | `modules/inventory-planning` | Immutable per-batch zero setup evidence |

These registrations change the architecture test's expected topology. They do not execute migrations, alter live data, activate stock publication, or grant runtime users permissions. Existing registrations remain intact. The new runtime writers belong to the owners of these records; controllers do not become database writers.

The existing pricing table already has historical writer registrations. Adding its Channels owner does not remove those older paths; consolidating all prior pricing routes is outside this feature. The other ten tables are created by migrations 0707–0709 for this implementation.
