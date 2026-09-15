# Inventory availability and channel controls — human UI designer handoff

Date: 2026-09-14

Owner: Echelon / Card Shellz

Status: **Design handoff. Previous AI-generated UI direction rejected. No replacement UI approved.**

## Read this first

Design an understandable operator experience around an existing inventory architecture. Do not copy the current Inventory Exposure page or the rejected prototype. Do not turn backend tables, DTOs, or provider-specific API requirements into the navigation hierarchy.

The operator's main questions are:

1. Which warehouses can supply this sales channel?
2. How much of that available inventory should this channel offer by default?
3. Which products or individual package SKUs need different settings on this channel?
4. What quantity results, why, and is that a proposed quantity or what the marketplace actually shows?
5. What is saved, what is active, and who currently controls publication?

The owner currently runs a two-person warehouse operation. Routine work must be quick. The architecture must also support multiple buildings, external fulfillment, and much larger teams without making today's operator navigate those future complexities on every edit. [D1]

### Explicit owner direction for this handoff

- Stop the current UI effort; hand the problem to a human designer before returning to implementation/deployment.
- The accepted business hierarchy is **channel → eligible warehouse supply → channel defaults → product/SKU exceptions**, not an ATP search screen as the starting point.
- Do not require a universal **Store / inventory location** dropdown. Shopify locations are not a common setting across all channels.
- **Do not require a written reason for routine draft edits.** The owner explicitly rejected that interaction. Automatic audit history is still necessary; auditability is not the same as forcing people to justify ordinary edits.
- Do not reintroduce separate inventory formulas per channel, editable calculated balances, or legacy controls as a shortcut.
- The rejected prototype is not a design system, approved screen specification, or implementation acceptance test. Its fictional accounts, warehouses, quantities, and locations are not production facts.

This document specifies domain behavior, operator needs, constraints, and known engineering gaps. It intentionally does **not** prescribe page layout, card arrangements, dropdown sequences, or a particular interaction design.

## 1. Problem statement

The inventory program started because physical quantities, availability calculations, transformations, reservations, and channel publication had competing authorities and inconsistent paths. The replacement architecture separates these responsibilities while routing availability and promises through one planner. The remaining UI must make that architecture usable, not expose its internal plumbing. Historical defect reports are not a current deployment audit. [D2, D3, E1–E8]

The current Inventory Exposure page combines global publication controls, warehouse preparation, provider destination creation, source assignments, policy editing, mappings, readiness, stop/resume, and preview. Labels include technical concepts such as destination owner, allocation dial channel, compatibility node, provider scope, and publication authority. Routine draft saves require reasons. The owner rejected both this experience and the subsequent prototype. [E24; owner feedback above]

The failed approach conflated four independent questions:

- **Supply:** where can this item actually be fulfilled?
- **Selling policy:** how much of its ATP do we expose to this channel?
- **Integration setup:** which external account and item identity receive updates?
- **Operational authority:** are changes merely saved, active, allowed to publish, or externally managed?

The new design must make these distinctions clear without making the operator manage the implementation concepts every time.

## 2. Evidence status and how to use this brief

Labels used throughout:

- **CODE:** confirmed in the inspected repository snapshot; not proof of production activation.
- **DECISION:** accepted business behavior recorded in the review documents or explicit owner statements.
- **REQUIRED CHANGE:** a requested design/engineering change, not an existing completed capability.
- **GAP / UNKNOWN:** not implemented in the inspected path or not sufficiently verified.
- **ILLUSTRATION:** invented numbers or configuration used to explain behavior, never live data.

Source snapshot: `9dd34e74e3fa7a033d936ccd3c4ae17a20bdacf5`, inspected in `C:\Users\owner\Echelon\.codex-worktrees\inventory-exposure-ux-20260914`.

During this handoff, `origin/main` was refreshed to `5bdb3ba95dd647867134db620fffa2238c1eb174`. The reviewed inventory-planning module, channel module, exposure DTO, and InventoryExposure page were unchanged between those commits. Other shipping/OMS and dropship shipping-estimate work did change; this document is not an audit of that unrelated work. PR #1262 was verified merged, with merge commit `7cc2b35d0d22448f03390791a3fa5812d5020d8d` ancestral to refreshed main.

No production database, provider account, application release, runtime authority, current inventory, current channel configuration, or external automation was queried for this handoff. Do not label the new model live based on this document. The repository's pre-activation completion record explicitly separates implementation from production cutover and later stabilization/retirement. [D3]

## 3. Shared architecture in plain language

**The system records physical stock once, determines what can actually be promised, then applies channel selling limits. Sending that quantity to Shopify or eBay is a separate delivery step.**

| Layer | What it owns | What it must not do |
| --- | --- | --- |
| Catalog | Exact product/SKU identity, package quantity, sellable/internal-only identity, physical tracking requirements | Invent physical stock or conversion permission |
| Quantity journal | Exact SKU/lot/warehouse/location movements and custody; derived lot/bin balances | Calculate channel selling policy |
| Inventory policies | Location promise eligibility and inventory safety protection | Become separate per-channel stock formulas |
| Transformation authority | Explicit allowed package conversions and component builds | Infer reverse permission from package sizes |
| Canonical planner | Warehouse-aware ATP and shared-resource order planning | Manufacture physical units merely because they are promiseable |
| Channel policy | Reduce ATP using resolved percentage, holdback, cap, cutoff, eligibility, sharing semantics | Increase ATP or override inventory safety stock |
| Publication system | Exact desired quantities, durable delivery, provider acknowledgement/readback, retries and stops | Recalculate ATP independently |
| Provider adapter | Authentication, external identity, provider-specific request/response translation | Decide a second inventory formula |
| UI | Show server evidence, collect intended changes, explain scope and outcome | Calculate its own ATP or quietly activate/publish on draft save |

Evidence: E1–E10, E19.

### Quantity path

1. Determine which supply warehouses are permitted for the relevant channel/destination.
2. In each warehouse, evaluate eligible physical supply, outstanding claims, inventory safety, and allowed transformations/builds.
3. Produce exact-SKU ATP independently within each warehouse.
4. Combine only the eligible warehouse results.
5. Resolve each channel policy field independently: SKU override, otherwise product default, otherwise channel default.
6. Calculate the channel's desired quantity.
7. If authority, target state, mappings, and publication controls permit, enqueue an absolute quantity update.
8. Deliver through the appropriate provider adapter and record acknowledgement and readback separately.

An order follows the same inventory authority: plan all its lines against shared resources, claim them atomically, then execute pick/conversion/build/fulfillment work. A displayed ATP value is not itself a stock reservation. [E2, E5–E10, E19]

## 4. Vocabulary that must remain distinct

