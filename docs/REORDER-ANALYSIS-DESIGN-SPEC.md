# Reorder Analysis Redesign — Design Spec

**Date:** 2026-07-26 · **Status:** Design handoff (mockups + spec, no implementation)
**Mockups:** `01-reorder-analysis.html` … `06-exclusions-policy.html` + `index.html` (open in any browser; self-contained)
**Baseline commit audited:** origin/main after PR #1032 · Authoritative prior doc: `docs/PURCHASING-HARDENING-HANDOFF-2026-07-19.md`

---

## 1. Decisions (agreed with owner, 2026-07-26)

1. **New page replaces PurchasingView.** Keep the `/api/purchasing/*` API surface; migrate server-generated deep links; retire `client/src/pages/PurchasingView.tsx` at parity (§8).
2. **SKU rows are the analysis driver**, rolled up by **Category** and **Product Line** (grouped table with subtotals, not a separate aggregates page).
3. **Two forward-demand inputs:** **Growth Adjustments** (NEW — % lifts with date ranges at business / category / product-line / SKU scope, stacking multiplicatively) and **Demand Events** (existing absolute-piece events, EXTENDED with category-level events materialized to SKUs by trailing-90d sales mix).
4. **Automation is designed to a full-autopilot ceiling** via a 5-stage ladder (Off → Observe → Auto-draft → Auto-send → Full autopilot incl. RFQ award), unlocked per vendor with category caps, hard spend caps, anomaly holds, and a global kill switch. Every gate change is logged.
5. **Full RFQ lifecycle is in scope for design** (send → quote capture → compare → award → promote quotes → PO conversion); implementation is phased.
6. **Report = email digest + in-app run report** after every scheduled run.
7. v1 stays **aggregated across warehouses and channels** (matches the engine's current `product_all_warehouses` scope).

## 2. Terminology (binding)

- **Growth Adjustment** — the % lever. Never call it an "overlay": *overlay* already means captured forward-demand contributions in the accuracy system (`purchase_forecast_overlay_contributions`).
- **Demand Event** — absolute-piece future demand (existing `procurement.demand_events`).
- **Reorder Point (RP)** / **Adjusted RP** — `ceil((lead + safety) × adjusted velocity)` / plus in-horizon weighted event pieces.
- **Stage 0–4** — the automation ladder rungs (Off / Observe / Auto-draft / Auto-send / Full autopilot).

## 3. What already exists (do not rebuild)

| Capability | Where |
|---|---|
| Weighted-blend forecast (7/30/90 + last-year seasonal windows, policy in warehouse settings) | `purchasing-demand-forecast.engine.ts`, `purchasing-forecast-policy.ts` |
| Reorder math incl. open-PO netting, MOQ/UOM rounding, status taxonomy | `purchasing-recommendation.engine.ts` |
| Demand events + rebuilt Demand Planner UI (SKU picker, audit, optimistic concurrency) | `demand-events.*`, `DemandPlanner.tsx` |
| Exclusions (per-product flag + rules table + modal) | `reorder_exclusion_rules`, `ExclusionRulesModal.tsx` — **note the `rules`→`exclusionRules` wiring bug, spun off separately** |
| Immutable recommendation runs/lines, decisions, PO handoff | `purchase_recommendation_runs/lines`, handoff service |
| Nightly auto-draft job with lease/heartbeat/run history; review_only vs draft_po; approval policies; quality gates | `auto-draft.job.ts`, `auto_draft_runs` |
| Forecast accuracy: observations → overlay contributions → 7/30/90d evaluations → cohort-isolated WAPE report + `ForecastAccuracyPanel` | PRs #1009–#1023 |
| Pipeline run ledger + recommendation-pipeline health | `purchase_pipeline_job_runs`, `/api/procurement/health/recommendation-pipeline` |
| RFQ draft creation (manual + automatic policy) and schema for the full lifecycle | migration 148/151/158, `purchasing-rfq.service.ts` |
| PO drafting, dual-status lifecycle, email outbox | `purchase-order.routes.ts`, `po_email_outbox` |

## 4. What is genuinely new (build order in §9)

### 4.1 Growth Adjustments (mockup 02)
- New table `procurement.growth_adjustments`: `id, scope ('business'|'category'|'product_line'|'product'), target_id/value, percent (int, e.g. 20 = +20%), starts_on, ends_on, reason (required), created_by, created_at, ended_at/ended_by` (append-only; "end now" sets `ended_at`, never deletes).
- Engine: `adjustedVelocity = blendedVelocity × Π(1 + pct/100)` over adjustments active on the as-of date whose scope matches the product. Applied **before** RP; events add after (matches mockup math drawer).
- **Backtesting contract (required):** adjustments change the forecast number, so each `purchase_forecast_observations` row must capture the applied multiplier set (own capture version + exclusion reasons), or the adjustment set joins the policy-cohort fingerprint. Recommendation: **capture as evidence** (like overlay contributions) — fingerprinting would fragment accuracy cohorts on every edit. Integer math: store percent as int; multiplier product applied in micros with a deterministic rounding rule expressible as a SQL check.
- Endpoints: CRUD under `/api/purchasing/growth-adjustments` (+ preview endpoint returning before/after RP/suggested for affected SKUs — the Impact tab).

### 4.2 Category-level Demand Events (mockup 02)
- Extend demand events: parent event may target a category (or product line); allocation **materializes** integer per-SKU lines by trailing-90d sales mix at creation (largest-remainder so lines sum exactly to the total — the overlay-capture reconciliation hard-fails on drift).
- Store the allocation basis (`mix_window_days`, per-line share) for auditability; re-materialize (with audit) if the event is edited before entering the horizon.

### 4.3 Automation ladder (mockup 03)
- New settings model: per-vendor stage (0–4), per-category stage cap, caps (`max_po_cents`, `max_daily_spend_cents`, `max_lines_per_run`), promotion thresholds (clean-run counts). Effective stage of a line = `min(vendor stage, category cap, global default)`.
- Maps onto existing plumbing: Stage 1 = `review_only`; Stage 2 = `draft_po`; Stage 3 = NEW auto-send step after handoff (reuses PO email outbox; respects caps; only quality-gate-eligible + policy-approved lines); Stage 4 = RFQ send + award-within-tolerance (last).
- Anomaly rules (qty vs trailing average, cost drift, forecast trust, new-SKU, daily cap, run overlap) each hold the *line* (never the run) with a structured reason surfaced in the run report; all rule/gate/cap changes append to a `automation_gate_events` audit table.
- Kill switch = existing scheduler-disable pattern + a DB flag so the UI can show/toggle it.

### 4.4 Run Report page + email digest (mockup 04)
- Page renders one analysis/auto-draft run: funnel (active → excluded → analyzed → actionable → outcomes), actions with gate reasoning, warnings, history. Data mostly exists (`auto_draft_runs.summary_json`, snapshots, pipeline ledger); needs a consolidated `GET /api/purchasing/runs/:id/report` endpoint.
- Email digest after each scheduled run via the existing SMTP path with a durable outbox (mirror `po_email_outbox` pattern); settings: every run / daily rollup / only-when-action-needed.

### 4.5 RFQ lifecycle (mockup 05)
- First-class commands (all idempotent, append-only evidence): `send` (line-sheet email via outbox), `capture-quote` (per vendor per line; no-bid with reason), `award` (per line, splits allowed; tolerance policy for Stage 4), `promote-quotes` (write awarded pricing to `vendor_products` as new evidence), `convert-to-pos` (drafts via the existing handoff pattern), `close/cancel` (with reason).
- The comparison matrix computes **landed unit cost** = unit + allocated freight; recommendation sentence must state the tradeoff (MOQ-forced excess vs unit price vs lead time), as mocked.

### 4.6 Cockpit (mockup 01)
- New page at `/reorder-analysis` consuming the existing analysis endpoint plus rollup grouping client-side (or a light `groupBy` param).
- The **math drawer** is the core deliverable: an 8-step plain-English walkthrough (windows → blend → adjustments → coverage target → events → supply → sizing → outcome/gate) rendered from fields the API already returns (`forecastProvenance`, `demandBasis`, `supplierBasis`, `qualityGate`) plus the new adjustment step.
- Embeds the existing `ForecastAccuracyPanel` (or its slim strip variant, as mocked).

## 5. Surface map (mockup → route)

**Navigation (revision 1):** the engine is ONE sidebar item — Procurement → **Reorder Engine** — not five siblings. Surfaces 01–05 are an internal tab strip (Analysis · Forecast inputs · Automation · Runs · RFQs) under a shared shell; Planning Policy stays under Admin. Routes below are the tab destinations.

| Mockup | Route | Replaces |
|---|---|---|
| 01 cockpit | `/reorder-analysis` | `PurchasingView.tsx` |
| 02 forecast adjustments | `/forecast-adjustments` (new; Demand Planner merges in as the Events tab) | `DemandPlanner.tsx` (eventually) |
| 03 automation | `/procurement/automation` (new) | scattered auto-draft settings |
| 04 run report | `/procurement/runs/:id` (new) | dashboard run card (kept as summary link) |
| 05 RFQ workbench | `/rfq` (new) | RFQ queue section of PurchasingView |
| 06 planning policy | `/settings/planning-policy` (new) | `ExclusionRulesModal` |

## 6. The math drawer contract (parity checklist for retirement)

Every number in the drawer must be sourced from engine output, never recomputed client-side: window pieces + per-day rates; blend weights incl. seasonal-zeroed redistribution note; active adjustments with links; lead/safety sources (vendor/product/default); event rows with confidence weights and allocation shares; available/reserved/on-order; gap; MOQ/increment rounding; status + confidence + gate reason. If the API lacks a field the drawer needs, extend the API — do not duplicate math in the client (single-engine invariant from the 07-19 handoff).

## 7. Sample-data provenance (mockups)

`data.js` is generated by `gen_data.py` using the verified engine formulas (blend, RP, MOQ rounding, status taxonomy, 90-day event horizon). KPI totals, impact deltas, and RFQ totals are computed, not invented. If a mockup number looks wrong, check the generator before editing HTML.

## 8. Deep-link migration & retirement criteria

Server-generated links target `/reorder-analysis?…` with params `status, candidateBand, reviewQueue, reason, forecastAction, recommendationId` (health services, dashboard, forecast-input-gap diagnostics). The new cockpit must honor all of them (filter/scroll/open-drawer behaviors) before PurchasingView is deleted. Retirement checklist: deep links honored · review/accepted queues re-homed (cockpit drawer + run report) · RFQ queue re-homed to workbench · accuracy panel embedded · operator decision dialog (acknowledgments, ≥10-char note) preserved.

## 9. Suggested implementation order

1. Cockpit read-only (rollups + math drawer, existing API) — immediate daily value, zero risk.
2. Growth Adjustments (schema + engine step + Impact preview + observation capture).
3. Category demand events with materialized allocation.
4. Run report page + email digest.
5. Automation ladder (settings model + Stage 3 auto-send inside caps).
6. RFQ lifecycle commands + workbench.
7. Stage 4 autopilot (RFQ send/award tolerance) — last, after accuracy trust thresholds are configured.

Each step lands behind the usual branch→PR flow; steps 2–3 need migrations and must state their backtesting interaction explicitly (per §4.1).

## 10. Revision 1 (owner review, 2026-07-26)

1. **Single-entry navigation.** The five engine surfaces read as one menu item ("Reorder Engine") with an internal tab strip — they must never present as siblings of higher-level Procurement functions (POs, Receiving, Suppliers). Applied across all mockups.
2. **Cockpit status model regrouped by operator question**, replacing the raw engine-bucket chip row (engine statuses are mutually exclusive, so "Order now 1" rendered below "Stockout 2" and read as a contradiction):
   - **Order queue**: `Needs order` = stockout + order_now, one red chip with a severity breakdown ("2 out of stock · 1 below reorder point"); `Order soon` (was "Burn rate") becomes actionable with an order-by deadline computed as `daysOfSupply − (leadTime + safetyStock)` days of slack.
   - **Watching**: `Inbound covers` (with earliest ETA) and `Healthy` — monitoring states, visually quiet.
   - **Inventory health card** (new): `Stagnant` (no sales in 90d) and `Overstocked` (>180d supply, surfaced as a first-class state) move out of the reorder chips entirely — their actions run the opposite direction (stop ordering / discount / liquidate); the card reconciles to the Idle-capital KPI.
   - KPI labels aligned: "Needs order" / "Order soon".
   Implementation note: this is presentation-layer grouping only — the engine taxonomy is unchanged; the UI maps statuses → queues.

## 11. Revision 2 (owner review, 2026-07-26)

1. **Additive queue chips.** `Needs order` and `Order soon` are toggles that combine; the cockpit's default view IS the combined order queue (severity-sorted), with "View all" one click away. Chip explainer sentences move into hover tooltips; order-soon gets concrete dates (projected stockout + order-by date = `asOf + daysOfSupply − (lead + safety)`), shown on the row, in the tooltip, and in the math drawer.
2. **The Order Builder is the single ordering flow.** Queue rows carry checkboxes (suggestions pre-checked; any row can be added — healthy rows exist for MOQ/freight top-offs; the old "+ Plan" is now "Add to order"). A sticky bar opens the builder: lines grouped by vendor, editable pieces with case-rounding hints, live totals, and one per-vendor choice — **Send as PO** (default; the owner buys each SKU from one vendor at known cost) or **Request quote** when cost is unknown/stale. Both output a vendor-facing document through the existing PO email pipeline.
3. **RFQ workbench demoted to a tracking surface.** It is no longer an entry point: lines land there only via "Request quote", and the multi-vendor comparison matrix appears only when more than one vendor actually quotes a line. The full lifecycle design remains for that case.
4. **Terminology:** "Reorder point" spelled out in column headers (tooltip carries the definition); "RP" only in space-constrained rollup chips with a tooltip.

Implementation mapping: the builder's per-vendor PO path is the existing accepted-recommendation → PO handoff + `po_email_outbox`; the Request-quote path is the existing RFQ draft creation. Quantity edits vs suggestion map to the existing override-reason contract (RFQ lines already require a ≥3-char reason when qty ≠ recommendation; the PO path should mirror it).

## 12. Revision 3 (owner review, 2026-07-26)

1. **Full-case rounding is a rule, not a hint.** Suggested pieces always round UP to a full case, and the Order Builder's quantity input enforces it (snap-up on edit; 0 = skip line). **Engine flag for implementation:** today `purchasing-recommendation.engine.ts` rounds to the purchase UOM only when the vendor mapping is priced `per_purchase_uom` (increment falls back to 1 piece otherwise). The owner's rule: round up to a full case whenever a case pack is known — use `vendor_products.pieces_per_purchase_uom`, falling back to `vendor_products.pack_size`. Small engine change; test both pricing bases.
2. **Inventory health leaves the cockpit.** The card was too sparse to do the job and the job is different (aging, turns, idle capital, markdown/liquidation candidates ≠ "what do I order today"). Cockpit keeps only quiet `Stagnant` and `Overstocked` filter chips in the Watching tier plus a clickable Idle-capital KPI. A dedicated **Inventory Health module under the Inventory menu group** is parked as future work.
3. **Forecast inputs parked as coming-soon.** The 02 surface as designed was tool-first, not task-first; rather than slow the ordering flow, the tab stays in the strip with a "Soon" badge and the page states what's coming (growth adjustments, category events with materialized allocation) and what exists today (per-SKU demand events in the Demand Planner, already feeding recommendations). The §4.1/§4.2 designs remain the implementation reference when this resumes; redesign the page task-first at that point.

## 13. Revision 4 — live-page merge audit (2026-07-26)

A full inventory of the live PurchasingView.tsx + server contracts (86 items) decided what survives into the new page. Outcomes, approved by the owner:

**Folded into the cockpit/Order Builder (the binding server contracts):**
- PO handoff requires a prior `accepted_for_po` decision with note ≥10 chars, `confirmDecision`, `acknowledgeAutomationEligibilityUnchanged`, and `reviewedControlCodes` covering EVERY active quality control (`purchasing-recommendation.routes.ts` `validateRecommendationDecisionEvidence`). The Order Builder's confirm stage collects all of it; replay safety is the accepted-decision unique constraint (409), not the client's Idempotency-Key header (unused by this route).
- RFQ over-allocation needs `quantityOverrideReason` ≥3 chars + `allocationOverrideApproved` (migration 158 trigger, fail-closed) — builder lines exceeding the suggestion collect both.
- Deep-link params `reviewQueue / recommendationId / candidateBand / reason / forecastAction` are emitted by six server generators and frozen into persisted notification rows — the new page must honor all five forever; `status` (new) is a free namespace, verified unused server-side.
- Kept: manual Refresh + run provenance, 30s KPI poll, toast/invalidation discipline, per-row Exclude action, skippedItems rendered under the excluded toggle with reason codes, confidence-factor tooltips, candidate band + quality controls in the drawer's outcome step.

**Moved:** quality-gate rollup, approval-policy impact, held-items triage, review-queue filters → Automation (03); full accuracy detail (cohort selector, per-SKU backtests, evaluate-matured trigger) + decision history → Run report (04); RFQ tracking counts → workbench (05); exclusion rules + forecast policy editor → Planning Policy (06).

**Dropped:** scroll-to-queue CTA, candidate-score spotlight, health-ratio bar, dense one-line provenance string.

**API extensions required by the new page:** category/product-line fields on reorder items; per-row inbound ETA; stop stripping `forwardDemandBasis.contributions` (or drawer fetches demand-events); suggested-spend (client-computed acceptable); Overstocked derived client-side (>180d supply, ok status). Accuracy strip pins the 30-day horizon and keeps the trust caveat. Add a UI-contract test for the new page pinning deep-link params + decision-evidence fields (pattern: `demand-planner-ui-contract.test.ts`).

## 14. Revision 5 — order semantics and risk-proportional evidence (2026-07-27)

1. **Analysis membership is managed only on Planning Policy (06).** The cockpit's per-row Exclude button (added in rev 4) is removed — sitting next to "Add to order" it read as an order action, and excluding from the page that displays the analysis creates a one-way-door feel. The cockpit keeps the excluded-rows toggle (read-only, with reason labels) plus a "Manage exclusions →" link to 06.
2. **Order membership is symmetric.** Row action toggles Add to order ↔ Remove; Order Builder lines carry an explicit × that syncs back to the table; empty builder shows an empty state.
3. **Decision evidence is proportional to risk.** Confirm step splits into "Ready — no active warnings" (no checkboxes; note optional with auto-note `Manual order via Order Builder`) and "Flagged — acknowledge each warning" (per-control checkboxes + ≥10-char note required, as before). The eligibility acknowledgment becomes a passive info line shown only with flagged items. **Server change required at implementation:** relax `validateRecommendationDecisionEvidence` so control-free decisions accept an auto-note and an implicit eligibility flag; keep the strict path whenever `qualityControls` is non-empty. Evidence remains append-only; nothing about the audit trail weakens — only the ceremony where there is no risk to acknowledge.

## 15. Open questions (parked)

- Multi-warehouse dimension (blocked on engine gaining warehouse-scoped demand/supply — out of scope v1).
- Accuracy trust thresholds (`accuracy_thresholds_not_configured` today) — needed before Stage 4; propose configuring after 60d of cohort data.
- AI-drafted quote intake from vendor email replies (noted in mockup 05 as "future").
- Whether `/demand-planner` remains a standalone page or fully merges into 02 (design assumes merge; keep the route as a redirect).
