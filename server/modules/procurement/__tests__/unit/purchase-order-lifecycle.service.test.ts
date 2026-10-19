import { describe, expect, it } from "vitest";
import { financialWorkflowFixture } from "../../../../../test/fixtures/po-financial-workflow";
import {
  PoLifecycleError,
  buildPoAutoDraftActionPlan,
  buildPoLifecycleSummary,
  buildFinancialTransitionChange,
  buildPhysicalTransitionChange,
  getAllowedLegacyTransitions,
} from "../../purchase-order-lifecycle.service";

describe("purchase-order-lifecycle.service", () => {
  it("builds a physical transition patch with legacy status compatibility", () => {
    const now = new Date("2026-05-16T12:00:00.000Z");

    const change = buildPhysicalTransitionChange({
      po: {
        id: 1,
        status: "approved",
        physicalStatus: "draft",
        sentToVendorAt: null,
      },
      target: "sent",
      userId: "user-1",
      notes: "Sent to vendor",
      now,
      extraPatch: { orderDate: now },
    });

    expect(change.patch).toMatchObject({
      physicalStatus: "sent",
      status: "sent",
      sentToVendorAt: now,
      orderDate: now,
      updatedBy: "user-1",
    });
    expect(change.history).toMatchObject({
      fromStatus: "approved",
      toStatus: "sent",
      changedBy: "user-1",
      notes: "Sent to vendor",
    });
  });

  it("uses legacy status as physical fallback for pre-dual-track rows", () => {
    const now = new Date("2026-05-16T12:00:00.000Z");

    const change = buildPhysicalTransitionChange({
      po: {
        id: 2,
        status: "sent",
        physicalStatus: "draft",
        vendorAckDate: null,
      },
      target: "acknowledged",
      userId: "user-1",
      now,
      extraPatch: { vendorAckDate: now },
    });

    expect(change.patch).toMatchObject({
      physicalStatus: "acknowledged",
      status: "acknowledged",
      vendorAckDate: now,
      updatedBy: "user-1",
    });
    expect(change.history).toMatchObject({
      fromStatus: "sent",
      toStatus: "acknowledged",
      changedBy: "user-1",
      notes: "Physical status: sent -> acknowledged",
    });
  });

  it("rejects an invalid physical transition with allowed states in details", () => {
    expect(() =>
      buildPhysicalTransitionChange({
        po: { status: "approved", physicalStatus: "draft" },
        target: "received",
      }),
    ).toThrow(PoLifecycleError);

    try {
      buildPhysicalTransitionChange({
        po: { status: "approved", physicalStatus: "draft" },
        target: "received",
      });
    } catch (error: any) {
      expect(error.details).toEqual({
        current: "draft",
        target: "received",
        allowed: ["sent", "cancelled"],
      });
    }
  });

  it.each(["unbilled", "invoiced", "partially_paid", "paid", "disputed"] as const)("rejects a manual financial patch for %s", target => {
    expect(() => buildFinancialTransitionChange({ po: { id: 1, financialStatus: "unbilled" }, target }))
      .toThrow(expect.objectContaining({ statusCode: 409, details: { code: "PO_FINANCIAL_LEDGER_OWNED" } }));
  });

  it("exposes legacy transition allowances for current compatibility gates", () => {
    expect(getAllowedLegacyTransitions("approved")).toEqual(["sent", "cancelled"]);
    expect(getAllowedLegacyTransitions("received")).toEqual(["closed"]);
    expect(getAllowedLegacyTransitions("not_real")).toEqual([]);
  });

  it("derives next actions for a draft PO from the central lifecycle table", () => {
    const lifecycle = buildPoLifecycleSummary({
      id: 10,
      status: "draft",
      physicalStatus: "draft",
      financialStatus: "unbilled",
    });

    expect(lifecycle.physicalStatus).toBe("draft");
    expect(lifecycle.allowedPhysicalTransitions).toEqual(["sent", "cancelled"]);
    expect(lifecycle.nextActions.map((action) => action.id)).toEqual(
      expect.arrayContaining(["submit", "send_to_vendor", "cancel"]),
    );
    expect(lifecycle.nextActions.find((action) => action.id === "send_to_vendor")).toMatchObject({
      endpoint: "/api/purchase-orders/10/send-to-vendor",
      requiredPermission: { resource: "purchasing", action: "create" },
    });
  });

  it("uses legacy status fallback when deriving actions for older rows", () => {
    const lifecycle = buildPoLifecycleSummary({
      id: 11,
      status: "sent",
      physicalStatus: "draft",
      financialStatus: "unbilled",
    });

    expect(lifecycle.physicalStatus).toBe("sent");
    expect(lifecycle.allowedPhysicalTransitions).toEqual(["acknowledged", "cancelled"]);
    expect(lifecycle.nextActions.map((action) => action.id)).toEqual(
      expect.arrayContaining(["acknowledge", "create_receipt", "cancel"]),
    );
  });

  it("derives physical movement actions from allowed physical transitions", () => {
    const acknowledged = buildPoLifecycleSummary({
      id: 12,
      status: "acknowledged",
      physicalStatus: "acknowledged",
      financialStatus: "unbilled",
    });
    expect(acknowledged.nextActions.map((action) => action.id)).toEqual(
      expect.arrayContaining(["mark_shipped", "create_receipt", "cancel"]),
    );

    const shipped = buildPoLifecycleSummary({
      id: 13,
      status: "acknowledged",
      physicalStatus: "shipped",
      financialStatus: "unbilled",
    });
    expect(shipped.nextActions.map((action) => action.id)).toEqual(
      expect.arrayContaining(["mark_in_transit", "mark_arrived", "create_receipt", "cancel"]),
    );
  });

  it("keeps close and AP movement distinct in the derived lifecycle summary", () => {
    const lifecycle = buildPoLifecycleSummary({
      id: 14,
      status: "received",
      physicalStatus: "received",
      financialStatus: "unbilled",
    });

    expect(lifecycle.allowedLegacyTransitions).toEqual(["closed"]);
    expect(lifecycle.allowedPhysicalTransitions).toEqual([]);
    expect(lifecycle.allowedFinancialTransitions).toEqual([]);
    expect(lifecycle.isTerminal).toBe(false);
    expect(lifecycle.nextActions.map((action) => action.id)).toContain("close");
  });

  it("builds read-only next-action guidance for auto-drafted POs", () => {
    const plan = buildPoAutoDraftActionPlan(
      {
        id: 15,
        source: "auto_draft",
        status: "draft",
        physicalStatus: "draft",
        financialStatus: "unbilled",
      },
      { lineCount: 2, openExceptionCount: 0 },
    );

    expect(plan).toMatchObject({
      kind: "auto_draft_po_next_action",
      primaryAction: {
        id: "open_lines",
        label: "Review drafted quantities",
        severity: "info",
        tab: "lines",
      },
      context: {
        lineCount: 2,
        openExceptionCount: 0,
        availableLifecycleActionIds: expect.arrayContaining(["submit", "send_to_vendor"]),
      },
    });
    expect(plan?.checklist.map((step) => [step.id, step.status])).toEqual([
      ["review_lines", "current"],
      ["send_supplier", "current"],
      ["receive_inventory", "pending"],
      ["ap_closeout", "pending"],
    ]);
  });

  it("prioritizes exceptions over normal auto-draft advancement guidance", () => {
    const plan = buildPoAutoDraftActionPlan(
      {
        id: 16,
        source: "auto_draft",
        status: "approved",
        physicalStatus: "draft",
        financialStatus: "unbilled",
      },
      { lineCount: 1, openExceptionCount: 2 },
    );

    expect(plan?.primaryAction).toMatchObject({
      id: "open_exceptions",
      severity: "critical",
      tab: "exceptions",
    });
    expect(plan?.checklist[0]).toMatchObject({
      id: "exceptions",
      status: "blocked",
    });
  });

  it("moves auto-drafted received POs into AP closeout guidance", () => {
    const plan = buildPoAutoDraftActionPlan(
      {
        id: 17,
        source: "auto_draft",
        status: "received",
        physicalStatus: "received",
        financialStatus: "unbilled",
      },
      { lineCount: 3, openExceptionCount: 0, financialWorkflow: financialWorkflowFixture(17, "unbilled") },
    );

    expect(plan?.primaryAction).toMatchObject({
      id: "create_invoice",
      label: "Create vendor invoice",
      tab: "invoices",
    });
    expect(plan?.checklist.map((step) => [step.id, step.status])).toContainEqual([
      "ap_closeout",
      "current",
    ]);
  });

  it("does not add auto-draft guidance to manually created POs", () => {
    expect(
      buildPoAutoDraftActionPlan({
        id: 18,
        source: "manual",
        status: "draft",
        physicalStatus: "draft",
        financialStatus: "unbilled",
      }),
    ).toBeNull();
  });

  const closedPo = { id: 19, source: "auto_draft", status: "closed", physicalStatus: "received", financialStatus: "paid" };

  it.each([
    ["review_required", "review_financial_evidence"],
    ["unbilled", "create_invoice"],
    ["awaiting_approval", "review_invoice_approval"],
    ["payment_due", "record_payment"],
    ["settled", "done"],
  ] as const)("uses current %s evidence instead of a cached paid status", (state, actionId) => {
    const plan = buildPoAutoDraftActionPlan(closedPo, { lineCount: 1, financialWorkflow: financialWorkflowFixture(19, state) });
    expect(plan?.primaryAction.id).toBe(actionId);
    expect(plan?.context.financialStatus).toBe("paid");
    expect(plan?.context.financialWorkflowState).toBe(state);
    expect(plan?.checklist.find(step => step.id === "ap_closeout")?.status).toBe(state === "settled" ? "done" : "current");
  });

  it.each([
    undefined,
    null,
    financialWorkflowFixture(20, "settled"),
    { ...financialWorkflowFixture(19, "settled"), evidence: financialWorkflowFixture(19, "review_required").evidence },
  ])("requires review when financial workflow evidence is missing, mismatched or invalid (%#)", (financialWorkflow) => {
    const plan = buildPoAutoDraftActionPlan(closedPo, { lineCount: 1, financialWorkflow });
    expect(plan?.primaryAction.id).toBe("review_financial_evidence");
    expect(plan?.checklist.find(step => step.id === "ap_closeout")?.status).toBe("current");
  });

  it("keeps physical close authority separate while recommending financial review first", () => {
    const po = { ...closedPo, status: "received" };
    expect(buildPoLifecycleSummary(po).nextActions.map(action => action.id)).toContain("close");
    expect(buildPoAutoDraftActionPlan(po, { lineCount: 1 })?.primaryAction.id).toBe("review_financial_evidence");
    expect(buildPoAutoDraftActionPlan(po, { lineCount: 1, financialWorkflow: financialWorkflowFixture(19, "settled") })?.primaryAction.id).toBe("close");
  });

  it("preserves receiving and exception priorities even when finance requires review", () => {
    const po = { ...closedPo, status: "acknowledged", physicalStatus: "arrived" };
    const context = { lineCount: 1, financialWorkflow: financialWorkflowFixture(19, "review_required") };
    expect(buildPoAutoDraftActionPlan(po, context)?.primaryAction.id).toBe("create_receipt");
    expect(buildPoAutoDraftActionPlan(po, { ...context, openExceptionCount: 1 })?.primaryAction.id).toBe("open_exceptions");
  });

  it.each([
    ["review_required", "review_financial_evidence"],
    ["awaiting_approval", "review_invoice_approval"],
    ["payment_due", "record_payment"],
    ["unbilled", "cancelled"],
    ["settled", "cancelled"],
  ] as const)("keeps cancellation physical while routing %s finance to %s", (state, actionId) => {
    const po = { ...closedPo, status: "cancelled", physicalStatus: "cancelled" };
    const plan = buildPoAutoDraftActionPlan(po, { lineCount: 0, financialWorkflow: financialWorkflowFixture(19, state) });
    expect(plan?.primaryAction.id).toBe(actionId);
    expect(plan?.context.physicalStatus).toBe("cancelled");
    expect(plan?.checklist.find(step => step.id === "receive_inventory")?.status).toBe("blocked");
    expect(plan?.checklist.find(step => step.id === "ap_closeout")?.status).toBe(state === "settled" ? "done" : state === "unbilled" ? "blocked" : "current");
  });

  it("requires review for cancelled POs with unavailable financial evidence", () => {
    const po = { ...closedPo, status: "cancelled", physicalStatus: "cancelled" };
    expect(buildPoAutoDraftActionPlan(po, { lineCount: 0 })?.primaryAction.id).toBe("review_financial_evidence");
    expect(buildPoAutoDraftActionPlan(po, { lineCount: 0, openExceptionCount: 1 })?.primaryAction.id).toBe("open_exceptions");
  });
});
