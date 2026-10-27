# Phase 2: recover retained maintenance through normal Sync

The existing automatic replacement owner refuses legacy attempts with an empty
HTTP journal (`supportsAutomaticEbayReplacement`). The older worker could admit
an existing-resource update and then fail on a provider read before its write
receipts were retained. An empty journal alone proves neither success nor that
nothing was sent.

Normal Sync will use retained stage evidence and a freshly verified provider
identity to recognize repeatable maintenance. The shared replacement policy owns
eligibility; channel adapters translate provider operations and retained stage
records. The existing automatic recovery transaction remains the only writer of
replacement receipts, unknown-state transitions and recurring reconciliation.

Required evidence: one uniquely attributable failed maintenance stage with a
retained provider GET/PUT failure (generic busy/setup errors do not qualify), the same
account and exact existing resources, complete coverage of the old scopes, no
active sender, and a current claimed Sync revision. Publish, removal, missing or
ambiguous evidence and changed identities retain their existing recovery path.
Old attempts become `superseded_unknown`, preserving their complete before-image;
they are never relabeled as failed, not sent, or successful. A recurring obligation
must commit atomically so a late old effect can be corrected using current values.

Validation exercises real PostgreSQL migrations and guards, normal saved Sync
execution, rollback, competing owners, replay, unsafe operations, and browser
completion without an acknowledgement dialog. Browser API fixtures do not prove
provider acceptance. Deployment and live acceptance remain separate checks.

ATP calculations, warehouse quantities and Phase 3 are outside this change.

## Responsibility owners

| Responsibility | Owner |
| --- | --- |
| Decide whether unknown effects can be replaced safely | `supportsCurrentValueReplacement` in inventory planning's shared domain policy |
| Translate eBay HTTP operations | Existing `supportsAutomaticEbayReplacement` adapter |
| Attribute an old eBay stage to retained local evidence | `PostgresEbayLegacyMaintenanceEvidenceReader`; read-only, on the recovery transaction |
| Fence scopes, preserve receipts and unknown outcomes, retain reconciliation | Existing `PostgresEbayAutomaticPublicationRecoveryRepository.recover`; no new writer |
| Recheck current identity and send current listing content | Existing saved Sync execution and listing connector |
| Detect and correct a late old effect | Existing recurring publication reconciliation owner |
| Display saved progress and completion | Existing saved Sync status UI; no alternate recovery endpoint or automatic operator acknowledgement |

The migration adds one immutable receipt field and an independent database guard.
The historical eBay table names remain compatible; channel-neutral eligibility
does not require renaming those ledgers or adding another automatic writer.

## Validation and limits

- Four affected PostgreSQL suites passed 147 cases before final hardening; the
  saved-Sync suite then passed all 38 cases with the final diagnostic gate,
  including three additional cases. This covers 150 distinct regression cases.
- Twenty shared-policy/operation-classification unit cases passed.
- All 413 repository guard checks passed, including migration and writer ownership.
- Application and server-test typechecks passed.
- The complete desktop/mobile recovery browser suite passed 185 of 186 cases.
  The first desktop page load exceeded its existing 45-second test budget under
  concurrent local validation. That unchanged case passed on desktop and mobile
  when rerun separately. Both new normal-Sync recovery browser cases passed.
- PostgreSQL tests use disposable PostgreSQL 17, production migrations and real
  admission/recovery owners; only provider HTTP is synthetic. Browser API fixtures
  test the UI separately and do not establish live eBay acceptance.

Missing/ambiguous stage evidence, unrelated scopes, changed provider identities,
active senders, publish and removal operations remain blocked. They are not
silently marked successful or treated as not sent. The existing explicit recovery
path remains available for those cases.

No production recovery was executed. A read-only refresh of the historical row
using the locally configured database URL failed TLS hostname verification;
verification was not disabled. Deployment and live normal-Sync acceptance remain
required before declaring the reported production listing recovered.
