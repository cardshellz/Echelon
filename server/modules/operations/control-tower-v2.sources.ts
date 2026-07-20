import {
  asRecord,
  compactEvidence,
  controlTowerFingerprint,
  humanizeControlTowerCode,
  isoTimestamp,
  nonNegativeInteger,
  positiveInteger,
  type ControlTowerSeverity,
  type ControlTowerSourceAdapter,
  type ProjectedControlTowerWorkItem,
} from "./control-tower-v2.domain";
import { EBAY_TRACKING_CONFLICT_RULE } from "../oms/channel-fulfillment-conflict";

const CHANNEL_PUSH_PENDING_THRESHOLD_MINUTES = 15;

const INVENTORY_SYSTEM_CONTROL_CHECKS = new Set([
  "inventory_level_constraint_gap",
  "inventory_ledger_immutability_guard_missing",
]);

const INVENTORY_CHECK_DESCRIPTIONS: Record<string, string> = {
  inventory_level_constraint_gap: "Every live inventory quantity bucket needs an explicit non-negative database constraint.",
  inventory_ledger_immutability_guard_missing: "The inventory movement journal needs a database guard that rejects mutation of posted rows.",
  negative_inventory_level_bucket: "No materialized inventory bucket may be negative.",
  stock_at_invalid_location: "Non-zero inventory must belong to an active location and an active warehouse.",
  level_lot_bucket_drift: "Location-level on-hand, reserved, and picked buckets must equal the sum of their FIFO lots.",
  negative_inventory_lot_bucket: "FIFO lot quantity buckets may not be negative.",
  ledger_row_arithmetic_mismatch: "A posted movement row's delta must equal its own after-minus-before quantity.",
  critical_ledger_actor_missing: "Operator-controlled inventory movements require an attributable actor.",
  reservation_ledger_missing_delta: "Reservation-affecting rows need signed bucket deltas so they can be attributed and replayed.",
  reservation_level_ledger_drift: "Live reserved counters must equal signed reservation movements by variant and location.",
  terminal_order_open_reservation: "Shipped, cancelled, or completed WMS orders may not retain an open reservation balance.",
  order_item_quantity_invariant: "Picked and fulfilled quantities must remain between zero and the authorized WMS line quantity.",
  active_pick_ledger_drift: "An active WMS line's picked quantity must equal its net pick and unpick movements.",
  active_pick_cogs_drift: "An active WMS line's picked quantity must equal the FIFO cost quantity attributed to it.",
  closed_receipt_line_ledger_drift: "Closed receiving-line quantities must equal receipt movements for the same receipt, variant, and location.",
  receipt_identity_collision_shape: "Positive receipt lines must have a durable identity that distinguishes repeated variant and location combinations.",
  closed_receipt_header_drift: "Closed receiving headers must equal their line-level received counts and quantities.",
  return_item_quantity_invalid: "Return expected and received quantities must be positive, bounded, and tied to their WMS order.",
  cumulative_return_exceeds_fulfilled: "Cumulative physically received returns may not exceed the WMS line's fulfilled quantity.",
  duplicate_refund_return_identity: "A channel refund identity may create at most one active WMS return for an order.",
  untraceable_case_break_adjustment: "Case-break movements need one durable conversion identity linking source, target, remainder, actor, and cost.",
  invalid_variant_hierarchy: "A variant's case-break target must share its product and contain fewer base units.",
  multiple_active_base_variants: "A product must have one deterministic active base-unit variant for case-break remainder routing.",
  cycle_count_terminal_with_unresolved_items: "A completed cycle count may not contain pending, investigative, or unapproved variance items.",
  cycle_count_freeze_state_drift: "Only in-progress cycle counts may own frozen warehouse locations.",
  stale_in_progress_cycle_count: "Cycle counts left in progress beyond three days require explicit review.",
  inline_replen_not_completed: "System-authoritative inline replenishment may not remain queued after its execution window.",
  duplicate_active_replen_task: "Equivalent active replenishment work must have one durable task identity.",
  lot_cost_mirror_drift: "Derived lot cent mirrors must equal authoritative integer mills.",
  order_item_cost_mirror_drift: "Derived order-line COGS cents must equal authoritative integer mills.",
  duplicate_lot_number: "Lot numbers must uniquely identify a cost layer.",
};

type ProjectedWithoutFingerprint = Omit<ProjectedControlTowerWorkItem, "sourceFingerprint">;

function firstPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") return value;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function providerDisplayName(value: unknown): string {
  const provider = stringOrNull(value)?.toLowerCase();
  if (provider === "shipstation") return "ShipStation";
  if (provider === "shopify") return "Shopify";
  if (provider === "ebay") return "eBay";
  return provider ? humanizeControlTowerCode(provider) : "Provider";
}

function channelOrderNumber(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = stringOrNull(value);
    if (normalized) return normalized;
  }
  return null;
}

function sourceStatus(value: unknown): "open" | "acknowledged" {
  return String(value).toLowerCase() === "acknowledged" ? "acknowledged" : "open";
}

function withFingerprint(item: ProjectedWithoutFingerprint): ProjectedControlTowerWorkItem {
  const fingerprint = controlTowerFingerprint({
    code: item.code,
    entityType: item.entityType,
    entityId: item.entityId,
    title: item.title,
    summary: item.summary,
    expectedState: item.expectedState,
    actualState: item.actualState,
    severity: item.severity,
    urgency: item.urgency,
    sourceStatus: item.sourceStatus,
    occurrenceCount: item.occurrenceCount,
    recurrenceCount: item.recurrenceCount,
    worsenedCount: item.worsenedCount,
    evidenceSummary: item.evidenceSummary,
  });
  return { ...item, sourceFingerprint: fingerprint };
}

function evidenceSentence(evidence: Record<string, unknown>, metric: unknown): string {
  const preferredKeys = [
    "sku",
    "external_order_number",
    "order_number",
    "location_code",
    "warehouse_location_id",
    "product_variant_id",
    "order_item_id",
    "receiving_order_id",
    "cycle_count_id",
    "replen_task_id",
    "quantity",
    "drift",
    "difference",
  ];
  const parts: string[] = [];
  for (const key of preferredKeys) {
    if (key === "order_number" && stringOrNull(evidence.external_order_number)) continue;
    const value = evidence[key];
    if (value === null || value === undefined || value === "") continue;
    parts.push(`${humanizeControlTowerCode(key)}: ${String(value)}`);
    if (parts.length >= 4) break;
  }
  const metricText = String(metric ?? "0");
  return parts.length > 0
    ? `The audit measured ${metricText} affected unit(s) or record(s). ${parts.join("; ")}.`
    : `The audit measured ${metricText} affected unit(s) or record(s). Open the technical evidence for the exact records.`;
}

function inventoryEntityRef(entityKey: Record<string, unknown>, evidence: Record<string, unknown>): string {
  const sku = stringOrNull(firstPresent(evidence, ["sku", "variant_sku"]));
  const location = stringOrNull(firstPresent(evidence, ["location_code", "bin_code"]));
  const orderNumber = stringOrNull(firstPresent(evidence, ["external_order_number", "order_number"]));
  if (sku && location) return `${sku} at ${location}`;
  if (sku) return sku;
  if (orderNumber) return `Order ${orderNumber}`;
  const key = Object.entries(entityKey)[0];
  return key ? `${humanizeControlTowerCode(key[0])} ${String(key[1])}` : "Inventory integrity finding";
}

function inventoryHref(category: string): string {
  if (["picking", "reservations"].includes(category)) return "/orders";
  if (category === "receiving") return "/receiving";
  if (category === "replenishment") return "/replenishment";
  return "/inventory";
}

