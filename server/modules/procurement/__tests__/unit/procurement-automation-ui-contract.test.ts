import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// UI contract for the Automation page (design surface 03,
// /procurement/automation). Pattern follows reorder-engine-ui-contract.test.ts:
// pin the load-bearing strings so a refactor cannot silently drop a frozen
// server contract — the deep-link params persisted into notification rows, the
// endpoints the page consumes, the exact mutation set, the decision-evidence
// fields the audited dialog submits, and the honest automation ladder (only
// the two real server-side modes are switchable).

// The needles below pin source CONTENT, not checkout line-ending flavor —
// normalize CRLF so a core.autocrlf=true (Windows) checkout matches the same
// bytes CI's LF checkout sees. Without this, the one multi-line needle (the
// candidate-band precedence expression) fails locally on CRLF checkouts.
const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");

const page = readSource("client/src/pages/ProcurementAutomation.tsx");
const app = readSource("client/src/App.tsx");
const routes = readSource("server/modules/procurement/purchasing-recommendation.routes.ts");

describe("procurement automation UI contract", () => {
  it("is registered at /procurement/automation for admin/lead", () => {
    expect(app).toContain('path="/procurement/automation"');
    expect(app).toMatch(
      /procurement\/automation"[\s\S]{0,300}component=\{ProcurementAutomation\}[\s\S]{0,100}allowedRoles=\{\["admin", "lead"\]\}/,
    );
  });

  it("honors the five frozen review-queue deep-link params", () => {
    // Server link generators emit /reorder-analysis?… with these params and
    // they are frozen into persisted notification rows (spec §8/§13). The
    // cockpit banner forwards the full query here; this page must read all
    // five forever.
    expect(page).toContain("reorderAnalysisSearchParams");
    expect(page).toContain('params.get("reviewQueue")');
    expect(page).toContain('params.get("reason")');
    expect(page).toContain('params.get("forecastAction")');
    expect(page).toContain('params.get("recommendationId")');
    expect(page).toContain('params.get("candidateBand")');
    // recommendationId + forecastAction deep links auto-scroll and open the
    // audited dialog once — the legacy PurchasingView behavior.
    expect(page).toContain("recommendation-review-target");
    expect(page).toContain("openedForecastDeepLinkRef");
    // candidateBand narrows the queue on this page (the legacy analysis table
    // it filtered lives on the cockpit), but a pinned recommendationId wins:
    // frozen links freeze the band at generation time, and score drift must
    // never hide the exact recommendation the link targets.
    expect(page).toContain(
      'candidateBandFilter === "all" ||\n        reviewQueueRecommendationId !== "all" ||',
    );
  });

  it("consumes the real automation read endpoints", () => {
    expect(page).toContain('"/api/purchasing/auto-draft-settings"');
    expect(page).toContain('"/api/purchasing/reorder-analysis"');
    expect(page).toContain("/api/purchasing/recommendation-review-queue");
    expect(page).toContain('"/api/purchasing/auto-draft/status"');
    expect(page).toContain('"/api/purchasing/auto-draft/runs?limit=5"');
  });

  it("mutates EXACTLY the three allowed endpoints", () => {
    // One PATCH (settings) + two POSTs (decision, manual run) — nothing else.
    const mutations = Array.from(
      page.matchAll(/fetch\("([^"]+)", \{\s*\n?\s*method: "(PATCH|POST)"/g),
    ).map((match) => `${match[2]} ${match[1]}`);
    expect(new Set(mutations)).toEqual(
      new Set([
        'PATCH /api/purchasing/auto-draft-settings',
        'POST /api/purchasing/recommendation-decisions',
        'POST /api/purchasing/auto-draft/run',
      ]),
    );
    expect(page.match(/method: "/g)).toHaveLength(3);
    expect(page).not.toMatch(/"(?:PUT|DELETE)"/);
  });

  it("renders the ladder honestly: only review_only and draft_po are switchable", () => {
    // The two real modes map onto the server's autoDraftMode enum…
    expect(page).toContain('mode: "review_only"');
    expect(page).toContain('mode: "draft_po"');
    expect(routes).toContain('["draft_po", "review_only"].includes(autoDraftMode)');
    // …the unshipped stages are locked with NO mode to PATCH.
    expect(page).toContain("mode: null");
    expect(page).toContain("Auto-send");
    expect(page).toContain("Full autopilot");
    expect(page).toContain("Not built yet");
  });

  it("PATCHes every legacy automation setting the ExclusionRulesModal owns today", () => {
    expect(page).toContain("autoDraftMode: stage.mode");
    expect(page).toContain("approvalPolicy: value");
    expect(page).toContain("includeOrderSoon: v");
    expect(page).toContain("skipOnOpenPo: v");
    expect(page).toContain("skipNoVendor: v");
    expect(page).toContain("candidateScoreStrongThreshold: strongThreshold");
    expect(page).toContain("candidateScoreReviewThreshold: reviewThreshold");
    expect(page).toContain("stalePoThresholds: parsed");
    expect(page).toContain("rfqDraftAutomationMode");
    expect(page).toContain("rfqDraftMinimumConfidence");
    expect(page).toContain("rfqDraftRequireTrustedForecast");
    expect(page).toContain("rfqDraftMaximumLinesPerRun");
  });

  it("submits the exact recommendation-decision evidence contract", () => {
    // validateRecommendationDecisionEvidence (server): note ≥10 chars,
    // confirmDecision: true, eligibility acknowledgment, and every current
    // control code acknowledged for reviewed/accepted_for_po.
    expect(routes).toContain("RECOMMENDATION_DECISION_NOTE_MIN_LENGTH = 10");
    expect(page).toContain("decisionNote.trim().length >= 10");
    expect(page).toContain("recommendationId: item.recommendationId");
    expect(page).toContain("kind: item.kind");
    expect(page).toContain("confirmDecision: true");
    expect(page).toContain("reviewedControlCodes: acknowledgedControlCodes");
    expect(page).toContain("acknowledgeAutomationEligibilityUnchanged");
    expect(page).toContain("everyDecisionControlReviewed && automationEligibilityAcknowledged");
    // The dialog cannot close while the mutation is pending (close-guard).
    expect(page).toContain("if (!open && !recommendationDecisionMutation.isPending) setDecisionDialog(null);");
    // All four operator decisions are reachable.
    expect(page).toContain('openRecommendationDecision(item, "reviewed")');
    expect(page).toContain('openRecommendationDecision(item, "accepted_for_po")');
    expect(page).toContain('openRecommendationDecision(item, "deferred")');
    expect(page).toContain('openRecommendationDecision(item, "dismissed")');
  });

  it("deep-links prepare_rfq to the cockpit instead of the legacy RFQ section", () => {
    expect(page).toContain('item.action.action === "prepare_rfq"');
    expect(page).toMatch(/\/reorder-analysis\?recommendationId=\$\{encodeURIComponent\(item\.recommendationId\)\}/);
  });

  it("renders its own engine tab strip with Automation current", () => {
    expect(page).toContain('aria-label="Reorder Engine sections"');
    expect(page).toContain('aria-current="page"');
    expect(page).toContain('href="/reorder-analysis"');
    expect(page).toContain('href="/demand-planner"');
    // Runs shipped (design surface 04) — live link; only RFQs remains Soon.
    expect(page).toContain('href="/procurement/runs"');
    expect(page).toContain('ENGINE_TABS_COMING_SOON = ["RFQs"]');
    expect(page).toContain('aria-disabled="true"');
  });

  it("ports the approval-policy impact + quality-gate rollup fields", () => {
    expect(page).toContain("approvalPolicyImpact");
    expect(page).toContain("qualityGateEligibleCount");
    expect(page).toContain("approvalPolicyEligibleCount");
    expect(page).toContain("approvalPolicyBlockedCount");
    expect(page).toContain("draftMutationEligibleCount");
    expect(page).toContain("heldRecommendations");
    expect(page).toContain("autoDraftEligibleCount");
    expect(page).toContain("autoDraftReviewRequiredCount");
  });

  it("keeps the manual run trigger lease-aware", () => {
    expect(page).toContain("autoDraftRunHasActiveLease");
    expect(page).toContain("leaseExpiresAt");
    expect(page).toContain("runAutoDraftMutation.isPending || autoDraftRunActive");
  });
});
