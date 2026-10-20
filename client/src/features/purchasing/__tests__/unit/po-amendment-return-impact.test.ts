import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { poAmendmentImpactSchema } from "@shared/procurement/po-amendment-impact";
import { PoAmendmentImpact } from "../../PoAmendmentImpact";

function impact(beforeMills = 10001, afterMills = 20002) {
  return poAmendmentImpactSchema.parse({
    quantities: [], shipments: [], lots: [], orderCosts: [], historicalCosts: [],
    applications: [{
      purchaseOrderLineId: 11, shipmentId: null, component: "product", status: "applied",
      lotsUpdated: 0, orderCostsUpdated: 0, orderCostDeltaCents: 0, issues: [],
      returnedCosts: [{ returnId: 9, returnLineId: 91, returnAllocationId: 191,
        costQuantityAllocationId: 391, inventoryLotId: 501, quantity: 2,
        component: "product", beforeMills, afterMills, deltaMills: afterMills - beforeMills }],
      returnedCostDeltaMills: afterMills - beforeMills,
    }],
  });
}
function render(value = impact(), approved = false) {
  return renderToStaticMarkup(createElement(Router, {
    ssrPath: "/purchase-orders/17", ssrSearch: "?tab=lines",
    children: createElement(PoAmendmentImpact, { impact: value, currency: "USD", purchaseOrderId: 17, approved }),
  }));
}

describe("PO amendment supplier-return value impact", () => {
  it("renders measured returned value, exact fractional cents, quantity and source", () => {
    const html = render();
    expect(html).toContain("Supplier-return value changes");
    expect(html).toContain("2 returned units");
    expect(html).toContain("1.0001 USD");
    expect(html).toContain("2.0002 USD");
    expect(html).toContain("/supplier-returns/9");
    expect(html).toContain("do not record a new physical return or supplier credit");
  });
  it("renders a negative value adjustment without turning it into cash or a credit", () => {
    const html = render(impact(20000, 10000));
    expect(html).toContain("Change: -1.0000 USD");
    expect(html).toContain("2.0000 USD");
    expect(html).toContain("1.0000 USD");
  });
  it("retains the measured returned value in approved history", () => {
    expect(render(impact(), true)).toContain("Returned value recorded at approval");
  });
  it("does not invent returned-value evidence for a legacy preview", () => {
    const value = impact();
    delete value.applications[0].returnedCosts;
    delete value.applications[0].returnedCostDeltaMills;
    expect(render(value)).not.toContain("Supplier-return value changes");
  });
});
