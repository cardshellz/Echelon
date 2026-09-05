# WMS stations implementation record

Date: 2026-09-05

## Status and delivered scope

The **draft setup slice** is implemented locally. This is the start of the approved shared foundation, **not the completed station execution system**. It provides persisted station definitions, Small Team workflow profiles, employee scopes, permission checks, audit history, and administration UI. It does not yet provide task assignment, workstation sessions, a live assembly queue, or pick-gun handoff.

No production data, inventory, recipes, ATP, reservations, Shopify quantities, channel settings, users, or roles were changed by this work. No migration was run against an application database and no deployment was performed for this slice. PR publication does not activate execution; there is no execution-activation endpoint or toggle.

Implementation branch: `codex/wms-workflow-foundation`.

Worktree: `C:\Users\owner\Echelon\worktrees\wms-workflow-foundation`.

Original clean base: `8785bc7586c69275bf6528a63d90bb0aa9556f41` (main after #1374). The implementation was subsequently rebased onto refreshed main at `ff9887bd133cd665b3f8a48139e8f41ba217fb03` and revalidated. Its intervening changes concern procurement navigation and Dropship listing-policy UI, not the station domain. No PR number from those other workstreams represents this work.

Publication preparation: rebased again onto `08721b955fdc72c1130f669a53962f92e8f2742f` (main after #1378). Typecheck and all 50 focused checks passed again on this base. The additional purchase-workspace changes remain outside this PR's diff. Migration prefix 0654 remains available on that base.

The main checkout's unrelated catalog work was preserved. The clean-worktree workflow kept implementation and baseline verification separate. The approved design is retained in `docs/WMS-STATIONS-WORK-ROUTING-AND-ASSIGNMENTS-PROPOSAL-2026-09-05.md`.

## What the code definitely does

| Behavior | Exact source and reasoning |
|---|---|
| Defaults to combined Receive & Stow, same-person replenishment, combined assembly/packing, and claiming on start | `shared/warehouse-work.ts:41`, `smallTeamProfile()`, returns these values. `emptyWorkConfiguration()` at line 83 creates no stations or employee assignments. These are draft settings, not execution consumers. |
| Exposes eleven capabilities without requiring eleven physical stations | `shared/warehouse-work.ts:3`, `WORK_CAPABILITIES`; `workStationSchema` allows multiple capabilities on one physical location. Mobile eligibility can omit a station. |
| Configures stations and employee warehouse/zone/station scopes | `shared/warehouse-work.ts`, `workStationSchema`, `workScopeSchema`, `workAccessSchema`, `workConfigurationSchema`; unknown fields, duplicate station identities/codes/users/capabilities, invalid IDs, and dangling station-scope references are rejected. |
| Gives administrators a real draft setup page | `client/src/pages/warehouse-work/WorkConfigurationPage.tsx:52`, `ConfigurationEditor`; the entry is Warehouse Settings → Stations & workflows, wired in `client/src/pages/WarehouseSettingsPage.tsx:250` and `client/src/App.tsx:378`. It edits capabilities, locations, profiles, scopes, and change reasons and shows paginated revision history. |
| Separates role abilities from physical work scope | `server/modules/identity/infrastructure/work-access.repository.ts:4`, `readWarehouseWorkActor`, reads current active-user status and role grants through Identity's published interface. `server/modules/warehouse/work/domain/work-configuration.ts:74`, `previewWorkContext`, requires matching role capability AND employee scope AND a valid warehouse-local location/station. Configuration rights do not imply work execution rights. |
| Fails closed for unknown legacy permission constraints | `readWarehouseWorkActor()` only accepts `constraints === null`. It does not silently erase a non-null constraint to widen a role. Supporting other role-constraint formats requires an explicit contract. |
| Rejects inactive/unknown/3PL warehouse configurations | `server/modules/warehouse/work/application/work-configuration.service.ts`, private `warehouse()`, accepts active `operations` and `bulk_storage` warehouses only. External 3PL fulfillment is not represented as an internal workstation. |
| Makes saves retry-safe and rejects stale editors | `WorkConfigurationService.save()` at line 55 canonicalizes the request, locks the warehouse, rechecks Identity, and returns a stored result only for the same command, payload, and actor. A new command must match the current revision. Access changes additionally require `warehouse_work:manage_access`. |
| Saves revision, station projection, and access projection atomically | `server/modules/warehouse/work/infrastructure/work-configuration.repository.ts:27`, `transaction()`, and line 92, `persist()`. A failure rolls back all three writes. Station identity collisions across warehouses cannot overwrite the existing station. |
| Retains station identity and complete before/after audit evidence | `validateConfigurationReferences()` at `server/modules/warehouse/work/domain/work-configuration.ts:42` requires existing stations to be disabled rather than deleted. `migrations/0654_warehouse_work_configuration.sql:2` stores actor, timestamp, reason, command, before/after configuration; its trigger at line 48 rejects UPDATE/DELETE/TRUNCATE of history. |
| Protects warehouse/location association | Migration triggers at lines 67 and 80 reject foreign station locations and moving a referenced location into another warehouse. FKs prevent deleting referenced warehouse/location/user identities. Disabling a station does not erase these historical relationships. |
| Does not let a lost HTTP response create a second logical save | `client/src/pages/warehouse-work/work-configuration-draft.ts:6`, `prepareWorkSaveAttempt`, retains the command ID for an identical draft. `ConfigurationEditor` retains unsaved edits when the server revision changes and requires explicit reload/review for conflicts. |
| Leaves live execution unconnected | `workRevisionSchema` fixes `executionStatus` to `not_connected`; `previewWorkContext()` always returns `executionAllowed: false`. `registerWorkConfigurationRoutes()` exposes setup, save, history, and read-only context preview only. No task, build, inventory, claim, label, or fulfillment command is called. |
| Keeps one writer for each new table | `scripts/writer-ratchet/baseline.json` adds exactly `warehouse.work_configuration_revisions`, `warehouse.work_stations`, and `warehouse.work_access_scopes`, each owned only by `modules/warehouse`. Identity grants are read through the Identity module, not through warehouse-owned SQL joins. |

## Contracts and controls

### Persistence

- `warehouse.work_configuration_revisions`: append-only revision/command/audit authority. Complete versioned profile, station, and access snapshots; never rewrite an old profile to match a new edit.
- `warehouse.work_stations`: stable UUID identities and current draft projection; unique code within a warehouse; location FK; enabled flag; multiple capabilities.
- `warehouse.work_access_scopes`: current employee scope projection keyed by warehouse and user; does not grant a role capability by itself.

The migration is additive. It does not seed stations, change location types, move materials, change stock, enable canonical inventory authority, or publish quantities. Migration prefix 0654 was checked against refreshed main; recheck it before publishing if main advances again.

Role definitions are added to the existing RBAC permission catalogue. Existing `SYSTEM_ROLES.Administrator` includes that catalogue, so the normal application RBAC seed will make these permissions available to administrators on deployment. This is not a new shared operator account, not an automatic assignment of employees to stations, and not an activation of live work. Other roles must explicitly receive the relevant abilities.

Configuration administration permissions are global administrative permissions. Work eligibility is warehouse-scoped. This slice does not introduce delegated zone-only configuration administrators or alter the existing generic RBAC constraints contract.

### HTTP

All routes require a personally authenticated session; server-side checks use the session actor, not an actor supplied in the request.

- `GET /api/warehouses/:warehouseId/work-configuration`: view setup and safe employee/location choices; requires view permission.
- `PUT /api/warehouses/:warehouseId/work-configuration`: `{ expectedRevision, commandId, reason, configuration }`; requires view/configure and manage-access when access changes.
- `GET /api/warehouses/:warehouseId/work-configuration/history?before=N`: twenty immutable revisions per page; requires view permission.
- `POST /api/warehouses/:warehouseId/work-configuration/preview-context`: read-only eligibility check for the current actor, capability, station or mobile context, and location. It does not assign work, start a session, reserve stock, or grant permission to execute.

GET and preview never create a default row or claim a task. No production runbook is authorized by these endpoint descriptions.

### Locking and failure behavior

The warehouse row serializes configuration revisions. Commands acquire its UPDATE lock before Identity rows, affected employee rows, warehouse-local locations, revision insertion, station IDs (sorted), and access user IDs (sorted). Setup/history/context reads use a shared warehouse lock. Identity membership and permission rows are shared-locked while the command is authorized; save-time employee validation is limited to the requested scopes.

The application does not hold this transaction open for any external API. It has no publication side effect, so no external outbox is needed for configuration saving; execution outbox contracts remain in the approved next package.

| Failure | Result |
|---|---|
| Same command and payload retried after response loss | Original revision returned; no new write or timestamp. |
| Reused command with changed payload/actor | 409 `WORK_COMMAND_REUSED`. |
| Another editor saved first | 409 `WORK_REVISION_CONFLICT`; local edits remain visible. |
| Missing/revoked role capability, inactive employee | 403 permission denial, including replay authorization. |
| Invalid cross-warehouse location or employee scope | Rejected before persistence. |
| Foreign station UUID collision or later projection failure | Entire transaction rolls back. |
| Deadlock/serialization/lock-unavailable failure | Classified 503; retry with the same command ID. |
| Corrupt stored/output contract or unexpected DB error | Classified 500; no raw DB details in the response. |
| Rollback itself fails | Both failures retained in AggregateError; broken client discarded. |

## Verification

Confirmed locally:

- TypeScript: `node node_modules/typescript/bin/tsc --incremental false` passed.
- Production client/server bundle: `npm run build` passed after rebase; Vite reports its large-chunk warning (not a build failure).
- Focused domain/service/transaction/HTTP/UI plus writer-ratchet and migration-prefix checks: **50 passed**, seven files.
- Full unit suite on the original clean base plus this change: **7,481 passed; four failed; fourteen skipped** (830 files).
- Full unit suite after rebasing onto `ff9887bd`: **7,520 passed; the same four failed; fourteen skipped** (834 files). No new failures were introduced by the rebase. The failing tests and their source files remain unchanged from main.
- All four failures reproduced on a second untouched worktree at `8785bc7586c69275bf6528a63d90bb0aa9556f41`; its git status remained clean.
- Whitespace check passed. New writer baseline adds only the three warehouse-owned tables.

The four unrelated failures are three assertions in `server/modules/oms/__tests__/unit/wms-sync-bin-resolution.test.ts:14` and one in `server/modules/warehouse/__tests__/unit/product-location-primary-scope.test.ts:138`. Their source-extraction regexes expect LF-only closing lines. Both underlying source files contain CRLF on this Windows checkout: regex match is false on raw text and true after in-memory CRLF→LF normalization. Those tests and implementation files are unchanged by this work. They were not silently fixed or excluded from the full run.

Seven real PostgreSQL tests are implemented in `server/modules/warehouse/__tests__/integration/work-configuration.integration.test.ts` and wired into `.github/workflows/ci.yml:101`. They cover actual migration execution, immutable history, projections, concurrent editor conflicts, identical retries, cross-warehouse guards, retirement, and rollback after a deliberately failed scope write. They were **skipped locally**, not passed: no disposable PostgreSQL server was available. The harness requires both an explicit disposable URL and acknowledgement and rejects an application database even if credentials differ.

UI coverage includes server rendering of Small Team defaults and permission controls, plus deterministic retry-state tests. Interactive browser/gun verification and actual PostgreSQL CI results remain outstanding. No external channel/provider calls were exercised.

## What is not proven / remaining implementation

This slice must not be presented as completing the full approved foundation or the inventory migration.

1. Shared durable tasks, workstation/device sessions, worker claims/assignment, handoff acceptance, partial/cancel recovery, and supervisor queues still need implementation. Session expiry must not release stock or redo physical work.
2. Pick-gun → assembly → packing needs an actual end-to-end execution integration through canonical inventory/build owner commands. There is no gun handoff button or live assembly completion command in this slice.
3. The label-first workflow remains approved: picker prints the existing label, passes the job to assembly, and moves on; assembler completes the physical build and applies that label. Label/provider event behavior must be traced and tested before activation, especially preventing a label event from rejecting or double-posting a later canonical build.
4. Receiving/stowing, replenishment, QA, returns, and inventory control still need their owner integrations. Small Team presentation must not replace the replenishment rules/resolver with picker UI posting authority.
5. Version pinning for active tasks, routing previews, activation/readiness checks, and execution outbox delivery are not implemented yet. Draft configuration has no activation state other than `not_connected`.
6. Existing ATP/claim cutover and legacy reservation reconciliation decisions are not resolved by adding stations. No assertion is made about production canonical-authority activation or deployment status.

## Assumptions and design decisions

No assumption about live stock, employees, station locations, provider configuration, or deployment state was used. Station locations and scopes must be explicitly selected against current warehouse/Identity records.

The existing warehouse record is treated as a building/site because `shared/schema/warehouse.schema.ts` explicitly defines it that way. Warehouse profiles are explicit copies of the Small Team preset in this slice, not a new business-wide inheritance engine. One employee may have different scopes in different warehouses; one warehouse scope may be warehouse-wide, a zone, or a set of stations. More elaborate unions and sub-profile overrides remain future extensions, not hidden fallback behavior.

The user approved implementation, not production activation. Keeping this configuration slice non-executing is deliberate sequencing, not a claim that a stub completes assembly. The next substantive package is the shared task/handoff engine connected to the real outbound assembly flow. No additional deployment is required merely to discuss or implement that next package.
