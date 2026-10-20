import { describe, expect, it, vi } from "vitest";
vi.mock("../../supplier-credit.service", () => ({
  executeSupplierCreditCommand: vi.fn()
}));
vi.mock("../../../../platform/commands/command-results.repository", () => ({
  financialCommandRepository: {}
}));
vi.mock("../../supplier-credit.repository", () => ({
  SupplierCreditError: class SupplierCreditError extends Error {
    constructor(readonly code: string, message: string, readonly statusCode = 409) {
      super(message);
    }
  }
}));
vi.mock("../../supplier-credit-settlement.repository", () => ({
  SupplierCreditEvidenceError: class SupplierCreditEvidenceError extends Error {
    readonly statusCode = 409;
    readonly details = {
      code: "CREDIT_REVIEW"
    };
  }
}));
import { bindSupplierCreditCommand, classifySupplierCreditFailure, createSupplierCreditCommands, validateSupplierCreditReceipt } from "../../supplier-credit.commands";
import { CostEvidenceError } from "../../../inventory/infrastructure/cost-evidence-values";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import type { FinancialCommandDescriptor, FinancialCommandRepository } from "../../../../platform/commands/transactional-command.service";
import type { CreditTransaction } from "../../supplier-credit.repository";
import type { SupplierCreditCommandResult } from "@shared/procurement/supplier-credit";
const request = {
  sourceInvoiceId: 1,
  expectedSourceVersion: "a".repeat(64),
  supplierReference: "CREDIT-1",
  creditCalendarDate: "2026-10-19",
  reason: "Reviewed supplier credit",
  lines: [{
    invoiceLineId: 2,
    amountCents: 100,
    disposition: {
      kind: "price_reduction" as const,
      component: "product" as const
    }
  }]
};
const base = {
  actorType: "user" as const,
  actorId: "owner",
  method: "POST",
  routeTemplate: "/api/supplier-credits",
  resourceKey: "supplier-credit:new:document",
  idempotencyKey: "credit-command-123",
  commandName: "supplier_credit.create",
  contractVersion: 1
};
const descriptor: FinancialCommandDescriptor = {
  ...base,
  requestHash: hashHttpFinancialCommand({
    ...base,
    params: {},
    query: {},
    body: request
  })
};
const capability = {
  allowed: false,
  code: "REVIEW",
  reason: "Review required"
};
function receipt(): SupplierCreditCommandResult {
  return {
    command: "create",
    actorId: "owner",
    idempotencyKey: descriptor.idempotencyKey,
    creditId: 3,
    request,
    applicationIds: [],
    reversedApplicationId: null,
    credit: {
      id: 3,
      sourceInvoiceId: 1,
      sourceInvoiceNumber: "INV-1",
      vendorId: 5,
      vendorName: "Supplier",
      currency: "USD",
      supplierReference: "CREDIT-1",
      creditCalendarDate: "2026-10-19",
      reason: request.reason,
      status: "draft",
      version: "b".repeat(64),
      replacesCreditId: null,
      replacedByCreditId: null,
      totalAmountCents: 100,
      appliedAmountCents: 0,
      unappliedAmountCents: 0,
      balanceState: "draft",
      balanceIssues: [],
      costStatus: "pending",
      costIssues: [],
      createdBy: "owner",
      createdAt: "2026-10-19T00:00:00.000Z",
      approvedBy: null,
      approvedAt: null,
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
      lines: [{
        ...request.lines[0],
        id: 4,
        label: "Product",
        sourceEvidence: {},
        costState: "pending",
        costIssues: []
      }],
      applications: [],
      capabilities: {
        approve: capability,
        apply: capability,
        void: capability,
        replace: capability
      }
    }
  };
}
const result = (body: unknown) => ({
  body,
  httpStatus: 201,
  terminalState: "succeeded" as const
});
describe("supplier credit durable response identity", () => {
  it("accepts the exact recorded document response", () => expect(() => validateSupplierCreditReceipt(result(receipt()), "create", request, descriptor)).not.toThrow());
  it.each(["actorId", "idempotencyKey"] as const)("rejects another %s", field => {
    const body = receipt();
    body[field] = "different";
    expect(() => validateSupplierCreditReceipt(result(body), "create", request, descriptor)).toThrow();
  });
  it("rejects a changed normalized submitted request", () => {
    const body = receipt();
    body.request = {
      ...request,
      reason: "Different request"
    };
    expect(() => validateSupplierCreditReceipt(result(body), "create", request, descriptor)).toThrow();
  });
  it("rejects unrelated credit economics even if request echo matches", () => {
    const body = receipt();
    body.credit.lines[0].amountCents = 99;
    expect(() => validateSupplierCreditReceipt(result(body), "create", request, descriptor)).toThrow();
  });
  it("rejects a changed draft header total despite matching source lines", () => {
    const body = receipt();
    body.credit.totalAmountCents = 200;
    expect(() => validateSupplierCreditReceipt(result(body), "create", request, descriptor)).toThrow();
  });
  it("rejects an extra unknown application identity in an otherwise matching apply receipt", () => {
    const body = receipt();
    const apply = {
      expectedVersion: "b".repeat(64),
      reason: "Apply approved credit",
      allocations: [{
        vendorInvoiceId: 1,
        appliedAmountCents: 100
      }]
    };
    body.command = "apply";
    body.request = apply;
    body.applicationIds = [7, 99];
    body.credit.status = "approved";
    body.credit.balanceState = "fully_applied";
    body.credit.appliedAmountCents = 100;
    body.credit.unappliedAmountCents = 0;
    body.credit.applications = [{
      id: 7,
      vendorInvoiceId: 1,
      invoiceNumber: "INV-1",
      appliedAmountCents: 100,
      actorId: "owner",
      recordedAt: "2026-10-19T00:00:00.000Z",
      reason: apply.reason,
      reversal: null,
      canReverse: capability
    }];
    expect(() => validateSupplierCreditReceipt({
      body,
      httpStatus: 200,
      terminalState: "succeeded"
    }, "apply", apply, descriptor, 3)).toThrow();
  });
  it("rejects an unrelated replacement result", () => {
    const body = receipt();
    body.credit.replacesCreditId = 9;
    expect(() => validateSupplierCreditReceipt(result(body), "create", request, descriptor)).toThrow();
  });
  it("rejects extra application ids in create results", () => {
    const body = receipt();
    body.applicationIds = [7];
    expect(() => validateSupplierCreditReceipt(result(body), "create", request, descriptor)).toThrow();
  });
  it("rejects a success-shaped malformed terminal rejection", () => expect(() => validateSupplierCreditReceipt({
    terminalState: "rejected",
    httpStatus: 200,
    body: {
      details: {
        creditCommandOutcome: "rejected",
        command: "create",
        actorId: "owner",
        idempotencyKey: descriptor.idempotencyKey
      }
    }
  }, "create", request, descriptor)).toThrow());
  it("accepts only a matching durable 4xx rejection", () => expect(() => validateSupplierCreditReceipt({
    terminalState: "rejected",
    httpStatus: 409,
    body: {
      details: {
        creditCommandOutcome: "rejected",
        command: "create",
        actorId: "owner",
        idempotencyKey: descriptor.idempotencyKey
      }
    }
  }, "create", request, descriptor)).not.toThrow());
  it("classifies source domain review as an explicit rejection", () => expect(classifySupplierCreditFailure(new CostEvidenceError("CREDIT_SOURCE_CHANGED", "Source changed"))).toMatchObject({
    kind: "rejected",
    httpStatus: 409,
    errorCode: "CREDIT_SOURCE_CHANGED"
  }));
  it("keeps unexpected database and output errors retryable", () => expect(classifySupplierCreditFailure(new Error("connection interrupted"))).toMatchObject({
    kind: "retryable"
  }));
  it("binds actor and command into one shared key namespace", () => {
    const a = bindSupplierCreditCommand(descriptor, "create"),
      b = bindSupplierCreditCommand({
        ...descriptor,
        actorId: "other"
      }, "create"),
      c = bindSupplierCreditCommand(descriptor, "void");
    expect([a.actorId, a.routeTemplate, a.resourceKey]).toEqual([b.actorId, b.routeTemplate, b.resourceKey]);
    expect(a.requestHash).not.toBe(b.requestHash);
    expect(a.requestHash).not.toBe(c.requestHash);
  });
  it.each([{
    actorType: "service"
  }, {
    method: "PUT"
  }, {
    resourceKey: "supplier-credit:99:document"
  }, {
    routeTemplate: "/api/unrelated"
  }, {
    requestHash: "f".repeat(64)
  }])("refuses caller descriptor mismatch before ledger reservation %j", async patch => {
    const reserve = vi.fn();
    const repository = {
      reserve
    } as unknown as FinancialCommandRepository<CreditTransaction>;
    await expect(createSupplierCreditCommands(repository).execute("create", request, {
      ...descriptor,
      ...patch
    } as FinancialCommandDescriptor)).rejects.toThrow("identity is invalid");
    expect(reserve).not.toHaveBeenCalled();
  });
});


