# Package Allocation Authority Resolution Audit

## Purpose

This command runs one bounded, shadow-only authority-resolution preview for one
privately selected WMS source item. It does not create an allocation group,
append a ledger plan, schedule work, call a provider, or make an effect intent
executable.

The command is disabled unless
`PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_ENABLED` is exactly `true`. It
uses only `WMS_INTEGRITY_AUDIT_DATABASE_URL`; there is no `DATABASE_URL`
fallback.

## Safety contract

1. A cost-only discovery-plan audit runs first and verifies the dedicated
   database role is read-only, lacks TEMP privilege, and has the expected
   relation/index contract.
2. The resolution preview runs in `REPEATABLE READ READ ONLY` and always ends
   with `ROLLBACK`, including successful previews.
3. Evidence loaders issue no advisory locks, `FOR UPDATE`, or `FOR KEY SHARE`
   in preview mode.
4. Relationship discovery is bounded to one source, at most 200 packages,
   10,000 label events, 5,000 current carrier events, and 8 MiB of sanitized
   payload evidence.
5. Standard output contains aggregate counts, review codes, plan evidence, and
   timings only. It omits the source ID, group UUID, label IDs, tracking
   numbers, package keys, raw evidence, and planner snapshots.
6. Any executable effect intent is a hard failure.

Relationship discovery is not complete authority. A package with no persisted
relationship remains unknowable; successful output therefore retains
`selectionCompleteness: "unproven_outside_persisted_relationships"`.

## Deployment prerequisites

Before the first run:

1. Deploy this audit slice and require green TypeScript, unit, and PostgreSQL
   hardening CI. The PostgreSQL test must execute rather than skip.
2. Preview the dedicated audit-role grant update:

   ```powershell
   npm run wms:configure-integrity-audit-role -- --dry-run --credential=<credential-name>
   ```

3. Obtain separate approval before applying that grant-only change:

   ```powershell
   npm run wms:configure-integrity-audit-role -- --execute --credential=<credential-name>
   ```

4. Confirm the deployed release and app/database health using metadata-only
   checks. Do not print or inspect config values.
5. Select one representative source ID privately. Do not paste it into logs or
   tickets. Generate a fresh preview-only UUID locally with `New-Guid`; the job
   rejects an existing nonempty allocation group.

## One supervised run

Run once with an external wall-clock limit. Supply the enable flag only to this
one-off process; do not persist it in app config and do not add a scheduler.

```text
heroku run --app cardshellz-echelon "env PACKAGE_ALLOCATION_AUTHORITY_RESOLUTION_AUDIT_ENABLED=true npm run wms:audit-package-allocation-resolution -- --source-id=<private-source-id> --group-key=<fresh-preview-uuid>"
```

The source ID is necessarily present in the operator command, shell history, and
potential Heroku dyno command metadata. The program itself never repeats it in
success or failure output. Keep the command and platform metadata private.

The external supervisor must terminate a hung process because pool shutdown is
not bounded by the PostgreSQL query timeout.

## Pass criteria

- command exits zero;
- `mode` is `read_only_resolution_preview`;
- `queryExecuted` and `readOnlyRoleVerified` are `true`;
- `databaseTemporaryPrivilege` is `false`;
- `plannedSequentialScanCount` is zero;
- `executableEffectIntentCount` is zero;
- selected/projected/rejected package counts and review codes are plausible for
  the privately selected case;
- no identifier or raw evidence appears in output;
- post-run release, web-dyno, and database health are unchanged.

## Stop conditions

Stop without retrying or changing authority when:

- the role, relation, or index preflight fails;
- the group is not absent or empty;
- source/package evidence is missing, out of bounds, or invalid;
- a sequential scan is planned on a protected discovery relation;
- any executable intent appears;
- cleanup fails or the external wall-clock limit is reached;
- output contains an identifier or raw evidence.

A passing audit is evidence for this one shadow case only. It does not authorize
ledger writes, runtime wiring, effect execution, scheduling, provider calls, or
Phase 2 cutover.
