/**
 * Inventory Planning & Availability — Internal Reservation Authority API (`A-B5` / `CI-03`)
 *
 * Canonical contract surface for order-level reservation, demand reconciliation,
 * refund release, cycle-count reconciliation, and authority-aware claim routing.
 * Peer modules (`oms`, `channels`, `inventory`, `wms`) must import reservation
 * contracts from this boundary rather than reaching into `channels/reservation.service`
 * or `inventory-planning/infrastructure/*`.
 */

import type { ProductInventoryStrategy } from "@shared/catalog/inventory-strategy";
import type {
  CanonicalAvailabilityCycleCountReconciliationCommand,
  CanonicalAvailabilityCycleCountReconciliationResult,
  CanonicalAvailabilityReservationStatusProjection,
} from "@shared/types/inventory-availability-claims";
import type { VariantAtp } from "../inventory/atp.service";

export type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

export interface ChannelSync {
  queueSyncAfterInventoryChange(variantId: number): Promise<void>;
}

export interface AtpService {
  getAtpPerVariant(productId: number, dbOverride?: any): Promise<VariantAtp[]>;
  getProductInventoryStrategy(
    productId: number,
    dbOverride?: any,
  ): Promise<ProductInventoryStrategy>;
}

export interface RecipeBuildPromise {
  claimOrderItem(
    input: {
      productId: number;
      variantId: number;
      orderQty: number;
      orderId: number;
      orderItemId: number;
      actorId?: string;
    },
    tx: any,
  ): Promise<ReserveForOrderResult>;
  cancelOrderDemands(
    orderId: number,
    reason: string,
    actorId?: string,
    dbOverride?: any,
  ): Promise<{
    cancelledDemands: number;
    cancelledBuildOrders: number;
    failures: Array<{ buildOrderId: number; reason: string }>;
  }>;
}

export interface ReservationResult {
  orderId: number;
  /** Exact canonical claim identity when canonical authority owns this reservation. */
  canonicalClaimId?: string | null;
  /** Count of line items backed by physical finished-goods reservations. */
  reserved: number;
  /** Count of line items promised through auditable recipe build orders. */
  promised: number;
  /** Line items that could not be reserved or promised. */
  failed: Array<{ sku: string; orderItemId: number; reason: string }>;
  /** Total base units physically reserved across all items. */
  totalBaseUnits: number;
  /** Total base units represented by unfinished build promises. */
  totalPromisedBaseUnits: number;
}

export interface ReserveForOrderResult {
  reserved: number;
  promised: number;
  shortfall: number;
}

export interface ReleaseOrderItemReservationResult {
  orderId: number;
  orderItemId: number;
  productVariantId: number;
  requestedQuantity: number;
  previouslyReleasedQuantity: number;
  releasedQuantity: number;
  openReservationAfter: number;
  idempotentReplay: boolean;
}

export interface ReleaseOrderReservationOptions {
  /** Canonical lifecycle outcome. Legacy reservation counters use the same release mechanics. */
  disposition?: "release" | "cancel";
  /**
   * Prevents a delayed caller from releasing a newer canonical claim for the
   * same WMS order. An explicit null means the caller captured a canonical
   * no-claim outcome and requires that no active claim now exists. Omission
   * retains the generic order-scoped release behavior. Legacy authority
   * rejects this canonical-only fence.
   */
  expectedCanonicalClaimId?: string | null;
  /** Internal transaction propagation used by the authority-aware runtime adapter. */
  dbOverride?: any;
}

export interface ReleaseOrderReservationResult {
  released: number;
  failed: Array<{ sku: string; orderItemId: number; reason: string }>;
}

export interface ReconcileOrderDemandCommand {
  orderId: number;
  /** Durable upstream event identity used by the canonical replacement command. */
  sourceEventId: string;
  /** Whether this invocation changed persisted WMS demand. Retries still carry the same event identity. */
  demandChanged: boolean;
  reason: string;
  userId?: string;
  /** Internal transaction propagation used by the authority-aware runtime adapter. */
  dbOverride?: any;
}

