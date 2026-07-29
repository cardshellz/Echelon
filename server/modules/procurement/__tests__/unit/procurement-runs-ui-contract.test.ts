import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// UI contract for the Run report page (design surface 04, /procurement/runs).
// Pattern follows procurement-automation-ui-contract.test.ts: pin the
// load-bearing strings so a refactor cannot silently drop a frozen server
// contract — the route + roles, the endpoints the page consumes, the
// READ-ONLY invariant (this page performs no mutations at all), the
// summary_json-derived fields it renders from normalizeAutoDraftRun, and the
// engine tab-strip state across all three shipped pages.

const page = readFileSync(
  resolve(process.cwd(), "client/src/pages/ProcurementRuns.tsx"),
  "utf8",
);
const app = readFileSync(resolve(process.cwd(), "client/src/App.tsx"), "utf8");
const routes = readFileSync(
  resolve(process.cwd(), "server/modules/procurement/purchasing-recommendation.routes.ts"),
  "utf8",
);
const reorderEnginePage = readFileSync(
  resolve(process.cwd(), "client/src/pages/ReorderEngine.tsx"),
  "utf8",
);
const automationPage = readFileSync(
  resolve(process.cwd(), "client/src/pages/ProcurementAutomation.tsx"),
  "utf8",
);

describe("procurement runs UI contract", () => {
  it("is registered at /procurement/runs for admin/lead", () => {
    expect(app).toContain('path="/procurement/runs"');
    expect(app).toMatch(
      /procurement\/runs"[\s\S]{0,300}component=\{ProcurementRuns\}[\s\S]{0,100}allowedRoles=\{\["admin", "lead"\]\}/,
    );
  });

  it("consumes the real run-report read endpoints", () => {
    // Run history (normalizeAutoDraftRun rows; server caps limit at 50).
    expect(page).toContain("/api/purchasing/auto-draft/runs?limit=");
    expect(routes).toContain('app.get("/api/purchasing/auto-draft/runs"');
    // Decision history — the same endpoint + limit the legacy PurchasingView
    // card consumes.
    expect(page).toContain('"/api/purchasing/recommendation-decisions"');
    expect(page).toContain("/api/purchasing/recommendation-decisions?limit=12");
    expect(routes).toContain('app.get("/api/purchasing/recommendation-decisions"');
    // Pipeline health banner.
    expect(page).toContain("/api/procurement/health/recommendation-pipeline");
    // Full forecast-accuracy detail is the existing component, reused directly
    // (NOT a re-implementation).
    expect(page).toContain(
      'import { ForecastAccuracyPanel } from "@/components/purchasing/ForecastAccuracyPanel"',
    );
    expect(page).toContain("<ForecastAccuracyPanel />");
  });

  it("performs NO mutations — the page is read-only", () => {
    // Every fetch in this page is a plain GET: no fetch options object ever
    // carries a method, and no HTTP verb literal appears. Run triggers and
    // settings writes live on the Automation page; the one evaluation mutation
    // inside the embedded ForecastAccuracyPanel belongs to that shared
    // component (pinned by the page that shipped it), not to this file.
    expect(page.match(/method: "/g)).toBeNull();
    expect(page).not.toMatch(/"(?:POST|PATCH|PUT|DELETE)"/);
    expect(page).not.toContain("useMutation");
    // The manual-trigger affordance is a LINK to Automation, not a POST.
    expect(page).toContain("Trigger runs from Automation");
  });

  it("renders only the summary_json fields normalizeAutoDraftRun actually serves", () => {
    // The run report renders the normalized projection of the persisted
    // summary_json (buildPurchasingRecommendationRunDetail): mode + approval
    // policy from settings, recommendationSummary counts, approval-policy
    // diagnostics, forecast diagnostics, and the capped recommendation
    // samples. Pin the server-side source fields…
    expect(routes).toContain("function normalizeAutoDraftRun");
    expect(routes).toContain("approvalPolicyDiagnostics");
    expect(routes).toContain("forecastDiagnostics: summaryJson?.forecastDiagnostics ?? null");
    expect(routes).toContain("recommendationSamples");
    expect(routes).toContain("recommendationSampleCounts");
    // …and the client fields that consume them.
    expect(page).toContain("approvalPolicyDiagnostics");
    expect(page).toContain("forecastDiagnostics");
    expect(page).toContain("autoDraftEligibleCount");
    expect(page).toContain("autoDraftReviewRequiredCount");
    expect(page).toContain("approvalPolicyEligibleCount");
    expect(page).toContain("approvalPolicyBlockedCount");
    expect(page).toContain("draftMutationEligibleCount");
    expect(page).toContain("approvedCandidateBandCounts");
    expect(page).toContain("blockedCandidateBandCounts");
    expect(page).toContain("autopilotBlockerCounts");
    expect(page).toContain("recommendationSamples.actionable");
    expect(page).toContain("recommendationSamples.approvalPolicyBlocked");
    expect(page).toContain("recommendationSamples.skipped");
    // Run-row counts always exist even when summary_json is missing.
    expect(page).toContain("itemsAnalyzed");
    expect(page).toContain("skippedNoVendor");
    expect(page).toContain("skippedOnOrder");
    expect(page).toContain("skippedExcluded");
    expect(page).toContain("errorMessage");
  });

  it("degrades gracefully for older runs missing newer summary_json fields", () => {
    // Both diagnostics objects are typed nullable and each null branch renders
    // honest fallback copy instead of crashing or inventing zeros.
    expect(page).toContain("RunApprovalPolicyDiagnostics | null");
    expect(page).toContain("RunForecastDiagnostics | null");
    expect(page).toContain("Approval-policy diagnostics were not persisted for this run");
    expect(page).toContain("Forecast diagnostics were not persisted for this run");
  });

  it("renders server-built recommendedActions hrefs as-is", () => {
    // buildAutoDraftRunRecommendedActions emits frozen hrefs (including
    // /reorder-analysis?… deep links persisted into the link contract). The
    // page must pass them through untouched — no rewriting, no re-deriving.
    expect(routes).toContain("function buildAutoDraftRunRecommendedActions");
    expect(page).toContain("recommendedActions");
    expect(page).toContain("href={action.href}");
    expect(page).not.toContain("action.href.replace");
  });

  it("ports the decision-history card contract from PurchasingView", () => {
    // Summary tiles: Accepted / Handoff / Deferred / Dismissed…
    expect(page).toContain("summary.acceptedForPo");
    expect(page).toContain("summary.poHandoffCreated");
    expect(page).toContain("summary.deferred");
    expect(page).toContain("summary.dismissed");
    // …and the recent-decision cards render reason, timestamp, actor, note.
    expect(page).toContain("decision.decisionReason");
    expect(page).toContain("decision.decidedAt");
    expect(page).toContain("decision.decidedBy");
    expect(page).toContain("decision.note");
    expect(page).toContain("Recommendation Decision History");
  });

  it("renders its own engine tab strip with Runs current — and the strips agree across pages", () => {
    // This page: Analysis / Demand Planner / Automation / RFQs live, Runs
    // current. All five surfaces have shipped, so the coming-soon chip
    // mechanism is gone entirely.
    expect(page).toContain('aria-label="Reorder Engine sections"');
    expect(page).toContain('aria-current="page"');
    expect(page).toContain('href="/reorder-analysis"');
    expect(page).toContain('href="/demand-planner"');
    expect(page).toContain('href="/procurement/automation"');
    expect(page).toContain('href="/procurement/rfqs"');
    expect(page).not.toContain("ENGINE_TABS_COMING_SOON");
    expect(page).not.toContain("aria-disabled");
    // Sibling pages: the Runs and RFQs chips are LIVE links everywhere, and
    // no page still carries a Soon chip. (The RFQ workbench contract suite
    // pins the full four-page strip agreement including its own strip.)
    expect(reorderEnginePage).toContain('href="/procurement/runs"');
    expect(reorderEnginePage).toContain('href="/procurement/rfqs"');
    expect(reorderEnginePage).not.toContain("ENGINE_TABS_COMING_SOON");
    expect(automationPage).toContain('href="/procurement/runs"');
    expect(automationPage).toContain('href="/procurement/rfqs"');
    expect(automationPage).not.toContain("ENGINE_TABS_COMING_SOON");
  });
});
