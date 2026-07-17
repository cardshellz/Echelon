# Shipping Rate Management UX Design Specification

**Status:** Designer brief
**Date:** July 16, 2026
**Audience:** Product designer, UX designer, frontend engineer, shipping-domain engineer
**Related architecture:** [SHIPPING-ENGINE-DESIGN.md](./SHIPPING-ENGINE-DESIGN.md)

## 1. Purpose

Design a clear, durable administrative experience for configuring what Card Shellz charges for shipping across its owned checkout and fulfillment programs.

This is not a carrier-rate shopping screen. It is a pricing-management surface for Card Shellz-owned shipping options such as **Standard Shipping**, **Priority Shipping**, **Overnight Shipping**, and **Pallet Freight**.

The existing implementation in `ShippingSettings.tsx` and `RateTableBuilder.tsx` is a functional engineering scaffold. It demonstrates available data and operations, but its layout, hierarchy, interaction model, and visual treatment are not the target design. **Do not pixel-match the current screen.**

### Non-negotiables at a glance

- Organize the experience as **Pricing Program -> Shipping Option -> Destinations -> Rates -> Review**.
- Make the pricing context, especially dropship versus customer checkout, visible before a row is opened.
- Use a program overview, program detail, and full-page editor. Do not put the entire workflow in a modal.
- Keep carrier products and carrier service codes out of pricing.
- Never require technical IDs or CSV to complete ordinary work.
- Replace the permanently expanded state grid with compact bulk destination management.
- Use an editable rate matrix for both shipment-weight and pallet-count pricing.
- Preserve a safe draft/revision lifecycle and show the impact before activation.

## 2. Product Outcome

An operations administrator must be able to:

1. See which shipping pricing program is used by Shopify, dropship, an internal website, or a warehouse-specific flow.
2. Understand which customer-facing shipping options are available in each program.
3. Create and maintain prices without knowing database IDs, provider service codes, or CSV syntax.
4. Apply one set of prices to many states and add ZIP-prefix exceptions when necessary.
5. Configure parcel prices by total shipment weight.
6. Configure pallet-freight prices by pallet count, with an optional total shipment-weight ceiling.
7. Save incomplete work as a draft, review coverage and errors, and deliberately activate a valid revision.
8. Return later and edit, clone, replace, retire, or inspect the configuration without re-importing it.

## 3. Primary Users

### Shipping administrator

Owns shipping prices, destination coverage, service promises, and activation. This user understands the business but should not need to understand the database schema.

### Operations lead

Reviews active pricing, diagnoses quote coverage, and may create a revision. This user needs strong read-only summaries and explicit status.

### Engineer or analyst

May use CSV for large updates, inspect validation detail, or compare revisions. CSV is a secondary power-user path, not the primary interface.

## 4. Locked Product Model

The design must preserve these concepts and relationships.

```text
Pricing context
  -> selects one Pricing Program
       -> contains one Rate Table revision per Shipping Option
            -> contains Destination Groups
                 -> contains parcel Weight Bands OR freight Pallet Bands
```

### 4.1 Pricing context

Identifies where and why a price is used.

| Example channel | Purpose | Meaning |
|---|---|---|
| Shopify | Customer checkout | Price shown to a shopper in Shopify checkout |
| Internal website | Customer checkout | Price shown on a Card Shellz-owned website |
| Dropship | Vendor fulfillment charge | Shipping amount charged to the dropship vendor |

An eBay buyer-facing shipping price remains controlled by eBay fulfillment policies. A dropship order originating on eBay can still use the **Dropship / Vendor Fulfillment** pricing program for the backend amount charged to the vendor.

### 4.2 Pricing Program

**User-facing term:** Pricing program
**Internal object:** `shipping.rate_books`

A pricing program is a named collection of shipping prices used by one or more explicit pricing contexts.

Examples:

- Shopify Retail Rates
- Dropship Vendor Fulfillment Rates
- Internal Store Rates

Every program must visibly show **Used by** assignments. An administrator should never have to infer whether a program is used for dropship.

### 4.3 Shipping Option

**User-facing term:** Shipping option
**Internal object:** `shipping.service_levels`

A shipping option is the promise sold to the buyer or vendor. It is owned by Card Shellz and is not a carrier product.