export const inventoryIntegritySource: ControlTowerSourceAdapter<Record<string, unknown>> = {
  name: "inventory_integrity",
  sourceNamespace: "inventory.integrity_findings",
  sourceType: "integrity_finding",
  projectionVersion: 3,
  async loadRows(client) {
    const result = await client.query(`
      SELECT
        finding.id,
        finding.check_id,
        finding.entity_fingerprint,
        finding.category,
        finding.severity,
        finding.status,
        finding.entity_key,
        finding.current_evidence,
        finding.current_metric,
        finding.first_seen_at,
        finding.last_seen_at,
        finding.last_changed_at,
        finding.occurrence_count,
        finding.recurrence_count,
        finding.worsened_count,
        finding.updated_at,
        wms_order.id AS resolved_wms_order_id,
        wms_order.order_number AS wms_order_number,
        oms_order.id AS oms_order_id,
        oms_order.external_order_number AS channel_order_number,
        channel.provider AS channel_provider
      FROM inventory.integrity_findings AS finding
      LEFT JOIN LATERAL (
        SELECT candidate.order_id
        FROM wms.order_items AS candidate
        WHERE candidate.id = CASE
          WHEN COALESCE(
            finding.current_evidence->>'order_item_id',
            finding.entity_key->>'order_item_id'
          ) ~ '^[1-9][0-9]*$'
          THEN COALESCE(
            finding.current_evidence->>'order_item_id',
            finding.entity_key->>'order_item_id'
          )::integer
          ELSE NULL
        END
        LIMIT 1
      ) AS order_item ON TRUE
      LEFT JOIN LATERAL (
        SELECT candidate.*
        FROM wms.orders AS candidate
        WHERE candidate.id = COALESCE(
          CASE
            WHEN COALESCE(
              finding.current_evidence->>'order_id',
              finding.entity_key->>'order_id'
            ) ~ '^[1-9][0-9]*$'
            THEN COALESCE(
              finding.current_evidence->>'order_id',
              finding.entity_key->>'order_id'
            )::integer
            ELSE NULL
          END,
          order_item.order_id
        )
        LIMIT 1
      ) AS wms_order ON TRUE
      LEFT JOIN oms.oms_orders AS oms_order
        ON oms_order.id = CASE
          WHEN wms_order.source IN ('oms', 'ebay')
           AND wms_order.oms_fulfillment_order_id ~ '^[1-9][0-9]{0,17}$'
          THEN wms_order.oms_fulfillment_order_id::bigint
          WHEN wms_order.source_table_id ~ '^[1-9][0-9]{0,17}$'
          THEN wms_order.source_table_id::bigint
          ELSE NULL
        END
      LEFT JOIN channels.channels AS channel
        ON channel.id = oms_order.channel_id
      WHERE finding.status IN ('open', 'acknowledged')
      ORDER BY finding.id
    `);
    return result.rows;
  },
  projectRow(row) {
    const id = positiveInteger(row.id, "inventory finding id");
    const checkId = String(row.check_id ?? "").trim();
    if (!checkId) throw new Error("inventory finding check_id is required");
    const category = String(row.category ?? "inventory").trim();
    const entityKey = asRecord(row.entity_key);
    const sourceEvidence = asRecord(row.current_evidence);
    const orderNumber = channelOrderNumber(
      row.channel_order_number,
      sourceEvidence.external_order_number,
      row.wms_order_number,
      sourceEvidence.order_number,
    );
    const evidence = orderNumber
      ? { ...sourceEvidence, external_order_number: orderNumber }
      : sourceEvidence;
    const wmsOrderId = row.resolved_wms_order_id == null
      ? null
      : positiveInteger(row.resolved_wms_order_id, "inventory finding wms_order_id");
    const omsOrderId = row.oms_order_id == null
      ? null
      : positiveInteger(row.oms_order_id, "inventory finding oms_order_id");
    const description = INVENTORY_CHECK_DESCRIPTIONS[checkId]
      ?? `The ${humanizeControlTowerCode(checkId).toLowerCase()} inventory invariant must hold.`;
    const severity: ControlTowerSeverity = row.severity === "blocker" ? "blocker" : "medium";
    const entityRef = inventoryEntityRef(entityKey, evidence);
    const firstSeenAt = isoTimestamp(row.first_seen_at, "inventory first_seen_at");
    const lastSeenAt = isoTimestamp(row.last_seen_at, "inventory last_seen_at");
    const lastChangedAt = isoTimestamp(row.last_changed_at, "inventory last_changed_at");
    const sourceUpdatedAt = isoTimestamp(row.updated_at ?? row.last_seen_at, "inventory updated_at");

    return withFingerprint({
      sourceNamespace: "inventory.integrity_findings",
      sourceType: "integrity_finding",
      sourceKey: String(id),
      projectionVersion: 3,
      domain: "inventory",
      code: checkId,
      entityType: "inventory_integrity_finding",
      entityId: String(id),
      entityRef,
      correlationId: stringOrNull(row.entity_fingerprint),
      rootCauseGroupKey: `inventory:${checkId}`,
      title: humanizeControlTowerCode(checkId),
      summary: description,
      expectedState: description,
      actualState: evidenceSentence(evidence, row.current_metric),
      severity,
      urgency: "normal",
      impactTags: INVENTORY_SYSTEM_CONTROL_CHECKS.has(checkId)
        ? ["inventory_accuracy", "system_control"]
        : category === "costs"
          ? ["financial_accuracy", "inventory"]
          : ["inventory_accuracy"],
      actionability: "investigate",
      sourceStatus: sourceStatus(row.status),
      ownerTeam: "Warehouse",
      recommendedAction: "Open the inventory evidence, identify the authoritative movement or balance, and use the owning workflow for any correction.",
      responseDueAt: null,
      firstSeenAt,
      lastSeenAt,
      lastChangedAt,
      occurrenceCount: Math.max(1, nonNegativeInteger(row.occurrence_count, "inventory occurrence_count", 1)),
      recurrenceCount: nonNegativeInteger(row.recurrence_count, "inventory recurrence_count"),
      worsenedCount: nonNegativeInteger(row.worsened_count, "inventory worsened_count"),
      evidenceSummary: {
        findingId: id,
        checkId,
        category,
        metric: String(row.current_metric ?? "0"),
        channelProvider: row.channel_provider,
        channelOrderNumber: orderNumber,
        omsOrderId,
        wmsOrderId,
        entityKey: compactEvidence(entityKey),
        evidence: compactEvidence(evidence),
      },
      detailLocator: {
        sourceTable: "inventory.integrity_findings",
        sourceId: id,
        omsOrderId,
        wmsOrderId,
        links: [{
          label: orderNumber ? `Open ${orderNumber}` : "Open inventory workflow",
          href: wmsOrderId ? `/orders?orderId=${wmsOrderId}` : inventoryHref(category),
        }],
      },
      availableActions: [{
        code: "open_source",
        kind: "navigate",
        label: orderNumber ? `Open ${orderNumber}` : "Open inventory workflow",
        href: wmsOrderId ? `/orders?orderId=${wmsOrderId}` : inventoryHref(category),
      }],
      sourceUpdatedAt,
      observedMetric: String(row.current_metric ?? "0"),
    });
  },
};

