# Cutover Runbook — ShipStation/OMS/WMS Refactor

**Last updated:** 2026-04-27
**Plan reference:** `shipstation-flow-refactor-plan.md` §10 Rollout Strategy
**Branch:** `refactor/ss-wms-oms`

This runbook covers the operational steps to safely flip feature flags for the ShipStation flow refactor, from the current all-flags-OFF state through full cutover (Shopify-native ShipStation disconnected).

**Do not rush.** Each flag flip is a discrete step. Monitor between every flip.

---

## Conventions used throughout this runbook

- **All shell commands assume Windows PowerShell** (the Heroku CLI environment Overlord uses).
- **`heroku run` requires the `-- "..."` quoted form** to pass flags through to the dyno's command. Without quotes, Heroku CLI eats the flags. Every `heroku run` example here uses the quoted form.
- **`heroku pg:psql` is not used** because `psql` is not installed locally on the workstation. SQL inspection commands are run from a PostgreSQL GUI client (DBeaver, pgAdmin, TablePlus, etc.) connected directly to the Echelon database.
- **`Select-String`** is used in place of `grep`.
- **Parity check (`scripts/parity-check-push.ts`) runs AFTER step 3.3** — not before. Pre-flag, the script has no Echelon-pushed shipments to compare against and reports all-skipped. See §2 and §3.3.A.

---

## 1. Pre-flight checklist

Complete **all** items before starting the flag-flip sequence.

### 1.1 Deployment verification

- [ ] All commits C1–C39 deployed to `main` on GitHub
- [ ] Heroku auto-deploy is green (no failed deploys in Activity tab)
- [ ] Production database accessible: connect via your DB GUI client and run `SELECT 1;` — should return one row.

### 1.2 Migration verification

In your DB client, run:

```sql
SELECT filename, applied_at
FROM public._migrations
WHERE filename LIKE '058_%'
   OR filename LIKE '059_%'
   OR filename LIKE '060_%'
   OR filename LIKE '061_%'
   OR filename LIKE '062_%'
   OR filename LIKE '063_%'
   OR filename LIKE '064_%'
   OR filename LIKE '065_%'
ORDER BY filename;
```

Expected: 7 rows (058–064 from the deploy, 065 added manually after dedup — see step 1.4 / 1.5).

- [ ] Migrations 058–064 present in `_migrations`
- [ ] Migration 065 to be added during step 1.5

### 1.3 Feature flags — all OFF

In PowerShell:

```powershell
heroku config -a cardshellz-echelon | Select-String -Pattern "WMS_FINANCIAL_SNAPSHOT|WMS_SHIPMENT_AT_SYNC|PUSH_FROM_WMS|SHIP_NOTIFY_V2|INBOUND_RECONCILE_V2|RECONCILE_V2|SHOPIFY_FULFILLMENT_PUSH_ENABLED"
```

**Expected:** no output (Heroku only shows env vars that are explicitly set; absence = unset = default OFF).

If the command returns rows, set each flag back to false (or unset) before proceeding.

- [ ] All 7 flags OFF (command returned no output)

### 1.4 Backfills — run in order

#### 1.4.1 Deduplicate OMS orders

```powershell
heroku run -a cardshellz-echelon -- "npx tsx scripts/dedup-oms-orders-duplicate-external-order-number.ts --dry-run"
```

Review the dry-run output. **The expected pattern:** ~470 duplicate groups exist (pre-fix data from before C39 normalized webhook ingest to numeric format). The dedup script may report errors due to a unique constraint on `oms_order_lines (order_id, external_line_id)` — that's expected.

If the dry-run shows the duplicates pattern documented in `memory/2026-04-27.md`, run the manual SQL cleanup (from that memory note) instead of `--execute`. The dedup script's auto-reassign logic does not handle the case where doomed rows have lines that conflict with kept rows' lines.

After cleanup, verify:

```sql
-- In your DB client
SELECT COUNT(*) AS remaining_dupe_pairs
FROM oms.oms_orders a
JOIN oms.oms_orders b
  ON a.channel_id = b.channel_id
  AND a.external_order_number = b.external_order_number
  AND a.id != b.id;
-- Expect 0
```

