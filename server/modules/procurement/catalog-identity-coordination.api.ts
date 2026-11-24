/**
 * Public catalog SKU rename, product merge, and identity cleanup coordination contract.
 */
export {
  ProcurementSkuReferenceError,
  synchronizeProcurementSkuReferences,
  type ProcurementSkuReferenceRename,
  type ProcurementSkuReferenceRenameResult,
} from "./application/procurement-sku-reference.service";
export {
  correctProduct102PurchasingIdentity,
  recordProduct102PurchasingCleanupAudit,
} from "./infrastructure/product-102-identity-cleanup.repository";
export {
  mergePurchasingProductIdentity,
  readPurchasingMergeEvidence,
} from "./application/purchasing-product-merge";
