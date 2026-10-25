import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierReturnCreditReviewInputSchema } from "@shared/procurement/supplier-return-credit";
import { costInteger, lockInventoryCostGraph, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { loadReturnCreditEvidence, projectReturnCreditEntitlement } from "./supplier-return-credit.repository";
import { SupplierReturnError } from "./supplier-return.errors";
import { SupplierReturnCreditReviewError, validateReturnCreditAssignments } from "./domain/supplier-return-credit-review";
async function readProjection(tx: CostEvidenceTransaction, entitlementId: number) {
    const row = (await tx.execute(sql `SELECT supplier_return_line_id FROM procurement.supplier_return_credit_entitlements WHERE id=${entitlementId}`)).rows[0];
    if (!row)
        throw new SupplierReturnError("RETURN_CREDIT_ENTITLEMENT_NOT_FOUND", "Returned quantity entitlement was not found.", 404);
    return projectReturnCreditEntitlement(await loadReturnCreditEvidence(tx, [costInteger(row.supplier_return_line_id, "returnLineId", 1)]), entitlementId);
}
export async function readSupplierReturnEntitlementReview(tx: CostEvidenceTransaction, id: number) {
    return (await readProjection(tx, costInteger(id, "entitlementId", 1))).review;
}
/** The outer command owner supplies current locked permission, actor-bound
 * durable identity and audit. This owner changes only append-only review evidence. */
export async function recordSupplierReturnCreditReview(tx: CostEvidenceTransaction, input: {
    entitlementId: number;
    raw: unknown;
    actorId: string;
    at: Date;
}) {
    const parsed = supplierReturnCreditReviewInputSchema.safeParse(input.raw);
    if (!parsed.success)
        throw new SupplierReturnError("RETURN_CREDIT_REVIEW_INVALID", "Review input requires an exact version, attribution and evidence.", 400);
    const data = parsed.data, entitlementId = costInteger(input.entitlementId, "entitlementId", 1);
    if (!input.actorId.trim() || !Number.isFinite(input.at.getTime()))
        throw new Error("Return credit review requires an actor and injected valid clock.");
    await lockInventoryCostGraph(tx);
    await tx.execute(sql `SELECT id FROM procurement.supplier_return_credit_entitlements WHERE id=${entitlementId} FOR UPDATE`);
    const current = await readProjection(tx, entitlementId);
    if (current.review.version !== data.expectedVersion)
        throw new SupplierReturnError("RETURN_CREDIT_REVIEW_STALE", "Returned value, credit notes or prior review changed. Reload and review the current evidence.");
    try {
        validateReturnCreditAssignments(data.assignments, current.review.creditLinks);
    }
    catch (error) {
        if (error instanceof SupplierReturnCreditReviewError)
            throw new SupplierReturnError(error.code, error.message);
        throw error;
    }
    await tx.execute(sql `INSERT INTO procurement.supplier_return_credit_reviews
    (entitlement_id,source_fingerprint,expected_version,disposition,assignments,source_evidence,evidence_reference,reason,recorded_by,recorded_at)
    VALUES (${entitlementId},${current.sourceFingerprint},${data.expectedVersion},${data.disposition},${canonicalJson(data.assignments)}::jsonb,
      ${canonicalJson(current.sourceEvidence)}::jsonb,${data.evidenceReference},${data.reason},${input.actorId},${input.at})`);
    return (await readProjection(tx, entitlementId)).review;
}