- [ ] Dedup completed, remaining_dupe_pairs = 0

#### 1.4.2 Backfill WMS↔OMS link

```powershell
# DRY-RUN first (defaults to dry-run if no flag)
heroku run -a cardshellz-echelon -- "npx tsx scripts/backfill-wms-oms-link.ts --dry-run"
```

Review the summary. Expect roughly:
- Path A (GID): scanned ~80, matched ~40, orphans ~40
- Path B (external_order_number): scanned ~54k, matched ~20k, orphans ~34k

Then execute:

```powershell
heroku run -a cardshellz-echelon -- "npx tsx scripts/backfill-wms-oms-link.ts --execute"
```

- [ ] WMS↔OMS link backfill completed
- [ ] Total updated: ~20k (matches dry-run)

### 1.5 Constraint verification + apply migration 065

#### 1.5.1 Apply migration 065 (only after 1.4.1 dedup is clean)

In your DB client, run as a **separate query** (not inside a transaction — `CONCURRENTLY` cannot run inside a tx). If your client auto-wraps in transactions, either disable auto-commit OR drop the `CONCURRENTLY` keyword (the table is small enough that the brief lock is fine):

```sql
-- Preferred (no table lock):
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_oms_orders_channel_external
  ON oms.oms_orders (channel_id, external_order_number)
  WHERE external_order_number IS NOT NULL;

-- Fallback if your client wraps queries in transactions:
CREATE UNIQUE INDEX IF NOT EXISTS uniq_oms_orders_channel_external
  ON oms.oms_orders (channel_id, external_order_number)
  WHERE external_order_number IS NOT NULL;
```

Then record the migration as applied:

```sql
INSERT INTO public._migrations (filename, content_hash)
VALUES ('065_oms_orders_unique_channel_external_order_number.sql', 'manual')
ON CONFLICT DO NOTHING;
```

#### 1.5.2 Verify both constraints

```sql
-- Migration 064 — NOT VALID constraint check
SELECT conname, convalidated
FROM pg_constraint
WHERE conname = 'chk_oms_fulfillment_order_id_not_null';
-- Expect 1 row, convalidated = false (NOT VALID; correct)

-- Migration 065 — unique index check
SELECT indexname
FROM pg_indexes
WHERE indexname = 'uniq_oms_orders_channel_external';
-- Expect 1 row
```

- [ ] Migration 064 (NOT VALID constraint) verified
- [ ] Migration 065 (unique index) applied and verified

---

## 2. Parity check — deferred until step 3.3 has been on for 1 hour

The parity check compares Shopify-native ShipStation push payloads against Echelon-equivalent payloads for recent orders.

**Why this can’t run pre-flag:** the script's first lookup expects a `wms.outbound_shipments` row keyed to `wms.orders.oms_fulfillment_order_id`. Pre-flag, those rows don’t exist for orders pushed by the parallel Shopify-native ShipStation feed (only inbound `processShopifyFulfillment` writes legacy rows, and those aren't in scope). The script will report `skipped: no_wms_shipment` for every order checked.

**Real parity-able data only exists AFTER:**

1. `WMS_SHIPMENT_AT_SYNC=true` (step 3.1) — starts creating shipment rows for new orders, AND
2. `PUSH_FROM_WMS=true` (step 3.3) — makes Echelon push fire and stamp `shipstation_order_id` on those shipments.

Once step 3.3 has been on for ~1 hour and a handful of orders have flowed through both Shopify-native ShipStation and Echelon-pushed ShipStation, run the parity check (see step 3.3.A below). **Do not block the flag-flip sequence on running it pre-flag — it will report all-skipped and tell you nothing.**

---

## 3. Flag-flip sequence

**One flag at a time.** Each flag change triggers a Heroku dyno restart. Wait for dyno health checks to pass before monitoring.

**General pattern for each flip:**

```powershell
heroku config:set FLAG_NAME=true -a cardshellz-echelon
# Wait for dyno restart (~30s)
heroku ps -a cardshellz-echelon  # verify dynos are "up"
# Monitor for the specified window (see each flag below)
# If issues: heroku config:set FLAG_NAME=false -a cardshellz-echelon
```

