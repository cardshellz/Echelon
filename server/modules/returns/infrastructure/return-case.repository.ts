import { and, asc, count, eq, sql, sum } from "drizzle-orm";
import {
  channels,
  dropshipStoreConnections,
  dropshipVendors,
  omsOrders,
  orders,
  returnCaseEvents,
  returnCaseInspections,
  returnCaseItems,
  returnCases,
  returnItems,
  returns as wmsReturns,
} from "@shared/schema";
import { db, pool } from "../../../db";
import type {
  ReturnCaseAdminStore,
  ReturnCaseDetailRow,
  ReturnCaseEventRow,
  ReturnCaseItemRow,
  ReturnCaseListQuery,
  ReturnCaseListRow,
  ReturnCaseSummaryMetrics,
} from "../application/return-case-admin.service";
import {
  ReturnCaseActionDomainError,
  parseReturnPolicySnapshot,
  type ReturnCaseActionContext,
  type ReturnInspectionFacts,
} from "../domain/return-case-actions";

const itemSummary = db
  .select({
    returnCaseId: returnCaseItems.returnCaseId,
    itemCount: count(returnCaseItems.id).as("return_case_item_count"),
    unitCount: sum(returnCaseItems.quantity).as("return_case_unit_count"),
  })
  .from(returnCaseItems)
  .groupBy(returnCaseItems.returnCaseId)
  .as("return_case_item_summary");


