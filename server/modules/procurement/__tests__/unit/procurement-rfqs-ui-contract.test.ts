import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Preserve the RFQ navigation and list contracts while the workflow panel owns
// quote capture and draft conversion. Browser and PG tests verify its behavior.

// Normalize CRLF so a core.autocrlf=true (Windows) checkout matches the same
// bytes CI's LF checkout sees.
const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");

const page = readSource("client/src/pages/ProcurementRfqs.tsx");
const panel = readSource("client/src/features/purchasing/RfqWorkflowPanel.tsx");
const workflowRoutes = readSource("server/modules/procurement/rfq-workflow.routes.ts");
const app = readSource("client/src/App.tsx");
const routes = readSource("server/modules/procurement/purchasing-recommendation.routes.ts");
const rfqService = readSource("server/modules/procurement/purchasing-rfq.service.ts");
const commandClient = readSource("client/src/lib/rfq-command.ts");
const commandHook = readSource("client/src/features/purchasing/use-rfq-commands.ts");
const listContract = readSource("shared/procurement/rfq-work-list.ts");
const listRepository = readSource("server/modules/procurement/rfq-work-list.repository.ts");
const reorderEnginePage = readSource("client/src/pages/ReorderEngine.tsx");
const automationPage = readSource("client/src/pages/ProcurementAutomation.tsx");
const runsPage = readSource("client/src/pages/ProcurementRuns.tsx");

describe("procurement RFQs UI contract", () => {
  it("is registered at /procurement/rfqs with purchasing or legacy inventory read access", () => {
    expect(app).toContain('path="/procurement/rfqs"');
    expect(app).toMatch(
      /procurement\/rfqs"[\s\S]{0,300}component=\{ProcurementRfqs\}[\s\S]{0,200}purchasing[\s\S]{0,200}inventory/,
    );
  });

  it("consumes exactly the two RFQ read endpoints", () => {
    // The tracking list added with this page…
    expect(page).toContain("/api/purchasing/rfqs?");
    expect(page).toContain("rfqWorkListResponseSchema.safeParse");
    expect(page).toContain("WorkListPagination");
    // …and the existing requirement queue the Order Builder also reads.
    expect(page).toContain('"/api/purchasing/rfq-queue"');
    expect(routes).toContain('app.get("/api/purchasing/rfq-queue"');
  });

  it("delegates quote capture and draft conversion to the permission-aware workflow panel", () => {
    expect(page).toContain("<RfqWorkflowPanel");
    expect(panel).toContain("useRfqCommands(rfqId)");
    expect(commandHook).toContain('hasPermission("purchasing", "edit")');
    expect(commandClient).toContain("financialCommandFetchJson");
    expect(commandClient).toContain("Idempotency-Key");
    expect(commandClient).toContain("createPersistentFinancialIntentStore");
    expect(commandClient).toContain("matchesRfqCommandReceipt");
    expect(panel).toContain('operation: "capture_quote"');
    expect(panel).toContain('operation: "convert"');
    expect(panel).toContain("quoteRevisionId: line.latestQuote!.id");
    expect(page).toContain("RFQs start in the Order Builder");
    expect(workflowRoutes).toContain('requirePermission("purchasing", "edit")');
  });
  it("registers the new server endpoint read-only through the service seam", () => {
    expect(routes).toMatch(/app\.get\("\/api\/purchasing\/rfqs",\s*requireAnyPermission\(\["purchasing", "view"\], \["inventory", "view"\]\)/);
    // No mutation verb is ever registered on the /api/purchasing/rfqs path.
    expect(routes).not.toMatch(/app\.(post|put|patch|delete)\("\/api\/purchasing\/rfqs/);
    // The route delegates to the service seam instead of inlining SQL…
    expect(routes).toContain("listRequestForQuotes(db, query.data)");
    expect(rfqService).toContain("export async function listRequestForQuotes");
    // Untrusted filters are validated and the snapshot is explicitly read-only.
    expect(listContract).toContain("RFQ_LIST_MAX_LIMIT = 100");
    expect(rfqService).toContain("rfqWorkListQuerySchema.parse");
    expect(listRepository).toContain('isolationLevel: "repeatable read", accessMode: "read only"');
  });

  it("connects requests to quote review and their exact purchase orders", () => {
    expect(page).toContain("Request quote");
    expect(page).toContain("Order Builder");
    expect(page).toContain('href="/reorder-analysis"');
    expect(page).toContain("Record the final vendor quote here");
    expect(page).toContain("focusedRfqId");
    expect(panel).toContain("purchaseOrder.purchaseOrderId");
    expect(panel).toContain("Quote history");
    expect(panel).toContain("Create draft PO");
  });
  it("renders the full schema status enums instead of masking them", () => {
    // Stored lifecycle statuses must render without masking quoted/ordered rows.
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
