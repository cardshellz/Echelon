import { eq, sql, type SQL } from "drizzle-orm";
import {
  returnBusinessContexts,
  returnPolicies,
  returnPolicyScopeKinds,
  type ReturnBusinessContext,
  type ReturnPolicy,
  type ReturnPolicyScopeKind,
} from "@shared/schema";
import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  OpenReturnCaseError,
  type LockedReturnSourceContext,
  type OpenReturnCaseResult,
  type OpenReturnCaseStore,
  type OpenReturnCaseTransaction,
  type PersistOpenReturnCaseInput,
  type ReturnSourceOrderDetail,
  type ReturnSourceOrderItem,
  type ReturnSourceOrderPartition,
  type ReturnSourceOrderSearchQuery,
  type ReturnSourceOrderSearchRow,
} from "../application/open-return-case.service";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface SqlExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

// Shared with the Shopify refund cascade. Both writers claim fulfilled units.
const RETURN_QUANTITY_LOCK_NAMESPACE = 918413;

interface SourceHeaderRow {
  oms_order_id: unknown;
  external_order_number: unknown;
  external_order_id: unknown;
  channel_id: unknown;
  channel_name: unknown;
  customer_name: unknown;
  customer_email: unknown;
  ordered_at: unknown;
  fulfillment_status: unknown;
  wms_partition_count: unknown;
}

interface SourceItemRow {
  wms_order_id: unknown;
  wms_order_number: unknown;
  fulfillment_partition_key: unknown;
  warehouse_status: unknown;
  wms_order_item_id: unknown;
  oms_order_line_id: unknown;
  external_line_item_id: unknown;
  sku: unknown;
  title: unknown;
  fulfilled_quantity: unknown;
  already_expected_quantity: unknown;
  returnable_quantity: unknown;
  unit_paid_price_cents: unknown;
}

interface DropshipContextRow {
  channel_id: unknown;
  vendor_id: unknown;
  store_connection_id: unknown;
}

interface ExistingCaseRow {
  id: unknown;
  case_number: unknown;
  wms_return_id: unknown;
  request_hash: unknown;
}

interface InsertedIdRow { id: unknown }
interface InsertedCaseRow extends InsertedIdRow { case_number: unknown }

export class PostgresOpenReturnCaseStore implements OpenReturnCaseStore {
  async searchSourceOrders(query: ReturnSourceOrderSearchQuery): Promise<ReturnSourceOrderSearchRow[]> {
    const pattern = `%${escapeLike(query.search.trim())}%`;
    const result = await db.execute(sql`
      WITH expected AS (
        SELECT ri.order_item_id, SUM(ri.expected_qty)::int AS expected_qty
        FROM wms.return_items ri
        WHERE ri.order_item_id IS NOT NULL
        GROUP BY ri.order_item_id
      ), eligible_orders AS (
        SELECT DISTINCT
          wo.oms_fulfillment_order_id::bigint AS oms_order_id,
          wo.id AS wms_order_id
        FROM wms.orders wo
        JOIN wms.order_items oi ON oi.order_id = wo.id
        LEFT JOIN expected e ON e.order_item_id = oi.id
        WHERE wo.oms_fulfillment_order_id ~ '^[0-9]+$'
          AND oi.fulfilled_quantity > COALESCE(e.expected_qty, 0)
      )
      SELECT
        oo.id AS oms_order_id,
        oo.external_order_number,
        oo.external_order_id,
        oo.channel_id,
        c.name AS channel_name,
        oo.customer_name,
        oo.customer_email,
        oo.ordered_at,
        oo.fulfillment_status,
        COUNT(DISTINCT eo.wms_order_id)::int AS wms_partition_count
      FROM oms.oms_orders oo
      JOIN eligible_orders eo ON eo.oms_order_id = oo.id
      JOIN channels.channels c ON c.id = oo.channel_id

      WHERE ${query.search.trim() === ""} OR (
        COALESCE(oo.external_order_number, '') ILIKE ${pattern} ESCAPE '\\'
        OR oo.external_order_id ILIKE ${pattern} ESCAPE '\\'
        OR oo.id::text ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(oo.customer_name, '') ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(oo.customer_email, '') ILIKE ${pattern} ESCAPE '\\'
      )
      GROUP BY oo.id, c.name
      ORDER BY oo.ordered_at DESC, oo.id DESC
      LIMIT ${query.limit}
    `);
    return rowsOf<SourceHeaderRow>(result).map(mapSourceHeader);
  }

