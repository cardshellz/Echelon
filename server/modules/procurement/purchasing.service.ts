/**
 * Purchasing service for Echelon WMS.
 *
 * Public facade and composition root for the PO lifecycle:
 * - PO number generation, CRUD, line management, totals
 * - State machine: draft → pending_approval → approved → sent → acknowledged
 *   → partially_received → received → closed (+ cancelled/void)
 * - Multi-level approval tier checking
 * - Revision tracking for post-send amendments
 * - Receipt-from-PO and receipt-from-shipment creation
 * - Vendor catalog, RFQ batch creation, inline PO entry, and preload queries
 */

import type { ProcurementSettingsSnapshot } from "@shared/procurement/procurement-settings";
import { poEvents as poEventsTable } from "@shared/schema";
import {
  readCommandAuthorityActor,
  readPurchaseApprovalActor,
} from "../identity";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import {
  readPoShipmentCostSummary,
  readPoShipmentCosts,
} from "./po-shipment-cost-summary.repository";
import { ProcurementSettingsError } from "./procurement-settings.policy";
import { readProcurementSettings } from "./procurement-settings.repository";
import { createPurchasingCatalog } from "./purchasing/purchasing-catalog";
import { createPurchasingCosting } from "./purchasing/purchasing-costing";
import { createPurchasingEntryCommands } from "./purchasing/purchasing-entry-commands";
import { createPurchasingEntryValidation } from "./purchasing/purchasing-entry-validation";
import { createPurchasingHeaderMutations } from "./purchasing/purchasing-header-mutations";
import { createPurchasingLifecycleActions } from "./purchasing/purchasing-lifecycle-actions";
import { createPurchasingLifecycleLocks } from "./purchasing/purchasing-lifecycle-locks";
import { createPurchasingReceiving } from "./purchasing/purchasing-receiving";
import { createPurchasingRfqAndPreload } from "./purchasing/purchasing-rfq-preload";
import {
  PurchasingError,
  type CreatePurchaseOrderWithLinesInput,
  type PurchaseOrderLineInput,
  type PurchasingBaseContext,
  type PurchasingServiceOptions,
  type Storage,
  type UpdateDraftPurchaseOrderWithLinesInput,
} from "./purchasing/purchasing.types";

export {
  PurchasingError,
  type CreatePurchaseOrderWithLinesInput,
  type PurchaseOrderLineInput,
  type UpdateDraftPurchaseOrderWithLinesInput,
};

export type PurchasingService = ReturnType<typeof createPurchasingService>;

