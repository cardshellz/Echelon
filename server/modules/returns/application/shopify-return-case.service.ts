import { sql } from "drizzle-orm";
import type {
  ReturnBusinessContext,
  ReturnPolicy,
  ReturnPolicyScopeKind,
} from "@shared/schema";
import {
  deriveShopifyRefundReturnLifecycle,
  ReturnCaseDomainError,
  snapshotReturnPolicy,
} from "../domain/return-case";
import { resolveReturnPolicy, type ReturnPolicyCandidate } from "../domain/return-policy";

type ResolvableReturnPolicy = ReturnPolicy & ReturnPolicyCandidate;

export interface RecordShopifyRefundReturnCaseInput {
  tx: any;
  channelId: number;
  omsOrderId: number;
  wmsOrderId: number;
  wmsReturnId: number;
  refundExternalId: string;
  now: Date;
}

export interface RecordShopifyRefundReturnCaseResult {
  caseId: number;
  caseNumber: string;
  replayed: boolean;
}

interface PolicyRow {
  id: number;
  name: string;
  scope_kind: ReturnPolicyScopeKind;
  scope_key: string;
  business_context: ReturnBusinessContext | null;
  channel_id: number | null;
  vendor_id: number | null;
  store_connection_id: number | null;
  version: number;
  status: string;
  return_window_days: number;
  return_destination: string;
  approval_authority: string;
  label_provider: string;
  return_shipping_payer: string;
  inspection_requirement: string;
  inspection_owner: string;
  customer_refund_authority: string;
  vendor_settlement_trigger: string;
  returnless_refund_allowed: boolean;
  notes: string | null;
  supersedes_policy_id: number | null;
  created_by: string;
  retired_by: string | null;
  retired_at: Date | null;
  created_at: Date;
}

interface CaseRow {
  id: number;
  case_number: string;
}

interface ItemSnapshotRow {
  wms_return_item_id: number;
  oms_order_line_id: number | null;
  wms_order_item_id: number | null;
  external_line_item_id: string | null;
  sku: string | null;
  title: string | null;
  quantity: number;
  unit_paid_price_cents: number;
  source_line_total_cents: number;
}

function rowsOf<T>(result: any): T[] {
  return Array.isArray(result?.rows) ? result.rows as T[] : [];
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ReturnCaseDomainError("RETURN_CASE_INPUT_INVALID", `${field} must be a positive integer.`, {
      field,
      value,
    });
  }
  return value;
}

function requireSourceEventId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160) {
    throw new ReturnCaseDomainError(
      "RETURN_CASE_INPUT_INVALID",
      "refundExternalId must contain between 1 and 160 characters.",
      { length: normalized.length },
    );
  }
  return normalized;
}

function mapPolicy(row: PolicyRow): ResolvableReturnPolicy {
  return {
    id: Number(row.id),
    name: row.name,
    scopeKind: row.scope_kind,
    scopeKey: row.scope_key,
    businessContext: row.business_context,
    channelId: row.channel_id == null ? null : Number(row.channel_id),
    vendorId: row.vendor_id == null ? null : Number(row.vendor_id),
    storeConnectionId: row.store_connection_id == null ? null : Number(row.store_connection_id),
    version: Number(row.version),
    status: row.status,
    returnWindowDays: Number(row.return_window_days),
    returnDestination: row.return_destination,
    approvalAuthority: row.approval_authority,
    labelProvider: row.label_provider,
    returnShippingPayer: row.return_shipping_payer,
    inspectionRequirement: row.inspection_requirement,
    inspectionOwner: row.inspection_owner,
    customerRefundAuthority: row.customer_refund_authority,
    vendorSettlementTrigger: row.vendor_settlement_trigger,
    returnlessRefundAllowed: row.returnless_refund_allowed,
    notes: row.notes,
    supersedesPolicyId: row.supersedes_policy_id,
    createdBy: row.created_by,
    retiredBy: row.retired_by,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
  };
}

async function findSourceCase(tx: any, sourceEventId: string): Promise<CaseRow | null> {
  const result = await tx.execute(sql`
    SELECT id, case_number
    FROM returns.return_cases
    WHERE source_provider = 'shopify'
      AND source_event_type = 'refund'
      AND source_event_id = ${sourceEventId}
    LIMIT 1
    FOR UPDATE
  `);
  return rowsOf<CaseRow>(result)[0] ?? null;
}

