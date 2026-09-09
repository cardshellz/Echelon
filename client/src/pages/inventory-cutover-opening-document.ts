import { z } from "zod";
import { openingAssessmentSchema, openingSourceSchema, openingVerificationSchema,
  requiredOpeningItems, saveOpeningRequestSchema } from "@shared/types/inventory-cutover-opening";

export type OpeningSource = z.infer<typeof openingSourceSchema>;
export type OpeningVerification = z.infer<typeof openingVerificationSchema>;
export type OpeningAssessment = z.infer<typeof openingAssessmentSchema>;
export const OPENING_DOCUMENT_LIMIT_BYTES = 10 * 1024 * 1024;
const worksheetSchema = z.object({ contractVersion: z.literal("inventory_cutover_opening_worksheet_v1"),
  recordedReference: z.unknown(), verification: z.unknown() }).strict();

/** Recorded values are references, not an attestation. Every independently
 * verified quantity starts blank, including explicit zero positions. */
export function createOpeningWorksheet(source: OpeningSource): string {
  return JSON.stringify({ contractVersion: "inventory_cutover_opening_worksheet_v1",
    recordedReference: { capturedAt: source.capturedAt, labels: source.labels,
      levels: source.evidence.levels, lots: source.evidence.lots,
      orders: source.evidence.orders, items: requiredOpeningItems(source.evidence), costs: source.evidence.costs },
    verification: { contractVersion: "inventory_cutover_opening_v1", expectedEvidenceHash: source.evidenceHash,
      expectedAuthorityRevision: source.authorityRevision, expectedConfigurationRunId: source.configurationRunId,
      verificationReference: "", verificationEvidenceHash: "", verifiedAt: "", historicalDisposition: "preserve_unresolved",
      levels: source.evidence.levels.map(level => ({ ...level, variantQty: "", reservedQty: "", pickedQty: "", packedQty: "" })),
      lots: source.evidence.lots.map(lot => ({ ...lot, onHandQty: "", reservedQty: "", pickedQty: "",
        unitCostMills: "", poUnitCostMills: "", packagingUnitCostMills: "", landedUnitCostMills: "" })),
      owners: requiredOpeningItems(source.evidence).map(item => ({ orderId: item.orderId, orderItemId: item.id,
        remainingQty: "", reservedQty: "", pickedQty: "", allocations: [] })),
    },
  // Keep the complete worksheet compact. Pretty-printing duplicated reference
  // and verification rows can exceed the import ceiling at ordinary bulk scope.
  });
}

export function parseOpeningDocument(text: string, source: OpeningSource): OpeningVerification {
  if (new TextEncoder().encode(text).byteLength > OPENING_DOCUMENT_LIMIT_BYTES) {
    throw new Error("The verification document exceeds 10MB. No partial document was imported.");
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("The verification document is not valid JSON."); }
  const worksheet = worksheetSchema.safeParse(raw);
  // Reference labels/recorded quantities in a worksheet are never accepted as
  // verification, identities or replacement source data.
  const parsed = openingVerificationSchema.safeParse(worksheet.success ? worksheet.data.verification : raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.slice(0, 8).map(issue => issue.path.join(".") || "document");
    throw new Error(`Verification is incomplete or invalid: ${fields.join(", ")}. Blank values are not zero; complete the independent evidence first.`);
  }
  assertOpeningSource(parsed.data, source);
  return parsed.data;
}

export function assertOpeningSource(verification: OpeningVerification, source: OpeningSource): void {
  if (source.runtimeAuthority !== "legacy") throw new Error("Opening verification is available only before inventory authority changes.");
  if (verification.expectedEvidenceHash !== source.evidenceHash
    || verification.expectedAuthorityRevision !== source.authorityRevision
    || verification.expectedConfigurationRunId !== source.configurationRunId) {
    throw new Error("This document belongs to different source evidence. Capture the current records and verify a new worksheet.");
  }
}

export function prepareOpeningSave(verification: OpeningVerification, source: OpeningSource,
  assessment: OpeningAssessment | null, reason: string, idempotencyKey: string) {
  assertOpeningSource(verification, source);
  if (!assessment?.ready || assessment.sourceEvidenceHash !== source.evidenceHash) {
    throw new Error("Preview this complete verification without blockers before saving it.");
  }
  const request = saveOpeningRequestSchema.parse({ verification, reason, idempotencyKey });
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > OPENING_DOCUMENT_LIMIT_BYTES) {
    throw new Error("The complete save request exceeds 10MB. No partial verification can be saved.");
  }
  return request;
}
