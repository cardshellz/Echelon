import type {
  OrderEditConnection,
  OrderEditOperation,
  OrderEditQuoteInput,
  OrderEditSettingsInput,
  OrderEditStatus,
} from "@shared/order-edits/order-edit.contract";
import type {
  OrderEditQuote,
  OrderEditRefundIntent,
  OrderEditSnapshot,
} from "./order-edit-provider";

export interface OrderEditOrderReference {
  omsOrderId: number;
  channelId: number;
  connectionId: number;
  externalOrderId: string;
  externalCustomerId: string | null;
  orderNumber: string;
  customerName: string;
  customerEmail: string | null;
  activeOperationId: string | null;
}
export interface OrderEditRecord {
  id: string;
  omsOrderId: number;
  connectionId: number;
  requestKey: string;
  requestHash: string;
  actorId: string;
  status: OrderEditStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  input: OrderEditQuoteInput;
  baseline: OrderEditSnapshot;
  quote: OrderEditQuote | null;
  paymentWindowMinutes: number;
  quoteDeadline: string;
  paymentDeadline: string | null;
  commitKey: string | null;
  commitStartedAt: string | null;
  refundIntent: OrderEditRefundIntent | null;
  refundStartedAt: string | null;
  lastSnapshot: OrderEditSnapshot | null;
  recoveryStartedAt: string | null;
  error: OrderEditOperation["error"];
}
export interface OrderEditReleaseProof {
  wmsOrderIds: number[];
  shipmentIds: number[];
  contentFingerprint: string;
  ownership?: "owned" | "none";
  allocationRequired?: boolean;
  fulfilledCancellation?: boolean;
}
export interface OrderEditStore {
  connections(): Promise<OrderEditConnection[]>;
  settings(connectionId: number): Promise<OrderEditConnection>;
  saveSettings(
    connectionId: number,
    input: OrderEditSettingsInput,
    actorId: string,
    now: Date,
  ): Promise<OrderEditConnection>;
  findOrders(
    connectionId: number,
    search: string,
  ): Promise<OrderEditOrderReference[]>;
  orderReference(
    connectionId: number,
    omsOrderId: number,
  ): Promise<OrderEditOrderReference>;
  withOrderLock<T>(omsOrderId: number, work: () => Promise<T>): Promise<T>;
  findByRequestKey(key: string): Promise<OrderEditRecord | null>;
  get(id: string): Promise<OrderEditRecord>;
  create(record: OrderEditRecord): Promise<void>;
  save(
    record: OrderEditRecord,
    previousVersion: number,
    actorId: string | null,
    action: string,
    releaseProof?: OrderEditReleaseProof,
  ): Promise<void>;
  pending(limit: number, now: Date): Promise<string[]>;
}
export interface OrderEditWarehouse {
  inspect(
    omsOrderId: number,
  ): Promise<{ editable: boolean; reasons: string[]; wmsOrderIds: number[] }>;
  acquire(omsOrderId: number, operationId: string): Promise<void>;
  assertHeld(omsOrderId: number, operationId: string): Promise<void>;
  reconcileAndRelease(
    omsOrderId: number,
    operationId: string,
    snapshot: OrderEditSnapshot,
  ): Promise<OrderEditReleaseProof>;
  releaseUnchanged(
    omsOrderId: number,
    operationId: string,
  ): Promise<OrderEditReleaseProof>;
  releaseFulfilledUnsubmitted(
    omsOrderId: number,
    operationId: string,
  ): Promise<OrderEditReleaseProof>;
}