function wmsSeverity(value: unknown, classification: string): ControlTowerSeverity {
  if (value === "blocker" || classification === "hard_block") return "blocker";
  if (value === "review" || value === "warning" || classification === "manual_review") return "high";
  return "low";
}

export const wmsReconciliationSource: ControlTowerSourceAdapter<Record<string, unknown>> = {
  name: "wms_reconciliation",
  sourceNamespace: "wms.reconciliation_exceptions",
  sourceType: "reconciliation_exception",
  projectionVersion: 2,
  async loadRows(client) {
    const result = await client.query(`
      SELECT
        exception.id,
        exception.source,
        exception.classification,
        exception.rule,
        exception.status,
        exception.severity,
        exception.wms_order_id,
        exception.wms_shipment_id,
        exception.external_system,
        exception.external_order_ref,
        exception.external_shipment_ref,
        exception.external_order_key,
        exception.idempotency_key,
        exception.summary,
        exception.details,
        exception.first_seen_at,
        exception.last_seen_at,
        exception.occurrence_count,
        exception.updated_at,
        COALESCE(exception.wms_order_id, shipment.order_id) AS resolved_wms_order_id,
        shipment.id AS resolved_wms_shipment_id,
        wms_order.order_number AS wms_order_number,
        oms_order.id AS oms_order_id,
        oms_order.external_order_number AS channel_order_number,
        channel.provider AS channel_provider,
        shipment.tracking_number,
        shipment.shipping_engine,
        shipment.engine_order_ref
      FROM wms.reconciliation_exceptions AS exception
      LEFT JOIN LATERAL (
        SELECT candidate.*
        FROM wms.outbound_shipments AS candidate
        WHERE candidate.id = exception.wms_shipment_id
           OR candidate.id = NULLIF(
             substring(exception.external_order_key FROM '^echelon-wms-shp-([0-9]+)$'),
             ''
           )::integer
           OR candidate.external_fulfillment_id =
             'shipstation_shipment:' || exception.external_shipment_ref
           OR candidate.shipstation_order_id::text = exception.external_order_ref
           OR (
             candidate.shipping_engine = exception.external_system
             AND candidate.engine_order_ref = exception.external_order_ref
           )
        ORDER BY
          CASE
            WHEN candidate.id = exception.wms_shipment_id THEN 1
            WHEN candidate.id = NULLIF(
              substring(exception.external_order_key FROM '^echelon-wms-shp-([0-9]+)$'),
              ''
            )::integer THEN 2
            WHEN candidate.external_fulfillment_id =
              'shipstation_shipment:' || exception.external_shipment_ref THEN 3
            WHEN candidate.shipstation_order_id::text = exception.external_order_ref THEN 4
            ELSE 5
          END,
          candidate.id DESC
        LIMIT 1
      ) AS shipment ON TRUE
      LEFT JOIN wms.orders AS wms_order
        ON wms_order.id = COALESCE(exception.wms_order_id, shipment.order_id)
      LEFT JOIN oms.oms_orders AS oms_order
        ON oms_order.id = CASE
          WHEN wms_order.source IN ('oms', 'ebay')
           AND wms_order.oms_fulfillment_order_id ~ '^[1-9][0-9]{0,17}$'
          THEN wms_order.oms_fulfillment_order_id::bigint
          WHEN wms_order.source_table_id ~ '^[1-9][0-9]{0,17}$'
          THEN wms_order.source_table_id::bigint
          ELSE NULL
        END
      LEFT JOIN channels.channels AS channel
        ON channel.id = oms_order.channel_id
      WHERE exception.status IN ('open', 'acknowledged')
        AND exception.classification <> 'historical_ignore'
      ORDER BY exception.id
    `);
    return result.rows;
  },
  projectRow(row) {
    const id = positiveInteger(row.id, "WMS reconciliation exception id");
    const rule = String(row.rule ?? "").trim();
    if (!rule) throw new Error("WMS reconciliation rule is required");
    const classification = String(row.classification ?? "manual_review");
    const details = asRecord(row.details);
    const orderNumber = channelOrderNumber(
      row.channel_order_number,
      row.wms_order_number,
    );
    const wmsOrderIdValue = row.resolved_wms_order_id ?? row.wms_order_id;
    const shipmentIdValue = row.resolved_wms_shipment_id ?? row.wms_shipment_id;
    const wmsOrderId = wmsOrderIdValue == null
      ? null
      : positiveInteger(wmsOrderIdValue, "wms_order_id");
    const shipmentId = shipmentIdValue == null
      ? null
      : positiveInteger(shipmentIdValue, "wms_shipment_id");
    const omsOrderId = row.oms_order_id == null
      ? null
      : positiveInteger(row.oms_order_id, "oms_order_id");
    const provider = providerDisplayName(row.external_system);
    const providerOrderRef = stringOrNull(row.external_order_ref);
    const providerShipmentRef = stringOrNull(row.external_shipment_ref);
    const trackingNumber = stringOrNull(
      rule === "shipstation_unmapped_physical_shipment"
        ? details.trackingNumber ?? row.tracking_number
        : rule === EBAY_TRACKING_CONFLICT_RULE
          ? details.currentTrackingNumber ?? row.tracking_number
          : row.tracking_number ?? details.trackingNumber,
    );
    const entityType = shipmentId ? "wms_shipment" : wmsOrderId ? "wms_order" : "external_order";
    const entityId = String(shipmentId ?? wmsOrderId ?? row.external_order_ref ?? id);
    const entityRef = orderNumber
      ? `Order ${orderNumber}`
      : providerOrderRef
        ? `${provider} order ${providerOrderRef}`
        : shipmentId
          ? `WMS shipment ${shipmentId}`
          : `Exception ${id}`;
    const summary = rule === "ship_notify_no_match"
      ? `${provider} shipment ${providerShipmentRef ?? "unknown"} did not match a WMS shipment${orderNumber ? ` for order ${orderNumber}` : ""}.`
      : rule === "shipstation_unmapped_physical_shipment"
        ? `${provider} reported another package${orderNumber ? ` for order ${orderNumber}` : ""}${trackingNumber ? ` with tracking ${trackingNumber}` : ""}. Echelon did not change fulfillment or inventory because the package has not been confirmed as an intentional replacement or a duplicate.`
        : String(row.summary ?? humanizeControlTowerCode(rule)).trim();
    const actualState = rule === "ship_notify_no_match"
      ? [
          `${provider} reported a shipment that could not be linked to WMS when the callback was processed.`,
          providerOrderRef ? `Provider order: ${providerOrderRef}.` : null,
          providerShipmentRef ? `Provider shipment: ${providerShipmentRef}.` : null,
          trackingNumber ? `Tracking: ${trackingNumber}.` : null,
        ].filter(Boolean).join(" ")
      : `${humanizeControlTowerCode(classification)}: ${summary}`;
    const orderHref = wmsOrderId ? `/orders?orderId=${wmsOrderId}` : "/orders";
    const openOrderLabel = orderNumber ? `Open ${orderNumber}` : "Open WMS orders";
    const firstSeenAt = isoTimestamp(row.first_seen_at, "WMS first_seen_at");
    const lastSeenAt = isoTimestamp(row.last_seen_at, "WMS last_seen_at");
    const sourceUpdatedAt = isoTimestamp(row.updated_at ?? row.last_seen_at, "WMS updated_at");

    return withFingerprint({
      sourceNamespace: "wms.reconciliation_exceptions",
      sourceType: "reconciliation_exception",
      sourceKey: String(id),
      projectionVersion: 2,
      domain: "wms",
      code: rule,
      entityType,
      entityId,
      entityRef,
      correlationId: stringOrNull(row.idempotency_key),
      rootCauseGroupKey: `wms:${rule}`,
      title: rule === EBAY_TRACKING_CONFLICT_RULE
        ? "eBay tracking changed after fulfillment"
        : humanizeControlTowerCode(rule),
      summary,
      expectedState: "OMS, WMS, shipment, and provider evidence must agree before fulfillment state changes.",
      actualState,
      severity: wmsSeverity(row.severity, classification),
      urgency: classification === "hard_block" ? "overdue" : "normal",
      impactTags: ["order_flow", "warehouse_execution"],
      actionability: "investigate",
      sourceStatus: sourceStatus(row.status),
      ownerTeam: "Warehouse",
      recommendedAction: rule === "ship_notify_no_match"
        ? `Open ${orderNumber ? `order ${orderNumber}` : "the WMS order list"}, verify whether this exact provider shipment is now linked, and replay the provider callback only if fulfillment is still missing.`
        : rule === "shipstation_unmapped_physical_shipment"
          ? "Use the physical-package evidence and merchant intent to classify it. Adopt an actual replacement as a reship; ignore it only with proof that the label was duplicate, voided, or unused."
          : rule === EBAY_TRACKING_CONFLICT_RULE
            ? "Compare the original eBay fulfillment with the later physical package. Classify the later package as a replacement or duplicate before resolving this item; do not resend tracking to eBay."
            : "Review the reconciliation evidence and resolve the underlying source workflow. Do not overwrite fulfillment state manually.",
      responseDueAt: null,
      firstSeenAt,
      lastSeenAt,
      lastChangedAt: sourceUpdatedAt,
      occurrenceCount: Math.max(1, nonNegativeInteger(row.occurrence_count, "WMS occurrence_count", 1)),
      recurrenceCount: 0,
      worsenedCount: 0,
      evidenceSummary: {
        exceptionId: id,
        source: row.source,
        classification,
        channelProvider: row.channel_provider,
        channelOrderNumber: orderNumber,
        omsOrderId,
        wmsOrderId,
        wmsShipmentId: shipmentId,
        externalSystem: row.external_system,
        externalOrderRef: row.external_order_ref,
        externalShipmentRef: row.external_shipment_ref,
        trackingNumber,
        shippingEngine: row.shipping_engine,
        engineOrderRef: row.engine_order_ref,
        details: compactEvidence(details),
      },
      detailLocator: {
        sourceTable: "wms.reconciliation_exceptions",
        sourceId: id,
        omsOrderId,
        wmsOrderId,
        wmsShipmentId: shipmentId,
        links: [{ label: openOrderLabel, href: orderHref }],
      },
      availableActions: [{ code: "open_source", kind: "navigate", label: openOrderLabel, href: orderHref }],
      sourceUpdatedAt,
      observedMetric: String(Math.max(1, nonNegativeInteger(row.occurrence_count, "WMS occurrence_count", 1))),
    });
  },
};