| Shipping option | Fulfillment mode | Pricing basis | Initial promise |
|---|---|---|---|
| Standard Shipping | Parcel | Total shipment weight | 3-7 business days |
| Priority Shipping | Parcel | Total shipment weight | 2-3 business days |
| Overnight Shipping | Parcel | Total shipment weight | 1 business day |
| Pallet Freight | Freight | Pallet count | Configurable later |

The chosen shipping option determines the pricing basis. The user does not choose weight versus pallet count independently.

### 4.4 Rate Table Revision

A rate table revision prices one shipping option within one pricing program. It has a lifecycle:

```text
Draft -> Active -> Superseded or Retired
```

- A draft can be incomplete and is never used for live quoting.
- Activating a valid draft replaces the prior active revision for that program and shipping option.
- Historical active revisions remain inspectable.
- An active revision is not edited in place. The user creates a revision, reviews it, and activates it.

### 4.5 Destination Group

A destination group applies the same rate bands to multiple destinations.

A group contains:

- One or more US states or territories.
- Optional ZIP-prefix overrides associated with a state.
- Optional origin-warehouse scope.
- One complete set of weight bands or pallet bands.

Destination groups are a user-interface abstraction. The system expands them into individual rate rows when saved.

### 4.6 Carrier or Fulfillment Method

Carrier products such as USPS Ground Advantage, UPS Ground, FedEx 2Day, or an LTL provider are **not pricing keys** and must not appear in the rate-table editor.

Future fulfillment configuration will map eligible carrier methods to each Card Shellz shipping option. That later mapping must enforce that the WMS cannot buy a method slower than the option purchased at checkout.

## 5. Experience Principles

1. **Business language first.** Show names, purposes, states, warehouses, pounds, pallets, and dollars. Never ask for a database ID or provider service code.
2. **Context before numbers.** A user must know where the rates are used and what shipping option they price before entering amounts.
3. **Progressive disclosure.** Do not place program selection, 50-plus state checkboxes, ZIP overrides, bands, validation, CSV, and activation into one uninterrupted page.
4. **Visual editing is primary.** CSV import accelerates bulk work but always resolves into the same editable visual model.
5. **Coverage is visible.** A user should immediately understand which destinations, warehouses, measures, and shipping options are covered.
6. **Drafts are safe.** Editing cannot silently change live checkout behavior.
7. **Errors include remediation.** Every error must identify the affected group or row and offer a direct path to fix it.
8. **Status is explicit.** Draft, scheduled, active, superseded, retired, inactive option, and incomplete coverage cannot rely on color alone.
9. **Operational density.** This is a recurring admin tool. Favor compact, scannable tables and predictable controls over marketing-style cards or decorative composition.

## 6. Recommended Information Architecture

The Shipping area should retain separate tabs for:

1. Box Catalog
2. Shipping Options
3. Packing Attributes
4. Pricing Programs

Use **Pricing Programs** as the user-facing tab label instead of **Rate Tables**. Rate tables remain a detail within a program.

Carrier-method mappings may become a separate future tab named **Fulfillment Methods**. Do not mix them into pricing.

## 7. Required Screens and Flows

### 7.1 Pricing Programs Overview

This is the first screen for shipping-rate work.

#### Required header controls

- Page title: `Pricing Programs`
- Primary action: `Create pricing program`
- Search by program name.
- Filters: status, used-by channel, purpose, and warehouse scope.

#### Required list behavior

Use a compact table or grouped list. Each row must be clickable and include:

| Field | Requirement |
|---|---|
| Program name | Human-readable name, never only an internal code |
| Used by | Explicit channel and purpose labels |
| Warehouse scope | `All warehouses` or warehouse names |
| Shipping options | Standard, Priority, Overnight, Pallet Freight with status |
| Coverage | States covered, ZIP overrides, and measure coverage summary |
| Program status | Draft, active, or retired |
| Updated | Date and user if available |
| Actions | Open, create revision, clone, retire; destructive actions in a menu |

#### Empty state

Explain that a pricing program determines shipping charges for a checkout or fulfillment flow. Offer `Create pricing program`. Do not lead with CSV import.

### 7.2 Pricing Program Detail

The detail view must answer these questions without opening another modal:

