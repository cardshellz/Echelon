import type {
  ReturnApprovalStatus,
  ReturnCaseStatus,
  ReturnCustomerRefundStatus,
  ReturnInspectionStatus,
  ReturnLogisticsStatus,
  ReturnVendorSettlementStatus,
} from "@shared/schema";
import {
  deriveReturnCaseActionPlan,
  type ReturnCaseActionContext,
} from "../domain/return-case-actions";

export interface ReturnCaseListQuery {
  search: string | null;
  caseStatus: ReturnCaseStatus | null;
  sourceProvider: string | null;
  channelId: number | null;
  page: number;
  limit: number;
}
export interface ReturnCaseSummaryMetrics {
  total: number;
  open: number;
  awaitingInspection: number;
  closed: number;
}

export interface ReturnCaseListRow {
  recordOrigin: "canonical" | "legacy_dropship";
  recordKey: string;
  legacyRmaId: number | null;
  id: number;
  caseNumber: string;
  sourceProvider: string;
  sourceEventType: string;
  sourceEventId: string;
  businessContext: string;
  channelId: number | null;
  channelName: string | null;
  vendorId: number | null;
  vendorName: string | null;
  storeConnectionId: number | null;
  storeName: string | null;
  omsOrderId: number | null;
  omsOrderNumber: string | null;
  wmsOrderId: number | null;
  wmsOrderNumber: string | null;
  wmsReturnId: number | null;
  caseStatus: ReturnCaseStatus;
  approvalStatus: ReturnApprovalStatus;
  logisticsStatus: ReturnLogisticsStatus;
  inspectionStatus: ReturnInspectionStatus;
  customerRefundStatus: ReturnCustomerRefundStatus;
  vendorSettlementStatus: ReturnVendorSettlementStatus;
  openedAt: Date;
  closedAt: Date | null;
  itemCount: number;
  unitCount: number;
}

export type ReturnCaseReceiptStatus = "expected" | "partially_received" | "received";

export interface ReturnCaseItemRow {
  id: number;
  wmsReturnItemId: number;
  omsOrderLineId: number | null;
  wmsOrderItemId: number | null;
  externalLineItemId: string | null;
  sku: string | null;
  title: string | null;
  quantity: number;
  expectedQuantity: number;
  receivedQuantity: number;
  remainingQuantity: number;
  receiptStatus: ReturnCaseReceiptStatus;
  unitPaidPriceCents: number;
  sourceLineTotalCents: number;
  createdAt: Date;
}

export interface ReturnCaseEventRow {
  id: number;
  eventType: string;
  actor: string;
  details: unknown;
  occurredAt: Date;
  createdAt: Date;
}

export interface ReturnCaseDetailRow extends ReturnCaseListRow {
  policyId: number;
  policyVersion: number;
  policySnapshot: unknown;
  createdAt: Date;
  updatedAt: Date;
  items: ReturnCaseItemRow[];
  events: ReturnCaseEventRow[];
  actionContext: ReturnCaseActionContext;
}

export interface ReturnCaseAdminStore {
  list(query: ReturnCaseListQuery): Promise<{
    rows: ReturnCaseListRow[];
    summary: ReturnCaseSummaryMetrics;
  }>;
  getById(id: number): Promise<ReturnCaseDetailRow | null>;
}

export class ReturnCaseAdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReturnCaseAdminError";
  }
}

export class ReturnCaseAdminService {
  constructor(private readonly store: ReturnCaseAdminStore) {}

  async list(query: ReturnCaseListQuery) {
    const result = await this.store.list(query);
    const totalPages = result.summary.total === 0 ? 0 : Math.ceil(result.summary.total / query.limit);
    return {
      cases: result.rows.map(serializeListRow),
      summary: result.summary,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.summary.total,
        totalPages,
      },
    };
  }

  async getById(id: number) {
    const row = await this.store.getById(id);
    if (!row) {
      throw new ReturnCaseAdminError(
        "RETURN_CASE_NOT_FOUND",
        "Return case was not found.",
        404,
        { id },
      );
    }
    return {
      ...serializeListRow(row),
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      policySnapshot: row.policySnapshot,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      items: row.items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
      events: row.events.map((event) => ({
        ...event,
        occurredAt: event.occurredAt.toISOString(),
        createdAt: event.createdAt.toISOString(),
      })),
      actionPlan: deriveReturnCaseActionPlan(row.actionContext),
    };
  }
}

function serializeListRow(row: ReturnCaseListRow) {
  return {
    recordOrigin: row.recordOrigin,
    recordKey: row.recordKey,
    legacyRmaId: row.legacyRmaId,
    id: row.id,
    caseNumber: row.caseNumber,
    sourceProvider: row.sourceProvider,
    sourceEventType: row.sourceEventType,
    sourceEventId: row.sourceEventId,
    businessContext: row.businessContext,
    channelId: row.channelId,
    channelName: row.channelName,
    vendorId: row.vendorId,
    vendorName: row.vendorName,
    storeConnectionId: row.storeConnectionId,
    storeName: row.storeName,
    omsOrderId: row.omsOrderId,
    omsOrderNumber: row.omsOrderNumber,
    wmsOrderId: row.wmsOrderId,
    wmsOrderNumber: row.wmsOrderNumber,
    wmsReturnId: row.wmsReturnId,
    caseStatus: row.caseStatus,
    approvalStatus: row.approvalStatus,
    logisticsStatus: row.logisticsStatus,
    inspectionStatus: row.inspectionStatus,
    customerRefundStatus: row.customerRefundStatus,
    vendorSettlementStatus: row.vendorSettlementStatus,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    itemCount: row.itemCount,
    unitCount: row.unitCount,
  };
}
