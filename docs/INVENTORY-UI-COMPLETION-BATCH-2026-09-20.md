# Inventory UI batch — 2026-09-20

> Historical first-batch record. The subsequent [coordinated channel-workflow batch](INVENTORY-CHANNEL-WORKFLOW-COMPLETION-2026-09-20.md)
> extends the same branch and closes the first three remaining gaps below. Both
> batches are delivered together. The tests and no-migration statement in this
> earlier record describe its original commit, not the combined PR.

## Outcome and boundary

Implemented together on `codex/inventory-ui-cutover-completion-20260920`, from refreshed
`origin/main` commit `1179d7d0d4c40ef765326398f570b5c31ca5e265`.
This is a local implementation/validation record, not a deployment or activation receipt.
The original checkout's unrelated catalog edits were left in place; all implementation
was isolated in a clean worktree.

The existing Channel Inventory redesign and catalog conversion UI were already present
on that baseline. This batch completes missing delivery visibility and hardens their
channel draft-editing experience. It does **not** claim the entire inventory migration,
or every remaining channel-control feature, is complete.

No production database, provider account, inventory balance, recipe, reservation,
channel setting, warehouse assignment, or runtime-authority value was changed. No new
ATP calculation or inventory movement writer was added. There is no schema migration.

## What the code definitely does