| Term | Meaning for this product |
| --- | --- |
| Product | A product family that may have several sellable package SKUs |
| SKU / variant | The exact package identity; one P5 unit is one five-piece pack, not one piece |
| Warehouse | A physical stock/fulfillment site known to Echelon |
| Bin / warehouse location | A position inside a warehouse, such as a pick slot or reserve bin |
| Reserve bin / backstock | A physical storage location; its stock can contribute to ATP |
| Reserved / claimed stock | Stock capacity owned by an order; not another physical location |
| Promise safety stock | Inventory intentionally protected from promises before channel limits |
| Channel holdback | A channel selling reduction applied after that channel's percentage |
| Sales channel | A business selling relationship/attribution and its selling policies; may differ from the integration transporting the order |
| Connection | Credentials and identity for one external store, seller account, or dropship store |
| Publication target | Internal identity describing the exact external destination to update; the UI need not use this engineering term |
| Shopify location | Shopify-specific inventory/fulfillment identity; not a generic channel, store, or Echelon bin |
| Fulfillment node | Internal representation of an internal warehouse, 3PL, or configured virtual node tied to warehouse scope; not free extra stock |
| ATP | What the planner can promise for an exact SKU in the specified warehouse/supply scope |
| Proposed quantity | A computed result from specified saved configuration and inventory evidence |
| Desired quantity | The quantity the active publishing process intends to send |
| Acknowledged quantity | A provider accepted a write request; not proof of a subsequent inventory readback |
| Observed quantity | A timestamped quantity read back from the exact provider identity |

Evidence: E1–E13, E15, E19; reviewed meanings in D1/D2.

Do not use “available,” “reserve,” “location,” “channel,” or “published” interchangeably. In particular, a Shopify location, an eBay seller account, and an Echelon reserve bin are not equivalent objects.

## 5. Warehouses and supply assignment

### Business behavior

- **DECISION:** eligible internal warehouses, networks, and 3PL nodes can supply an appropriate channel; there is no hardcoded rule that Shopify/eBay/dropship may use only one named warehouse.
- **CODE:** a missing source binding is a blocker, not permission to use every active warehouse.
- **CODE:** ATP is computed per warehouse before aggregation. Components in separate buildings cannot be combined to create one assembled unit without an actual transfer and receipt.
- **DECISION:** in-transit stock is owned inventory, but not available at the receiving warehouse before receipt.
- **CODE:** source selection does not itself move stock, change inventory ownership, change a 3PL's fulfillment responsibility, or grant publication authority.

Evidence: E2, E8, E13; D1/D2 warehouse and 3PL decisions.

### Important implementation gap: source inheritance

**Historical approved intent:** fulfillment scope can resolve SKU → product → channel default. [D2, lines 113–120]

**Implemented source-binding path:** one set of fulfillment nodes per `publicationTargetId`. The save contract and runtime lookup have no product/SKU-specific source sets. Product/SKU policy inheritance is implemented, but that is a different capability. [E8]

**Designer/engineering handoff:** preserve the desired business ability in the requirements, but flag narrower warehouse exceptions as an engineering gap. Do not claim it works today; do not silently remove it; do not create fictitious external destinations as a workaround for missing SKU warehouse rules. Engineering must settle and implement the source resolver before any proposed narrower controls can be represented as functional.

### External mapping belongs to integration setup

The common business choice is which warehouses may supply the channel. Provider-specific account/location mappings must remain exact behind that experience. If multiple publishing destinations exist, the design must reveal which one is being configured when necessary; it must not silently edit them all or arbitrarily choose the first. A single configured destination does not justify a mandatory extra picker. [E8–E11]

## 6. Channel defaults and product/SKU overrides

### One resolver, applied independently to every field

**CODE:** first explicit value wins: **SKU → product → channel**. A missing required field is unresolved configuration and blocks normal publication; it must not become implicit unrestricted ATP. [E6, E7]

Examples of field-level inheritance:

- SKU supplies 80% while product supplies a holdback of 5 and channel supplies the cutoff.
- Changing the SKU percentage does not disconnect the SKU from inherited holdback/cutoff settings.
- Choosing “inherit” is different from explicitly setting zero.
- An explicit “no maximum” is different from inheriting a parent's maximum.

**Important:** the channel percentage is a **default**, not a hard master ceiling. A SKU override of 80% replaces a channel default of 50%; it is not 40%, and it is not capped at 50%. Likewise a SKU eligibility override can replace channel-default eligibility. Do not present either default as an emergency switch that unconditionally affects every SKU. [E6]

### Complete channel control inventory

| Business control | Code field | Meaning and scope | Required interaction clarity |
| --- | --- | --- | --- |
| Offer percentage | `shareBps` | 0–10,000 basis points, equivalent to 0–100%; channel/product/SKU field | Show human percentages, not basis points; label inheritance and effective source |
| Keep off this channel | `holdbackSellableUnits` | Whole sellable-SKU units subtracted after percentage | Not warehouse safety stock; identify pack/case units |
| Maximum quantity to show | `maxPublish` / resolved `maxPublishSellableUnits` | Explicit no limit or a whole-SKU cap | No limit must be a choice, not a magic string people type |
| Show zero below | `minPublishSellableUnits` | If the remaining quantity is smaller than this threshold, show zero | Never increases quantity; not a minimum order quantity or guaranteed availability |
| Item eligibility | `eligible` | Resolved false yields zero; narrower rules can override broader defaults | Distinguish inherited default from an explicit SKU exclusion and from publication stop |
| Sharing semantics | `allocationSemantics` | `exposure` or `partitioned` | Explain stock-sharing behavior rather than relying on enum names |

All quantity fields use units of the exact sellable SKU. A cap of 4 C25 means four cases, not four pieces. [E6, E7]

### Exact calculation contract

```text
if resolved eligible is false:
    desired = 0
else:
    shared = floor(canonicalAtpUnits * shareBps / 10_000)
    afterHoldback = max(0, shared - holdbackSellableUnits)
    capped = min(afterHoldback, maxPublishSellableUnits or no limit)
    desired = 0 if capped < minPublishSellableUnits else capped
```

The UI consumes the server's result and breakdown. It does not implement this as a second live calculator. The internal calculation field `publishedUnits` does not prove that any provider was called. [E7, E15]

### Sharing does not create stock

- **Exposure:** two channels can independently advertise availability backed by the same pool. Their displayed quantities need not add up to ATP. Orders still compete for the same atomic resource claims.
- **Partitioned:** configured shares are checked across overlapping destination/SKU/warehouse supply. Over-budget combinations block readiness/publication. This is not the same as physically moving inventory into channel-specific bins.
- Do not silently normalize over-budget rules or make an independent product/SKU package partition that prevents a customer buying all feasible stock of one package size.
- Asynchronous marketplaces still create an oversell risk between external purchases and Echelon ingestion. Shared claims prevent double ownership internally; they do not prove that every external checkout is synchronously validated.

