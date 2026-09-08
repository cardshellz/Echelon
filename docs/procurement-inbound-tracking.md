# Inbound procurement tracking

## Delivered behavior

The shipment Tracking tab and the purchase lifecycle shipment inspector both use `InboundShipmentTracking`. One shipment may retain up to 20 parcel/container/BL/booking references, including paused or corrected references. The inspector expands tracking in place, preserving the purchase and connected records. Each reference shows carrier status, actual versus estimated events, timezone provenance, provider update time, last attempted and successful refresh, next due refresh, classified failures, retained observations, recent attempts and configuration changes. Ocean port arrival is explicitly separate from a warehouse arrival or receipt. Parcel delivery is labeled carrier destination arrival. Neither adapter invokes shipment status transitions, receiving, putaway, inventory availability, finance posting or supplier purchasing commands.

Real callable adapters are implemented, not activated by this change:

- SeaRates: `GET https://tracking.searates.com/tracking`, container (`CT`), bill of lading (`BL`) and booking (`BK`) identifiers, optional SCAC. Optional `route=true&ais=true` requests expose an actual vessel AIS observation only when coordinates and its UTC observation timestamp are present. Interpolated route pins and intermediate vessel destination ports are not presented as container position or final destination ETA.
- ShipStation: existing v2 tracking client and `SHIPSTATION_V2_API_KEY` credential owner, `GET https://api.shipstation.com/v2/tracking?carrier_code=...&tracking_number=...`. This supports parcel tracking from connected carriers; it does not establish ocean container support. API tracking entitlement is required even for labels created externally.

Official provider contracts inspected on 2026-09-07:

- [SeaRates Container Tracking API and OpenAPI](https://docs.searates.com/reference/tracking/), [machine-readable specification](https://docs.searates.com/spec/tracking-v3-openapi.json).
- [SeaRates rate limits](https://docs.searates.com/reference/tracking/rate-limit): provider account quotas can change; HTTP Retry-After and classified API rate-limit failures are respected through bounded backoff.
- [ShipStation tracking guide](https://docs.shipstation.com/apis/shipengine/docs/tracking/tracking), [v2 Advanced/Enterprise endpoints](https://docs.shipstation.com/plans/shipstation-api-advanced-enterprise).

## Runtime wiring and external setup

1. Apply additive migration `229_procurement_inbound_tracking.sql` through the existing migration runner. It adds references, immutable observations, attempts and command history, with restrictive history FKs. No historical shipment status/data is backfilled or rewritten.
2. Register `registerInboundTrackingRoutes(app)` from `server/modules/procurement/inbound-tracking.routes.ts` with the other procurement routes.
3. Start `startInboundTrackingScheduler()` from `inbound-tracking.runtime.ts` after migrations and normal app initialization; retain its `stop()` handle with other scheduler shutdown handles. The service is inert unless `PROCUREMENT_TRACKING_POLLING_ENABLED=true`. The application-level `DISABLE_SCHEDULERS` and dedicated `PROCUREMENT_TRACKING_DISABLED` guards can additionally prevent starting it.
4. Configure `SEARATES_TRACKING_API_KEY` in the deployment secret store for an approved SeaRates Container Tracking account. Configure/retain `SHIPSTATION_V2_API_KEY` for parcel tracking. Account/plan/carrier/AIS access must be confirmed with the actual providers. This work makes no paid provider calls, creates no subscription, and activates no production setting.
5. Add the actual shipment's tracking references and carrier code in its Tracking tab. The UI does not treat credentials present as verified connectivity. Enable global polling only after the approved account and references are ready. A successful response proves that reference was fetched; it does not certify every carrier or all future observations.

Routes require `purchasing:view` for reads/history and `purchasing:edit` for configuration/refresh. The solo operator needs no additional approval ceremony. No route sends vendor orders. Configuration identities are immutable; pause an incorrect reference and add the correction so its old evidence stays attached correctly.

## Safety, ordering and failure semantics

- Boundaries validate strict input/output DTOs. A response must match the exact saved number and ocean reference type. References returned for another container, incomplete location/vessel graphs, duplicates, malformed dates, out-of-bound coordinates or more than 1,000 events fail visibly.
- SeaRates metadata and AIS update timestamps are documented as UTC. Carrier event and port timestamps retain their literal value and reported location timezone. No server-local timezone or warehouse ETA is inferred. Actual/estimated/unknown date certainty and provider-calculated or mirrored evidence remain distinct.
- Immutable normalized observations are deduplicated by canonical SHA-256 fingerprint. Every completed poll records an immutable attempt, including duplicate, older-provider and superseded-lease results. Configuration commands have durable request keys, actor, injected clock, revisions, before/after config and response. Reference identity and histories are protected by database triggers; correcting a provider observation creates new evidence.
- Six-hour normal refresh and five-minute minimum manual refresh reduce duplicate requests. A one-minute scheduler claims at most ten due references per sweep using `FOR UPDATE SKIP LOCKED`, a monotonic claim version and 60-second leases. Multiple app instances cannot own the same current claim. An expired or invalidated claim cannot replace current state. Crash recovery reclaims the lease; provider GETs may be retried after an uncertain process failure, but identical observations are not duplicated.
- Provider HTTP requests are fixed-origin HTTPS with redirects rejected and bounded bodies/timeouts (20 seconds/2 MB for ocean; existing 15 seconds/1 MB for parcels). SeaRates mandates query-key authentication; URLs, raw provider bodies and raw transport exceptions are never persisted or logged by this module. Deployment-level HTTP/APM logging must also redact the provider's `api_key` query parameter.
- SeaRates older UTC carrier revisions and parcel responses missing a previously recorded actual event/delivery time remain in history but do not replace the current projection. Same/newer revisions can record corrections, including a corrected lower business status. No monotonic business-status guess overrides actual provider corrections.
- Transient failures preserve the last good observation and back off exponentially, bounded to 24 hours, honoring longer valid SeaRates Retry-After delays. Parcel failures use the existing ShipStation retryability classifier and the same bounded exponential delay. Permanent identity/configuration/access/quota errors require review; an authorized refresh retries after the five-minute cooldown. Pausing a reference invalidates in-flight work. Closed/cancelled shipments retain readable tracking history and are excluded from polling.
- UI labels expose missing data and stale-source responses. Provider-cached observations can be older than Echelon's successful HTTP attempt. Neither timestamp is evidence of warehouse availability.

## Rollback

Disable the tracking scheduler or roll back the application release. Keep the additive tracking tables and immutable evidence; dropping them is not a safe rollback. Existing manual shipment and receiving paths retain their original authority.

## Validation and remaining external dependencies

Unit/mocked HTTP tests cover provider contracts, determinism, corrections, invalid input, timeout, response bounds, redaction and route capabilities. Disposable PostgreSQL tests exercise migration replay, transactional rollback, competing commands/workers, old leases, historical deduplication, immutable identity/history, retry state, graph restrictions and paged history. Dedicated desktop/mobile browser tests cover navigation, provider setup, date/position provenance, failures, identical-key retries and read-only access. The scheduler has non-overlap and shutdown/recovery tests.

Live provider account credentials, paid entitlement, real shipment reference correctness and carrier telemetry quality remain external setup/acceptance. Tests use fictional provider data and mocked HTTP. This document makes no claim that a production feed has been enabled or a carrier subscription purchased.