1. Where is this program used?
2. Which shipping options are configured and active?
3. What destination and measure coverage exists?
4. Which revision is live?
5. What needs attention?

#### Program summary

- Program name and status.
- Used-by assignments as readable labels.
- Warehouse scope.
- Last activated and last edited metadata.
- Any program-level warning.

#### Shipping-option table

One row per Card Shellz shipping option:

| Column | Example |
|---|---|
| Shipping option | Standard Shipping |
| Mode | Parcel |
| Pricing basis | Shipment weight |
| Live revision | Active since Jul 16, 2026 |
| Coverage | 48 states, 3 ZIP overrides, 0-50 lb |
| Draft | In progress, 2 errors |
| Actions | View active, continue draft, create revision |

Clicking a row opens its rate-table detail or editor.

### 7.3 Create or Edit Rate Table

Use a full-page workflow with a persistent progress indicator or clear sections. Do not use a large modal for the entire workflow.

Recommended steps:

1. Context
2. Destinations
3. Rates
4. Review and activate

The designer may combine steps 2 and 3 in a master-detail workspace if that is easier to use, but the hierarchy must remain clear.

#### Persistent actions

- Back to program
- Draft status and save state
- `Save draft`
- `Review`
- `Cancel`

Use a sticky action bar on long pages. Saving a draft must not activate it.

## 8. Step Specifications

### 8.1 Step 1: Context

Required fields:

1. **Pricing program**
   - Searchable dropdown by program name.
   - Each option shows its Used by context beneath the name.
   - No internal code or ID entry.
2. **Shipping option**
   - Select Standard, Priority, Overnight, or Pallet Freight.
   - Show parcel/freight mode and delivery promise.
   - Mark an inactive option clearly and explain that rates can be prepared but cannot quote until the option is activated.
3. **Effective timing**
   - `Activate immediately` or `Schedule activation` when reaching the final step.
   - A new draft itself has no live effect.

Derived, read-only information:

- Pricing basis: shipment weight or pallet count.
- Currency: USD for the initial release.
- Channel and purpose assignments.

### 8.2 Step 2: Destinations

The current full-width grid of every state is not the target experience. Design a compact destination-group manager.

Recommended structure:

- Left pane or upper list: destination groups with compact summaries.
- Right pane or expanded row: selected group's destinations, warehouse, and overrides.
- Primary action: `Add destination group`.

#### State selection

Support:

- Searchable multi-select.
- Checkboxes with state name and abbreviation.
- Presets: Contiguous US, All US states, States and territories, Clear.
- Selected-state chips or a compact count summary.
- Immediate warning when a state is already assigned to another group at the same warehouse scope.

Do not require the user to scroll through a permanently expanded 50-state matrix.

#### Origin warehouse

- Dropdown populated with warehouse names.
- Default: `All warehouses`.
- Never request a warehouse ID.
- Explain that a warehouse-specific rate takes precedence over the all-warehouse default.

#### ZIP-prefix overrides

- ZIP override entry is secondary to statewide pricing.
- Select the state, then paste or type comma-separated 1-5 digit prefixes.
- Convert accepted prefixes into removable chips or rows.
- Show duplicates and invalid values inline before save.
- A ZIP override must have a statewide fallback for the same state and warehouse scope.
- At runtime, the longest matching ZIP prefix wins.

#### Group actions

- Rename group for operator clarity. Example: `Contiguous US`, `Alaska and Hawaii`, `Local PA rates`.
- Duplicate group.
- Copy rates from another group.
- Delete group with confirmation when it contains rates.

### 8.3 Step 3: Parcel Rates

Parcel options are priced once using **total shipment weight**, not units per package and not each package separately.

Use a compact, spreadsheet-like matrix:

| From | Through | Charge | Row actions |
|---|---|---|---|
| 0 lb | 1 lb | $8.99 | Delete |
| Over 1 lb | 5 lb | $11.99 | Delete |
| Over 5 lb | 20 lb | $15.99 | Delete |

Requirements:

- The lower boundary is calculated from the previous row and is read-only.
- The user enters the upper boundary and charge.
- Pounds are the displayed and entered unit.
- Store normalized integer values internally without exposing grams.
- Add, delete, and reorder bands without opening a modal.
- Support keyboard navigation and paste into consecutive cells.
- Offer `Copy bands to...` for applying a schedule to other destination groups.
- Clearly show the open-ended final band if supported, or require an explicit maximum and state that limit.