Evidence: E5, E7, E19; D1 whole-order/basket decisions. The last point is an architectural limitation, not a claim that a current oversell incident occurred.

### Returning an override to inheritance

**CODE:** individual fields may be null/inherited, but the current policy schema rejects a version with every field null. **GAP:** removing an entire saved override requires a verified retirement/removal contract. Do not simulate removal by copying today's parent values into an explicit override; that would break future inheritance. [E6]

## 7. What is common across channels, and what is not

The common product experience is supply selection, channel defaults, narrower exceptions, quantity explanation, and publication status. Connection setup must adapt to the actual provider capability. A provider name appearing in a schema does not prove that its adapter exists. [E9–E13]

| Selling path | Confirmed integration shape | Common controls | Provider-specific setup / limitations |
| --- | --- | --- | --- |
| Shopify | Store connection; quantity writes/readbacks are location-scoped | Same canonical ATP and channel policy | Exact Shopify store connection, Shopify inventory location, mapped inventory item. This location concept must not be required for eBay. |
| Shopify Canada | Shopify-shaped transport; user identifies Canadian 3PL fulfillment and external quantity management | Visibility and applicable supply/policy explanation | Do not take over publishing or local fulfillment just because a warehouse is assigned. Actual live ownership/configuration needs verification. |
| Direct eBay | Account-scoped adapter; exact verified seller account and registered inventory-item/SKU identity | Same canonical ATP and policy | Seller account/item mapping, not Shopify-style inventory location. |
| Dropship through eBay | Separate dropship-store credential owner; eBay account-scoped transport | Same canonical ATP and policy; no separate dropship inventory formula | Identify vendor/store/seller account accurately. Internal Dropship OMS attribution is not itself an external marketplace inventory location. |
| TikTok through Shopify | User-stated operating route; source code classifies Shopify-origin TikTok sales separately | Shared inventory authority through the relevant Shopify route | Sales attribution is not proof of a separately addressable publisher. Do not offer apparently independent TikTok quantities unless the integration can enforce them. |
| Future direct TikTok | No direct TikTok publication transport registered in the inspected composition | Must reuse canonical ATP, policy and publication contracts | Thin provider adapter required. Actual account/warehouse/item scope and readback capabilities need discovery; do not assume Shopify or eBay semantics. |
| Future marketplace/provider | Not enabled merely by adding an enum value | Reuse the same domain decisions | Implement and verify authentication, identity, absolute quantity write, acknowledgement, readback, error handling, and ingress normalization. |

Evidence: E9–E13, D2 lines 146–190. This table describes Echelon's reviewed adapters, not every possible feature the external marketplaces offer.

### Four responsibilities that must not be conflated

1. Who owns the stock commercially?
2. Who holds and fulfills it physically?
3. Which system supplies inventory observations?
4. Which system is allowed to publish the selling quantity?

A 3PL can hold Echelon-owned stock and fulfill orders while the 3PL's existing integration controls publication. Selecting that warehouse as a source must not silently transfer any of those responsibilities. Current target publication authority values are `echelon`, `external_provider`, and `manual`. [E13, E14]

## 8. Upstream inventory controls the designer must understand

These explain the quantity shown in channel controls. They must have one owner and must not be duplicated as independent channel settings.

### Physical on-hand, claims, and custody

After the approved quantity opening, the immutable quantity journal is the physical quantity authority. `inventory_levels.variant_qty` and lot `qty_on_hand` are projections of unpicked exact-SKU stock, not independently maintained balances. Reserved stock overlaps on-hand; picked and packed are custody buckets. [E1, D4]

Picking a claimed unit moves it out of on-hand and consumes its reservation while increasing picked custody. ATP must not subtract that same unit again merely because it is now picked. An ATP projection or saved channel rule does not create a physical conversion, lot, or stock movement. [E1, E5]

Digital/nonshipping or explicitly untracked items must not be forced through physical stock configuration and quantity publication. Internal-only component SKUs are different: they can be real tracked physical supply for transformations while being excluded as customer-facing ATP/claim/listing targets. Do not confuse an internal component with a digital product, or publish zero to a digital listing merely because it has no physical inventory. [E22; D3]

### Location promise eligibility

- Reserve/backstock is normally promise-eligible even when not directly pickable.
- Receiving, staging, and quarantine are hard exclusions in the current planner.
- Inactive/frozen locations or inactive warehouses are excluded.
- Explicit location policy supports inherit/eligible/ineligible within the planner's hard gates.

**GAP:** a backend draft endpoint exists for location policy; a complete operator editor was not located in this review. Do not claim it is already a usable workflow. [E2, E23]

### Promise safety stock

**DECISION/CODE:** inventory-owned, before transformations and channel limits. Scope resolution is warehouse/SKU → SKU → business default. The internal SKU scope key is `network:variant:<id>`; do not mistake that label for an extra pooled network deduction. One resolved policy applies for each warehouse resource. [E3]

| Mode | User meaning | Relevant fields |
| --- | --- | --- |
| Inherit | Use the broader setting; not valid as unresolved business default | `mode: inherit` |
| Off | Protect zero units for this resolved scope | `mode: off` |
| Fixed units | Protect this exact-SKU quantity | `fixedUnits` |
| Days of cover | Protect demand-based stock; use fixed fallback when demand is untrusted | `daysOfCoverMilliDays`, `untrustedDemandFallbackUnits`, `demandMethodVersion` |

Trusted demand protection is `ceil(dailyDemandMilliUnits * daysOfCoverMilliDays / 1,000,000)`. Untrusted demand uses the configured fallback **instead**, not the maximum of fixed and calculated values. A SKU may explicitly turn protection off. [E3]

Demand trust is system-derived evidence, not a casual operator checkbox. The current method checks observation coverage, event/consumption sufficiency, recency, identity/classification problems, and snapshot freshness. Current constants include a 28-day window, at least 14 observed days, two source events, two active consumption days, three consumed units, recent consumption within 14 days, and a 36-hour snapshot freshness gate. These are implementation/version details, not numbers the designer should hardcode. Show the system result, timestamp, method, fallback being used, and actionable explanation. A complete exceptional trust-override UI is not verified. [E3]

Approved demand includes legitimate external consumption such as customer shipments, replacements, concessions, and appropriately classified component consumption. Transfers, replenishment, picking/packing, package conversions, count corrections, RTV, and one-off disposal do not become ordinary sales demand. Received returns do not erase historical consumption. [D1 lines 95–117; E3]

**Purchasing/reorder safety is separate.** Existing Product Detail `safetyStockDays` describes reorder calculations. It is not this ATP floor; the accepted terminology is Purchasing Safety Buffer. [E23, D2]

