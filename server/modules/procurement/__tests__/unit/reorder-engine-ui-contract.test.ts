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
const appShell = readFileSync(
  resolve(process.cwd(), "client/src/components/layout/AppShell.tsx"),
  "utf8",
);
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

  it("routes review-queue links to the Automation page with the query preserved", () => {
    // The review queue re-homed to /procurement/automation: the cockpit banner
    // forwards the FULL original query there (frozen server-generated params
    // keep working), and the legacy escape hatch stays only as a route.
    expect(helpers).toContain("/procurement/automation");
    expect(helpers).not.toContain("/reorder-analysis/legacy");
    expect(page).toContain("deepLink.automationUrl");
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

  it("renders the engine tab strip: Analysis active, Demand Planner + Automation live, rest inert", () => {
    // One in-page strip under the header (rev-1 single-entry nav decision,
    // spec §10.1 / §11): the engine surfaces never present as nav siblings.
    expect(page).toContain('aria-label="Reorder Engine sections"');
    // Analysis is this page — marked current, not a link.
    expect(page).toContain('aria-current="page"');
    // Demand Planner is the live forward-demand surface, linked and honestly
    // labeled — NOT the parked "Forecast inputs" design (spec §12.3).
    expect(page).toContain('href="/demand-planner"');
    expect(page).toContain("Demand Planner");
    expect(page).not.toContain("Forecast inputs");
    // Automation shipped (design surface 03) — the chip is a LIVE link now.
    expect(page).toContain('href="/procurement/automation"');
    // Runs shipped (design surface 04) — the chip is a LIVE link now.
    expect(page).toContain('href="/procurement/runs"');
    // …and all target routes actually exist, so no link can go dead.
    expect(app).toContain('path="/demand-planner"');
    expect(app).toContain('path="/procurement/automation"');
    expect(app).toMatch(/procurement\/automation"[\s\S]{0,200}component=\{ProcurementAutomation\}/);
    expect(app).toContain('path="/procurement/runs"');
    expect(app).toMatch(/procurement\/runs"[\s\S]{0,200}component=\{ProcurementRuns\}/);
    // Unshipped surfaces are inert muted chips with a Soon pill — pinned set,
    // ACTUALLY rendered (the const alone could go stale), aria-disabled, and
    // NO dead links: the only hrefs in the whole page are Demand Planner,
    // Automation, and Runs.
    expect(page).toContain('ENGINE_TABS_COMING_SOON = ["RFQs"]');
    expect(page).toContain("ENGINE_TABS_COMING_SOON.map");
    expect(page).toContain('aria-disabled="true"');
    expect(page).toContain("Soon");
    const hrefs = Array.from(page.matchAll(/href="([^"]+)"/g)).map((match) => match[1]);
    expect(hrefs).toEqual(["/demand-planner", "/procurement/automation", "/procurement/runs"]);
    // The href scan above only sees literal href="…" — ban the two syntaxes
    // that would let a chip become a link while evading it: wouter's `to`
    // alias and computed href={…} expressions.
    expect(page).not.toMatch(/\bto="/);
    expect(page).not.toMatch(/\bhref=\{/);
  });

  it("relabels the single Procurement nav entry when the cockpit flag is on (PR 5)", () => {
    // AppShell reads the SAME settings query key as the route switch in
    // App.tsx, so React Query dedupes and the nav label can never disagree
    // with which page /reorder-analysis actually renders.
    expect(appShell).toContain('queryKey: ["/api/settings/procurement"]');
    expect(appShell).toContain("useNewReorderCockpit");
    // Fail-safe is STRICT: only an explicit `true` from the settings payload
    // flips the label — undefined data (fetch pending, 401/403, 500, or the
    // query disabled for roles that can't see Procurement) stays legacy. And
    // the fetch never fires at all for roles the endpoint would 403.
    expect(appShell).toContain("procurementSettings?.useNewReorderCockpit === true");
    expect(appShell).toContain("enabled: canSeeProcurementNav");
    expect(appShell).toContain("retry: false");
    // Flag OFF (or settings load error) → the base structure's legacy label,
    // byte-identical to the pre-flag nav.
    expect(appShell).toContain(
      '{ label: "Reorder Analysis", icon: BarChart3, href: REORDER_ANALYSIS_HREF }',
    );
    // Flag ON → same href, same icon, relabeled "Reorder Engine".
    expect(appShell).toContain('REORDER_ANALYSIS_HREF = "/reorder-analysis"');
    expect(appShell).toContain('REORDER_ENGINE_NAV_LABEL = "Reorder Engine"');
    expect(appShell).toMatch(
      /child\.href === REORDER_ANALYSIS_HREF\s*\?\s*\{ \.\.\.child, label: REORDER_ENGINE_NAV_LABEL \}\s*:\s*child/,
    );
    // …and the sidebar renders the DERIVED view, not the base structure —
    // otherwise the relabel logic above could exist but never take effect.
    expect(appShell).toContain("{navEntries.map((entry) => {");
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
