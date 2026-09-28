# Dropship .ops cost change controls — design record

Owner decision of 2026-09-27: when Card Shellz changes a .ops cost, vendors
get notice before an increase is charged, orders keep the current cost until
then, vendors are told what changed on their listings, and every setting is a
staff-editable policy in an admin settings module. Money is integer cents
everywhere. Each part below is its own pull request.

## What happens today

- **Order acceptance charges the live cost.** The wholesale basis is the
  vendor's `.ops` plan cost, read inside the acceptance transaction
  (`server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts`,
  the `loadProductCosts` call near line 1756, resolved by
  `resolveAcceptanceUnitCost` in `domain/order-acceptance-cost.ts`). A change
  saved in Shellz Club is charged on the very next accepted order.
- **Nobody is told.** `application/dropship-notification-events.ts` has no cost
  or price event, and the Shellz Club plan pricing routes
  (`shellz-club-app/server/routes/pricing.ts`: pricing config, overrides, bulk
  CSV) send nothing.
- **Listing prices do not follow.** No job reprices a listing when its cost
  changes, and nothing flags a price that falls below cost. An open pricing
  review goes stale (`DROPSHIP_PRICING_REVIEW_STALE`).
- **A cost has several sources.** `PgShellzClubProductCostAdapter` resolves a
  vendor's cost from their plan: an exact-variant override (fixed price or
  percentage), the plan's wholesale percentage, or undiscounted retail
  (`docs/DROPSHIP-OPS-PRODUCT-COST.md`). A Shopify retail price move changes
  every percentage cost; a plan switch changes all of the vendor's costs.
- **It has already happened.** On 2026-09-27 the owner's catalog preview showed
  a `.ops` cost of $8.09 for `ARM-ENV-SGL-P50` (the value
  `docs/DROPSHIP-OPS-PRODUCT-COST.md` recorded on 2026-09-07), and $6.99 later
  the same day. No vendor was told.

## The cost schedule

Per vendor and variant, because a vendor's cost depends on their plan: a
schedule of entries (cost, effective date). The cost in force at a moment is
the latest entry already in effect; later entries are announced changes. Pure
rules (part C2, `server/modules/dropship/domain/cost-schedule.ts`), applied to
each new reading of the live cost:

1. **First reading** starts the schedule. It is not a change.
2. **Same as in force**: any announced change is withdrawn.
3. **Decrease**: announced changes are withdrawn; the decrease applies at once,
   or after the notice when the policy says so.
4. **Increase**: announced after the notice, dated at the next midnight UTC once
   the full notice has passed. An increase already announced below the live
   cost keeps its date; one announced above it is lowered to it and keeps its
   date. An increase caused only by a Shopify retail move under a percentage
   cost applies at once when the policy says retail moves get no notice.
5. **Unavailable reading**: nothing changes. Acceptance still fails closed.

**Price protection.** When the policy enables it, acceptance charges the cost in
force after reconciling the schedule with the live reading it already takes.
So an increase is charged from its effective date, and a decrease from the
moment it is seen. With protection off, acceptance charges the live cost and
the schedule still records the change and its notice.

## The policy (admin settings module)

Versioned like the wallet policy: every save is a new immutable version with a
change note and its author, exactly one active version, and an idempotency key.
The settings and their ranges live once in `shared/dropship/cost-change-policy.ts`.

| Setting | Range | Default (ASSUMPTION) |
|---|---|---|
| Notice before an increase is charged | 0–90 days | 14 |
| Decreases | at once, or after the same notice | at once |
| Keep charging the current cost until an increase takes effect | on/off | on |
| Give Shopify retail moves the same notice | on/off | on |
| Notify by email, in the portal, and on decreases | on/off each | on |
| Skip notices under a change of | 0–$1,000 and 0–100% | no minimum |
| Rule-priced listings when an increase takes effect | reprice / wait for review | reprice |
| Fixed-price listings the new cost puts under water | nothing / warn / pause | warn |
| How often live costs are compared with the schedule | 15–1,440 minutes | 60 |

A change under the notice minimum is still recorded, scheduled and protected;
only the notice is skipped.

## The admin settings module (part C1)

Dropship, **Cost Changes** (`/dropship?tab=cost-changes`):
`client/src/pages/dropship-cost-change-policy-panel.tsx`, with every decision
in `dropship-cost-change-policy-model.ts`. Reading needs `dropship:view`;
publishing needs `dropship:manage_operations`.

- **What acts today.** The server reports which parts are live
  (`DROPSHIP_COST_CHANGE_ENFORCEMENT` in
  `application/dropship-cost-change-policy-service.ts`). All four are off in
  C1, and each later part switches on its own. Until every part a setting needs
  is live, the page marks that setting "not live yet" and says what happens
  today (see "What happens today" above).