---

### 3.1 `WMS_SHIPMENT_AT_SYNC=true` (Commit 8)

**Why first:** Creates `wms.outbound_shipments` rows at sync time. Nothing reads from this table yet — purely additive. Zero risk to existing flows.

```powershell
heroku config:set WMS_SHIPMENT_AT_SYNC=true -a cardshellz-echelon
```

**What to watch:**
- `metric=wms_shipment_created` — rows should be created for new orders
- No `CRITICAL:` log lines

**Live tail:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String -Pattern "metric=wms_shipment_created|CRITICAL:"
```

**Monitoring window:** 1 hour (light monitoring is fine — this flag is very safe)

**Rollback:**
```powershell
heroku config:set WMS_SHIPMENT_AT_SYNC=false -a cardshellz-echelon
```

- [ ] Flag ON, dynos healthy, no errors for 1h

---

### 3.2 `WMS_FINANCIAL_SNAPSHOT=true` (Commit 7)

**Why second:** Populates new financial columns (`total_cents`, `tax_cents`, etc.) on `wms.orders`. Still no read side consumes these — purely additive.

```powershell
heroku config:set WMS_FINANCIAL_SNAPSHOT=true -a cardshellz-echelon
```

**What to watch:**
- New orders should have `wms.orders.total_cents > 0` (verify in DB client)
- `metric=wms_financial_snapshot_*` events
- No `CRITICAL:` log lines

**Live tail:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String -Pattern "metric=wms_financial_snapshot|wms_sync_validation_failed|CRITICAL:"
```

**Verify in DB client:**
```sql
-- Recent orders should have non-zero financials
SELECT id, order_number, total_cents, currency, created_at
FROM wms.orders
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC
LIMIT 10;
```

**Monitoring window:** 1 hour

**Rollback:**
```powershell
heroku config:set WMS_FINANCIAL_SNAPSHOT=false -a cardshellz-echelon
```
Existing rows with populated values are unaffected (they have `0` defaults otherwise).

- [ ] Flag ON, dynos healthy, new orders have financial data for 1h

---

### 3.3 `PUSH_FROM_WMS=true` (Commit 12)

**Why third:** Now ShipStation push reads from WMS instead of OMS. This is the first flag that changes **behavior** — push payloads now come from the WMS data model.

```powershell
heroku config:set PUSH_FROM_WMS=true -a cardshellz-echelon
```

**What to watch:**
- `metric=ss_push_succeeded` rate steady or higher
- `metric=ss_push_rejected` — should be near zero
- `SS_PUSH_INVALID_SHIPMENT` log entries — should be zero
- Push success rate matches pre-flag baseline

