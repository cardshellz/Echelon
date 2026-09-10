# Verified current-inventory opening

## Superseding quantity-authority update

The sections below retain the original **v1** design and evidence. The current
v2 workflow is described in [One physical quantity authority](INVENTORY-SINGLE-QUANTITY-AUTHORITY.md).
It derives bin totals from independently verified lot observations instead of
requiring both legacy counters to match. Differences in those quantity counters
can be established by the approved opening; exact lot identities, original
costs, complete current ownership and all other safety checks remain required.
The opening is posted with the canonical ATP cutover in one transaction.
Historical v1 saved assessments keep their original semantics. Saving either
verification is still not activation, and deployment alone changes no counts.

## Approved policy and scope

The operator approved building a controlled opening-balance cutover from independently verified current stock and outstanding orders, with unresolved historical discrepancies preserved separately. This is an explicit alternative to reconstructing every current owner from incomplete legacy journals. It is not proof that the old journals, shipments or historical costs have been repaired.

Deploying this feature changes no stock, orders, costs, reservations, provider quantities or runtime authority. An operator must independently verify a complete snapshot, save its immutable audit, then use the existing preparation, conservative publication, final review and commit workflow. Saving verification is not activation. Current inconsistencies remain blockers.

## Existing screen and endpoints

The opening section lives on the existing Supply Transformations page before preparation; no new review page is introduced. The existing preflight response remains compatible.

- `GET /api/inventory-planning/admin/cutover-opening/source`: capture current source facts and human-readable order/SKU/warehouse/bin labels using one repeatable-read, read-only transaction.
- `POST /api/inventory-planning/admin/cutover-opening/preview`: assess an explicit independent verification against a fresh read-only snapshot; no audit or stock writes.
- `POST /api/inventory-planning/admin/cutover-opening/verify`: recapture under the exclusive cutover admission fence and append one immutable verification record. No physical counters, cost rows, orders, claims or authority are changed.

All endpoints require `inventory_planning.activate`; a normal view permission does not authorize an opening attestation. Only the two authenticated POST endpoints accept a bounded 10 MB body. Ordinary JSON endpoints retain their existing limit.

The exported worksheet separates recorded values from independently verified observations. Verification quantities and evidence fields start blank, not zero or pre-approved. Uploaded display names are not identity authority. The operator uses exact IDs bound to server-supplied human-readable labels, an independent verification reference and document hash, verification time and reason. Preview and immutable save are separate explicit actions. An uncertain save retries the exact original key and body.

## What verification proves

`evaluateCutoverOpening` in `server/modules/inventory-planning/domain/inventory-cutover-opening.ts` requires:

1. The complete source evidence hash and current authority revision match the submitted snapshot. Saving also checks the expected configuration-freeze identity.
2. Every current level and lot is independently verified exactly, including on-hand/reserved/picked/packed counters and all recorded cost components. Missing, duplicated, changed or newly introduced rows are not silently accepted. A mismatch requires a separate inventory-owner correction, not an opening overwrite.
3. Every current tracked physical order line has an explicit verification, including unstarted demand and zero remaining quantity. Remaining demand equals original ordered minus fulfilled quantity. Original progress must be nonnegative, no greater than ordered quantity, and compatible with the current claim runtime. Current picked observations agree with cumulative picked minus fulfilled progress.
4. Every positive hold identifies exact owner, warehouse, level, variant and lot. Customer allocations plus retained independent build holds exhaust every reserved and picked lot unit exactly. Several orders over several lots require explicit verified assignments, not an inferred FIFO assignment.
5. Current picked stock has distinct existing original order/item/lot cost records whose quantities and integer-mills arithmetic match exactly. These rows are adopted into immutable canonical pick provenance; they are not edited, fabricated or divided to fit a desired answer.
6. Existing current-demand, OMS authorization coverage, variant/warehouse, build lifecycle, physical balance, pending shipment and canonical-lineage guards still pass. A hold does not become available simply because an old owner is closed.

The evaluator projects independently verified current ownership into the existing adoption planner in memory. These observations are not inserted as invented historical transactions. The final claim import preserves existing reserved/picked units and reserves only additional eligible fresh demand through the existing inventory owner. Shortfalls remain explicit. Opening verification never invokes the empty-bin promise counter-release path.

## Historical evidence retained, not cleared

The immutable opening snapshot stores the complete original census, uploaded verification, assessed plan, displaced historical findings, actor, reason, verification time, semantic request hash and result hashes. The original inventory journal, original cost rows and provider records remain unchanged.

Only explicitly shipped source/physical records and terminal ignored receipt/acknowledgment records are treated as historical in this projection; pending, processing, failed, review and unknown lifecycle work remains subject to current guards. Physical `delivered` is not a supported persisted lifecycle and is not silently archived. Original accepted OMS-demand coverage is evaluated against original commercial quantities, not the reduced remaining-demand projection.