### 8.4 Step 3: Pallet Freight Rates

Pallet Freight is a Card Shellz shipping option with `freight` fulfillment mode. It is not a carrier name.

Use a matrix tailored to freight:

| From | Through | Maximum total shipment weight | Charge | Row actions |
|---|---|---|---|---|
| 1 pallet | 1 pallet | Optional | $___ | Delete |
| Over 1 pallet | 2 pallets | Optional | $___ | Delete |
| Over 2 pallets | 4 pallets | Optional | $___ | Delete |

Requirements:

- Pallet boundaries are whole numbers beginning at 1.
- Lower boundaries are calculated and read-only.
- Charge is for the shipment at that pallet-count band, not a per-pallet multiplier unless a future pricing mode explicitly says otherwise.
- `Maximum total shipment weight` is optional and displayed in pounds.
- Explain the weight ceiling in a tooltip: the band is eligible only when both pallet count and total shipment weight fit.
- Freight quotes require pallet count from the calling workflow.
- Freight class and accessorials are reserved inputs for later freight-provider integrations. Do not invent incomplete pricing controls for them now.

Future freight context may include:

- Freight class
- Liftgate
- Residential delivery
- Appointment delivery
- Limited-access location
- Stackability
- Pallet dimensions and total weight

The design should leave room for these future qualifiers in a separate advanced section or later configuration layer, but they are not part of the initial local-rate editor.

### 8.5 Step 4: Review and Activate

The review screen must summarize rather than repeat the editor.

#### Required summary

- Pricing program and Used by context.
- Shipping option, mode, promise, and pricing basis.
- Effective timing.
- Number of destination groups.
- States and territories covered.
- ZIP overrides.
- Warehouse scopes.
- Weight or pallet coverage.
- Total generated rate rows.
- Changes from the currently active revision.

#### Validation hierarchy

Use three levels:

1. **Blocking errors**
   - Missing price or upper boundary.
   - Overlapping or non-contiguous bands within the same destination scope.
   - Duplicate state or ZIP assignment at the same warehouse scope.
   - ZIP override without a statewide fallback.
   - Parcel/freight pricing-basis mismatch.
   - Invalid ZIP prefix, negative price, or invalid measure.
2. **Warnings requiring review**
   - States omitted from intended coverage.
   - Shipping option is inactive.
   - Unusually high or low price.
   - No warehouse-specific pricing where one previously existed.
3. **Informational notes**
   - Draft will supersede an active revision.
   - Number of generated database rows.

Each issue must link to the exact group and field that resolves it. Do not show an error list with no remediation path.

#### Activation actions

- `Save draft` remains available.
- `Activate now` is enabled only without blocking errors.
- `Schedule activation` supports a future date and time.
- If an active revision exists, state plainly that it will become superseded.
- Activation requires a concise confirmation dialog showing the program, shipping option, and effective time.

## 9. CSV Import and Export

CSV is an advanced accelerator, not the first screen or only editing method.

### Import flow

1. Choose `Import CSV` from the editor.
2. Download a template for Parcel or Pallet Freight.
3. Upload a file. Pasting CSV text may remain as an advanced alternative.
4. Show a preview table using business units and readable destinations.
5. Display row-level errors next to affected cells.
6. Let the user correct data or return to the file.
7. Convert valid data into destination groups and rate bands in the visual editor.
8. Continue editing normally before saving a draft.

### Required CSV columns

Parcel:

```text
state,zip_prefix,min_lb,max_lb,rate_usd
```

Pallet Freight:

```text
state,zip_prefix,min_pallets,max_pallets,max_total_lb,rate_usd
```

Warehouse-specific overrides can be selected after import or supported by a clearly documented optional warehouse column later.

### Export

Allow export of the current visual draft or active revision using the same business-unit format. Export must not expose database IDs.

## 10. Shipping Options Screen

The Shipping Options tab configures the promise sold at checkout, separate from prices.

Each option shows:

- Display name.
- Description.
- Parcel or freight mode.
- Business-day promise range.
- Active/inactive status.
- Number of active pricing programs using it.
- Warning when activating an option without sufficient rate coverage.

