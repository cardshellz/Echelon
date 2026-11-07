# Configurable staff access: first increment, credential reset and WMS picking

This extends [explicit employee access](identity-explicit-access-rollout.md). It is
the shared access foundation, the shipment/order-context slice and the WMS picking
access slice (`B1`), not yet a completed authorization migration across all legacy
Echelon surfaces. Roles remain explicit configurable bundles.
New definitions never automatically grant access or restore revoked memberships.

## Behavior and ownership

- Identity owns effective capabilities, dependency review, stale-save revisions,
  current actor/credential proof, lockout protection and transactional access audit.
  Unsupported restricted grants remain contained; the role editor cannot erase them.
- Shipping owns shipment reads. Separate capabilities control shipment visibility,
  carrier costs and a bounded linked order summary. Context does not grant Orders
  management, customer address/email, pricing or adjacent WMS access.
- WMS Picking (`B1`) migrates sidebar navigation, route admission, `PickingPage`
  tabs/controls and `/api/picking/*` + picking order endpoints off bare assigned-role
  membership and `requireAssignedSystemRole("admin", "lead")` onto explicit `/roles`
  capabilities: `picking:view`, `orders:claim`, `picking:perform`, `picking:complete`,
  `picking:release_any`, `orders:hold`, `orders:priority`, `orders:resolve_exception`,
  `picking:view_logs`, `picking:view_metrics` and `picking:manage_settings` (with
  `picking:view` required as a prerequisite for `picking:view_logs`,
  `picking:view_metrics` and `picking:manage_settings`). Non-live `/packing` is
  removed from sidebar navigation and denied at the router boundary until Packing
  goes live in Phase 10 (`B5`).
- Profile edits reject password fields. Credential reset requires explicit ordinary
  or privileged reset authority, freshly verified actor credentials, a reviewed access
  revision and expected target generation. Protected targets include control-plane
  grant holders, restricted/inactive holders and actual assigned system Administrator/
  Team Lead authority while those compatibility policies remain.
- Password changes, random UUID credential generation, completion state and redacted
  audit commit together. Stale/concurrent commands fail safely. Operation IDs provide
  correlation, not an exactly-once receipt; inspect current state/audit after an
  uncertain response before deliberately submitting a new reset.
- Temporary credentials authenticate only a completion principal, never a legacy staff
  user. Active zero-role accounts can change their own password without gaining business
  access. Self-change ends staff sessions and requires sign-in again. Existing login
  strings remain compatible; newly chosen credentials reject bcrypt's 72-byte truncation.
- HTTP admission, WebSocket delivery and the two eBay SSE observers reject stale
  generations. Observer refusal does not cancel accepted business work, retract already
  delivered/buffered data, or make external provider work atomic.
- Staff login preserves independent customer-return and `.ops` session namespaces and
  secure-cookie requirements. Customer-return regeneration preserves staff generation.
  Pending staff OAuth must restart after staff session rotation.

## Release gates

1. Validate [PR #2004's credential-state migration](../migrations/900000056000020040001_staff_credential_state.sql) according to
   [migration policy](migration-allocation.md). Apply it only after the old-writer
   quiescence in gate 4; install schema before enabling the new code. Reads do not
   backfill missing state. Verify full-schema upgrade and actual
   nonowner runtime-role permissions; reduced fixtures and owner test roles are not that
   acceptance. Existing audit ownership and startup-parity gaps remain separate.
2. Review actual existing assignments, explicit shipment/reset/picking grants and a usable
   administrator/recovery path. Do not infer any grants from profile labels or copy
   existing `users:edit` into reset authority. In `/roles`, review and check
   `picking:view_logs`, `picking:view_metrics` and `picking:manage_settings` for any
   role that should retain access to `/picking/logs`, `/picking/metrics`,
   `/picking/settings` or order combining. The application does not create a default
   administrator or credential. Exact-account production recovery needs explicit approval.
3. Existing staff sessions lack generation metadata and must reauthenticate. Verify a
   real nonproduction browser with custom/multiple/empty roles and both forced and voluntary
   password changes, including independent portal sessions and safe credential handoff.
4. Quiesce old account-creation/password writers before the one-time backfill and drain
   old session admission before relying on generation revocation. An old instance can
   otherwise create a user without credential state after the backfill. Verify zero
   missing user/state associations after all old writers are stopped; stop and review an
   explicit correction if any exist. There is no read-side automatic repair. Old
   instances ignore the generation; old assets cannot complete the new
   lifecycle. Coordinate deployment and test mixed assets/instances without auto-grants.
5. Require exact-head CI and reviewed changes to guards, baselines and discovery. An
   implementation, local pass, hosted pass, required merge check and deployed behavior
   are separate evidence states. Do not release with a failing or missing required lane.

## Verification, limits and recovery

Local proof covers current actor denial, profile escalation refusal, protected targets,
stale/concurrent reset, audit rollback, login/reset races, delayed old-session saves,
real HTTP/WebSocket/SSE revocation, independent session regeneration, WMS picking
route/page/sidebar capability boundaries and schema backfill
on synthetic disposable data. Desktop/mobile browser journeys exercise the real frontend
with mocked APIs; they do not replace a connected runtime acceptance.

Shipment pages retain the 200-row cap; order context reads at most 201 lines and marks
truncation. Access configuration refuses relations above 10000 rows rather than claiming
capacity. SSE adds two authority reads per event and bounds pending output at 512 events;
that bound does not prove socket backpressure, throughput or production workload support.

Retain credential state, audit and revocation protection on rollback. Prefer a reviewed
forward correction or separately approved temporary restriction. Never restore profile
password writes, acceptance of missing/stale generations, startup regranting or an
emergency bypass. Resolve uncertain writes through owner state and audit before retry.
