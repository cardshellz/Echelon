# Vendor listing pricing rules

This workflow generates vendor selling prices; it does not recommend prices,
estimate profit, debit a wallet, or change marketplace listings when saved.

## Authority and rollout

- Store-owned, immutable profile revisions contain one default recipe and ordered
  group recipes. The lowest priority number wins; equal-priority matching groups
  are blocked. Recipes never stack.
- Formula: basis × (10,000 + markup basis points) / 10,000 + flat cents. Round once
  half-up to cents, then optionally round upward to an ending of .99.
- Basis is explicitly either current .ops purchase cost per sellable pack or
  catalog reference retail. Missing basis is a blocker, never zero or a fallback.
- Fixed overrides and explicit catalog-default choices remain distinct from rule
  inheritance. A bulk review explicitly adopts rules for existing listings and
  preserves fixed overrides unless the vendor deliberately releases them.
- Preview and approval are separate. Approval checks the exact profile revision,
  selected population, current listing settings, and cost evidence again. It is
  atomic and idempotent, and writes an audit event. No marketplace call is made.
- Listing previews use the same rule resolver. Saving rules invalidates the UI's
  prior publication preview. Publication still requires its explicit review and
  queue action; queued payloads are not rewritten by later cost changes.

## Delivery boundaries

1. Exact-money resolver, versioned store profiles, explicit price ownership.
2. Server-wide impact review and atomic adoption, catalog UI, preview/editor wiring.
3. Separate price-only marketplace update jobs and automatic change detection.
   These are not implied by saving a profile and must not reuse a full-content
   listing update as an automatic price update.

Wallet/order acceptance cost reconciliation and suggested pricing remain separate.

## Implemented first release

The catalog's existing connected-store workflow now contains Listing pricing
rules. There is no new navigation item. Defaults and named groups support
percentage markup, flat markup, or both, with product-cost or explicit retail
basis. Groups target a category, product line, product, or named set of listings.
Fixed and previously saved legacy prices are preserved by default because the
legacy listing column does not prove whether its price was manually chosen.
The review checkbox deliberately releases those exceptions when wanted.

The server scans selected catalog entries with a keyset cursor and supports up
to 10,000 selected listings per pricing review. The browser receives 50 impact
rows at a time. This limit is separate from the existing 500-item marketplace
listing-preview/push request limit; this release does not claim bulk live
repricing or automatic publishing is implemented.

Approval stores a profile revision plus rule-owned listing settings in one
transaction. It recalculates the review against the same database snapshot,
compares its evidence, and uses set-based revision/projection writes. Savepoint
isolation allows an explicit retail-based recipe to survive an unavailable cost
source; a cost-based recipe remains blocked. No marketplace client or wallet
writer exists in the rule application dependency graph.

The single-listing editor distinguishes fixed, catalog-default, and rule modes.
The listing preview builds its marketplace intent from the shared resolver and
uses the same cost observation in its economics display. Queue creation requires
the reviewed rule evidence and rechecks it under the store's queue/save lock.
Changing rules never rewrites an already queued, reviewed marketplace payload.

## Test and rollout checklist

- Apply migration 0659 before deploying the application code. Existing 0657 price
  revisions remain immutable; nullable legacy modes preserve their old meaning.
- Review a default 30% + $1 rule against the .ops cost: an 809-cent cost produces
  1152 cents before optional upward .99 rounding.
- Add a category/group exception, check priority handling, inspect all impact
  pages, and confirm manual prices are preserved unless deliberately released.
- Apply, generate a new listing preview, edit one fixed exception, then restore
  that listing to rules. No browser hard refresh should be necessary.
- Missing cost, conflicting winning priorities, stale cost/selection/price
  evidence, failed audit insertion, and concurrent applies must not partially
  adopt prices. Retry uncertain applies with the same key.
- Next deployment boundary: a dedicated price-only marketplace update job with
  per-item outcomes, explicit approval, and separate desired/confirmed prices.
  Automatic cost-change monitoring and automatic live repricing remain disabled.

## Local verification (2026-09-07)

- Full unit suite: 8,907 passed, 37 skipped. An earlier run hit a Node fetch
  `bad port` error in the unchanged shipping-estimate HTTP fixture, then two
  cascading mock failures. That file passed independently and the full rerun
  passed without application or test changes.
- Client pricing/preview contracts: 160 passed. TypeScript and the production
  build passed; the build retains its large-bundle warning.
- Disposable PostgreSQL 17: 45 integration tests passed, including a real
  1,000-listing adoption, audit-write rollback, concurrent approval, immutable
  revisions, fixed exceptions, and caller-owned cost-read savepoint recovery.
- Browser journeys: all eight desktop/mobile cases passed with synthetic API
  responses. Desktop/mobile screenshots were visually inspected. These are not
  production eBay or Shellz Club end-to-end tests.
- No production settings, marketplace listings, or wallet data were changed.