### Transformations and builds

- Physical stock supplies its own exact SKU without needing a conversion.
- Another package can contribute only through complete, valid, allowed directed paths.
- Every reverse direction requires its own explicit authority; equal piece counts do not grant it.
- Component builds bind exact recipe versions, quantities, and relevant warehouse scope.
- Build-to-promise is item/product-owned, not a per-channel toggle. The current implementation has a product-model `buildToPromiseEnabled` and output recipe bindings; do not imply a separately verified arbitrary per-SKU enablement switch.
- Build time, throughput, queue capacity, and channel promise horizons are outside the accepted current scope.
- A missing or malformed conversion contributes zero through that path; it does not erase valid exact finished stock. Validation blockers and available exact stock must be explainable separately.

**Confirmed UI discrepancy:** the owner asked for source-owned columns showing each source SKU's outgoing paths. Current `DestinationColumns` renders incoming authority by output SKU. The designer must not treat that existing layout as an approved decision. [E4; D1 lines 167–170]

### Orders and warehouse execution boundary

Whole-order planning claims shared resources for all order lines together. Execution then records the actual source SKU, warehouse/bin/lot, conversion/build operation, and custody movement. A promised build is not an already assembled or picked item. The owner needs genuine assembly handoff without forcing a small operation into unnecessary role/station handoffs for every task. These execution screens are adjacent work, not a requirement to put workstation administration inside channel settings. [E4, E5; owner decisions]

The accepted physical-discrepancy path allows a picker to record genuinely found inventory with an audited discrepancy/custody transaction rather than forcing the picker to obey a known-wrong stock count. Do not weaken inventory authority silently; exceptions must remain explicit and traceable. [D1 lines 227–250; D2]

Future cart/checkout validation is a caller of the whole-order contract. It must not be represented as enabled today or block Shopify checkout until the full authenticated integration is built, tested, reviewed, and activated. [D1 section 6; D3]

## 9. 3PL and multi-building behavior

**DECISION:** one warehouse/3PL may serve multiple channels, and one channel may draw from multiple eligible warehouses. Commercial ownership, physical custody, fulfillment execution, and publishing ownership remain separate. [D2, E13]

Required 3PL lifecycle, not a claim of fully operational integration:

1. Receive owned stock locally.
2. Dispatch a transfer; stock becomes owned in transit, not destination ATP.
3. Record 3PL receipt, including partial receipt/discrepancies.
4. Capture trustworthy external physical inventory observations with separate on-hand, committed, damaged, inbound, and available meanings.
5. Observe/submit orders according to the actual fulfillment owner; track node-level demand and fulfillment.
6. Reconcile stock, shipments, cancellations, returns, and losses against durable evidence.

Shopify's displayed available quantity is a channel observation, not automatically physical 3PL on-hand. The legacy Shopify quantity-import path is guarded after the ledger opening; it is not proof of a complete provider-neutral external custody integration. [E13, D4]

For the user-described Canadian 3PL, design visibility without implying that Echelon will pick locally or take over existing publishing. Exact provider, facility, feeds, permissions, freshness, and reconciliation capability remain unknown. Use “externally managed” and meaningful observation age, not misleading editable quantities or a green “synced” badge unsupported by evidence.

## 10. Saving, applying, activation, and publication are different actions

The designer must distinguish these concepts without turning ordinary edits into an engineering ceremony.

| State/action | Meaning | Required clarity |
| --- | --- | --- |
| Unsaved edit | Browser-only proposed input | Navigation must not silently lose meaningful work; no claim of live effect |
| Saved draft | Persisted configuration, not authoritative live settings | Simple routine save; automatic audit; no mandatory prose reason |
| Calculated preview | Server result using identified saved definitions and inventory evidence | Show snapshot age, rule source, blockers, and that no provider write occurred |
| Active configuration | The sealed definition versions the live authority uses | Distinguish from newer pending drafts |
| First canonical cutover | Full reviewed authority transition, including verified opening and conservative publication | Restricted operational action, not a normal Save button |
| Desired/queued | Active policy generated work for a specific external identity | Not yet provider-confirmed |
| Acknowledged | Write accepted by provider | Not the same as observed/read-back quantity |
| Verified / drifted | Readback agrees or disagrees with intended quantity | Timestamp, exact scope, actionable cause/recovery |
| Stop publishing | Prevent future eligible writes | Does not automatically make storefront stock zero |
| Resume publishing | Restore a previously stopped target under fresh checks | Not first-time activation; not applying pending draft changes |

Evidence: E14–E20.

### Remove mandatory draft reasons correctly

**Current code:** policy/source/mapping saves require nonblank `changeReason`; the existing UI follows that contract. The service already captures authenticated actor/time/request identity and persists audit events. The policy save's audit currently records `before: null`, so it is not proof of complete before/after field history. [E14]

**REQUIRED CHANGE:** routine saves must not require written justification. Preserve automatic actor, time, action, affected scope, changed fields/before-after values, version, and retry identity. An optional note may be available without blocking the task.

This requires coordinated API/schema/service/audit changes. Do not merely remove the textbox while the API still rejects saves. Do not invisibly submit a fabricated user reason or treat placeholder text as consent. System-generated action metadata should be identified as system metadata.

The rejection of routine draft reasons does not rescind the separately approved role gate and evidence for first activation or sensitive inventory/publication operations. Existing sensitive-action reason requirements remain current behavior; the human designer should make their risk and consequences clear rather than spread them across every form. [D1 section 12; E14, E16]

### GAP: routine post-cutover application of changes

The reviewed cutover promotes selected draft definitions and seals active pointers. The stopped-target resume path explicitly uses prior active/sealed definitions and ignores pending drafts. A general post-cutover “apply these changed drafts” workflow has **not been proven by this review**. [E17, E18]

The designer should specify the intended normal edit → save → review effect → apply interaction. Engineering must map it to a verified configuration activation contract before implementation. Do not label Resume as Apply, do not build a fake activation button, and do not force a full first-cutover workflow onto every normal edit without an explicit architectural decision.

### Preview scope and freshness

The existing preview is saved-draft-preferred and uses saved ATP shadow evidence; it is not an unsaved-form simulator or an on-demand marketplace inventory read. Changes to a broader rule may have no effect on an example SKU that overrides that field. The displayed effective source must explain why. If instant unsaved previews are designed, they require a server-side side-effect-free contract, not browser ATP arithmetic. [E6, E15]

## 11. Publishing controls and operational recovery

### Global versus destination controls

