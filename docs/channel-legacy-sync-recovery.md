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

Required evidence: one uniquely attributable failed maintenance stage, the same
account and exact existing resources, complete coverage of the old scopes, no
active sender, and a current claimed Sync revision. Publish, removal, missing or
ambiguous evidence and changed identities retain their existing recovery path.
Old attempts become `superseded_unknown`, preserving their complete before-image;
they are never relabeled as failed, not sent, or successful. A recurring obligation
must commit atomically so a late old effect can be corrected using current values.

Validation will exercise real PostgreSQL migrations and guards, normal saved Sync
execution, rollback, competing owners, replay, unsafe operations, and browser
completion without an acknowledgement dialog. Browser API fixtures do not prove
provider acceptance. Deployment and live acceptance remain separate checks.

ATP calculations, warehouse quantities and Phase 3 are outside this change.
