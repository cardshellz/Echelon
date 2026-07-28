import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// UI contract for the Reorder Engine cockpit (PR 2 read-only + PR 3 Order
// Builder). Pattern follows demand-planner-ui-contract.test.ts: pin the
// load-bearing strings so a refactor cannot silently drop a frozen server
// contract — the deep-link params persisted into notification rows, the
// endpoints the page consumes, the exact mutation set the Order Builder is
// allowed, the decision-evidence fields, the feature-flag key, and the
// legacy fallback route.

const page = readFileSync(resolve(process.cwd(), "client/src/pages/ReorderEngine.tsx"), "utf8");
const helpers = readFileSync(
  resolve(process.cwd(), "client/src/features/purchasing/reorderEngine.ts"),
  "utf8",
);
const app = readFileSync(resolve(process.cwd(), "client/src/App.tsx"), "utf8");
const settingsPage = readFileSync(resolve(process.cwd(), "client/src/pages/ProcurementSettings.tsx"), "utf8");
const service = readFileSync(
  resolve(process.cwd(), "server/modules/procurement/purchasing.service.ts"),
  "utf8",
);

describe("reorder engine UI contract", () => {
  it("honors the five frozen legacy deep-link params plus the new status param", () => {
    // recommendationId is handled natively (scroll + highlight + open drawer)…
    expect(helpers).toContain('params.get("recommendationId")');
    // …the four review-queue params trigger the non-breaking legacy banner…
    expect(helpers).toContain('"reviewQueue"');
    expect(helpers).toContain('"reason"');
    expect(helpers).toContain('"forecastAction"');
    expect(helpers).toContain('"candidateBand"');
    // …and `status` (the new, server-verified-free param) preselects chips.
    expect(helpers).toContain('params.get("status")');
    // The page parses via the shared helper the server generators target.
    expect(page).toContain("reorderAnalysisSearchParams");
    expect(page).toContain("parseReorderEngineDeepLink");
  });

  it("routes legacy review-queue links to the legacy page with the query preserved", () => {
    expect(helpers).toContain("/reorder-analysis/legacy");
    expect(page).toContain("deepLink.legacyUrl");
    expect(page).toContain("review queue");
  });

  it("consumes the purchasing read endpoints", () => {
    expect(page).toContain("/api/purchasing/kpis");
    expect(page).toContain("/api/purchasing/reorder-analysis");
    expect(page).toContain("/api/purchasing/forecast-backtests"); // accuracy strip
    expect(page).toContain("/api/procurement/health/recommendation-pipeline"); // pipeline dot
    // Order Builder mapping reads: authoritative review-queue kind/controls
    // for decisions, and saved-run lines for RFQ allocation baselines.
    expect(page).toContain("/api/purchasing/recommendation-review-queue?limit=100");
    expect(page).toContain("recommendation-review-queue?recommendationId=");
    expect(page).toContain('"/api/purchasing/rfq-queue"');
  });

  it("wires the Order Builder to EXACTLY the allowed mutations (PR 3)", () => {
    // Every mutation flows through the single postPurchasingCommand seam with
    // a literal endpoint at the call site — collect them all and pin the set.
    const commandCalls = Array.from(page.matchAll(/postPurchasingCommand\(\s*"([^"]+)"/g)).map(
      (match) => match[1],
    );
    expect(commandCalls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(commandCalls)).toEqual(
      new Set([
        "/api/purchasing/recommendation-runs", // manual refresh + RFQ snapshot fallback
        "/api/purchasing/recommendation-decisions", // accepted_for_po per line
        "/api/purchasing/recommendation-accepted-queue/create-po", // one per vendor group
        "/api/purchasing/rfq-queue", // one idempotent batch
      ]),
    );
    // …and no mutation exists outside the seam: the only literal HTTP method
    // in the page is the seam's own POST; no other verb appears at all.
    expect(page.match(/method: "/g)).toHaveLength(1);
    expect(page).toContain('method: "POST"');
    expect(page).not.toMatch(/"(?:PATCH|PUT|DELETE)"/);
  });

  it("collects the full decision-evidence and override-evidence contracts", () => {
    // Strict accepted_for_po evidence (validateRecommendationDecisionEvidence):
    // confirm + eligibility acknowledgment + every current control code.
    expect(helpers).toContain('decision: "accepted_for_po"');
    expect(helpers).toContain("confirmDecision: true");
    expect(helpers).toContain("acknowledgeAutomationEligibilityUnchanged: true");
    expect(helpers).toContain("reviewedControlCodes");
    // Quantity-override evidence pairs: PO handoff (migration 177 shape) and
    // RFQ allocation (migration 158 shape), both keyed off requestedPieces.
    expect(helpers).toContain("requestedPieces");
    expect(helpers).toContain("quantityOverrideReason");
    expect(helpers).toContain("allocationOverrideApproved");
    // Risk-proportional note: flagged lines demand >=10 chars, clean orders
    // record the auto-note.
    expect(helpers).toContain('"Manual order via Order Builder"');
    // RFQ batches are idempotent from dialog-open.
    expect(page).toContain("idempotencyKey: rfqIdempotencyKey");
    expect(page).toContain("crypto.randomUUID()");
  });

  it("keeps the client PO-handoff batch cap in lockstep with the server schema", () => {
    // The handoff command accepts at most 25 items; the client must fail an
    // oversized vendor group BEFORE recording any accepted_for_po decision,
    // or the acceptances land and the guaranteed-400 handoff strands them.
    const handoffService = readFileSync(
      resolve(process.cwd(), "server/modules/procurement/recommendation-po-handoff.service.ts"),
      "utf8",
    );
    expect(handoffService).toContain("items: z.array(handoffItemSchema).min(1).max(25)");
    expect(helpers).toContain("MAX_PO_HANDOFF_LINES = 25");
    expect(page).toContain("lines.length > MAX_PO_HANDOFF_LINES");
  });

  it("renders engine output without recomputing planning math client-side", () => {
    // Single-engine invariant: the drawer and table read engine fields…
    expect(page).toContain("forwardDemandBasis");
    expect(page).toContain("adjustedReorderPoint");
    expect(page).toContain("leadTimeBasis");
    expect(page).toContain("reorderPointPieces");
    expect(page).toContain("demandWindowDiagnostics");
    expect(page).toContain("forecastBlend");
    expect(page).toContain("earliestInboundEta");
    expect(page).toContain("skippedReason");
  });

  it("is gated by the useNewReorderCockpit procurement setting end-to-end", () => {
    // Server: whitelisted key with a safe default.
    expect(service).toContain('"useNewReorderCockpit"');
    expect(service).toContain("useNewReorderCockpit: false");
    // Settings page: admin-toggleable with a real label.
    expect(settingsPage).toContain('key: "useNewReorderCockpit"');
    // Router: flag switch on /reorder-analysis…
    expect(app).toContain("useNewReorderCockpit");
    expect(app).toContain("ReorderAnalysisRoute");
    // …with the always-legacy fallback route registered.
    expect(app).toContain('path="/reorder-analysis/legacy"');
    expect(app).toMatch(/reorder-analysis\/legacy"[\s\S]{0,200}component=\{PurchasingView\}/);
  });
});
