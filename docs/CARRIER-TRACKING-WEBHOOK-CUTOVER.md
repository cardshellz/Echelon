# Carrier Tracking Webhook Cutover

## Purpose

Move ShipStation carrier-tracking webhook ownership from Archon to Echelon without
losing Archon's shipment visibility.

After the cutover:

1. ShipStation sends its single `track` webhook to Echelon.
2. Echelon authenticates, stores, normalizes, and reconciles carrier events against
   canonical provider labels.
3. Archon reads Echelon's authenticated carrier-tracking projection on its existing
   Echelon sync schedule.
4. Archon updates package status and derives order status from every active,
   non-return package. A split order is not marked delivered until all such packages
   are delivered.

The existing Archon webhook route stays deployed during the transition so the
provider subscription can be restored if the Echelon ingress fails.

## Current Production Subscription

- ShipStation event: `track`
- Webhook id: `43350`
- Current URL:
  `https://archon-os-20aa790cd70d.herokuapp.com/api/shipstation/tracking-webhook`
- Target URL:
  `https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/shipping/webhooks/shipstation/track`

Reconfirm this state with a dry run immediately before the cutover. Do not rely on
the values above if ShipStation reports a different webhook id, URL, duplicate
subscription, or custom header.

## Required Configuration

Echelon:

- `SHIPSTATION_V2_API_KEY`
- `SHIPSTATION_TRACKING_WEBHOOK_SECRET`
- `SHIPSTATION_TRACKING_WEBHOOK_URL`
- `INTERNAL_API_KEY`

Archon:

- `ECHELON_API_URL`
- `INTERNAL_API_KEY`, with the same value accepted by Echelon

Do not print either secret in command output or commit it to source control.

## Deployment Sequence

### 1. Deploy Echelon

Deploy the Echelon carrier projection and guarded webhook takeover support. Do not
execute the takeover yet.

Confirm the internal projection rejects an unauthenticated request and accepts an
authenticated request:

```powershell
curl.exe -i `
  "https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/internal/carrier-tracking/packages?limit=1"

curl.exe -i `
  -H "Authorization: Bearer $env:INTERNAL_API_KEY" `
  "https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/internal/carrier-tracking/packages?limit=1"
```

Expected responses are `401` and `200`, respectively.

### 2. Deploy Archon

Deploy the Archon projection consumer. Startup creates the idempotent
`echelon_tracking_projection_backlog` table before the sync scheduler starts.

Wait for one Echelon sync cycle or invoke Archon's existing Echelon sync action.
Verify that the carrier-tracking sync completed:

```sql
SELECT
  id,
  workspace_id,
  source,
  sync_type,
  status,
  records_synced,
  errors,
  started_at,
  completed_at
FROM sync_logs
WHERE source = 'echelon'
  AND sync_type = 'carrier_tracking'
ORDER BY id DESC
LIMIT 10;
```

Check the durable unmatched backlog:

```sql
SELECT
  COUNT(*) FILTER (WHERE resolved_at IS NULL) AS unresolved,
  MIN(first_seen_at) FILTER (WHERE resolved_at IS NULL) AS oldest_unresolved_at,
  MAX(last_seen_at) FILTER (WHERE resolved_at IS NULL) AS newest_unresolved_at
FROM echelon_tracking_projection_backlog;
```

An unresolved row means Echelon has a canonical package that Archon has not yet
imported by tracking number. The next sync retries it; it must not be discarded or
used to invent an Archon shipment.

### 3. Guarded Dry Run

Run from the deployed Echelon release:

```powershell
heroku run "npx tsx scripts/configure-shipstation-tracking-webhook.ts --dry-run --replace-webhook-id=43350 --expected-current-url=https://archon-os-20aa790cd70d.herokuapp.com/api/shipstation/tracking-webhook" -a cardshellz-echelon
```

Expected status: `takeover_planned`.

Stop if the result is `conflict`. The command deliberately refuses to proceed when:

- there is not exactly one `track` webhook;
- the webhook id or current URL differs;
- the existing webhook already has custom headers; or
- the target Echelon URL is not valid HTTPS.

### 4. Execute the In-Place Takeover

This is the production mutation and requires explicit approval after steps 1-3 are
green:

```powershell
heroku run "npx tsx scripts/configure-shipstation-tracking-webhook.ts --execute --replace-webhook-id=43350 --expected-current-url=https://archon-os-20aa790cd70d.herokuapp.com/api/shipstation/tracking-webhook" -a cardshellz-echelon
```

Expected status: `taken_over`, with webhook id `43350`. The command uses ShipStation's
in-place update operation, then re-reads the provider state and fails unless the URL,
id, event, and authentication header match exactly.

Rerun the ordinary dry run without takeover flags. Expected status:
`already_configured`.

### 5. End-to-End Verification

Use a newly created test label or the next real package event. Confirm, in order:

1. Echelon stored an authenticated webhook receipt.
2. Echelon stored or hydrated a normalized carrier event.
3. Echelon reconciled the event to exactly one provider label.
4. The Echelon internal projection returns the package.
5. Archon records a completed `carrier_tracking` sync.
6. Archon's package status matches Echelon.
7. For a split order, Archon's order remains in transit until every active,
   non-return package is delivered.

## Failure Handling

- If Echelon rejects or cannot parse a webhook, leave the receipt and hydration
  evidence intact for retry and review.
- If Archon has not imported the package yet, retain the Echelon projection in
  `echelon_tracking_projection_backlog` and retry it after later shipment syncs.
- Do not create an Archon shipment from tracking data alone.
- Do not manually overwrite Echelon canonical carrier state to make Archon agree.
- If ingress fails after takeover, restore webhook `43350` to the documented Archon
  URL in ShipStation and remove the Echelon authentication header. Reconfirm the
  provider state immediately afterward. The Archon route remains deployed for this
  rollback path.

## Follow-Up Removal

Remove Archon's direct ShipStation tracking webhook only after a production soak
shows:

- continuous authenticated Echelon receipts;
- no unexplained reconciliation backlog;
- completed Archon carrier-tracking syncs; and
- no persistent unresolved Archon projection backlog.
