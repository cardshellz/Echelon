# Explicit employee access: Foundation rollout contract

This draft records the approved employee access model and the release gates for its
implementation. The initial documentation commit reserves a real draft PR identity;
the implementation and migration will be attached to the same draft after allocation.
It is not a deployment or permission-change authorization.

## Accepted authority

Access comes from explicitly assigned roles. Custom roles, multiple roles and deliberate
zero-role assignments remain valid. The legacy user role label does not grant access.
Ordinary startup registers missing definitions only; it must not restore revoked grants
or infer memberships from legacy labels. Account creation and granting access are separate.
Existing named business approver-role requirements remain explicit assigned-role policies.

## Intended correction and preserved behavior

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

1. Allocate the audit migration using this actual draft PR number and current migration
   dependencies. Verify discovery, immutability, upgrade and final-head hosted checks.
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
