import { sql } from "drizzle-orm";

import { getFlowBucketSamples, getFlowWaterfall } from "../oms/flow-waterfall.service";
import { getOmsOpsHealth, type OmsOpsIssue } from "../oms/ops-health.service";
import { remediateOmsFlowIssue } from "../oms/oms-flow-reconciliation.service";
import { loadProcurementHealthSummary } from "../procurement/procurement-health-summary.service";

export const CONTROL_TOWER_DOMAINS = [
  "oms",
  "wms",
  "shipping",
  "inventory",
  "procurement",
] as const;

export type ControlTowerDomain = (typeof CONTROL_TOWER_DOMAINS)[number];
export type ControlTowerSeverity = "critical" | "warning" | "info";
export type ControlTowerStatus = "open" | "in_progress" | "blocked" | "resolved";

export interface ControlTowerAction {
  id: string;
  label: string;
  kind: "navigate" | "execute";
  href?: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  unavailableReason?: string;
}

export interface ControlTowerWorkItem {
  id: string;
  domain: ControlTowerDomain;
  code: string;
  severity: ControlTowerSeverity;
  status: ControlTowerStatus;
  title: string;
  summary: string;
  detail: string | null;
  count: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  ageMinutes: number | null;
  source: string;
  affected: {
    orderNumber?: string | null;
    omsOrderId?: number | null;
    wmsOrderId?: number | null;
    shipmentId?: number | null;
    sku?: string | null;
    poId?: number | null;
    href?: string | null;
  };
  evidence: Record<string, unknown>;
  actions: ControlTowerAction[];
}

export interface ControlTowerSourceStatus {
  domain: ControlTowerDomain;
  status: "ok" | "degraded" | "unavailable";
  itemCount: number;
  error: string | null;
}

export interface ControlTowerFilters {
  domain: ControlTowerDomain | "all";
  severity: ControlTowerSeverity | "all";
  status: ControlTowerStatus | "all";
  search: string;
  limit: number;
}

export interface ControlTowerSummary {
  open: number;
  critical: number;
  warning: number;
  info: number;
  byDomain: Record<ControlTowerDomain, number>;
  byCode: Array<{ code: string; domain: ControlTowerDomain; count: number }>;
}

export interface ControlTowerResponse {
  generatedAt: string;
  status: "healthy" | "degraded" | "critical";
  overview: {
    funnel: { sourceObserved: number; entered: number; reachedWms: number; hasShipment: number; shipped: number; trackingConfirmed: number };
    wmsBuckets: Array<{ status: string; count: number }>;
    deadLetterCauses: Array<{ code: string; cause: string; count: number }>;
    crossSystem: { wmsShippedOmsOpen: number; omsNotUpdated: number };
    sla: { breached: number };
  } | null;
  filters: ControlTowerFilters;
  summary: ControlTowerSummary;
  sources: ControlTowerSourceStatus[];
  workItems: ControlTowerWorkItem[];
}

export interface ControlTowerDetail extends ControlTowerWorkItem {
  records: unknown[];
}

interface DrizzleDb {
  execute: (query: any) => any;
}

interface OperationsDashboard {
  getPickReplenHealth: (params: {
    filter: string;
    page: number;
    pageSize: number;
    search?: string;
  }) => Promise<{
    items: any[];
    total: number;
  }>;
  getActionQueue?: (params: {
    filter: "all";
    page: number;
    pageSize: number;
  }) => Promise<{ items: any[]; total: number }>;
}

interface ReplenishmentService {
  queueMissingPickBinReplen: (params: {
    mode: "queue_replen";
    variantId: number;
    locationId: number;
    limit: number;
  }) => Promise<unknown>;
  cleanupHealthIssues: (params: {
    mode: "stale_no_demand" | "duplicates" | "inline_execution";
    taskId?: number | null;
    limit?: number;
    userId?: string;
  }) => Promise<unknown>;
}

export interface ControlTowerDependencies {
  db: DrizzleDb;
  operationsDashboard?: OperationsDashboard;
  replenishment?: ReplenishmentService;
  shipmentTracking?: any;
  canViewProcurement?: boolean;
}

interface SourceLoadResult {
  items: ControlTowerWorkItem[];
  recordsByItemId?: Map<string, unknown[]>;
  overview?: ControlTowerResponse["overview"];
}

const OMS_REMEDIABLE_CODES = new Set([
  "OMS_PAID_WITHOUT_WMS",
  "WMS_READY_WITHOUT_SHIPMENT",
  "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION",
  "OMS_FINAL_WMS_ACTIVE",
  "WMS_FINAL_OMS_OPEN",
  "SHIPMENT_SHIPPED_OMS_OPEN",
  "SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED",
  "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
  "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED",
]);

