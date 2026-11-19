import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import type { CostIssue } from "@shared/procurement/cost-source-contracts";
import { CostIssueMessage } from "../../CostIssueMessage";
import { CostLinkRepairAction } from "../../CostLinkRepairAction";
import { CostLinkRepairSummary } from "../../CostLinkRepairSummary";
import { costLinkRepair } from "../../../../../../test/fixtures/cost-link-repair";

function renderAction(issues: CostIssue[]): string {
  return renderToStaticMarkup(
    createElement(Router, {
      ssrPath: "/purchase-orders/17",
      ssrSearch: "?tab=lines",
      children: createElement(CostLinkRepairAction, {
        shipmentId: 42,
        lineId: 11,
        issues,
      }),
    }),
  );
}

describe("cost-link repair real rendering", () => {
  it("renders an ordinary issue without inventing an order link", () => {
    const markup = renderToStaticMarkup(
      createElement(CostIssueMessage, {
        issue: { code: "COST_REVIEW", message: "Receipt evidence is missing." },
      }),
    );
    expect(markup).toContain("Receipt evidence is missing.");
    expect(markup).not.toContain("/orders?");
  });

  it("links an unverified sale to its recorded order for review", () => {
    const markup = renderToStaticMarkup(
      createElement(CostIssueMessage, {
        issue: {
          code: "COST_ORDER_SALE_UNVERIFIED",
          message: "Existing costs were preserved.",
          orderCostReview: {
            orderId: 27,
            orderCostId: 81,
            inventoryLotId: 503,
            quantity: 5,
            status: "cancelled",
          },
        },
      }),
    );
    expect(markup).toContain("Existing costs were preserved.");
    expect(markup).toContain('href="/orders?orderId=27"');
    expect(markup).toContain("Review order #27");
  });

  it.each([false, true])(
    "renders the cost history and before/after with approved=%s",
    (approved) => {
      const markup = renderToStaticMarkup(
        createElement(CostLinkRepairSummary, {
          summary: costLinkRepair,
          approved,
        }),
      );
      expect(markup).toContain(
        approved
          ? "Cost links restored"
          : "Transfer and repacking links to restore",
      );
      expect(markup).toContain("Recorded warehouse transfer");
      expect(markup).toContain("Recorded case opened into packs");
      expect(markup).toContain("#802, #803");
      expect(markup).toContain("Before");
      expect(markup).toContain(approved ? "Saved" : "After approval");
      expect(markup).toContain("$1.00");
      expect(markup).toContain("$3.50");
      expect(markup).toContain("New expense postings: <strong>0</strong>");
      expect(markup).toContain(
        "Its cost stays unassigned; no expense will be created.",
      );
    },
  );

  it("opens the affected shipment line from a missing-history issue", () => {
    const markup = renderAction([
      {
        code: "COST_HISTORICAL_LINEAGE_MISSING",
        message: "Transfer cost link is missing.",
      },
    ]);
    expect(markup).toContain("Review transfer and repacking links");
    expect(markup).toContain("/shipments/42?");
    expect(markup).toContain("repairCostLinks=11");
  });

  it("keeps the remaining evidence requirement without repeating an approved repair", () => {
    const markup = renderAction([
      {
        code: "COST_UNRESOLVED_QUANTITY_RETAINED",
        message: "Three packs have no recorded destination.",
        costLinksAlreadyReviewed: true,
      },
    ]);
    expect(markup).toContain(
      "Transfer and repacking links have already been reviewed.",
    );
    expect(markup).toContain("quantities need stock movement evidence");
    expect(markup).not.toContain("repairCostLinks=");
  });
});