**Live tail:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String -Pattern "metric=ss_push_|SS_PUSH_INVALID_SHIPMENT|CRITICAL:"
```

**Monitoring window:** **24 hours minimum**

**Rollback:**
```powershell
heroku config:set PUSH_FROM_WMS=false -a cardshellz-echelon
```
Legacy `pushOrder` path reactivates immediately on next request.

- [ ] Flag ON, zero rejected pushes, zero `SS_PUSH_INVALID_SHIPMENT` for 24h

#### 3.3.A Parity check — the actual run point

After `PUSH_FROM_WMS=true` has been on for ~1 hour AND at least 5–10 new orders have flowed through:

```powershell
# Replace <FLIP_TS_UTC> with the exact UTC timestamp PUSH_FROM_WMS=true was set.
# Without --since the script falls back to a 14-day window that will sweep in pre-flag
# orders pushed by Shopify-native ShipStation; those will all diverge by design and
# tell you nothing about whether the new code is correct.
heroku run -a cardshellz-echelon -- "npx tsx scripts/parity-check-push.ts --limit 50 --since <FLIP_TS_UTC>"
```

Example for a flip at 2026-04-29 19:01 EST (= 2026-04-29 23:01 UTC):
```powershell
heroku run -a cardshellz-echelon -- "npx tsx scripts/parity-check-push.ts --limit 50 --since 2026-04-29T23:01:00Z"
```

**Requirements:**
- Exit code 0 (no real divergences)
- Zero `diverge` outcomes in the report
- `ok + address_only > 0` (otherwise the script ran against pre-flag data and produced no useful comparison; wait longer or pass `--since <flip-timestamp>`)
- `address_only` outcomes are acceptable — they represent USPS CASS address standardization differences (case, street suffix abbreviation, ZIP+4, city truncation) between ShipStation's CASS-validated addresses and Echelon's literal customer-entry addresses. Both are correct; the difference is cosmetic, not a data integrity issue.
- Use `--strict` if you want to treat `address_only` as `diverge` (legacy behavior). Not recommended for normal parity runs.

**Run it twice with at least 1 hour between runs.** Both must be exit code 0 with `ok + address_only > 0`.

| Run | Timestamp (UTC) | Exit code | OK count | Address-only | Diverge count | Notes |
|-----|-----------------|-----------|----------|-------------|---------------|-------|
| 1   |                 |           |          |             |               |       |
| 2   |                 |           |          |             |               |       |

- [ ] Parity check passed twice with zero divergences and ok + address_only > 0

**If divergences appear:** roll back `PUSH_FROM_WMS=false`, paste the per-order diff, fix the root cause before re-flipping.

---

### 3.4 `SHIP_NOTIFY_V2=true` (Commit 15)

**Why fourth:** SHIP_NOTIFY handler routes to the new shipment-centric v2 path. Supports multi-shipment, void, re-label, address-change, mid-flight cancel-after-label.

```powershell
heroku config:set SHIP_NOTIFY_V2=true -a cardshellz-echelon
```

**What to watch:**
- `wms.outbound_shipments` status transitions correct
- No orphan SHIP_NOTIFY entries in the DLQ
- `metric=ss_ship_notify_processed` climbing
- `CRITICAL: ship_notify` — should be zero

**Live tail:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String -Pattern "metric=ss_ship_notify|ss_ship_notify_dead_letter|CRITICAL:"
```

**Verify DLQ in DB client:**
```sql
SELECT provider, topic, status, COUNT(*) AS rows
FROM oms.webhook_retry_queue
WHERE provider = 'shipstation' AND topic = 'SHIP_NOTIFY'
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY provider, topic, status;
-- pending+dead should be zero or near-zero
```

**Monitoring window:** **24 hours minimum**

**Rollback:**
```powershell
heroku config:set SHIP_NOTIFY_V2=false -a cardshellz-echelon
```
Legacy `processShipNotify` path still exists and reactivates.

- [ ] Flag ON, shipment transitions correct, no DLQ entries for 24h

---

### 3.5 `RECONCILE_V2=true` (Commit 35)

**Why fifth:** Hourly reconcile now reads from `wms.outbound_shipments` instead of the legacy path.

```powershell
heroku config:set RECONCILE_V2=true -a cardshellz-echelon
```

**What to watch:**
- `metric=ss_reconcile_v2_divergence` — should be zero
- Reconcile job should complete within its cron window
- `CRITICAL: reconcile` — should be zero

**Live tail:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String -Pattern "metric=ss_reconcile_v2|CRITICAL:"
```

**Monitoring window:** **24 hours minimum**

**Rollback:**
```powershell
heroku config:set RECONCILE_V2=false -a cardshellz-echelon
```
Legacy hourly reconcile reactivates.

- [ ] Flag ON, zero divergences for 24h

---

### 3.6 `INBOUND_RECONCILE_V2=true` (Commits 27–30)

**Why sixth:** Activates the Shopify → OMS → WMS → SS inbound reconciliation cascade (fulfillments, orders, refunds).

```powershell
heroku config:set INBOUND_RECONCILE_V2=true -a cardshellz-echelon
```

**What to watch:**
- `metric=shopify_webhook_retry_processed` — climbing
- `metric=shopify_webhook_dlq_dead_letter` — should be zero or near-zero
- `CRITICAL: inbound_reconcile` — should be zero

**Live tail:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String -Pattern "metric=shopify_webhook|CRITICAL:"
```

