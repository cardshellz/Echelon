# Cutover Runbook — ShipStation/OMS/WMS Refactor

**Last updated:** 2026-04-26
**Plan reference:** `shipstation-flow-refactor-plan.md` §10 Rollout Strategy
**Branch:** `refactor/ss-wms-oms`

This runbook covers the operational steps to safely flip feature flags for the ShipStation flow refactor, from the current all-flags-OFF state through full cutover (Shopify-native ShipStation disconnected).

**Do not rush.** Each flag flip is a discrete step. Monitor between every flip.

---

## 1. Pre-flight checklist

Complete **all** items before starting the flag-flip sequence.

### 1.1 Deployment verification

- [ ] All commits C1–C37 deployed to `main` on GitHub
- [ ] Heroku auto-deploy is green (no failed deploys in Activity tab)
- [ ] Production database accessible: `heroku run psql $DATABASE_URL -c "SELECT 1"`

### 1.2 Migration verification

Run from Heroku console:

```bash
heroku run psql $DATABASE_URL -c "
  SELECT version, name FROM _migrations
  WHERE version BETWEEN 058 AND 066
  ORDER BY version;
"
```

Expected: rows for migrations 058 through 066, all applied.

- [ ] Migrations 058–066 applied
- [ ] Reverse migrations (if any) verified as not present

### 1.3 Feature flags — all OFF

```bash
heroku config | grep -E "WMS_FINANCIAL_SNAPSHOT|WMS_SHIPMENT_AT_SYNC|PUSH_FROM_WMS|SHIP_NOTIFY_V2|INBOUND_RECONCILE_V2|RECONCILE_V2|SHOPIFY_FULFILLMENT_PUSH_ENABLED"
```

All 7 flags must be `false` or unset.

- [ ] All flags OFF

### 1.4 Backfills — run in order

```bash
# 1. Deduplicate OMS orders with duplicate external_order_number
heroku run npx tsx scripts/dedup-oms-orders-duplicate-external-order-number.ts --execute

# 2. Backfill WMS↔OMS link (handles both GID + external_order_number paths)
heroku run npx tsx scripts/backfill-wms-oms-link.ts --execute
```

- [ ] Dedup backfill completed with zero unresolvable duplicates
- [ ] WMS↔OMS link backfill completed

### 1.5 Constraint verification

```bash
# Migration 064 — NOT VALID constraint (exempts legacy orphans)
heroku run psql $DATABASE_URL -c "
  SELECT conname, convalidated FROM pg_constraint
  WHERE conname LIKE '%wms_orders%oms_order_id%';
"
# Expect convalidated = false (NOT VALID; this is correct)

# Migration 065 — unique index (only after dedup)
heroku run psql $DATABASE_URL -c "
  SELECT indexname FROM pg_indexes
  WHERE indexname LIKE '%wms_orders%oms_order_id%unique%';
"
# Expect the index to exist
```

- [ ] Migration 064 (NOT VALID constraint) applied
- [ ] Migration 065 (unique index) applied

---

## 2. Parity check — must pass twice

The parity check compares Shopify-native ShipStation push payloads against Echelon-equivalent payloads for recent orders.

### 2.1 Run the check

```bash
heroku run npx tsx scripts/parity-check-push.ts --limit 50
```

**Requirements:**
- Exit code 0 (no divergences)
- Zero `diverge` outcomes in the report

### 2.2 Run it twice

- First run: record timestamp + result
- Wait at least **1 hour** (to capture new orders flowing through)
- Second run: record timestamp + result
- Both runs must be exit code 0

### 2.3 Document results

| Run | Timestamp (UTC) | Exit code | Divergences | Notes |
|-----|-----------------|-----------|-------------|-------|
| 1   |                 |           |             |       |
| 2   |                 |           |             |       |

- [ ] Parity check passed twice with zero divergences

---

## 3. Flag-flip sequence

**One flag at a time.** Each flag change triggers a Heroku dyno restart. Wait for dyno health checks to pass before monitoring.

**General pattern for each flip:**

```bash
heroku config:set FLAG_NAME=true
# Wait for dyno restart (~30s)
heroku ps  # verify dynos are "up"
# Monitor for the specified window
# If issues: heroku config:set FLAG_NAME=false
```

---

### 3.1 `WMS_SHIPMENT_AT_SYNC=true` (Commit 8)

**Why first:** Creates `wms.outbound_shipments` rows at sync time. Nothing reads from this table yet — purely additive. Zero risk to existing flows.

```bash
heroku config:set WMS_SHIPMENT_AT_SYNC=true
```

**What to watch:**
- `metric=wms_shipment_at_sync` — rows should be created for new orders
- No `CRITICAL:` log lines

**Monitoring window:** 1 hour (light monitoring is fine — this flag is very safe)

**Rollback:**
```bash
heroku config:set WMS_SHIPMENT_AT_SYNC=false
```

