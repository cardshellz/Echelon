# Independent account order progress

## Customer presentation

The account keeps one Status column with three labelled rows. Payment and Delivery are always visible. Return appears only for an actual return; an owner outage is shown explicitly instead of being presented as no return. Manage order reuses the same loaded facts and provides expandable delivery, return and refund details without a new provider or money request.

| Track | Source of truth | Presentation |
| --- | --- | --- |
| Payment | Current sales-channel financial label; actual refund attempts and confirmed case refund evidence | Native payment label, with refund activity when applicable. Intake's default pending value is not Refund processing. |
| Delivery | Shipping engine's matched carrier events and verified historical channel fulfillment events for exact active outbound packages | Awaiting carrier pickup, Shipped, In transit, Partially delivered, Delivered, Delivery issue, Delivery attempted, Ready for pickup. Unknown tracking preserves dated delivery evidence; without that evidence it preserves the known warehouse/native fulfillment label. |
| Return | Accepted authorization, saved label, return-direction carrier tracking, actual warehouse received units, inspection and case owner | Started, Label ready — awaiting drop-off, In transit, Delivery issue, Delivered — awaiting receipt, Partially received, Received, Under review, Complete, Cancelled, Needs attention, No shipment required. |

A label does not prove drop-off, warehouse receipt or refund. Carrier delivery to the warehouse does not prove receipt. A refund does not change physical return progress. Completed receipt does not issue a refund. An order is Delivered only when every expected outbound package has delivery evidence and no native/warehouse units remain outstanding. A closed return with outstanding units is Needs attention.

One authorization can span several warehouse cases and still appears once. Several authorizations remain separate. A legacy refund-only case does not manufacture a new physical return. Refund execution remains under the existing financial owner and manual Shopify policy; this feature creates no new refund authority or automatic case-closing rule.

## Concrete read path

1. `CustomerAccountOrderQueriesService.summaries` verifies current native customer/channel/order identity and retains its exact integer-cent total.
2. `CustomerAccountProgressService.read` reads shipping and returns independently. Failure or malformed facts in one lane cannot erase the other lane or verified money.
3. `PostgresCustomerOrderDeliveryReader.read` binds requested OMS and external IDs as exact pairs, checks customer/channel ownership before and after asynchronous reads, reads bounded native/verified historical package facts, and consumes only shipping's matched projection.
4. `PostgresCustomerReturnProgressReader.read` reads authorizations, latest successful label records, receipt quantities, inspection/case lifecycle and actual refund evidence under the same ownership constraints. Return labels cannot complete outbound delivery.
5. Pure domain presenters produce fixed customer labels. The theme and panel render the same DTO. No rate quote, label purchase, current return eligibility calculation or carrier API runs in this read path.

The additive response is explicitly negotiated with `statusDisplayVersion=v2`. Old clients retain the previous strict response. A new client reaching an old backend can retry this read once without the additive version after the specific old validation rejection; authentication and service failures never downgrade the request.

## Normal tracking capture

`enqueueSavedLabelStatus` participates in the existing transaction that saves a successful return label or verified historical package document. The durable shipping worker reads provider facts outside customer requests, registers status evidence through the existing shipping owner, and ingests matched carrier status without contents or outbound-dispatch authority. It does not buy, refund, redeem, reserve or adjust stock.

Historical V1 shipment IDs are not blindly treated as V2 label IDs. `verifyHistoricalStatusLabelAlias` requires a provider-read label with matching proposed identity, exact tracking, outbound direction and the same normalized creation instant. Only then is its label-specific tracking endpoint used. This avoids relying on access to the generic tracking endpoint. Alias proof is journaled separately from contents-authority evidence and cannot mask a newer contents conflict.

If that exact historical label has not confirmed final delivery, the worker also reads Shopify's existing authenticated fulfillment observation. `deriveSalesChannelDeliveryEvidence` accepts only the verified package's exact fulfillment, unique tracking, unchanged physical lines, shop/connection/order/customer owner and actual dated carrier events. SUCCESS/FULFILLED alone never means Delivered. Multi-tracking fulfillments cannot manufacture package-level delivery. Events retain Shopify provenance in the immutable shipping-owned `sales_channel_delivery_evidence` journal; they are not fabricated ShipStation events. Account reads require the current verified history revision and provider observation hash. Unknown ShipStation tracking cannot erase dated delivery evidence; newer delivery issues take precedence. This path is outbound-only and cannot advance any return label, receipt or refund.

