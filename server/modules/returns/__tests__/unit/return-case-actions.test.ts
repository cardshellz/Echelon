import { describe, expect, it } from "vitest";
import {
  deriveReturnCaseActionPlan,
  parseReturnPolicySnapshot,
  type ReturnCaseActionContext,
} from "../../domain/return-case-actions";

describe("return case action plan", () => {
  it("offers receipt first from exact unreceived WMS evidence", () => {
    const plan = deriveReturnCaseActionPlan(context());

    expect(plan.nextAction).toBe("record_receipt");
    expect(plan.receiptSummary).toEqual({
      expectedUnits: 2,
      receivedUnits: 0,
      remainingUnits: 2,
      fullyReceived: false,
      partiallyReceived: false,
    });
    expect(plan.inspectionSummary).toBeNull();
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: "record_receipt", state: "available", reasonCode: null }),
      expect.objectContaining({ kind: "start_inspection", state: "blocked", reasonCode: "RETURN_NOT_FULLY_RECEIVED" }),
      expect.objectContaining({ kind: "complete_inspection", state: "blocked", reasonCode: "RETURN_NOT_FULLY_RECEIVED" }),
      expect.objectContaining({ kind: "record_disposition", state: "blocked", reasonCode: "RETURN_NOT_FULLY_RECEIVED" }),
      expect.objectContaining({ kind: "apply_inventory_treatment", state: "blocked", reasonCode: "RETURN_NOT_FULLY_RECEIVED" }),
      expect.objectContaining({ kind: "issue_customer_refund", state: "blocked", reasonCode: "RETURN_INSPECTION_EVIDENCE_INVALID" }),
      expect.objectContaining({ kind: "settle_vendor_account", state: "not_applicable", reasonCode: "RETURN_VENDOR_SETTLEMENT_NOT_APPLICABLE" }),
    ]);
  });

  it("supports partial receipt without starting inspection", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "partially_received" },
      receipt: receipt({ receivedQuantity: 1, status: "partially_received" }),
    }));

    expect(plan.receiptSummary).toMatchObject({
      receivedUnits: 1,
      remainingUnits: 1,
      partiallyReceived: true,
    });
    expect(plan.nextAction).toBe("record_receipt");
  });

  it("offers inspection only after exact full receipt reconciliation", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
    }));

    expect(plan.nextAction).toBe("start_inspection");
    expect(plan.actions[0]).toMatchObject({ state: "completed" });
    expect(plan.actions[1]).toMatchObject({ state: "available" });
  });

  it("blocks on extra or unmapped WMS return items", () => {
    const facts = receipt();
    facts.items.push({
      returnCaseItemId: null,
      wmsReturnItemId: 99,
      caseExpectedQuantity: null,
      wmsExpectedQuantity: 1,
      wmsReceivedQuantity: 0,
      wmsStatus: "expected",
    });
    const plan = deriveReturnCaseActionPlan(context({ receipt: facts }));

    expect(plan.nextAction).toBeNull();
    expect(plan.actions[0]).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_WMS_ITEM_SET_MISMATCH",
    });
  });

  it("does not offer Card Shellz receipt or inspection for externally owned work", () => {
    const plan = deriveReturnCaseActionPlan(context({
      policy: { ...policy(), returnDestination: "vendor", inspectionOwner: "vendor" },
    }));

    expect(plan.nextAction).toBeNull();
    expect(plan.actions[0]).toMatchObject({ state: "not_applicable", reasonCode: "RETURN_DESTINATION_EXTERNAL" });
    expect(plan.actions[1]).toMatchObject({ state: "not_applicable", reasonCode: "RETURN_INSPECTION_OWNED_EXTERNALLY" });
    expect(plan.actions[2]).toMatchObject({ state: "not_applicable", reasonCode: "RETURN_INSPECTION_OWNED_EXTERNALLY" });
  });

  it("blocks unresolved conditional inspection", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received" },
      policy: { ...policy(), inspectionRequirement: "conditional" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
    }));

    expect(plan.actions[1]).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_CONDITIONAL_INSPECTION_UNRESOLVED",
    });
    expect(plan.actions[2]).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_CONDITIONAL_INSPECTION_UNRESOLVED",
    });
  });

  it("treats an active persisted inspection as already started", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "in_progress" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: {
        inspectionId: 8,
        status: "in_progress",
        startedAt: new Date("2026-08-22T12:00:00.000Z"),
        startedBy: "user:7",
        completedAt: null,
        completedBy: null,
      },
    }));

    expect(plan.nextAction).toBe("complete_inspection");
    expect(plan.actions[1]).toMatchObject({ state: "completed", reasonCode: null });
    expect(plan.actions[2]).toMatchObject({ state: "available", reasonCode: null });
    expect(plan.inspectionSummary).toMatchObject({
      inspectionId: 8,
      status: "in_progress",
      completedAt: null,
      completedBy: null,
    });
    expect(plan.inspectionSummary?.startedAt).toBeInstanceOf(Date);
  });

  it.each(["approved", "rejected"] as const)(
    "treats coherent %s inspection evidence as completed",
    (outcome) => {
      const completedAt = new Date("2026-08-22T12:15:00.000Z");
      const plan = deriveReturnCaseActionPlan(context({
        lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: outcome },
        receipt: receipt({ receivedQuantity: 2, status: "received" }),
        inspection: {
          inspectionId: 8,
          status: outcome,
          startedAt: new Date("2026-08-22T12:00:00.000Z"),
          startedBy: "user:7",
          completedAt,
          completedBy: "user:9",
        },
      }));

      expect(plan.nextAction).toBe("record_disposition");
      expect(plan.actions[1]).toMatchObject({ state: "completed", reasonCode: null });
      expect(plan.actions[2]).toMatchObject({ state: "completed", reasonCode: null });
      expect(plan.actions[3]).toMatchObject({ state: "available", reasonCode: null });
      expect(plan.inspectionSummary).toMatchObject({ inspectionId: 8, status: outcome });
      expect(plan.inspectionSummary?.completedAt).not.toBe(completedAt);
      expect(plan.inspectionSummary?.completedAt?.getTime()).toBe(completedAt.getTime());
    },
  );

  it("keeps coherent terminal evidence completed after later case closure and restocking", () => {
    const inspection: NonNullable<ReturnCaseActionContext["inspection"]> = {
      inspectionId: 8,
      status: "approved",
      startedAt: new Date("2026-08-22T12:00:00.000Z"),
      startedBy: "user:7",
      completedAt: new Date("2026-08-22T12:15:00.000Z"),
      completedBy: "user:9",
    };
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: {
        ...lifecycle(),
        caseStatus: "closed",
        logisticsStatus: "received",
        inspectionStatus: "approved",
      },
      receipt: {
        ...receipt({ receivedQuantity: 2, status: "received" }),
        restocked: true,
      },
      inspection,
      disposition: {
        recordCount: 1,
        lines: [{
          dispositionItemId: 100,
          dispositionId: 10,
          returnCaseItemId: 1,
          treatment: "restock_sellable",
          quantity: 2,
        }],
      },
    }));

    expect(plan.nextAction).toBeNull();
    expect(plan.actions[1]).toMatchObject({ state: "completed", reasonCode: null });
    expect(plan.actions[2]).toMatchObject({ state: "completed", reasonCode: null });
    expect(plan.inspectionSummary).not.toBe(inspection);
    expect(plan.actions[3]).toMatchObject({ state: "completed", reasonCode: null });
    expect(plan.inspectionSummary?.startedAt).not.toBe(inspection.startedAt);
    expect(plan.inspectionSummary?.startedAt.getTime()).toBe(inspection.startedAt.getTime());
    expect(plan.inspectionSummary?.completedAt).not.toBe(inspection.completedAt);
    expect(plan.inspectionSummary?.completedAt?.getTime()).toBe(inspection.completedAt.getTime());
  });
  it("requires persisted terminal inspection evidence instead of inferring completion", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "approved" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: null,
    }));

    expect(plan.nextAction).toBeNull();
    expect(plan.actions[1]).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_INSPECTION_STATE_CONFLICT",
    });
    expect(plan.actions[2]).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_INSPECTION_STATE_CONFLICT",
    });
    expect(plan.actions[3]).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_INSPECTION_STATE_CONFLICT",
    });
  });

  it("rejects cancelled or lifecycle-mismatched inspection evidence", () => {
    const cancelledPlan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "in_progress" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: {
        inspectionId: 8,
        status: "cancelled",
        startedAt: new Date("2026-08-22T12:00:00.000Z"),
        startedBy: "user:7",
        completedAt: new Date("2026-08-22T12:15:00.000Z"),
        completedBy: "user:9",
      },
    }));
    const mismatchedPlan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "rejected" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: {
        inspectionId: 9,
        status: "approved",
        startedAt: new Date("2026-08-22T12:00:00.000Z"),
        startedBy: "user:7",
        completedAt: new Date("2026-08-22T12:15:00.000Z"),
        completedBy: "user:9",
      },
    }));

    for (const plan of [cancelledPlan, mismatchedPlan]) {
      expect(plan.nextAction).toBeNull();
      expect(plan.actions[1]).toMatchObject({
        state: "blocked",
        reasonCode: "RETURN_INSPECTION_STATE_CONFLICT",
      });
      expect(plan.actions[2]).toMatchObject({
        state: "blocked",
        reasonCode: "RETURN_INSPECTION_STATE_CONFLICT",
      });
    }
  });
  it("blocks inconsistent or prematurely restocked receipt evidence", () => {
    const plan = deriveReturnCaseActionPlan(context({
      receipt: { ...receipt(), restocked: true },
    }));

    expect(plan.nextAction).toBeNull();
    expect(plan.actions[0]).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_RECEIPT_STATE_CONFLICT",
    });
  });

  it("blocks zero-receipt evidence when lifecycle says no physical return is required", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "not_required" },
    }));

    expect(plan.nextAction).toBeNull();
    expect(plan.actions[0]).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_RECEIPT_STATE_CONFLICT",
    });
  });

  it.each([
    ["scopeKind", "invalid_scope"],
    ["returnDestination", "warehouse"],
    ["approvalAuthority", "anyone"],
    ["labelProvider", "printer"],
    ["returnShippingPayer", "nobody"],
    ["inspectionRequirement", "sometimes"],
    ["inspectionOwner", "carrier"],
    ["customerRefundAuthority", "nobody"],
    ["vendorSettlementTrigger", "immediately"],
  ] as const)("rejects invalid enum-backed policy field %s", (field, value) => {
    expect(() => parseReturnPolicySnapshot({
      ...policy(),
      [field]: value,
    })).toThrowError(expect.objectContaining({ code: "RETURN_POLICY_SNAPSHOT_INVALID" }));
  });


  it.each(["none", "conditional"] as const)(
    "offers disposition when %s inspection is resolved without fabricated evidence",
    (inspectionRequirement) => {
      const plan = deriveReturnCaseActionPlan(context({
        lifecycle: {
          ...lifecycle(),
          logisticsStatus: "received",
          inspectionStatus: "not_required",
        },
        policy: { ...policy(), inspectionRequirement },
        receipt: receipt({ receivedQuantity: 2, status: "received" }),
        conditionalInspectionDecision: inspectionRequirement === "conditional" ? "waived" : null,
      }));

      expect(plan.nextAction).toBe("record_disposition");
      expect(plan.actions[1]).toMatchObject({
        state: "not_applicable",
        reasonCode: "RETURN_INSPECTION_NOT_REQUIRED",
      });
      expect(plan.actions[2]).toMatchObject({
        state: "not_applicable",
        reasonCode: "RETURN_INSPECTION_NOT_REQUIRED",
      });
      expect(plan.actions[3]).toMatchObject({ state: "available", reasonCode: null });
    },
  );

  it("does not treat external inspection ownership alone as resolved evidence", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received" },
      policy: { ...policy(), inspectionOwner: "vendor" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
    }));

    expect(plan.actions[3]).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_INSPECTION_OWNED_EXTERNALLY",
    });
  });

  it("keeps partial append-only disposition evidence available", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "approved" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: completedInspection("approved"),
      disposition: {
        recordCount: 1,
        lines: [{
          dispositionItemId: 100,
          dispositionId: 10,
          returnCaseItemId: 1,
          treatment: "hold_non_sellable",
          quantity: 1,
        }],
      },
    }));

    expect(plan.nextAction).toBe("record_disposition");
    expect(plan.actions[3]).toMatchObject({ state: "available", reasonCode: null });
    expect(plan.actions[3].description).toContain("does not restock inventory");
    expect(plan.dispositionSummary).toEqual({
      receivedUnits: 2,
      recordedUnits: 1,
      remainingUnits: 1,
      fullyRecorded: false,
      partiallyRecorded: true,
      items: [{
        returnCaseItemId: 1,
        receivedQuantity: 2,
        restockSellableQuantity: 0,
        holdNonSellableQuantity: 1,
        recordedQuantity: 1,
        remainingQuantity: 1,
      }],
    });
  });

  it("completes disposition only after every received unit has a treatment", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "rejected" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: completedInspection("rejected"),
      disposition: {
        recordCount: 2,
        lines: [
          {
            dispositionItemId: 100,
            dispositionId: 10,
            returnCaseItemId: 1,
            treatment: "restock_sellable",
            quantity: 1,
          },
          {
            dispositionItemId: 101,
            dispositionId: 11,
            returnCaseItemId: 1,
            treatment: "hold_non_sellable",
            quantity: 1,
          },
        ],
      },
    }));

    expect(plan.nextAction).toBe("apply_inventory_treatment");
    expect(plan.actions[3]).toMatchObject({ state: "completed", reasonCode: null });
    expect(plan.actions[4]).toMatchObject({ state: "available", reasonCode: null });
    expect(plan.dispositionSummary).toMatchObject({
      receivedUnits: 2,
      recordedUnits: 2,
      remainingUnits: 0,
      fullyRecorded: true,
      partiallyRecorded: false,
    });
  });

  it("keeps partially applied inventory treatment available with exact source evidence", () => {
    const disposition = completeDisposition();
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "approved" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: completedInspection("approved"),
      disposition,
      inventoryTreatment: {
        recordCount: 1,
        lines: [{
          dispositionItemId: 100,
          returnCaseItemId: 1,
          treatment: "restock_sellable",
          quantity: 1,
          warehouseLocationId: 17,
          inventoryTransactionId: 501,
          inventoryLotId: 601,
        }],
      },
    }));

    expect(plan.nextAction).toBe("apply_inventory_treatment");
    expect(plan.actions[4]).toMatchObject({ state: "available", reasonCode: null });
    expect(plan.inventoryTreatmentSummary).toEqual({
      dispositionUnits: 2,
      appliedUnits: 1,
      remainingUnits: 1,
      fullyApplied: false,
      partiallyApplied: true,
      items: [
        {
          dispositionItemId: 100,
          returnCaseItemId: 1,
          treatment: "restock_sellable",
          quantity: 1,
          warehouseLocationId: 17,
          inventoryTransactionId: 501,
          inventoryLotId: 601,
          applied: true,
        },
        {
          dispositionItemId: 101,
          returnCaseItemId: 1,
          treatment: "hold_non_sellable",
          quantity: 1,
          warehouseLocationId: null,
          inventoryTransactionId: null,
          inventoryLotId: null,
          applied: false,
        },
      ],
    });
  });

  it("preserves completed immutable treatment evidence after later case closure and WMS restock", () => {
    const disposition = completeDisposition();
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), caseStatus: "closed", logisticsStatus: "received", inspectionStatus: "approved" },
      receipt: { ...receipt({ receivedQuantity: 2, status: "received" }), restocked: true },
      inspection: completedInspection("approved"),
      disposition,
      inventoryTreatment: {
        recordCount: 2,
        lines: [
          {
            dispositionItemId: 100,
            returnCaseItemId: 1,
            treatment: "restock_sellable",
            quantity: 1,
            warehouseLocationId: 17,
            inventoryTransactionId: 501,
            inventoryLotId: 601,
          },
          {
            dispositionItemId: 101,
            returnCaseItemId: 1,
            treatment: "hold_non_sellable",
            quantity: 1,
            warehouseLocationId: null,
            inventoryTransactionId: null,
            inventoryLotId: null,
          },
        ],
      },
    }));

    expect(plan.nextAction).toBeNull();
    expect(plan.actions[3]).toMatchObject({ state: "completed", reasonCode: null });
    expect(plan.actions[4]).toMatchObject({ state: "completed", reasonCode: null });
    expect(plan.inventoryTreatmentSummary).toMatchObject({
      dispositionUnits: 2,
      appliedUnits: 2,
      remainingUnits: 0,
      fullyApplied: true,
      partiallyApplied: false,
    });
  });

  it("fails closed for unknown, mismatched, duplicate, or incomplete inventory treatment evidence", () => {
    const validSellable = {
      dispositionItemId: 100,
      returnCaseItemId: 1,
      treatment: "restock_sellable" as const,
      quantity: 1,
      warehouseLocationId: 17,
      inventoryTransactionId: 501,
      inventoryLotId: 601,
    };
    const invalidEvidence: NonNullable<ReturnCaseActionContext["inventoryTreatment"]>[] = [
      { recordCount: 1, lines: [{ ...validSellable, dispositionItemId: 999 }] },
      { recordCount: 1, lines: [{ ...validSellable, returnCaseItemId: 999 }] },
      { recordCount: 1, lines: [{ ...validSellable, quantity: 2 }] },
      { recordCount: 1, lines: [{ ...validSellable, treatment: "hold_non_sellable" }] },
      { recordCount: 1, lines: [{ ...validSellable, warehouseLocationId: null }] },
      { recordCount: 1, lines: [{ ...validSellable }, { ...validSellable }] },
      { recordCount: 2, lines: [{ ...validSellable }] },
      { recordCount: 1, lines: [{ ...validSellable, dispositionItemId: 101, treatment: "hold_non_sellable", inventoryTransactionId: 501, inventoryLotId: 601 }] },
    ];

    for (const inventoryTreatment of invalidEvidence) {
      const plan = deriveReturnCaseActionPlan(context({
        lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "approved" },
        receipt: receipt({ receivedQuantity: 2, status: "received" }),
        inspection: completedInspection("approved"),
        disposition: completeDisposition(),
        inventoryTreatment,
      }));
      expect(plan.nextAction).toBeNull();
      expect(plan.actions[4]).toMatchObject({
        state: "blocked",
        reasonCode: "RETURN_INVENTORY_TREATMENT_STATE_CONFLICT",
      });
      expect(plan.inventoryTreatmentSummary.items).toEqual([]);
    }
  });

  it("fails closed for malformed, unknown, or excessive disposition evidence", () => {
    const invalidEvidence: NonNullable<ReturnCaseActionContext["disposition"]>[] = [
      {
        recordCount: 1,
        lines: [{
          dispositionItemId: 100,
          dispositionId: 10,
          returnCaseItemId: 1,
          treatment: "restock_sellable",
          quantity: 3,
        }],
      },
      {
        recordCount: 1,
        lines: [{
          dispositionItemId: 100,
          dispositionId: 10,
          returnCaseItemId: 999,
          treatment: "hold_non_sellable",
          quantity: 1,
        }],
      },
      {
        recordCount: 1,
        lines: [{
          dispositionItemId: 100,
          dispositionId: 10,
          returnCaseItemId: 1,
          treatment: "destroy" as "restock_sellable",
          quantity: 1,
        }],
      },
      {
        recordCount: 2,
        lines: [{
          dispositionItemId: 100,
          dispositionId: 10,
          returnCaseItemId: 1,
          treatment: "restock_sellable",
          quantity: 1,
        }],
      },
      {
        recordCount: 1,
        lines: [
          {
            dispositionItemId: 100,
            dispositionId: 10,
            returnCaseItemId: 1,
            treatment: "restock_sellable",
            quantity: 1,
          },
          {
            dispositionItemId: 101,
            dispositionId: 10,
            returnCaseItemId: 1,
            treatment: "hold_non_sellable",
            quantity: 1,
          },
        ],
      },
    ];

    for (const disposition of invalidEvidence) {
      const plan = deriveReturnCaseActionPlan(context({
        lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "approved" },
        receipt: receipt({ receivedQuantity: 2, status: "received" }),
        inspection: completedInspection("approved"),
        disposition,
      }));
      expect(plan.nextAction).toBeNull();
      expect(plan.actions[3]).toMatchObject({
        state: "blocked",
        reasonCode: "RETURN_DISPOSITION_STATE_CONFLICT",
      });
    }
  });

  it("offers the Shopify customer refund only for an eligible retail return", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: {
        ...lifecycle(),
        logisticsStatus: "received",
        inspectionStatus: "approved",
      },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: completedInspection("approved"),
      disposition: completeDisposition(),
    }));

    expect(plan.actions.find((item) => item.kind === "issue_customer_refund")).toMatchObject({
      state: "available",
      reasonCode: null,
    });
    expect(plan.actions.find((item) => item.kind === "settle_vendor_account")).toMatchObject({
      state: "not_applicable",
      reasonCode: "RETURN_VENDOR_SETTLEMENT_NOT_APPLICABLE",
    });
  });

  it("offers a retail refund without inspection only when policy and lifecycle both say not required", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: {
        ...lifecycle(),
        logisticsStatus: "received",
        inspectionStatus: "not_required",
      },
      policy: { ...policy(), inspectionRequirement: "none" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: null,
      disposition: completeDisposition(),
    }));

    expect(plan.actions.find((item) => item.kind === "issue_customer_refund")).toMatchObject({
      state: "available",
      reasonCode: null,
    });
  });

  it("blocks financial actions when an approved lifecycle lacks terminal inspection evidence", () => {
    const retail = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "approved" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: null,
      disposition: completeDisposition(),
    }));
    expect(retail.actions.find((item) => item.kind === "issue_customer_refund")).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_INSPECTION_EVIDENCE_INVALID",
    });

    const dropship = deriveReturnCaseActionPlan(context({
      ...context(),
      businessContext: "dropship",
      channelProvider: null,
      vendorId: 22,
      lifecycle: { ...lifecycle(), inspectionStatus: "approved", customerRefundStatus: "not_required", vendorSettlementStatus: "pending" },
      policy: { ...policy(), customerRefundAuthority: "marketplace", vendorSettlementTrigger: "inspection_approved" },
      inspection: null,
      disposition: completeDisposition(),
    }));
    expect(dropship.actions.find((item) => item.kind === "settle_vendor_account")).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_INSPECTION_EVIDENCE_INVALID",
    });
  });

  it("marks the retail refund completed from canonical lifecycle evidence", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), customerRefundStatus: "completed" },
    }));

    expect(plan.actions.find((item) => item.kind === "issue_customer_refund")).toMatchObject({
      state: "completed",
      reasonCode: null,
    });
  });

  it("fails the retail refund closed for unsupported ownership or provider context", () => {
    const externalAuthority = deriveReturnCaseActionPlan(context({
      policy: { ...policy(), customerRefundAuthority: "marketplace" },
    }));
    expect(externalAuthority.actions.find((item) => item.kind === "issue_customer_refund")).toMatchObject({
      state: "not_applicable",
      reasonCode: "RETURN_CUSTOMER_REFUND_OWNED_EXTERNALLY",
    });

    const unsupportedProvider = deriveReturnCaseActionPlan(context({ channelProvider: "ebay" }));
    expect(unsupportedProvider.actions.find((item) => item.kind === "issue_customer_refund")).toMatchObject({
      state: "blocked",
      reasonCode: "RETURN_CUSTOMER_REFUND_PROVIDER_UNSUPPORTED",
    });
  });

  it("offers vendor wallet settlement only for an eligible dropship return", () => {
    const plan = deriveReturnCaseActionPlan(context({
      businessContext: "dropship",
      channelProvider: "ebay",
      vendorId: 22,
      lifecycle: {
        ...lifecycle(),
        logisticsStatus: "received",
        inspectionStatus: "approved",
        customerRefundStatus: "not_required",
        vendorSettlementStatus: "pending",
      },
      policy: {
        ...policy(),
        customerRefundAuthority: "marketplace",
        vendorSettlementTrigger: "inspection_approved",
      },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: completedInspection("approved"),
      disposition: completeDisposition(),
    }));

    expect(plan.actions.find((item) => item.kind === "issue_customer_refund")).toMatchObject({
      state: "not_applicable",
      reasonCode: "RETURN_CUSTOMER_REFUND_NOT_OWNED",
    });
    expect(plan.actions.find((item) => item.kind === "settle_vendor_account")).toMatchObject({
      state: "available",
      reasonCode: null,
    });
  });

  it("marks vendor settlement completed from canonical lifecycle evidence", () => {
    const plan = deriveReturnCaseActionPlan(context({
      businessContext: "dropship",
      vendorId: 22,
      lifecycle: {
        ...lifecycle(),
        customerRefundStatus: "not_required",
        vendorSettlementStatus: "completed",
      },
      policy: { ...policy(), vendorSettlementTrigger: "inspection_approved" },
    }));

    expect(plan.actions.find((item) => item.kind === "settle_vendor_account")).toMatchObject({
      state: "completed",
      reasonCode: null,
    });
  });

  it("fails vendor settlement closed when its trigger cannot be proven locally", () => {
    for (const trigger of ["customer_refunded", "carrier_claim_paid"] as const) {
      const plan = deriveReturnCaseActionPlan(context({
        businessContext: "dropship",
        vendorId: 22,
        lifecycle: {
          ...lifecycle(),
          customerRefundStatus: "not_required",
          vendorSettlementStatus: "pending",
        },
        policy: { ...policy(), vendorSettlementTrigger: trigger },
      }));
      expect(plan.actions.find((item) => item.kind === "settle_vendor_account")).toMatchObject({
        state: "blocked",
        reasonCode: trigger === "customer_refunded"
          ? "RETURN_VENDOR_TRIGGER_CUSTOMER_REFUND_UNPROVEN"
          : "RETURN_VENDOR_TRIGGER_CARRIER_CLAIM_UNPROVEN",
      });
    }
  });

  it("blocks both financial actions when persisted inventory-treatment evidence conflicts", () => {
    const plan = deriveReturnCaseActionPlan(context({
      lifecycle: { ...lifecycle(), logisticsStatus: "received", inspectionStatus: "approved" },
      receipt: receipt({ receivedQuantity: 2, status: "received" }),
      inspection: completedInspection("approved"),
      disposition: completeDisposition(),
      inventoryTreatment: {
        recordCount: 1,
        lines: [{
          dispositionItemId: 999,
          returnCaseItemId: 1,
          treatment: "restock_sellable",
          quantity: 1,
          warehouseLocationId: 17,
          inventoryTransactionId: 501,
          inventoryLotId: 601,
        }],
      },
    }));

    expect(plan.actions[5]).toMatchObject({ state: "blocked", reasonCode: "RETURN_INVENTORY_TREATMENT_STATE_CONFLICT" });
    expect(plan.actions[6]).toMatchObject({ state: "not_applicable" });
  });
});

