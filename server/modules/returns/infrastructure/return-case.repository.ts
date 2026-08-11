import { and, asc, count, desc, eq, ilike, inArray, or, sql, sum } from "drizzle-orm";
import {
  channels,
  dropshipStoreConnections,
  dropshipVendors,
  omsOrders,
  orders,
  returnCaseEvents,
  returnCaseItems,
  returnCases,
} from "@shared/schema";
import { db } from "../../../db";
import type {
  ReturnCaseAdminStore,
  ReturnCaseDetailRow,
  ReturnCaseEventRow,
  ReturnCaseItemRow,
  ReturnCaseListQuery,
  ReturnCaseListRow,
} from "../application/return-case-admin.service";

const itemSummary = db
  .select({
    returnCaseId: returnCaseItems.returnCaseId,
    itemCount: count(returnCaseItems.id).as("return_case_item_count"),
    unitCount: sum(returnCaseItems.quantity).as("return_case_unit_count"),
  })
  .from(returnCaseItems)
  .groupBy(returnCaseItems.returnCaseId)
  .as("return_case_item_summary");

export class PostgresReturnCaseAdminStore implements ReturnCaseAdminStore {
  async list(query: ReturnCaseListQuery): Promise<{ rows: ReturnCaseListRow[]; total: number }> {
    const where = buildWhere(query);
    const offset = (query.page - 1) * query.limit;
    const [rows, totalRows] = await Promise.all([
      selectCaseRows()
        .where(where)
        .orderBy(desc(returnCases.openedAt), desc(returnCases.id))
        .limit(query.limit)
        .offset(offset),
      db
        .select({ total: count(returnCases.id) })
        .from(returnCases)
        .innerJoin(channels, eq(channels.id, returnCases.channelId))
        .leftJoin(dropshipVendors, eq(dropshipVendors.id, returnCases.vendorId))
        .leftJoin(dropshipStoreConnections, eq(dropshipStoreConnections.id, returnCases.storeConnectionId))
        .innerJoin(omsOrders, eq(omsOrders.id, returnCases.omsOrderId))
        .innerJoin(orders, eq(orders.id, returnCases.wmsOrderId))
        .where(where),
    ]);
    return {
      rows: rows.map(mapListRow),
      total: readNonNegativeInteger(totalRows[0]?.total, "total"),
    };
  }

  async getById(id: number): Promise<ReturnCaseDetailRow | null> {
    const [caseRows, itemRows, eventRows] = await Promise.all([
      selectCaseRows().where(eq(returnCases.id, id)).limit(1),
      db
        .select()
        .from(returnCaseItems)
        .where(eq(returnCaseItems.returnCaseId, id))
        .orderBy(asc(returnCaseItems.id)),
      db
        .select()
        .from(returnCaseEvents)
        .where(eq(returnCaseEvents.returnCaseId, id))
        .orderBy(asc(returnCaseEvents.occurredAt), asc(returnCaseEvents.id)),
    ]);
    const caseRow = caseRows[0];
    if (!caseRow) return null;
    return {
      ...mapListRow(caseRow),
      policyId: caseRow.policyId,
      policyVersion: caseRow.policyVersion,
      policySnapshot: caseRow.policySnapshot,
      createdAt: caseRow.createdAt,
      updatedAt: caseRow.updatedAt,
      items: itemRows.map(mapItemRow),
      events: eventRows.map(mapEventRow),
    };
  }
}

function selectCaseRows() {
  return db
    .select({
      id: returnCases.id,
      caseNumber: returnCases.caseNumber,
      sourceProvider: returnCases.sourceProvider,
      sourceEventType: returnCases.sourceEventType,
      sourceEventId: returnCases.sourceEventId,
      businessContext: returnCases.businessContext,
      channelId: returnCases.channelId,
      channelName: channels.name,
      vendorId: returnCases.vendorId,
      vendorBusinessName: dropshipVendors.businessName,
      vendorEmail: dropshipVendors.email,
      vendorMemberId: dropshipVendors.memberId,
      storeConnectionId: returnCases.storeConnectionId,
      storeDisplayName: dropshipStoreConnections.externalDisplayName,
      storeDomain: dropshipStoreConnections.shopDomain,
      omsOrderId: returnCases.omsOrderId,
      omsOrderNumber: omsOrders.externalOrderNumber,
      wmsOrderId: returnCases.wmsOrderId,
      wmsOrderNumber: orders.orderNumber,
      wmsReturnId: returnCases.wmsReturnId,
      policyId: returnCases.policyId,
      policyVersion: returnCases.policyVersion,
      policySnapshot: returnCases.policySnapshot,
      caseStatus: returnCases.caseStatus,
      approvalStatus: returnCases.approvalStatus,
      logisticsStatus: returnCases.logisticsStatus,
      inspectionStatus: returnCases.inspectionStatus,
      customerRefundStatus: returnCases.customerRefundStatus,
      vendorSettlementStatus: returnCases.vendorSettlementStatus,
      openedAt: returnCases.openedAt,
      closedAt: returnCases.closedAt,
      createdAt: returnCases.createdAt,
      updatedAt: returnCases.updatedAt,
      itemCount: itemSummary.itemCount,
      unitCount: itemSummary.unitCount,
    })
    .from(returnCases)
    .innerJoin(channels, eq(channels.id, returnCases.channelId))
    .leftJoin(dropshipVendors, eq(dropshipVendors.id, returnCases.vendorId))
    .leftJoin(dropshipStoreConnections, eq(dropshipStoreConnections.id, returnCases.storeConnectionId))
    .innerJoin(omsOrders, eq(omsOrders.id, returnCases.omsOrderId))
    .innerJoin(orders, eq(orders.id, returnCases.wmsOrderId))
    .leftJoin(itemSummary, eq(itemSummary.returnCaseId, returnCases.id));
}