Return labels retain their V2 `se-*` identity and use their exact label endpoint. Provider carrier account IDs are resolved from the provider, never guessed from tracking text. Known voided/replaced labels are not advertised as ready.

The queue prioritizes returns, then newly captured normal shipments and history for purchases with an accepted return, then other historical bootstrap work. Lease fencing, unique source identity, immutable attempts and atomic finalization cover duplicate workers and crashes. Network/provider outages back off; confirmed identity or data failures require review of tracking evidence while customer order/return tools remain usable. Carrier polling stops after confirmed delivery, voiding or actual parcel receipt. No paid tracking subscription is automatically started by this feature.

## Adversarial acceptance

The acceptance gate runs real PostgreSQL owner tables and services with synthetic provider HTTP boundaries, then builds the actual account bundle and runs browser journeys:

`node --import tsx scripts/ci/returns-workflow-acceptance.ts`

Coverage includes three original shipments, two repacked return boxes, out-of-order and future events, exact V1/V2 alias proof, multiple customer/return identities, cross-channel/customer and swapped ID scopes, actual receipt retries, independent refund/inspection progress, old/new client contracts, worker concurrency and expired leases, immutable audit rows, source conflicts, failure isolation and desktop/narrow-mobile layouts. Tracking capture is asserted to create no outbound dispatch or refund command. Account panel opening is asserted to create no additional request.

Shipping and account unit regressions, application/server/client typechecks, the native theme suite and CI architecture/writer guards accompany the connected gate. Synthetic tests prove application behavior; they do not claim that a carrier has a historical delivery event it no longer provides. Existing private customer diagnostics remain outside Git.

## Local acceptance results

All providers in command/receiving tests are synthetic. Database tests use disposable loopback PostgreSQL databases; browser journeys use local preview fixtures. These counts overlap and must not be added together.

| Check | Result |
| --- | --- |
| Connected release gate | 145 database checks, 280 focused unit checks, actual production bundle build, 74 desktop/mobile browser journeys passed |
| Extended complex-flow suite | 46 checks passed, including the full supported safe bigint order identity, immutable evidence and source-boundary retries |
| Stale-carrier attack | Connected mixed-box journey passed with an old In transit event and unknown tracking yielding to later dated delivery; a newer carrier issue still wins |
| Shipping/account regressions | 1,324 checks passed |
| Ownership, money-read and impact guards | 102 checks passed |
| Workflow/required-check contracts | 65 checks passed |
| Application, server-test and client-test types | Passed |

The native theme acceptance covers full-width account layout, initially visible status labels, three original packages and two return boxes, owner outages, refund-before-receipt, desktop and narrow-mobile close controls, and pinned compiled assets. Its final source pin and suite are verified separately in the companion checkout.

### Assumptions and failure boundaries

No delivery is inferred from fulfillment success, and no warehouse receipt or refund is inferred from a label or carrier delivery. Historical evidence requires an exact purchase, customer/shop, fulfillment, tracking and physical-line match. Ambiguous tracking is not spread across packages. Missing tracking evidence changes status presentation only; it does not revoke purchase-based return eligibility or alter cancellation permissions.

Provider outages retain saved status jobs with bounded retries. Source identity conflicts require tracking-evidence review; they cannot advance another order or return. One failed progress lane preserves verified money and other lanes. Unknown carrier status cannot erase dated historical delivery; a newer exception wins. Expired workers cannot finalize someone else's lease, retries cannot duplicate immutable events, and status capture cannot enqueue dispatch, refund, label-purchase, rewards or inventory commands.

## Release boundary

The implementation is published for review in Echelon PR #1969 and is not deployed. `migrations/900000045000019690001_customer_order_progress_capture.sql` contains the shipping status jobs, immutable attempts and channel delivery evidence, plus idempotent historical bootstrap. Its allocation metadata depends on the current main migration inventory. Disposable staging fixtures execute this same migration; there is no separate SQL template. Deploy the backend with this migration before the companion theme, and require final-head hosted CI and read-only deployed acceptance.

Deploy the backend before updating unpublished staging theme 174740308127. The live theme is not a target. Final acceptance must verify final-head/post-merge CI, deployed source ancestry, migration presence and read-only account behavior. Real orders, returns, payments, postage purchases, refunds, rewards, points and inventory balances are not changed by our verification.