const UNIFIED_RETURN_CASES_CTE = `
WITH canonical_item_summary AS (
  SELECT return_case_id, COUNT(*)::integer AS item_count, COALESCE(SUM(quantity), 0)::integer AS unit_count
  FROM returns.return_case_items
  GROUP BY return_case_id
),
legacy_item_summary AS (
  SELECT rma_id, COUNT(*)::integer AS item_count, COALESCE(SUM(quantity), 0)::integer AS unit_count
  FROM dropship.dropship_rma_items
  GROUP BY rma_id
),
unified_returns AS (
  SELECT
    'canonical'::text AS record_origin,
    'canonical:' || rc.id::text AS record_key,
    NULL::integer AS legacy_rma_id,
    rc.id, rc.case_number, rc.source_provider, rc.source_event_type, rc.source_event_id,
    rc.business_context, rc.channel_id, channel.name AS channel_name, rc.vendor_id,
    COALESCE(vendor.business_name, vendor.email, vendor.member_id) AS vendor_name,
    rc.store_connection_id, COALESCE(store.external_display_name, store.shop_domain) AS store_name,
    rc.oms_order_id, oms.external_order_number AS oms_order_number, rc.wms_order_id,
    wms.order_number AS wms_order_number, rc.wms_return_id, rc.case_status, rc.approval_status,
    rc.logistics_status, rc.inspection_status, rc.customer_refund_status, rc.vendor_settlement_status,
    rc.opened_at, rc.closed_at, COALESCE(items.item_count, 0)::integer AS item_count,
    COALESCE(items.unit_count, 0)::integer AS unit_count,
    CONCAT_WS(' ', rc.case_number, rc.source_event_id, oms.external_order_number, wms.order_number,
      vendor.business_name, vendor.email, store.external_display_name, store.shop_domain) AS searchable
  FROM returns.return_cases rc
  LEFT JOIN channels.channels channel ON channel.id = rc.channel_id
  LEFT JOIN dropship.dropship_vendors vendor ON vendor.id = rc.vendor_id
  LEFT JOIN dropship.dropship_store_connections store ON store.id = rc.store_connection_id
  LEFT JOIN oms.oms_orders oms ON oms.id = rc.oms_order_id
  LEFT JOIN wms.orders wms ON wms.id = rc.wms_order_id
  LEFT JOIN canonical_item_summary items ON items.return_case_id = rc.id

  UNION ALL

  SELECT
    'legacy_dropship'::text AS record_origin,
    'legacy_dropship:' || rma.id::text AS record_key,
    rma.id AS legacy_rma_id,
    rma.id, rma.rma_number AS case_number,
    COALESCE(store.platform, intake.platform, 'dropship') AS source_provider,
    'legacy_rma'::text AS source_event_type, rma.id::text AS source_event_id,
    'dropship'::text AS business_context, COALESCE(intake.channel_id, oms.channel_id) AS channel_id,
    COALESCE(channel.name, store.platform, intake.platform) AS channel_name, rma.vendor_id,
    COALESCE(vendor.business_name, vendor.email, vendor.member_id) AS vendor_name,
    rma.store_connection_id, COALESCE(store.external_display_name, store.shop_domain) AS store_name,
    rma.oms_order_id,
    COALESCE(oms.external_order_number, intake.external_order_number, intake.external_order_id) AS oms_order_number,
    NULL::integer AS wms_order_id, NULL::text AS wms_order_number, NULL::integer AS wms_return_id,
    CASE
      WHEN rma.status IN ('closed', 'rejected') THEN 'closed'
      WHEN rma.status = 'disputed' THEN 'exception'
      ELSE 'open'
    END AS case_status,
    CASE
      WHEN rma.status = 'rejected' THEN 'rejected'
      WHEN rma.status = 'requested' THEN 'pending'
      ELSE 'approved'
    END AS approval_status,
    CASE
      WHEN rma.status = 'no_inspection_review' THEN 'not_required'
      WHEN rma.received_at IS NOT NULL THEN 'received'
      WHEN rma.status = 'in_transit' THEN 'in_transit'
      ELSE 'awaiting_return'
    END AS logistics_status,
    CASE
      WHEN rma.status = 'no_inspection_review' THEN 'not_required'
      WHEN rma.status = 'rejected' THEN 'rejected'
      WHEN rma.inspected_at IS NOT NULL AND rma.status IN ('approved', 'credited', 'closed') THEN 'approved'
      ELSE 'pending'
    END AS inspection_status,
    CASE
      WHEN rma.credited_at IS NOT NULL THEN 'completed'
      WHEN rma.status = 'rejected' THEN 'not_required'
      ELSE 'pending'
    END AS customer_refund_status,
    CASE
      WHEN rma.credited_at IS NOT NULL THEN 'completed'
      WHEN rma.status = 'rejected' THEN 'not_applicable'
      ELSE 'pending'
    END AS vendor_settlement_status,
    rma.requested_at AS opened_at,
    CASE WHEN rma.status IN ('closed', 'rejected')
      THEN COALESCE(rma.credited_at, rma.inspected_at, rma.received_at, rma.updated_at)
      ELSE NULL
    END AS closed_at,
    COALESCE(items.item_count, 0)::integer AS item_count,
    COALESCE(items.unit_count, 0)::integer AS unit_count,
    CONCAT_WS(' ', rma.rma_number, rma.id::text, oms.external_order_number,
      intake.external_order_number, intake.external_order_id, vendor.business_name, vendor.email,
      store.external_display_name, store.shop_domain, rma.return_tracking_number) AS searchable
  FROM dropship.dropship_rmas rma
  LEFT JOIN dropship.dropship_vendors vendor ON vendor.id = rma.vendor_id
  LEFT JOIN dropship.dropship_store_connections store ON store.id = rma.store_connection_id
  LEFT JOIN dropship.dropship_order_intake intake ON intake.id = rma.intake_id
  LEFT JOIN oms.oms_orders oms ON oms.id = rma.oms_order_id
  LEFT JOIN channels.channels channel ON channel.id = COALESCE(intake.channel_id, oms.channel_id)
  LEFT JOIN legacy_item_summary items ON items.rma_id = rma.id
  WHERE NOT EXISTS (
    SELECT 1
    FROM returns.return_cases adopted
    WHERE adopted.source_provider = 'dropship'
      AND adopted.source_event_type = 'legacy_rma'
      AND adopted.source_event_id = rma.id::text
  )
),
filtered_returns AS (
  SELECT *
  FROM unified_returns
  WHERE ($1::text IS NULL OR case_status = $1)
    AND ($2::text IS NULL OR source_provider = $2)
    AND ($3::integer IS NULL OR channel_id = $3)
    AND ($4::text IS NULL OR searchable ILIKE '%' || $4 || '%')
)
`;