function context(overrides: Partial<ReturnCaseActionContext> = {}): ReturnCaseActionContext {
  return {
    businessContext: "retail",
    channelProvider: "shopify",
    vendorId: null,
    lifecycle: lifecycle(),
    policy: policy(),
    receipt: receipt(),
    inspection: null,
    conditionalInspectionDecision: null,
    disposition: null,
    inventoryTreatment: null,
    ...overrides,
  };
}

function completeDisposition(): NonNullable<ReturnCaseActionContext["disposition"]> {
  return {
    recordCount: 2,
    lines: [
      {
        dispositionItemId: 100,
        dispositionId: 10,
        returnCaseItemId: 1,
        treatment: "restock_sellable",
        quantity: 1,
      },
      {
        dispositionItemId: 101,
        dispositionId: 11,
        returnCaseItemId: 1,
        treatment: "hold_non_sellable",
        quantity: 1,
      },
    ],
  };
}


function completedInspection(
  outcome: "approved" | "rejected",
): NonNullable<ReturnCaseActionContext["inspection"]> {
  return {
    inspectionId: 8,
    status: outcome,
    startedAt: new Date("2026-08-22T12:00:00.000Z"),
    startedBy: "user:7",
    completedAt: new Date("2026-08-22T12:15:00.000Z"),
    completedBy: "user:9",
  };
}
function lifecycle(): ReturnCaseActionContext["lifecycle"] {
  return {
    caseStatus: "open",
    approvalStatus: "approved",
    logisticsStatus: "awaiting_return",
    inspectionStatus: "pending",
    customerRefundStatus: "pending",
    vendorSettlementStatus: "not_applicable",
  };
}

function policy(): NonNullable<ReturnCaseActionContext["policy"]> {
  return {
    id: 6,
    name: "Shopify returns",
    version: 2,
    scopeKind: "channel_context",
    scopeKey: "context:retail:channel:36",
    returnWindowDays: 32,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "customer",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
  };
}

function receipt(input: {
  receivedQuantity?: number;
  status?: "expected" | "partially_received" | "received";
} = {}): NonNullable<ReturnCaseActionContext["receipt"]> {
  const receivedQuantity = input.receivedQuantity ?? 0;
  const status = input.status ?? "expected";
  return {
    wmsReturnId: 230,
    wmsStatus: status,
    receivedAt: receivedQuantity > 0 ? new Date("2026-08-22T12:00:00.000Z") : null,
    restocked: false,
    canonicalItemCount: 1,
    items: [{
      returnCaseItemId: 1,
      wmsReturnItemId: 301,
      caseExpectedQuantity: 2,
      wmsExpectedQuantity: 2,
      wmsReceivedQuantity: receivedQuantity,
      wmsStatus: status,
    }],
  };
}
