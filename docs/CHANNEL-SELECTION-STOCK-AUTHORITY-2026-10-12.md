# Channel selection owns stock publication

Reviewed base: `0b966a56f673b73860fce843ebd0c9862443ee49` (`origin/main`, fetched October 12, 2026). This document describes the proposed branch implementation, not a production repair or deployment.

## Problem and resulting behavior

The previous live inventory path separately read publication membership. A product selected in its sales channel could therefore be blocked by an old `included=false` inventory decision. The channel/store selection now supplies publication intent to the existing Inventory planner. Historical membership records remain readable audit evidence; the editable membership endpoints return an explanatory 410 and their UI controls are removed.

- Channels owns eBay/Shopify/Walmart selection in `readChannelStockSelection` and `resolveChannelStockSelection` (`server/modules/channels/infrastructure/channel-stock-selection.repository.ts`, `server/modules/channels/channel-stock-selection.domain.ts`). The existing listing eligibility resolver still decides eligibility. Exact account, connection, SKU and mapping checks remain required.
- Dropship owns its exposure, vendor selection, listing mode and retained-work decisions in `readDropshipListingStockSelection` and `decideDropshipStockPublicationSelection` (`server/modules/dropship/infrastructure/dropship-stock-publication-selection.reader.ts`, `server/modules/dropship/domain/stock-publication-selection.ts`). Existing exposure and vendor-selection resolvers are reused.
- Inventory consumes these contracts through `readPublicationStockSelection` (`server/modules/inventory-planning/infrastructure/inventory-publication-selection.reader.ts:32`). `planInventoryChannelExposureProduct` continues to calculate quantities with the existing canonical ATP and exposure policies (`application/inventory-channel-exposure-runtime.service.ts:148` in that module). A retained deselected identity requests zero; a candidate without managed publication intent remains a read-only preview. Clearing duties do not consume a positive partition share.
- Normal eBay publication calls `ensureEbayPublicationReady` (`infrastructure/ebay-publication-readiness.repository.ts:41`). Mapping promotion, current quantity planning, immutable receipt and audit share a transaction. It does not require a second stock-inclusion approval. A retry can reuse a saved partial publication target only after exact source validation; it cannot guess a replacement listing or bypass an uncertain provider outcome.

## Completion and recovery

Migration `0743_publication_selection_work.sql` installs selection-change notifications and durable product invalidations. The notifications contain no inclusion or quantity algorithm. `PostgresPublicationSelectionWork.processDue/processProduct` runs in the existing publication worker. The current plan, desired quantities/outbox and work acknowledgment commit together; rollback or process interruption leaves pending work. Scheduled exposure boundaries also invalidate selection.

Business selection changes and provider admission use the existing publication gate. Admission rechecks selection before a full provider request; an old positive request cannot pass after deselection. Contention returns an actionable conflict response. Walmart retains exact deselected feed identities for zero delivery/readback through `WalmartConnectionRepository.inventoryMappings`; order matching still uses its active mapping reader.

After an exact verified eBay withdrawal, `PostgresInventoryPublicationOutboxRepository.runIfCurrent` can supersede obsolete stock work with its withdrawal reference. This records supersession, not a fabricated provider acknowledgment, and preserves unresolved historical request evidence. Disabling managed Dropship publication also preserves clearing duty for retained listings.

## Deployment impact and limits

The migrations schedule a current-selection replan for products with existing active mappings. Normal workers then use existing channel/store selections, current ATP, and existing provider protections. No migration publishes a listing or directly calls a provider. Historical membership, initial-scope and eBay readiness receipts are preserved. New mapping-preparation and selection-attempt evidence is immutable, including against truncation.

Disconnected credentials, paused transport, inventory holds, ambiguous identities and uncertain provider outcomes remain explicit blockers. A retained zero is durable work, not proof that a provider accepted it. Production data, stock, configuration, incident recoveries and deployments were not changed in this task.

Known selection errors cross the Inventory/eBay boundary as an explicit public error type with allowlisted codes. Existing issue actions lead to the applicable connection, mapping, variant, Inventory or Dropship setup. Unknown database and validation errors remain private; their internal cause is retained for diagnosis.

## Validation evidence

Local validation includes focused units, real disposable PostgreSQL and browser tests with mocked provider/API responses. PostgreSQL cases cover selection toggles without physical quantity changes, replay, stale positive admission, concurrent actions, audit rollback, worker restart, partial publication reuse, exact withdrawal retirement, and historical compatibility. Browser coverage exercises eBay, Walmart and Channel Inventory after removing the second inclusion controls.

Recorded passing runs (overlapping suites are not added together):

- 2,775 focused unit tests, including Inventory planning and ownership ratchets.
- 118 final selection-error and publication-boundary tests.
- 122 historical compatibility checks, including 104 disposable PostgreSQL cases and 18 mapping-selector units.
- 76 retained-duty/audit checks and 68 withdrawal-retirement checks, including disposable PostgreSQL rollback, replay and identity cases.
- 22 browser tests: 14 eBay, six Walmart and two Channel Inventory cases. APIs/providers are mocked; these do not prove live provider acceptance.
- Final production, server-test and client-test TypeScript checks and the application build passed. The build retained its existing large-bundle warning.

Five new PostgreSQL suites are registered in `scripts/ci/postgres-test-manifest.ts` and its coverage guard. Migration prefixes 0743/0744 were checked against the freshly fetched base above.

The full local unit run exposed 25 pre-existing Windows text-format failures across 12 suites, reproduced on a separate clean checkout of the exact base above. Two transient HTTP tests reported a blocked random port and passed on isolated rerun. Neither result was hidden by changing unrelated fixtures or weakening tests. Passing local tests, remote CI, merge, deployment and actual provider behavior are separate evidence; this branch makes no claim of a live production repair.
