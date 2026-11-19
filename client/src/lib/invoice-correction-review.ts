import type { InvoiceQuantityApprovalRequest, InvoiceQuantityPreview, InvoiceQuantityPreviewRequest } from "@shared/procurement/invoice-quantity-correction";
import { canonicalJson } from "@shared/utils/canonical-json";

/** A response or saved retry must describe the exact reviewed intent. A missing
 * new preview version remains valid only for already-committed legacy receipts. */
export function invoiceCorrectionMatchesRequest(preview: InvoiceQuantityPreview,
  request: InvoiceQuantityPreviewRequest | InvoiceQuantityApprovalRequest): boolean {
  if (preview.sourceVersion !== request.sourceVersion || preview.afterQuantity !== request.quantityPieces
    || (request.unitCostMills !== undefined && preview.afterUnitCostMills !== request.unitCostMills)
    || (request.lineTotalCents !== undefined && preview.afterLineAmountCents !== request.lineTotalCents)) return false;
  if (request.costComponents !== undefined) {
    const expected = request.costComponents, actual = preview.afterCostComponents;
    if (!preview.costComponentsReviewed || !actual || expected.productMills !== actual.productMills
      || expected.packagingMills !== actual.packagingMills || expected.adjustmentMills !== actual.adjustmentMills
      || expected.packagingTreatment !== actual.packagingTreatment || canonicalJson(expected.adjustments ?? null) !== canonicalJson(actual.adjustments ?? null)) return false;
  } else if (preview.costComponentsReviewed) return false;
  if ("previewVersion" in request && request.previewVersion !== undefined
    && (preview.previewVersion !== request.previewVersion || preview.costing === undefined)) return false;
  return true;
}