- **Global publication control** is shared across channels. It is not scoped to whichever channel happens to be selected on the screen.
- Each publication target has `disabled`, `preview`, or `live` state and separate publishing ownership.
- External/manual ownership does not become Echelon-owned because a target is prepared or a source is selected.
- A target stop disables the target and supersedes pending work. Global stop prevents new admission while retaining catch-up evidence.
- A later target resume performs fresh exact identity/readiness/readback checks and queues current absolute quantities rather than replaying stale positive values.
- A channel-wide grouped stop must accurately disclose all affected targets. Atomic grouping across several targets is not established merely by a single-target endpoint.
- Pausing updates is not publishing zero. Setting a default to zero is not necessarily an all-SKU emergency stop because narrower overrides can win.

Evidence: E6, E16, E18–E20.

### Durable publication contract

The publication system sends **absolute quantities**, not increments/decrements. Identity includes the exact owner/connection, provider scope, external item/SKU, and monotonic desired revision. It preserves zero updates, serializes competing work, retries classified transient failures, records failed/dead-letter work, and compares provider readback separately. Adapters cannot recalculate the quantity. [E9, E19]

Operator statuses should answer practical questions: waiting, sending, confirmed, mismatched, retrying, blocked, stopped, or externally managed. Technical row states can remain available in diagnostic detail; do not imply every internal state is a required manual workflow step.

### Failure and empty-state requirements

| Situation | What must be communicated | What must not happen |
| --- | --- | --- |
| No assigned eligible sources | No supply scope configured; identify the owning configuration task | Fall back to all warehouses |
| No overrides | Broader applicable rules are in use | Claim there is no inventory |
| Search finds no rows | No matching records for this search/filter | Claim all items inherit channel defaults directly |
| Missing account/SKU mapping | Exact destination/item setup is incomplete | Guess account, location, or SKU |
| Invalid conversion | Explain excluded path and its validation issue; retain separately valid exact-stock evidence | Infer missing reverse authority |
| Stale/missing ATP or demand evidence | Show unknown/stale state and required refresh; show safety fallback where applicable | Display a fresh-looking zero or success |
| Conflicting edit | Someone changed the revision; compare/reload before save | Silently overwrite another user's work |
| Save response lost | Preserve original command identity and recover its outcome | Create a second unrelated write automatically |
| Provider write acknowledged, readback absent | Awaiting verification | Mark fully verified |
| Provider mismatch | Show desired versus observed quantity and observation time | Claim internal desired quantity is marketplace truth |
| Publishing stopped | Updates stopped, with scope | Imply customers can no longer buy remaining provider inventory |
| Externally managed 3PL | Owner and observation limits | Offer a routine takeover switch or editable “physical stock” from provider availability |
| Partitioned shares exceed budget | Explain overlapping supply and conflicting rules | Silently renormalize or publish unsafe totals |

These requirements derive from E2, E6–E9, E14–E20 and owner feedback. Exact final status wording and recovery interactions are design work, not approved copy.

## 12. Permissions and audit

Current capability checks are `inventory_planning:view`, `inventory_planning:edit`, and `inventory_planning:activate`. They are permissions assigned to roles, not proof of a fixed role named “Activator.” No two-person approval is required by the accepted plan. [E16, D1]

- View: quantities, effective rules, inherited sources, statuses, history.
- Edit: routine draft configuration within permitted scope.
- Activate: sensitive activation/readiness/publication controls where implemented.

Design for a single authorized operator today without requiring artificial handoffs. Scale through capability-based access and meaningful scopes, not a forced new workstation/role for every operation. Do not show an editable setting if the current user/system authority cannot save it; provide a clear reason and path where appropriate.

The backend retains validation, optimistic revision checks, idempotency, transactions, locking, and immutable evidence. Those are not form fields the operator should have to understand. The UI must handle their visible outcomes: validation error, conflict, pending result, success, retryable failure, or blocked action. [E14, E16–E19]

## 13. Worked examples for design validation

All numbers below are **ILLUSTRATIONS**, not production configuration. Use explicit units and assumptions in any design based on them.

### A. Channel default and one SKU exception

Assume the permitted warehouses provide 60 and 40 P5 packs of canonical ATP after all upstream policies: 100 packs total. Resolved eligibility is true, sharing semantics are exposure, and the zero-below cutoff is 0. Channel default is 50%. Product holdback is 5 exact-SKU units; for P5 that means 5 packs. P5 overrides offer percentage to 80% and maximum to 60 packs.

Result: `100 × 80% = 80; minus 5 = 75; capped to 60` → **60 P5 packs**. It is not `100 × 50% × 80%`.

Changing the channel default to 40% does not affect P5's explicit 80% override. Returning only that percentage to inheritance yields `100 × 40% − 5 = 35` packs; the independent maximum still applies. [E6, E7]

### B. Package conversion does not erase exact stock

Assume one eligible warehouse, safety off, no claims, 100 EA and 10 P5 physically on hand.

| Allowed paths | EA ATP | P5 ATP |
| --- | ---: | ---: |
| Neither direction | 100 | 10 |
| P5 → 5 EA only | 150 | 10 |
| 5 EA → P5 only | 100 | 30 |
| Both explicit directions | 150 | 30 |

These are alternative promises against shared stock, not independent quantities that can all be purchased together. Missing EA → P5 permission contributes zero from the 100 EA but leaves the 10 physical P5 available. [E4, E5; D1]

### C. Days of cover and a fallback

Trusted demand of 2 P5/day × 3 days protects 6 P5. If evidence is untrusted and fallback is 4, protection is 4 instead. Off protects zero. A channel cannot undo that safety deduction. [E3]

### D. Multiple marketplaces and one stock pool

The same eligible warehouse can supply Shopify and eBay. In exposure mode, both may advertise quantities backed by the same stock; an accepted claim changes remaining availability for both. In partitioned mode, overlapping shares must pass the common budget check. Provider identities differ, but the stock calculation does not. [E5, E7–E11]

### E. Shopify and a Canadian 3PL

The company owns stock that is physically held by a 3PL. The existing external integration controls the Shopify Canada quantity. The operator needs visibility and reconciliation, not a workflow that assumes local picking or silently replaces that publisher. A saved source assignment must not be treated as permission to take over. [D2, E13]

### F. Draft versus active settings

An operator changes a SKU cap from 60 to 20 and saves without typing a justification. The change is automatically audited and remains visibly pending until the correct apply/activation process succeeds. With enough eligible ATP and no other limiting rule, a saved-draft preview can show 20 while the active cap remains 60; the active cap itself is not proof of the provider's quantity. Resuming a stopped target must not secretly apply that pending cap. [E14, E15, E18; REQUIRED CHANGE for reason-free saving]

## 14. Deliverables requested from the human designer