function procurementSeverity(value: unknown): ControlTowerSeverity {
  if (value === "error") return "high";
  if (value === "warn") return "medium";
  return "low";
}

export const procurementExceptionsSource: ControlTowerSourceAdapter<Record<string, unknown>> = {
  name: "procurement_exceptions",
  sourceNamespace: "procurement.po_exceptions",
  sourceType: "po_exception",
  projectionVersion: 1,
  async loadRows(client) {
    const result = await client.query(`
      SELECT
        exception.id,
        exception.po_id,
        exception.kind,
        exception.severity,
        exception.status,
        exception.payload,
        exception.payload_hash,
        exception.title,
        exception.message,
        exception.detected_at,
        exception.updated_at,
        purchase_order.po_number,
        purchase_order.status AS po_status
      FROM procurement.po_exceptions AS exception
      JOIN procurement.purchase_orders AS purchase_order
        ON purchase_order.id = exception.po_id
      WHERE exception.status IN ('open', 'acknowledged')
      ORDER BY exception.id
    `);
    return result.rows;
  },
  projectRow(row) {
    const id = positiveInteger(row.id, "PO exception id");
    const poId = positiveInteger(row.po_id, "PO exception po_id");
    const kind = String(row.kind ?? "").trim();
    if (!kind) throw new Error("PO exception kind is required");
    const poNumber = String(row.po_number ?? poId);
    const title = String(row.title ?? humanizeControlTowerCode(kind)).trim();
    const message = stringOrNull(row.message) ?? title;
    const payload = asRecord(row.payload);
    const detectedAt = isoTimestamp(row.detected_at, "PO exception detected_at");
    const updatedAt = isoTimestamp(row.updated_at ?? row.detected_at, "PO exception updated_at");

    return withFingerprint({
      sourceNamespace: "procurement.po_exceptions",
      sourceType: "po_exception",
      sourceKey: String(id),
      projectionVersion: 1,
      domain: "procurement",
      code: kind,
      entityType: "purchase_order",
      entityId: String(poId),
      entityRef: poNumber,
      correlationId: stringOrNull(row.payload_hash),
      rootCauseGroupKey: `procurement:${kind}`,
      title,
      summary: message,
      expectedState: "The purchase order should complete its approved procurement lifecycle without an unresolved exception.",
      actualState: message,
      severity: procurementSeverity(row.severity),
      urgency: "normal",
      impactTags: ["procurement", "financial_control"],
      actionability: "investigate",
      sourceStatus: sourceStatus(row.status),
      ownerTeam: "Procurement",
      recommendedAction: "Open the purchase order exception, review its evidence, and resolve or dismiss it in the procurement workflow.",
      responseDueAt: null,
      firstSeenAt: detectedAt,
      lastSeenAt: updatedAt,
      lastChangedAt: updatedAt,
      occurrenceCount: 1,
      recurrenceCount: 0,
      worsenedCount: 0,
      evidenceSummary: {
        exceptionId: id,
        poId,
        poNumber,
        poStatus: row.po_status,
        severity: row.severity,
        payload: compactEvidence(payload),
      },
      detailLocator: {
        sourceTable: "procurement.po_exceptions",
        sourceId: id,
        poId,
        links: [{ label: `Open ${poNumber}`, href: `/purchase-orders/${poId}` }],
      },
      availableActions: [{ code: "open_source", kind: "navigate", label: `Open ${poNumber}`, href: `/purchase-orders/${poId}` }],
      sourceUpdatedAt: updatedAt,
      observedMetric: "1",
    });
  },
};

