import { describe, expect, it } from "vitest";
import { parseSupplierSaveResult, parseSupplierDispatchResult, parseSupplierPreparationResult, supplierDispatchReviewedVersion } from "../../supplier-dispatch";

describe("supplier dispatch response evidence", () => {
  const sent = { id: 17, status: "sent", physicalStatus: "sent", sentToVendorAt: "2026-10-18T12:00:00.000Z" };
  it("accepts the expected PO only with recorded sent state and timestamp", () => {
    expect(parseSupplierDispatchResult(sent, 17)).toBe("recorded");
  });
  it.each([{ ...sent, id: 18 }, { ...sent, physicalStatus: "draft" }, { ...sent, sentToVendorAt: null }, { ...sent, sentToVendorAt: "invalid" }, { success: true }, null])("rejects unsupported sent evidence %j", (body) => {
    expect(() => parseSupplierDispatchResult(body, 17)).toThrow(/could not be verified/);
  });
  it("distinguishes renewed approval from recorded dispatch", () => {
    expect(parseSupplierDispatchResult({ id: 17, status: "pending_approval", physicalStatus: "draft" }, 17)).toBe("approval_required");
    expect(() => parseSupplierDispatchResult({ id: 18, status: "pending_approval", physicalStatus: "draft" }, 17)).toThrow();
  });
  it("requires a valid displayed version and preserves its instant", () => {
    expect(supplierDispatchReviewedVersion("2026-10-18T08:00:00-04:00")).toBe("2026-10-18T12:00:00.000Z");
    for (const invalid of [undefined, null, "", "yesterday", 123]) expect(() => supplierDispatchReviewedVersion(invalid)).toThrow(/version is unavailable/);
  });
});

describe("supplier preparation evidence", () => {
  const approved = { id: 17, poNumber: "PO-17", status: "approved", physicalStatus: "draft" };
  it("accepts approved or pending preparation without any sent claim", () => {
    expect(parseSupplierPreparationResult(approved, 17).status).toBe("approved");
    expect(parseSupplierPreparationResult({ ...approved, status: "pending_approval" }).status).toBe("pending_approval");
  });
  it.each([{ ...approved, id: 99 }, { ...approved, status: "sent" }, { ...approved, physicalStatus: "sent" }, { success: true }, null])("rejects unverified preparation %j", (body) => {
    expect(() => parseSupplierPreparationResult(body, 17)).toThrow(/could not be verified/);
  });
});

describe("supplier creation and preparation evidence", () => {
  const draft = { id: 17, poNumber: "PO-17", status: "draft", physicalStatus: "draft" };
  const approved = { ...draft, status: "approved" };
  it("validates a saved draft without claiming preparation", () => {
    expect(parseSupplierSaveResult({ po: draft }, false)).toEqual({ po: draft, preparationError: null });
  });
  it.each(["approved", "pending_approval"])("validates prepared %s without dispatch", (status) => {
    expect(parseSupplierSaveResult({ po: { ...approved, status }, status, pending_approval: status === "pending_approval", dispatch_recorded: false }, true))
      .toEqual({ po: { ...approved, status }, preparationError: null });
  });
  it("preserves the verified saved PO when its preparation fails", () => {
    expect(parseSupplierSaveResult({ po: draft, status: "draft", dispatch_recorded: false, sendError: "Quote needs review" }, true))
      .toEqual({ po: draft, preparationError: "Quote needs review" });
  });
  it.each([
    null, { success: true }, { po: { ...approved, id: "17" }, dispatch_recorded: false },
    { po: approved }, { po: approved, dispatch_recorded: true },
    { po: draft, dispatch_recorded: false },
    { po: approved, status: "draft", dispatch_recorded: false },
    { po: approved, pending_approval: true, dispatch_recorded: false },
    { po: approved, sendError: {}, dispatch_recorded: false },
    { po: { ...approved, physicalStatus: "sent" }, dispatch_recorded: false },
  ])("rejects incomplete or contradictory preparation %j", (body) => {
    expect(() => parseSupplierSaveResult(body, true)).toThrow(/could not be verified/);
  });
  it("rejects a saved response from a different purchase", () => {
    expect(() => parseSupplierSaveResult({ po: draft }, false, 99)).toThrow();
    expect(parseSupplierSaveResult({ po: draft }, false, 17).po.id).toBe(17);
  });
  it("rejects preparation or errors unexpectedly returned for draft creation", () => {
    expect(() => parseSupplierSaveResult({ po: approved }, false)).toThrow();
    expect(() => parseSupplierSaveResult({ po: draft, sendError: "Unexpected preparation" }, false)).toThrow();
  });
});