- **Settings in force.** Each setting's value, its default, and whether it acts
  today, plus who published the version in force and why.
- **New policy version.** Every setting grouped as staff think of them, and a
  required change note. Publishing needs a changed setting, with one
  exception: the version the migration seeded (created by `system`) can be
  published unchanged, which records that staff approved it.
- **Version history.** Newest first, at most 20 versions. Each version shows who
  published it, when, why, and which settings changed from the version before.

A save sends one idempotency key per distinct request. The page reuses the key
while the settings and note stay the same, so a retry after a lost response is
replayed by the server and never publishes a second version.

**API.** `GET` and `POST /api/dropship/admin/cost-changes/policy`
(`interfaces/http/dropship-admin-cost-change-policy.routes.ts`).

A `POST` inside one transaction:
1. claims its key in `dropship.dropship_admin_config_commands`;
2. takes advisory lock 94004;
3. retires the active row;
4. inserts the next version;
5. writes a before/after audit event (`cost_change_policy_version_created`) to
   `dropship.dropship_audit_events`.

| Condition | Status |
|---|---|
| Created | 201 |
| Replay | 200 |
| Invalid input, or no key | 400 |
| Key reused for a different request, or a concurrent publish | 409 |
| Table not there yet | 503 |
| Stored row fails the contract | 500 |

## Delivery plan

| Part | Scope | Switches on |
|---|---|---|
| C1 | This policy and its admin module | none |
| C2 | Cost schedule and detection | `detection` (where the worker is switched on) |
| C3 | Price protection at acceptance | `priceProtection` (the policy setting decides whether it applies) |
| C4 | Vendor notices | `vendorNotices` (the policy's channels and minimums decide what is sent) |
| C5 | Listing actions on the effective date | `listingActions` |

## Cost schedule and detection (part C2)

**Storage (migration 0711).**
- `dropship.dropship_cost_schedule_entries`: one row per schedule entry, per
  vendor and variant: kind (`baseline`, `increase`, `decrease`), the cost it
  changes from, the cost, the effective date, and the reading that created it
  (time, policy version, cost source, plan, override, retail price and
  discount) and which writer took it (`recorded_by`: `detection`, or
  `acceptance` once C3 reconciles at order acceptance). A trigger permits only two changes to a row: stamping
  `withdrawn_at` once, and lowering the cost of an announced increase. Rows
  are never deleted.
- `dropship.dropship_cost_change_log`: one append-only row per operation
  applied (`baseline`, `increase_announced`, `increase_applied`,
  `decrease_announced`, `decrease_applied`, `increase_reduced`,
  `change_withdrawn`), with the amounts, the date, whether only the retail
  price moved, and the reading. A trigger refuses updates and deletes. The
  event names live once in `shared/dropship/cost-change-policy.ts`.
- `dropship.dropship_cost_detection_state`: the worker's one row: pass
  number, when the pass started and completed, the vendor cursor, the policy
  version, and the pass's counts.

**Which costs are watched.** Vendors with status `active` or `paused` (the
set the listing tier reconcile reviews), and for each, the distinct variants
in `dropship.dropship_vendor_listings` whose status is not `not_listed` or
`ended` (`COST_TRACKED_LISTING_STATUSES` in
`application/dropship-cost-detection-service.ts`). A variant not yet tracked
gets a baseline at its first reading; a relisted variant starts again from
the live cost.

**Telling a retail move from a plan change.** The cost reader now returns the
retail price and discount a retail-based cost came from
(`retailPriceCents`, `discountBps` on `DropshipProductCost`; null for a fixed
price). A reading is retail-driven only when, compared with the reading behind
the entry in force, the source, plan, override and discount are the same and
the retail price differs (`isRetailDrivenReading` in `domain/cost-schedule.ts`).
It is compared with the entry in force, not an announced one, so a plan change
bundled with a retail move still gets the notice.

**The worker** (`infrastructure/dropship-cost-detection-runner.ts`, schedule
`costDetection`, advisory lock 736215) is opt-in:
`DROPSHIP_COST_DETECTION_WORKER_ENABLED=true`. It ticks every minute
(`DROPSHIP_COST_DETECTION_TICK_INTERVAL_MS`) and each tick:
1. records the tick, reads the policy in force, and starts a pass when none is
   under way and the policy's detection interval has elapsed since the last
   one began (otherwise the tick is `not_due` and does nothing);
2. takes the next vendors after the cursor
   (`DROPSHIP_COST_DETECTION_VENDORS_PER_TICK`, default 25, at most 1,000);
3. for each vendor, in one transaction under
   `pg_advisory_xact_lock(hashtext('dropship_cost_schedule'), vendor_id)`:
   lists the tracked variants, loads their live entries, reads their costs
   through `PgShellzClubProductCostAdapter.forTransaction` (10,000 per call),
   reconciles each variant with `reconcileCostSchedule`, writes every entry
   and log row, and moves the cursor past the vendor. The cursor only moves
   forward; a stale worker's transaction rolls back whole;
4. completes the pass when fewer vendors than the batch remained.

An unavailable or zero reading records nothing and is counted; a
`source_read_failed` reading is a WARN. Every vendor with a change or an
unavailable reading is logged with its counts, and every pass start and
completion is logged.

**Admin views** (`interfaces/http/dropship-admin-cost-change-activity.routes.ts`,
`dropship:view`): `GET /api/dropship/admin/cost-changes/detection` (whether
this process runs the worker, the state row, and up to 200 announced changes,
soonest first) and `GET /api/dropship/admin/cost-changes/log?limit=&beforeId=`
(newest first, at most 50 per page, cursor by id). The Cost Changes tab shows
them under "Announced changes" and "Change log"
(`client/src/pages/dropship-cost-change-activity-panel.tsx`).

**What "live" means.** `DROPSHIP_COST_CHANGE_ENFORCEMENT.detection` is now
true (the code shipped), but the overview reports detection live only where
the worker is switched on (`resolveDropshipCostChangeEnforcement`), and the
tab shows the last pass, so the page never claims a check that is not running.
Nothing charges, tells or reprices from the schedule until C3 to C5.

## Price protection at acceptance (part C3)

Order acceptance prices its lines inside its own transaction
(`resolveAcceptanceLinesWithClient` in
`infrastructure/dropship-order-acceptance.repository.ts`, on both the legacy
and the canonical path). It now:

1. reads the policy in force (`resolvePolicy`);
2. takes the vendor's schedule lock (`lockVendorSchedule`, the lock detection
   takes), then reads the live `.ops` costs as before;
