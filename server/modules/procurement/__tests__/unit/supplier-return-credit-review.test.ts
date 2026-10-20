import { describe, expect, it } from "vitest";
import { projectReturnCreditReview, validateReturnCreditAssignments } from "../../domain/supplier-return-credit-review";
import { supplierReturnCreditReviewInputSchema, supplierReturnCreditReviewCommandResultSchema } from "@shared/procurement/supplier-return-credit";
import { supplierCreditCreateInputSchema } from "@shared/procurement/supplier-credit";
import { resolveSupplierCreditReductions } from "../../domain/supplier-credit-source";
import { resolveShipmentSupplierCredits } from "../../domain/shipment-supplier-credits";
const link = { id: 5, creditId: 6, creditLineId: 7, sourceInvoiceId: 8, supplierReference: "CREDIT-1", status: "approved" as const,
    entitlementId: 1, quantity: 20, component: "unassigned" as const, amountCents: 220, attributionComponents: ["product" as const, "packaging" as const] };
const input = { entitlementId: 1, returnId: 2, returnLineId: 3, quantity: 20, intervals: [{ start: 0, quantity: 20 }],
    currentCosts: { productMills: 20000, packagingMills: 2000, landedMills: 4000, totalMills: 26000 },
    costEntryIds: [1, 2, 3], links: [link], history: [] as unknown[] };
