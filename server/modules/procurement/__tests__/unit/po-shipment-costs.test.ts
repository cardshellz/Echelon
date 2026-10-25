import { describe, expect, it } from "vitest";
import {
  buildPoShipmentCosts,
  type PoShipmentCostSummaryInput,
  type PoShipmentCostLineDetail,
} from "../../domain/po-shipment-cost-summary";
import { shipmentCostReviewGuidance } from "@shared/procurement/po-shipment-costs";
import type { ShipmentCostException } from "@shared/procurement/shipment-cost-exception";

const source = (): PoShipmentCostSummaryInput => ({
  poId: 1,
  currency: "USD",
  poAmountCents: 10000,
  shipmentIds: [10],
  charges: [
    {
      id: 20,
      shipmentId: 10,
      costType: "freight",
      currency: "USD",
      amountCents: 1000,
      confirmed: true,
    },
  ],
  allocations: [
    { costId: 20, poId: 1, lineId: 30, allocatedCents: 600 },
    { costId: 20, poId: 2, lineId: 31, allocatedCents: 400 },
  ],
  lines: [
    {
      id: 30,
      quantity: 80,
      sourceTotalMills: 60000,
      sourceQuantity: 80,
      evidence: "confirmed",
      applicationStatus: "applied",
      issue: null,
    },
  ],
});
const detail = (): PoShipmentCostLineDetail => ({
  lineId: 30,
  shipmentId: 10,
  shipmentNumber: "TEST-SHIP-10",
  shipmentStatus: "closed",
  sku: "TEST-SKU",
  applicationId: 100,
  recordedAt: "2026-10-13T11:18:59.298Z",
  sourceIssue: null,
  applicationIssues: [],
});
const supplier = { freightCents: 300, dutyCents: 200 };

it("retains the PO line identity for allocated costs, independently of SKU", () => {
  const result = buildPoShipmentCosts(source(), supplier, [{ ...detail(), purchaseOrderLineId: 44 }]);
  expect(result.lines[0]).toMatchObject({ lineId: 30, purchaseOrderLineId: 44, allocatedCents: 600 });
});