export interface ReconcileOrderDemandResult {
  /** True when this event caused reservation/claim state to be reconciled. */
  reconciled: boolean;
  release: ReleaseOrderReservationResult;
  reservation: ReservationResult;
}

export interface RefundDemandReleaseTarget {
  orderItemId: number;
  quantity: number;
}

export interface ReconcileRefundOrderDemandCommand {
  /** Channel-derived cumulative demand requires canonical whole-order reconciliation. */
  requiredAuthority?: "canonical";
  orderId: number;
  /** Durable Shopify refund identity shared by every affected line. */
  sourceEventId: string;
  /** Event-attributed, unconsumed line demand to release under legacy authority. */
  releaseTargets: readonly RefundDemandReleaseTarget[];
  reason: string;
  userId?: string;
  /** Internal transaction propagation used by the authority-aware runtime adapter. */
  dbOverride?: any;
  /** Internal hook used to defer channel sync until the authority transaction commits. */
  deferUntilCommit?: (effect: () => Promise<void>) => void;
}

export interface ReconcileRefundOrderDemandResult {
  /** Target-variant units actually removed from reservation/claim ownership by this attempt. */
  releasedReservationQuantity: number;
}

export interface ReconcileCycleCountInventoryCommand
  extends CanonicalAvailabilityCycleCountReconciliationCommand {
  /** Internal transaction propagation used by the authority-aware runtime adapter. */
  dbOverride?: any;
  /** Internal hook used to defer channel sync until the authority transaction commits. */
  deferUntilCommit?: (effect: () => Promise<void>) => void;
}

export interface OrderReservationStatus {
  sku: string;
  orderItemId: number;
  reservedQty: number;
  promisedQty: number;
  demandStatus: string | null;
  isReserved: boolean;
  isPromised: boolean;
}

export type OrderReservationStatusResult =
  | OrderReservationStatus[]
  | CanonicalAvailabilityReservationStatusProjection;

export interface ReservationServiceContract {
  reserveForOrder(
    productId: number,
    variantId: number,
    orderQty: number,
    orderId: number,
    orderItemId: number,
    userId?: string,
    dbOverride?: any,
  ): Promise<ReserveForOrderResult>;
  reserveOrder(orderId: number, userId?: string, dbOverride?: any): Promise<ReservationResult>;
  releaseOrderReservation(
    orderId: number,
    reason: string,
    userId?: string,
    options?: ReleaseOrderReservationOptions,
  ): Promise<ReleaseOrderReservationResult>;
  releaseOrderItemReservation(params: {
    orderId: number;
    orderItemId: number;
    quantity: number;
    sourceEventId: string;
    reason: string;
    userId?: string;
    dbOverride?: any;
    /** Internal grouped-refund control; requires a caller-owned transaction. */
    deferChannelSync?: boolean;
  }): Promise<ReleaseOrderItemReservationResult>;
  reconcileOrderDemand(command: ReconcileOrderDemandCommand): Promise<ReconcileOrderDemandResult>;
  reconcileRefundOrderDemand(
    command: ReconcileRefundOrderDemandCommand,
  ): Promise<ReconcileRefundOrderDemandResult>;
  reconcileCycleCountInventory(
    command: ReconcileCycleCountInventoryCommand,
  ): Promise<CanonicalAvailabilityCycleCountReconciliationResult>;
  reallocateOrphaned(
    productVariantId: number,
    warehouseLocationId: number,
    userId?: string,
    orphanedQty?: number,
    dbOverride?: any,
    deferUntilCommit?: (effect: () => Promise<void>) => void,
  ): Promise<{ released: number; reallocated: number; failed: number }>;
  getOrderReservationStatus(orderId: number, dbOverride?: any): Promise<OrderReservationStatusResult>;
  autoReserveOnSync(
    shopifyOrderId: string,
    userId?: string,
    dbOverride?: any,
  ): Promise<ReservationResult | null>;
}
