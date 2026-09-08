# Procurement cost reporting delivery v1

## Authority and exact data

`inventory/application/apply-cost-revision.ts:applyCostRevision` records an immutable
`inventory.cost_reporting_events` row in the same transaction as each successful cost
application. Review-required applications produce no applied-cost report. This delivery
consumer preserves that payload unchanged: currency, source revision/fingerprint,
component, exact before/after lot cost snapshots, allocation quantity/remainder,
signed aggregate COGS delta in cents, actor and recorded time.

Mills mean 1/100 cent (10,000 mills per dollar). No floating point conversion,
currency conversion, or credit clamping occurs. Event and application bigint IDs travel
as decimal strings. Lot cost values remain validated safe integer numbers. The current
inventory owner refuses a uniform lot revaluation with a nonzero remainder; the wire
contract nevertheless retains and validates the remainder field instead of hiding it.

The v1 payload does **not** contain individual sales, COGS-row IDs, or accounting account
mappings. It must not be interpreted as a full sales-cost ledger or a journal command.
Archon's new consumer retains reporting evidence only. Its acknowledgement means
`accepted_evidence_only`; it creates no journal, transaction, accounting source document,
or inventory-authority connection. Archon remains responsible for reviewed accounting.

## Contract and consumer

Echelon's canonical contract is `shared/procurement/cost-report-delivery.ts`.
The coordinated Archon change on `codex/procurement-reporting` uses
`packages/shared/procurementCostReporting.ts`, migration
`0082_procurement_cost_report_inbox.sql`, and `server/procurementReporting/`.
Both repositories test the same committed `procurement-cost-report-v1.json` golden
vector: canonical hashes, a signed delta, residual and maximum PostgreSQL bigint ID.
Change the protocol version and update both consumers deliberately when semantics change.

`POST /api/integrations/procurement-cost-reports` accepts a strict versioned envelope:
source system, destination, delivery, event and application identities; exact PO/line
IDs; SHA-256 payload hash; unchanged payload; and SHA-256 envelope hash. Hashing uses
recursively sorted object keys and retains array order. The envelope hash excludes
its own `reportHash` field. Its immutable acknowledgement includes all delivery/source
IDs and both hashes, plus a persisted receiver receipt ID and acceptance time.

The receiver authenticates before its dedicated 4 MiB JSON parser and binds the configured
source/destination to an existing Archon user and entity. A source system has one immutable
destination/tenant/entity binding. A source event has one inbox record across all delivery
IDs. Exact replay returns the original acknowledgement. Changing the payload, delivery,
destination or tenant for a retained source identity conflicts; it never creates another
report that could double count the adjustment.

Authenticated Archon users can read evidence through:

- `GET /api/entities/:entityId/procurement-cost-reports?before=:receiptId`
- `GET /api/entities/:entityId/procurement-cost-reports/:receiptId`

The list uses acceptance-time/receipt-ID keyset pagination, with cursor lookup restricted
to the same current tenant/entity. It rejects unknown and foreign cursors.

## Destination configuration

No production destination, entity ID or credential is inferred, configured or activated by
this change. Deploy the coordinated receiver and migrations before enabling the sender.
Use a secret manager for a unique random credential of at least 32 printable ASCII
characters; neither service returns or logs it.

| Echelon setting | Required meaning |
| --- | --- |
| `COST_REPORT_DESTINATION_ID` | Reviewed UUID shared with this Archon receiver |
| `ECHELON_COST_REPORT_SOURCE_ID` | Stable installation identity, not a display name |
| `ARCHON_COST_REPORT_URL` | Exact public HTTPS receiver endpoint above |
| `COST_REPORT_ALLOWED_HOSTS` | Comma-separated exact allowed hostnames; no wildcard |
| `ARCHON_COST_REPORT_TOKEN` | Receiver's bearer credential |
| `COST_REPORT_DELIVERY_ENABLED` | Exact `true` to enable delivery; disabled by default |
| `COST_REPORT_DELIVERY_DISABLED` | Exact `true` stops this worker and disables new manual retries |
| `DISABLE_SCHEDULERS` | Exact `true` also disables effective delivery/readiness |