function channelPushTitle(status: string): string {
  if (status === "failed") return "Channel fulfillment push failed";
  if (status === "review") return "Channel fulfillment needs review";
  return "Channel fulfillment confirmation overdue";
}

export const channelFulfillmentSource: ControlTowerSourceAdapter<Record<string, unknown>> = {
  name: "channel_fulfillment",
  sourceNamespace: "oms.channel_fulfillment_pushes",
  sourceType: "channel_fulfillment_push",
  projectionVersion: 2,
  async loadRows(client) {
    const result = await client.query(`
      SELECT
        push.id,
        push.oms_order_id,
        push.physical_shipment_id,
        push.channel_provider,
        push.channel_fulfillment_id,
        push.push_status,
        push.attempt_count,
        push.last_error,
        push.metadata,
        push.created_at,
        push.updated_at,
        oms_order.external_order_number,
        oms_order.external_order_id,
        oms_order.fulfillment_status,
        physical_shipment.provider AS shipping_provider,
        physical_shipment.provider_physical_shipment_id,
        physical_shipment.tracking_number,
        physical_shipment.carrier,
        physical_shipment.status AS physical_shipment_status,
        shipment_request.wms_order_id,
        wms_order.order_number AS wms_order_number
      FROM oms.channel_fulfillment_pushes AS push
      JOIN oms.oms_orders AS oms_order
        ON oms_order.id = push.oms_order_id
      JOIN wms.physical_shipments AS physical_shipment
        ON physical_shipment.id = push.physical_shipment_id
      JOIN wms.shipment_requests AS shipment_request
        ON shipment_request.id = physical_shipment.shipment_request_id
      JOIN wms.orders AS wms_order
        ON wms_order.id = shipment_request.wms_order_id
      WHERE push.push_status IN ('failed', 'review')
         OR (
           push.push_status = 'pending'
           AND push.created_at <= NOW() - ($1::INTEGER * INTERVAL '1 minute')
         )
      ORDER BY push.id
    `, [CHANNEL_PUSH_PENDING_THRESHOLD_MINUTES]);
    return result.rows;
  },
  projectRow(row) {
    const id = positiveInteger(row.id, "channel fulfillment push id");
    const omsOrderId = positiveInteger(row.oms_order_id, "channel push oms_order_id");
    const physicalShipmentId = positiveInteger(row.physical_shipment_id, "channel push physical_shipment_id");
    const status = String(row.push_status ?? "").toLowerCase();
    if (!new Set(["failed", "review", "pending"]).has(status)) {
      throw new Error(`unsupported channel fulfillment push status ${status}`);
    }
    const provider = String(row.channel_provider ?? "channel");
    const orderNumber = channelOrderNumber(row.external_order_number, row.wms_order_number);
    const orderReference = orderNumber ? `Order ${orderNumber}` : `OMS order ${omsOrderId}`;
    const trackingNumber = stringOrNull(row.tracking_number);
    const lastError = stringOrNull(row.last_error);
    const metadata = asRecord(row.metadata);
    const createdAt = isoTimestamp(row.created_at, "channel push created_at");
    const updatedAt = isoTimestamp(row.updated_at ?? row.created_at, "channel push updated_at");
    const actual = lastError
      ? `${provider} push is ${status}. Last error: ${lastError}`
      : `${provider} push is ${status} after ${row.attempt_count ?? 0} attempt(s).`;

    return withFingerprint({
      sourceNamespace: "oms.channel_fulfillment_pushes",
      sourceType: "channel_fulfillment_push",
      sourceKey: String(id),
      projectionVersion: 2,
      domain: "shipping",
      code: `channel_fulfillment_${status}`,
      entityType: "physical_shipment",
      entityId: String(physicalShipmentId),
      entityRef: trackingNumber ? `${orderReference} / ${trackingNumber}` : orderReference,
      correlationId: stringOrNull(row.provider_physical_shipment_id),
      rootCauseGroupKey: `shipping:channel_fulfillment:${provider}:${status}`,
      title: channelPushTitle(status),
      summary: `${orderReference} has a physical shipment that is not confirmed by ${provider}.`,
      expectedState: "Each physical shipment must be confirmed exactly once by the originating sales channel.",
      actualState: actual,
      severity: status === "pending" ? "medium" : "high",
      urgency: status === "failed" ? "due_soon" : "normal",
      impactTags: ["channel_writeback", "customer_tracking"],
      actionability: "investigate",
      sourceStatus: "open",
      ownerTeam: "Order Operations",
      recommendedAction: "Review the physical shipment and channel response, then use the authorized fulfillment replay workflow if the channel is still missing tracking.",
      responseDueAt: null,
      firstSeenAt: createdAt,
      lastSeenAt: updatedAt,
      lastChangedAt: updatedAt,
      occurrenceCount: Math.max(1, nonNegativeInteger(row.attempt_count, "channel push attempt_count") + 1),
      recurrenceCount: 0,
      worsenedCount: 0,
      evidenceSummary: {
        channelFulfillmentPushId: id,
        omsOrderId,
        wmsOrderId: row.wms_order_id,
        physicalShipmentId,
        channelOrderNumber: orderNumber,
        externalOrderId: row.external_order_id,
        channelProvider: provider,
        channelFulfillmentId: row.channel_fulfillment_id,
        pushStatus: status,
        attemptCount: row.attempt_count,
        trackingNumber,
        carrier: row.carrier,
        shippingProvider: row.shipping_provider,
        physicalShipmentStatus: row.physical_shipment_status,
        lastError,
        metadata: compactEvidence(metadata),
      },
      detailLocator: {
        sourceTable: "oms.channel_fulfillment_pushes",
        sourceId: id,
        omsOrderId,
        wmsOrderId: row.wms_order_id,
        physicalShipmentId,
        links: [{
          label: orderNumber ? `Open ${orderNumber}` : "Open OMS order",
          href: `/oms/orders?orderId=${omsOrderId}`,
        }],
      },
      availableActions: [{
        code: "open_source",
        kind: "navigate",
        label: orderNumber ? `Open ${orderNumber}` : "Open OMS order",
        href: `/oms/orders?orderId=${omsOrderId}`,
      }],
      sourceUpdatedAt: updatedAt,
      observedMetric: String(Math.max(1, nonNegativeInteger(row.attempt_count, "channel push attempt_count") + 1)),
    });
  },
};

export const CONTROL_TOWER_SOURCE_ADAPTERS = [
  inventoryIntegritySource,
  wmsReconciliationSource,
  procurementExceptionsSource,
  channelFulfillmentSource,
] as const;

export function getControlTowerSourceAdapter(name: string) {
  return CONTROL_TOWER_SOURCE_ADAPTERS.find((adapter) => adapter.name === name) ?? null;
}
