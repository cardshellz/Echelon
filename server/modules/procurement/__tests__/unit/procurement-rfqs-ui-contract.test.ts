import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// UI contract for the RFQ workbench page (design surface 05,
// /procurement/rfqs) — the LAST engine surface re-homed before PurchasingView
// retires. Pattern follows procurement-runs-ui-contract.test.ts: pin the
// load-bearing strings so a refactor cannot silently drop a frozen contract —
// the route + roles, the endpoints the page consumes, the READ-ONLY invariant
// on BOTH sides (the page performs no mutations; the new server endpoint is
// registered as a GET with no mutation sibling), the demoted-to-tracking
// framing, and the engine tab-strip agreement across all four shipped pages.

// Normalize CRLF so a core.autocrlf=true (Windows) checkout matches the same
// bytes CI's LF checkout sees.
const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");

const page = readSource("client/src/pages/ProcurementRfqs.tsx");
const app = readSource("client/src/App.tsx");
const routes = readSource("server/modules/procurement/purchasing-recommendation.routes.ts");
const rfqService = readSource("server/modules/procurement/purchasing-rfq.service.ts");
const reorderEnginePage = readSource("client/src/pages/ReorderEngine.tsx");
const automationPage = readSource("client/src/pages/ProcurementAutomation.tsx");
const runsPage = readSource("client/src/pages/ProcurementRuns.tsx");

describe("procurement RFQs UI contract", () => {
  it("is registered at /procurement/rfqs for admin/lead", () => {
    expect(app).toContain('path="/procurement/rfqs"');
    expect(app).toMatch(
      /procurement\/rfqs"[\s\S]{0,300}component=\{ProcurementRfqs\}[\s\S]{0,100}allowedRoles=\{\["admin", "lead"\]\}/,
    );
  });

  it("consumes exactly the two RFQ read endpoints", () => {
    // The tracking list added with this page…
    expect(page).toContain("/api/purchasing/rfqs?limit=");
    // …and the existing requirement queue the Order Builder also reads.
    expect(page).toContain('"/api/purchasing/rfq-queue"');
    expect(routes).toContain('app.get("/api/purchasing/rfq-queue"');
  });

  it("performs NO mutations — the page is read-only", () => {
    // RFQ creation lives in the cockpit's Order Builder (POST
    // /api/purchasing/rfq-queue, pinned by reorder-engine-ui-contract), and
    // the post-draft lifecycle is not built server-side. Nothing on this page
    // may create, send, or award: no fetch method, no HTTP verb literal, no
    // useMutation.
    expect(page.match(/method: "/g)).toBeNull();
    expect(page).not.toMatch(/"(?:POST|PATCH|PUT|DELETE)"/);
    expect(page).not.toContain("useMutation");
    // The creation affordance is a LINK back to the Order Builder.
    expect(page).toContain("RFQs start in the Order Builder");
  });

  it("registers the new server endpoint read-only through the service seam", () => {
    // GET /api/purchasing/rfqs: permission consistent with the sibling
    // procurement read (GET /api/purchasing/rfq-queue is "inventory"/"view").
    expect(routes).toContain(
      'app.get("/api/purchasing/rfqs", requirePermission("inventory", "view")',
    );
    // No mutation verb is ever registered on the /api/purchasing/rfqs path.
    expect(routes).not.toMatch(/app\.(post|put|patch|delete)\("\/api\/purchasing\/rfqs/);
    // The route delegates to the service seam instead of inlining SQL…
    expect(routes).toContain("listRequestForQuotes(db, { limit: req.query.limit })");
    expect(rfqService).toContain("export async function listRequestForQuotes");
    // …the list is bounded (untrusted limit clamped server-side)…
    expect(rfqService).toContain("RFQ_LIST_MAX_LIMIT = 100");
    expect(rfqService).toContain("parseRfqListLimit");
    // …and the whole service stays read-only: selects only, no writes.
    expect(rfqService).not.toMatch(/\.(insert|update|delete|execute)\(/);
  });

  it("frames the demoted workbench honestly: tracking, not an entry point", () => {
    // Spec §11.2/§11.3: quote requests START in the Order Builder; a line
    // lands here only via "Request quote".
    expect(page).toContain("Request quote");
    expect(page).toContain("Order Builder");
    expect(page).toContain('href="/reorder-analysis"');
    // The mock's send/compare/award stages are NOT built server-side — the
    // unshipped lifecycle is one quiet line, not a fake pipeline.
    expect(page).toContain(
      "unlock when the RFQ lifecycle ships",
    );
    expect(page).not.toContain("Award & draft POs");
    expect(page).not.toContain("comparison matrix");
  });

  it("renders the full schema status enums instead of masking them", () => {
    // request_for_quotes_status_chk — everything is draft until the lifecycle
    // ships, but a row that ever carries another status must render honestly.
    for (const status of ["draft", "sent", "partially_quoted", "quoted", "declined", "cancelled", "expired"]) {
      expect(page).toContain(`${status}:`);
    }
    // request_for_quote_lines_status_chk adds accepted/ordered.
    expect(page).toContain("accepted:");
    expect(page).toContain("ordered:");
    // Draft-time override evidence indicators (migration 158 contract).
    expect(page).toContain("quantityOverrideReason");
    expect(page).toContain("allocationOverrideApprovedBy");
    expect(page).toContain("allocationOverrideExcessPieces");
    // Quote-capture evidence is not masked: the quoted unit cost renders when
    // present, through the shared integer-mills formatter — never ad-hoc float
    // division on money.
    expect(page).toContain("quotedUnitCostMills != null");
    expect(page).toContain("formatMills(");
    expect(page).not.toMatch(/quotedUnitCostMills\s*[/*]/);
  });

  it("renders its own engine tab strip with RFQs current — and the strips agree across all four pages", () => {
    const surfaces = [
      { name: "rfqs", source: page, ownHref: "/procurement/rfqs" },
      { name: "reorder engine", source: reorderEnginePage, ownHref: "/reorder-analysis" },
      { name: "automation", source: automationPage, ownHref: "/procurement/automation" },
      { name: "runs", source: runsPage, ownHref: "/procurement/runs" },
    ] as const;
    const allHrefs = [
      "/reorder-analysis",
      "/demand-planner",
      "/procurement/automation",
      "/procurement/runs",
      "/procurement/rfqs",
    ];
    for (const surface of surfaces) {
      // Every page renders the shared strip with itself marked current…
      expect(surface.source, surface.name).toContain('aria-label="Reorder Engine sections"');
      expect(surface.source, surface.name).toContain('aria-current="page"');
      // …links every OTHER surface…
      for (const href of allHrefs) {
        if (href === surface.ownHref) continue;
        expect(surface.source, `${surface.name} → ${href}`).toContain(`href="${href}"`);
      }
      // …never links itself (the current surface is a span, not a link)…
      expect(surface.source, `${surface.name} self-link`).not.toContain(`href="${surface.ownHref}"`);
      // …and carries no leftover coming-soon chip mechanism.
      expect(surface.source, surface.name).not.toContain("ENGINE_TABS_COMING_SOON");
      expect(surface.source, surface.name).not.toContain("aria-disabled");
    }
  });
});