- [ ] Flag ON, dynos healthy, no errors for 1h

---

### 3.2 `WMS_FINANCIAL_SNAPSHOT=true` (Commit 7)

**Why second:** Populates new financial columns (`total_cents`, `tax_cents`, etc.) on `wms.orders`. Still no read side consumes these — purely additive.

```bash
heroku config:set WMS_FINANCIAL_SNAPSHOT=true
```

**What to watch:**
- New orders should have `wms.orders.total_cents > 0`
- `metric=wms_financial_snapshot` — successful writes
- No `CRITICAL:` log lines

**Monitoring window:** 1 hour

**Rollback:**
```bash
heroku config:set WMS_FINANCIAL_SNAPSHOT=false
```
Existing rows with populated values are unaffected (they have `0` defaults otherwise).

- [ ] Flag ON, dynos healthy, new orders have financial data for 1h

---

### 3.3 `PUSH_FROM_WMS=true` (Commit 12)

**Why third:** Now ShipStation push reads from WMS instead of OMS. This is the first flag that changes **behavior** — push payloads now come from the WMS data model.

```bash
heroku config:set PUSH_FROM_WMS=true
```

**What to watch:**
- `metric=ss_push_rejected_total` — should be zero
- `SS_PUSH_INVALID_SHIPMENT` events in Heroku logs — should be zero
- Push success rate should match pre-flag baseline
- `metric=push_from_wms` entries in structured logs

**Monitoring window:** **24 hours minimum**

**Rollback:**
```bash
heroku config:set PUSH_FROM_WMS=false
```
Legacy `pushOrder` path reactivates immediately on next request.

- [ ] Flag ON, zero rejected pushes, zero `SS_PUSH_INVALID_SHIPMENT` for 24h

---

### 3.4 `SHIP_NOTIFY_V2=true` (Commit 15)

**Why fourth:** SHIP_NOTIFY handler routes to the new shipment-centric v2 path. Supports multi-shipment, void, re-label, address-change, mid-flight cancel-after-label.

```bash
heroku config:set SHIP_NOTIFY_V2=true
```

**What to watch:**
- `wms.outbound_shipments` status transitions should be correct
- No orphan SHIP_NOTIFY entries in the DLQ
- `metric=ship_notify_v2` — processed count climbing
- `CRITICAL: ship_notify` — should be zero

**Monitoring window:** **24 hours minimum**

**Rollback:**
```bash
heroku config:set SHIP_NOTIFY_V2=false
```
Legacy `processShipNotify` path still exists and reactivates.

- [ ] Flag ON, shipment transitions correct, no DLQ entries for 24h

---

### 3.5 `RECONCILE_V2=true` (Commit 35)

**Why fifth:** Hourly reconcile now reads from `wms.outbound_shipments` instead of the legacy path.

```bash
heroku config:set RECONCILE_V2=true
```

**What to watch:**
- `metric=ss_reconcile_v2_divergence` — should be zero
- Reconcile job should complete within its cron window
- `CRITICAL: reconcile` — should be zero

**Monitoring window:** **24 hours minimum**

**Rollback:**
```bash
heroku config:set RECONCILE_V2=false
```
Legacy hourly reconcile reactivates.

- [ ] Flag ON, zero divergences for 24h

---

### 3.6 `INBOUND_RECONCILE_V2=true` (Commits 27–30)

**Why sixth:** Activates the Shopify → OMS → WMS → SS inbound reconciliation cascade (fulfillments, orders, refunds).

```bash
heroku config:set INBOUND_RECONCILE_V2=true
```

**What to watch:**
- `metric=inbound_reconcile_processed_total` — climbing
- `metric=inbound_reconcile_error_total` — should be zero or near-zero
- `CRITICAL: inbound_reconcile` — should be zero

**Monitoring window:** **24 hours minimum**

**Rollback:**
```bash
heroku config:set INBOUND_RECONCILE_V2=false
```
Shopify webhooks revert to legacy no-op paths.

- [ ] Flag ON, processed count climbing, errors near-zero for 24h

---

### 3.7 `SHOPIFY_FULFILLMENT_PUSH_ENABLED=true` (Commits 22–25)

**Why last:** This is the big one — Echelon starts pushing fulfillments to Shopify. Shopify-native ShipStation is still running in parallel as a safety net.

```bash
heroku config:set SHOPIFY_FULFILLMENT_PUSH_ENABLED=true
```

**What to watch:**
- `metric=shopify_fulfillment_push_total{status='success'}` — climbing
- `metric=shopify_fulfillment_push_total{status='error'}` — trending to zero
- `metric=shopify_push_dead_letter` — DLQ should be empty
- `CRITICAL: shopify_push` — should be zero
- Customer-facing: tracking emails arriving as expected

**Monitoring window:** **48 hours minimum** before proceeding to final cutover

