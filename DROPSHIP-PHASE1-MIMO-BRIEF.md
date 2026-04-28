# MiMo Brief: Dropship Phase 1 Redo

## Goal
Redo Phase 1 safely on a feature branch. This is **schema/migration/tests only**.

## Branch
Create a feature branch from latest `origin/main`:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feature/dropship-phase1-data-model-redo
```

Do **not** commit directly to `main`.

## First reads
- `DROPSHIP-DESIGN.md` if present
- `DROPSHIP-IMPLEMENTATION-DELTA.md` if present
- `DROPSHIP-PHASE1-ENGINEER-BRIEF.md` if present
- `/home/cardshellz/.openclaw/workspace/memory/coding-standards.md` if available

If those docs are missing locally, use this brief as authoritative and ask before guessing.

## Hard no-touch rules
Do **not** touch:
- `package.json`
- `query.ts`
- `vendor-portal/`
- `ops-portal.jsx`
- `ops-portal-design-spec.md`
- any UI files
- eBay/Shopify push code
- order acceptance logic
- wallet debit/credit runtime logic
- production/staging DB config

Do **not** drop existing dropship tables/columns in this phase.
No `DROP TABLE ... CASCADE`.
No destructive migration.
No hardcoded channel IDs.
No hardcoded discounts/tier maps.

## Scope
Implement only additive Phase 1 data model work:

1. Store connections
2. Product selections
3. Variant/SKU overrides
4. Pricing rules
5. Vendor listings
6. Listing push jobs/items
7. Wallet pending/available support, additive only
8. Order intake audit table
9. Store setup checks/blockers
10. Dropship audit events if no existing suitable event table exists

## Required architecture decisions
- OMS channel is `Dropship`.
- Vendor platforms (`ebay`, `shopify`, later others) are source surfaces under Dropship, not OMS channels.
- Card Shellz internal eBay is separate from Dropship.
- Order intake idempotency is `(channel_id, external_order_id)`.
- `vendor_id` is ownership/reporting/billing metadata.
- `oms_order_id` must reference OMS order identity, **not WMS orders**.
- Dropship ATP/allocation will come later from the existing ATP + channel allocation engine. Do not add raw ATP logic.
- Shellz Club `.ops` / configured dropship plan is pricing/entitlement source of truth. Do not create tier discount constants.
- Pending ACH is not spendable. Phase 1 only models this, no runtime wallet flow.

## Migration requirements
- Use the next unused migration prefix after checking existing files.
- Before finalizing, run a duplicate-prefix check.
- Migration must be additive and idempotent where reasonable.
- Add check constraints for enums/status fields where practical.
- Add DB-level idempotency constraints.

Critical constraints:
- wallet ledger unique `(reference_type, reference_id)` where `reference_id IS NOT NULL`
- order intake unique `(channel_id, external_order_id)`
- product selection unique `(vendor_id, product_id)`
- variant override unique `(vendor_id, product_variant_id)`
- active/current listing uniqueness by store connection + variant
- store setup check unique by store connection + check key
- fixed pricing rules allowed only at variant/SKU scope

## Tests
Add tests for migration/schema constraints. If integration DB is unavailable, still add tests and clearly report they were not run because `ECHELON_TEST_DATABASE_URL` is missing.

Required test coverage:
- duplicate wallet reference rejected
- duplicate order intake rejected
- duplicate product selection rejected
- duplicate variant override rejected
- fixed pricing rule rejected on non-variant scope
- fixed pricing rule allowed on variant scope
- pending/available wallet fields are integer cents
- store connection status constraints
- listing uniqueness/idempotency key shape

## Verification before handoff
Run:

```bash
npm run check
python3 - <<'PY'
from pathlib import Path
from collections import defaultdict
m=defaultdict(list)
for p in Path('migrations').glob('*.sql'):
    pre=p.name.split('_',1)[0]
    if pre.isdigit(): m[pre].append(p.name)
for pre, files in sorted(m.items()):
    if len(files)>1:
        raise SystemExit(f'duplicate migration prefix {pre}: {files}')
print('no duplicate migration prefixes')
PY
```

Run targeted tests if test DB is configured.

## Handoff format
Return exactly:

1. Summary of changes
2. Assumptions made
3. Risks
4. Test coverage explanation
5. Failure modes

Also include:
- branch name
- commit hash
- files changed
- exact commands run and results
