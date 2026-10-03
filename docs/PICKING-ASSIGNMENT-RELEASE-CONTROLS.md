# Picking assignment and hold controls

Implementation branch: `codex/picking-release-permissions`, initially based on `ae4f64ba6` after merged PR #1651 and refreshed against `edd1812f9` before publication. This is a code change, not a production order recovery or inventory adjustment.

## Operator behavior

- **Remove hold** changes hold state through the existing hold workflow. It requires `orders:hold`, whether the hold belongs to an order or a line.
- **Release picking assignment** ends picker ownership. It preserves recorded picks, inventory, reservations, whole-order holds and line holds. A held order stays held after its assignment is released.
- **Recover stuck order** is removed. An active assignment is not itself evidence that an order is stuck.

A picker with `picking:perform` can release their own assignment. Releasing another picker's assignment, or an active order with no recorded owner, requires the separate **picking / release any** permission. Its description in Roles is “Release another picker’s assignment without changing holds or pick progress.” The existing RBAC seed gives it to Administrator and Team Lead, not Picker. Custom roles may receive it through the existing Roles editor. Legacy `user.role` labels alone do not authorize an override.

Implementation: `PickingWorkspace` in `client/src/pages/Picking.tsx`, `canReleasePickingAssignment` in `shared/types/picking-assignment-release.ts`, and `DEFAULT_PERMISSIONS` / `SYSTEM_ROLES` in `server/modules/identity/domain/identity.domain.ts`.

## One operation and its failure behavior

`PickingUseCases.releaseOrder` delegates to `releasePickingAssignment`. Its transaction:

1. Reads and share-locks the current Identity account and applicable role grants. Missing, inactive, revoked or unsupported constrained grants fail closed.
2. Locks the WMS order and checks ownership, permission, current status and the assignment snapshot supplied by the screen (picker ID and `startedAt`). An override requires that snapshot. A changed assignment or non-active order is rejected, not reopened.
3. Updates only `warehouseStatus` to `ready`, `assignedPickerId` to null and `startedAt` to null.
4. Appends `order_released` to the existing picking audit log with actor, time, authority and before/after snapshots in the same transaction. Audit failure rolls the update back. A retry against an already released order is a no-op with no second audit row.

Inventory and line-state commands are not called. Holds can only be removed via the separate hold workflow. Combined groups check all active member assignments and issue the same per-order command for each; this is not an all-or-nothing group transaction. A partial failure is reported, the queue is refreshed, and already released orders remain released.

Implementation: `server/modules/orders/domain/picking-assignment-release.ts`, `picking-assignment-release.service.ts`, `picking-assignment-release.repository.ts`; Identity permission reads live in `server/modules/identity/infrastructure/picking-release-access.repository.ts`.

## Compatibility and deployment

- Normal URL: `POST /api/picking/orders/:id/release`.
- Legacy `POST /api/orders/:id/force-release` delegates to that same handler and additionally requires `picking:release_any`. It no longer clears holds or resets progress.
- Both old internal diagnostic release URLs return **410** with guidance to use the queue. No runtime/script caller was found in the repository; external callers cannot be ruled out by source inspection.
- `resetProgress: true` is rejected. Explicit unpick/correction workflows remain separate.
- Current UI always submits the observed assignment. For compatibility, old callers without a snapshot may release only their own active assignment; they do not get the new same-picker-reclaim stale-snapshot protection. Overrides without a snapshot must refresh rather than act blindly.
- No new database migration: the existing startup RBAC seed installs the new permission. Reload the Picking page after deployment to obtain the new controls and permission list.
- This does not implement automatically ending a picking assignment when all remaining lines are held. That workflow is unchanged.

## Verification and remaining limits

Local checks passed: 644 unit/regression checks, 12 PostgreSQL integration checks, and 28 desktop/mobile browser checks. Application, server-test and client-test TypeScript checks passed; `git diff --check` passed. The disposable PostgreSQL cluster was stopped and removed after verification.

Automated coverage includes owner/override permissions, invalid input, separate hold controls, combined groups, absent and terminal orders, stale assignments, duplicate commands, concurrent SQL writers, atomic audit rollback, and preservation of the complete order and its lines except the three assignment fields. PostgreSQL tests use a uniquely created disposable local database and current-column fixtures; they are not a full production migration test. Browser tests exercise desktop and mobile screens with mocked APIs.

Production orders, live role grants, and post-deployment behavior have not been inspected or changed by this implementation. Local checks are not GitHub CI or production verification; publishing this change does not deploy it.
