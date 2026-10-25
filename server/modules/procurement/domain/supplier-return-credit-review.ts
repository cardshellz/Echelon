import { supplierReturnCreditReviewSchema, supplierReturnCreditReviewEntrySchema, supplierReturnCreditAssignmentSchema, type SupplierReturnCreditReview } from "@shared/procurement/supplier-return-credit";
import type { SupplierReturnCostTotals } from "@shared/procurement/supplier-return";
import { costFingerprint, costInteger } from "../../inventory/infrastructure/cost-evidence-values";
export class SupplierReturnCreditReviewError extends Error {
    constructor(readonly code: string, message: string) { super(message); this.name = "SupplierReturnCreditReviewError"; }
}
type ReviewLink = SupplierReturnCreditReview["creditLinks"][number];
export function validateReturnCreditAssignments(raw: unknown, links: readonly ReviewLink[]) {
    const assignments = supplierReturnCreditAssignmentSchema.array().max(1000).parse(raw);
    if (new Set(assignments.map(row => row.creditLinkId)).size !== assignments.length) {
        throw new SupplierReturnCreditReviewError("RETURN_CREDIT_ASSIGNMENT_DUPLICATE", "Attribute each supplier credit link once.");
    }
    for (const assignment of assignments) {
        const link = links.find(row => row.id === assignment.creditLinkId && row.status === "approved");
        if (!link || link.component !== "unassigned") {
            throw new SupplierReturnCreditReviewError("RETURN_CREDIT_ASSIGNMENT_SOURCE", "Only an active unassigned supplier credit can receive a component attribution.");
        }
        // Unassigned notes originate from goods invoices. Freight still requires
        // its own approved invoice/charge link; this review cannot create one.
        if (assignment.landedCents !== 0 || assignment.productCents > 0 && !link.attributionComponents.includes("product")
            || assignment.packagingCents > 0 && !link.attributionComponents.includes("packaging") || BigInt(assignment.productCents) + BigInt(assignment.packagingCents)
            + BigInt(assignment.landedCents) !== BigInt(link.amountCents)) {
            throw new SupplierReturnCreditReviewError("RETURN_CREDIT_ASSIGNMENT_AMOUNT", "Product and packaging attribution must exactly equal the original goods credit amount.");
        }
    }
    return assignments;
}
export function projectReturnCreditReview(input: {
    entitlementId: number;
    returnId: number;
    returnLineId: number;
    quantity: number;
    intervals: readonly {
        start: number;
        quantity: number;
    }[];
    currentCosts: SupplierReturnCostTotals;
    costEntryIds: readonly number[];
    links: ReviewLink[];
    history: unknown[];
}) {
    const history = supplierReturnCreditReviewEntrySchema.array().max(1000).parse(input.history);
    const latestReview = history.at(-1) ?? null;
    const active = input.links.filter(link => link.status === "approved").sort((left, right) => left.id - right.id);
    const sourceEvidence = { contractVersion: 1, entitlementId: input.entitlementId, returnId: input.returnId,
        returnLineId: input.returnLineId, quantity: input.quantity, intervals: input.intervals,
        currentCosts: input.currentCosts, costEntryIds: [...input.costEntryIds], activeCredits: active };
    const sourceFingerprint = costFingerprint(sourceEvidence);
    const reviewCurrent = latestReview !== null && latestReview.sourceFingerprint === sourceFingerprint;
    const assignments = reviewCurrent ? validateReturnCreditAssignments(latestReview.assignments, active) : [];
    let product = BigInt(0), packaging = BigInt(0), landed = BigInt(0), unassigned = BigInt(0);
    for (const link of active) {
        const amount = BigInt(link.amountCents);
        if (link.component === "product")
            product += amount * BigInt(100);
        else if (link.component === "packaging")
            packaging += amount * BigInt(100);
        else if (link.component === "landed")
            landed += amount * BigInt(100);
        else {
            const attribution = assignments.find(row => row.creditLinkId === link.id);
            if (!attribution)
                unassigned += amount;
            else {
                product += BigInt(attribution.productCents) * BigInt(100);
                packaging += BigInt(attribution.packagingCents) * BigInt(100);
                landed += BigInt(attribution.landedCents) * BigInt(100);
            }
        }
    }
    const productMills = BigInt(input.currentCosts.productMills) - product;
    const packagingMills = BigInt(input.currentCosts.packagingMills) - packaging;
    const landedMills = BigInt(input.currentCosts.landedMills) - landed;
    const exact = (value: bigint, field: string) => costInteger(value.toString(), field, -Number.MAX_SAFE_INTEGER);
    const review = supplierReturnCreditReviewSchema.parse({ entitlementId: input.entitlementId, returnId: input.returnId,
        returnLineId: input.returnLineId, quantity: input.quantity,
        version: costFingerprint({ sourceFingerprint, latestReviewId: latestReview?.id ?? null }), currentCosts: input.currentCosts,
        creditLinks: input.links, latestReview, reviewHistory: history, reviewCurrent,
        differences: { productMills: exact(productMills, "return.productDifference"), packagingMills: exact(packagingMills, "return.packagingDifference"),
            landedMills: exact(landedMills, "return.landedDifference"),
            totalMills: exact(productMills + packagingMills + landedMills - unassigned * BigInt(100), "return.totalDifference"),
            unassignedCreditCents: costInteger(unassigned.toString(), "return.unassignedCredit") } });
    return { review, sourceFingerprint, sourceEvidence };
}
