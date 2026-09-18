# eBay void/relabel and combined-order tracking

## Problem and supported behavior

When an order already had an allocated label, combining it with another order
could fail `lockSourceGroupClosure` with `SOURCE_ALREADY_GROUPED`. No replacement
channel commands were created. The original physical quantity still counted, so
carrier finalization could subsequently fail `FULFILLMENT_AUTHORITY_EXCEEDED`.
The existing eBay create-fulfillment adapter also lacked a tracking amendment.

This change admits a verified replacement before the ordinary allocation
bootstrap. A physical package containing complete source shipment items from
multiple eBay orders produces one canonical command per order. Previously
published tracking is amended; an order without a provider fulfillment uses the
existing create path. This is a future lifecycle change, with no historical
selection, backfill job, or production recovery script.

Automatic replacement requires all of these facts:

- Every source item is an eBay customer fulfillment, with exact whole-source
  quantities and existing paid/request/plan authority.
- Every predecessor allocation belongs to a label whose complete, hashed event
  history proves a void, exact contents, and an awaiting-relabel lifecycle.
- No predecessor has confirmed carrier-possession evidence. Every item in every
  replaced package is covered, and there is no competing active replacement.
- An eBay amendment covers one existing provider fulfillment and the complete
  eBay order, with exact quantities and no cancellation request.

Partial-source repartition, multiple provider fulfillments, ambiguous labels,
changed quantities, or previously dispatched predecessors require review. A void
without a replacement does not remove tracking already published to eBay.

## Execution and ownership

1. `PackageAllocationLabelCommercialFulfillmentService.process` invokes
   `reconcileEbayLabelReplacement` inside the existing serializable label
   workflow, before `persistDiscovered` can reject prior group membership.
2. `ebay-label-replacement.repository.ts::reconcileEbayLabelReplacement` reuses
   `projectPersistedDeclaredPackageLifecycleShadow`, locks shared source items
   in order, rechecks label evidence, and waits for predecessor voids or an
   in-flight channel command. `decideEbayLabelReplacement` is the pure quantity
   and predecessor safety decision.
3. In one transaction, the canonical OMS owner appends quantity adjustments to
   voided physical items, materializes the exact replacement, and creates the
   per-order commands. Original allocation groups, plans, label events, and
   successful command history remain available. Pending/retry predecessor
   commands become review records with `PACKAGE_LABEL_SUPERSEDED`.
4. Migration `0679_ebay_label_replacement_authority.sql` adds explicit replacement
   provenance and durable work. Deferred constraints require conservation of
   source quantity, plan line, request item, and order item; a negative transfer
   cannot commit without its replacement. Applied replacement identity is
   immutable. No inventory mutation occurs in this operation.
5. `createChannelFulfillmentAuthorityService::runDueBatch` retries waiting work
   and applied work whose projection did not finish. Replacement commands remain
   unclaimable until projection is recorded. eBay commands belonging to voided
   or superseded labels are excluded from claiming.
6. `createFulfillmentPushService::pushTrackingForShipmentCommand` resolves the
   order's channel account and reads predecessor tracking from the immutable
   adjustment chain. The channel adapter either creates absent fulfillment or
   calls `EbayApiClient.replaceShippingFulfillmentTracking`.
7. The amendment method reads the complete provider collection and order,
   verifies exact whole-order scope, rereads for changes, and sends Trading
   `CompleteSale`. It accepts success only after REST readback verifies the new
   tracking and quantities. A retry adopts an already-correct package. A lost
   response, 429/5xx, or unconfirmed provider state remains retryable through the
   existing command attempts and leases. Permanent scope conflicts go to review.
8. `createShipStationService::confirmDispatch` reconciles replacement authority
   before the WMS/inventory dispatch path. Later canonical materialization
   recognizes the applied package and reuses its commands. Quantity is not
   fulfilled twice merely because the label changed.
9. `channel-writeback.service.ts::shippedChannelShipmentsCte` uses effective
   physical provenance and requires each current replacement command to succeed.
   A historical `tracking_pushed` event cannot mask replacement debt.

The Trading API's documented amendment operation replaces existing tracking and
carrier values when new ones are supplied. It operates at order scope, which is
why this implementation requires whole-order proof before calling it.
Reference: [eBay CompleteSale request contract](https://developer.ebay.com/devzone/xml/docs/Reference/ebay/types/CompleteSaleRequestType.html).

## Validation and limits

The disposable PostgreSQL package-allocation suite passed 88 tests, including
ten combined-label cases: late void, void first, two previously allocated orders,
transaction rollback, concurrent observations, projection failure, per-order
health, an in-flight predecessor command, competing labels, and repeated relabel.
Those tests execute the real allocation, projection, provider-account dispatch,
and eBay HTTP adapter code against a real database and mocked provider responses.
They assert conserved quantities, stable command identities, independent order
writeback, and zero inventory movements from label replacement.

Focused HTTP tests cover omitted provider quantities, exact readback, duplicate
replay, a lost success response, scope conflicts, rate limits/server failures,
and an acknowledgement without the required provider state. Pure domain tests
cover invalid quantities, unsafe integer precision, carrier possession, and
ambiguous source mappings. The full unit run passed 13,439 tests across 1,118
files, with 39 skipped tests in its selected corpus. Application, server-test,
and client-test TypeScript checks, the production build, and writer ownership
checks passed. The local PostgreSQL cluster was stopped after validation.

For Windows validation, task-owned database storage was moved into ignored test
artifacts so Git source discovery stayed bounded. The pre-existing migration
0678 assertion requires LF line endings; that file was temporarily normalized to
its repository representation and restored afterward, with no PR content change.

No sandbox or live eBay write was made. Actual Trading amendment behavior for
the connected account and REST-created fulfillments still needs a controlled
sandbox acceptance check before production rollout. Mocked HTTP success is not
provider acceptance evidence. External actors can change provider state between
reads; eBay does not offer a compare-and-swap for this operation. Conflicting or
unverified readback remains visible as review/retry rather than local success.

## Rollout and next checks

- Apply migration 0679 before starting the updated application. It changes
  schema and constraints; it does not rewrite historical shipments.
- Verify sandbox acceptance with one published original order, a void, and a
  replacement combining a second order. Check both eBay orders independently,
  replay the observation, and confirm quantities and inventory stay unchanged.
- Observe `EBAY_LABEL_REPLACEMENT` and `EBAY_LABEL_REPLACEMENT_RETRY`, the durable
  `wms.ebay_label_replacement_work` state/reason, and existing channel command
  attempts/review/dead-letter records. Late voids wait durably. Unsupported
  scopes remain reviewable and must not be force-created as duplicate packages.
- The existing `PACKAGE_ALLOCATION_COMMERCIAL_FULFILLMENT_DISABLED` switch also
  disables admission and worker retries for replacement. It is not a recall of
  commands already committed before the switch was changed.
- After deployment, verify both provider tracking and local canonical command
  completion for new cases. Deployment and historical order remediation are
  separate actions and were not performed as part of this change.
