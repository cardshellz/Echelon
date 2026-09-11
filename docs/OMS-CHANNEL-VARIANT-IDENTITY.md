# OMS channel variant identity

## Scope

This patch corrects order-item identity resolution when a Shopify line contains a variant ID but no SKU. It does not change inventory formulas, quantities, reservation policy, channel configuration, or shipping requirements. No migration, startup backfill, live repair command, or provider request is added.

## Contract

1. `normalizeShopifyLineItems` preserves `variant_id` as `externalVariantId`. Numeric and ProductVariant GID forms normalize without a lossy number conversion. Invalid or unsafe identities raise a classified error.
2. `resolveOrderLineCatalogIdentity` is shared by initial OMS ingestion, duplicate ingestion, and the existing/new-line branches of the Shopify order-update handler. Its repository reads through the caller's transaction.
3. Match `(channelId, externalVariantId)` against `channels.channel_listings`. Never infer store ownership from `catalog.product_variants.shopify_variant_id`, a product title, or another channel's mapping.
4. Preserve SKU-only ingestion when there is no channel-variant match, using active catalog candidates so an archived predecessor does not create false ambiguity. If SKU and channel-variant matches disagree, or either produces multiple candidates, reject the assignment explicitly. A known conflicting external product ID or newly assigned inactive external mapping also requires review. A previously bound inactive identity can remain bound.
5. Neither a SKU match nor an external mapping may silently replace a non-null catalog identity on an existing OMS line. Existing lines are locked before resolution. Shared locks hold the selected mapping and catalog rows through the OMS transaction; duplicate mappings are rejected, not resolved by row order.
6. Keep the source SKU on OMS. WMS materialization and the existing edit-propagation path use the resolved catalog SKU. Without a catalog SKU, the existing source-SKU/`UNKNOWN` behavior remains; no SKU is invented.
7. Append `line_catalog_identity_resolved` to OMS order events in the same transaction as a changed identity. The event records prior/new variant IDs, channel, matching method, source event/reference, source SKU, and catalog SKU. A repeated identical assignment creates no additional identity event.

## Synthetic example

An incoming line has SKU `null`, external variant `1001`, channel `2`, and quantity `2`. Channel `2` maps `1001` to catalog variant `11`, SKU `EXAMPLE-P5`.

- OMS retains source SKU `null`, quantity `2`, and binds catalog variant `11`.
- WMS receives catalog variant `11`, SKU `EXAMPLE-P5`, quantity `2`, and the original shipping requirement.
- A separate channel's mapping for `1001` cannot be selected.
- Retrying the same source event does not duplicate the line or identity event.

## Limits and rollout

- Existing live records are not repaired by this development work. Normal future ingestion/update calls use the new resolver after deployment; any targeted historical repair must be separately reviewed and authorized.
- An unscoped catalog provider ID match alone is not sufficient evidence for a historical repair. Verify the order's channel and its listing mapping first.
- Channels with no usable external variant identity retain their SKU-only behavior. The legacy Shopify cache bridge cannot reconstruct provider IDs absent from its cached input; this patch does not invent them or change that cache's schema.
- Ambiguous/conflicting evidence throws a named error into the existing ingestion/webhook error and retry path. This patch does not add automatic mapping correction or a new review UI.
- Error codes are included in `Error.message` because `markWebhookFailed` persists that message. Initial-ingestion failures roll back the new order and its lines. Existing-order updates retain their per-line transactions: earlier committed lines are not rolled back if a later line fails, and retries reprocess through the same identity guard.
- This is not proof of inventory-cutover readiness or of a production deployment.

## Verification

Unit coverage exercises normalization, exact/cross-reference matching decisions, inactive/ambiguous/malformed evidence, identity-change protection, and catalog/source SKU selection. Existing transaction/authority guards remain in place.

The PostgreSQL integration suite exercises channel isolation, real OMS ingestion and WMS DTO construction, replay/concurrency, mapping locks, conflicting identity rollback, audit failure rollback, aliases, and nonshipping lines. Its schema-derived fixture verifies queries and transaction behavior, not production migrations or inventory triggers. It is registered in the PostgreSQL CI manifest without removing prior suites.

Local validation completed on 2026-09-10:

- `npm run check` and `npm run build`: passed. Build retains the existing large-chunk warning.
- `npm run test:unit`: 1,032 files passed, one skipped; 12,308 tests passed, 39 skipped.
- All eight PostgreSQL CI shards: 73 files and 1,159 tests passed, none skipped. The final expanded identity suite was then rerun: all 15 tests passed, including late identity resolution and newly added lines on replay.
- `git diff --check`: passed. No production database or provider was used for validation.