describe("supplier credit cost reconciliation receipts", () => {
  const review = { expectedVersion: "b".repeat(64), reason: "Recheck after the receipt was closed" };
  function reconcileReceipt(): SupplierCreditCommandResult {
    const body = receipt();
    body.command = "reconcile_costs";
    body.request = review;
    body.credit.status = "approved";
    body.credit.approvedBy = "owner";
    body.credit.approvedAt = "2026-10-19T00:00:00.000Z";
    body.credit.balanceState = "available";
    body.credit.unappliedAmountCents = body.credit.totalAmountCents;
    body.credit.costStatus = "review_required";
    body.credit.costIssues = [{ code: "RECEIPT_EVIDENCE_REQUIRED", message: "Receipt evidence still needs review." }];
    return body;
  }
  function validate(body: SupplierCreditCommandResult) {
    return validateSupplierCreditReceipt({ body, httpStatus: 200, terminalState: "succeeded" },
      "reconcile_costs", review, descriptor, 3);
  }
  it("accepts an exact successful evaluation that retains the version and unresolved cost review", () => {
    const body = reconcileReceipt();
    expect(body.credit.version).toBe(review.expectedVersion);
    expect(() => validate(body)).not.toThrow();
  });
  it("accepts current posted evidence without requiring a new financial version", () => {
    const body = reconcileReceipt();
    body.credit.costStatus = "posted";
    body.credit.costIssues = [];
    expect(() => validate(body)).not.toThrow();
  });
  it.each(["draft", "voided"] as const)("rejects a %s document receipt", status => {
    const body = reconcileReceipt();
    body.credit.status = status;
    expect(() => validate(body)).toThrow();
  });
  it("rejects unverified financial evidence even when costing was rechecked", () => {
    const body = reconcileReceipt();
    body.credit.balanceState = "review_required";
    body.credit.appliedAmountCents = null;
    body.credit.unappliedAmountCents = null;
    expect(() => validate(body)).toThrow();
  });
  it.each(["draft", "voided", "fully_applied"] as const)("rejects an inconsistent approved %s balance state", balanceState => {
    const body = reconcileReceipt();
    body.credit.balanceState = balanceState;
    expect(() => validate(body)).toThrow();
  });
  it("rejects missing balance amounts or reported balance issues", () => {
    const missing = reconcileReceipt();
    missing.credit.appliedAmountCents = null;
    expect(() => validate(missing)).toThrow();
    const inconsistent = reconcileReceipt();
    inconsistent.credit.balanceIssues = [{ code: "CREDIT_REVIEW", message: "Financial evidence requires review." }];
    expect(() => validate(inconsistent)).toThrow();
  });
  it.each(["actorId", "idempotencyKey"] as const)("rejects another %s", field => {
    const body = reconcileReceipt();
    body[field] = "unrelated";
    expect(() => validate(body)).toThrow();
  });
  it("rejects changed request, resource, application or reversal evidence", () => {
    const changed = reconcileReceipt();
    changed.request = { ...review, reason: "Unrelated request" };
    expect(() => validate(changed)).toThrow();
    const unrelated = reconcileReceipt();
    unrelated.creditId = 4;
    unrelated.credit.id = 4;
    expect(() => validate(unrelated)).toThrow();
    const allocation = reconcileReceipt();
    allocation.applicationIds = [7];
    expect(() => validate(allocation)).toThrow();
    const reversal = reconcileReceipt();
    reversal.reversedApplicationId = 7;
    expect(() => validate(reversal)).toThrow();
  });
});