**Monitoring window:** **24 hours minimum**

**Rollback:**
```powershell
heroku config:set INBOUND_RECONCILE_V2=false -a cardshellz-echelon
```
Shopify webhooks revert to legacy no-op paths.

- [ ] Flag ON, processed count climbing, errors near-zero for 24h

---

### 3.7 `SHOPIFY_FULFILLMENT_PUSH_ENABLED=true` (Commits 22–25)

**Why last:** This is the big one — Echelon starts pushing fulfillments to Shopify. Shopify-native ShipStation is still running in parallel as a safety net.

```powershell
heroku config:set SHOPIFY_FULFILLMENT_PUSH_ENABLED=true -a cardshellz-echelon
```

**What to watch:**
- `metric=shopify_push_succeeded` — climbing
- `metric=shopify_push_failed` — trending to zero
- `metric=shopify_push_dead_letter` — DLQ should be empty
- `CRITICAL: Shopify Fulfillment Push Dead-Lettered` — should be zero
- Customer-facing: tracking emails arriving as expected

**Live tail:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String -Pattern "metric=shopify_push|CRITICAL:"
```

**Verify DLQ in DB client:**
```sql
SELECT topic, status, COUNT(*) AS rows
FROM oms.webhook_retry_queue
WHERE provider = 'internal' AND topic = 'shopify_fulfillment_push'
  AND created_at > NOW() - INTERVAL '48 hours'
GROUP BY topic, status;
-- pending+dead should be zero or near-zero
```

**Monitoring window:** **48 hours minimum** before proceeding to final cutover

**Rollback:**
```powershell
heroku config:set SHOPIFY_FULFILLMENT_PUSH_ENABLED=false -a cardshellz-echelon
```
Shopify-native SS feed is still running in parallel, catches any unfulfilled orders.

- [ ] Flag ON, push success rate >99%, DLQ empty for 48h

---

### Timing summary

| Flag | Min monitoring | Cumulative |
|------|---------------|------------|
| WMS_SHIPMENT_AT_SYNC | 1h | Day 1 |
| WMS_FINANCIAL_SNAPSHOT | 1h | Day 1 |
| PUSH_FROM_WMS | 24h | Day 2 |
| SHIP_NOTIFY_V2 | 24h | Day 3 |
| RECONCILE_V2 | 24h | Day 4 |
| INBOUND_RECONCILE_V2 | 24h | Day 5 |
| SHOPIFY_FULFILLMENT_PUSH_ENABLED | 48h | Day 7 |

**Estimated total: ~7 days** from first flag flip to ready for final cutover.

---

## 4. Final cutover: disconnect Shopify-native ShipStation

**Prerequisites:**
- [ ] `SHOPIFY_FULFILLMENT_PUSH_ENABLED` has been ON for at least 48 hours
- [ ] Zero `CRITICAL: Shopify Fulfillment Push Dead-Lettered` log entries in the monitoring window
- [ ] `metric=shopify_push_dead_letter` is empty
- [ ] Final parity check passes (run `parity-check-push.ts` one more time)

### 4.1 Disconnect in Shopify admin

1. Log in to Shopify admin
2. Navigate to **Apps** → **ShipStation**
3. Click **Uninstall** (or **Pause** if you want a reversible option)
4. Confirm the uninstall

### 4.2 Post-disconnect monitoring

Monitor for **24 hours** after disconnect:

- [ ] No customer complaints about missing tracking emails
- [ ] Fulfillment push success rate remains >99%
- [ ] No `CRITICAL:` log entries
- [ ] DLQ remains empty
- [ ] Order throughput matches prior baseline (Echelon's SS volume ≈ prior combined volume)

### 4.3 Sign-off

- [ ] 24h post-cutover monitoring complete
- [ ] Overlord sign-off received
- [ ] `memory/YYYY-MM-DD.md` updated with cutover completion

---

## 5. Rollback procedure

Each flag can be rolled back independently. The system is designed so that flipping a flag OFF reactivates the legacy code path for that component.

### Per-flag rollback

| Flag | Rollback command (PowerShell) | State after rollback |
|------|-------------------------------|---------------------|
| `WMS_SHIPMENT_AT_SYNC` | `heroku config:set WMS_SHIPMENT_AT_SYNC=false -a cardshellz-echelon` | New orders stop getting `outbound_shipments` rows. Existing rows harmless. |
| `WMS_FINANCIAL_SNAPSHOT` | `heroku config:set WMS_FINANCIAL_SNAPSHOT=false -a cardshellz-echelon` | New orders get `0` defaults on financial columns. Existing populated rows unaffected. |
| `PUSH_FROM_WMS` | `heroku config:set PUSH_FROM_WMS=false -a cardshellz-echelon` | Push reverts to legacy OMS-based `pushOrder`. Immediate effect on next push. |
| `SHIP_NOTIFY_V2` | `heroku config:set SHIP_NOTIFY_V2=false -a cardshellz-echelon` | SHIP_NOTIFY reverts to legacy `processShipNotify`. Shipment rows in WMS are harmless if unused. |
| `RECONCILE_V2` | `heroku config:set RECONCILE_V2=false -a cardshellz-echelon` | Hourly reconcile reverts to legacy path. |
| `INBOUND_RECONCILE_V2` | `heroku config:set INBOUND_RECONCILE_V2=false -a cardshellz-echelon` | Shopify webhooks revert to legacy no-op paths (known buggy but stable). |
| `SHOPIFY_FULFILLMENT_PUSH_ENABLED` | `heroku config:set SHOPIFY_FULFILLMENT_PUSH_ENABLED=false -a cardshellz-echelon` | Echelon stops pushing fulfillments. Shopify-native SS (if still installed) catches orders. |

**Customer impact: minimal** for flags 1–6. The system reverts to the behavior that was working before the flag was on.

For flag 7 (Shopify fulfillment push), if you roll back AFTER disconnecting Shopify-native SS:
- **Immediately re-enable** the Shopify ShipStation app
- Monitor for any orders that missed fulfillment during the gap

### Emergency full rollback

If everything goes wrong:

```powershell
# 1. Flip ALL flags off (one command, multiple values)
heroku config:set `
  WMS_SHIPMENT_AT_SYNC=false `
  WMS_FINANCIAL_SNAPSHOT=false `
  PUSH_FROM_WMS=false `
  SHIP_NOTIFY_V2=false `
  RECONCILE_V2=false `
  INBOUND_RECONCILE_V2=false `
  SHOPIFY_FULFILLMENT_PUSH_ENABLED=false `
  -a cardshellz-echelon

