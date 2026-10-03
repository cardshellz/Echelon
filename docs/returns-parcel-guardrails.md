# Prepaid return parcel guardrails

Configure these under **Returns → Policies → New version → Return shipping → Prepaid return guardrails**. Saving publishes one policy version with its warehouse, allowed account/services, and parcel limits. The existing channel resolver chooses the policy from the authenticated order; customers choose neither a policy nor a carrier.

## Per-box limits

- USPS: at most 20 lb of product weight and 130 inches of length plus girth.
- UPS/FedEx: at most 50 lb of product weight, 108 inches on the longest side, and 165 inches of length plus girth.
- Length plus girth is the longest side + twice each of the other sides. Rotating a box does not change eligibility. There is no separate volume limit.
- Administrators may lower limits. These merchant weight ceilings and carrier size ceilings cannot be raised. A carrier account's existing weight limit may be stricter.
- Only U.S. domestic prepaid returns are supported, including Alaska and Hawaii. Both physical addresses must be in the U.S. International orders do not receive free labels.

The customer supplies the actual outside dimensions or confirms an original box. The system calculates weight from the selected products and rounds the completed box up once to whole grams. It adds no packaging allowance and exposes no editable or visible customer weight field.

The packing step starts overweight selections in separate boxes when whole purchased units fit individually. Two 30 lb units require two boxes. A later overweight move disables review and offers **Split to fit**, preserving quantities and the first box's custom dimensions. An individual unit above every permitted service's weight cap, unknown product weight, or a plan needing more than 20 boxes requires assistance.

Carrier limit sources: [USPS Ground Advantage](https://www.usps.com/ship/ground-advantage.htm), [UPS parcel size and weight](https://www.ups.com/us/en/support/shipping-support/shipping-dimensions-weight), [FedEx Ground](https://www.fedex.com/en-us/shipping/ground.html). The 20/50 lb limits are merchant policy; they are lower than the carriers' technical weight maxima. Carrier surcharges, dimensional weight, and actual rate availability still apply inside those size limits.

## Cost protection

Each actual box is quoted on the connected accounts and allowed services for the physical customer-to-warehouse route. Only eligible services participate. The cheapest permitted actual rate is selected.

With cost protection enabled, the engine also obtains fresh quotes on that same route for each eligible carrier/account's normal reference carton at its maximum permitted product weight. Defaults are 20 × 13 × 10 inches for USPS and 24 × 18 × 16 inches for UPS/FedEx. Administrators can change these comparison cartons. They do not substitute for the customer's actual dimensions and are not volume limits.

The cheapest eligible normal reference rate becomes the box's spending ceiling. A price above that ceiling, or missing/contradictory reference evidence, blocks purchase. There is no fabricated national dollar maximum or fixed AK/HI surcharge allowance. The references were selected from read-only connected-account quotes on October 3, 2026; sampled routes do not establish a nationwide maximum.

Size and weight are checked in the customer draft, server review, preparation, and transactional intake. Cost protection is checked during review and immediately before intake reserves return quantities. Label progression checks every unpurchased box before buying the next box. Independent rate calls use bounded concurrency; the purchase target is quoted last to limit decision age. A quote exceeding the existing 60-second lifetime cannot authorize a purchase.

The ledger retains the actual quote, reference manifests and rates, accepted policy configuration, chosen service, physical route, and actor. Purchase intent is committed under the existing parcel/settings locks before the carrier POST. Concurrent commands cannot purchase a box twice. Unknown purchase outcomes retain their original request and enter read-only reconciliation.

## Activation and failures

This change requires no database migration or direct production data update. Existing policies/accepted returns without `parcelGuardrails` preserve their saved contract. Create a new applicable policy version to enable the defaults for new returns; existing accepted labels and their recovery requests are not rewritten.

During private testing, save the new policy version, refresh the portal's settings, and choose the order again so it receives the new source revision and packing limits. Customer launch remains independently gated. Refunds remain manual in Shopify.

- At review, a rejected box can be resized or split before another submission. No RMA/receiving claim or label exists yet.
- A transient quote failure before intake retains the saved command for an exact retry; it does not reserve return quantities.
- If prices/availability change after acceptance, the return stays saved and the next label is blocked for assistance. A failed quote never retries a carrier purchase.
- Carrier measurement/invoice adjustments remain possible. Fresh quotes are spending guardrails, not a carrier price lock. Product-only weight does not account for packaging.

Verification uses deterministic domain tests, disposable PostgreSQL ledgers and real migrations, mocked provider APIs, and desktop/mobile browser journeys. It does not establish live invoice totals, production deployment, or a new paid label test.