Carrier-method eligibility is not configured here in the initial release. A future Fulfillment Methods screen will handle that mapping and enforcement.

## 11. Matching and Precedence Rules to Communicate

The interface does not need to expose internal priorities, but it must make these outcomes understandable:

1. Warehouse-specific pricing beats an all-warehouse default.
2. A ZIP-prefix override beats the statewide price.
3. The longest matching ZIP prefix wins when multiple overrides match.
4. The shipment measure selects exactly one band.
5. The engine returns at most one quote per active shipping option.
6. Parcel pricing uses the shipment's total weight once.
7. Pallet pricing uses pallet count and, when configured, the total-weight ceiling.

A short `How rates are selected` help panel may explain these rules with one concrete example.

### Example

The Dropship Vendor Fulfillment program contains a Standard Shipping table:

- Pennsylvania statewide, 0-1 lb: $8.99
- Pennsylvania ZIP prefix 160, 0-1 lb: $7.99
- Pennsylvania statewide, over 1-5 lb: $11.99

A 12 oz dropship shipment to ZIP 16066 is charged $7.99. A 12 oz shipment to ZIP 19103 is charged $8.99. A 3 lb shipment to either ZIP uses the 1-5 lb statewide band unless that ZIP also has an override for that band.

## 12. Draft, Revision, and Destructive-Action Behavior

- `Edit active rates` creates a draft revision. It does not mutate live rows.
- A draft may be saved while incomplete.
- The user can resume a draft from the program detail screen.
- Only one clearly identified working draft should exist per pricing program and shipping option unless product later supports named scenarios.
- Deleting a draft does not affect active checkout pricing.
- Retiring an active table requires confirmation and must explain the quote impact.
- Historical revisions are read-only and show who activated them and when.
- Clone can copy a table to another program or shipping option only when the pricing basis is compatible.

## 13. Required States

The design deliverable must include:

- Loading skeletons.
- No pricing programs.
- Program with no shipping options configured.
- New blank draft.
- Partially completed draft.
- Draft with blocking errors.
- Draft with warnings only.
- Valid draft ready to activate.
- Active revision with no draft.
- Active revision with a draft in progress.
- Scheduled revision.
- Superseded revision.
- Retired program or table.
- API load failure with Retry.
- Save failure that preserves unsaved input.
- Inactive shipping option.
- No warehouses configured.
- CSV preview with mixed valid and invalid rows.

## 14. Content and Labeling Rules

Use these labels:

| Use | Do not use in operator UI |
|---|---|
| Pricing program | Rate book ID |
| Shipping option | Service-level code |
| Used by | Pricing-channel key |
| Origin warehouse | Warehouse ID |
| Statewide rate | Zone rule |
| ZIP-prefix override | Postal-prefix database row |
| Shipment weight | `min_measure` / `max_measure` |
| Pallet count | Pricing-basis enum |
| Charge | `rate_cents` |

Do not ask an operator to type:

- Database IDs.
- Internal codes.
- Carrier service codes.
- Warehouse IDs.
- JSON.
- CSV unless they intentionally choose the import workflow.

## 15. Accessibility and Responsive Requirements

- Every input has a persistent visible label.
- Status is communicated with text and icon, not color alone.
- All tables and selectors are keyboard operable.
- Focus returns predictably after adding or deleting a row.
- Validation is announced and linked to fields.
- State selection supports keyboard search rather than requiring pointer use.
- Dollar, pound, and pallet units remain visible while editing.
- Destructive controls have accessible names and confirmation.
- The primary admin target is desktop, but the overview and review screens must remain usable on a narrow laptop viewport.
- The rate matrix may use controlled horizontal scrolling on small screens; it must never clip values or actions silently.
- Sticky headers and actions must not cover editable rows.

## 16. Visual Direction

This is a quiet operational tool.

- Use compact typography and restrained visual hierarchy.
- Prefer tables, split panes, collapsible rows, and toolbars over large stacked cards.
- Avoid nested cards.
- Avoid oversized headings, decorative gradients, and marketing composition.
- Use status badges sparingly and consistently.
- Use familiar icons for add, duplicate, delete, import, export, and revision history.
- Reserve strong color for selection, blocking errors, and the primary action.
- Keep units aligned with numeric fields.
- Make repeated rates easy to compare vertically.