function rows(result: { rows?: any[] } | null | undefined): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function positiveInt(value: unknown, field: string): number {
  const parsed = intOrNull(value);
  if (parsed === null || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

function asIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ageMinutes(value: unknown): number | null {
  const iso = asIso(value);
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
}

function severityFromPriority(priority: unknown): ControlTowerSeverity {
  const value = Number(priority);
  if (value <= 1) return "critical";
  if (value === 2) return "warning";
  return "info";
}

function statusForSeverity(severity: ControlTowerSeverity): ControlTowerStatus {
  return severity === "critical" ? "blocked" : "open";
}

function makeNavigateAction(
  id: string,
  label: string,
  href: string,
): ControlTowerAction {
  return {
    id,
    label,
    kind: "navigate",
    href,
    enabled: true,
    requiresConfirmation: false,
  };
}

function makeExecuteAction(
  id: string,
  label: string,
  enabled: boolean,
  unavailableReason?: string,
): ControlTowerAction {
  return {
    id,
    label,
    kind: "execute",
    enabled,
    requiresConfirmation: true,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

function omsAffected(sample: any): ControlTowerWorkItem["affected"] {
  const omsOrderId = intOrNull(sample?.oms_order_id ?? sample?.id ?? sample?.order_id);
  const wmsOrderId = intOrNull(sample?.wms_order_id ?? sample?.wms_id);
  const shipmentId = intOrNull(sample?.shipment_id ?? sample?.outbound_shipment_id);
  const orderNumber = sample?.order_number ?? sample?.external_order_number ?? null;
  return {
    omsOrderId,
    wmsOrderId,
    shipmentId,
    orderNumber: orderNumber == null ? null : String(orderNumber),
    href: orderNumber ? `/oms/orders?search=${encodeURIComponent(String(orderNumber))}` : null,
  };
}

function omsRemediationInput(code: string, sample: any, operator: string) {
  const affected = omsAffected(sample);
  if (!OMS_REMEDIABLE_CODES.has(code)) {
    throw new Error(`Unsupported OMS remediation code: ${code}`);
  }

  const input: {
    code: string;
    operator: string;
    omsOrderId?: number;
    wmsOrderId?: number;
    shipmentId?: number;
  } = { code, operator };

  if (code === "OMS_PAID_WITHOUT_WMS" || code === "WMS_FINAL_OMS_OPEN" || code === "SHIPMENT_SHIPPED_OMS_OPEN") {
    input.omsOrderId = positiveInt(affected.omsOrderId, "omsOrderId");
  }
  if (code === "WMS_READY_WITHOUT_SHIPMENT" || code === "OMS_FINAL_WMS_ACTIVE" || code === "WMS_FINAL_OMS_OPEN") {
    input.wmsOrderId = positiveInt(affected.wmsOrderId, "wmsOrderId");
  }
  if (
    code === "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION" ||
    code === "SHIPMENT_SHIPPED_OMS_OPEN" ||
    code === "SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED" ||
    code === "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED" ||
    code === "SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED"
  ) {
    input.shipmentId = positiveInt(affected.shipmentId, "shipmentId");
  }
  return input;
}

function wmsHref(item: any): string {
  if (item.orderNumber) return `/orders?search=${encodeURIComponent(String(item.orderNumber))}`;
  if (item.sku) return `/inventory?search=${encodeURIComponent(String(item.sku))}`;
  return "/replenishment";
}

function wmsActions(item: any, replenishmentAvailable: boolean): ControlTowerAction[] {
  const actions: ControlTowerAction[] = [makeNavigateAction("open", "Open WMS record", wmsHref(item))];
  const action = String(item.action ?? "");
  if (action === "queue_replen") {
    const enabled = replenishmentAvailable && intOrNull(item.variantId) !== null && intOrNull(item.locationId) !== null;
    actions.push(makeExecuteAction(
      "execute",
      "Queue replenishment",
      enabled,
      enabled ? undefined : "The replenishment service or required location identifiers are unavailable.",
    ));
  } else if (action === "cancel_no_demand") {
    actions.push(makeExecuteAction("execute", "Cancel stale task", replenishmentAvailable && intOrNull(item.taskId) !== null));
  } else if (action === "cancel_duplicate") {
    actions.push(makeExecuteAction("execute", "Cancel duplicate task", replenishmentAvailable && intOrNull(item.taskId) !== null));
  } else if (action === "auto_execute_replen") {
    actions.push(makeExecuteAction("execute", "Run inline replenishment", replenishmentAvailable && intOrNull(item.taskId) !== null));
  }
  return actions;
}

async function loadOms(deps: ControlTowerDependencies, includeOverview = true): Promise<SourceLoadResult> {
  const health = await getOmsOpsHealth(deps.db);
  let waterfall: Awaited<ReturnType<typeof getFlowWaterfall>> | null = null;
  let waterfallError: string | null = null;
  if (includeOverview) {
    try {
      waterfall = await getFlowWaterfall(deps.db, { windowDays: 30 });
    } catch (error) {
      waterfallError = error instanceof Error ? error.message : String(error);
      console.error("[Operations Control Tower] OMS waterfall snapshot failed:", error);
    }
  }
  const items = health.issues
    .filter((issue) => issue.count > 0)
    .map((issue: OmsOpsIssue): ControlTowerWorkItem => {
      const firstSample = issue.sample[0] ?? {};
      const affected = omsAffected(firstSample);
      const actions: ControlTowerAction[] = [
        makeNavigateAction("open", "Open OMS details", "/oms/flow-monitor"),
      ];
      if (OMS_REMEDIABLE_CODES.has(issue.code)) {
        actions.push(makeExecuteAction("remediate", "Run safe remediation", true));
      }
      if (affected.orderNumber) {
        actions.push(makeNavigateAction("trace", "Open OMS order", `/oms/orders?search=${encodeURIComponent(affected.orderNumber)}`));
      }
      return {
        id: `oms:issue:${issue.code}`,
        domain: "oms",
        code: issue.code,
        severity: issue.severity,
        status: statusForSeverity(issue.severity),
        title: issue.code.replace(/_/g, " "),
        summary: issue.message,
        detail: issue.message,
        count: issue.count,
        firstSeenAt: null,
        lastSeenAt: asIso(health.generatedAt),
        ageMinutes: null,
        source: "oms.ops.health",
        affected,
        evidence: { issue, workers: health.workers, channelWriteback: health.channelWriteback },
        actions,
      };
    });
  const recordsByItemId = new Map<string, unknown[]>();
  for (const item of items) recordsByItemId.set(item.id, (health.issues.find((issue) => `oms:issue:${issue.code}` === item.id)?.sample ?? []));
  if (waterfallError) {
    const item: ControlTowerWorkItem = {
      id: "oms:monitor:flow-waterfall",
      domain: "oms",
      code: "OMS_FLOW_WATERFALL_UNAVAILABLE",
      severity: "critical",
      status: "blocked",
      title: "OMS flow monitor unavailable",
      summary: "The OMS health source loaded, but the waterfall snapshot could not be read.",
      detail: waterfallError,
      count: 1,
      firstSeenAt: null,
      lastSeenAt: new Date().toISOString(),
      ageMinutes: null,
      source: "oms.flow-waterfall",
      affected: { href: "/oms/flow-monitor" },
      evidence: { error: waterfallError },
      actions: [makeNavigateAction("open", "Open OMS monitor", "/oms/flow-monitor")],
    };
    items.push(item);
    recordsByItemId.set(item.id, [{ error: waterfallError }]);
  }
  return {
    items,
    recordsByItemId,
    overview: waterfall ? {
      funnel: waterfall.funnel,
      wmsBuckets: waterfall.wmsBuckets,
      deadLetterCauses: waterfall.deadLetterCauses,
      crossSystem: {
        wmsShippedOmsOpen: waterfall.crossSystem.wmsShippedOmsOpen,
        omsNotUpdated: waterfall.crossSystem.omsNotUpdated,
      },
      sla: { breached: waterfall.sla.breached },
    } : null,
  };
}

async function loadWms(deps: ControlTowerDependencies, limit: number): Promise<SourceLoadResult> {
  if (!deps.operationsDashboard) return { items: [] };
  const result = await deps.operationsDashboard.getPickReplenHealth({ filter: "all", page: 1, pageSize: Math.min(250, limit) });
  const items = (result.items ?? []).map((item: any): ControlTowerWorkItem => {
    const severity = severityFromPriority(item.priority);
    return {
      id: `wms:${item.type}:${item.id}`,
      domain: "wms",
      code: `WMS_${String(item.type).toUpperCase()}`,
      severity,
      status: statusForSeverity(severity),
      title: String(item.type).replace(/_/g, " "),
      summary: item.detail || "WMS health item requires attention",
      detail: item.detail || null,
      count: 1,
      firstSeenAt: asIso(item.createdAt),
      lastSeenAt: asIso(item.createdAt),
      ageMinutes: item.ageHours == null ? ageMinutes(item.createdAt) : Number(item.ageHours) * 60,
      source: "wms.operations.pick-replen-health",
      affected: {
        orderNumber: item.orderNumber,
        wmsOrderId: intOrNull(item.orderId),
        sku: item.sku,
        href: wmsHref(item),
      },
      evidence: { item },
      actions: wmsActions(item, Boolean(deps.replenishment)),
    };
  });
  const recordsByItemId = new Map<string, unknown[]>();
  for (const item of items) recordsByItemId.set(item.id, [item.evidence.item]);
  return { items, recordsByItemId };
}

async function loadShipping(deps: ControlTowerDependencies, limit: number): Promise<SourceLoadResult> {
  const [legacyResult, writebackResult] = await Promise.all([
    deps.db.execute(sql`
      SELECT
        os.id AS shipment_id,
        os.order_id AS wms_order_id,
        o.order_number,
        os.status::text AS shipment_status,
        os.shipping_engine,
        os.engine_order_ref,
        os.engine_shipment_ref,
        os.shipstation_order_id,
        os.tracking_number,
        os.carrier,
        os.requires_review,
        os.review_reason,
        os.held,
        os.on_hold_reason,
        os.created_at,
        os.updated_at,
        CASE
          WHEN os.requires_review THEN 'SHIPMENT_REQUIRES_REVIEW'
          WHEN os.held THEN 'SHIPMENT_ON_HOLD'
          ELSE 'SHIPMENT_NOT_PUSHED_TO_ENGINE'
        END AS issue_code
      FROM wms.outbound_shipments os
      LEFT JOIN wms.orders o ON o.id = os.order_id
      WHERE os.voided_at IS NULL
        AND COALESCE(o.warehouse_status, '') NOT IN ('cancelled', 'shipped')
        AND (
          os.requires_review = true
          OR (os.held = true AND COALESCE(os.source, '') <> 'line_item_hold')
          OR (
            os.status IN ('planned', 'queued', 'labeled')
            AND NULLIF(BTRIM(os.engine_order_ref), '') IS NULL
            AND os.created_at < NOW() - INTERVAL '15 minutes'
          )
        )
      ORDER BY
        CASE WHEN os.requires_review THEN 1 WHEN os.held THEN 2 ELSE 3 END,
        os.created_at ASC,
        os.id ASC
      LIMIT ${limit}
    `),
    deps.db.execute(sql`
      SELECT
        cfp.id AS push_id,
        cfp.oms_order_id,
        cfp.physical_shipment_id,
        cfp.channel_provider,
        cfp.channel_fulfillment_id,
        cfp.push_status,
        cfp.attempt_count,
        cfp.last_error,
        cfp.created_at,
        cfp.updated_at,
        ps.provider_physical_shipment_id,
        ps.tracking_number,
        ps.carrier,
        sr.wms_order_id,
        sr.legacy_wms_shipment_id AS shipment_id,
        wo.order_number,
        CASE
          WHEN cfp.push_status IN ('failed', 'review') THEN 'CHANNEL_FULFILLMENT_WRITEBACK_FAILED'
          ELSE 'CHANNEL_FULFILLMENT_WRITEBACK_PENDING'
        END AS issue_code
      FROM oms.channel_fulfillment_pushes cfp
      JOIN wms.physical_shipments ps ON ps.id = cfp.physical_shipment_id
      JOIN wms.shipment_requests sr ON sr.id = ps.shipment_request_id
      JOIN wms.orders wo ON wo.id = sr.wms_order_id
      WHERE cfp.push_status IN ('pending', 'failed', 'review')
        AND ps.status = 'shipped'
      ORDER BY
        CASE WHEN cfp.push_status IN ('failed', 'review') THEN 1 ELSE 2 END,
        cfp.updated_at ASC,
        cfp.id ASC
      LIMIT ${limit}
    `),
  ]);

  const items: ControlTowerWorkItem[] = [];
  const recordsByItemId = new Map<string, unknown[]>();
  for (const row of rows(legacyResult)) {
    const code = String(row.issue_code);
    const severity: ControlTowerSeverity = row.requires_review ? "critical" : row.held ? "warning" : "critical";
    const shipmentId = intOrNull(row.shipment_id);
    const wmsOrderId = intOrNull(row.wms_order_id);
    const omsOrderId = null;
    const affected = {
      orderNumber: row.order_number == null ? null : String(row.order_number),
      wmsOrderId,
      shipmentId,
      href: row.order_number ? `/orders?search=${encodeURIComponent(String(row.order_number))}` : "/outbound-shipments",
    };
    const item: ControlTowerWorkItem = {
      id: `shipping:legacy:${shipmentId}`,
      domain: "shipping",
      code,
      severity,
      status: statusForSeverity(severity),
      title: code.replace(/_/g, " "),
      summary: row.review_reason || row.on_hold_reason || "Shipment has not reached a stable shipping-engine state.",
      detail: row.review_reason || row.on_hold_reason || null,
      count: 1,
      firstSeenAt: asIso(row.created_at),
      lastSeenAt: asIso(row.updated_at),
      ageMinutes: ageMinutes(row.created_at),
      source: "wms.outbound_shipments",
      affected,
      evidence: { row },
      actions: [
        makeNavigateAction("open", "Open shipment", affected.href),
        ...(code === "SHIPMENT_NOT_PUSHED_TO_ENGINE" && shipmentId
          ? [makeExecuteAction(
              "retry_push",
              "Retry engine push",
              !row.shipping_engine || String(row.shipping_engine).toLowerCase() === "shipstation",
              !row.shipping_engine || String(row.shipping_engine).toLowerCase() === "shipstation"
                ? undefined
                : `No safe retry delegate is registered for shipping engine ${row.shipping_engine}.`,
            )]
          : []),
      ],
    };
    items.push(item);
    recordsByItemId.set(item.id, [row]);
  }

  for (const row of rows(writebackResult)) {
    const pushId = intOrNull(row.push_id);
    const shipmentId = intOrNull(row.shipment_id);
    const wmsOrderId = intOrNull(row.wms_order_id);
    const omsOrderId = intOrNull(row.oms_order_id);
    const code = String(row.issue_code);
    const failed = row.push_status !== "pending";
    const affected = {
      orderNumber: row.order_number == null ? null : String(row.order_number),
      omsOrderId,
      wmsOrderId,
      shipmentId,
      href: row.order_number ? `/orders?search=${encodeURIComponent(String(row.order_number))}` : "/outbound-shipments",
    };
    const item: ControlTowerWorkItem = {
      id: `shipping:writeback:${pushId}`,
      domain: "shipping",
      code,
      severity: failed ? "critical" : "warning",
      status: failed ? "blocked" : "open",
      title: `${String(row.channel_provider).toUpperCase()} tracking writeback ${failed ? "failed" : "pending"}`,
      summary: row.last_error || `Tracking has not been confirmed in ${row.channel_provider}.`,
      detail: row.last_error || null,
      count: 1,
      firstSeenAt: asIso(row.created_at),
      lastSeenAt: asIso(row.updated_at),
      ageMinutes: ageMinutes(row.updated_at ?? row.created_at),
      source: "oms.channel_fulfillment_pushes",
      affected,
      evidence: { row },
      actions: [
        makeNavigateAction("open", "Open order", affected.href),
        ...(shipmentId && omsOrderId && ["shopify", "ebay"].includes(String(row.channel_provider).toLowerCase())
          ? [makeExecuteAction("retry_writeback", "Retry channel writeback", true)]
          : [makeExecuteAction("retry_writeback", "Retry channel writeback", false, "This row is not linked to a supported channel writeback delegate yet.")]),
      ],
    };
    items.push(item);
    recordsByItemId.set(item.id, [row]);
  }
  return { items, recordsByItemId };
}

async function loadInventory(deps: ControlTowerDependencies, limit: number): Promise<SourceLoadResult> {
  const result = await deps.db.execute(sql`
    SELECT
      il.id AS inventory_level_id,
      il.product_variant_id AS variant_id,
      pv.sku,
      pv.name,
      il.warehouse_location_id AS location_id,
      wl.code AS location_code,
      wl.warehouse_id,
      il.variant_qty,
      il.reserved_qty,
      il.picked_qty,
      il.packed_qty,
      il.updated_at,
      CASE
        WHEN il.variant_qty < 0 THEN 'NEGATIVE_ON_HAND'
        WHEN il.reserved_qty > il.variant_qty THEN 'RESERVED_EXCEEDS_ON_HAND'
        WHEN il.picked_qty > il.variant_qty THEN 'PICKED_EXCEEDS_ON_HAND'
        ELSE 'INVENTORY_COUNTER_DRIFT'
      END AS issue_code
    FROM inventory.inventory_levels il
    JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
    JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
    WHERE il.variant_qty < 0
       OR il.reserved_qty > il.variant_qty
       OR il.picked_qty > il.variant_qty
    ORDER BY il.updated_at ASC, il.id ASC
    LIMIT ${limit}
  `);

  const items: ControlTowerWorkItem[] = [];
  const recordsByItemId = new Map<string, unknown[]>();
  for (const row of rows(result)) {
    const code = String(row.issue_code);
    const item: ControlTowerWorkItem = {
      id: `inventory:level:${row.inventory_level_id}`,
      domain: "inventory",
      code,
      severity: "critical",
      status: "blocked",
      title: code.replace(/_/g, " "),
      summary: `${row.sku} at ${row.location_code} has inconsistent inventory counters.`,
      detail: "No automatic adjustment is offered here. The operator must inspect the ledger and correct the source transaction or perform an audited inventory action.",
      count: 1,
      firstSeenAt: asIso(row.updated_at),
      lastSeenAt: asIso(row.updated_at),
      ageMinutes: ageMinutes(row.updated_at),
      source: "inventory.inventory_levels",
      affected: {
        sku: row.sku,
        href: `/inventory?search=${encodeURIComponent(String(row.sku))}`,
      },
      evidence: { row },
      actions: [makeNavigateAction("open", "Open inventory", `/inventory?search=${encodeURIComponent(String(row.sku))}`)],
    };
    items.push(item);
    recordsByItemId.set(item.id, [row]);
  }

  if (deps.operationsDashboard?.getActionQueue) {
    const actionQueue = await deps.operationsDashboard.getActionQueue({ filter: "all", page: 1, pageSize: Math.min(100, limit) });
    for (const row of actionQueue.items ?? []) {
      // Negative inventory is already represented by the counter-integrity
      // query above; do not create two work items for the same level.
      if (row.type === "negative_inventory") continue;
      const severity = severityFromPriority(row.priority);
      const item: ControlTowerWorkItem = {
        id: `inventory:action:${row.type}-${row.id ?? row.sourceId}`,
        domain: "inventory",
        code: `INVENTORY_${String(row.type).toUpperCase()}`,
        severity,
        status: statusForSeverity(severity),
        title: String(row.type).replace(/_/g, " "),
        summary: row.detail || `${row.sku || "Inventory"} requires an operational action.`,
        detail: row.detail || null,
        count: 1,
        firstSeenAt: null,
        lastSeenAt: null,
        ageMinutes: row.hoursAging != null ? Number(row.hoursAging) * 60 : row.daysSinceMovement != null ? Number(row.daysSinceMovement) * 24 * 60 : null,
        source: "wms.operations.action-queue",
        affected: {
          sku: row.sku || null,
          href: row.sku ? `/inventory?search=${encodeURIComponent(String(row.sku))}` : "/replenishment",
        },
        evidence: { item: row },
        actions: [makeNavigateAction("open", "Open inventory operations", row.sku ? `/inventory?search=${encodeURIComponent(String(row.sku))}` : "/replenishment")],
      };
      items.push(item);
      recordsByItemId.set(item.id, [row]);
    }
  }
  return { items, recordsByItemId };
}

async function loadProcurement(deps: ControlTowerDependencies): Promise<SourceLoadResult> {
  if (!deps.canViewProcurement || !deps.shipmentTracking) return { items: [] };
  const summary = await loadProcurementHealthSummary({ shipmentTracking: deps.shipmentTracking, limit: 100 });
  const items: ControlTowerWorkItem[] = [];
  const recordsByItemId = new Map<string, unknown[]>();
  for (const source of summary.sources) {
    if (source.status === "healthy") continue;
    const severity: ControlTowerSeverity = source.status === "critical" ? "critical" : "warning";
    const item: ControlTowerWorkItem = {
      id: `procurement:health:${source.key}`,
      domain: "procurement",
      code: `PROCUREMENT_${source.key.toUpperCase()}`,
      severity,
      status: severity === "critical" ? "blocked" : "open",
      title: source.label,
      summary: source.detail,
      detail: source.detail,
      count: source.total,
      firstSeenAt: null,
      lastSeenAt: asIso(summary.generatedAt),
      ageMinutes: null,
      source: "procurement.health",
      affected: { href: source.href },
      evidence: { source, generatedAt: summary.generatedAt },
      actions: [makeNavigateAction(source.actionLabel, source.actionLabel, source.href)],
    };
    items.push(item);
    recordsByItemId.set(item.id, [source]);
  }
  return { items, recordsByItemId };
}

function compareWorkItems(a: ControlTowerWorkItem, b: ControlTowerWorkItem): number {
  const severityRank: Record<ControlTowerSeverity, number> = { critical: 0, warning: 1, info: 2 };
  const severityDelta = severityRank[a.severity] - severityRank[b.severity];
  if (severityDelta !== 0) return severityDelta;
  const ageA = a.ageMinutes ?? -1;
  const ageB = b.ageMinutes ?? -1;
  if (ageA !== ageB) return ageB - ageA;
  return a.id.localeCompare(b.id);
}

function sourceStatus(domain: ControlTowerDomain, result: SourceLoadResult | null, error: unknown): ControlTowerSourceStatus {
  return {
    domain,
    status: error ? "degraded" : "ok",
    itemCount: result?.items.length ?? 0,
    error: error instanceof Error ? error.message : error ? String(error) : null,
  };
}

export function parseControlTowerFilters(input: {
  domain?: unknown;
  severity?: unknown;
  status?: unknown;
  search?: unknown;
  limit?: unknown;
}): ControlTowerFilters {
  const domain = CONTROL_TOWER_DOMAINS.includes(String(input.domain ?? "") as ControlTowerDomain)
    ? String(input.domain) as ControlTowerDomain
    : "all";
  const severity = ["critical", "warning", "info"].includes(String(input.severity ?? ""))
    ? String(input.severity) as ControlTowerSeverity
    : "all";
  const status = ["open", "in_progress", "blocked", "resolved"].includes(String(input.status ?? ""))
    ? String(input.status) as ControlTowerStatus
    : "all";
  const parsedLimit = Number(input.limit);
  return {
    domain,
    severity,
    status,
    search: String(input.search ?? "").trim().slice(0, 120),
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(250, parsedLimit) : 100,
  };
}

export async function getOperationsControlTower(
  deps: ControlTowerDependencies,
  filters: ControlTowerFilters,
  options: { onlyDomain?: ControlTowerDomain; includeOverview?: boolean } = {},
): Promise<ControlTowerResponse> {
  const allLoaders: Array<{ domain: ControlTowerDomain; load: () => Promise<SourceLoadResult> }> = [
    { domain: "oms", load: () => loadOms(deps, options.includeOverview !== false) },
    { domain: "wms", load: () => loadWms(deps, filters.limit) },
    { domain: "shipping", load: () => loadShipping(deps, filters.limit) },
    { domain: "inventory", load: () => loadInventory(deps, filters.limit) },
    { domain: "procurement", load: () => loadProcurement(deps) },
  ];
  const loaders = options.onlyDomain
    ? allLoaders.filter((entry) => entry.domain === options.onlyDomain)
    : allLoaders;

  const loaded: Array<typeof loaders[number] & { result: SourceLoadResult; error: unknown }> = [];
  // Existing domain sources already bound their own query batches. Keep the
  // tower fan-out bounded as well, while avoiding a five-source serial wait.
  const loadOne = async (entry: typeof loaders[number]) => {
    try {
      const result = await entry.load();
      return { ...entry, result, error: null };
    } catch (error) {
      return { ...entry, result: { items: [] }, error };
    }
  };
  for (let index = 0; index < loaders.length; index += 2) {
    loaded.push(...await Promise.all(loaders.slice(index, index + 2).map(loadOne)));
  }

  const allItems = loaded.flatMap((entry) => entry.result.items);
  const filtered = allItems
    .filter((item) => filters.domain === "all" || item.domain === filters.domain)
    .filter((item) => filters.severity === "all" || item.severity === filters.severity)
    .filter((item) => filters.status === "all" || item.status === filters.status)
    .filter((item) => {
      if (!filters.search) return true;
      const haystack = JSON.stringify({
        id: item.id,
        code: item.code,
        title: item.title,
        summary: item.summary,
        affected: item.affected,
      }).toLowerCase();
      return haystack.includes(filters.search.toLowerCase());
    })
    .sort(compareWorkItems)
    .slice(0, filters.limit);

  const byDomain = Object.fromEntries(CONTROL_TOWER_DOMAINS.map((domain) => [
    domain,
    allItems.filter((item) => item.domain === domain).reduce((sum, item) => sum + item.count, 0),
  ])) as Record<ControlTowerDomain, number>;
  const byCode = [...new Map(allItems.map((item) => [`${item.domain}:${item.code}`, item])).values()]
    .map((item) => ({
      domain: item.domain,
      code: item.code,
      count: allItems.filter((candidate) => candidate.domain === item.domain && candidate.code === item.code)
        .reduce((sum, candidate) => sum + candidate.count, 0),
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const summary: ControlTowerSummary = {
    open: allItems.reduce((sum, item) => sum + item.count, 0),
    critical: allItems.filter((item) => item.severity === "critical").reduce((sum, item) => sum + item.count, 0),
    warning: allItems.filter((item) => item.severity === "warning").reduce((sum, item) => sum + item.count, 0),
    info: allItems.filter((item) => item.severity === "info").reduce((sum, item) => sum + item.count, 0),
    byDomain,
    byCode,
  };
  const sources = loaded.map((entry) => sourceStatus(entry.domain, entry.result, entry.error));
  const hasSourceError = sources.some((source) => source.status !== "ok");
  const overview = loaded.find((entry) => entry.result.overview)?.result.overview ?? null;
  return {
    generatedAt: new Date().toISOString(),
    status: summary.critical > 0 || hasSourceError ? "critical" : summary.warning > 0 ? "degraded" : "healthy",
    overview,
    filters,
    summary,
    sources,
    workItems: filtered,
  };
}

export async function getOperationsControlTowerDetail(
  deps: ControlTowerDependencies,
  id: string,
): Promise<ControlTowerDetail | null> {
  const domain = CONTROL_TOWER_DOMAINS.find((candidate) => id.startsWith(`${candidate}:`));
  const response = await getOperationsControlTower(
    deps,
    parseControlTowerFilters({ limit: 250 }),
    {
      onlyDomain: domain,
      includeOverview: id === "oms:monitor:flow-waterfall",
    },
  );
  const item = response.workItems.find((candidate) => candidate.id === id);
  if (!item) return null;

  let records: unknown[] = [];
  if (item.domain === "oms") {
    const bucket = await getFlowBucketSamples(deps.db, item.code, { windowDays: 365 });
    records = Array.isArray((bucket as any)?.rows) ? (bucket as any).rows : [];
  } else if (item.domain === "wms" || item.domain === "shipping" || item.domain === "inventory" || item.domain === "procurement") {
    records = Array.isArray(item.evidence.item) ? item.evidence.item : [item.evidence.item ?? item.evidence.row ?? item.evidence.source];
  }
  return { ...item, records };
}

export async function executeOperationsControlTowerAction(input: {
  deps: ControlTowerDependencies;
  id: string;
  actionId: string;
  record?: any;
  operator: string;
  detail?: ControlTowerDetail;
}): Promise<unknown> {
  const detail = input.detail ?? await getOperationsControlTowerDetail(input.deps, input.id);
  if (!detail) throw new Error("Control Tower work item not found or already resolved");
  const action = detail.actions.find((candidate) => candidate.id === input.actionId);
  if (!action) throw new Error(`Action ${input.actionId} is not available for this work item`);
  if (!action.enabled || action.kind !== "execute") throw new Error(action.unavailableReason || "Action is not executable");

  if (detail.domain === "oms" && input.actionId === "remediate") {
    if (!input.record || typeof input.record !== "object") throw new Error("A concrete affected OMS record is required");
    return remediateOmsFlowIssue(input.deps.db, {
      ...omsRemediationInput(detail.code, input.record, input.operator),
    });
  }

  if (detail.domain === "shipping" && input.actionId === "retry_push") {
    const row = detail.evidence.row as any;
    return remediateOmsFlowIssue(input.deps.db, {
      code: "SHIPMENT_NOT_PUSHED_TO_SHIPSTATION",
      shipmentId: positiveInt(row?.shipment_id, "shipmentId"),
      operator: input.operator,
    });
  }

  if (detail.domain === "shipping" && input.actionId === "retry_writeback") {
    const row = detail.evidence.row as any;
    const code = String(row?.channel_provider || "").toLowerCase() === "shopify"
      ? "SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED"
      : "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED";
    return remediateOmsFlowIssue(input.deps.db, {
      code,
      omsOrderId: positiveInt(row?.oms_order_id, "omsOrderId"),
      wmsOrderId: row?.wms_order_id == null ? undefined : positiveInt(row.wms_order_id, "wmsOrderId"),
      shipmentId: positiveInt(row?.shipment_id, "shipmentId"),
      operator: input.operator,
    });
  }

  if (detail.domain === "wms" && input.actionId === "execute") {
    const item = detail.evidence.item as any;
    if (!input.deps.replenishment) throw new Error("Replenishment service is unavailable");
    if (item.action === "queue_replen") {
      return input.deps.replenishment.queueMissingPickBinReplen({
        mode: "queue_replen",
        variantId: positiveInt(item.variantId, "variantId"),
        locationId: positiveInt(item.locationId, "locationId"),
        limit: 1,
      });
    }
    if (item.action === "cancel_no_demand") {
      return input.deps.replenishment.cleanupHealthIssues({ mode: "stale_no_demand", taskId: positiveInt(item.taskId, "taskId"), limit: 1, userId: input.operator });
    }
    if (item.action === "cancel_duplicate") {
      return input.deps.replenishment.cleanupHealthIssues({ mode: "duplicates", taskId: positiveInt(item.taskId, "taskId"), limit: 1, userId: input.operator });
    }
    if (item.action === "auto_execute_replen") {
      return input.deps.replenishment.cleanupHealthIssues({ mode: "inline_execution", taskId: positiveInt(item.taskId, "taskId"), limit: 1, userId: input.operator });
    }
  }

  throw new Error(`No safe action delegate exists for ${detail.domain}:${detail.code}`);
}