function postedReview(): ShipmentCostException {
  return {
    state: "open", fingerprint: "a".repeat(64), kind: "missing_receipt_history", currency: "USD",
    allocatedMills: 60000, amountMills: 60000, lotsUpdated: 0, cogsRowsUpdated: 0, decision: null,
    issues: [{ code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Receipt cost links were not recorded." }],
    reconciliation: { status: "posted", destination: "historical_cogs", postedMills: 60000, unassignedMills: 0 },
  };
}

describe("current reconciliation resolves the PO cost status, preserving its audit", () => {
  function reconciled() {
    const input = source(), review = postedReview();
    input.lines[0].applicationStatus = "review_required";
    const recorded = { ...detail(), applicationIssues: review.issues, exceptionReview: review };
    return { input, recorded, review };
  }
  it.each(["confirmed", "estimated"])("counts a posted %s charge as complete", evidence => {
    const { input, recorded } = reconciled();
    input.lines[0].evidence = evidence;
    input.charges[0].confirmed = evidence === "confirmed";
    const before = JSON.stringify({ input, recorded });
    expect(buildPoShipmentCosts(input, supplier, [recorded])).toMatchObject({
      summary: { appliedLines: 1, reviewLines: 0, pendingLines: 0, inventoryCosting: "applied",
        estimatedCents: evidence === "estimated" ? 600 : 0 },
      lines: [{ status: "applied", issues: recorded.applicationIssues, exceptionReview: recorded.exceptionReview }],
      totals: { freightCents: 900, dutyCents: 200, combinedCostCents: 10600 },
    });
    expect(JSON.stringify({ input, recorded })).toBe(before);
  });
  it.each(["unresolved", "review_required"] as const)("keeps %s costs actionable", status => {
    const { input, recorded } = reconciled();
    recorded.exceptionReview.reconciliation!.status = status;
    expect(buildPoShipmentCosts(input, supplier, [recorded])).toMatchObject({
      summary: { reviewLines: 1, inventoryCosting: "review_required" }, lines: [{ status: "review_required" }],
    });
  });
  it("keeps a fully reversed zero charge complete when the allocator removes zero allocations", () => {
    const { input, recorded } = reconciled();
    input.charges[0].amountCents = 0;
    input.allocations = [];
    input.lines[0].sourceTotalMills = 0;
    recorded.exceptionReview.allocatedMills = 0;
    recorded.exceptionReview.amountMills = 0;
    recorded.exceptionReview.reconciliation!.postedMills = 0;
    expect(buildPoShipmentCosts(input, supplier, [recorded])).toMatchObject({
      summary: { totalCents: 0, appliedLines: 1, reviewLines: 0, unallocatedChargeCount: 0, inventoryCosting: "applied" },
      totals: { combinedCostCents: 10000 }, lines: [{ status: "applied" }],
    });
  });
  it.each(["amount", "quantity", "source issue", "new issue", "unreadable issues", "no application"])(
    "never lets a saved posting hide changed or invalid evidence: %s", change => {
      const { input, recorded } = reconciled();
      const row: PoShipmentCostLineDetail = recorded;
      if (change === "amount") input.lines[0].sourceTotalMills = 50000;
      if (change === "quantity") input.lines[0].sourceQuantity = 79;
      if (change === "source issue") row.sourceIssue = { code: "LANDED_ALLOCATION_STALE", message: "Split changed." };
      if (change === "new issue") row.applicationIssues = [{ code: "COST_GRAPH_INCOMPLETE", message: "New missing history." }];
      if (change === "unreadable issues") row.applicationIssues = null;
      if (change === "no application") row.applicationId = null;
      expect(buildPoShipmentCosts(input, supplier, [row])).toMatchObject({
        summary: { reviewLines: 1, inventoryCosting: "review_required" }, lines: [{ status: "review_required" }],
      });
    },
  );
  it("counts only the remaining unresolved line in a mixed PO", () => {
    const { input, recorded } = reconciled();
    input.allocations[1].poId = input.poId;
    input.lines.push({ ...input.lines[0], id: 31, sourceTotalMills: 40000 });
    const outstanding = { ...detail(), lineId: 31, applicationIssues: [{ code: "COST_GRAPH_INCOMPLETE", message: "Missing attribution." }] };
    expect(buildPoShipmentCosts(input, supplier, [recorded, outstanding])).toMatchObject({
      summary: { appliedLines: 1, reviewLines: 1, pendingLines: 0, inventoryCosting: "review_required" },
      lines: [{ status: "applied" }, { status: "review_required" }],
    });
  });
});

describe("PO card totals and recorded shipment cost review", () => {
  it("keeps a retained quantity review visible and does not suggest retrying away missing history", () => {
    const issue = { code:"COST_UNRESOLVED_QUANTITY_RETAINED",message:"Lot CASE-1: four units remain unresolved.",
      unresolvedQuantity:{inventoryLotId:3364,allocationId:1,lotNumber:"CASE-1",originalQuantity:220,
        onHandQuantityAtReview:157,recordedOutflowQuantityAtReview:59,quantity:4,component:"landed" as const,amountMills:609104} };
    const input = source(); input.lines[0].applicationStatus="review_required";
    const costs = buildPoShipmentCosts(input,supplier,[{...detail(),applicationIssues:[issue]}]);
    expect(costs.lines[0]).toMatchObject({status:"review_required",issues:[issue]});
    expect(shipmentCostReviewGuidance([issue]).nextStep).toContain("retrying will not resolve");
  });
  it("shows supplier plus allocated shipment charges without adding supplier charges twice", () => {
    expect(buildPoShipmentCosts(source(), supplier, [detail()])).toMatchObject({
      supplier,
      totals: { freightCents: 900, dutyCents: 200, combinedCostCents: 10600 },
      summary: { appliedLines: 1, totalCents: 600 },
      lines: [
        {
          lineId: 30,
          shipmentId: 10,
          sku: "TEST-SKU",
          allocatedCents: 600,
          status: "applied",
          issues: [],
        },
      ],
    });
  });
  it("retains signed allocated credits in the top cards", () => {
    const input = source();
    input.charges[0].amountCents = -1000;
    input.allocations[0].allocatedCents = -600;
    input.allocations[1].allocatedCents = -400;
    expect(buildPoShipmentCosts(input, supplier, [detail()]).totals).toEqual({
      freightCents: -300,
      dutyCents: 200,
      combinedCostCents: 9400,
    });
  });
  it.each(["missing allocation", "another currency"])(
    "keeps cards incomplete for %s",
    (problem) => {
      const input = source();
      if (problem === "missing allocation") input.allocations = [];
      else input.charges[0].currency = "EUR";
      expect(buildPoShipmentCosts(input, supplier, [detail()]).totals).toEqual({
        freightCents: null,
        dutyCents: null,
        combinedCostCents: null,
      });
    },
  );
  it("preserves the latest recorded reasons, timestamp and identity", () => {
    const input = source();
    input.lines[0].applicationStatus = "review_required";
    const issue = {
      code: "COST_UNIFORM_LOT_RESIDUAL_REVIEW",
      message: "Exact remainder was preserved for review.",
    };
    const recorded = { ...detail(), applicationIssues: [issue] };
    expect(buildPoShipmentCosts(input, supplier, [recorded])).toMatchObject({
      summary: { reviewLines: 1, inventoryCosting: "review_required" },
      lines: [
        {
          status: "review_required",
          applicationId: 100,
          recordedAt: recorded.recordedAt,
          issues: [issue],
        },
      ],
    });
  });
  it("includes source errors even before a cost application was recorded", () => {
    const input = source();
    input.lines[0].applicationStatus = null;
    const issue = {
      code: "LANDED_ALLOCATION_STALE",
      message: "The saved allocation is outdated.",
    };
    const result = buildPoShipmentCosts(input, supplier, [
      {
        ...detail(),
        applicationId: null,
        recordedAt: null,
        sourceIssue: issue,
      },
    ]);
    expect(result.summary.reviewLines).toBe(1);
    expect(result.lines[0].issues).toEqual([issue]);
  });
  it.each([
    null,
    [{ code: "invalid code", message: "Bad history" }],
    "not an array",
  ])(
    "shows unreadable recorded reasons explicitly (%j)",
    (applicationIssues) => {
      const result = buildPoShipmentCosts(source(), supplier, [
        { ...detail(), applicationIssues },
      ]);
      expect(result.lines[0]).toMatchObject({
        status: "review_required",
        issues: [{ code: "COST_REVIEW_DETAILS_MISSING" }],
      });
      expect(result.summary.inventoryCosting).toBe("review_required");
    },
  );
  it("does not call an unrecorded update applied", () => {
    const input = source();
    input.lines[0].applicationStatus = null;
    const result = buildPoShipmentCosts(input, supplier, [
      {
        ...detail(),
        applicationId: null,
        recordedAt: null,
        applicationIssues: null,
      },
    ]);
    expect(result.lines[0]).toMatchObject({
      status: "pending",
      issues: [{ code: "COST_UPDATE_NOT_RECORDED" }],
    });
  });
  it("keeps supplier confirmation separate from completed estimate posting", () => {
    const input = source();
    input.charges[0].confirmed = false;
    input.lines[0].evidence = "estimated";
    expect(
      buildPoShipmentCosts(input, supplier, [detail()]).lines[0],
    ).toMatchObject({
      status: "applied",
      issues: [],
    });
  });
  it("explains an applied result that is outdated after an allocation changes", () => {
    const input = source();
    input.lines[0].sourceTotalMills = 50000;
    expect(
      buildPoShipmentCosts(input, supplier, [detail()]).lines[0],
    ).toMatchObject({
      status: "pending",
      issues: [{ code: "COST_UPDATE_OUTDATED" }],
    });
  });
  it("classifies a recorded retry as review", () => {
    const input = source();
    input.lines[0].applicationStatus = "retry_required";
    expect(
      buildPoShipmentCosts(input, supplier, [detail()]).summary.reviewLines,
    ).toBe(1);
  });
  it("rejects duplicate and foreign line identities", () => {
    expect(() =>
      buildPoShipmentCosts(source(), supplier, [detail(), detail()]),
    ).toThrow();
    expect(() =>
      buildPoShipmentCosts(source(), supplier, [
        { ...detail(), shipmentId: 999 },
      ]),
    ).toThrow();
    expect(() =>
      buildPoShipmentCosts(source(), supplier, [{ ...detail(), lineId: 31 }]),
    ).toThrow();
    const input = source();
    input.allocations.push({ ...input.allocations[0] });
    expect(() => buildPoShipmentCosts(input, supplier, [detail()])).toThrow();
  });
  it("rejects fractional and overflowing card amounts", () => {
    expect(() =>
      buildPoShipmentCosts(source(), { ...supplier, freightCents: 0.5 }, [
        detail(),
      ]),
    ).toThrow();
    expect(() =>
      buildPoShipmentCosts(
        source(),
        { ...supplier, freightCents: Number.MAX_SAFE_INTEGER },
        [detail()],
      ),
    ).toThrow();
  });
  it("does not mutate inputs", () => {
    const input = source(),
      recorded = detail();
    const before = JSON.stringify({ input, recorded, supplier });
    buildPoShipmentCosts(input, supplier, [recorded]);
    expect(JSON.stringify({ input, recorded, supplier })).toBe(before);
  });
});

describe("actionable cost review wording", () => {
  const issue = (code: string) => ({ code, message: "Recorded problem" });
  it("explains an earlier rounding failure and invites a checked retry", () => {
    expect(
      shipmentCostReviewGuidance([
        issue("COST_UNIFORM_LOT_RESIDUAL_REVIEW"),
        issue("COST_GRAPH_INCOMPLETE"),
      ]),
    ).toMatchObject({
      explanation: expect.stringContaining("earlier cost update"),
      nextStep: expect.stringContaining("Select Update shipment costs"),
    });
  });
  it("does not dismiss an independent history error as rounding", () => {
    expect(
      shipmentCostReviewGuidance([
        issue("COST_UNIFORM_LOT_RESIDUAL_REVIEW"),
        issue("COST_HISTORICAL_QUANTITY_INCOMPLETE"),
      ]).nextStep,
    ).toContain("recorded receipt");
  });
  it.each([
    ["LANDED_ALLOCATION_STALE", "Select Update shipment costs"],
    ["LANDED_INVOICE_SOURCE_MISMATCH", "supplier invoice"],
    ["COST_MANUAL_OVERRIDE_REVIEW", "manual cost correction"],
    ["COST_GRAPH_INCOMPLETE", "recorded receipt"],
    ["COST_UPDATE_NOT_RECORDED", "Check that the shipment charges"],
    ["COST_UNKNOWN_REASON", "reason shown above"],
  ])("gives a next step for %s", (code, wording) => {
    expect(shipmentCostReviewGuidance([issue(code)]).nextStep).toContain(
      wording,
    );
  });
});
