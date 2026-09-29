# Order country integrity

Order address writers store recognized ISO 3166-1 alpha-2 codes. A missing country
remains NULL; shipping requires a known country. Provider country codes take
precedence over names, and an invalid supplied code does not fall back to a name.
Ambiguous names such as `America` and `Virgin Islands` are rejected.

## Deployment and database protection

Migration `258_order_country_integrity.sql` guards new and changed country values
on `oms.oms_orders`, `wms.orders`, and `wms.combined_order_groups`. It accepts
documented country-name aliases during rolling deployment and stores their codes.
An unchanged historical country value does not prevent unrelated order updates.
The migration does **not** rewrite historical orders or enable customer returns.
The raw `public.shopify_orders` mirror belongs to another writer and is excluded.

Full-table validation is a separate rollout step after approved historical repair.
Do not add a `CHECK ... NOT VALID` as a shortcut: PostgreSQL enforces that check on
updated rows, including unrelated updates to historical noncanonical records.

## Preview historical cleanup

Use Echelon's configured database (`EXTERNAL_DATABASE_URL` takes precedence over
`DATABASE_URL`). Do not place credentials in command arguments or plan files.

```powershell
node --import tsx scripts/repair-order-countries.ts --plan=.local/country-repair.json
```

The default is read-only. It writes a new plan file containing only table names,
primary IDs, before/after countries, and hashes of unrecognized values. It refuses
to overwrite an existing plan. Its summary includes a SHA-256 digest and counts.
Keep the plan outside version control. Review it before authorizing application.
Missing/blank countries and all other columns remain unchanged. Unknown nonempty
values block application; resolve those from authoritative evidence first.

The read-only production census on 2026-09-29 found 33,684 recognized aliases in
OMS, 50,870 in WMS orders, and none in combined groups. These are field counts,
not distinct customer orders. No unrecognized nonempty values were found in
these tables. This census is a point-in-time observation; generate a fresh plan
for the actual cleanup rather than treating those counts as an execution target.

## Apply an approved plan

Deploy migration 258 and the application changes first. Obtain approval for the
specific saved plan and its digest before production application. For example:

```powershell
node --import tsx scripts/repair-order-countries.ts --apply --plan=.local/country-repair.json --actor=OPERATOR_ID --operation-key=APPROVED_OPERATION_ID --confirm-digest=APPROVED_SHA256
```

The repair changes only the specified country fields on the order records. It
does not change order status, addresses' other fields, inventory quantities,
refunds, return policies, customer access, or shipping labels. Normal database
triggers remain active. Each batch locks rows, checks that their country still
matches the preview, and commits country updates with immutable before/after
audit rows in `oms.order_country_repairs`. Operation identity, actor, and plan
digest are bound in `oms.order_country_repair_operations`.

The OMS `queue_archon_order` trigger from migration 0672 also creates or advances
the order's Archon projection outbox entry. The 2026-09-29 preview therefore
implies **33,684 OMS outbox entries created or advanced**, alongside its 84,554
country-field corrections, and subsequent normal Archon order projection work.
Country changes, repair audit rows, and outbox rows commit or roll back together.
PostgreSQL sequence values can have gaps after rollback; a sequence increment
alone is not a committed outbox entry. An idempotent retry skips countries already
corrected and does not enqueue them again.

The production trigger inventory on 2026-09-29 also confirmed the existing
`aa_cutover_writer_admission` statement guard on OMS and WMS orders. It takes the
normal cutover admission fence lock (`FOR SHARE NOWAIT`) and requires its singleton
to have a positive epoch; it does not change inventory quantities. An unavailable fence aborts
the current repair batch. Do not disable or bypass either this admission guard or
the Archon outbox trigger. The OMS status-only sellability trigger and insert-only
intake trigger do not fire for these country-only updates. Confirm the current
enabled trigger inventory before approving a later production run.

A concurrent country edit aborts that batch instead of overwriting the edit.
Earlier committed batches remain audited. Retry the exact same plan, operation
key, and actor to resume; already canonical rows are skipped. A changed plan or
actor requires a new operation key and a newly reviewed approval. Missing rows,
changed values, lock timeouts, or audit-write failures cause a nonzero exit.
There is no automatic reverse migration that restores country names.

After cleanup, generate another read-only preview. Investigate any remaining
aliases or unknowns before validating a full-table constraint in a later release.
