import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CompleteReturnInspectionReview,
  ReturnCaseOperationsCard,
  createReceiptDraft,
  refreshReturnCaseAfterConflict,
  resolveInspectionCompletionContext,
  validateReceiptDraft,
  type ReceiptDraftLine,
} from "../ReturnCaseOperationsCard";
import {
  ReturnCaseAdminApiError,
  type ReturnCaseActionPlan,
  type ReturnCaseDetailItem,
} from "../return-case-admin-api";

describe("ReturnCaseOperationsCard", () => {
  it("renders only the actions supplied by the server action plan", () => {
    const markup = renderToStaticMarkup(createElement(ReturnCaseOperationsCard, {
      returnCaseId: 42,
      actionPlan: actionPlan({
        nextAction: "start_inspection",
        actions: [{
          kind: "start_inspection",
          label: "Inspect received return",
          description: "Server-authorized inspection action.",
          state: "available",
          reasonCode: null,
        }],
      }),
      items: [],
      onRefreshRequested: async () => undefined,
    }));

    expect(markup).toContain("Inspect received return");
    expect(markup).toContain("Server-authorized inspection action.");
    expect(markup).not.toContain("Record receipt");
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it("labels the completed begin step as Started and exposes completion for the exact active inspection", () => {
    const markup = renderToStaticMarkup(createElement(ReturnCaseOperationsCard, {
      returnCaseId: 42,
      actionPlan: actionPlan({
        nextAction: "complete_inspection",
        inspectionSummary: {
          inspectionId: 91,
          status: "in_progress",
          startedAt: "2026-08-22T14:30:00.000Z",
          startedBy: "user:7",
          completedAt: null,
          completedBy: null,
        },
        actions: [
          {
            kind: "start_inspection",
            label: "Begin inspection",
            description: "Inspection has started.",
            state: "completed",
            reasonCode: null,
          },
          {
            kind: "complete_inspection",
            label: "Complete inspection",
            description: "Record the final inspection outcome.",
            state: "available",
            reasonCode: null,
          },
        ],
      }),
      items: [item({ receivedQuantity: 1, remainingQuantity: 0, receiptStatus: "received" })],
      onRefreshRequested: async () => undefined,
    }));

    expect(markup).toContain("Begin inspection");
    expect(markup).toContain(">Started<");
    expect(markup).toContain("Complete inspection");
    expect(markup.match(/<button/g)).toHaveLength(1);
  });

  it("does not manufacture a completion control without an exact active inspection identity", () => {
    const markup = renderToStaticMarkup(createElement(ReturnCaseOperationsCard, {
      returnCaseId: 42,
      actionPlan: actionPlan({
        nextAction: "complete_inspection",
        inspectionSummary: null,
        actions: [{
          kind: "complete_inspection",
          label: "Complete inspection",
          description: "Server action lacks the required active inspection evidence.",
          state: "available",
          reasonCode: null,
        }],
      }),
      items: [item({ receivedQuantity: 1, remainingQuantity: 0, receiptStatus: "received" })],
      onRefreshRequested: async () => undefined,
    }));

    expect(markup).toContain("Complete inspection");
    expect(markup).not.toContain("<button");
  });

  it("renders an explicit outcome decision, read-only receipt lines, and the no-side-effects warning", () => {
    const markup = renderToStaticMarkup(createElement(CompleteReturnInspectionReview, {
      inspection: {
        inspectionId: 91,
        status: "in_progress",
        startedAt: "2026-08-22T14:30:00.000Z",
        startedBy: "user:7",
        completedAt: null,
        completedBy: null,
      },
      returnedItems: [item({ title: "Returned item", receivedQuantity: 1, remainingQuantity: 0, receiptStatus: "received" })],
      outcome: null,
      pending: false,
      notes: "",
      onOutcomeChange: () => undefined,
      onNotesChange: () => undefined,
    }));

    expect(markup).toContain("Inspection outcome");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Reject");
    expect(markup).toContain("Returned item");
    expect(markup).toContain("does not restock inventory");
    expect(markup).toContain("Completion notes (optional)");
    expect(markup).toContain('id="return-inspection-outcome-label"');
    expect(markup).toContain('aria-labelledby="return-inspection-outcome-label"');
  });

  it("derives completion only from the latest available action and exact active inspection", () => {
    const availablePlan = actionPlan({
      inspectionSummary: {
        inspectionId: 91,
        status: "in_progress",
        startedAt: "2026-08-22T14:30:00.000Z",
        startedBy: "user:7",
        completedAt: null,
        completedBy: null,
      },
      actions: [{
        kind: "complete_inspection",
        label: "Complete inspection",
        description: "Record the final inspection outcome.",
        state: "available",
        reasonCode: null,
      }],
    });
    const blockedPlan = actionPlan({
      ...availablePlan,
      actions: [{ ...availablePlan.actions[0], state: "blocked", reasonCode: "RETURN_CASE_NOT_OPEN" }],
    });

    expect(resolveInspectionCompletionContext(availablePlan)).toMatchObject({
      action: { state: "available" },
      inspection: { inspectionId: 91, status: "in_progress" },
    });
    expect(resolveInspectionCompletionContext(blockedPlan)).toBeNull();
  });

  it("refreshes exactly once after a 409 conflict and classifies refresh failure", async () => {
    const conflict = new ReturnCaseAdminApiError({
      code: "RETURN_CASE_INSPECTION_STATE_STALE",
      message: "Refresh the return case and try again.",
      status: 409,
    });
    const refresh = vi.fn(async () => undefined);

    await expect(refreshReturnCaseAfterConflict(conflict, refresh)).resolves.toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);

    const failedRefresh = vi.fn(async () => { throw new Error("refresh failed"); });
    await expect(refreshReturnCaseAfterConflict(conflict, failedRefresh)).resolves.toBe("failed");
    expect(failedRefresh).toHaveBeenCalledTimes(1);

    const notConflict = new ReturnCaseAdminApiError({
      code: "RETURN_CASE_CLIENT_INPUT_INVALID",
      message: "Invalid input.",
      status: 400,
    });
    await expect(refreshReturnCaseAfterConflict(notConflict, refresh)).resolves.toBe("not_requested");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows server-provided blocked actions without manufacturing an executable control", () => {
    const markup = renderToStaticMarkup(createElement(ReturnCaseOperationsCard, {
      returnCaseId: 42,
      actionPlan: actionPlan({
        nextAction: null,
        actions: [{
          kind: "record_receipt",
          label: "Record receipt",
          description: "Receipt is blocked by persisted state.",
          state: "blocked",
          reasonCode: "RETURN_CASE_NOT_APPROVED",
        }],
      }),
      items: [],
      onRefreshRequested: async () => undefined,
    }));

    expect(markup).toContain("Record receipt");
    expect(markup).toContain("RETURN_CASE_NOT_APPROVED");
    expect(markup).not.toContain("<button");
  });
});

describe("receipt draft", () => {
  it("starts each outstanding line blank and preserves its displayed receipt version", () => {
    const draft = createReceiptDraft([
      item({ id: 11, expectedQuantity: 4, receivedQuantity: 1, remainingQuantity: 3, receiptStatus: "partially_received" }),
      item({ id: 12, expectedQuantity: 2, receivedQuantity: 2, remainingQuantity: 0, receiptStatus: "received" }),
    ]);

    expect(draft).toEqual([expect.objectContaining({
      returnCaseItemId: 11,
      expectedQuantity: 4,
      receivedQuantity: 1,
      remainingQuantity: 3,
      quantityReceivedNow: "",
    })]);
  });

  it("supports partial per-line receipt and emits deterministic positive deltas only", () => {
    const result = validateReceiptDraft([
      draftLine({ returnCaseItemId: 12, expectedQuantity: 6, receivedQuantity: 2, remainingQuantity: 4, quantityReceivedNow: "2" }),
      draftLine({ returnCaseItemId: 11, expectedQuantity: 4, receivedQuantity: 1, remainingQuantity: 3, quantityReceivedNow: "0" }),
      draftLine({ returnCaseItemId: 10, expectedQuantity: 1, receivedQuantity: 0, remainingQuantity: 1, quantityReceivedNow: "1" }),
    ]);

    expect(result).toEqual({
      success: true,
      lines: [
        { returnCaseItemId: 10, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: 1 },
        { returnCaseItemId: 12, expectedCurrentReceivedQuantity: 2, quantityReceivedNow: 2 },
      ],
      fieldErrors: {},
      formError: null,
    });
  });

  it.each([
    {
      name: "quantity above remaining",
      draft: [draftLine({ remainingQuantity: 2, quantityReceivedNow: "3" })],
      error: "No more than 2 units remain.",
    },
    {
      name: "fractional quantity",
      draft: [draftLine({ quantityReceivedNow: "1.5" })],
      error: "Enter a whole number of zero or more.",
    },
    {
      name: "invalid displayed received quantity",
      draft: [draftLine({ receivedQuantity: -1 })],
      error: "Displayed received quantity is invalid. Refresh the return case.",
    },
    {
      name: "duplicate line",
      draft: [draftLine({}), draftLine({ quantityReceivedNow: "1" })],
      error: "This return item appears more than once.",
    },
  ])("rejects $name", ({ draft, error }) => {
    const result = validateReceiptDraft(draft);

    expect(result.success).toBe(false);
    expect(Object.values(result.fieldErrors)).toContain(error);
    expect(result.formError).toBe("Correct the receipt quantities before continuing.");
  });

  it("requires at least one positive received quantity", () => {
    const result = validateReceiptDraft([
      draftLine({ quantityReceivedNow: "0" }),
    ]);

    expect(result).toMatchObject({
      success: false,
      fieldErrors: {},
      formError: "Enter at least one unit received now.",
    });
  });
});

function actionPlan(overrides: Partial<ReturnCaseActionPlan>): ReturnCaseActionPlan {
  return {
    nextAction: null,
    receiptSummary: {
      expectedUnits: 0,
      receivedUnits: 0,
      remainingUnits: 0,
      fullyReceived: false,
      partiallyReceived: false,
    },
    inspectionSummary: null,
    actions: [],
    ...overrides,
  };
}

function item(overrides: Partial<ReturnCaseDetailItem>): ReturnCaseDetailItem {
  return {
    id: 11,
    wmsReturnItemId: 101,
    omsOrderLineId: 201,
    wmsOrderItemId: 301,
    externalLineItemId: "line-11",
    sku: "SKU-11",
    title: "Item 11",
    quantity: 1,
    expectedQuantity: 1,
    receivedQuantity: 0,
    remainingQuantity: 1,
    receiptStatus: "expected",
    unitPaidPriceCents: 495,
    sourceLineTotalCents: 495,
    createdAt: "2026-08-22T12:00:00.000Z",
    ...overrides,
  };
}

function draftLine(overrides: Partial<ReceiptDraftLine>): ReceiptDraftLine {
  return {
    returnCaseItemId: 11,
    title: "Item 11",
    sku: "SKU-11",
    expectedQuantity: 3,
    receivedQuantity: 0,
    remainingQuantity: 3,
    quantityReceivedNow: "1",
    ...overrides,
  };
}