## 17. Designer Deliverables

The design package should include:

1. Pricing Programs overview.
2. Pricing Program detail with shipping-option rows.
3. Create-rate flow, Context step.
4. Destination-group manager with compact state selection and ZIP overrides.
5. Parcel weight-band editor.
6. Pallet-count editor with optional total-weight ceiling.
7. Review and activation screen.
8. Active revision detail and revision history.
9. CSV import preview and row-error treatment.
10. Loading, empty, warning, blocking-error, and failed-save states.
11. Desktop design at approximately 1440 px.
12. Narrow-laptop behavior at approximately 1024 px.
13. Clickable prototype for creating and activating one parcel table.
14. Clickable prototype for creating and activating one pallet-freight table.
15. Component and interaction annotations sufficient for frontend implementation.

## 18. Acceptance Criteria

The design is ready for implementation when a representative administrator can complete these tasks without explanation:

1. Identify which pricing program dropship currently uses.
2. Identify the live Standard Shipping revision and its coverage.
3. Create a draft for Dropship Pallet Freight without entering a technical ID or carrier code.
4. Apply one pallet schedule to the contiguous US.
5. Create different pallet prices for Alaska and Hawaii.
6. Add a Pennsylvania ZIP-prefix override.
7. Configure 1-pallet, 2-pallet, and 3-4-pallet bands with an optional total-weight ceiling.
8. Find and correct an overlapping band.
9. Save an incomplete draft without affecting live quotes.
10. Review exactly what will change before activation.
11. Activate the draft and understand which prior revision was superseded.
12. Reopen the active configuration and create another editable revision.

## 19. Out of Scope for This Design Pass

- Carrier account credentials.
- Buying shipping labels.
- Live carrier-rate shopping.
- Carrier-method eligibility and WMS enforcement.
- Freight-provider selection.
- NMFC classification workflow.
- Freight accessorial pricing.
- Pallet construction or palletization optimization.
- Parcel cartonization.
- eBay buyer-facing shipping-policy configuration.
- Membership discount policy, free-shipping benefits, or Shopify Functions UI.

These capabilities must integrate with the same service-level abstraction later, but they should not complicate the initial pricing-management experience.

## 20. Engineering Constraints for Handoff

The designer does not need to design around table names, but the following constraints are real:

- A rate table belongs to one pricing program and one shipping option.
- Parcel tables use `shipment_weight`; freight tables use `pallet_count`.
- State is a required two-letter US region.
- ZIP prefix is optional and contains 1-5 digits.
- Rates are stored in integer cents.
- Parcel measures are stored in grams but displayed in pounds.
- Pallet measures are stored as whole counts.
- Optional freight weight ceilings are stored in grams but displayed in pounds.
- Warehouse scope can be global or reference a configured warehouse.
- Activation and revision history are server-controlled lifecycle operations.
- The API can expand destination groups into individual state/ZIP/band rows.

The final design should optimize the operator's mental model, not mirror the storage model.

## 21. Product Requirements That Need Engineering Follow-up

The designer should include these target behaviors even though the current scaffold may not support all of them yet. Engineering must estimate and sequence the gaps during implementation planning.

| Target behavior | Likely engineering work |
|---|---|
| Use `Pricing Program` throughout the UI | Relabel the current rate-book surfaces without renaming the backend object |
| Create and edit pricing-program assignments | Add or complete admin APIs and UI for channel, purpose, and warehouse assignment |
| Save an incomplete draft | Relax draft persistence validation while retaining strict activation validation |
| Name destination groups | Persist names in draft metadata or a future first-class grouping model |
| Schedule activation | Add activation scheduling and job execution around `effectiveFrom` |
| Show revision author and change history | Add or expose audit metadata and revision comparison |
| Copy bands or duplicate groups | Add client-side transformation and corresponding draft persistence |
| Export business-unit CSV | Add a normalized export endpoint or client-side serializer |
| Surface active-versus-draft differences | Add a comparison response or deterministic client-side diff |
| Configure future freight qualifiers | Extend the freight rating model only when accessorial and provider requirements are approved |

These gaps are not reasons to preserve the current UI. They are implementation work created by the target product experience.