Displaced findings are recorded as **unresolved historical exceptions**, never marked repaired or financially written off. Their complete hash and count, the verification hash and opening snapshot ID appear in final-review evidence and the immutable reconstruction receipt. Counts can overlap and are not inventory quantities or counts of unique customer incidents.

## Persistence, concurrency and stale evidence

Migration `240_inventory_cutover_verified_opening.sql` adds the inventory-planning-owned `inventory.availability_cutover_opening_snapshots` audit. Insert requires the existing admission-fence owner, legacy authority at the reviewed revision and the expected open configuration freeze. The audit rejects update, delete and truncate. Semantic command identity includes the authenticated actor, verification, reason and idempotency key. Exact retry returns the original record; a conflicting retry or competing verification for the same source/revision cannot overwrite it.

The migration also pins receipt, latest-attempt and legacy build-demand writers into the existing statement-level cutover admission mechanism. Those records are part of the full census; they cannot introduce pending work between capture and admitted save/activation. Existing admission uses fail-fast locking rather than waiting in conflicting lock order.

Reconstruction preview and commit select the newest immutable opening verification if one exists. No verification preserves the original strict-ledger path. A selected verification whose complete source hash or authority revision changed explicitly blocks; the code does not fall back to an older record or silently resume strict mode. Preparation changes the configuration-freeze identity, not the independently verified physical basis; configuration selections and publication remain independently rechecked by the existing workflow.

Final commit recaptures under the existing fence, validates review/impact hashes, preserves the opening provenance, imports claims and original picked costs, and retains the existing atomic activation/publication behavior. A late failure rolls back new claims, fresh reservations, authority and publication together. The separately saved historical audit remains available; the failed attempt does not rewrite it.

## Operational limits and remaining work

- A database snapshot is recorded evidence, not a physical stock count. A reference/hash supplied by an authorized operator is an auditable attestation, not automated authentication of an external count document.
- Independently counted quantities that disagree with current records must be corrected through an approved owning-module operation before verification. This feature does not supply or execute those corrections.
- Packed custody without a supported exact handoff, missing current picked costs, incompatible WMS picked/fulfilled progress, unresolved active packages, missing accepted demand and incorrect source configuration remain blockers.
- Partly fulfilled lines with remaining demand are explicitly blocked: the current canonical picker compares claim-owned picked units to cumulative WMS picked progress and has no historical-fulfillment baseline. The opening must not pass adoption only to fail the next pick. Fully fulfilled lines create no new claim, but any remaining non-shipped source or physical package still blocks.
- This approach does not rewrite historical loss/COGS, recover old package-specific FIFO history, or repair the old OMS/WMS numeric-ID collision by guess.
- The full evidence hash includes historical records. A concurrent order, stock, cost, receipt or other captured-evidence change invalidates the packet. Use a controlled operational window and recapture as needed; no stale verification is carried forward automatically.
- Catalog models, channel/source mappings, provider drain/readbacks and final activation approval remain separate existing requirements. No provider setting or warehouse assignment is inferred by this feature.
- A complete opening proof is a large administrative operation, not a background poll. A synthetic 9,000-owner stress case with 50,000 journal groups completed with a 384 MiB JavaScript heap but exceeded 512 MiB process RSS; a 256 MiB diagnostic heap exhausted memory. Confirm actual server memory headroom before a full live capture/verification. No production memory setting was changed by this implementation.

## Test coverage

Unit coverage checks exact counters, complete coverage, original-cost arithmetic above JavaScript's safe-integer range, negative/progress edge cases, unsupported partial fulfillment, unfinished work on fully fulfilled lines, multiple explicit lot owners, build holds, preserved ignored/unknown history, live review blockers, malformed inputs, deterministic hashes and immutable inputs. HTTP/UI coverage checks permissions, endpoint-specific body bounds, blank independent-verification fields, labels, manual preview/save, stale state and same-command retry.

Real PostgreSQL coverage verifies the actual fence and append-only migration, source and revision compare-and-set behavior, concurrent saves and replay, no physical/history changes when saving, effective projection of a saved opening, stale verification rejection, original picked-cost adoption, retained build holds, final-commit rollback/replay and receipt-writer admission. Run results and exact commit are reported in the delivery handoff; this document does not claim a production opening was verified or activated.

The transport regression preserves 9,000 order lines, 341 levels, 2,371 lots and 4,277 original cost references while keeping a completed compact worksheet below the unchanged 10 MiB import cap. Blank quantities are still blank, and no reference row is dropped. Evidence hashing retains strict input validation and byte-compatible prior hashes while avoiding duplicate parsing/sorting of the same full census.