1. A provider-neutral information architecture organized around the operator's business tasks, with clear boundaries to inventory policies and publishing operations.
2. Desktop designs and usable narrow/mobile behavior for the primary channel configuration and SKU-exception tasks.
3. Interaction specifications for inheritance, explicit zero, no limit, source selection, SKU units, save/conflict/recovery, and active versus pending configuration.
4. Provider-specific setup variants for Shopify, direct eBay, dropship eBay, and externally managed fulfillment, without a fake universal location field.
5. Clear quantity explanation and provenance: warehouse contributions, effective rule sources, saved snapshot time, proposed/desired/observed distinctions, and exclusions/blockers.
6. Empty, loading, stale, permission-denied, validation, conflict, stopped, external-management, and provider-failure states.
7. A proposed normal post-cutover change/apply workflow, explicitly marked for engineering contract validation.
8. A list of backend/API changes needed to make the design real; do not conceal gaps with nonfunctional controls.
9. An annotated handoff with components, behavior, accessible labels/keyboard flow, responsive rules, and realistic but explicitly sample data.

The designer may challenge wording and navigation, but should not silently change inventory math, ownership, inheritance, or production authority. Bring unresolved domain decisions back to the owner; do not ask the owner to resolve low-level technical details that engineering can verify.

## 15. Acceptance checklist before UI implementation resumes

- A new operator can identify supplying warehouses, set a channel default, and make one SKU exception without understanding publication-target internals.
- Routine edits do not demand prose reasons.
- Shopify-specific location fields appear only where actually relevant; eBay is not forced into that model.
- Real connection identity remains unambiguous even when one provider has multiple accounts.
- Channel default versus hard stop is unmistakable; percentages do not accidentally multiply.
- Each field clearly shows inherited versus explicit value and where the effective setting comes from.
- Safety stock, channel holdback, reserved claims, and reserve bins are not conflated.
- Pack/case units are explicit and alternatives are not presented as additive stock.
- Sources, stock custody, external observations, and publishing ownership are separate.
- Pending changes, active settings, calculated preview, queued work, acknowledgement, and provider observation cannot be mistaken for one another.
- The UI consumes server evidence; no new browser ATP formula or per-provider quantity formula exists.
- Narrow/mobile layouts keep the main action discoverable without hidden sideways scrolling.
- Engineering has resolved source-scope inheritance, whole-override removal, and normal post-cutover apply behavior before those interactions are advertised as working.
- Designs are reviewed by the owner before implementation; usability of the rejected prototype's mechanics is not acceptance evidence.

## 16. Open engineering and operational checks

| Item | Status / next owner |
| --- | --- |
| Remove mandatory routine draft reasons and improve complete automatic audit deltas | REQUIRED CHANGE; engineering must update request validation and persistence, not just UI |
| Channel/product/SKU warehouse-source inheritance | Historical decision versus target-only implementation gap; domain/API resolution required |
| Remove an entire override cleanly | Current all-null rejection; verify/create explicit retirement contract |
| Apply new drafts after initial cutover | Not proven; do not repurpose stopped-target resume |
| Dedicated location eligibility editor | Backend exists; complete client workflow not located |
| Source-oriented transformation controls | Current destination-oriented UI conflicts with recorded preference |
| Build-to-promise scope wording | Product-model toggle and output bindings verified; do not promise an unverified independent per-SKU switch |
| TikTok-independent throttling through Shopify | Separately addressable publication scope not proven; no independent direct adapter wired |
| Direct TikTok adapter | Future work; provider requirements/capabilities need evidence |
| Canadian 3PL feeds, facilities, reconciliation and publication owner | User context known; production integration completeness unknown |
| Current deployed SHA, migrations, runtime authority and ledger opening | Not verified in this handoff |
| Live channel connections, exact targets, source assignments, policies, mappings and readbacks | Read-only production preflight needed before activation |
| Other external inventory publishers / marketplace automations | Cannot be excluded through repository inspection alone |
| Post-cutover stability/retirement gate | Requires real operational evidence and an explicit gate, not a UI mockup |

No hypotheses about current production quantities are used as design facts. Multiple account/location names and all example quantities in the rejected prototype were fictional.

## 17. Deployment boundary after design approval

The UI design task does not authorize deployment or inventory changes. After design approval:

1. Engineering maps interactions to verified contracts and resolves the listed gaps in coherent, reviewable implementation batches from a clean worktree.
2. Test common controls and provider-specific cases, including inheritance, conflict/retry recovery, zeros, missing mappings, readback failure, and external ownership.
3. Verify the actual deployed release and runtime authority read-only. Do not infer activation from a merged PR.
4. If still pre-cutover, retain the approved full-catalog shadow/readiness process and separately authorized first activation. No required canary cohorts.
5. First activation uses verified physical opening and claims, conservative provider publication/readback, atomic canonical authority change, then full absolute publication/verification.
6. After first cutover, do not return to known-wrong legacy formulas. Later rollback requires an eligible verified canonical version and the appropriate evidence.
7. Remove obsolete controls and code only after replacement authority and operational stability are verified. Do not continue maintaining two editable sources of truth.

These are architecture/deployment boundaries from D1–D4 and E17–E20, not a claim that any step was executed for this handoff.

## Appendix A. Source evidence for engineering

All code paths and line numbers below refer to the pinned `9dd34e74e3fa7a033d936ccd3c4ae17a20bdacf5` worktree named in section 2. The designer should be able to understand the main brief without opening the code. Engineers must refresh these references before implementation.

