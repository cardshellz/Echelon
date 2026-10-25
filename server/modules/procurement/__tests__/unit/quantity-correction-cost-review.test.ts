import { describe, expect, it } from "vitest";
import type { CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import type { ReconciliationRecordEvidence } from "../../../inventory/domain/cost-reconciliation";
import { summarizeQuantityCorrectionCostReview } from "../../quantity-correction-cost-review";

const source: CostSourceRevision = {
  contractVersion: 1,
  revision: 1,
  fingerprint: "a".repeat(64),
  component: "landed",
  scope: {
    kind: "shipment_line",
    purchaseOrderId: 1,
    purchaseOrderLineId: 2,
    inboundShipmentId: 3,
    inboundShipmentLineId: 4,
  },
  sources: [
    {
      kind: "shipment_cost",
      documentId: 3,
      lineId: 5,
      version: "b".repeat(64),
    },
  ],
  currency: "USD",
  totalMills: 12983800,
  basePieces: 200000,
  evidence: "confirmed",
  packagingTreatment: "not_applicable",
  issue: null,
  manualOverride: null,
};
const record: ReconciliationRecordEvidence = {
  record: {
    lotId: 6,
    lotNumber: "TRANSFERRED-RECEIPT",
    originalQuantity: 20,
    onHandQuantity: 0,
    receiptId: 7,
    receiptLineId: 8,
    quantityWithoutHistory: null,
    explanation: "Missing transfer link",
  },
  hasCogs: false,
  hasContribution: false,
  hasLegacyCogs: false,
  hasPhysicalCommitments: false,
  existingLandedMills: 0,
};
function input(): Parameters<typeof summarizeQuantityCorrectionCostReview>[0] {
  return {
    source,
    status: "review_required",
    issues: [
      {
        code: "COST_HISTORICAL_LINEAGE_MISSING",
        message: "Missing transfer link",
      },
    ],
    records: [record],
    hasKnownRoots: false,
    balances: { historical_cogs: 0, inventory_variance: 0 },
    destination: null,
  };
}

describe("quantity correction cost review", () => {
  it("retains the saved shipment charge without interpreting an empty lot as a sale", () => {
    const value = input(),
      before = structuredClone(value);
    expect(summarizeQuantityCorrectionCostReview(value)).toEqual({
      unassignedMills: 12983800,
      needsHistoryReview: true,
      postedMills: 0,
      destination: null,
      affectedLots: [
        {
          lotId: 6,
          lotNumber: "TRANSFERRED-RECEIPT",
          receiptId: 7,
          receivedUnits: 20,
          onHandUnits: 0,
        },
      ],
    });
    expect(value).toEqual(before);
  });
  it.each([
    "known_origin",
    "existing_lot_cost",
    "order_cost",
    "older_order_cost",
    "transfer_link",
  ])(
    "does not claim the whole charge is unassigned when there is %s evidence",
    (kind) => {
      const value = input();
      value.hasKnownRoots = kind === "known_origin";
      value.records = [
        {
          ...record,
          existingLandedMills: kind === "existing_lot_cost" ? 1 : 0,
          hasCogs: kind === "order_cost",
          hasLegacyCogs: kind === "older_order_cost",
          hasContribution: kind === "transfer_link",
        },
      ];
      expect(
        summarizeQuantityCorrectionCostReview(value).unassignedMills,
      ).toBeNull();
    },
  );
  it("keeps unknown costing separate from missing inventory history", () => {
    expect(
      summarizeQuantityCorrectionCostReview({
        ...input(),
        source: null,
        issues: null,
        records: [],
      }),
    ).toMatchObject({ unassignedMills: null, needsHistoryReview: false });
    expect(
      summarizeQuantityCorrectionCostReview({
        ...input(),
        issues: [
          {
            code: "COST_CURRENCY_REVIEW",
            message: "Currency evidence missing",
          },
        ],
      }),
    ).toMatchObject({ unassignedMills: null, needsHistoryReview: false });
  });
  it("reports zero remaining only for a successful saved application with no issues", () => {
    expect(
      summarizeQuantityCorrectionCostReview({
        ...input(),
        status: "applied",
        issues: [],
        records: [],
      }),
    ).toMatchObject({ unassignedMills: 0, needsHistoryReview: false });
    expect(
      summarizeQuantityCorrectionCostReview({
        ...input(),
        issues: [],
        records: [],
      }).unassignedMills,
    ).toBeNull();
  });
  it("preserves exact sub-cent remainders and existing postings", () => {
    const value = input();
    value.issues = [
      {
        code: "COST_UNRESOLVED_QUANTITY_RETAINED",
        message: "Unexplained quantity",
        unresolvedQuantity: {
          inventoryLotId: 6,
          allocationId: 9,
          lotNumber: "TRANSFERRED-RECEIPT",
          originalQuantity: 20,
          onHandQuantityAtReview: 0,
          recordedOutflowQuantityAtReview: 19,
          quantity: 1,
          component: "landed",
          amountMills: 100001,
        },
      },
    ];
    value.balances = { historical_cogs: 100000, inventory_variance: 0 };
    value.destination = "historical_cogs";
    expect(summarizeQuantityCorrectionCostReview(value)).toMatchObject({
      unassignedMills: 1,
      postedMills: 100000,
      destination: "historical_cogs",
    });
    value.balances.historical_cogs = 100002;
    expect(
      summarizeQuantityCorrectionCostReview(value).unassignedMills,
    ).toBeNull();
  });
  it("does not hide a preserved posting that still requires reconciliation", () => {
    const value = input();
    value.issues!.push({
      code: "COST_EXISTING_POSTING_PRESERVED",
      message: "Earlier approval preserved",
    });
    value.balances.historical_cogs = 12983800;
    expect(summarizeQuantityCorrectionCostReview(value)).toMatchObject({
      unassignedMills: null,
      postedMills: 12983800,
      needsHistoryReview: true,
    });
  });
  it("rejects unsafe money before conversion or subtraction", () => {
    const value = input();
    value.balances.historical_cogs = Number.MAX_SAFE_INTEGER + 1;
    expect(() => summarizeQuantityCorrectionCostReview(value)).toThrow();
  });
});