| Archon setting | Required meaning |
| --- | --- |
| `COST_REPORT_RECEIVER_ENABLED` | Exact `true` to accept reports; disabled by default |
| `COST_REPORT_DESTINATION_ID` | Same reviewed UUID |
| `ECHELON_COST_REPORT_SOURCE_ID` | Same stable installation identity |
| `ECHELON_COST_REPORT_TOKEN` | Same bearer credential |
| `COST_REPORT_ARCHON_USER_ID` | Existing owning Archon user |
| `COST_REPORT_ARCHON_ENTITY_ID` | Existing accounting entity owned by that user |

HTTPS certificate validation is mandatory. The sender resolves DNS once, rejects all
nonpublic or mixed private/public results, and pins a public IPv4 address to the TLS
request while preserving the host/server name. IPv6-only destinations are unsupported.
Credentials in URLs, redirects, query strings, fragments and nonstandard ports are
rejected. The whole DNS/HTTP exchange is bounded to 15 seconds; acknowledgements to
16 KiB. No live request was made during implementation.

Token rotation preserves the identity binding. Retargeting an existing destination URL
or accounting entity is intentionally refused; do not mint another source identity to
re-import the same events. A future relocation needs an explicit reviewed continuity
procedure rather than silently rebinding retained accounting evidence.

## Delivery, retry and operations

Migration 230 adds destination bindings, durable deliveries, immutable delivery audit,
and immutable retry intents. The worker prepares ten source events per scan, reconciles
each against its recorded source/application/lot snapshots, and quarantines invalid
history as a dead letter without manufacturing or truncating a replacement payload.

PostgreSQL `FOR UPDATE SKIP LOCKED` owns claims; each claim has a fresh lease token,
60-second expiry and increasing attempt count. Ten bounded requests start concurrently.
Completion checks the lease token, attempt and expiry before writing. Expired workers
cannot overwrite a later attempt. The receiver's stable replay handles a delivered
report whose HTTP response or local completion transaction was lost.

Connection/timeout errors and HTTP 408/429/5xx back off from 30 seconds exponentially
with a one-hour ceiling. Eight attempts exhaust an automatic cycle. Other HTTP failures,
invalid acknowledgement identities/hashes and invalid source evidence require attention.
Worker exceptions log a sanitized code and leave durable state available for recovery.

The purchase lifecycle's **Archon cost reporting** section shows configuration state,
unqueued event count, the latest 500 delivery records, errors, attempts, next attempt,
receiver receipt and verified hash. Older immutable records remain in PostgreSQL; the
view explicitly reports truncation. Read access uses `inventory:view`. Retrying requires
`purchasing:approve`, a reason, expected attempt count and an idempotency key. A reviewed
retry resets its automatic-cycle count but retains the total attempts, delivery ID,
payload and destination. Invalid source payloads cannot be retried into validity.

All delivery transitions and manual retry intents write audit evidence in the same
transaction. Failed audit persistence rolls back the transition. Delivered records,
bindings, audit and retry intents cannot be edited, deleted or truncated.

## Integration and validation

The composition root creates `CostReportingRepository(databasePool)` (only `connect`
is required), then `createCostReportingService(repository)`. Register
`registerCostReportingRoutes(app, service)` after authentication composition and start
`startCostReportingWorker(service)` only after migrations/bootstrap. The returned async
stop callback drains the active tick on shutdown. The parent integration owns these
global registrations and the writer-ratchet baseline; this scoped commit adds no global
pool, startup DDL, CI edits or package changes.

Focused coverage includes exact/golden contracts, malformed data, safe integer bounds,
private DNS and pinned TLS options, HTTP status/size/time limits, concurrency and lease
fencing, immutable replay, database audit rollback, source-history conflicts, cross-tenant
authorization, chronological receiver pagination, and desktop/mobile status/retry flows.
The sender's PostgreSQL fixture uses the actual inventory application/event owner with
an injected revaluation boundary; it does not claim to retest all downstream COGS math.
Receiver PostgreSQL tests run the complete Archon migration chain and prove zero
journal, transaction and accounting-source-document writes for retained reports.