async function loadActivePolicies(tx: any): Promise<ResolvableReturnPolicy[]> {
  const result = await tx.execute(sql`
    SELECT *
    FROM returns.return_policies
    WHERE status = 'active'
    ORDER BY id
  `);
  return rowsOf<PolicyRow>(result).map(mapPolicy);
}

async function loadItemSnapshots(
  tx: any,
  args: { wmsReturnId: number; wmsOrderId: number; omsOrderId: number },
): Promise<ItemSnapshotRow[]> {
  const result = await tx.execute(sql`
    SELECT
      ri.id AS wms_return_item_id,
      ri.oms_order_line_id,
      ri.order_item_id AS wms_order_item_id,
      ri.external_line_item_id,
      COALESCE(ol.sku, oi.sku, ri.sku) AS sku,
      COALESCE(ol.name, ol.title, oi.name) AS title,
      ri.expected_qty::int AS quantity,
      COALESCE(ol.paid_price_cents, oi.paid_price_cents, 0)::bigint AS unit_paid_price_cents,
      COALESCE(ol.total_price_cents, oi.total_price_cents, 0)::bigint AS source_line_total_cents
    FROM wms.return_items ri
    JOIN wms.returns r ON r.id = ri.return_id
    LEFT JOIN wms.order_items oi ON oi.id = ri.order_item_id
    LEFT JOIN oms.oms_order_lines ol ON ol.id = ri.oms_order_line_id
    WHERE ri.return_id = ${args.wmsReturnId}
      AND r.order_id = ${args.wmsOrderId}
      AND (ri.order_item_id IS NULL OR oi.order_id = ${args.wmsOrderId})
+      AND (ri.oms_order_line_id IS NULL OR ol.order_id = ${args.omsOrderId})
    ORDER BY ri.id
  `);
  return rowsOf<ItemSnapshotRow>(result).map((row) => ({
    ...row,
    wms_return_item_id: Number(row.wms_return_item_id),
    oms_order_line_id: row.oms_order_line_id == null ? null : Number(row.oms_order_line_id),
    wms_order_item_id: row.wms_order_item_id == null ? null : Number(row.wms_order_item_id),
    quantity: Number(row.quantity),
    unit_paid_price_cents: Number(row.unit_paid_price_cents),
    source_line_total_cents: Number(row.source_line_total_cents),
  }));
}

