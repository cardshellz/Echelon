# Observed package dimensions

Shipping owns the dimensions reported for an actual provider package. Product
dimensions, carton catalog sizes and pack plans do not establish what was shipped.
The normal ShipStation label observation path now normalizes provider inches or
centimeters into the shared positive, four-decimal-place millimeter contract.
Missing dimensions stay unknown. Invalid measurements are retained as a rejection;
they cannot prevent recording the label or authorize shipment quantities.

## Persistence and provenance

`normalizeShipStationLabelObservation` adds independently versioned
`packageDimensions` evidence to the existing sanitized label event. The existing
shipping repository saves that immutable event and the latest measurement pointer
in label metadata in the same transaction, under the existing label identity lock.
The pointer includes the observation time and exact event hash. No new shipment,
quantity, inventory, payment, refund or points command is introduced.

The contents-authority hash and its contract remain unchanged: dimensions cannot
establish unit allocations or dispatch authority. Equivalent normalized sizes
replay idempotently. Missing fields preserve the retained size; older observations
cannot overwrite newer ones. Equal-time contradictory observations are marked
ambiguous. A later verified observation, including replay of a previously seen
size, can recover the current pointer without rewriting immutable evidence.
Unrelated label metadata is preserved.

## Returns

`ShippingPackageDimensionsReader.read` is shipping's published read-only surface.
It uses the existing provider/label identity and label/event-hash indexes, checks
active outbound direction and exact tracking identity, validates the retained
contract, and requires its measurement to match the immutable event. Voided,
return, conflicting, malformed or unproven records return an unusable result.

Returns first establishes exact purchased-line and package provenance using its
existing canonical allocation checks. It then consults shipping's saved size
before the older returns-only measurement cache or remote dimension lookup.
Known unusable shipping evidence cannot be bypassed by those fallbacks. Older
packages without recorded shipping measurements retain the existing verified
cache/provider fallback. A shipping read failure is reported and leaves manual
sizing available; it does not invent a box or change return eligibility.

The background order-options inspector remains responsible for its derived
return-package cache. Existing label-change invalidation makes it observe revised
measurements. Fresh return review validates the selected package size again.
Customer reads write no measurement data and buy no labels. The existing UI shows
the original size and lets the customer change boxes.

Historical orders with no canonical package/line links still require real
dimensions. This change does not guess those links or repair historical orders.

## Validation

Coverage includes normal ingestion through the real transaction repository into
return inspection, no remote dimension request when saved data exists, repeated
and concurrent delivery, equivalent units, missing and invalid measurements,
old observations, equal-time conflicts, corrected replay, wrong identities,
void/return labels, corrupt provenance and rollback after event-persistence failure.
PostgreSQL tests run only against a validated disposable database and are registered
in the CI manifest and coverage guard. UI tests use fictional orders/transports.
