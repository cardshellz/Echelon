# Shipment Lifecycle Shadow Activation Runbook

## Current status

Phase 0 is deployed in Heroku release `v2697` from merge commit
`3123147fa51575d859c576bee460606df1dc389f`. The shadow audit is disabled:
`SHIPMENT_LIFECYCLE_SHADOW_ENABLED` was unset on 2026-08-21, and the job accepts
only the exact value `true`.

The dedicated `WMS_INTEGRITY_AUDIT_DATABASE_URL` exists, but a strict connection
attempt failed during TLS negotiation with `DEPTH_ZERO_SELF_SIGNED_CERT` before
`BEGIN` or any SQL ran. Heroku Enhanced Certificates were off at that check.
Consequently, the dedicated role identity, transaction mode, TLS session,
relation grants, and production query behavior remain unproven. No flag, grant,
certificate setting, database row, or provider record was changed.

Read-only shadow activation and shipment-lifecycle cutover are separate. A safe
shadow run would only evaluate retained evidence and emit bounded aggregates; it
would not authorize shipment, inventory, channel, notification, or provider
effects.

## Required approvals and sequence

1. Deploy this activation-hardening release, including the supporting provider
   and immutable-label-ID scan index.
2. Obtain explicit production authorization before enabling Heroku Enhanced
   Certificates or changing any database credential, grant, or config value.
3. After the certificate change, prove normal application health before testing
   the dedicated audit credential.
4. Using only the dedicated audit URL, prove all of the following without a
   fallback to the application credential:
   - certificate and hostname verification succeeds;
   - the session user is the intended audit role;
   - the transaction is read-only;
   - the five required relations have exact `SELECT` and schema `USAGE`;
   - row-level security is absent on those relations;
   - the audit login has no direct or nested membership in any other role;
   - table-, column-, sequence-, schema-, database-, and elevated-role mutation
     capabilities match the repository preflight;
   - the database `TEMPORARY` capability is reported explicitly.
5. If grants are missing, first review the credential utility's dry-run plan.
   Execute that plan only after separate explicit authorization, then repeat the
   dedicated-role proof.
6. Run one supervised page with the conservative default limits. Capture only
   aggregate result counts, bounded payload bytes, phase durations, and observed
   maximum RSS. Do not emit a cursor, database ID, tracking number, provider
   order, customer field, or item key.
7. Keep the feature flag and any scheduling disabled until the one-page result,
   runtime, memory, TLS, and role evidence have been reviewed and activation is
   explicitly authorized.

## Execution contract

The package command is:

```text
npm run wms:audit-shipment-lifecycle-shadow -- [bounded options]
```

There is no automatic scheduler in Phase 0. The command processes one page and
does not expose its continuation cursor. Internally, pagination uses immutable
label IDs; each invocation creates its own `REPEATABLE READ READ ONLY`
transaction and is therefore a separate snapshot, not one cross-page snapshot.

The repository rejects oversized individual events, oversized page payloads,
excess events per label, and excess total events before returning full JSON
payloads to Node; PostgreSQL still evaluates the sanitized JSON text to calculate
those byte bounds. The repository enforces statement, lock, and idle-transaction
deadlines, while the job/pool add finite connection and client-query deadlines.
Any connection, preflight, query, projection, rollback, release, or pool-cleanup
failure fails the command;
cleanup failures must not replace the primary error.

Node-postgres does not expose a pool-shutdown deadline, so the supervised
invocation must also have an external wall-clock deadline. Exceeding it is a
failed run and remains a blocker to recurring scheduling.

`TEMPORARY` is reported because it may be inherited through database `PUBLIC`
privileges. It is not treated as proof of operational-table mutation authority,
but it remains part of the activation evidence and must not be hidden.

## Stop conditions

Stop without retrying through a broader credential or weakening a guard when:

- TLS verification fails or the presented chain/hostname is not trusted;
- the role, grants, RLS state, or mutation-capability proof differs from the
  reviewed contract;
- a query or external command deadline is exceeded, or cleanup fails;
- any page/event/byte limit is exceeded;
- aggregates contain identities or sensitive provider/customer data;
- runtime or memory exceeds the reviewed activation envelope; or
- any code path attempts a WMS, inventory, channel, notification, provider, DDL,
  DML, or durable shadow-result write.

## Not resolved by shadow activation

Even a successful read-only shadow run does not make lifecycle cutover safe.
The main contract retains the blockers for key-only carrier-link dispatch,
serialized cross-package quantity allocation, manual-reship compare/use
concurrency, voided-label carrier possession, missing normal inventory change
notification, and remaining external-ID/PostgreSQL-integer write boundaries.

## Evidence to retain

For each approved run retain, without record identities or secrets:

- deployed commit and release;
- exact non-secret limits and projector version;
- dedicated role/preflight outcome;
- TLS verification outcome (protocol/cipher only if safely available);
- aggregate counts and limitation/review codes;
- selected event bytes, maximum event bytes, and page-limit outcome;
- exact phase durations and observed maximum RSS; and
- final success or classified failure, including rollback and cleanup status.