3. loads the vendor's schedule for the order's variants and reconciles it with
   the live reading through the same planner detection uses
   (`application/dropship-cost-schedule-reconciliation.ts`), writing every
   entry and log row with `recorded_by = 'acceptance'`;
4. refuses an unavailable or zero cost exactly as before, before anything is
   written;
5. charges each line the cost in force when the policy's `priceProtection` is
   on, else the live cost (`decideChargedUnitCost` in
   `domain/order-acceptance-cost.ts`). An announced increase is not charged
   before its date; a decrease given notice stays at the old cost until its
   date, by the policy's own choice.

**Evidence.** Each line's provenance now carries the live cost, the schedule
entry charged, the policy version and whether protection applied
(`DropshipAcceptanceProductCostEvidence`); the pricing snapshot is version 3
with the same fields per wholesale line, and the cost evidence hash includes
the live cost and the entry id, so a protected debit is explained by both.

**Failure modes (C3).**
- The schedule tables are not there yet: the acceptance fails
  `DROPSHIP_COST_SCHEDULE_TABLE_MISSING` with `retryable: true`, and the
  processing pass retries after migration 0711 lands.
- A schedule write is refused (guard or CHECK): the whole acceptance rolls
  back with no wallet write, classified permanent (`retryable: false`).
- Detection and an acceptance see the same change at once: the vendor lock
  serializes them; the second sees the first's entries and writes nothing new.
- No entry in force can be resolved for an available cost: refused as
  `DROPSHIP_ORDER_COST_SCHEDULE_UNRESOLVED` (fatal), never charged a guess.

## Vendor notices (part C4)

**Decision per change** (`domain/cost-change-notice.ts`, applied by
`application/dropship-cost-change-notice-service.ts`): every change log row
gets exactly one decision, recorded in `dropship.dropship_cost_change_notices`
(migration 0712, append-only):

| Row | Decision |
|---|---|
| Schedule start (`baseline`) | `skipped_baseline` |
| Decrease, and the policy does not announce decreases | `skipped_decrease` |
| Change under the policy's cents or percent minimum | `skipped_below_minimum` |
| Policy sends on no channel | `skipped_channels_off` |
| Lowered or withdrawn change whose announcement was never sent | `skipped_unannounced` |
| Otherwise | `sent`, as `announced` (a date ahead), `applied` (took effect at once) or `updated` (lowered or withdrawn) |