# 2. Re-enable Shopify ShipStation app (if disconnected)

# 3. Monitor DLQ — clear any stuck entries if needed (in DB client)
```

(The backtick `` ` `` is PowerShell's line-continuation character.)

### Customer communication template

If customers are affected (e.g., tracking delays):

> Subject: Tracking update delayed for your recent order
>
> Hi [Name],
>
> We're investigating a brief delay in tracking updates for orders placed in the last [X] hours. Your order is being processed normally — you'll receive tracking information shortly.
>
> If you have questions, reply to this email.
>
> — Cardshellz Team

---

## 6. Common issues + remediation

### 6.1 Shopify push dead-letter spike

**Symptom:** `metric=shopify_push_dead_letter` count increasing.

**Investigation:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String "metric=shopify_push_dead_letter"
```

**Common causes:**
- Shopify API rate limit (429) → retries should handle; check if retries are exhausted
- Invalid fulfillment payload (missing tracking number, bad line item) → check the dead-letter entry for the specific order
- Shopify store permissions changed → verify app scopes in Shopify admin

**Remediation:**
- If rate limit: monitor — it should self-resolve via retry
- If bad payload: fix the specific order data, re-trigger push manually
- If permissions: restore app scopes, re-trigger pushes

### 6.2 WMS sync validation failures

**Symptom:** `metric=wms_sync_validation_failed` increasing.

**Investigation:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String "metric=wms_sync_validation_failed"
```