  async getSourceOrder(omsOrderId: number): Promise<ReturnSourceOrderDetail | null> {
    const header = await loadSourceHeader(db, omsOrderId);
    if (!header) return null;
    const [context, itemRows] = await Promise.all([
      inferDropshipContext(db, omsOrderId, header.channelId),
      loadSourceItems(db, omsOrderId, null, false),
    ]);
    return {
      ...header,
      ...context,
      partitions: groupPartitions(itemRows),
    };
  }

  transaction<T>(work: (tx: OpenReturnCaseTransaction) => Promise<T>): Promise<T> {
    return db.transaction((tx) => work(new PostgresOpenReturnCaseTransaction(tx)));
  }
}

class PostgresOpenReturnCaseTransaction implements OpenReturnCaseTransaction {
  constructor(private readonly tx: Transaction) {}

  async lockCommand(idempotencyKey: string): Promise<void> {
    await this.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`return-case-command:${idempotencyKey}`}))`);
  }

  async findExisting(idempotencyKey: string): Promise<{ requestHash: string; result: OpenReturnCaseResult } | null> {
    const result = await this.tx.execute(sql`
      SELECT
        rc.id,
        rc.case_number,
        rc.wms_return_id,
        COALESCE(opened.details ->> 'requestHash', '') AS request_hash
      FROM returns.return_cases rc
      LEFT JOIN LATERAL (
        SELECT rce.details
        FROM returns.return_case_events rce
        WHERE rce.return_case_id = rc.id
          AND rce.event_type = 'manual_return_case_opened'
        ORDER BY rce.id ASC
        LIMIT 1
      ) opened ON TRUE
      WHERE rc.source_provider = 'admin'
        AND rc.source_event_type = 'manual_return_case_opened'
        AND rc.source_event_id = ${idempotencyKey}
      LIMIT 1
    `);
    const row = rowsOf<ExistingCaseRow>(result)[0];
    if (!row) return null;
    return {
      requestHash: readText(row.request_hash, "request hash"),
      result: {
        caseId: readPositiveInteger(row.id, "return case id"),
        caseNumber: readText(row.case_number, "return case number"),
        wmsReturnId: readPositiveInteger(row.wms_return_id, "WMS return id"),
        replayed: true,
      },
    };
  }

  async loadSourceForUpdate(input: {
    omsOrderId: number;
    wmsOrderId: number;
    wmsOrderItemIds: number[];
  }): Promise<LockedReturnSourceContext | null> {
    await this.tx.execute(sql`
      SELECT pg_advisory_xact_lock(${RETURN_QUANTITY_LOCK_NAMESPACE}, ${input.omsOrderId})
    `);
    const sourceResult = await this.tx.execute(sql`
      SELECT oo.id, oo.channel_id
      FROM oms.oms_orders oo
      JOIN wms.orders wo
        ON wo.id = ${input.wmsOrderId}
       AND wo.oms_fulfillment_order_id = oo.id::text
      WHERE oo.id = ${input.omsOrderId}
      FOR UPDATE OF oo, wo
    `);
    const sourceRow = rowsOf<{ id: unknown; channel_id: unknown }>(sourceResult)[0];
    if (!sourceRow) return null;

    const channelId = readPositiveInteger(sourceRow.channel_id, "channel id");
    const [context, itemRows, policies] = await Promise.all([
      inferDropshipContext(this.tx, input.omsOrderId, channelId),
      loadSourceItems(this.tx, input.omsOrderId, input.wmsOrderId, true, input.wmsOrderItemIds),
      this.tx.select().from(returnPolicies).where(eq(returnPolicies.status, "active")),
    ]);
    return {
      omsOrderId: input.omsOrderId,
      wmsOrderId: input.wmsOrderId,
      channelId,
      ...context,
      policies: policies.map(toResolvableReturnPolicy),
      items: itemRows.map(mapSourceItem),
    };
  }

  async persist(input: PersistOpenReturnCaseInput): Promise<OpenReturnCaseResult> {
    const returnResult = await this.tx.execute(sql`
      INSERT INTO wms.returns (
        order_id, source, source_event_key, reason, restocked, status,
        notes, created_at, updated_at
      ) VALUES (
        ${input.source.wmsOrderId}, 'returns_admin', ${`manual-return:${input.idempotencyKey}`},
        ${input.reasonCode}, false, 'expected', ${input.notes}, ${input.now}, ${input.now}
      )
      RETURNING id
    `);
    const wmsReturnId = readPositiveInteger(rowsOf<InsertedIdRow>(returnResult)[0]?.id, "WMS return id");

    const wmsReturnItems: Array<{ item: PersistOpenReturnCaseInput["selectedItems"][number]; id: number }> = [];
    for (const item of input.selectedItems) {
      const itemResult = await this.tx.execute(sql`
        INSERT INTO wms.return_items (
          return_id, order_item_id, oms_order_line_id, external_line_item_id,
          sku, expected_qty, received_qty, restock_policy, status, created_at, updated_at
        ) VALUES (
          ${wmsReturnId}, ${item.wmsOrderItemId}, ${item.omsOrderLineId},
          ${item.externalLineItemId}, ${item.sku}, ${item.quantity}, 0,
          'return', 'expected', ${input.now}, ${input.now}
        )
        RETURNING id
      `);
      wmsReturnItems.push({
        item,
        id: readPositiveInteger(rowsOf<InsertedIdRow>(itemResult)[0]?.id, "WMS return item id"),
      });
    }

    const caseResult = await this.tx.execute(sql`
      INSERT INTO returns.return_cases (
        source_provider, source_event_type, source_event_id, business_context,
        channel_id, vendor_id, store_connection_id, oms_order_id, wms_order_id,
        wms_return_id, policy_id, policy_version, policy_snapshot, case_status,
        approval_status, logistics_status, inspection_status,
        customer_refund_status, vendor_settlement_status, opened_at, created_at, updated_at
      ) VALUES (
        'admin', 'manual_return_case_opened', ${input.idempotencyKey}, ${input.source.businessContext},
        ${input.source.channelId}, ${input.source.vendorId}, ${input.source.storeConnectionId},
        ${input.source.omsOrderId}, ${input.source.wmsOrderId}, ${wmsReturnId},
        ${input.policy.id}, ${input.policy.version}, ${JSON.stringify(input.policySnapshot)}::jsonb,
        ${input.lifecycle.caseStatus}, ${input.lifecycle.approvalStatus}, ${input.lifecycle.logisticsStatus},
        ${input.lifecycle.inspectionStatus}, ${input.lifecycle.customerRefundStatus},
        ${input.lifecycle.vendorSettlementStatus}, ${input.now}, ${input.now}, ${input.now}
      )
      RETURNING id, case_number
    `);
    const returnCase = rowsOf<InsertedCaseRow>(caseResult)[0];
    const caseId = readPositiveInteger(returnCase?.id, "return case id");
    const caseNumber = readText(returnCase?.case_number, "return case number");

    for (const { item, id } of wmsReturnItems) {
      const sourceLineTotalCents = multiplyMoney(item.unitPaidPriceCents, item.quantity);
      await this.tx.execute(sql`
        INSERT INTO returns.return_case_items (
          return_case_id, wms_return_item_id, oms_order_line_id, wms_order_item_id,
          external_line_item_id, sku, title, quantity, unit_paid_price_cents,
          source_line_total_cents, created_at
        ) VALUES (
          ${caseId}, ${id}, ${item.omsOrderLineId}, ${item.wmsOrderItemId},
          ${item.externalLineItemId}, ${item.sku}, ${item.title}, ${item.quantity},
          ${item.unitPaidPriceCents}, ${sourceLineTotalCents}, ${input.now}
        )
      `);
    }

    const eventDetails = {
      requestHash: input.requestHash,
      sourceProvider: "admin",
      sourceEventType: "manual_return_case_opened",
      omsOrderId: input.source.omsOrderId,
      wmsOrderId: input.source.wmsOrderId,
      wmsReturnId,
      channelId: input.source.channelId,
      businessContext: input.source.businessContext,
      vendorId: input.source.vendorId,
      storeConnectionId: input.source.storeConnectionId,
      reasonCode: input.reasonCode,
      itemCount: input.selectedItems.length,
      unitCount: input.selectedItems.reduce((total, item) => total + item.quantity, 0),
      policyId: input.policy.id,
      policyVersion: input.policy.version,
    };
    await this.tx.execute(sql`
      INSERT INTO returns.return_case_events (
        return_case_id, event_type, actor, details, occurred_at, created_at
      ) VALUES (
        ${caseId}, 'manual_return_case_opened', ${input.actor},
        ${JSON.stringify(eventDetails)}::jsonb, ${input.now}, ${input.now}
      )
    `);
    await persistAuditEvent(this.tx, {
      actor: input.actor,
      action: "RETURN_CASE_OPENED",
      target: `returns.return_cases:${caseId}`,
      changes: {
        before: null,
        after: {
          caseId,
          caseNumber,
          wmsReturnId,
          lifecycle: input.lifecycle,
        },
      },
      context: eventDetails,
    }, { timestamp: input.now });
    return { caseId, caseNumber, wmsReturnId, replayed: false };
  }
}

async function loadSourceHeader(executor: SqlExecutor, omsOrderId: number): Promise<ReturnSourceOrderSearchRow | null> {
  const result = await executor.execute(sql`
    SELECT
      oo.id AS oms_order_id,
      oo.external_order_number,
      oo.external_order_id,
      oo.channel_id,
      c.name AS channel_name,
      oo.customer_name,
      oo.customer_email,
      oo.ordered_at,
      oo.fulfillment_status,
      COUNT(DISTINCT wo.id)::int AS wms_partition_count
    FROM oms.oms_orders oo
    JOIN channels.channels c ON c.id = oo.channel_id
    JOIN wms.orders wo ON wo.oms_fulfillment_order_id = oo.id::text
    WHERE oo.id = ${omsOrderId}
    GROUP BY oo.id, c.name
  `);
  const row = rowsOf<SourceHeaderRow>(result)[0];
  return row ? mapSourceHeader(row) : null;
}

async function inferDropshipContext(
  executor: SqlExecutor,
  omsOrderId: number,
  channelId: number,
): Promise<Pick<ReturnSourceOrderDetail, "businessContext" | "vendorId" | "storeConnectionId">> {
  const result = await executor.execute(sql`
    SELECT doi.channel_id, doi.vendor_id, doi.store_connection_id
    FROM dropship.dropship_order_intake doi
    WHERE doi.oms_order_id = ${omsOrderId}
    GROUP BY doi.channel_id, doi.vendor_id, doi.store_connection_id
    ORDER BY doi.vendor_id, doi.store_connection_id
  `);
  const rows = rowsOf<DropshipContextRow>(result);
  if (rows.length === 0) return { businessContext: "retail", vendorId: null, storeConnectionId: null };
  if (rows.length !== 1) {
    throw new OpenReturnCaseError(
      "RETURN_SOURCE_CONTEXT_AMBIGUOUS",
      "The OMS order is linked to more than one dropship vendor or store.",
      409,
      { omsOrderId, matches: rows.length },
    );
  }
  const row = rows[0];
  const intakeChannelId = readPositiveInteger(row.channel_id, "dropship intake channel id");
  if (intakeChannelId !== channelId) {
    throw new OpenReturnCaseError(
      "RETURN_SOURCE_CONTEXT_MISMATCH",
      "The dropship intake channel does not match the OMS order channel.",
      409,
      { omsOrderId, omsChannelId: channelId, intakeChannelId },
    );
  }
  return {
    businessContext: "dropship",
    vendorId: readPositiveInteger(row.vendor_id, "dropship vendor id"),
    storeConnectionId: readPositiveInteger(row.store_connection_id, "dropship store connection id"),
  };
}

async function loadSourceItems(
  executor: SqlExecutor,
  omsOrderId: number,
  wmsOrderId: number | null,
  forUpdate: boolean,
  itemIds: number[] = [],
): Promise<SourceItemRow[]> {
  const result = await executor.execute(sql`
    WITH expected AS (
      SELECT ri.order_item_id, SUM(ri.expected_qty)::int AS expected_qty
      FROM wms.return_items ri
      WHERE ri.order_item_id IS NOT NULL
      GROUP BY ri.order_item_id
    )
    SELECT
      wo.id AS wms_order_id,
      wo.order_number AS wms_order_number,
      wo.fulfillment_partition_key,
      wo.status AS warehouse_status,
      oi.id AS wms_order_item_id,
      oi.oms_order_line_id,
      oi.source_item_id AS external_line_item_id,
      oi.sku,
      oi.name AS title,
      oi.fulfilled_quantity,
      COALESCE(e.expected_qty, 0)::int AS already_expected_quantity,
      GREATEST(oi.fulfilled_quantity - COALESCE(e.expected_qty, 0), 0)::int AS returnable_quantity,
      oi.paid_price_cents AS unit_paid_price_cents
    FROM wms.orders wo
    JOIN wms.order_items oi ON oi.order_id = wo.id
    LEFT JOIN expected e ON e.order_item_id = oi.id
    WHERE wo.oms_fulfillment_order_id = ${String(omsOrderId)}
      AND (${wmsOrderId}::int IS NULL OR wo.id = ${wmsOrderId})
      AND (${itemIds.length === 0} OR oi.id = ANY(ARRAY[${sql.join(itemIds.length === 0 ? [0] : itemIds, sql`, `)}]::int[]))
      AND oi.fulfilled_quantity > COALESCE(e.expected_qty, 0)
    ORDER BY wo.id, oi.id
    ${forUpdate ? sql`FOR UPDATE OF wo, oi` : sql``}
  `);
  return rowsOf<SourceItemRow>(result);
}

function groupPartitions(rows: SourceItemRow[]): ReturnSourceOrderPartition[] {
  const partitions = new Map<number, ReturnSourceOrderPartition>();
  for (const row of rows) {
    const wmsOrderId = readPositiveInteger(row.wms_order_id, "WMS order id");
    let partition = partitions.get(wmsOrderId);
    if (!partition) {
      partition = {
        wmsOrderId,
        wmsOrderNumber: readText(row.wms_order_number, "WMS order number"),
        fulfillmentPartitionKey: readText(row.fulfillment_partition_key, "fulfillment partition key"),
        warehouseStatus: readText(row.warehouse_status, "warehouse status"),
        items: [],
      };
      partitions.set(wmsOrderId, partition);
    }
    partition.items.push(mapSourceItem(row));
  }
  return [...partitions.values()];
}

function mapSourceHeader(row: SourceHeaderRow): ReturnSourceOrderSearchRow {
  return {
    omsOrderId: readPositiveInteger(row.oms_order_id, "OMS order id"),
    externalOrderNumber: readNullableText(row.external_order_number),
    externalOrderId: readText(row.external_order_id, "external order id"),
    channelId: readPositiveInteger(row.channel_id, "channel id"),
    channelName: readText(row.channel_name, "channel name"),
    customerName: readNullableText(row.customer_name),
    customerEmail: readNullableText(row.customer_email),
    orderedAt: readDate(row.ordered_at, "ordered at"),
    fulfillmentStatus: readNullableText(row.fulfillment_status),
    wmsPartitionCount: readNonNegativeInteger(row.wms_partition_count, "WMS partition count"),
  };
}

function mapSourceItem(row: SourceItemRow): ReturnSourceOrderItem {
  return {
    wmsOrderItemId: readPositiveInteger(row.wms_order_item_id, "WMS order item id"),
    omsOrderLineId: readNullablePositiveInteger(row.oms_order_line_id, "OMS order line id"),
    externalLineItemId: readNullableText(row.external_line_item_id),
    sku: readText(row.sku, "SKU"),
    title: readText(row.title, "item title"),
    fulfilledQuantity: readNonNegativeInteger(row.fulfilled_quantity, "fulfilled quantity"),
    alreadyExpectedQuantity: readNonNegativeInteger(row.already_expected_quantity, "already expected quantity"),
    returnableQuantity: readPositiveInteger(row.returnable_quantity, "returnable quantity"),
    unitPaidPriceCents: readNonNegativeInteger(row.unit_paid_price_cents, "unit paid price cents"),
  };
}

function toResolvableReturnPolicy(
  policy: ReturnPolicy,
): ReturnPolicy & { scopeKind: ReturnPolicyScopeKind; businessContext: ReturnBusinessContext | null } {
  if (!returnPolicyScopeKinds.includes(policy.scopeKind as ReturnPolicyScopeKind)) {
    throw new OpenReturnCaseError(
      "RETURN_POLICY_DATA_INVALID",
      "An active return policy has an unsupported scope kind.",
      500,
      { policyId: policy.id, scopeKind: policy.scopeKind },
    );
  }
  if (
    policy.businessContext !== null &&
    !returnBusinessContexts.includes(policy.businessContext as ReturnBusinessContext)
  ) {
    throw new OpenReturnCaseError(
      "RETURN_POLICY_DATA_INVALID",
      "An active return policy has an unsupported business context.",
      500,
      { policyId: policy.id, businessContext: policy.businessContext },
    );
  }
  return {
    ...policy,
    scopeKind: policy.scopeKind as ReturnPolicyScopeKind,
    businessContext: policy.businessContext as ReturnBusinessContext | null,
  };
}

function rowsOf<T>(result: unknown): T[] {
  if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray((result as { rows: unknown }).rows)) {
    throw new Error("Database result did not contain rows.");
  }
  return (result as { rows: T[] }).rows;
}

function readPositiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} is not a positive safe integer.`);
  return parsed;
}

function readNullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : readPositiveInteger(value, field);
}

function readNonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} is not a non-negative safe integer.`);
  return parsed;
}

function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is missing.`);
  return value;
}

function readNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function readDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field} is invalid.`);
  return parsed;
}

function multiplyMoney(unitCents: number, quantity: number): number {
  const result = unitCents * quantity;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new OpenReturnCaseError("RETURN_CASE_ITEM_MONEY_INVALID", "Return case item money exceeds the supported range.", 409, {
      unitCents,
      quantity,
    });
  }
  return result;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
