# Shipping Pricing UI Design Handoff

**Status:** Ready for product design
**Updated:** July 22, 2026
**Audience:** Product designer, UX designer, frontend engineer
**Implementation PR:** [#993](https://github.com/cardshellz/Echelon/pull/993)

## 1. Assignment

Redesign the Echelon shipping-pricing administration experience so an operations user can confidently configure:

- which business flow uses a pricing program;
- the customer-facing shipping options in that program;
- destination groups and their default prices;
- product-specific pricing exceptions;
- product and destination restrictions;
- draft testing, review, and activation.

The backend model and core workflows already exist. This is a usability, information-architecture, and interaction-design assignment. The designer should improve the experience without inventing a second pricing model.

## 2. Product Context

Echelon owns a shared shipping-rate engine used by multiple business flows. A **pricing program** is a collection of prices assigned to one or more flows, such as:

- Shopify customer checkout;
- a Card Shellz-owned website checkout;
- dropship vendor fulfillment charges.

A pricing program contains customer-facing **shipping options**, such as Standard Shipping. Each shipping option has revisioned destination rates and optional product rules.

This is not a carrier shopping or label-buying screen. Carrier methods are selected later in fulfillment. The administrator is configuring what Card Shellz charges for an internal shipping option.

## 3. Locked Product Model

The design must preserve this hierarchy:

```text
Business flow assignment
  -> Pricing program
       -> Shipping option
            -> Rate-table revision
                 -> Destination group
                      -> Default destination pricing
                      -> Product pricing exceptions
                      -> Shipping restrictions
                      -> Draft quote test
```

### Definitions

| Term | Meaning |
| --- | --- |
| Business flow | Where and why the price is used, such as Shopify checkout or dropship vendor fulfillment. |
| Pricing program | A named collection of shipping prices assigned to one or more business flows. |
| Shipping option | The offer shown to a customer or vendor, such as Standard Shipping. It is not a carrier service code. |
| Revision | A draft, active, superseded, or retired version of one shipping option's rates and product rules. |
| Destination group | States and optional ZIP prefixes that share default prices for a warehouse scope. |
| Product exception | A rule that changes the charge for selected products within a destination group. |
| Restriction | A rule that suppresses the shipping option when selected products are present for that destination. |

## 4. Current Navigation and Workflow

The current implementation is under:

```text
Shipping > Settings > Pricing programs
```

The existing flow is:

1. Open the Pricing Programs overview.
2. Open a pricing program.
3. Choose a shipping option.
4. Create or continue a draft revision.
5. Confirm the pricing context.
6. Select a destination group.
7. Configure one of four destination-group views:
   - Default pricing
   - Product exceptions
   - Restrictions
   - Test rate
8. Save the draft.
9. Review validation and coverage.
10. Activate the revision deliberately.

PR #993 adds live and draft product-rule counts to each shipping-option row and changes the primary action label to `Edit rates & rules`. These changes improve discovery but are not intended as the final design.

## 5. Current UI Problems

The designer should solve these specific problems:

1. **Product rules are difficult to discover.** They are nested inside a shipping option, a draft revision, and a selected destination group.
2. **The hierarchy is not self-evident.** Program, option, revision, destination group, default rates, and product rules compete for attention.
3. **Draft versus live state requires too much interpretation.** An operator must always know whether an edit can affect checkout.
4. **Product behavior is fragmented.** Exceptions and restrictions are separate views but together form the product policy for a destination group.
5. **Rule impact is hard to scan.** The operator cannot quickly compare which destination groups have defaults only, exceptions, restrictions, or incomplete rules.
6. **The editor is dense.** State selection, ZIP overrides, pricing methods, product rules, CSV tools, validation, and activation need stronger progressive disclosure.
7. **The primary path is not obvious.** A first-time operator should not need documentation to add a California exception for one bulky product.
8. **Error recovery needs direct navigation.** Validation should identify the affected option, destination group, and rule and take the user directly there.

## 6. Business Behavior That Must Not Change

### Revision safety

- Active rates and rules are immutable.
- Editing active configuration creates a draft revision.
- Saving a draft never changes live quoting.
- Activation revalidates the complete draft and atomically supersedes the prior active revision.
- Draft, active, superseded, and retired states must use text, not color alone.

### Destination pricing

- A destination group contains states and optional ZIP-prefix overrides.
- A destination group uses one parcel pricing method at a time:
  - weight bands; or
  - base charge plus each started pound.
- Money is stored and calculated in integer cents.
- Shipment weight is normalized by the backend; the UI should display understandable pound and ounce units.

### Product policy

- Product rules belong to a specific rate-table revision.
- A rule is scoped to the selected destination group.
- Products can be selected by shipping group, product line, category, saved product set, confirmed SIOC status, or exact variants.
- Product selection is frozen into revision membership when the rule is saved.
- Restrictions run before pricing and suppress the shipping option when matched.
- A line can match no more than one base-price exception in the same destination scope.
- Products without a matching base-price exception use the destination group's default pricing.
- Supported product pricing behaviors are:
  - free shipping;
  - fixed charge;
  - weight bands;
  - base charge plus each started pound;
  - surcharge;
  - free over matching-item subtotal.
- Product charge scope can be matching items combined or each matching item where supported.
- Draft testing uses the unpublished revision and does not affect checkout.

### Channel boundaries

- Shopify and owned checkouts can use Echelon pricing programs for shopper-facing rates.
- Dropship uses its assigned pricing program for the backend shipping amount charged to the vendor.
- eBay buyer-facing shipping remains controlled by eBay fulfillment policies. An eBay-sourced dropship order can still incur the dropship vendor fulfillment charge.

## 7. What the Designer May Change

The designer may change:

- information hierarchy and page composition;
- labels and supporting copy;
- table columns and row expansion behavior;
- step structure and progressive disclosure;
- navigation between destination defaults and product policy;
- rule-builder interaction patterns;
- summaries, filters, search, and status presentation;
- responsive behavior;
- empty, loading, warning, error, and read-only states.

The designer must not change:

- the hierarchy in Section 3;
- revision ownership or activation safety;
- pricing and rule precedence;
- assignment uniqueness;
- channel responsibilities;
- integer-money behavior;
- the distinction between pricing options and carrier methods.

## 8. Recommended Information Architecture

### Pricing Programs Overview

Use a compact operational table. Each row should answer:

- What is this program called?
- Which flows use it?
- Which shipping options are live?
- Is there unpublished work?
- Are product rules present?
- Does anything require attention?

Suggested columns:

```text
Program | Used by | Live options | Drafts | Product rules | Status | Updated
```

### Pricing Program Detail

Keep assignments and shipping options on one page. Product-policy presence must be visible before opening the editor.

Suggested shipping-option columns:

```text
Option | Live revision | Destination coverage | Product rules | Draft | Status | Action
```

The product-rule cell should distinguish live rules from draft rules. `0 live` is meaningful and should not be confused with unavailable data.

### Rate and Product Policy Editor

Use a full-page editor with persistent context and save state.

Recommended structure:

```text
Program / Shipping option / Draft status

Context  ->  Destinations, rates & rules  ->  Review & activate

Destination groups        Selected destination group
------------------        --------------------------
Northeast                 Overview / summary
West Coast                Default pricing
Alaska & Hawaii           Product policy
Military                  Test quote
```

Within the selected destination group, present **Default pricing** and **Product policy** as related parts of one configuration. Product policy may then distinguish pricing exceptions from shipping restrictions without making them feel like unrelated systems.

### Product Policy Summary

For each destination group, show a compact summary such as:

```text
Default: weight bands
Exceptions: 3
Restrictions: 1
Last draft test: passed
```

The summary should provide direct actions to add, inspect, or fix a rule.

## 9. Required Designer Workflows

The prototype must support these workflows without verbal explanation:

1. Find the pricing program used for dropship vendor fulfillment.
2. Identify the live Standard Shipping revision and whether a draft exists.
3. Create a draft without changing live checkout.
4. Create a destination group for selected states.
5. Set default weight-band prices for that group.
6. Add a fixed product price for a bulky product line.
7. Add a per-item surcharge for an exact variant.
8. Make confirmed SIOC products ship free.
9. Block a case variant from Alaska and Hawaii.
10. Test a mixed cart containing default-priced and exception-priced items.
11. Understand why an overlapping rule blocks activation.
12. Navigate directly from a validation error to the affected rule.
13. Review the live-to-draft difference.
14. Activate the revision and understand which revision was superseded.

## 10. Required States

Provide designs for:

- no pricing programs;
- program with no assignment;
- shipping option with no live revision;
- live revision with no draft;
- live revision with a draft;
- destination group with default pricing only;
- destination group with product exceptions;
- destination group with restrictions;
- unsaved changes;
- saving;
- saved draft;
- failed save with retained input;
- loading and API failure;
- incomplete destination coverage;
- overlapping product rules;
- missing catalog weight;
- draft quote success;
- draft quote blocked by a restriction;
- activation warning;
- activation-blocking error;
- superseded and retired read-only revisions;
- permission-denied read-only state.

## 11. Content Guidelines

- Use business language, not table names or IDs.
- Use `Pricing program`, not `Rate book`.
- Use `Shipping option`, not `Service-level ID`.
- Use `Product pricing exception`, not `Base-charge rule`.
- Use `Shipping restriction`, not `Block action`.
- Use `Matching items combined` and `Each matching item` only when the distinction affects the selected behavior.
- Always state whether the user is viewing live configuration or an unpublished draft.
- Avoid vague labels such as `Configured`, `Ready`, or `Policy` without the object and state they describe.
- Do not require the operator to understand database IDs, internal channel IDs, JSON, or CSV syntax.

## 12. Visual Direction

This is a recurring operations tool, not a marketing surface.

- Favor compact tables, split panes, toolbars, and clear section hierarchy.
- Avoid decorative summary cards and cards nested inside cards.
- Keep row actions stable and aligned.
- Use badges only for meaningful state.
- Reserve strong color for selection, primary actions, and blocking failures.
- Keep units visible beside numeric values.
- Make repeated prices easy to compare vertically.
- Ensure long program, destination-group, product-line, and SKU names do not break the layout.
- Target desktop operations first at approximately 1440 px and verify a narrow laptop layout at approximately 1024 px.

## 13. Deliverables

The design handoff should include:

1. Updated Pricing Programs overview.
2. Pricing Program detail.
3. Draft editor with destination-group navigation.
4. Default weight-band pricing.
5. Default base-plus-per-pound pricing.
6. Product-policy summary.
7. Add/edit product pricing exception.
8. Add/edit shipping restriction.
9. Draft quote tester and trace.
10. Review and activation comparison.
11. All states in Section 10.
12. Desktop and narrow-laptop layouts.
13. Clickable prototype for workflows 4-12 in Section 9.
14. Component and interaction annotations sufficient for implementation using the existing APIs.

## 14. Acceptance Criteria

The design is ready for frontend implementation when:

- a new operator can find product rules from the Pricing Programs overview;
- live and draft configuration cannot be mistaken for one another;
- the relationship between a destination default and its product exceptions is obvious;
- restrictions clearly explain that the shipping option will be suppressed;
- the rule builder reveals only fields relevant to the selected behavior;
- every activation error identifies the affected group or rule and provides a direct fix path;
- ordinary work requires no technical IDs or CSV;
- the full workflow remains usable at 1024 px without clipped controls;
- the design preserves every locked behavior in Section 6.

## 15. Source Map

These files prove the current implementation and are the designer's engineering references:

| Concern | Source |
| --- | --- |
| Shipping settings navigation | `client/src/pages/ShippingSettings.tsx`, `ShippingSettings` |
| Pricing-program overview and routing | `client/src/components/shipping/pricing-programs/PricingProgramsTab.tsx`, `PricingProgramsTab` |
| Program detail and shipping-option rows | `client/src/components/shipping/pricing-programs/ProgramDetail.tsx`, `ProgramDetail` and `OptionRow` |
| Draft editor and activation flow | `client/src/components/shipping/pricing-programs/RateTableEditor.tsx`, `RateTableEditor` |
| Destination-group workspace | `client/src/components/shipping/pricing-programs/DestinationGroupsPanel.tsx`, `DestinationGroupsPanel` |
| Product rule list, builder, and draft test | `client/src/components/shipping/pricing-programs/DestinationProductPolicies.tsx`, `DestinationProductPolicies`, `PolicyRuleList`, `RuleDialog`, and `PolicyPreview` |
| Product-rule API | `server/modules/shipping-engine/interfaces/http/product-rate-policy-admin.routes.ts`, `registerProductRatePolicyAdminRoutes` |
| Rate-table revision API | `server/modules/shipping-engine/interfaces/http/rate-table-admin.routes.ts`, `registerRateTableAdminRoutes` |
| Product-rule evaluation and precedence | `server/modules/shipping-engine/domain/product-rate-policy.ts`, `evaluateProductRatePolicy` |
| Runtime quote orchestration | `server/modules/shipping-engine/application/rate-quote.service.ts`, `quoteShipmentRates` |
| Persistent shipping model | `shared/schema/shipping.schema.ts` |

## 16. Supporting Documents

Read these in order when deeper context is needed:

1. This handoff: current design assignment and locked product behavior.
2. [SHIPPING-RATE-MANAGEMENT-UX-DESIGN-SPEC.md](./SHIPPING-RATE-MANAGEMENT-UX-DESIGN-SPEC.md): detailed rate-management UX background. It predates the current product-policy workflow, so this handoff controls where they differ.
3. [SHIPPING-ENGINE-DESIGN.md](./SHIPPING-ENGINE-DESIGN.md): authoritative engine architecture and product-rule precedence.
4. [SHIPPING-ENGINE-HANDOFF.md](./SHIPPING-ENGINE-HANDOFF.md): implementation and rollout context.

## 17. Known Unknowns

The following decisions are not proven by the current implementation and should not be invented silently during design:

- whether product policy should become its own editor step or remain within each destination group;
- whether a future first-class product-set manager belongs inside Shipping or Catalog;
- how carton-scoped pricing will appear if cartonization becomes a checkout input;
- how future carrier-method mappings will be administered;
- whether designers should expose bulk rule import in the first release.

Show alternatives for these questions when they materially affect the proposed layout, but preserve the current backend contract unless product and engineering approve a change.