| Operator action | Result and source evidence |
| --- | --- |
| Edit warehouse supply, channel defaults, product/SKU exceptions, or item mappings | All four editors use `useDraftEditor` to pin the initial revision and retain the exact command/key after an ambiguous response. Background refresh cannot overwrite dirty inputs. [`useDraftEditor`, line 7](../client/src/features/channel-inventory/use-draft-editor.ts#L7) |
| Encounter a concurrent edit | Current inputs remain visible; saving is blocked until the operator explicitly reloads. A 409 is distinguished from a network/5xx/invalid-response uncertainty. Same hook and [`isDefinitiveDraftRejection`](../client/src/features/channel-inventory/draft-session.ts) |
| Change workspace tabs/channels or close an editor | Guarded controls ask before discarding dirty inputs and refuse to leave an unresolved save. Browser unload gets a warning. [`DraftNavigation`, line 9](../client/src/features/channel-inventory/DraftNavigation.tsx#L9) |
| Use browser Back with a clean form | Selection follows the URL rather than immediately overwriting the history entry. [`AuthorizedChannelInventoryPage`](../client/src/features/channel-inventory/ChannelInventoryPage.tsx) |
| Open Quantities on a phone | Compact SKU cards show available/proposed counts; Explain quantity reveals the existing server calculation and warehouse/rule evidence. Desktop also removes intermediate calculation columns from the default view. [`QuantitiesTab`, line 37](../client/src/features/channel-inventory/components/QuantitiesTab.tsx#L37) |
| Check delivery | Separate latest requested, last provider-accepted, and last observed counts, each with its own timestamp. Earlier acceptance/observation does not masquerade as verification of a newer request. Unknown is not zero. [`PublicationStatus`, line 16](../client/src/features/channel-inventory/components/PublicationStatus.tsx#L16) |
| Reload delivery records | Reads persisted Echelon evidence only. It neither calls a provider nor captures inventory/creates a shadow run. [`registerInventoryChannelExposureRoutes`, publication-status GET, line 84](../server/modules/inventory-planning/interfaces/http/inventory-channel-exposure.routes.ts#L84) |
| Lack view/edit permission | No workspace data query without view permission; view-only operators have no draft-save controls. The new GET requires `inventory_planning:view`. Existing mutation permissions are unchanged. Same page and route above |

Routine draft reasons remain optional. Saving remains distinct from activation.
Channel percentages/holdbacks/caps still use the existing server preview; this page
does not calculate a second availability figure.

## Delivery evidence contract and failure modes

`GET /api/inventory-planning/admin/channel-exposure/publication-status`
takes `publicationTargetId` and `productId`. The response has a captured-at timestamp,
runtime authority, target revision, and per-SKU nullable desired/acknowledged/observed
records. Quantities and bigint identifiers stay decimal strings.

- `ChannelPublicationStatusService.read` validates request and response. Invalid or
  unavailable data fails visibly, rather than returning empty/zero success.
  [Service, line 16](../server/modules/inventory-planning/application/inventory-channel-publication-status.service.ts#L16);
  [shared contract](../shared/types/inventory-channel-publication-status.ts).
- `PostgresChannelPublicationStatusReader.read` uses a repeatable-read, read-only
  transaction, an 8-second statement timeout, and a bounded 1,000-SKU response.
  More than that limit is an explicit error, never silent truncation.
  [Repository, line 11](../server/modules/inventory-planning/infrastructure/inventory-channel-publication-status.repository.ts#L11).
- It uses the active sealed item mapping and the exact destination owner, account/location,
  and inventory-item identity. A draft mapping is not delivery authority. Outbox evidence
  also matches the saved provider SKU. Records without sufficient identity evidence remain
  unknown. [Identity predicates, line 96](../server/modules/inventory-planning/infrastructure/inventory-channel-publication-status.repository.ts#L96).
- Failed refreshes hide stale delivery figures. A historical readback is explicitly not a
  live stock check, even if its quantity once matched. Provider-managed/manual destinations
  retain their ownership labels. Legacy authority is explicitly called out.
- Draft retry state is in memory, not a durable offline draft store. Guarded workspace
  actions and browser unload warnings do not guarantee recovery after a forced tab close,
  crash, or navigation outside those controls. Saved server drafts remain authoritative.

## Catalog/conversion checkpoint

These existing features were validated, not replaced:

- Variants uses the package conversion card for hierarchy-managed products, build
  relationships for recipe-managed products, and no package editor for physical-only
  products. Active directions remain visible until a draft is explicitly opened.
  [`ProductConversionCard`, line 112](../client/src/features/inventory-builds/ProductConversionCard.tsx#L112).
- Product Review/Apply shows warehouse/channel impact and retains the same command on
  uncertain Apply. [`ProductDefinitionReview`, line 16](../client/src/features/inventory-builds/ProductDefinitionReview.tsx#L16).
- Procurement owns editable safety policy; Inventory's safety summary is read-only.
  Safety Review/Apply covers the affected scope and preserves its exact retry.
  [`SafetyDefinitionReview`, line 14](../client/src/features/inventory-builds/SafetyDefinitionReview.tsx#L14).
- The actual database-backed cutover composition suite passed, including verified opening,
  claim reconstruction, publication and routine product/safety definition application.
  This proves fixture behavior, not the correctness of today's production opening stock.
  [Composition suite](../server/modules/inventory-planning/__tests__/integration/inventory-cutover-composition.integration.test.ts).

## Validation

| Check | Final result |
| --- | --- |
| `npm run check -- --incremental false` | Passed |
| `npm run check:tests` | Passed |
| `npm run test:unit` | 1,138 files passed; 13,758 tests passed; 39 tests / one file skipped |
| Focused channel/conversion client contracts | 11 files; 179 tests passed |
| All eight `scripts/ci/postgres-tests.ts` shards | 86 files; 1,336 tests; zero failures/errors/skips, against a new localhost-only PostgreSQL cluster |
| `playwright.inventory.config.ts` | 42 desktop/mobile checks passed |
| Catalog conversion/safety browser journeys | 28 desktop/mobile checks passed |
| Final channel-only browser rerun | 24 checks passed after making screenshot fixtures use a consistent active mapping |
| Visual inspection | Desktop and 390px mobile screenshots inspected; no page-width overflow; mobile proposed quantities no longer require horizontal table scrolling |

The new eight-test PostgreSQL suite is included in the explicit CI manifest and its
coverage guard. Its database tables come from the actual inventory migrations.
[Database suite](../server/modules/inventory-planning/__tests__/integration/inventory-channel-publication-status.integration.test.ts);
[CI manifest](../scripts/ci/postgres-test-manifest.ts);
[browser journeys](../test/browser/channel-inventory-workspace.spec.ts).

Validation corrections: an initial all-files Vitest run incorrectly ran schema-owning
integration suites concurrently against one test database; that result was not counted
as a pass. All PostgreSQL suites were rerun through the existing per-file isolated CI
runner. A pre-existing literal-newline assertion failed on Windows CRLF checkout bytes;
its migration was formatted locally to the identical Git-normalized content for the unit
run, with no migration-content change. New-route and CI-manifest count assertions were
updated, and the final full unit run passed.
The temporary PostgreSQL cluster was stopped after validation; no existing local database
service was stopped or reconfigured.

## What is not proven / still required

The designer handoff's other backend gaps remain explicit, not disguised as working buttons:

1. Routine post-cutover **channel** policy/source/mapping Review/Apply. Existing product
   and safety Review/Apply are not that contract; Resume still uses active definitions.
2. Product/SKU-specific warehouse-source overrides; supply currently belongs to the destination.
3. Explicit retirement of an entire saved product/SKU exception; copying parent values
   is not equivalent to restoring inheritance.
4. A complete location promise-eligibility editor and any unimplemented direct provider adapters.

See the later [handoff completion checkpoint](INVENTORY-CHANNEL-CONTROLS-DESIGNER-HANDOFF.md#completion-checkpoint--2026-09-20)
and the visible explanations in Supply, ExceptionSheet, and PublishingTab. This batch
closes the previously missing per-SKU delivery-status read path, not those separate contracts.

Production was not queried in this UI batch. Before cutover, refresh the actual opening
inventory/obligations and run the full post-reconstruction projection, then review exact
warehouse/channel quantities and obtain explicit activation approval. Prior dated read-only
reports and passing local tests cannot substitute for that evidence. Post-cutover legacy
retirement remains gated by the consolidation plan; it is not authorized by this UI work.