**Common causes:**
- Upstream OMS order is malformed (missing required fields) → check the specific order in OMS
- Shopify webhook delivered partial data → check Shopify webhook delivery status
- Race condition between OMS creation and WMS sync → typically self-resolves on retry

**Remediation:**
- Check the specific order data in the OMS / WMS tables
- If malformed: fix the upstream data, re-trigger sync
- If race condition: the retry mechanism should handle it

### 6.3 SS reconcile divergences

**Symptom:** `metric=ss_reconcile_v2_divergence` increasing.

**Investigation:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String "metric=ss_reconcile_v2_divergence"
```

**Common causes:**
- Status mismatch between WMS `outbound_shipments` and ShipStation → check the specific shipment IDs in the log entry
- Manual change in ShipStation (label re-printed, address changed outside Echelon) → expected divergence, reconcile should update WMS
- SHIP_NOTIFY not received for a shipped order → check ShipStation webhook delivery

**Remediation:**
- Review specific shipment IDs from the divergence log
- If manual SS change: reconcile should auto-correct WMS
- If missing SHIP_NOTIFY: check ShipStation webhook config, manually trigger if needed

### 6.4 Push rejection spike

**Symptom:** `ss_push_rejected` increasing, `SS_PUSH_INVALID_SHIPMENT` events.

**Investigation:**
```powershell
heroku logs --tail -a cardshellz-echelon | Select-String "SS_PUSH_INVALID_SHIPMENT"
```

**Common causes:**
- WMS order missing shipping address (edge case for certain order types) → check the specific order
- Combined-orders link missing → check `wms.outbound_shipments` for `combined_role`
- ShipStation API schema change → check ShipStation API docs

**Remediation:**
- If missing address: investigate the order source, fix if possible
- If combined-orders: verify the link was created at order creation
- If API change: may need a code fix — pause push flag and investigate

---

## Appendix A: Log monitoring cheat sheet (PowerShell)

```powershell
# Live stream all relevant metrics
heroku logs --tail -a cardshellz-echelon | Select-String -Pattern "metric=|CRITICAL:"

# Specific metric streams
heroku logs --tail -a cardshellz-echelon | Select-String "metric=shopify_push_dead_letter"
heroku logs --tail -a cardshellz-echelon | Select-String "metric=wms_sync_validation_failed"
heroku logs --tail -a cardshellz-echelon | Select-String "metric=ss_reconcile_v2_divergence"
heroku logs --tail -a cardshellz-echelon | Select-String "SS_PUSH_INVALID_SHIPMENT"
heroku logs --tail -a cardshellz-echelon | Select-String "CRITICAL:"

# Check dyno health
heroku ps -a cardshellz-echelon

# Quick config check (all 7 cutover flags at once)
heroku config -a cardshellz-echelon | Select-String -Pattern "WMS_FINANCIAL_SNAPSHOT|WMS_SHIPMENT_AT_SYNC|PUSH_FROM_WMS|SHIP_NOTIFY_V2|INBOUND_RECONCILE_V2|RECONCILE_V2|SHOPIFY_FULFILLMENT_PUSH_ENABLED"
```

---

## Appendix B: Heroku CLI quirks worth knowing

1. **`heroku run` with flags requires the quoted form:**
   ```powershell
   # WRONG — Heroku CLI eats the --execute flag:
   heroku run npx tsx scripts/foo.ts --execute -a cardshellz-echelon

   # RIGHT — quoted command, Heroku passes it through verbatim:
   heroku run -a cardshellz-echelon -- "npx tsx scripts/foo.ts --execute"
   ```

2. **`heroku pg:psql` requires `psql` installed locally** — if you don't have psql, run SQL via your DB GUI client instead. All SQL examples in this runbook are written to copy-paste into a GUI.

3. **PowerShell line continuation is backtick `` ` ``** (not `\`). The emergency rollback in §5 uses this for the multi-flag `config:set`.

4. **`-a cardshellz-echelon`** must be on every Heroku command if you don't have it set as a default app. Some PowerShell users `cd` into the repo directory and Heroku auto-detects the app from `.git/config` — but the `-a` flag is always safe.