export function createPurchasingService(
  db: any,
  storage: Storage,
  options: PurchasingServiceOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const readApprovalActor = options.readApprovalActor ?? readPurchaseApprovalActor;
  const readCommandActor = options.readCommandActor ?? readCommandAuthorityActor;
  const reconcileApprovedInvoiceCost = options.reconcileApprovedInvoiceCost;

  // Purchasing decisions read only the canonical global policy. Missing or invalid
  // configuration fails closed; all writes belong to the settings command owner.
  async function getProcurementSettings(): Promise<ProcurementSettingsSnapshot> {
    return getProcurementSettingsTx(db, false);
  }

  async function getProcurementSettingsTx(tx: any, lock = true): Promise<ProcurementSettingsSnapshot> {
    try {
      return (await readProcurementSettings(tx, lock ? "share" : undefined)).settings;
    } catch (error) {
      if (error instanceof ProcurementSettingsError) {
        throw new PurchasingError(error.message, error.statusCode, { code: error.code });
      }
      throw error;
    }
  }

  function resolveActor(userId: string | null | undefined): { actorType: "user" | "system"; actorId: string } {
    if (userId && userId.length > 0) {
      return { actorType: "user", actorId: userId };
    }
    return { actorType: "system", actorId: "system:auto" };
  }

  async function emitPoEvent(
    poId: number,
    eventType: string,
    userId: string | null | undefined,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const { actorType, actorId } = resolveActor(userId);
    await db.insert(poEventsTable).values({
      poId,
      eventType,
      actorType,
      actorId,
      payloadJson: payload ?? null,
    });
  }

  async function emitPoEventTx(
    tx: any,
    poId: number,
    eventType: string,
    userId: string | null | undefined,
    payload?: Record<string, unknown>,
    at?: Date,
  ): Promise<void> {
    const { actorType, actorId } = resolveActor(userId);
    await tx.insert(poEventsTable).values({
      poId,
      eventType,
      actorType,
      actorId,
      payloadJson: payload ?? null,
      ...(at ? { createdAt: at } : {}),
    });
  }

  const ctx: PurchasingBaseContext = {
    db,
    storage,
    now,
    readApprovalActor,
    readCommandActor,
    reconcileApprovedInvoiceCost,
    lockInventoryCostGraph,
    resolveActor,
    emitPoEvent,
    emitPoEventTx,
    getProcurementSettings,
    getProcurementSettingsTx,
  };

  const costing = createPurchasingCosting(ctx);
  const catalog = createPurchasingCatalog(ctx);
  const rfqAndPreload = createPurchasingRfqAndPreload(ctx, catalog);
  const lifecycleLocks = createPurchasingLifecycleLocks(ctx, costing);
  const headerMutations = createPurchasingHeaderMutations(ctx, {
    persistPurchaseOrderCatalogWritesTx: catalog.persistPurchaseOrderCatalogWritesTx,
    observeLifecycleState: lifecycleLocks.observeLifecycleState,
    lockLifecycleHeader: lifecycleLocks.lockLifecycleHeader,
  });
  const receiving = createPurchasingReceiving(ctx, costing);
  const lifecycleActions = createPurchasingLifecycleActions(ctx, lifecycleLocks, {
    persistCompletedVendorPurchaseEvidenceTx: catalog.persistCompletedVendorPurchaseEvidenceTx,
    createReceiptFromPO: receiving.createReceiptFromPO,
  });
  const entryValidation = createPurchasingEntryValidation(ctx, costing);
  const entryCommands = createPurchasingEntryCommands(ctx, entryValidation, {
    persistPurchaseOrderCatalogWritesTx: catalog.persistPurchaseOrderCatalogWritesTx,
    observeLifecycleState: lifecycleLocks.observeLifecycleState,
    sendWithLockedEconomics: lifecycleActions.sendWithLockedEconomics,
  });

  return {
    // PO CRUD
    createPO: headerMutations.createPO,
    updatePO: headerMutations.updatePO,
    updateDeliverySchedule: headerMutations.updateDeliverySchedule,
    deletePO: headerMutations.deletePO,
    getPurchaseOrders: (filters?: any) => storage.getPurchaseOrders(filters),
    getPurchaseOrdersCount: (filters?: any) => storage.getPurchaseOrdersCount(filters),
    getPurchaseOrderById: (id: number) => storage.getPurchaseOrderById(id),
    getPurchaseOrderByPoNumber: (poNumber: string) => storage.getPurchaseOrderByPoNumber(poNumber),
    getPoShipmentCostSummary: (id: number) => readPoShipmentCostSummary(db, id),
    getPoShipmentCosts: (id: number) => readPoShipmentCosts(db, id),

    // Lines
    addLine: headerMutations.hardenedAddLine,
    addLineCommand: headerMutations.hardenedAddLineCommand,
    updateIncotermsAndCharges: headerMutations.updateIncotermsAndCharges,
    addBulkLines: headerMutations.hardenedAddBulkLines,
    addBulkLinesCommand: headerMutations.hardenedAddBulkLinesCommand,
    updateLine: headerMutations.hardenedUpdateLine,
    updateLineCommand: headerMutations.hardenedUpdateLineCommand,
    deleteLine: headerMutations.hardenedCancelLine,
    cancelLineCommand: headerMutations.hardenedCancelLineCommand,
    getPurchaseOrderLines: (poId: number) => storage.getPurchaseOrderLines(poId),
    getPurchaseOrderLineById: (id: number) => storage.getPurchaseOrderLineById(id),

    // Status transitions
    submit: lifecycleActions.submit,
    returnToDraft: lifecycleActions.returnToDraft,
    approve: lifecycleActions.approve,
    approveCommand: lifecycleActions.approveCommand,
    send: lifecycleActions.send,
    sendToVendor: lifecycleActions.sendToVendor,
    acknowledge: lifecycleActions.acknowledge,
    cancel: lifecycleActions.cancel,
    close: lifecycleActions.close,
    closeShort: lifecycleActions.closeShort,
    executeLifecycleCommand: lifecycleActions.executeLifecycleCommand,

    // Recalculate
    recalculateTotals: costing.recalculateTotals,
    computePoTotalsFromLines: costing.computePoTotalsFromLines,
    computeAllocatedLineCosts: costing.computeAllocatedLineCosts,

    // Receiving integration
    createReceiptFromPO: receiving.createReceiptFromPO,
    createReceiptFromShipment: receiving.createReceiptFromShipment,
    getShipmentReceiptPackResolution: receiving.getShipmentReceiptPackResolution,
    getPurchaseOrderReceiveOptions: receiving.getPurchaseOrderReceiveOptions,
    getShipmentPoReceiveOptions: receiving.getShipmentPoReceiveOptions,
    onReceivingOrderClosed: receiving.onReceivingOrderClosed,
    onReceivingOrderClosedInTransaction: receiving.onReceivingOrderClosedInTransaction,
    afterReceivingOrderClosed: receiving.afterReceivingOrderClosed,

    // Dual-track lifecycle (migration 0565)
    transitionPhysical: lifecycleActions.transitionPhysical,
    transitionFinancial: lifecycleActions.transitionFinancial,
    recomputeFinancialAggregates: lifecycleActions.recomputeFinancialAggregates,
    findOpenPoLineByProduct: receiving.findOpenPoLineByProduct,

    // On-order query
    getOnOrderQty: rfqAndPreload.getOnOrderQty,

    // History / Audit
    getPoStatusHistory: (poId: number) => storage.getPoStatusHistory(poId),
    getPoRevisions: (poId: number) => storage.getPoRevisions(poId),
    getPoReceipts: (poId: number) => storage.getPoReceipts(poId),

    // Approval tiers
    getApprovalTiers: () => storage.getAllPoApprovalTiers(),
    getApprovalTierById: (id: number) => storage.getPoApprovalTierById(id),
    createApprovalTier: (data: any) => (storage as any).createPoApprovalTier(data),
    updateApprovalTier: (id: number, updates: any) => (storage as any).updatePoApprovalTier(id, updates),
    deleteApprovalTier: (id: number) => (storage as any).deletePoApprovalTier(id),

    // Vendor Products
    getVendorProducts: (filters?: any) => storage.getVendorProducts(filters),
    getVendorProductById: (id: number) => storage.getVendorProductById(id),
    getPreferredVendorProduct: (productId: number, variantId?: number) => storage.getPreferredVendorProduct(productId, variantId),
    createVendorProduct: catalog.createVendorProduct,
    updateVendorProduct: catalog.updateVendorProduct,
    deleteVendorProduct: catalog.deactivateVendorProduct,
    bulkUpsertVendorCatalog: catalog.bulkUpsertVendorCatalog,
    applyReviewedSupplierEvidenceImport: catalog.applyReviewedSupplierEvidenceImport,
    snapshotPurchaseRecommendations: rfqAndPreload.snapshotPurchaseRecommendations,
    createRfqBatch: rfqAndPreload.createRfqBatch,
    createRfqBatchInTransaction: rfqAndPreload.createRfqBatchInTransaction,
    assertRfqCreationAuthority: rfqAndPreload.assertRfqCreationAuthority,

    // Spec A: inline create, one-click send, duplicate, preload, settings.
    createPurchaseOrderWithLines: entryCommands.createPurchaseOrderWithLines,
    assertPurchaseEntryAuthority: entryCommands.assertPurchaseEntryAuthority,
    executePurchaseEntryInTransaction: entryCommands.executePurchaseEntryInTransaction,
    updateDraftPurchaseOrderWithLines: entryCommands.updateDraftPurchaseOrderWithLines,
    sendPurchaseOrder: entryCommands.sendPurchaseOrder,
    duplicatePurchaseOrder: entryCommands.duplicatePurchaseOrder,
    getNewPoPreload: rfqAndPreload.getNewPoPreload,
    getProcurementSettings,
    emitPoEvent,
  };
}