export async function recordShopifyRefundReturnCase(
  input: RecordShopifyRefundReturnCaseInput,
): Promise<RecordShopifyRefundReturnCaseResult> {
  const channelId = requirePositiveInteger(input.channelId, "channelId");
  const omsOrderId = requirePositiveInteger(input.omsOrderId, "omsOrderId");
  const wmsOrderId = requirePositiveInteger(input.wmsOrderId, "wmsOrderId");
  const wmsReturnId = requirePositiveInteger(input.wmsReturnId, "wmsReturnId");
  const sourceEventId = requireSourceEventId(input.refundExternalId);
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
    throw new ReturnCaseDomainError("RETURN_CASE_INPUT_INVALID", "now must be a valid Date.");
  }

  const existing = await findSourceCase(input.tx, sourceEventId);
  if (existing) {
    return { caseId: Number(existing.id), caseNumber: existing.case_number, replayed: true };
  }

  const resolution = resolveReturnPolicy(await loadActivePolicies(input.tx), {
    businessContext: "retail",
    channelId,
    vendorId: null,
    storeConnectionId: null,
  });
  if (!resolution) {
    throw new ReturnCaseDomainError(
      "RETURN_CASE_POLICY_NOT_CONFIGURED",
      "No active return policy applies to this Shopify retail return.",
      { channelId, omsOrderId, wmsOrderId, wmsReturnId, sourceEventId },
    );
  }

  const policy = resolution.winner;
  const lifecycle = deriveShopifyRefundReturnLifecycle(policy);
  const policySnapshot = snapshotReturnPolicy(policy);
  const items = await loadItemSnapshots(input.tx, { wmsReturnId, wmsOrderId, omsOrderId });
  if (items.length === 0) {
    throw new ReturnCaseDomainError(
      "RETURN_CASE_ITEMS_MISSING",
      "The WMS return has no item rows that can be snapshotted into a Return Case.",
      { omsOrderId, wmsOrderId, wmsReturnId, sourceEventId },
    );
  }
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new ReturnCaseDomainError("RETURN_CASE_ITEM_INVALID", "Return Case item quantity must be positive.", {
        wmsReturnItemId: item.wms_return_item_id,
        quantity: item.quantity,
      });
    }
    if (!Number.isSafeInteger(item.unit_paid_price_cents) || item.unit_paid_price_cents < 0
      || !Number.isSafeInteger(item.source_line_total_cents) || item.source_line_total_cents < 0) {
      throw new ReturnCaseDomainError("RETURN_CASE_ITEM_MONEY_INVALID", "Return Case item money must be non-negative safe integers.", {
        wmsReturnItemId: item.wms_return_item_id,
      });
    }
  }

  const inserted = await input.tx.execute(sql`
    INSERT INTO returns.return_cases (
      source_provider, source_event_type, source_event_id, business_context,
      channel_id, vendor_id, store_connection_id, oms_order_id, wms_order_id,
      wms_return_id, policy_id, policy_version, policy_snapshot, case_status,
      approval_status, logistics_status, inspection_status,
      customer_refund_status, vendor_settlement_status, opened_at, created_at, updated_at
    ) VALUES (
      'shopify', 'refund', ${sourceEventId}, 'retail',
      ${channelId}, NULL, NULL, ${omsOrderId}, ${wmsOrderId},
      ${wmsReturnId}, ${policy.id}, ${policy.version}, ${JSON.stringify(policySnapshot)}::jsonb,
      ${lifecycle.caseStatus}, ${lifecycle.approvalStatus}, ${lifecycle.logisticsStatus},
      ${lifecycle.inspectionStatus}, ${lifecycle.customerRefundStatus},
      ${lifecycle.vendorSettlementStatus}, ${input.now}, ${input.now}, ${input.now}
    )
    ON CONFLICT (source_provider, source_event_type, source_event_id) DO NOTHING
    RETURNING id, case_number
  `);
  const returnCase = rowsOf<CaseRow>(inserted)[0] ?? null;
  if (!returnCase) {
    const concurrentCase = await findSourceCase(input.tx, sourceEventId);
    if (!concurrentCase) {
      throw new ReturnCaseDomainError(
        "RETURN_CASE_IDEMPOTENCY_CONFLICT",
        "A Return Case conflict occurred but the source event could not be resolved.",
        { sourceEventId, wmsReturnId },
      );
    }
    return { caseId: Number(concurrentCase.id), caseNumber: concurrentCase.case_number, replayed: true };
  }

  for (const item of items) {
    await input.tx.execute(sql`
      INSERT INTO returns.return_case_items (
        return_case_id, wms_return_item_id, oms_order_line_id, wms_order_item_id,
        external_line_item_id, sku, title, quantity, unit_paid_price_cents,
        source_line_total_cents, created_at
      ) VALUES (
        ${Number(returnCase.id)}, ${item.wms_return_item_id}, ${item.oms_order_line_id},
        ${item.wms_order_item_id}, ${item.external_line_item_id}, ${item.sku}, ${item.title},
        ${item.quantity}, ${item.unit_paid_price_cents}, ${item.source_line_total_cents}, ${input.now}
      )
    `);
  }

  const eventDetails = {
    sourceProvider: "shopify",
    sourceEventType: "refund",
    sourceEventId,
    channelId,
    omsOrderId,
    wmsOrderId,
    wmsReturnId,
    policyId: policy.id,
    policyVersion: policy.version,
    itemCount: items.length,
  };
  await input.tx.execute(sql`
    INSERT INTO returns.return_case_events (
      return_case_id, event_type, actor, details, occurred_at, created_at
    ) VALUES (
      ${Number(returnCase.id)}, 'shopify_refund_return_case_opened',
      'system:shopify_refund', ${JSON.stringify(eventDetails)}::jsonb,
      ${input.now}, ${input.now}
    )
  `);

  return { caseId: Number(returnCase.id), caseNumber: returnCase.case_number, replayed: false };
}