| ID | Exact files / functions / relevant lines |
| --- | --- |
| E1 | `server/modules/inventory/domain/quantity-ledger.ts:10–15` `quantityBalanceSchema`, `:74–85` `normalizeQuantityCommand`; `server/modules/inventory/infrastructure/quantity-ledger.repository.ts:27` `postInsideTransaction`, `:41–99` `post`, `:183–195` `project` |
| E2 | `server/modules/inventory-planning/domain/inventory-availability-planner.ts:34–35` default/hard-excluded location sets; `:488–495` `isPromiseEligibleLocation`; `:625–694` `buildContext`; `:1052–1124` `projectCanonicalAtp` |
| E3 | `shared/types/inventory-promise-safety-admin.ts:10–47` demand constants, `promiseSafetyAdminScopeSchema`, `promiseSafetyAdminValueSchema`; planner `:498–605` `resolveSafety`; `server/modules/inventory-planning/domain/inventory-demand-evidence.ts:111–237` `planDemandEvidenceSnapshots`; `server/modules/inventory-planning/infrastructure/inventory-promise-safety-admin.repository.ts:474–697` `loadDemandConsumptionEvents` |
| E4 | `shared/types/inventory-availability-planner.ts:113` onward: `plannerTransformationPathSchema`, `plannerRecipeBindingSchema`, `plannerTransformationModelSchema`; planner `:697–758` `buildContext`, `:892–1005` `fulfillUpTo`; `client/src/pages/SupplyTransformations.tsx:1919–1927` `DestinationColumns`, `:2151` `BuildAuthorityEditor` |
| E5 | Planner `:1150–1234` `planCanonicalClaim`; `server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts:4160–4293` `claimOrder` |
| E6 | `shared/types/inventory-channel-exposure.ts:19–52` `channelExposurePolicyScopeSchema`, `channelExposurePolicyValueSchema`; `server/modules/inventory-planning/domain/inventory-channel-exposure.ts:84–136` `resolveChannelExposurePolicy` |
| E7 | `server/modules/inventory-planning/domain/inventory-channel-exposure.ts:139–172` `calculateChannelExposure`, `:175–195` `findPartitionedShareOverages`; `server/modules/inventory-planning/application/inventory-channel-exposure-runtime.service.ts:419–438` `applyPartitionOverages` |
| E8 | Exposure shared types `:77–103` source version/head, `:227–250` `savePublicationSourceBindingDraftRequestSchema`; runtime service `:237–278`, `:292–352` `planTarget`; `server/modules/inventory-planning/infrastructure/inventory-channel-exposure-runtime.repository.ts:288–308` source-binding query in `loadSelectedPublicationTargets` |
| E9 | `server/modules/inventory-planning/application/inventory-publication-transport.ts:17–62` absolute request and `InventoryPublicationTransportAdapter`; `server/modules/inventory-planning/application/inventory-publication-outbox.service.ts:91–138` `publishAndVerify` |
| E10 | `server/modules/channels/adapters/shopify.adapter.ts:72–75` supported location scope, `:131–167` `pushInventory`, `:223–281` `readInventory` / `setInventoryLevel`, `:619–667` `getCredentials` |
| E11 | `server/modules/channels/adapters/ebay.adapter.ts:107` account scope, `:234–256` `pushInventory`, `:361–379` inventory-item update, `:411–443` `readInventory`, `:892–920` `assertExactPublicationAccount`, `:1073–1090` `exactEbayInventoryItemKey`; `server/modules/channels/channel-inventory-publication-transport.adapter.ts:30–40` canonical bridge |
| E12 | `server/modules/dropship/infrastructure/dropship-ebay-inventory-publication.adapter.ts:82–87` adapter owner/provider/scope, `:97–135` absolute write/read, `:137–215` `loadContext`; `server/modules/oms/archon-commerce-origin.ts:29–48` `classifyCommerceOrigin`; `server/services/index.ts:365–378` transport registry composition |
| E13 | `server/modules/warehouse/domain/warehouse-inventory-source.ts:27–50` `resolveConfiguredWarehouseSource`, `:69–89` `planWarehouseInventorySource`; `server/modules/inventory/application/inventory.use-cases.ts:2352–2403`, `:2467–2475` `syncWarehouse`; `server/modules/inventory/application/legacy-quantity-import.ts:9–15` `assertLegacyQuantityImportAllowed` |
| E14 | Exposure shared types `:128–140` target schema, `:209–250` draft save requests, `:281–290` mapping save; `shared/types/warehouse-inventory-source.ts:40–47` source-preparation reason; `server/modules/inventory-planning/application/inventory-channel-exposure-admin.service.ts:101–117` `savePolicyDraft`; admin repository `:630–674`, `:743–750` `savePolicyDraft` transaction/audit |
| E15 | `server/modules/inventory-planning/infrastructure/inventory-channel-exposure-admin.repository.ts:887–997`, `:1152–1169` `preview`; exposure shared types `:338–399` preview contract; runtime repository `:194–247` proposed/active definition selection |
| E16 | `server/modules/inventory-planning/interfaces/http/inventory-channel-exposure.routes.ts:61–225` `registerInventoryChannelExposureRoutes`; `server/modules/inventory-planning/interfaces/http/inventory-publication-global-control.routes.ts:26–39` permission/command boundary |
| E17 | `server/modules/inventory-planning/infrastructure/inventory-cutover-definitions.repository.ts:26–69` `promoteInventoryCutoverDefinitionsInsideTransaction`; `server/modules/inventory-planning/infrastructure/inventory-cutover-commit.repository.ts:24–95` `commit` |
| E18 | `server/modules/inventory-planning/infrastructure/inventory-publication-target-stop.repository.ts:119–159` `stop`; runtime repository `:205–218`, `:237–247` `loadPreviewPublicationTargetForResume` and active-only selection; `server/modules/inventory-planning/infrastructure/inventory-publication-target-resume.repository.ts:179–363` resume transaction; `shared/types/inventory-publication-target-resume.ts:109–121` result |
| E19 | `server/modules/inventory-planning/application/inventory-publication-outbox.service.ts:52–138`; `server/modules/inventory-planning/infrastructure/inventory-publication-outbox.repository.ts:62–177`, `:182–340`, `:361–606`; `server/modules/inventory-planning/infrastructure/quantity-publication-admission.repository.ts:240–330` admission/serialization |
| E20 | `server/modules/inventory-planning/infrastructure/inventory-publication-global-control.repository.ts:40–158` global control transaction; `server/modules/inventory-planning/application/inventory-legacy-admin-control.service.ts:30–207` authority guards; `server/modules/inventory-planning/application/inventory-publication-work-coordinator.service.ts:42–128` runtime coordination |
| E21 | `server/modules/inventory-planning/application/inventory-availability-runtime-atp.service.ts:56–64`, `:162–194` authority-routed ATP; `server/modules/inventory-planning/application/inventory-channel-quantity-runtime.service.ts:77–206` `readProduct` |
| E22 | `server/modules/inventory-planning/infrastructure/inventory-availability-shadow.repository.ts:411` onward `captureGraphInsideTransaction`; planner `:1066–1070`, `:1167–1171` internal-only target restrictions; physical snapshot excludes nonshipping/untracked inventory |
| E23 | `server/modules/inventory-planning/domain/inventory-availability-master-data.contracts.ts:37` `locationPromisePolicyDraftSchema`; master-data HTTP routes `:157–168`; `client/src/pages/SupplyTransformations.tsx:1217` safety-panel placement; `client/src/pages/promise-safety-policy-panel.tsx:219–360` `PromiseSafetyPolicyPanel`; `client/src/pages/ProductDetail.tsx:2896` purchasing/reorder safety setting |
| E24 | `client/src/pages/InventoryExposure.tsx:87–102` separate reason state; `:486` onward current mixed setup/control page; `:595–606` target reason requirement; `:730–732` routine source draft reason; `:213`, `:249`, `:294` request payloads |

### Decision and history records