function buildWhere(query: ReturnCaseListQuery) {
  const conditions = [];
  if (query.caseStatus) conditions.push(eq(returnCases.caseStatus, query.caseStatus));
  if (query.sourceProvider) conditions.push(eq(returnCases.sourceProvider, query.sourceProvider));
  if (query.channelId) conditions.push(eq(returnCases.channelId, query.channelId));
  if (query.search) {
    const search = `%${query.search}%`;
    conditions.push(or(
      ilike(returnCases.caseNumber, search),
      ilike(returnCases.sourceEventId, search),
      ilike(omsOrders.externalOrderNumber, search),
      ilike(orders.orderNumber, search),
      ilike(dropshipVendors.businessName, search),
      ilike(dropshipVendors.email, search),
      ilike(dropshipStoreConnections.externalDisplayName, search),
      ilike(dropshipStoreConnections.shopDomain, search),
    ));
  }
  return conditions.length === 0 ? undefined : and(...conditions);
}

type SelectedCaseRow = Awaited<ReturnType<ReturnType<typeof selectCaseRows>["limit"]>>[number];

function mapListRow(row: SelectedCaseRow): ReturnCaseListRow {
  return {
    id: readPositiveSafeInteger(row.id, "return case id"),
    caseNumber: row.caseNumber,
    sourceProvider: row.sourceProvider,
    sourceEventType: row.sourceEventType,
    sourceEventId: row.sourceEventId,
    businessContext: row.businessContext,
    channelId: row.channelId,
    channelName: row.channelName,
    vendorId: row.vendorId,
    vendorName: row.vendorBusinessName ?? row.vendorEmail ?? row.vendorMemberId ?? null,
    storeConnectionId: row.storeConnectionId,
    storeName: row.storeDisplayName ?? row.storeDomain ?? null,
    omsOrderId: readPositiveSafeInteger(row.omsOrderId, "OMS order id"),
    omsOrderNumber: row.omsOrderNumber,
    wmsOrderId: row.wmsOrderId,
    wmsOrderNumber: row.wmsOrderNumber,
    wmsReturnId: readPositiveSafeInteger(row.wmsReturnId, "WMS return id"),
    caseStatus: row.caseStatus as ReturnCaseListRow["caseStatus"],
    approvalStatus: row.approvalStatus as ReturnCaseListRow["approvalStatus"],
    logisticsStatus: row.logisticsStatus as ReturnCaseListRow["logisticsStatus"],
    inspectionStatus: row.inspectionStatus as ReturnCaseListRow["inspectionStatus"],
    customerRefundStatus: row.customerRefundStatus as ReturnCaseListRow["customerRefundStatus"],
    vendorSettlementStatus: row.vendorSettlementStatus as ReturnCaseListRow["vendorSettlementStatus"],
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    itemCount: readNonNegativeInteger(row.itemCount ?? 0, "item count"),
    unitCount: readNonNegativeInteger(row.unitCount ?? 0, "unit count"),
  };
}

function mapItemRow(row: typeof returnCaseItems.$inferSelect): ReturnCaseItemRow {
  return {
    id: readPositiveSafeInteger(row.id, "return case item id"),
    wmsReturnItemId: readPositiveSafeInteger(row.wmsReturnItemId, "WMS return item id"),
    omsOrderLineId: readNullablePositiveSafeInteger(row.omsOrderLineId, "OMS order line id"),
    wmsOrderItemId: row.wmsOrderItemId,
    externalLineItemId: row.externalLineItemId,
    sku: row.sku,
    title: row.title,
    quantity: row.quantity,
    unitPaidPriceCents: readNonNegativeInteger(row.unitPaidPriceCents, "unit paid price cents"),
    sourceLineTotalCents: readNonNegativeInteger(row.sourceLineTotalCents, "source line total cents"),
    createdAt: row.createdAt,
  };
}

function mapEventRow(row: typeof returnCaseEvents.$inferSelect): ReturnCaseEventRow {
  return {
    id: readPositiveSafeInteger(row.id, "return case event id"),
    eventType: row.eventType,
    actor: row.actor,
    details: row.details,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

function readPositiveSafeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${field} returned by the database.`);
  }
  return parsed;
}

function readNullablePositiveSafeInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : readPositiveSafeInteger(value, field);
}

function readNonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} returned by the database.`);
  }
  return parsed;
}
