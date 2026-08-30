# Historical ShipStation Contents System Recovery

## Purpose

This command repairs only historical label evidence whose exact package contents
can be proven deterministically from current ShipStation data. It appends one
immutable `contents_recovered` event through
`HistoricalShipStationContentsSystemRecoveryService`; it does not write package
allocations, post inventory, fulfill orders, call a marketplace mutation, or
replace the Operations Control Tower.

The accepted evidence statuses are deliberately limited to:

- `provider_line_keys_authoritative`: ShipStation returned exact recognized WMS
  shipment-item identities and positive quantities.
- `exact_unique_wms_match`: ShipStation returned unrecognized product rows whose
  SKU/quantity multiset matches one exact linked WMS package.

Empty, omitted, malformed, mixed, ambiguous, conflicting, missing, or failed
provider evidence remains unresolved and review-only.

## Safety contract

The runner is manual and unscheduled. It has four independent boundaries:

1. A hard limit of 25 candidates per invocation; the default is 10.
2. Preview is the default and never constructs a write pool.
3. Apply requires the SHA-256 `previewToken` produced by the exact same bounded
   page. The runner re-audits the page and attempts no writes if the token changed.
4. Apply additionally requires both
   `HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_ENABLED=true` and a dedicated
   `HISTORICAL_SHIPSTATION_CONTENTS_SYSTEM_RECOVERY_DATABASE_URL`. It never falls
   back to `DATABASE_URL` or `EXTERNAL_DATABASE_URL`.

Each label's recovery service also compares the exact per-label provider evidence
hash from the preview against its second ShipStation GET immediately before the
database transaction. A provider change in that final gap prevents that label's
write with `PROVIDER_EVIDENCE_CHANGED`.

The read side continues to require
`HISTORICAL_SHIPSTATION_CONTENTS_AUDIT_ENABLED=true` and
`WMS_INTEGRITY_AUDIT_DATABASE_URL`. Remote URLs must use the repository's verified
TLS contract.

## Preview

```sh
npm run wms:recover-historical-shipstation-contents -- --limit=10
```

Use `--before-label-id=ID` with the same limit to preview a later page. Save the
complete JSON result. It contains aggregate evidence, bounded internal label IDs,
and cryptographic hashes, but no provider shipment IDs, tracking numbers, SKUs,
quantities, or raw payloads.

## Apply the exact preview

```sh
npm run wms:recover-historical-shipstation-contents -- \
  --apply \
  --preview-token=THE_64_CHARACTER_PREVIEW_TOKEN \
  --limit=10
```

Repeat the exact `--before-label-id` value from preview when applying a paginated
page. A different limit or cursor produces a different page and cannot reuse the
token.

Apply processes recoverable labels sequentially. Each label is independently
serialized and transactional. One per-label failure does not hide earlier
committed recoveries: the JSON result reports `created`, `already_persisted`, or a
sanitized failure code for every attempted internal label ID, and the process
exits nonzero when any label failed.

## Verification and stop conditions

After apply, rerun preview with the same page boundary. Successfully recovered
labels no longer qualify because they now have authoritative V2 content evidence.

Stop without retrying blindly when:

- `PREVIEW_TOKEN_MISMATCH` appears: evidence changed after preview and zero writes
  were attempted.
- a candidate reports `CANDIDATE_CHANGED`: its locked database evidence changed
  before persistence.
- a database/concurrency/cleanup code appears: inspect the specific run before
  deciding whether an idempotent retry is appropriate.
- provider evidence is no longer recoverable: leave the label unresolved for the
  existing operational exception flow.