const assignment = { creditLinkId: 5, productCents: 200, packagingCents: 20, landedCents: 0 };
function reviewed(disposition: "attribution_only" | "awaiting_supplier_note" | "supplier_declined" = "attribution_only") {
    const initial = projectReturnCreditReview(input);
    return { ...input, history: [{ id: 9, sourceFingerprint: initial.sourceFingerprint, expectedVersion: initial.review.version,
                disposition, assignments: [assignment], evidenceReference: "SUPPLIER-EMAIL-1", reason: "Reviewed original credit note components",
                recordedBy: "reviewer", recordedAt: "2026-10-20T12:00:00.000Z" }] };
}
describe("immutable supplier return credit difference review", () => {
    it("preserves actual money and leaves unassigned components explicit", () => {
        const copy = structuredClone(input), result = projectReturnCreditReview(input);
        expect(result.review.differences).toEqual({ productMills: 20000, packagingMills: 2000, landedMills: 4000, totalMills: 4000, unassignedCreditCents: 220 });
        expect(result.review.reviewCurrent).toBe(false);
        expect(input).toEqual(copy);
    });
    it.each(["attribution_only", "awaiting_supplier_note", "supplier_declined"] as const)("keeps the freight difference unresolved after %s evidence", disposition => {
        const result = projectReturnCreditReview(reviewed(disposition));
        expect(result.review.reviewCurrent).toBe(true);
        expect(result.review.differences).toEqual({ productMills: 0, packagingMills: 0, landedMills: 4000, totalMills: 4000, unassignedCreditCents: 0 });
        expect(result.review.version).not.toBe(result.review.latestReview!.expectedVersion);
        expect(result.review.creditLinks[0].amountCents).toBe(220);
    });
    it("invalidates the prior review when a late freight revision changes returned value", () => {
        const result = projectReturnCreditReview({ ...reviewed(), costEntryIds: [1, 2, 3, 4],
            currentCosts: { ...input.currentCosts, landedMills: 6000, totalMills: 28000 } });
        expect(result.review.reviewCurrent).toBe(false);
        expect(result.review.differences.totalMills).toBe(6000);
        expect(result.review.differences.unassignedCreditCents).toBe(220);
        expect(result.review.reviewHistory).toHaveLength(1);
    });
    it("retains a voided note and invalidates the old review without changing physical entitlement", () => {
        const result = projectReturnCreditReview({ ...reviewed(), links: [{ ...link, status: "voided" }] });
        expect(result.review.reviewCurrent).toBe(false);
        expect(result.review.quantity).toBe(20);
        expect(result.review.differences.totalMills).toBe(26000);
        expect(result.review.creditLinks[0].status).toBe("voided");
    });
    it("supports a monetary top-up on the same entitlement and requires a fresh combined review", () => {
        const topup = { ...link, id: 10, creditId: 11, creditLineId: 12, component: "landed" as const, amountCents: 40, attributionComponents: [] };
        const changed = { ...reviewed(), links: [link, topup] };
        const stale = projectReturnCreditReview(changed);
        expect(stale.review.reviewCurrent).toBe(false);
        const fresh = projectReturnCreditReview({ ...changed, history: [...changed.history, {
                    ...changed.history[0] as object, id: 13, sourceFingerprint: stale.sourceFingerprint, expectedVersion: stale.review.version,
                }] });
        expect(fresh.review.reviewCurrent).toBe(true);
        expect(fresh.review.differences).toEqual({ productMills: 0, packagingMills: 0, landedMills: 0, totalMills: 0, unassignedCreditCents: 0 });
        expect(fresh.review.quantity).toBe(20);
    });
    it.each([
        { ...assignment, productCents: 199 }, { ...assignment, landedCents: 1, productCents: 199 },
        { ...assignment, creditLinkId: 99 },
    ])("rejects unsupported or nonconserving attribution %j", value => {
        expect(() => validateReturnCreditAssignments([value], [link])).toThrow();
    });
    it("rejects attribution of a voided, explicitly assigned, or duplicate credit", () => {
        expect(() => validateReturnCreditAssignments([assignment], [{ ...link, status: "voided" }])).toThrow();
        expect(() => validateReturnCreditAssignments([assignment], [{ ...link, component: "product" }])).toThrow();
        expect(() => validateReturnCreditAssignments([assignment, assignment], [link])).toThrow();
    });
    it.each([0.5, -1, Number.MAX_SAFE_INTEGER + 1, NaN])("rejects dirty amount %s without throwing from safeParse", amount => {
        expect(supplierReturnCreditReviewInputSchema.safeParse({ expectedVersion: "a".repeat(64), reason: "Reviewed evidence", evidenceReference: "proof",
            disposition: "attribution_only", assignments: [{ ...assignment, productCents: amount }] }).success).toBe(false);
    });
    it("validates actor/target receipt identity and preserves immutable review fields", () => {
        const projection = projectReturnCreditReview(reviewed());
        const receipt = { command: "review_credit_difference", entitlementId: 1, actorId: "reviewer", idempotencyKey: "intent-1",
            request: { expectedVersion: projection.review.latestReview!.expectedVersion, reason: "Reviewed evidence", evidenceReference: "proof", disposition: "attribution_only", assignments: [assignment] },
            review: projection.review };
        expect(supplierReturnCreditReviewCommandResultSchema.safeParse(receipt).success).toBe(true);
        expect(supplierReturnCreditReviewCommandResultSchema.safeParse({ ...receipt, entitlementId: 99 }).success).toBe(false);
    });
    it("supports separate product and packaging amounts on one genuine returned-quantity credit note", () => {
        const disposition = { kind: "accepted_stock_return", supplierReturnLineId: 3, quantity: 20, evidenceReference: "COLLECTION-1" };
        expect(supplierCreditCreateInputSchema.safeParse({ sourceInvoiceId: 8, expectedSourceVersion: "a".repeat(64), supplierReference: "CREDIT-1",
            creditCalendarDate: "2026-10-20", reason: "Supplier accepted collection", lines: [
                { invoiceLineId: 9, amountCents: 200, disposition: { ...disposition, component: "product" } },
                { invoiceLineId: 9, amountCents: 20, disposition: { ...disposition, component: "packaging" } },
            ] }).success).toBe(true);
    });
    it("never includes accepted-return credit money or references in gross purchase/shipment cost sources", () => {
        const credit = { id: 1, supplier_credit_id: 2, invoice_line_id: 3, amount_cents: 200, status: "approved",
            disposition: { kind: "accepted_stock_return", supplierReturnLineId: 4, quantity: 2, evidenceReference: "collection", component: "product" }, source_evidence: {} };
        expect(resolveSupplierCreditReductions([], [credit])).toEqual({ productMills: BigInt(0), packagingMills: BigInt(0), basePieces: BigInt(0), issues: [], sources: [], returns: [] });
        expect(resolveShipmentSupplierCredits({ charges: [], allocations: [], invoices: [], credits: [credit] })).toMatchObject({ issues: [], sources: [] });
    });
});
