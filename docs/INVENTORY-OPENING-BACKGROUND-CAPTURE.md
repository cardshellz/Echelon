# Inventory opening background capture

## Scope

The opening panel's **Capture current recorded data** action now enqueues a read-only capture. A dedicated `inventory-capture` process reads the census, and the browser polls progress and downloads bounded result chunks. The web request no longer performs this census or serializes its complete result.

This captures **recorded data**, not independently verified quantities. It does not approve an opening, fix inventory, activate canonical authority, publish channel quantities, or change shipment state. Verification preview/save and final activation retain their existing fresh-evidence and stale-input checks. Their synchronous endpoints, and the legacy GET `/cutover-opening/source` compatibility endpoint, are not converted by this change.

## Consistency and failure behavior

- One complete capture runs globally. Concurrent starts are serialized, exact request keys replay, and the same actor can reconnect to their active job. Other actors cannot read its status or chunks.
- The existing read-only repeatable-read transaction covers authority, evidence, labels, and the last verification. Journals use a non-holdable cursor and 500-row FETCH batches of **one SELECT**, not independent queries with changing snapshots. Commit-time READ COMMITTED callers also retain that journal statement's snapshot.
- Existing limits remain: 100,000 raw journal rows and 50,000 aggregate groups. A limit violation fails the whole capture; it never silently truncates evidence.
- Result JSON is serialized in chunks of at most 32,768 UTF-16 characters, with a maximum of 2,048 chunks. Unicode surrogate pairs remain intact. Chunks are unavailable until the job is marked complete with a contiguous artifact.
- A session advisory lock admits one worker. A replacement fails interrupted jobs and removes their partial artifacts; it never resumes an old snapshot. Users must request a fresh capture after a failed attempt.
- Heartbeats older than 30 seconds report the worker offline. The worker uses a three-connection pool, the existing 60-second database statement limit, and a ten-minute attempt watchdog. The watchdog is an event-loop timer, not a hard CPU interrupt; the process heap cap additionally limits runaway JavaScript heap growth.
- Completed/failed artifacts expire after 24 hours. Cleanup runs at worker startup and hourly. Expiration is enforced on reads even before physical cleanup. These are transient operational artifacts, not the immutable opening attestation/audit tables.
- Logs contain capture IDs, named stages, timings, RSS, and allowlisted failure codes; not census rows or raw SQL errors.

The full validated evidence and compact journal groups still reside in worker memory. This is bounded transport and reduced duplication, **not constant-memory capture**. The browser still needs enough memory to reassemble and validate the full source. Production memory use and database query duration must be observed after deployment.

## Deployment and rollback

1. Verify the PR's actual head/merge SHA and migration prefix against current main. This change adds `244_inventory_opening_capture_jobs.sql`; do not reuse a number occupied by a concurrent PR.
2. Deploy through the normal release migration/build path. The build emits `dist/inventory-opening-capture.cjs` in addition to the existing web bundle.
3. With explicit operational/billing approval, provision **one** `inventory-capture` process from the Procfile. Its command is `node --max-old-space-size=384 dist/inventory-opening-capture.cjs`. Do not change the web dyno size as part of this rollout. The UI reports worker-offline until the process has a heartbeat.
4. Capture from the existing inventory panel. Confirm enqueue returns promptly, named progress advances, all chunks download, and the complete worksheet opens. Record stage timings/RSS and compare the capture's displayed totals with read-only database evidence. Do not treat the worksheet as independent count approval.
5. Test preview/save separately when independent counts and order ownership evidence exist; this capture change does not prove those operations meet production latency requirements.

Rollback: stop the capture process and roll back application code through the usual release mechanism. Keep the additive transient tables; there is no need to delete operational history or modify inventory. A stopped worker cannot produce a verified opening. If restarting this version, startup recovery fails its interrupted artifact and a new capture is required.

## Validation

- PostgreSQL coverage: queue concurrency/idempotency, actor isolation, offline worker, partial-artifact exclusion, restart recovery, expiration, worker lock; existing opening/commit/quantity paths; concurrent updates between cursor batches remain outside the original snapshot.
- Unit coverage: authenticated HTTP boundaries, bounded/Unicode-safe serialization, oversize rejection, polling/reassembly failure behavior, journal aggregate parity, unchanged canonical hash bytes, existing opening panel and worksheet flows.
- Run `node node_modules/vitest/vitest.mjs run unit`, the PostgreSQL CI suites using only a disposable test database, `node node_modules/typescript/bin/tsc --noEmit --incremental false`, and `node node_modules/tsx/dist/cli.mjs script/build.ts`.
- Production acceptance is still required. No production worker provisioning, inventory write, attestation, activation, or provider publication is authorized by these local checks.

Local synthetic check (2026-09-10): 9,000 orders/items, 341 levels, 2,371 lots, 4,277 cost rows and 50,000 aggregate journal groups passed evidence hashing, source validation and chunk serialization under Node's 384 MiB heap limit. Output was 18,920,933 bytes in 578 chunks; peak process RSS was 328,912 KiB (about 321 MiB). This test used synthetic fixtures, not PostgreSQL/provider I/O, and does not establish production peak memory or runtime.
