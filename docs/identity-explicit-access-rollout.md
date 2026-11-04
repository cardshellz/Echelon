# Explicit employee access: Foundation rollout contract

This document records the approved employee access model and the release gates for
[draft PR #1998](https://github.com/cardshellz/Echelon/pull/1998). The implementation
carries the earlier scoped-grant, role-editor and startup-revocation corrections into
one explicit-role cutover. It is not a deployment or permission-change authorization.

## Accepted authority

Access comes from explicitly assigned roles. Custom roles, multiple roles and deliberate
zero-role assignments remain valid. The legacy user role label does not grant access.
Ordinary startup registers missing definitions only; it must not restore revoked grants
or infer memberships from legacy labels. Account creation and granting access are separate.
Existing named business approver-role requirements remain explicit assigned-role policies.

## Implementation and preserved behavior

- Reject malformed role selections before deleting anything. An explicit empty list is a
  valid revocation. Serialize full replacements without promising optimistic versioning.
- Recheck access-administration actors inside the mutation transaction. Preserve existing
  usable access-management coverage and commit critical access audit with the mutation.
- Preserve restricted grants and fail closed when an editor cannot safely represent them.
- Use current active account/assignment state at staff HTTP, UI and WebSocket boundaries.
  Keep active zero-role identity readback and logout available for recovery.
- Protect access audit with an additive forward migration; do not rewrite prior guards,
  grant records, credentials, financial state or customer/vendor access policies.

## Gates before any rollout

1. Verify discovery, immutability, upgrade and final-head hosted checks for
   `900000053000019980001_identity_access_audit_guard.sql`. Its allocation belongs to
   PR #1998 and depends on `0107_audit_events.sql` and the current Shopify OAuth
   migration. Install the additive guard before enabling the access-command cutover.
2. Run the read-only access preflight only in an explicitly approved environment. Review
   actual zero-role accounts and named-role effects; a legacy label is not migration input.
3. If there is no usable access manager, stop. Review an explicit bootstrap for the exact
   existing account and existing role/grant IDs, expected prior state, authorized actor,
   reason and audit evidence. Do not add a default grant, credential or emergency bypass.
4. Verify actual runtime-role permissions protect audit history. Disposable tests under
   an owner/superuser do not establish deployed least privilege.
5. Coordinate old/new instances and assets. Old startup code must not recreate revoked
   access; new clients fail closed without the current authority metadata contract.
6. Exercise custom/multiple/zero-role and lost-response paths in a real nonproduction
   browser/session. Synthetic component/socket tests alone are not this acceptance.

## Recovery and limits

Retain additive audit protection and history. Do not roll back to startup code that
regrants access; prefer stopping rollout or a reviewed forward correction. Any old-code
rollback needs a revocation-preserving startup patch and current-access review.
After a lost response, read current state and audit before resubmitting. Operation IDs
provide correlation, not an exactly-once receipt or stale-form conflict detection.

This bounded family does not certify every business command, the whole session lifecycle,
production throughput, effective GitHub protections, or the complete Foundation phase.
No merge, automatic merge, deployment or production permission/data mutation is authorized.

## Evidence and maintenance

The pre-publication local review passed 684 focused tests, 664 disposable PostgreSQL
tests across 15 suites, all three TypeScript checks, and seven full current-source schema
upgrade groups covering 512 tables. After allocation, the six Identity database suites
(229 cases) and full-source upgrade were rerun successfully using the allocated SQL.
The 684 focused tests and all three TypeScript checks also passed after allocation.
The new and prior audit guards coexist; a real lock timeout and injected ledger-write
failure preserve prior metadata/history and roll back incomplete DDL. These tests use
an existing disposable owner/superuser and do not establish actual runtime least privilege.
Current hosted results belong to the exact PR head, not these historical local counts.

The access-administration use cases own account/role changes, membership replacement and
permission replacement. `runIdentityAdministration` enforces current actor authority,
management coverage and transactional audit. `readIdentityAccessPreflight` reports the
existing management condition without granting access. Tests are registered in the
existing PostgreSQL manifest; the private-writer AST guard runs in the unit lane.
The guard detects literal imports/re-exports, not all computed imports or direct SQL.

Preserve the accepted custom/multiple/empty-role model when changing these controls.
Guard, exclusion, fixture or manifest changes require review of prohibited and permitted
behavior; a larger baseline is not proof of compliance. Password-reset session invalidation,
optimistic editor versioning and whole-system command/telemetry coverage remain separate work.