**Rollback:**
```bash
heroku config:set SHOPIFY_FULFILLMENT_PUSH_ENABLED=false
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
- [ ] Zero `CRITICAL: shopify_push` log entries in the monitoring window
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

| Flag | Rollback command | State after rollback |
|------|-----------------|---------------------|
| `WMS_SHIPMENT_AT_SYNC` | `heroku config:set WMS_SHIPMENT_AT_SYNC=false` | New orders stop getting `outbound_shipments` rows. Existing rows harmless. |
| `WMS_FINANCIAL_SNAPSHOT` | `heroku config:set WMS_FINANCIAL_SNAPSHOT=false` | New orders get `0` defaults on financial columns. Existing populated rows unaffected. |
| `PUSH_FROM_WMS` | `heroku config:set PUSH_FROM_WMS=false` | Push reverts to legacy OMS-based `pushOrder`. Immediate effect on next push. |
| `SHIP_NOTIFY_V2` | `heroku config:set SHIP_NOTIFY_V2=false` | SHIP_NOTIFY reverts to legacy `processShipNotify`. Shipment rows in WMS are harmless if unused. |
| `RECONCILE_V2` | `heroku config:set RECONCILE_V2=false` | Hourly reconcile reverts to legacy path. |
| `INBOUND_RECONCILE_V2` | `heroku config:set INBOUND_RECONCILE_V2=false` | Shopify webhooks revert to legacy no-op paths (known buggy but stable). |
| `SHOPIFY_FULFILLMENT_PUSH_ENABLED` | `heroku config:set SHOPIFY_FULFILLMENT_PUSH_ENABLED=false` | Echelon stops pushing fulfillments. Shopify-native SS (if still installed) catches orders. |

**Customer impact: minimal** for flags 1–6. The system reverts to the behavior that was working before the flag was on.

For flag 7 (Shopify fulfillment push), if you roll back AFTER disconnecting Shopify-native SS:
- **Immediately re-enable** the Shopify ShipStation app
- Monitor for any orders that missed fulfillment during the gap

### Emergency full rollback

If everything goes wrong:

```bash
# 1. Flip ALL flags off
heroku config:set \
  WMS_SHIPMENT_AT_SYNC=false \
  WMS_FINANCIAL_SNAPSHOT=false \
  PUSH_FROM_WMS=false \
  SHIP_NOTIFY_V2=false \
  RECONCILE_V2=false \
  INBOUND_RECONCILE_V2=false \
  SHOPIFY_FULFILLMENT_PUSH_ENABLED=false

# 2. Re-enable Shopify ShipStation app (if disconnected)

# 3. Monitor DLQ — clear any stuck entries if needed
```

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
```bash
heroku logs --tail | grep "metric=shopify_push_dead_letter"
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
```bash
heroku logs --tail | grep "metric=wms_sync_validation_failed"
```

**Common causes:**
- Upstream OMS order is malformed (missing required fields) → check the specific order in OMS
- Shopify webhook delivered partial data → check Shopify webhook delivery status
- Race condition between OMS creation and WMS sync → typically self-resolves on retry

**Remediation:**
- Check the specific order data in the OMS/wms tables
- If malformed: fix the upstream data, re-trigger sync
- If race condition: the retry mechanism should handle it

### 6.3 SS reconcile divergences

**Symptom:** `metric=ss_reconcile_v2_divergence` increasing.

**Investigation:**
```bash
heroku logs --tail | grep "metric=ss_reconcile_v2_divergence"
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

**Symptom:** `ss_push_rejected_total` increasing, `SS_PUSH_INVALID_SHIPMENT` events.

**Investigation:**
```bash
heroku logs --tail | grep "SS_PUSH_INVALID_SHIPMENT"
```

**Common causes:**
- WMS order missing shipping address (edge case for certain order types) → check the specific order
- Combined-orders link missing → check `wms_combined_orders_link` table
- ShipStation API schema change → check ShipStation API docs

**Remediation:**
- If missing address: investigate the order source, fix if possible
- If combined-orders: verify the link was created at order creation
- If API change: may need a code fix — pause push flag and investigate

---

## Appendix: Log monitoring cheat sheet

```bash
# Live stream all relevant metrics
heroku logs --tail | grep -E "metric=|CRITICAL:"

# Specific metric streams
heroku logs --tail | grep "metric=shopify_push_dead_letter"
heroku logs --tail | grep "metric=wms_sync_validation_failed"
heroku logs --tail | grep "metric=ss_reconcile_v2_divergence"
heroku logs --tail | grep "SS_PUSH_INVALID_SHIPMENT"
heroku logs --tail | grep "CRITICAL:"

# Check dyno health
heroku ps

# Quick config check
heroku config | grep -E "WMS_|PUSH_|SHIP_NOTIFY|RECONCILE|SHOPIFY_"
```