interface UnifiedReturnCaseRow {
  record_origin: "canonical" | "legacy_dropship";
  record_key: string;
  legacy_rma_id: number | string | null;
  id: number | string;
  case_number: string;
  source_provider: string;
  source_event_type: string;
  source_event_id: string;
  business_context: string;
  channel_id: number | string | null;
  channel_name: string | null;
  vendor_id: number | string | null;
  vendor_name: string | null;
  store_connection_id: number | string | null;
  store_name: string | null;
  oms_order_id: number | string | null;
  oms_order_number: string | null;
  wms_order_id: number | string | null;
  wms_order_number: string | null;
  wms_return_id: number | string | null;
  case_status: string;
  approval_status: string;
  logistics_status: string;
  inspection_status: string;
  customer_refund_status: string;
  vendor_settlement_status: string;
  opened_at: Date | string;
  closed_at: Date | string | null;
  item_count: number | string;
  unit_count: number | string;
  searchable: string;
}

interface UnifiedReturnSummaryRow {
  total: number | string;
  open: number | string;
  awaiting_inspection: number | string;
  closed: number | string;
}
export class PostgresReturnCaseAdminStore implements ReturnCaseAdminStore {
  async list(query: ReturnCaseListQuery): Promise<{ rows: ReturnCaseListRow[]; summary: ReturnCaseSummaryMetrics }> {
    const offset = (query.page - 1) * query.limit;
    const filters = [query.caseStatus, query.sourceProvider, query.channelId, query.search];

    const [pageResult, summaryResult] = await Promise.all([
      pool.query<UnifiedReturnCaseRow>(
        `${UNIFIED_RETURN_CASES_CTE}
        SELECT *
        FROM filtered_returns
        ORDER BY opened_at DESC, record_origin ASC, id DESC
        LIMIT $5 OFFSET $6
        `,
        [...filters, query.limit, offset],
      ),
      pool.query<UnifiedReturnSummaryRow>(
        `${UNIFIED_RETURN_CASES_CTE}
        SELECT
          COUNT(*)::integer AS total,
          COUNT(*) FILTER (WHERE case_status = 'open')::integer AS open,
          COUNT(*) FILTER (
            WHERE case_status = 'open'
              AND logistics_status = 'received'
              AND inspection_status = 'pending'
          )::integer AS awaiting_inspection,
          COUNT(*) FILTER (WHERE case_status = 'closed')::integer AS closed
        FROM filtered_returns
        `,
        filters,
      ),
    ]);

    const summary = summaryResult.rows[0];
    return {
      rows: pageResult.rows.map(mapUnifiedListRow),
      summary: {
        total: readNonNegativeInteger(summary?.total ?? 0, "total"),
        open: readNonNegativeInteger(summary?.open ?? 0, "open total"),
        awaitingInspection: readNonNegativeInteger(summary?.awaiting_inspection ?? 0, "awaiting inspection total"),
        closed: readNonNegativeInteger(summary?.closed ?? 0, "closed total"),
      },
    };
  }

