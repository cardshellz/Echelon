import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// UI contract for the Reorder Engine cockpit (PR 2 of the redesign).
// Pattern follows demand-planner-ui-contract.test.ts: pin the load-bearing
// strings so a refactor cannot silently drop a frozen server contract —
// the deep-link params persisted into notification rows, the endpoints the
// page consumes, the feature-flag key, and the legacy fallback route.

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

  it("consumes the purchasing endpoints and only those (read-only cockpit)", () => {
    expect(page).toContain("/api/purchasing/kpis");
    expect(page).toContain("/api/purchasing/reorder-analysis");
    expect(page).toContain("/api/purchasing/recommendation-runs"); // manual refresh (POST)
    expect(page).toContain("/api/purchasing/forecast-backtests"); // accuracy strip
    expect(page).toContain("/api/procurement/health/recommendation-pipeline"); // pipeline dot
    // No ordering actions in PR 2: no decision or PO/RFQ mutations.
    expect(page).not.toContain("/api/purchasing/recommendation-decisions");
    expect(page).not.toContain("/api/purchasing/recommendation-accepted-queue");
    expect(page).not.toContain("create-po");
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