**One notification per reading and kind.** Rows are grouped by vendor, reading
time and writer (the reconciliation that recorded them), then by kind, and
each group is one notification: a plan switch that moves hundreds of costs is
one message listing the first ten and counting the rest. The idempotency key
is `dropship-cost-change:{vendorId}:{kind}:{recordedBy}:{observedAt}`; the
notification store replays it, so a crash between sending and recording never
tells a vendor twice. The send happens before the decisions are recorded, and
a group whose send fails stays undecided and is retried on the next pass. A
vendor's readings are decided in order: once one of them fails in a pass, the
vendor's later readings are deferred to a later pass (`groupsDeferred`), so a
lowered or withdrawn change is never judged `skipped_unannounced` while its
announcement is still waiting to go out. The pass finds undecided rows by an
anti-join of the change log against the notices table over their indexes; its
cost grows with the log, and a decision watermark is the next step if the log
ever reaches millions of rows.
Events: `dropship_cost_change_announced`, `dropship_cost_change_applied`,
`dropship_cost_change_updated`, registered as not critical so the policy's
channels (`notifyByEmail`, `notifyInPortal`) are honoured.

**Where it runs.** The notice pass rides the cost detection worker's tick,
after detection, so it covers changes recorded by acceptance too
(`DROPSHIP_COST_NOTICE_GROUPS_PER_TICK`, default 20).

**Surfaces.** Vendors: `GET /api/dropship/cost-changes` and the portal's
"Cost changes" page (coming changes, the last 30 days with each change's
notice status, and the policy's notice terms in their words). Staff: the
change log on the Cost Changes tab shows each row's notice decision.

**ASSUMPTION.** Notices state amounts in USD; the schedule carries no
currency and .ops costs are the Shopify store's prices.

**Failure modes (C4).**
- Notification store down: the group's decisions are not recorded and the
  pass retries it next tick; a WARN names the vendor and reading.
- No notification sender wired: the pass refuses to record a `sent` decision
  (`DROPSHIP_COST_CHANGE_NOTICE_SENDER_MISSING`, fatal) rather than claim a
  notice went out.
- A pass replayed after a crash: the same key replays the notification, and
  `ON CONFLICT (log_id) DO NOTHING` keeps one decision per row.
- Before migration 0712: the pass fails transient and retries; the vendor
  page answers 503.

## Delivery plan for the remaining parts

**C5, listing actions.** On the effective date:
- rule-priced listings are repriced through system push jobs, or wait for the
  vendor's review;
- below-cost fixed prices are flagged, or paused through the variant
  publication hold (at most 500 variants per command).

A queued push publishes the price computed when it runs, not the price the
vendor reviewed. `DropshipListingPushWorkerService` refreshes the listing intent
(`refreshListingIntent`) and pushes it, and its drift check compares only the
stored preview hashes. So under "wait for review", C5 must stop a queued push
from publishing a changed rule price.

## Failure modes (C2)

- **Before migration 0711 runs.** The worker's tick fails with
  `DROPSHIP_COST_SCHEDULE_TABLE_MISSING` (transient) and is retried next tick;
  the admin views answer 503.
- **Two workers at once.** The scheduler lock serializes ticks; per vendor, the
  schedule lock serializes writers; the cursor refuses to move backwards
  (`DROPSHIP_COST_DETECTION_CURSOR_CONFLICT`), rolling the stale
  transaction back so nothing is recorded twice.
- **A vendor's write fails.** The vendor's transaction rolls back, the tick
  fails and is logged, and the next tick resumes at the same cursor.
- **The cost source cannot be read.** Nothing is recorded for the vendor, the
  pass moves on, and the next pass retries; a WARN names the vendor.
- **An entry changed under the reconciliation.** Refused as
  `DROPSHIP_COST_SCHEDULE_ENTRY_STALE`; the transaction rolls back and the
  next pass re-reads.
- **A stored amount that is not whole cents, or an unknown kind or event.**
  Refused as `fatal` and never served.
- **The policy's interval is outside its range.** The tick aborts as `fatal`
  before touching the state.
- **The worker is not switched on.** The tab says so ("Worker off here") and
  reports detection as not live in that environment.

## Failure modes (C1)

- **Before migration 0710 runs.** Reads fall back to the shared defaults with a
  WARN (`DROPSHIP_COST_CHANGE_POLICY_DEFAULTS_FALLBACK`); a publish is refused
  with 503 and nothing is written.
- **Two publishes at once.** Advisory lock 94004 serializes them. A race on the
  one-active or version index is refused as a retryable conflict (409).
- **A retried or replayed request.**
  - Same key and same request: the stored version is returned (200).
  - Same key and a different request: refused permanently (409).
- **A stored row outside the contract.** This means the table's CHECKs were
  bypassed. The row is refused as `fatal` and never served.
- **A lost response.** The page keeps the key for the same request, so the
  retry replays.