  async getById(id: number): Promise<ReturnCaseDetailRow | null> {
    const caseRows = await selectCaseRows().where(eq(returnCases.id, id)).limit(1);
    const caseRow = caseRows[0];
    if (!caseRow) return null;

    const [itemRows, eventRows, wmsReturnRows, wmsItemRows, inspectionRows] = await Promise.all([
      selectDetailItemRows(id),
      db
        .select()
        .from(returnCaseEvents)
        .where(eq(returnCaseEvents.returnCaseId, id))
        .orderBy(asc(returnCaseEvents.occurredAt), asc(returnCaseEvents.id)),
      db
        .select()
        .from(wmsReturns)
        .where(eq(wmsReturns.id, caseRow.wmsReturnId))
        .limit(1),
      db
        .select()
        .from(returnItems)
        .where(eq(returnItems.returnId, caseRow.wmsReturnId))
        .orderBy(asc(returnItems.id)),
      db
        .select()
        .from(returnCaseInspections)
        .where(and(
          eq(returnCaseInspections.returnCaseId, id),
          eq(returnCaseInspections.status, "in_progress"),
        ))
        .orderBy(asc(returnCaseInspections.id))
        .limit(2),
    ]);

    const actionContext = buildActionContext({
      caseRow,
      itemRows,
      wmsReturn: wmsReturnRows[0] ?? null,
      wmsItems: wmsItemRows,
      inspectionRows,
    });
    return {
      ...mapListRow(caseRow),
      policyId: caseRow.policyId,
      policyVersion: caseRow.policyVersion,
      policySnapshot: caseRow.policySnapshot,
      createdAt: caseRow.createdAt,
      updatedAt: caseRow.updatedAt,
      items: itemRows.map(mapItemRow),
      events: eventRows.map(mapEventRow),
      actionContext,
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

function mapUnifiedListRow(row: UnifiedReturnCaseRow): ReturnCaseListRow {
  return {
    recordOrigin: row.record_origin,
    recordKey: row.record_key,
    legacyRmaId: readNullablePositiveSafeInteger(row.legacy_rma_id, "legacy RMA id"),
    id: readPositiveSafeInteger(row.id, "return record id"),
    caseNumber: row.case_number,
    sourceProvider: row.source_provider,
    sourceEventType: row.source_event_type,
    sourceEventId: row.source_event_id,
    businessContext: row.business_context,
    channelId: readNullablePositiveSafeInteger(row.channel_id, "channel id"),
    channelName: row.channel_name,
    vendorId: readNullablePositiveSafeInteger(row.vendor_id, "vendor id"),
    vendorName: row.vendor_name,
    storeConnectionId: readNullablePositiveSafeInteger(row.store_connection_id, "store connection id"),
    storeName: row.store_name,
    omsOrderId: readNullablePositiveSafeInteger(row.oms_order_id, "OMS order id"),
    omsOrderNumber: row.oms_order_number,
    wmsOrderId: readNullablePositiveSafeInteger(row.wms_order_id, "WMS order id"),
    wmsOrderNumber: row.wms_order_number,
    wmsReturnId: readNullablePositiveSafeInteger(row.wms_return_id, "WMS return id"),
    caseStatus: row.case_status as ReturnCaseListRow["caseStatus"],
    approvalStatus: row.approval_status as ReturnCaseListRow["approvalStatus"],
    logisticsStatus: row.logistics_status as ReturnCaseListRow["logisticsStatus"],
    inspectionStatus: row.inspection_status as ReturnCaseListRow["inspectionStatus"],
    customerRefundStatus: row.customer_refund_status as ReturnCaseListRow["customerRefundStatus"],
    vendorSettlementStatus: row.vendor_settlement_status as ReturnCaseListRow["vendorSettlementStatus"],
    openedAt: readDate(row.opened_at, "opened at"),
    closedAt: readNullableDate(row.closed_at, "closed at"),
    itemCount: readNonNegativeInteger(row.item_count, "item count"),
    unitCount: readNonNegativeInteger(row.unit_count, "unit count"),
  };
}
type SelectedCaseRow = Awaited<ReturnType<ReturnType<typeof selectCaseRows>["limit"]>>[number];

function mapListRow(row: SelectedCaseRow): ReturnCaseListRow {
  return {
    recordOrigin: "canonical",
    recordKey: `canonical:${readPositiveSafeInteger(row.id, "return case id")}`,
    legacyRmaId: null,
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
    omsOrderId: readNullablePositiveSafeInteger(row.omsOrderId, "OMS order id"),
    omsOrderNumber: row.omsOrderNumber,
    wmsOrderId: row.wmsOrderId,
    wmsOrderNumber: row.wmsOrderNumber,
    wmsReturnId: readNullablePositiveSafeInteger(row.wmsReturnId, "WMS return id"),
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

function selectDetailItemRows(returnCaseId: number) {
  return db
    .select({ caseItem: returnCaseItems, wmsItem: returnItems })
    .from(returnCaseItems)
    .innerJoin(returnItems, eq(returnItems.id, returnCaseItems.wmsReturnItemId))
    .where(eq(returnCaseItems.returnCaseId, returnCaseId))
    .orderBy(asc(returnCaseItems.id));
}
type SelectedDetailItemRow = Awaited<ReturnType<typeof selectDetailItemRows>>[number];

function mapItemRow(row: SelectedDetailItemRow): ReturnCaseItemRow {
  const expectedQuantity = readPositiveSafeInteger(row.wmsItem.expectedQty, "WMS expected quantity");
  const receivedQuantity = readNonNegativeInteger(row.wmsItem.receivedQty, "WMS received quantity");
  if (receivedQuantity > expectedQuantity) throw new Error("WMS received quantity exceeds expected quantity.");
  return {
    id: readPositiveSafeInteger(row.caseItem.id, "return case item id"),
    wmsReturnItemId: readPositiveSafeInteger(row.caseItem.wmsReturnItemId, "WMS return item id"),
    omsOrderLineId: readNullablePositiveSafeInteger(row.caseItem.omsOrderLineId, "OMS order line id"),
    wmsOrderItemId: row.caseItem.wmsOrderItemId,
    externalLineItemId: row.caseItem.externalLineItemId,
    sku: row.caseItem.sku,
    title: row.caseItem.title,
    quantity: readPositiveSafeInteger(row.caseItem.quantity, "return case item quantity"),
    expectedQuantity,
    receivedQuantity,
    remainingQuantity: expectedQuantity - receivedQuantity,
    receiptStatus: readReceiptStatus(row.wmsItem.status),
    unitPaidPriceCents: readNonNegativeInteger(row.caseItem.unitPaidPriceCents, "unit paid price cents"),
    sourceLineTotalCents: readNonNegativeInteger(row.caseItem.sourceLineTotalCents, "source line total cents"),
    createdAt: row.caseItem.createdAt,
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

interface ActionContextInput {
  caseRow: SelectedCaseRow;
  itemRows: SelectedDetailItemRow[];
  wmsReturn: typeof wmsReturns.$inferSelect | null;
  wmsItems: Array<typeof returnItems.$inferSelect>;
  inspectionRows: Array<typeof returnCaseInspections.$inferSelect>;
}

function buildActionContext(input: ActionContextInput): ReturnCaseActionContext {
  if (input.inspectionRows.length > 1) throw new Error("Return case has more than one active inspection.");
  const canonicalByWmsItemId = new Map(
    input.itemRows.map(({ caseItem }) => [
      readPositiveSafeInteger(caseItem.wmsReturnItemId, "WMS return item id"),
      caseItem,
    ] as const),
  );
  return {
    lifecycle: {
      caseStatus: input.caseRow.caseStatus as ReturnCaseActionContext["lifecycle"]["caseStatus"],
      approvalStatus: input.caseRow.approvalStatus as ReturnCaseActionContext["lifecycle"]["approvalStatus"],
      logisticsStatus: input.caseRow.logisticsStatus as ReturnCaseActionContext["lifecycle"]["logisticsStatus"],
      inspectionStatus: input.caseRow.inspectionStatus as ReturnCaseActionContext["lifecycle"]["inspectionStatus"],
      customerRefundStatus: input.caseRow.customerRefundStatus as ReturnCaseActionContext["lifecycle"]["customerRefundStatus"],
      vendorSettlementStatus: input.caseRow.vendorSettlementStatus as ReturnCaseActionContext["lifecycle"]["vendorSettlementStatus"],
    },
    policy: parseStoredPolicy(input.caseRow.policySnapshot, input.caseRow.policyId, input.caseRow.policyVersion),
    receipt: input.wmsReturn ? {
      wmsReturnId: readPositiveSafeInteger(input.wmsReturn.id, "WMS return id"),
      wmsStatus: readRequiredText(input.wmsReturn.status, "WMS return status"),
      receivedAt: readNullableDate(input.wmsReturn.receivedAt, "WMS received at"),
      restocked: readBoolean(input.wmsReturn.restocked, "WMS restocked"),
      canonicalItemCount: input.itemRows.length,
      items: input.wmsItems.map((wmsItem) => {
        const wmsReturnItemId = readPositiveSafeInteger(wmsItem.id, "WMS return item id");
        const canonicalItem = canonicalByWmsItemId.get(wmsReturnItemId);
        return {
          returnCaseItemId: canonicalItem ? readPositiveSafeInteger(canonicalItem.id, "return case item id") : null,
          wmsReturnItemId,
          caseExpectedQuantity: canonicalItem
            ? readPositiveSafeInteger(canonicalItem.quantity, "return case item quantity")
            : null,
          wmsExpectedQuantity: readPositiveSafeInteger(wmsItem.expectedQty, "WMS expected quantity"),
          wmsReceivedQuantity: readNonNegativeInteger(wmsItem.receivedQty, "WMS received quantity"),
          wmsStatus: readRequiredText(wmsItem.status, "WMS return item status"),
        };
      }),
    } : null,
    inspection: input.inspectionRows[0] ? mapActiveInspection(input.inspectionRows[0]) : null,
    conditionalInspectionDecision: null,
  };
}

function parseStoredPolicy(
  value: unknown,
  policyId: number,
  policyVersion: number,
): ReturnCaseActionContext["policy"] {
  try {
    const policy = parseReturnPolicySnapshot(value);
    return policy.id === policyId && policy.version === policyVersion ? policy : null;
  } catch (error) {
    if (error instanceof ReturnCaseActionDomainError && error.code === "RETURN_POLICY_SNAPSHOT_INVALID") return null;
    throw error;
  }
}

function mapActiveInspection(row: typeof returnCaseInspections.$inferSelect): ReturnInspectionFacts {
  return {
    inspectionId: readPositiveSafeInteger(row.id, "return inspection id"),
    status: readInspectionStatus(row.status),
    startedAt: readDate(row.startedAt, "inspection started at"),
    startedBy: readRequiredText(row.startedBy, "inspection started by"),
    completedAt: readNullableDate(row.completedAt, "inspection completed at"),
    completedBy: readNullableText(row.completedBy),
  };
}

function readReceiptStatus(value: unknown): ReturnCaseItemRow["receiptStatus"] {
  if (value === "expected" || value === "partially_received" || value === "received") return value;
  throw new Error("Invalid WMS return item status returned by the database.");
}
function readInspectionStatus(value: unknown): ReturnInspectionFacts["status"] {
  if (value === "in_progress" || value === "approved" || value === "rejected" || value === "cancelled") return value;
  throw new Error("Invalid return inspection status returned by the database.");
}
function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Invalid " + field + " returned by the database.");
  return value;
}
function readNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid " + field + " returned by the database.");
  return value;
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

function readDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${field} returned by the database.`);
  }
  return parsed;
}

function readNullableDate(value: Date | string | null, field: string): Date | null {
  return value === null ? null : readDate(value, field);
}
function readNonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} returned by the database.`);
  }
  return parsed;
}
