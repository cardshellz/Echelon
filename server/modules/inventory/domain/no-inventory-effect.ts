import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  costFingerprintSchema, costInventoryEffectProofSchema, costInventoryEffectSchema, type CostInventoryEffectProof,
  type CostIssue, type CostSourceRevision,
} from "@shared/procurement/cost-source-contracts";
import { costFingerprint } from "../infrastructure/cost-evidence-values";

const id = z.number().int().positive().safe();
const quantity = z.number().int().nonnegative().safe();
export const noInventoryEffectEvidenceSchema = z.object({
  purchaseOrderLineId: id,
  recognizedQuantity: z.boolean(),
  inventoryHistory: z.boolean(),
  costHistory: z.boolean(),
  outstandingCustody: z.boolean(),
  invoices: z.array(z.object({ documentId: id, lineId: id, version: costFingerprintSchema }).strict()),
  returns: z.array(z.object({
    supplierCreditLineId: id, supplierCreditId: id, creditVersion: costFingerprintSchema,
    returnDispositionId: id, observationId: id, receivingLineId: id,
    purchaseOrderLineId: id, quantity: id, unitsPerVariant: id,
    dispositionQuantity: id, returnedQuantity: quantity, observedQuantity: id,
    receivedQuantity: quantity, pendingQuantity: quantity,
    sourceMatches: z.boolean(), receiptClosed: z.boolean(),
  }).strict()),
}).strict();
export type NoInventoryEffectEvidence = z.infer<typeof noInventoryEffectEvidenceSchema>;
type Source = Pick<CostSourceRevision, "scope" | "inventoryEffect" | "sources" | "totalMills" | "basePieces" | "currency" | "evidence" | "issue" | "component">;

/** Pure proof of the narrowly supported case. Absence of a lot alone is never
 * authority: physical receipt, custody, financial history and source identities
 * must agree. Blockers retain review; this never writes a compensating loss. */
export function proveNoInventoryEffect(source: Source, raw: unknown): {
  proof: CostInventoryEffectProof | null; issues: CostIssue[];
} {
  const evidence = noInventoryEffectEvidenceSchema.safeParse(raw);
  const effect = costInventoryEffectSchema.safeParse(source.inventoryEffect);
  const issue = (code: string, message: string) => ({ proof: null, issues: [{ code, message }] });
  if (!effect.success || source.scope.kind !== "purchase_order_line" || source.component === "landed"
    || source.totalMills !== 0 || source.basePieces !== 0 || source.currency !== "USD" || source.evidence !== "confirmed" || source.issue
    || !evidence.success || evidence.data.purchaseOrderLineId !== source.scope.purchaseOrderLineId) {
    return issue("COST_NO_EFFECT_EVIDENCE_REQUIRED", "The full quarantine return needs complete current source, custody and inventory evidence before it can be completed without a cost effect.");
  }
  const live = evidence.data;
  if (live.recognizedQuantity || live.inventoryHistory || live.costHistory) {
    return issue("COST_NO_EFFECT_RECOGNIZED_HISTORY", "This purchase line has accepted quantity, inventory or prior cost history. Its full return needs a supported inventory and accounting disposition; no stock or sold costs were changed.");
  }
  if (live.outstandingCustody) {
    return issue("COST_NO_EFFECT_CUSTODY_PENDING", "Complete or cancel the outstanding receiving work and resolve every held quantity before completing this fully returned source.");
  }
  const invoiceRefs = source.sources.filter(row => row.kind === "vendor_invoice_line")
    .map(({ documentId, lineId, version }) => ({ documentId, lineId, version })).sort((a, b) => a.lineId - b.lineId);
  if (canonicalJson(invoiceRefs) !== canonicalJson([...live.invoices].sort((a, b) => a.lineId - b.lineId))) {
    return issue("COST_NO_EFFECT_SOURCE_CHANGED", "The approved invoice sources changed after the full-return source was recorded. Review the current invoice and credit evidence.");
  }
  const dispositionQuantities = new Map<number, bigint>();
  const expected = effect.data.returns;
  if (canonicalJson(expected.map(row => row.supplierCreditLineId).sort((a, b) => a - b))
    !== canonicalJson(live.returns.map(row => row.supplierCreditLineId).sort((a, b) => a - b))) {
    return issue("COST_NO_EFFECT_RETURN_CHANGED", "The current returned credit sources differ from the reviewed full-return scope. Review all return allocations before completing costs.");
  }
  for (const item of expected) {
    const matches = live.returns.filter(row => row.supplierCreditLineId === item.supplierCreditLineId);
    const row = matches[0];
    const reference = source.sources.find(ref => ref.kind === "supplier_credit_line" && ref.lineId === item.supplierCreditLineId);
    if (matches.length !== 1 || !row || !reference || reference.documentId !== row.supplierCreditId || reference.version !== row.creditVersion
      || !row.sourceMatches || row.purchaseOrderLineId !== source.scope.purchaseOrderLineId
      || row.returnDispositionId !== item.returnDispositionId || row.observationId !== item.observationId || row.receivingLineId !== item.receivingLineId
      || row.quantity !== item.quantity || row.unitsPerVariant !== item.unitsPerVariant
      || row.receivedQuantity !== 0 || row.pendingQuantity !== 0 || row.returnedQuantity !== row.observedQuantity) {
      return issue("COST_NO_EFFECT_RETURN_CHANGED", "The active credit no longer identifies the exact immutable, fully returned quarantine quantity. Review the return and credit source; no cost effect was recorded.");
    }
    if (!row.receiptClosed) return issue("COST_NO_EFFECT_RECEIPT_OPEN", "Close the receipt with zero accepted units before completing its full quarantine return cost disposition.");
    const total = (dispositionQuantities.get(row.returnDispositionId) ?? BigInt(0)) + BigInt(item.quantity);
    dispositionQuantities.set(row.returnDispositionId, total);
    if (total > BigInt(row.dispositionQuantity)) return issue("COST_NO_EFFECT_RETURN_EXCEEDED", "The credits claim more than the immutable returned quantity. Review the return allocations.");
  }
  const proof = costInventoryEffectProofSchema.parse({
    contractVersion: 1, purchaseOrderLineId: source.scope.purchaseOrderLineId,
    inventoryEffect: effect.data, evidenceFingerprint: costFingerprint(live),
  });
  return { proof, issues: [] };
}