- **D1:** `docs/INVENTORY-ATP-CHANNEL-ALLOCATION-PHASE-0-REVIEWED-DECISIONS.md` — accepted physical, safety, transformation, whole-order, channel and activation rules. Its historical status statements are not current production facts.
- **D2:** `docs/INVENTORY-ATP-CHANNEL-ALLOCATION-PHASE-0-FINAL-REVIEW-CLOSURE.md` — later Phase 0 decisions, channel ownership, TikTok-through-Shopify, 3PL target architecture. Historical defect/live-state tables are dated, not fresh observations.
- **D3:** `docs/INVENTORY-AVAILABILITY-PREACTIVATION-COMPLETION-2026-09-14.md` — repository implementation census and explicit boundary between code completion, production activation, stabilization, and retirement.
- **D4:** `docs/INVENTORY-SINGLE-QUANTITY-AUTHORITY.md` — immutable quantity journal, protected projections, verified opening, and retirement boundaries. Supersedes older independently maintained quantity assumptions.
- Original plan: `docs/INVENTORY-TRANSFORMATION-ARCHITECTURE-AND-MIGRATION-PLAN.md`, read in full for this handoff. Its opening authority section explicitly supersedes historical equivalence-group/canary/legacy-rollback assumptions. Do not revive them from old sections.
- Latest owner statements in this conversation override prior proposed screen layout and mandatory routine draft-reason UX. No fresh UI design has been approved.

## Appendix B. Handoff provenance and limits

This is a documentation-only handoff informed by three bounded read-only reviews: upstream quantity/planning, channel/provider behavior, and exposure/lifecycle contracts. No Figma or prototype editing was performed as part of this handoff. The earlier Figma attempt was incomplete because the Starter-plan tool limit blocked further writes; its file is not a deliverable to use as an approved design.

The earlier local prototype and its browser tests describe a rejected illustration, not production behavior or a design mandate. Do not use their successful browser checks to argue that the UI is acceptable.

No application code, production data, inventory, recipes, ATP, reservations, Shopify/eBay/TikTok quantities, channel settings, or publication authority changed. This brief does not authorize a PR, deployment, cutover, or provider action. The next step is human design review, followed by explicit agreement on implementation.

## Appendix C. Implementation record — Channel Inventory rebuild (2026-09-15)

Status: **implemented on branch `claude/zealous-wright-mfwqu6`, pending owner review.** The
owner asked for the UI to be rebuilt around the architecture in this brief rather than
waiting for a separate design pass. This appendix records what was built, which contract
changes it required, and which gaps remain open (and are shown as gaps in the UI rather
than hidden behind non-functional controls).

### What replaced the Inventory Exposure page

`client/src/features/channel-inventory/` (route `/channels/inventory`, nav label
**Channel Inventory**; `/channels/inventory-exposure` redirects). The page is organized
around the accepted business hierarchy:

| Operator question | Where it lives |
| --- | --- |
| Which channel am I working on? | Channel rail (left) with per-channel destination status dots |
| Which warehouses can supply this channel? | **Supply** tab per destination; warehouse checklist; active vs saved-draft summary; explicit "no supply configured" failure state (no all-warehouse fallback) |
| How much should this channel offer by default? | **Selling rules** tab → channel default: six controls in human units (percent, whole SKU units, "No limit" as an explicit choice) |
| Which products/SKUs need different settings? | **Selling rules** tab → exceptions list (grouped by product) and an editor that shows, per field, the inherited value and its source next to the option to override it |
| What quantity results and why? | **Quantities** tab: server preview rows only; snapshot age, rule provenance, warehouse contributions, per-row calculation chain, blockers; "Proposed" is labelled as not the marketplace's current quantity |
| What is saved, active, and who publishes? | Destination strip pills (Publishing / Calculating only / Not publishing / Externally managed / Manual) and the **Publishing** tab: publisher, pending drafts, activation boundary, and the sensitive commands behind reason dialogs |

Design rules honoured from this brief: no universal store/location picker (Shopify
locations appear only for Shopify connections, fetched live; eBay and Dropship eBay use the
provider-verified account id); no written reason on routine saves (optional collapsed note
only); reasons remain required for readiness inclusion, stop, resume, and the global
switch; the UI computes no availability or channel quantity of its own; percentages are
never shown as basis points; pack units are stated per SKU; saved drafts are visibly
"pending activation" and Resume is never labelled Apply.

### Contract and persistence changes

- `shared/types/inventory-channel-exposure.ts`: `changeReason` is optional/nullable on the
  three routine draft saves (policy, source binding, SKU mapping) and on disabled
  destination registration; blank notes normalize to `null`. Version DTOs carry
  `changeReason: string | null`. The admin view adds `connections[].shopifyLocationId`,
  `connections[].providerAccount` (verified eBay identity), `dropshipStores[].verifiedExternalAccountId`,
  and `policySubjects` (catalog labels for every product/SKU rule); `policyHeads` is no
  longer filtered to the selected product so exceptions can be listed per channel.
- `migrations/247_inventory_channel_controls_optional_change_note.sql`: `change_reason` /
  `update_reason` become nullable with null-aware check constraints on the versioned
  definition tables, their heads, and `inventory_publication_targets`. No rows rewritten.
- `inventory-channel-exposure-admin.repository.ts`: every routine draft save now records an
  audit **before** image (the replaced draft, or the active definition it supersedes) and the
  optional note under `context.note`; nothing fabricates a reason.
- Sensitive contracts (`setInventoryPublicationTargetPreviewStateRequestSchema`,
  stop, resume review/resume, global control, cutover) are unchanged and still require a reason.

### Gaps still open (surfaced in the UI as such)

| Gap | How the UI treats it today |
| --- | --- |
| Product/SKU-scoped warehouse supply | Supply tab states supply is per destination; no per-item control is offered |
| Removing an entire product/SKU rule | Editor requires at least one explicit field and says removal is not available yet |
| Routine post-cutover "apply saved drafts" | Publishing tab lists pending drafts and states activation is the reviewed cutover; Resume is documented as using the active configuration only |
| Per-SKU desired/acknowledged/observed status | Quantities tab labels "Proposed" and points to the sync log; no read endpoint exists yet |
| Location promise-eligibility editor | Not part of this page (inventory policy, Supply & Transformations) |
| Providers without an adapter (e.g. Amazon, TikTok direct) | Listed, but destination registration is disabled with an explanation |

### Verification

- Unit: `client/src/features/channel-inventory/__tests__/*` (view-model, formatting, request
  builders, page contract), updated server tests for optional notes and required sensitive
  reasons, updated cross-link tests.
- Browser (Playwright, mocked API): `test/browser/inventory-publication-target-resume.spec.ts`
  rewritten for the Publishing tab flow; `inventory-authority-gates.spec.ts` updated for the
  new name and path.
- Not verified here: production data, provider accounts, or any live publication.
