# WMS stations, work routing, and assignments — review proposal

Date: 2026-09-05

Status: Approved for implementation by the user on 2026-09-05. Production activation remains separate. See WMS-STATIONS-IMPLEMENTATION-RECORD-2026-09-05.md for delivered scope and verification.

## 1. Outcome and boundaries

Build one warehouse-execution framework for fixed stations, mobile work, routing, worker assignments, and durable handoffs. Connect existing receiving, replenishment, build, pick, pack, return, and count owners to it. Do not create separate queue/assignment engines for every station type.

A shared assembly list could avoid configured stations, but it still needs ownership and completion tracking. It is not the full solution requested here. This proposal supersedes that temporary simplification.

This document records the pre-implementation investigation. At the time of that investigation no application or production changes were made and no deployment or production database state was inspected. The implementation record tracks subsequent local code changes; this historical evidence is not a claim that the new workflow is live.

### Verified baseline

- Refreshed origin/main: `8785bc7586c69275bf6528a63d90bb0aa9556f41` (merge #1374).
- Investigation checkout: `8ac7394762f17caa77e8124f96ce58597007bddb` in clean worktree `codex/inventory-final-activation-1372`.
- Git diff verified no differences in the cited warehouse, identity, receiving, inventory execution, WMS, packing, shipment-state, or migration-plan files between this checkout and refreshed main. Newer catalog/backfill and Dropship listing-policy work is not station functionality.
- No tracked AGENTS.md was found on main; user-supplied AGENTS instructions and on-disk CLAUDE.md apply.
- Read the 870-line inventory transformation migration plan in full. WMS_ARCHITECTURE.md describes a desired pack-station flow but is not proof of deployed workstation functionality.
- Searches across shared/server/client/migrations found no dedicated workstation, station_id, or assembly_station model. This is a source-code finding, not proof about externally configured ShipStation stations.

### User-confirmed operating requirements

1. Assembly ingredients are already at the assembly area.
2. The picker prints the shipping label in ShipStation before assembly; the job then leaves ShipStation's queue. Preserve that physical sequence.
3. The shipping label carries the current handwritten instructions and is applied after assembly.
4. Let the picker finish their assigned work without pretending unfinished assembly is a completed finished-SKU pick.
5. Build the full station/assignment design for review; do not implement yet.
6. Preserve warehouse-aware canonical ATP, exact physical stock, explicit conversions, per-item promise policy, existing channel architecture, and future multi-warehouse/3PL support.
7. Do not add build-time capacity or channel-specific promise rules, new checkout blocks, or mandatory two-person approvals through this project.
8. Replenishment remains rule/resolver-directed. Operator observations are evidence, not an alternate source of conversion or replenishment authority.
9. The operation currently has two employees. One person performs receiving/movement/stow, and the picker replenishes inline. Do not impose separate stations, logins, or self-handoffs for those same-person activities.
10. Build one scalable model for hundreds of employees and multiple buildings, enabling additional workflow separation by configuration when operationally needed. Section 3A defines the proposed small-team defaults; these are not production settings.

## 2. Confirmed current foundation and gaps

| ID | What the code definitely does | Evidence and reasoning | Gap / limit |
| --- | --- | --- | --- |
| E1 | Warehouse locations carry warehouse, zone, location type, pickability, capacity, and pick-zone fields. | [warehouseLocations](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/shared/schema/warehouse.schema.ts:130) | Locations are stock addresses, not station queues or employee sessions. Do not infer ATP eligibility from a station type. |
| E2 | Users can have multiple roles. Role permissions have a constraints JSON column. | [authRolePermissions and authUserRoles](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/shared/schema/identity.schema.ts:101) | Stored constraints do not establish enforcement. |
| E3 | Common authorization returns resource:action strings and tests membership. | [getUserPermissions](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/identity/infrastructure/identity.repository.ts:56); [hasPermission](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/identity/index.ts:27); [requirePermission](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/routes/middleware.ts:27) | This path does not evaluate warehouse, zone, or station constraints. Typed scope enforcement must be implemented, not assumed. |
| E4 | Picking has guarded order-level worker assignment and identifies another current picker. | [PickingUseCases.claimOrder](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/orders/picking.use-cases.ts:2929) | This is not a general cross-workflow assignment model. A worker assignment is distinct from an inventory reservation claim. |
| E5 | The gun has SKU/bin/quantity/status and replenishment guidance. | [PickItem](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/client/src/pages/Picking.tsx:556); [replenishment dialog](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/client/src/pages/Picking.tsx:4851) | No assembly handoff fields; the current replenishment acknowledgement only dismisses its dialog. |
| E6 | Build orders have warehouse, output location, progress, and completion actor. | [buildOrders](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/shared/schema/inventory.schema.ts:230); [Build Orders table](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/client/src/pages/Builds.tsx:432) | No general station binding, worker claim, shift/session, or station-scoped queue. |
| E7 | Canonical operation records distinguish package/build types, quantities, output location, and execution status. Claim application commands expose package execution, build handoff, and build execution. | [inventoryAvailabilityClaimOperations](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/shared/schema/inventory-planning.schema.ts:1435); [canonical operation commands](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory-planning/application/inventory-availability-claim.service.ts:109) | Service capabilities are not a connected operator workflow. Searches found no production UI/route caller of those application execution commands. |
| E8 | Generic build execution explicitly refuses canonical claim-owned builds. | [assertClaimBuildActionAvailable](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/infrastructure/build-execution.repository.ts:231) | Wiring a new station to the old generic Execute endpoint would not solve canonical assembly. |
| E9 | Transformation consumes source on-hand/reservations and creates output on-hand/reservations; picking separately moves finished quantity into picked counters. | [executeTransformationOperation](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts:1942); [pickResources](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/infrastructure/canonical-claim-inventory.repository.ts:1425) | A task click must never silently invent physical completion. Canonical build execution currently completes the whole planned build in its completion update; partial-run semantics require explicit work. |
| E10 | Packing queue selects eligible, non-held orders globally; confirmation stores actual box, weight, time, and packer and can mark the plan packed. | [getPackingQueue](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/shipping-engine/application/packing.service.ts:134); [confirmParcel](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/shipping-engine/application/packing.service.ts:339) | No station/warehouse argument in this queue. Current parcel confirmation is not proof of complete scan-to-box content verification or assembly readiness. |
| E11 | Packing endpoints require authentication; build execution requires inventory:adjust. | [registerPackingRoutes](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/shipping-engine/interfaces/http/packing.routes.ts:33); [build execution route](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/build.routes.ts:166) | Introduce operation-specific permissions and scoped access. Do not give assemblers inventory-adjust authority just to complete a planned job. |
| E12 | ReceivingService.close posts to the selected putaway location and marks the receiving line putaway-complete. | [ReceivingService.close](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/procurement/receiving.service.ts:989); [receipt posting and putaway update](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/procurement/receiving.service.ts:1278) | Distinct dock receipt and later physical putaway cannot be added as a second receipt. Their posting sequence must be separated when that workflow is enabled. |
| E13 | Replenishment execution re-resolves source, locks the task, and validates executable state. | [ReplenishmentUseCases.executeTask](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/application/replenishment.use-cases.ts:1131) | Station assignment must call this owner, preserving rule-driven source selection and claim safety. |
| E14 | Cycle counts have initialization, observations, investigation, and variance approval entrypoints. | [initialize](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/application/cycle-count.use-cases.ts:534); [recordCount](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/application/cycle-count.use-cases.ts:709); [approveVariance](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/application/cycle-count.use-cases.ts:1192) | A worker counting stock must not automatically acquire permission to approve adjustments. |
| E15 | Return receipt locks the return aggregate and children and validates receipt state. | [receiveExpectedWmsReturn](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/wms/return-receipt-commands.ts:256) | This receipt command alone does not prove all inspection, disposition, restock, and refund paths are integrated. |
| E16 | Shipment enums distinguish labeled from shipped; carrier-dispatch authority has an explicit evidence-bearing contract. | [isShipmentShipped / isShipmentOpen](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/shared/enums/order-status.ts:95); [ConfirmCarrierDispatchInput](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/shipping/carrier-dispatch-authority.ts:1) | Actual production label-to-WMS-to-channel event behavior remains unverified. Do not treat ShipStation queue removal as assembly, packing, or carrier-possession evidence. |
| E17 | Build completion records full planned completion and cost through the inventory writer. | [executeOperation inventory call](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/infrastructure/canonical-claim-build.repository.ts:594); [build completion update](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/infrastructure/canonical-claim-build.repository.ts:704) | Partial physical completion cannot be exposed as a cosmetic UI counter; exact partial consumption/output/claim lineage must exist first. |

Hypotheses: none are required to assert the gaps above. The user confirmed two employees, combined receiving/movement/stow, and picker-performed inline replenishment. Actual station counts, hardware, detailed staffing assignments, posting/scan timing, and production provider-event behavior remain UNKNOWN. The target design below is PROPOSED, not an assertion about current code.

## 3. One model, different operational capabilities

Keep six concepts separate:

| Concept | Meaning |
| --- | --- |
| Warehouse / fulfillment node | Where inventory and execution belong; includes separate internal warehouses and external 3PL nodes. |
| Location | Exact stock or staging address. Quantities stay in the existing inventory/lot owners, not on a station balance. |
| Station | A named fixed work area, such as PACK-01 or ASSEMBLY-01, linked to input, output, staging, and exception locations. |
| Capability and queue | Work the station or mobile team may receive: assembly, packing, receiving, movement, count, etc. One bench may support several capabilities. |
| Employee / permissions / eligibility | Who may perform which action in which warehouse/zone/station. An assignment never grants permission. |
| Device/session and task assignment | Which authenticated person is using a gun/terminal, where they are operating, and which particular work they currently own. |

Mobile picking, forklift movement, and cycle counting use warehouse/zone work pools and device sessions. They do not require a fictitious fixed bench. A gun or forklift is a resource, not a stock bin.

A station may have multiple concurrent operators, subject to explicit task/parcel ownership. One employee may qualify for several stations; their active context determines their workload. Default station is a convenience, never a permanent restriction or authorization grant.

## 3A. Small-team operation with progressive workflow enablement

Revision added 2026-09-05 after the user clarified that the current warehouse has two employees. This section refines the full-suite design: all catalogue entries are supported capabilities, not mandatory stations, queues, login changes, or distinct staff roles. No configuration was applied.

### The operating principle

An activity is not a station. A stock movement is not necessarily a human handoff. A station is a real work area. Create a separate handoff/queue only when custody or responsibility actually changes, work is deliberately deferred, or a controlled process requires it.

Use ONE task/quantity/ownership engine in every configuration. Small-team mode is a workflow presentation/routing preset, not an alternative inventory implementation or a permission bypass.

The same worker can receive, move, and stow within one guided job. The same picker can do permitted replenishment and resume picking. The same assembler can assemble, pack, and apply a label at one bench. Every completed physical operation still gets its owning-domain evidence; the operator need not manage the intermediate task records.

### Proposed current two-person preset

| Workflow | Small-team experience | Separately queued only when |
| --- | --- | --- |
| Receive -> move -> stow | One Receive & Stow job and one personal session. Capture actual SKU/UOM, quantity, and final location without changing stations or accepting three assignments. Post directly to the confirmed final location when the goods really have been stowed. | Goods are received now but left for later putaway, inspection is required, or another person takes responsibility. Then retain actual receiving/staging stock and a visible remaining movement. |
| Pick -> replenish -> resume pick | Show resolver-issued eligible replenishment as part of the current gun workflow. Carry the same operator assignment and return to the original pick. No trip to a replenishment queue or new station login. | A different operator/equipment capability is needed, the worker cannot perform it, or work is deliberately deferred. |
| Picker -> assembly | Keep the real handoff already described by the user. Route job and label to the combined Assembly + Packing area; no ingredient-collection task since materials are there. | This is already separate responsibility, so it remains visible regardless of team size. |
| Assembly -> packing -> label application | One bench, one job view, same authorized employee. Advance to the next required instruction automatically; no manual mode switch or self-handoff. Final action may complete the remaining validated steps together, but never records assembly before it happened. | Assembly output goes elsewhere, another employee takes over, or packing is deferred. |
| Returns -> inspect -> restow | Same-person guided workflow when permitted, with actual disposition evidence. No extra station merely because the activity changed. | QA hold, rework, approval permission, or physical custody requires separation. |

Opening an executable job can atomically assign/start it for the authenticated, eligible worker, with visible ownership and a concurrency guard. No additional “Claim,” “Start,” and “Accept next step” clicks are required on the routine same-person path. Merely previewing a job must remain read-only.

A fixed terminal can remember its configured work area; a worker logs in personally. A gun can inherit the permitted warehouse/work pool and remain mobile. If there is exactly one eligible context, select it automatically; never select an unauthorized or ambiguous warehouse silently.

Both employees may receive one composed Warehouse Operator role containing the routine capabilities they actually perform. Role templates in section 5 describe permission bundles, not required headcount or ten separate role switches. Adjustment, recipe editing, activation, sensitive label actions, and approvals remain separately granted.

### Enablement gates: scoped workflow profiles, not a pile of global booleans

Expose these settings in Warehouse administration -> Workflow profiles. The Small team preset provides defaults; expand the specific workflow only when needed.

| Profile setting | Suggested current default | Expansion |
| --- | --- | --- |
| Inbound processing | Receive & Stow together | Receive into staging, then separate putaway; optional QA dependency |
| Replenishment work ownership | Same permitted picker continues | Dedicated operator/team queue, with exceptions by method/equipment/zone |
| Assembly and packing | Combined at the actual assembly area | Separate assembly/pack queues and stations |
| Work assignment UX | Automatically assign when execution starts | Eligible team queue, supervisor dispatch, or station allocation |
| Handoff verification | Only at real responsibility/custody/deferred-work boundaries; reuse the next job-open/scan action where it provides valid evidence | Explicit send/receive scans and tote/container tracking where operationally needed |

Feature availability, physical routing, worker authorization, and stock-posting rules are separate concerns. Do not let an “advanced features off” flag switch off stock ownership, discrepancy handling, audit, authorization, or duplicate-post protection. Enabling a feature exposes approved configuration; it does not automatically activate new routes or mutate stock.

Profile resolution is explicit and deterministic: business template -> warehouse default -> optional building/area/workflow override -> explicit SKU/operation/location routing override where supported. Missing means inherit. The UI shows the effective value and its source; ambiguous overrides are rejected. Eligibility and safety restrictions are always intersected, never weakened by a more specific convenience setting.

Replenishment MUST reuse the existing rule/tier/warehouse resolver for decisions and posting. New workflow settings govern whether the same person sees/does the work in context; they are not a second auto-replen switch. Current code evidence:
- [loadLocationConfig and resolveReplenParams](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/application/replenishment.use-cases.ts:628) resolve location/SKU and rule/tier parameters.
- [resolveAutoExecute](C:/Users/owner/Echelon/worktrees/inventory-final-activation-1372/server/modules/inventory/application/replenishment.use-cases.ts:3525) accepts SKU overrides, tier overrides, and warehouse inline/queue/hybrid fallback, but returns queue for non-case-break methods.
- Therefore “same operator handles a transfer during picking” must not be implemented as “automatically post every transfer.” It may require explicit physical movement evidence within the SAME gun workflow. No picker-selected quantities or confirmations replace the rules as replenish authority.

### Growth without changing the accounting model

Example future change: Building B has a receiving crew and forklift team. Give its inbound workflow a staged-receipt profile and route the putaway leg to its material-handler pool. Building A can keep Receive & Stow combined. Existing shared records, quantity ownership, APIs, and inventory owners remain the same.

Support warehouse IDs and stable scoped area/resource IDs from the start. Add a building grouping where needed for physical routing; do not assume one building must equal one inventory warehouse or that moving between buildings creates new inventory. A cross-building move requires actual transfer/custody evidence even when one employee does both ends. Separate warehouses/3PL nodes retain explicit inventory and fulfillment boundaries.

At hundreds of users, keep queues server-filtered and paginated by warehouse/pool/state; use indexes, deterministic priority, per-task concurrency, and durable event processing. A warehouse-wide execution lock, polling every job to every terminal, or a queue per employee does not scale and is not the proposed model. Load tests and operational capacity measurements are required; no employee-count throughput guarantee has been verified.

Profile changes are versioned and previewable. Apply a new profile to new work by default. Started work keeps its routed version; moving queued/unstarted work requires an explicit validated reassignment. Never rewrite progress, release inventory, or strand active work because a gate is changed. Pausing a station stops new assignments, not the recording/recovery of work already physically underway.

### Always-on safeguards, optional process ceremony

Always on: individual identity, scoped permissions, exact SKU/UOM/location and reservations, explicit transformation authority, idempotent posting, audit, valid completion evidence, visible unresolved work, safe partial/cancel recovery, and distinction between label/assembly/packing/dispatch.

Optional by workflow: separate activity queues, explicit workstation selection, extra handoff scans, put walls, dedicated replenishment teams, separate assembly/packing areas, and advanced dispatch scheduling. Omitted screens do not imply omitted physical truth.

Do not require every routine activity to pass a separate confirmation dialog. Capture required evidence in the normal action or scan, auto-advance same-person work, and surface exceptions when necessary. No timer, label print, “small team” preset, or default assignee may fabricate physical assembly completion.

### Additional acceptance tests for progressive workflows

- Same-person Receive & Stow has no self-handoff and no duplicate receiving/transfer quantity.
- A staged receipt left overnight stays at its real receiving location; it is not falsely shown stowed.
- Picker replenishment resumes the same pick and preserves the existing resolver/claim safety; explicit-transfer evidence does not require a separate station.
- One-step and split-task routes for the same completed physical operations reconcile to identical final quantity/cost/ownership, with their true intermediate histories.
- Two workers opening the same executable job cannot double-claim or double-post.
- Combined Assembly + Packing has no redundant mode switch and cannot finish before required physical work/contents exist.
- Profile changes, paused stations, role revocation, device failure, and warehouse switching cannot orphan or silently move active work.
- Test small-team and multiple-building configurations in the same suite; no distinct legacy/small-business execution engine.

## 4. Full station and work-area catalogue

These are capabilities to support, NOT a requirement to purchase eleven benches. Combine compatible functions at one physical area.

| Type | Fixed/mobile | Work received and operator instruction | Completion / destination | Suggested role |
| --- | --- | --- | --- | --- |
| Receiving / inbound dock | Fixed area, mobile scanning permitted | Identify PO/transfer/ASN, SKU/UOM, actual quantity and actual receiving/final location; record damage/shortage. | Combined: receipt at confirmed final stow location. Staged: receipt at dock, then inspection/putaway work. Never both as separate receipts for the same stock. | Receiver |
| Inspection / quarantine / QA | Fixed area or controlled inspection point | Inspect inbound, returned, assembled, or disputed goods; show disposition requirements. | Recorded disposition to approved stock, rework, quarantine, or authorized scrap. | Quality operator; authorized disposition approver |
| Putaway / internal transfer | Mobile gun/forklift | Take exact SKU/lot/handling unit from source and put at resolved destination. Includes inter-station supply moves. | Physical movement with preserved lot/cost/claim ownership. | Material handler |
| Replenishment / decant | Mobile and/or fixed decant bench | Resolver-issued resupply, break-pack, or bulk-to-pick tasks. | Exact transfer/conversion to target; shortages remain exceptions. | Material handler / replenishment operator |
| Picking | Mobile, cart, zone, or fixed pick cell | Pick finished stock into the identified order/tote; show separately routed assembly work. | Finished-stock pick evidence and next-area handoff; not a fictitious assembly completion. | Picker |
| Consolidation / sort / put wall | Fixed staging area | Match separately picked totes/items to exact order/shipment/parcel; show missing contributions. | Verified combined contents, then packing or assembly; transfer/sort does not manufacture inventory. | Sorter / packer |
| Assembly / kitting / preparation | Fixed bench or configured inline activity | Exact approved components/operations, quantities, instructions, order and label association. | Posted output and ownership, then packing/stock/next build step. | Assembler |
| Packing / value-added finishing | Fixed bench or mobile pack capability | Verify exact shipment contents, carton, weight and required inserts/labels/finishing steps. | Box/parcel closed with contents and actor evidence; then dispatch staging. | Packer |
| Dispatch / shipping dock | Fixed staging lanes, mobile scans | Match ready package to active label, carrier/service, load or pickup. | Record dispatch evidence through shipping owner; no second stock deduction. | Shipping operator |
| Returns / rework | Fixed receiving/triage area, may share QA/assembly | Match return, receive actual goods, inspect, choose permitted disposition; route repair/repack work. | Restock only after approved disposition, or rework/quarantine/scrap. Refunds remain a separate authorized financial workflow. | Returns operator |
| Inventory control / exception resolution | Mobile counts plus supervisor desk | Count/recount, investigate missing material or wrong-bin evidence, recover stranded tasks. | Audited owner commands for approved corrections; no unrestricted operator adjustment. | Counter / inventory controller / warehouse lead |

Operational distinctions:

- Assembly and packing can be one ASSEMBLY-PACK-01 station. The person may complete both tasks in sequence without handing a box across the room.
- Print/reprint/void is a permission-controlled shipping capability and device binding, not necessarily another bench.
- Transfer outbound work uses picking/consolidation/dispatch; transfer inbound uses receiving/putaway. Do not invent separate inventory for a “transfer station.”
- Cross-docking is an approved route from receipt to outbound staging; it does not need its own station type. Enable only if the business uses it.
- Scrap is a controlled disposition, not a general-purpose “delete stock” station.
- The supervisor control desk and external 3PL monitor are work views, not inventory-holding stations.

## 5. Roles, assignments, and login

Reuse existing accounts, role editor, and multi-role support (E2). Add scoped WMS permissions, not new shared station accounts.

| Role template | Permitted routine work | Kept separate |
| --- | --- | --- |
| Receiver | Assigned inbound receipt/count/location evidence | PO price edits, over-receipt override, receipt reversal |
| Material handler | Assigned transfers, replenishment, approved decant execution | Changing replenish rules or promising another order's reserved stock |
| Picker | Assigned picks, assembly handoff, discrepancy observations | Marking unperformed builds complete or arbitrary stock adjustment |
| Assembler | Assigned authorized operations and actual output evidence | Recipe editing, conversion permission, activation, free-form stock creation |
| Packer | Shipment-content verification, box/weight, close package | Recipe changes; label void/reprint requires its own permission |
| Shipping operator | Allowed label actions and dispatch evidence | Treating label creation as assembly or physical dispatch |
| Returns / QA operator | Receipt, inspection, allowed disposition | Refund, scrap/write-off, unrestricted inventory adjustment unless separately granted |
| Inventory controller | Count review, authorized correction and reconciliation | Changes outside warehouse scope; unsupported cost creation |
| Warehouse lead | Reassign/reprioritize, handle exceptions, see all scoped queues | Automatic bypass of lot/claim integrity |
| WMS administrator | Configure stations, routing, device bindings, access | Operational/financial permissions remain explicit, not implied by setup access |

Enforce permission + warehouse/zone/station scope + station capability + current task assignment + inventory-owner preconditions on the SERVER for reads and writes. A hidden button is not enforcement. E3 shows this is new work.

Workflow: personal login -> inherit or select a permitted station/mobile context -> see “My work” and eligible queue -> atomically assign/start when executing a job -> record observations -> complete/handoff through the owning command. Section 3A removes redundant selection, claim clicks, mode switches, and self-handoffs for combined same-person workflows.

A station session is not the task owner. Logging out or a dead battery does not erase ownership, undo work, release inventory, or falsely complete a job. Supervisors can recover/reassign with reason and preserved progress. No mandatory two-person approval; the required approval capability may be held by one authorized person.

## 6. Routing and operational state

Rules resolve a task into a warehouse-scoped capability pool and, when needed, an eligible station. The workflow profile can keep consecutive compatible steps with the current authorized worker without a station or queue change. Rules use the committed operation and version, SKU/product override, source/output compatibility, equipment needs, and existing priority/ship-by information. Missing or ambiguous required routing creates a visible unroutable task; it never fabricates a destination or silently picks a different warehouse.

SKU/product configuration selects operational routing. It does not grant transformation permission, create channel-specific build rules, add build-time ATP, or reduce ATP when nobody is logged in. The active canonical plan remains the source of what must be made.

Normal proposed task lifecycle:

- `waiting_dependencies`: required supply, predecessor operation, or physical handoff is not ready.
- `queued`: eligible work awaits an operator.
- `assigned` then `in_progress`: an accountable employee owns it.
- `awaiting_handoff`: this step is complete but material/job receipt by the next area is outstanding, when receipt is required.
- `completed`: owning-domain evidence proves all required work is complete.
- `blocked`, `paused`, and `cancelled` are explicit guarded alternatives, with reasons.

A job is not a single global status. Show assembly, picker assignment, packing, label, and dispatch progress separately. An order/shipment readiness projection derives from required quantities and dependencies.

The handoff record distinguishes WORK-ONLY (materials already at assembly), LABEL/PAPER handoff, and PHYSICAL MATERIAL/TOTE transfer. A work-only handoff creates no stock movement. “Sent” and “received” are separate evidence where physical custody matters. A digital queue never proves a physical label arrived.

## 7. Echelon's label-first assembly example

Example identifiers are illustrative, not live records: order 12345 requires 2 P5; 10 EA exist at assembly stock location ASSEMBLY-INPUT. Authorized path is 5 EA -> 1 P5.

1. Canonical claim reserves those actual 10 EA for the order. Two P5 do not physically exist yet.
2. Gun displays “2 P5 require assembly; deliver shipping label to ASSEMBLY-PACK-01.” Handoff creates/updates one durable order-linked work item; duplicate taps replay.
3. Picker prints in ShipStation as today. Internal job identity already exists, so it can queue before provider label data reaches Echelon. Link the exact provider account, shipment/package, active label version and tracking when authoritative data arrives. Never use tracking alone as the primary job ID.
4. Picker passes the label to the station. Their pick assignment may finish once their other required tasks are done. ShipStation queue behavior is preserved; Echelon still shows assembly outstanding.
5. Authorized assembler executes the job from the station queue, which can atomically assign/start it without a separate Claim click, and matches the label/order. A scan may open a job only on an unambiguous active binding; unknown or voided labels need review.
6. After actual assembly, the canonical owner consumes 10 EA and creates 2 P5, preserving costs and reservation ownership. If output goes directly into this shipment's box, perform the distinct order allocation/pick step through the owner; do not require a fictitious shelf trip.
7. The same employee continues directly into the combined station's packing instructions, verifies contents, applies the existing label, and closes the package. No mode switch, self-handoff, or separate pack station is mandatory.
8. Dispatch remains separately evidenced. Cancellation, missing parts, incomplete output, superseded pack plans, and wrong/voided labels remain visible exceptions.

If there are already two finished P5, the plan can use them directly and no assembly task is needed. Mixed ready/build quantities get separate linked tasks; “assembly required” is derived per order line/quantity, not a permanent SKU boolean.

CRITICAL integration check: E16 proves distinct status concepts, not the actual production event chain. Trace label print -> ShipStation event -> Echelon shipment/claim handling -> channel writeback before activation. If that chain closes claims or marks internal work terminal early, normalize/gate it at the provider boundary. Preserve raw events; do not silently alter customer notifications or provider configuration. Any necessary externally visible timing change requires separate review.

## 8. Data and domain contracts — proposed logical records

Final migration names remain subject to boundary review; these are not implemented tables.

| Record | Required fields / ownership contract |
| --- | --- |
| Station | ID, unique warehouse/code, fixed work-area identity, enabled/paused/retired state, capabilities, compatible input/output/staging/exception location bindings, equipment bindings, definition revision. Mobile resources and their sessions are linked separately. No inventory quantities. |
| Work pool, workflow profile, and routing rule | Warehouse/optional building/zone scope, required capability, eligible stations/resources, combined/staged steps, assignment/handoff presentation, priority rule, SKU/operation override, immutable version/reason. Work items snapshot the effective profile. Capability pool is not an ATP pool. |
| Worker scope and session | Existing user ID; explicit warehouse/zone/station eligibility; device ID; selected context; authenticated start/end; no device-based permission grant. Reuse identity ownership for grants. |
| Work item and lines | Warehouse, owner-domain ID, order/line/shipment references as relevant, canonical claim/revision/operation references when relevant, exact SKU/UOM and required/completed quantities, state, version, priority, dependencies, routing snapshot. No parallel reservation ledger. |
| Assignment history | Work item, employee, station/session, assigned/start/end timestamps, current fencing/version token, reason; only one active exclusive assignment per executable task/quantity. Team jobs use explicit bounded subtasks. |
| Handoff | Upstream/downstream IDs, expected content/quantity, destination, work-only/material/label kind, sender and recipient evidence, sent/received/blocked state. |
| Container / label link | Reuse verified existing shipment/parcel identity; add tote/cart custody only where no suitable owner exists. Exact contents and provenance; label version/provider binding separate from job ID. Reprint must not recreate work. |
| Event / command receipt / outbox | Actor, entity versions, command/request hash, exact owning-operation receipt, before/after evidence, correlation ID, timestamp, durable idempotency key; outbox for asynchronous projection/notification. |

Tasks project existing domain work; they do not independently claim that builds, receipts, or parcels are complete. Generic task status edits cannot bypass owning-domain guards. Inventory claims reserve stock; worker assignments reserve an employee's responsibility. Use different names and IDs.

Proposed APIs: get scoped queue; open/close station session; assign/start/pause/reassign work; record handoff receipt; execute typed operation; record exception; retrieve execution receipt. Validate inbound and outbound DTOs. Session determines actor; client supplies expected version and idempotency key, never trusted actor identity.

Command result: task/version, typed domain outcome, applied quantities, domain receipt IDs, remaining work, and actionable errors. Uncertain timeout returns/retrieves durable receipt; do not blindly repeat physical work.

## 9. Safety, concurrency, and failure controls

- Exactly one active task per owning operation/revision/purpose; duplicate creation and completion are idempotent.
- Serial assignment/quantity ownership prevents two workers making the same units. Expired device presence is not permission to repeat a physical build. Started work requires recovery evidence before reallocation.
- Preserve the owning module's established lock order. For canonical operations, integrate assignment/version validation inside the same transaction AFTER the existing authority/graph/order/claim/resource lock sequence, or use a reviewed fenced owner command. Never hold a new task lock and then enter an owner that takes locks in the opposite order. Exact cross-owner lock matrix is an implementation prerequisite.
- Inventory changes and completed operation/task evidence must commit atomically when in the same database. Asynchronous receipts use durable inbox/outbox and reconciliation, not “fire and forget.”
- Partial completion records exact consumed inputs, outputs, cost layers, and remaining reservations. E17 means this is a substantive backend requirement, not already available via the full-build command.
- Cancellation after work starts is not “release everything.” Preserve consumed/output stock and history; release only proven remaining claims; route physical cleanup/rework to an authorized task.
- A printer error does not undo assembly; a label void does not undo stock. Superseded label binding blocks use of the old label and retains the work.
- Same-station multi-capability work still enforces step ordering and exact parcel contents. Do not let “pack complete” skip missing assembly or other order lines.
- Pack close/dispatch require only the required contents of that authorized shipment, not unrelated held lines or a different warehouse's shipment.
- Offline gun/terminal: retain observation intent locally only if implemented securely; do not display successful financial/inventory posting without a server receipt. Reconnect/retry is idempotent.
- Picker discrepancy observations remain supported. Route valid observed stock through canonical reconciliation; do not force an inaccurate system count, nor create unsupported quantities/costs.
- Count/QA/rework stock eligibility uses inventory policy and existing authority; station setup must not turn reserve bins off for ATP or double-subtract safety stock.
- No station login, assignment, or handoff changes ATP by itself. Actual owner transactions feed existing canonical availability/publication paths.
- Multi-warehouse tasks cannot silently rebind stock or shipment. Physical transfer and approved fulfillment reassignment are separate commands.

## 10. UI placement

- Warehouse administration -> Stations & work areas: code, warehouse, capabilities, location/equipment bindings, active/paused status. One bench can enable several modes.
- Warehouse administration -> Workflow profiles & Work routing: Small team preset, combined/staged work, eligible station pools, and explicit inheritance/effective values. Hide unused configuration while retaining the same engine. SKU/operation overrides link from Supply & Transformations; do not create another recipe editor or second replenishment resolver.
- Existing Roles -> operation permissions and typed WMS scope; employee profile -> eligible warehouses/stations and optional default.
- Operations -> My work and Station queue: waiting, active, blocked, handoff, completed; scan/search by supported job/label/tote identity.
- Existing gun -> prominent assembly-required quantities and handoff instructions; current picker work can finish independently.
- Existing Builds and Packing pages -> specialized execution views over shared work/assignment state. Retain recipe administration and pack-plan evidence; retire duplicate local queue ownership only after the replacement is live and verified.
- Warehouse lead -> cross-station board: unassigned, overdue, blocked, paused, awaiting physical receipt, operator ownership, stale device sessions, label printed with assembly incomplete.
- Order/shipment -> timeline of work, inventory evidence, assembly, label, packing, and dispatch. Do not reuse one “shipped” flag for every stage.

Devices: optional barcode scanner, printer, scale, camera, or dimensioner bindings by capability. No hardware purchase assumed. Device connectors and print verification are separate from a configured device record.

## 11. 3PL and marketplace handling

A 3PL is an external fulfillment node, not an internal station with a pretend employee login. External jobs have provider-owned execution and normalized inventory/order/dispatch evidence. Show those in an external-work monitor alongside, but distinct from, internal station queues.

Inventory we own at a 3PL remains warehouse/node-specific. Ship-to-3PL uses internal transfer-out/dispatch and external receipt/reconciliation. No arrival is assumed from our dispatch.

Channels select approved fulfillment nodes through existing routing. Internal station routing stays provider-agnostic. Shopify Canada/3PL, Dropship via eBay, and TikTok via Shopify do not get duplicate station implementations. A future direct TikTok adapter remains separate channel work.

## 12. Relationship to the ATP migration

Retain the migration's exact physical stock, one planner, explicit directed transformations, warehouse awareness, durable claims, immutable costs, and publication authority.

Add the missing operational contract: “who performs which planned work, where, using which device, with what handoff and completion evidence.” This is not a new ATP formula, new inventory strategy, or reason to postpone work behind speculative build-time capacity.

The historical migration document's older equivalence/rollback/canary passages are superseded by its Status And Authority / Decisions Recorded sections and later reviewed decisions. BOUNDARIES.md also contains legacy fungible ATP examples; use its ownership rule, not its old arithmetic, for this design.

WMS_ARCHITECTURE.md mentions pack-station/tote flows (lines 30–44), but its narrative is not implementation proof. Update it after approval to describe actual adopted station, custody, and inventory semantics.

The new station framework does not by itself solve legacy-reservation adoption at first canonical cutover. That previously identified decision remains open; do not bury it in this larger WMS project.

## 13. Implementation packages after design approval

These are cohesive engineering packages, not a commitment to a particular PR/deployment count.

1. Shared foundation: station/capability/location model, scoped RBAC, sessions, assignment/handoff contracts, task projections, idempotency/audit, supervisor board. No automatic activation of physical workflows.
2. Complete outbound vertical: gun assembly handoff -> canonical execution -> packing/label association -> dispatch evidence; include partials, combined/multi-parcel orders, cancellation, device recovery, provider-event timing, and role tests. This is the acceptance-critical path for the current ATP effort.
3. Full-suite connections: receiving/QA/putaway, replenishment/mobile transfers, consolidation, returns/rework, counts, and external-node visibility using the same framework and existing domain owners. Do not reimplement those domains.

Build the shared model for the whole catalogue now; do not require separate physical hardware or parallel queue engines for each capability. Existing operational UIs remain available until their replacements pass end-to-end verification. No required canary cohorts or repeated production inventory experiments.

## 14. Required verification before any activation

- Unit/state-machine tests: routing specificity, missing route, scoped access, task/quantity dependencies, partials, priority, no-work direct stock, digital/non-inventory exclusion.
- PostgreSQL integration tests: concurrent claim/start/complete, duplicate requests, transaction rollback, stale sessions, reassignment fencing, cancellation during build, exact lot/cost/claim accounting, lock-order conflicts.
- UI tests: picker can hand off and continue; station login sees only permitted work; mixed pick/build quantities; same-bench assembly+packing; two employees competing; blocked work remains visible.
- Device/provider tests: scan wrong/voided/duplicate label; label data arrives late; printer fails; network response lost; repeated provider event; reprint vs replacement shipment; no duplicate label purchase or stock movement.
- Full warehouse walkthrough with representative stock: receipt -> putaway -> replenishment -> reserve -> pick/assembly -> pack -> dispatch -> return/disposition/count.
- Verify inactive code cannot change live authority. Read-only production reconciliation and a separately approved activation plan precede writes.
- No tests were run for this proposal; it changes documentation only. No live quantities, production roles, installed scanners, or event timing were verified.

## 15. Review questions and next checks

Discuss these one at a time, not as an implementation questionnaire:

1. Confirmed: two employees, combined receiving/movement/stow, and picker-performed replenishment. Review section 3A's combined-flow defaults before asking for more physical station detail.
2. Remaining: equipment and actual handoff destinations/permissions. Do not ask for a separate employee or station for each capability; reuse individual accounts and combined work areas.
3. Which SKU operations must go to assembly, and which are permitted inline? Store routing apart from transformation permission.
4. Is physical label arrival acknowledged by scan, job selection, or another existing action? Confirm reliable label/order identity; do not assume a tracking barcode uniquely identifies the job.
5. How are partial assemblies, missing components, end-of-shift work, and cancellations physically handled? Complete the exact quantity/ownership contract.
6. Technical check: trace actual ShipStation label and dispatch events through Echelon, inventory claims, and channel writeback. No speculative promise that current label-first behavior already works with canonical deferred assembly.
7. Technical check: prove existing tote/cart/parcel identity and custody coverage; reuse, extend, or add only what is genuinely missing.
8. Technical check: complete a per-module lock/transaction and writer-ownership matrix and current disposable-PostgreSQL test route.

## 16. External reference patterns

These support design distinctions, not claims about Echelon or a mandate to copy another product.

- Microsoft documents warehouse work templates/pools and location directives as separate controls for how work is performed and where inventory moves: [Control warehouse work](https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/control-warehouse-location-directives).
- Its worker setup separates worker identity, warehouse defaults, and permitted mobile workflows: [Manage warehouse workers](https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/manage-warehouse-workers).
- Its packing setup associates authorized workers with packing profiles and default warehouse/location: [Pack containers for shipment](https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/packing-containers).
- Its quality workflow can route incoming stock through inspection and subsequent disposition-specific movement: [Quality management for warehouse processes](https://learn.microsoft.com/en-us/dynamics365/supply-chain/inventory/quality-management-for-warehouses-processes).

Recommendation is the Echelon-specific design above. No claim is made that every robust warehouse needs every physical station, labor-standard feature, or vendor workflow.
