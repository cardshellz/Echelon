/**
 * Public catalog SKU rename, product merge, and identity cleanup coordination contract.
 */
export {
  ProcurementSkuReferenceError,
  synchronizeProcurementSkuReferences,
  type ProcurementSkuReferenceRename,
  type ProcurementSkuReferenceRenameResult,
} from "./procurement-sku-reference.service";
export {
  correctProduct102PurchasingIdentity,
  recordProduct102PurchasingCleanupAudit,
} from "./product-102-identity-cleanup.repository";
export {
  mergePurchasingProductIdentity,
  readPurchasingMergeEvidence,
} from "./purchasing-product-merge";
