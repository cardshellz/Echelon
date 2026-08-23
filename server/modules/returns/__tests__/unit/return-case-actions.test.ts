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

      expect(plan.nextAction).toBeNull();
      expect(plan.actions[1]).toMatchObject({ state: "completed", reasonCode: null });
      expect(plan.actions[2]).toMatchObject({ state: "completed", reasonCode: null });
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
    }));

    expect(plan.nextAction).toBeNull();
    expect(plan.actions[1]).toMatchObject({ state: "completed", reasonCode: null });
    expect(plan.actions[2]).toMatchObject({ state: "completed", reasonCode: null });
    expect(plan.inspectionSummary).not.toBe(inspection);
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
});

function context(overrides: Partial<ReturnCaseActionContext> = {}): ReturnCaseActionContext {
  return {
    lifecycle: lifecycle(),
    policy: policy(),
    receipt: receipt(),
    inspection: null,
    conditionalInspectionDecision: null,
    ...overrides,
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
