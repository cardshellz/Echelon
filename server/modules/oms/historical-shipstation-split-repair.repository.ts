import type { Pool, PoolClient } from "pg";

import {
  buildHistoricalSplitRepairComponents,
  HISTORICAL_SPLIT_REPAIR_SOURCE,
  type HistoricalSplitAppliedPackage,
  type HistoricalSplitCanonicalPackage,
  type HistoricalSplitInspection,
  type HistoricalSplitProviderPackage,
  type HistoricalSplitProviderReconciliationResult,
  type HistoricalSplitRepairAudit,
  type HistoricalSplitRepairComponent,
  type HistoricalSplitRepairFailure,
  type HistoricalSplitRepairFlags,
  type HistoricalSplitRepairPackagePlan,
  type HistoricalSplitRetryCandidate,
} from "./historical-shipstation-split-repair.service";
import type { ShipStationShipment } from "./shipstation.service";

const FAILURE_INDEX_PATTERN =
  'uq_outbound_shipments_active_(?:shipstation_order_key|shipstation_order_id|engine_order_ref)';
const UNMAPPED_RULES = Object.freeze([
  "shipstation_unmapped_physical_shipment",
  "ship_notify_no_match",
]);

type QueryExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

interface SourceItemRow {
  id: number;
  shipment_id: number;
  order_id: number;
  channel_id: number | null;
  shipment_status: string;
  shipment_source: string;
  external_fulfillment_id: string | null;
  tracking_number: string | null;
  carrier: string | null;
  order_item_id: number | null;
  replacement_for_order_item_id: number | null;
  shipment_item_purpose: string;
  product_variant_id: number | null;
  qty: number;
  from_location_id: number | null;
  box_id: string | null;
  weight_oz: number | null;
  provider_membership_state: string;
  canonical_physical_shipment_id: number | null;
}

interface CanonicalRow {
  provider_physical_shipment_id: string;
  physical_shipment_id: number;
  tracking_number: string | null;
  legacy_wms_shipment_ids: number[];
  wms_order_ids: number[];
  channel_command_count: number;
}

interface TargetAllocation {
  providerShipmentId: number;
  sourceShipmentItemId: number;
  quantity: number;
  orderId: number;
  targetShipmentId: number;
}

interface TargetPlan {
  providerPackage: HistoricalSplitProviderPackage;
  orderId: number;
  channelId: number | null;
  identity: string;
  expectedSourceItems: Array<{
    sourceShipmentItemId: number;
    quantity: number;
    source: SourceItemRow;
  }>;
  targetShipmentId: number | null;
}

export interface HistoricalShipStationSplitRepairRepository {
  loadRetryCandidates(flags: HistoricalSplitRepairFlags): Promise<readonly HistoricalSplitRetryCandidate[]>;
  inspectPackages(packages: readonly HistoricalSplitRepairPackagePlan[]): Promise<HistoricalSplitInspection>;
  applyComponent(
    component: HistoricalSplitRepairComponent,
    audit: HistoricalSplitRepairAudit,
  ): Promise<readonly HistoricalSplitAppliedPackage[]>;
  proveProviderPackageLinks(
    applied: HistoricalSplitAppliedPackage,
  ): Promise<number>;
  finalizeMappedPackage(
    applied: HistoricalSplitAppliedPackage,
    packagePlan: HistoricalSplitRepairPackagePlan,
    reconciliation: HistoricalSplitProviderReconciliationResult,
    audit: HistoricalSplitRepairAudit,
  ): Promise<void>;
  finalizeRepairedPackage(
    applied: HistoricalSplitAppliedPackage,
    packagePlan: HistoricalSplitRepairPackagePlan,
    physicalShipmentId: number,
    audit: HistoricalSplitRepairAudit,
  ): Promise<void>;
  finalizeNonOutboundPackage(
    candidate: HistoricalSplitRetryCandidate,
    shipment: ShipStationShipment,
    disposition: "voided" | "return_label",
    audit: HistoricalSplitRepairAudit,
  ): Promise<void>;
}

function repairError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function rowsOf<T>(result: { rows?: T[] }): T[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function asPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw repairError("INVALID_PERSISTED_ID", `${field} must be a positive integer`);
  }
  return parsed;
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((candidate) =>
    Number.isSafeInteger(candidate) && candidate > 0
  ))].sort((left, right) => left - right);
}

function providerPhysicalIdentity(
  providerShipmentId: number,
  orderId: number,
  primaryOrderId: number,
): string {
  return orderId === primaryOrderId
    ? `shipstation_shipment:${providerShipmentId}`
    : `shipstation_combined:${providerShipmentId}:order:${orderId}`;
}

function immutableFailure(
  providerShipmentIds: readonly number[],
  code: string,
  message: string,
): HistoricalSplitRepairFailure {
  return Object.freeze({ providerShipmentIds: Object.freeze([...providerShipmentIds]), code, message });
}

function expectedMembershipKey(row: Pick<
  SourceItemRow,
  "order_item_id" | "replacement_for_order_item_id" | "shipment_item_purpose" | "product_variant_id"
>): string {
  return [
    row.order_item_id ?? "",
    row.replacement_for_order_item_id ?? "",
    row.shipment_item_purpose,
    row.product_variant_id ?? "",
  ].join(":");
}

function addQuantity(map: Map<string, number>, key: string, quantity: number): void {
  map.set(key, (map.get(key) ?? 0) + quantity);
}

function mapsEqual(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, quantity] of left) {
    if (right.get(key) !== quantity) return false;
  }
  return true;
}

function parseSourceRow(raw: Record<string, unknown>): SourceItemRow {
  return {
    id: asPositiveInteger(raw.id, "shipment item id"),
    shipment_id: asPositiveInteger(raw.shipment_id, "shipment id"),
    order_id: asPositiveInteger(raw.order_id, "WMS order id"),
    channel_id: raw.channel_id == null ? null : Number(raw.channel_id),
    shipment_status: String(raw.shipment_status ?? ""),
    shipment_source: String(raw.shipment_source ?? ""),
    external_fulfillment_id: raw.external_fulfillment_id == null ? null : String(raw.external_fulfillment_id),
    tracking_number: raw.tracking_number == null ? null : String(raw.tracking_number),
    carrier: raw.carrier == null ? null : String(raw.carrier),
    order_item_id: raw.order_item_id == null ? null : Number(raw.order_item_id),
    replacement_for_order_item_id: raw.replacement_for_order_item_id == null
      ? null
      : Number(raw.replacement_for_order_item_id),
    shipment_item_purpose: String(raw.shipment_item_purpose ?? ""),
    product_variant_id: raw.product_variant_id == null ? null : Number(raw.product_variant_id),
    qty: Number(raw.qty),
    from_location_id: raw.from_location_id == null ? null : Number(raw.from_location_id),
    box_id: raw.box_id == null ? null : String(raw.box_id),
    weight_oz: raw.weight_oz == null ? null : Number(raw.weight_oz),
    provider_membership_state: String(raw.provider_membership_state ?? "authoritative"),
    canonical_physical_shipment_id: raw.canonical_physical_shipment_id == null
      ? null
      : Number(raw.canonical_physical_shipment_id),
  };
}

async function loadSourceRows(
  executor: QueryExecutor,
  sourceItemIds: readonly number[],
  lock: boolean,
): Promise<Map<number, SourceItemRow>> {
  if (sourceItemIds.length === 0) return new Map();
  const result = await executor.query(
    `SELECT item.id, item.shipment_id, shipment.order_id, shipment.channel_id,
       shipment.status::text AS shipment_status, shipment.source AS shipment_source,
       shipment.external_fulfillment_id, shipment.tracking_number, shipment.carrier,
       item.order_item_id, item.replacement_for_order_item_id,
       item.shipment_item_purpose, item.product_variant_id, item.qty,
       item.from_location_id, item.box_id, item.weight_oz,
       item.provider_membership_state,
       physical_item.physical_shipment_id AS canonical_physical_shipment_id
     FROM wms.outbound_shipment_items AS item
     JOIN wms.outbound_shipments AS shipment ON shipment.id = item.shipment_id
     LEFT JOIN wms.physical_shipment_items AS physical_item
       ON physical_item.legacy_wms_shipment_item_id = item.id
     WHERE item.id = ANY($1::int[])
     ORDER BY item.id
     ${lock ? "FOR UPDATE OF item, shipment" : ""}`,
    [sourceItemIds],
  );
  return new Map(rowsOf<Record<string, unknown>>(result).map((raw) => {
    const row = parseSourceRow(raw);
    return [row.id, row];
  }));
}

async function loadCanonicalRows(
  pool: Pool,
  providerShipmentIds: readonly number[],
): Promise<Map<number, CanonicalRow>> {
  if (providerShipmentIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT physical.provider_physical_shipment_id,
       physical.id AS physical_shipment_id, physical.tracking_number,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT COALESCE(
         label_link.legacy_wms_shipment_id, legacy_item.shipment_id
       )), NULL) AS legacy_wms_shipment_ids,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT legacy_shipment.order_id), NULL) AS wms_order_ids,
       (SELECT COUNT(*)::int FROM oms.channel_fulfillment_pushes AS command
        WHERE command.physical_shipment_id = physical.id) AS channel_command_count
     FROM wms.physical_shipments AS physical
     LEFT JOIN wms.shipping_provider_label_links AS label_link
       ON label_link.physical_shipment_id = physical.id
     LEFT JOIN wms.physical_shipment_items AS physical_item
       ON physical_item.physical_shipment_id = physical.id
     LEFT JOIN wms.outbound_shipment_items AS legacy_item
       ON legacy_item.id = physical_item.legacy_wms_shipment_item_id
     LEFT JOIN wms.outbound_shipments AS legacy_shipment
       ON legacy_shipment.id = COALESCE(label_link.legacy_wms_shipment_id, legacy_item.shipment_id)
     WHERE physical.provider = 'shipstation'
       AND physical.provider_physical_shipment_id = ANY($1::text[])
     GROUP BY physical.id
     ORDER BY physical.id`,
    [providerShipmentIds.map(String)],
  );
  return new Map(rowsOf<Record<string, unknown>>(result).map((raw) => {
    const providerShipmentId = asPositiveInteger(
      raw.provider_physical_shipment_id,
      "provider physical shipment id",
    );
    return [providerShipmentId, {
      provider_physical_shipment_id: String(raw.provider_physical_shipment_id),
      physical_shipment_id: asPositiveInteger(raw.physical_shipment_id, "physical shipment id"),
      tracking_number: raw.tracking_number == null ? null : String(raw.tracking_number),
      legacy_wms_shipment_ids: numberArray(raw.legacy_wms_shipment_ids),
      wms_order_ids: numberArray(raw.wms_order_ids),
      channel_command_count: Number(raw.channel_command_count) || 0,
    }];
  }));
}
async function exactTargetMembership(
  executor: QueryExecutor,
  target: TargetPlan,
): Promise<boolean> {
  if (!target.targetShipmentId) return false;
  const result = await executor.query(
    `SELECT order_item_id, replacement_for_order_item_id,
            shipment_item_purpose, product_variant_id, qty
     FROM wms.outbound_shipment_items
     WHERE shipment_id = $1
     ORDER BY id`,
    [target.targetShipmentId],
  );
  const actual = new Map<string, number>();
  for (const row of rowsOf<Record<string, unknown>>(result)) {
    addQuantity(actual, expectedMembershipKey({
      order_item_id: row.order_item_id == null ? null : Number(row.order_item_id),
      replacement_for_order_item_id: row.replacement_for_order_item_id == null
        ? null
        : Number(row.replacement_for_order_item_id),
      shipment_item_purpose: String(row.shipment_item_purpose ?? ""),
      product_variant_id: row.product_variant_id == null ? null : Number(row.product_variant_id),
    }), Number(row.qty));
  }
  const expected = new Map<string, number>();
  for (const item of target.expectedSourceItems) {
    addQuantity(expected, expectedMembershipKey(item.source), item.quantity);
  }
  return mapsEqual(actual, expected);
}

function buildTargetPlansForPackage(
  plan: HistoricalSplitRepairPackagePlan,
  sources: ReadonlyMap<number, SourceItemRow>,
): TargetPlan[] {
  const packageOrderIds = [...new Set(plan.providerPackage.items.map((item) =>
    sources.get(item.sourceShipmentItemId)!.order_id
  ))].sort((left, right) => left - right);
  return packageOrderIds.map((orderId) => {
    const expectedSourceItems = plan.providerPackage.items
      .filter((item) => sources.get(item.sourceShipmentItemId)!.order_id === orderId)
      .map((item) => ({
        sourceShipmentItemId: item.sourceShipmentItemId,
        quantity: item.quantity,
        source: sources.get(item.sourceShipmentItemId)!,
      }));
    return {
      providerPackage: plan.providerPackage,
      orderId,
      channelId: expectedSourceItems[0].source.channel_id,
      identity: providerPhysicalIdentity(
        plan.providerPackage.providerShipmentId,
        orderId,
        packageOrderIds[0],
      ),
      expectedSourceItems,
      targetShipmentId: null,
    };
  });
}

async function loadExactExistingTargets(
  executor: QueryExecutor,
  plan: HistoricalSplitRepairPackagePlan,
  sources: ReadonlyMap<number, SourceItemRow>,
): Promise<readonly TargetPlan[] | null> {
  const targets = buildTargetPlansForPackage(plan, sources);
  for (const target of targets) {
    const existing = await executor.query(
      `SELECT id, order_id, status::text AS status, tracking_number
       FROM wms.outbound_shipments
       WHERE external_fulfillment_id = $1
       ORDER BY id`,
      [target.identity],
    );
    const matches = rowsOf<Record<string, unknown>>(existing);
    if (matches.length !== 1) return null;
    const row = matches[0];
    if (
      Number(row.order_id) !== target.orderId
      || String(row.status) !== "shipped"
      || String(row.tracking_number ?? "") !== target.providerPackage.trackingNumber
    ) return null;
    target.targetShipmentId = asPositiveInteger(row.id, "existing target shipment id");
    if (!(await exactTargetMembership(executor, target))) return null;
  }
  return Object.freeze(targets);
}
async function resolveOrCreateTarget(
  client: PoolClient,
  target: TargetPlan,
  audit: HistoricalSplitRepairAudit,
): Promise<number> {
  const existing = await client.query(
    `SELECT id, order_id, status::text AS status, external_fulfillment_id,
            tracking_number
     FROM wms.outbound_shipments
     WHERE external_fulfillment_id = $1
        OR (order_id = $2 AND status = 'shipped' AND tracking_number = $3)
     ORDER BY CASE WHEN external_fulfillment_id = $1 THEN 0 ELSE 1 END, id
     FOR UPDATE`,
    [target.identity, target.orderId, target.providerPackage.trackingNumber],
  );
  const matches = rowsOf<Record<string, unknown>>(existing);
  if (matches.length > 1) {
    throw repairError(
      "TARGET_PACKAGE_IDENTITY_AMBIGUOUS",
      `Multiple WMS shipments match provider package ${target.providerPackage.providerShipmentId} order ${target.orderId}`,
    );
  }
  if (matches.length === 1) {
    const row = matches[0];
    const id = asPositiveInteger(row.id, "target shipment id");
    if (
      Number(row.order_id) !== target.orderId
      || String(row.status) !== "shipped"
      || String(row.tracking_number ?? "") !== target.providerPackage.trackingNumber
      || (row.external_fulfillment_id != null && String(row.external_fulfillment_id) !== target.identity)
    ) {
      throw repairError(
        "TARGET_PACKAGE_IDENTITY_CONFLICT",
        `Existing WMS shipment ${id} conflicts with provider package ${target.providerPackage.providerShipmentId}`,
      );
    }
    await client.query(
      `UPDATE wms.outbound_shipments
       SET external_fulfillment_id = COALESCE(external_fulfillment_id, $2),
           shipping_engine = COALESCE(NULLIF(BTRIM(shipping_engine), ''), 'shipstation'),
           engine_order_ref = COALESCE(NULLIF(BTRIM(engine_order_ref), ''), $3),
           engine_shipment_ref = COALESCE(NULLIF(BTRIM(engine_shipment_ref), ''), $4),
           shipstation_order_id = COALESCE(shipstation_order_id, $5),
           shipstation_order_key = COALESCE(NULLIF(BTRIM(shipstation_order_key), ''), $6),
           requires_review = false, review_reason = NULL, updated_at = $7
       WHERE id = $1`,
      [id, target.identity, String(target.providerPackage.providerOrderId),
       String(target.providerPackage.providerShipmentId), target.providerPackage.providerOrderId,
       target.providerPackage.providerOrderKey, audit.occurredAt],
    );
    return id;
  }

  const inserted = await client.query(
    `INSERT INTO wms.outbound_shipments (
       order_id, channel_id, external_fulfillment_id, source, status,
       carrier, service_code, tracking_number, shipped_at,
       shipping_engine, engine_order_ref, engine_shipment_ref,
       shipstation_order_id, shipstation_order_key,
       shipment_purpose, requires_review, review_reason, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, 'shipped', $5, $6, $7, $8,
       'shipstation', $9, $10, $11, $12,
       'customer_fulfillment', false, NULL, $13, $13
     ) RETURNING id`,
    [target.orderId, target.channelId, target.identity, HISTORICAL_SPLIT_REPAIR_SOURCE,
     target.providerPackage.carrierCode, target.providerPackage.serviceCode,
     target.providerPackage.trackingNumber, target.providerPackage.shippedAt,
     String(target.providerPackage.providerOrderId), String(target.providerPackage.providerShipmentId),
     target.providerPackage.providerOrderId, target.providerPackage.providerOrderKey,
     audit.occurredAt],
  );
  return asPositiveInteger(rowsOf<Record<string, unknown>>(inserted)[0]?.id, "inserted shipment id");
}

async function insertCopiedAllocation(
  client: PoolClient,
  sourceItemId: number,
  targetShipmentId: number,
  quantity: number,
  providerShipmentId: number,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO wms.outbound_shipment_items (
       shipment_id, order_item_id, replacement_for_order_item_id,
       shipment_item_purpose, product_variant_id, qty,
       from_location_id, box_id, weight_oz, tracking_id,
       provider_membership_state, created_at
     )
     SELECT $2, order_item_id, replacement_for_order_item_id,
       shipment_item_purpose, product_variant_id, $3,
       from_location_id, box_id, weight_oz, $4, 'authoritative', NOW()
     FROM wms.outbound_shipment_items WHERE id = $1
     RETURNING id`,
    [sourceItemId, targetShipmentId, quantity, String(providerShipmentId)],
  );
  if (rowsOf(inserted).length !== 1) {
    throw repairError("SOURCE_ITEM_COPY_FAILED", `WMS shipment item ${sourceItemId} could not be copied atomically`);
  }
}

async function applySourceAllocations(
  client: PoolClient,
  source: SourceItemRow,
  allocations: readonly TargetAllocation[],
): Promise<void> {
  const sorted = [...allocations].sort((left, right) =>
    left.providerShipmentId - right.providerShipmentId || left.targetShipmentId - right.targetShipmentId
  );
  const total = sorted.reduce((sum, allocation) => sum + allocation.quantity, 0);
  if (total > source.qty) {
    throw repairError(
      "SOURCE_QUANTITY_EXCEEDED",
      `Provider packages require ${total} units from WMS shipment item ${source.id}, but only ${source.qty} remain`,
    );
  }
  const resident = sorted.find((allocation) => allocation.targetShipmentId === source.shipment_id);
  const outbound = sorted.filter((allocation) => allocation !== resident);

  if (resident) {
    if (source.qty - outbound.reduce((sum, item) => sum + item.quantity, 0) !== resident.quantity) {
      throw repairError(
        "RESIDENT_PACKAGE_QUANTITY_CONFLICT",
        `Existing package ${source.shipment_id} cannot prove exact quantity for source item ${source.id}`,
      );
    }
    for (const allocation of outbound) {
      await insertCopiedAllocation(client, source.id, allocation.targetShipmentId,
        allocation.quantity, allocation.providerShipmentId);
    }
    await client.query(
      `UPDATE wms.outbound_shipment_items
       SET qty = $2, tracking_id = $3, provider_membership_state = 'authoritative'
       WHERE id = $1`,
      [source.id, resident.quantity, String(resident.providerShipmentId)],
    );
    return;
  }

  if (total < source.qty) {
    for (const allocation of sorted) {
      await insertCopiedAllocation(client, source.id, allocation.targetShipmentId,
        allocation.quantity, allocation.providerShipmentId);
    }
    const reduced = await client.query(
      `UPDATE wms.outbound_shipment_items SET qty = qty - $2
       WHERE id = $1 AND qty = $3 AND qty > $2 RETURNING id`,
      [source.id, total, source.qty],
    );
    if (rowsOf(reduced).length !== 1) {
      throw repairError("SOURCE_ITEM_REDUCTION_FAILED", `WMS shipment item ${source.id} could not be reduced atomically`);
    }
    return;
  }

  const [primary, ...copies] = sorted;
  for (const allocation of copies) {
    await insertCopiedAllocation(client, source.id, allocation.targetShipmentId,
      allocation.quantity, allocation.providerShipmentId);
  }
  const moved = await client.query(
    `UPDATE wms.outbound_shipment_items
     SET shipment_id = $2, qty = $3, tracking_id = $4,
         provider_membership_state = 'authoritative'
     WHERE id = $1 AND shipment_id = $5 AND qty = $6 RETURNING id`,
    [source.id, primary.targetShipmentId, primary.quantity, String(primary.providerShipmentId),
     source.shipment_id, source.qty],
  );
  if (rowsOf(moved).length !== 1) {
    throw repairError("SOURCE_ITEM_MOVE_FAILED", `WMS shipment item ${source.id} could not be moved atomically`);
  }
}

async function resolveRetryRows(
  client: PoolClient,
  retryIds: readonly number[],
  providerShipmentId: number,
  audit: HistoricalSplitRepairAudit,
  disposition: string,
): Promise<void> {
  if (retryIds.length === 0) return;
  const updated = await client.query(
    `UPDATE oms.webhook_retry_queue
     SET status = 'success', next_retry_at = $3,
         payload = payload || jsonb_build_object(
           'historicalSplitRepair', jsonb_build_object(
             'runId', $4, 'operator', $5, 'reason', $6,
             'idempotencyKey', $7, 'providerShipmentId', $2,
             'disposition', $8, 'previousLastError', last_error,
             'resolvedAt', $3
           )
         ),
         last_error = NULL, updated_at = $3
     WHERE id = ANY($1::int[]) AND provider = 'shipstation'
       AND topic = 'SHIP_NOTIFY' AND status = 'dead'
       AND last_error ~ $9 RETURNING id`,
    [retryIds, providerShipmentId, audit.occurredAt, audit.runId, audit.operator,
     audit.reason, audit.idempotencyKey, disposition,
     `shipment ${providerShipmentId}: duplicate key value violates unique constraint "${FAILURE_INDEX_PATTERN}"`],
  );
  if (rowsOf(updated).length !== retryIds.length) {
    throw repairError(
      "RETRY_ROW_PROOF_CHANGED",
      `Expected to resolve ${retryIds.length} retry rows for provider shipment ${providerShipmentId}, resolved ${rowsOf(updated).length}`,
    );
  }
}
async function resolveExceptions(
  client: PoolClient,
  providerShipmentId: number,
  audit: HistoricalSplitRepairAudit,
  resolution: string,
  physicalShipmentId: number | null,
): Promise<void> {
  await client.query(
    `UPDATE wms.reconciliation_exceptions
     SET classification = 'safe_auto_repair', status = 'resolved', severity = 'info',
         details = details || jsonb_build_object(
           'historicalSplitRepair', jsonb_build_object(
             'runId', $2, 'providerShipmentId', $1,
             'physicalShipmentId', $3, 'idempotencyKey', $4,
             'resolvedAt', $5
           )
         ),
         resolved_at = $5, resolved_by = $6, resolution = $7, updated_at = $5
     WHERE external_system = 'shipstation'
       AND external_shipment_ref = $1::text
       AND rule = ANY($8::text[])
       AND status IN ('open', 'acknowledged')`,
    [providerShipmentId, audit.runId, physicalShipmentId, audit.idempotencyKey,
     audit.occurredAt, audit.operator, resolution, UNMAPPED_RULES],
  );
}

async function insertAuditEvents(
  client: PoolClient,
  wmsOrderIds: readonly number[],
  providerShipmentId: number,
  physicalShipmentId: number | null,
  disposition: string,
  audit: HistoricalSplitRepairAudit,
): Promise<void> {
  if (wmsOrderIds.length === 0) return;
  await client.query(
    `INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
     SELECT oms_order.id, 'historical_shipstation_split_repaired',
       jsonb_build_object(
         'runId', $2, 'providerShipmentId', $3,
         'physicalShipmentId', $4, 'disposition', $5,
         'operator', $6, 'reason', $7, 'idempotencyKey', $8,
         'wmsOrderId', wms_order.id
       ), $9
     FROM wms.orders AS wms_order
     JOIN oms.oms_orders AS oms_order
       ON wms_order.oms_fulfillment_order_id ~ '^[0-9]+$'
      AND oms_order.id = wms_order.oms_fulfillment_order_id::bigint
     WHERE wms_order.id = ANY($1::int[])
       AND NOT EXISTS (
         SELECT 1 FROM oms.oms_order_events AS existing
         WHERE existing.order_id = oms_order.id
           AND existing.event_type = 'historical_shipstation_split_repaired'
           AND existing.details->>'idempotencyKey' = $8
           AND existing.details->>'providerShipmentId' = $3::text
       )`,
    [wmsOrderIds, audit.runId, providerShipmentId, physicalShipmentId,
     disposition, audit.operator, audit.reason, audit.idempotencyKey, audit.occurredAt],
  );
}

export function createHistoricalShipStationSplitRepairRepository(
  pool: Pool,
): HistoricalShipStationSplitRepairRepository {
  async function loadRetryCandidates(
    flags: HistoricalSplitRepairFlags,
  ): Promise<readonly HistoricalSplitRetryCandidate[]> {
    const values: unknown[] = [];
    const postFilters: string[] = [];
    if (flags.providerShipmentId !== null) {
      values.push(flags.providerShipmentId);
      postFilters.push(`matched.provider_shipment_id = $${values.length}`);
    }
    let limit = "";
    if (flags.limit !== null) {
      values.push(flags.limit);
      limit = `LIMIT $${values.length}`;
    }
    const result = await pool.query(
      `WITH matched AS (
         SELECT retry.id AS retry_id,
           (REGEXP_MATCH(
             retry.last_error,
             'shipment ([0-9]+): duplicate key value violates unique constraint "${FAILURE_INDEX_PATTERN}"'
           ))[1]::bigint AS provider_shipment_id
         FROM oms.webhook_retry_queue AS retry
         WHERE retry.provider = 'shipstation'
           AND retry.topic = 'SHIP_NOTIFY'
           AND retry.status = 'dead'
           AND retry.last_error ~
             'shipment [0-9]+: duplicate key value violates unique constraint "${FAILURE_INDEX_PATTERN}"'
       )
       SELECT matched.provider_shipment_id,
              ARRAY_AGG(matched.retry_id ORDER BY matched.retry_id) AS retry_ids
       FROM matched
       ${postFilters.length > 0 ? `WHERE ${postFilters.join(" AND ")}` : ""}
       GROUP BY matched.provider_shipment_id
       ORDER BY matched.provider_shipment_id
       ${limit}`,
      values,
    );
    return Object.freeze(rowsOf<Record<string, unknown>>(result).map((row) => Object.freeze({
      providerShipmentId: asPositiveInteger(row.provider_shipment_id, "provider shipment id"),
      retryIds: Object.freeze(numberArray(row.retry_ids)),
    })));
  }

  async function inspectPackages(
    packages: readonly HistoricalSplitRepairPackagePlan[],
  ): Promise<HistoricalSplitInspection> {
    const providerIds = packages.map((plan) => plan.providerPackage.providerShipmentId);
    const canonicalRows = await loadCanonicalRows(pool, providerIds);
    const sourceItemIds = [...new Set(packages.flatMap((plan) =>
      plan.providerPackage.items.map((item) => item.sourceShipmentItemId)
    ))].sort((left, right) => left - right);
    const sourceRows = await loadSourceRows(pool, sourceItemIds, false);
    const alreadyCanonical: HistoricalSplitCanonicalPackage[] = [];
    const validPlans: HistoricalSplitRepairPackagePlan[] = [];
    const resumedProviderIds = new Set<number>();
    const unsafe: HistoricalSplitRepairFailure[] = [];

    for (const plan of packages) {
      const providerId = plan.providerPackage.providerShipmentId;
      const canonical = canonicalRows.get(providerId);
      if (canonical) {
        if (canonical.tracking_number && canonical.tracking_number !== plan.providerPackage.trackingNumber) {
          unsafe.push(immutableFailure(
            [providerId], "CANONICAL_TRACKING_CONFLICT",
            `Canonical physical shipment ${canonical.physical_shipment_id} has tracking ${canonical.tracking_number}, not ${plan.providerPackage.trackingNumber}`,
          ));
          continue;
        }
        if (canonical.legacy_wms_shipment_ids.length === 0 || canonical.wms_order_ids.length === 0) {
          unsafe.push(immutableFailure(
            [providerId], "CANONICAL_LEGACY_LINK_MISSING",
            `Canonical physical shipment ${canonical.physical_shipment_id} lacks legacy WMS package lineage`,
          ));
          continue;
        }
        alreadyCanonical.push(Object.freeze({
          packagePlan: plan,
          applied: Object.freeze({
            providerShipmentId: providerId,
            legacyWmsShipmentIds: Object.freeze(canonical.legacy_wms_shipment_ids),
            wmsOrderIds: Object.freeze(canonical.wms_order_ids),
          }),
          materialized: Object.freeze({
            physicalShipmentId: canonical.physical_shipment_id,
            channelCommandCount: canonical.channel_command_count,
          }),
        }));
        continue;
      }

      const errors: string[] = [];
      const canonicalSourceIds: number[] = [];
      for (const item of plan.providerPackage.items) {
        const source = sourceRows.get(item.sourceShipmentItemId);
        if (!source) {
          errors.push(`source WMS shipment item ${item.sourceShipmentItemId} is missing`);
          continue;
        }
        if (source.shipment_status !== "shipped") {
          errors.push(`source WMS shipment ${source.shipment_id} is ${source.shipment_status}, not shipped`);
        }
        if (source.shipment_item_purpose !== "customer_fulfillment") {
          errors.push(`source WMS shipment item ${source.id} purpose is ${source.shipment_item_purpose}`);
        }
        if (!Number.isSafeInteger(source.qty) || source.qty <= 0) {
          errors.push(`source WMS shipment item ${source.id} has invalid quantity ${source.qty}`);
        }
        if (source.canonical_physical_shipment_id !== null) {
          canonicalSourceIds.push(source.id);
        }
      }

      if (errors.length === 0 && canonicalSourceIds.length > 0) {
        const existingTargets = await loadExactExistingTargets(pool, plan, sourceRows);
        if (existingTargets === null) {
          errors.push(
            `source WMS shipment items ${canonicalSourceIds.join(", ")} already belong to another canonical package and this provider package has no exact resumable legacy target`,
          );
        } else {
          resumedProviderIds.add(providerId);
        }
      }

      if (errors.length > 0) {
        unsafe.push(immutableFailure([providerId], "SOURCE_PACKAGE_LINEAGE_UNSAFE", errors.join("; ")));
      } else {
        validPlans.push(plan);
      }
    }

    const safeComponents: HistoricalSplitRepairComponent[] = [];
    for (const component of buildHistoricalSplitRepairComponents(validPlans)) {
      const resumedCount = component.packages.filter((plan) =>
        resumedProviderIds.has(plan.providerPackage.providerShipmentId)
      ).length;
      if (resumedCount > 0 && resumedCount !== component.packages.length) {
        unsafe.push(immutableFailure(
          component.packages.map((plan) => plan.providerPackage.providerShipmentId),
          "PARTIAL_COMPONENT_RESUME_AMBIGUOUS",
          "A connected package component mixes already-reshaped and unreshaped provider packages; automatic mutation is blocked.",
        ));
        continue;
      }
      if (resumedCount === component.packages.length) {
        safeComponents.push(component);
        continue;
      }

      const requiredBySource = new Map<number, number>();
      for (const plan of component.packages) {
        for (const item of plan.providerPackage.items) {
          requiredBySource.set(item.sourceShipmentItemId,
            (requiredBySource.get(item.sourceShipmentItemId) ?? 0) + item.quantity);
        }
      }
      const conflicts: string[] = [];
      for (const [sourceId, required] of requiredBySource) {
        const source = sourceRows.get(sourceId)!;
        if (required > source.qty) {
          conflicts.push(
            `provider packages require ${required} units from WMS shipment item ${sourceId}, but only ${source.qty} remain`,
          );
        }
        if (required < source.qty && (!source.external_fulfillment_id || !source.tracking_number)) {
          conflicts.push(
            `WMS shipment item ${sourceId} would leave ${source.qty - required} units without stable residual package identity`,
          );
        }
      }
      if (conflicts.length > 0) {
        unsafe.push(immutableFailure(
          component.packages.map((plan) => plan.providerPackage.providerShipmentId),
          "COMPONENT_QUANTITY_PROOF_FAILED", conflicts.join("; "),
        ));
      } else {
        safeComponents.push(component);
      }
    }

    return Object.freeze({
      alreadyCanonical: Object.freeze(alreadyCanonical),
      repairableComponents: Object.freeze(safeComponents),
      unsafe: Object.freeze(unsafe),
    });
  }
  async function applyComponent(
    component: HistoricalSplitRepairComponent,
    audit: HistoricalSplitRepairAudit,
  ): Promise<readonly HistoricalSplitAppliedPackage[]> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const sourceIds = [...new Set(component.packages.flatMap((plan) =>
        plan.providerPackage.items.map((item) => item.sourceShipmentItemId)
      ))].sort((left, right) => left - right);
      const sources = await loadSourceRows(client, sourceIds, true);
      if (sources.size !== sourceIds.length) {
        throw repairError(
          "SOURCE_ITEM_SET_CHANGED",
          `Component ${component.componentKey} lost source WMS shipment items after inspection`,
        );
      }
      const orderIds = [...new Set([...sources.values()].map((row) => row.order_id))]
        .sort((left, right) => left - right);
      for (const orderId of orderIds) {
        await client.query("SELECT pg_advisory_xact_lock(918406, $1)", [orderId]);
      }

      const targets = component.packages.flatMap((plan) =>
        buildTargetPlansForPackage(plan, sources)
      );
      targets.sort((left, right) =>
        left.providerPackage.providerShipmentId - right.providerPackage.providerShipmentId
        || left.orderId - right.orderId
      );
      for (const target of targets) {
        target.targetShipmentId = await resolveOrCreateTarget(client, target, audit);
      }

      const allTargetsExact = (
        await Promise.all(targets.map((target) => exactTargetMembership(client, target)))
      ).every(Boolean);
      if (!allTargetsExact) {
        const allocationsBySource = new Map<number, TargetAllocation[]>();
        for (const target of targets) {
          for (const expected of target.expectedSourceItems) {
            const existing = allocationsBySource.get(expected.sourceShipmentItemId) ?? [];
            existing.push({
              providerShipmentId: target.providerPackage.providerShipmentId,
              sourceShipmentItemId: expected.sourceShipmentItemId,
              quantity: expected.quantity,
              orderId: target.orderId,
              targetShipmentId: target.targetShipmentId!,
            });
            allocationsBySource.set(expected.sourceShipmentItemId, existing);
          }
        }
        for (const sourceId of [...allocationsBySource.keys()].sort((a, b) => a - b)) {
          await applySourceAllocations(client, sources.get(sourceId)!, allocationsBySource.get(sourceId)!);
        }
      }

      for (const target of targets) {
        if (!(await exactTargetMembership(client, target))) {
          throw repairError(
            "TARGET_PACKAGE_MEMBERSHIP_MISMATCH",
            `WMS shipment ${target.targetShipmentId} does not exactly match provider package ${target.providerPackage.providerShipmentId}`,
          );
        }
      }

      const targetIds = targets.map((target) => target.targetShipmentId!);
      const sourceShipmentIds = [...new Set([...sources.values()].map((source) => source.shipment_id))];
      await client.query(
        `UPDATE wms.outbound_shipments AS shipment
         SET status = 'cancelled', requires_review = false,
             review_reason = 'historical_aggregate_repartitioned',
             cancelled_at = COALESCE(cancelled_at, $3), updated_at = $3
         WHERE shipment.id = ANY($1::int[])
           AND NOT (shipment.id = ANY($2::int[]))
           AND shipment.status = 'shipped'
           AND NOT EXISTS (
             SELECT 1 FROM wms.outbound_shipment_items AS item
             WHERE item.shipment_id = shipment.id
           )`,
        [sourceShipmentIds, targetIds, audit.occurredAt],
      );

      const applied = component.packages.map((plan) => {
        const packageTargets = targets.filter((target) =>
          target.providerPackage.providerShipmentId === plan.providerPackage.providerShipmentId
        );
        return Object.freeze({
          providerShipmentId: plan.providerPackage.providerShipmentId,
          legacyWmsShipmentIds: Object.freeze(
            packageTargets.map((target) => target.targetShipmentId!).sort((a, b) => a - b),
          ),
          wmsOrderIds: Object.freeze(
            packageTargets.map((target) => target.orderId).sort((a, b) => a - b),
          ),
        });
      });
      await client.query("COMMIT");
      return Object.freeze(applied);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function proveProviderPackageLinks(
    applied: HistoricalSplitAppliedPackage,
  ): Promise<number> {
    const expectedShipmentIds = [...new Set(applied.legacyWmsShipmentIds)].sort(
      (left, right) => left - right,
    );
    if (expectedShipmentIds.length === 0) {
      throw repairError(
        "PROVIDER_LABEL_TARGET_SET_EMPTY",
        `Provider shipment ${applied.providerShipmentId} has no repaired WMS package targets`,
      );
    }
    const result = await pool.query(
      `SELECT ARRAY_AGG(DISTINCT link.legacy_wms_shipment_id ORDER BY link.legacy_wms_shipment_id) AS linked_ids
       FROM wms.shipping_provider_labels AS label
       JOIN wms.shipping_provider_label_links AS link
         ON link.shipping_provider_label_id = label.id
       WHERE label.provider = 'shipstation'
         AND label.provider_label_id = $1
         AND link.legacy_wms_shipment_id = ANY($2::int[])`,
      [String(applied.providerShipmentId), expectedShipmentIds],
    );
    const linkedIds = numberArray(rowsOf<Record<string, unknown>>(result)[0]?.linked_ids);
    if (
      linkedIds.length !== expectedShipmentIds.length
      || linkedIds.some((id, index) => id !== expectedShipmentIds[index])
    ) {
      throw repairError(
        "PROVIDER_LABEL_TARGET_LINKAGE_INCOMPLETE",
        `Provider shipment ${applied.providerShipmentId} links repaired WMS packages [${linkedIds.join(", ")}], expected [${expectedShipmentIds.join(", ")}]`,
      );
    }
    return linkedIds.length;
  }

  async function finalizeRepairedPackage(
    applied: HistoricalSplitAppliedPackage,
    packagePlan: HistoricalSplitRepairPackagePlan,
    physicalShipmentId: number,
    audit: HistoricalSplitRepairAudit,
  ): Promise<void> {
    if (!Number.isSafeInteger(physicalShipmentId) || physicalShipmentId <= 0) {
      throw repairError(
        "CANONICAL_PHYSICAL_SHIPMENT_REQUIRED",
        `Provider shipment ${applied.providerShipmentId} cannot be finalized without a canonical physical shipment`,
      );
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await resolveRetryRows(
        client, packagePlan.retryIds, applied.providerShipmentId, audit,
        "canonical_physical_package_materialized",
      );
      await resolveExceptions(
        client, applied.providerShipmentId, audit,
        "Historical ShipStation split package was reconstructed from exact provider line quantities and materialized through canonical fulfillment authority.",
        physicalShipmentId,
      );
      if (applied.legacyWmsShipmentIds.length > 0) {
        await client.query(
          `UPDATE wms.outbound_shipments
           SET requires_review = false, review_reason = NULL, updated_at = $2
           WHERE id = ANY($1::int[])
             AND review_reason = ANY($3::text[])`,
          [applied.legacyWmsShipmentIds, audit.occurredAt,
           ["shipstation_unmapped_physical_shipment", "ship_notify_no_match"]],
        );
      }
      await insertAuditEvents(
        client, applied.wmsOrderIds, applied.providerShipmentId,
        physicalShipmentId, "canonical_physical_package_materialized", audit,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function finalizeMappedPackage(
    applied: HistoricalSplitAppliedPackage,
    packagePlan: HistoricalSplitRepairPackagePlan,
    reconciliation: HistoricalSplitProviderReconciliationResult,
    audit: HistoricalSplitRepairAudit,
  ): Promise<void> {
    if (!Number.isSafeInteger(reconciliation.providerLabelLinkCount)
        || reconciliation.providerLabelLinkCount <= 0) {
      throw repairError(
        "PROVIDER_LABEL_LINKAGE_REQUIRED",
        `Provider shipment ${applied.providerShipmentId} cannot be finalized without exact provider-label linkage`,
      );
    }
    const disposition = reconciliation.dispatchEvidence === "confirmed"
      ? "provider_label_mapped_dispatch_confirmed"
      : "provider_label_mapped_awaiting_dispatch";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await resolveRetryRows(
        client, packagePlan.retryIds, applied.providerShipmentId, audit, disposition,
      );
      await resolveExceptions(
        client, applied.providerShipmentId, audit,
        "Historical ShipStation split package was reconstructed from exact provider line quantities and linked to immutable provider-label evidence. Carrier tracking remains dispatch authority.",
        null,
      );
      if (applied.legacyWmsShipmentIds.length > 0) {
        await client.query(
          `UPDATE wms.outbound_shipments
           SET requires_review = false, review_reason = NULL, updated_at = $2
           WHERE id = ANY($1::int[])
             AND review_reason = ANY($3::text[])`,
          [applied.legacyWmsShipmentIds, audit.occurredAt,
           ["shipstation_unmapped_physical_shipment", "ship_notify_no_match"]],
        );
      }
      await insertAuditEvents(
        client, applied.wmsOrderIds, applied.providerShipmentId,
        null, disposition, audit,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function finalizeNonOutboundPackage(
    candidate: HistoricalSplitRetryCandidate,
    shipment: ShipStationShipment,
    disposition: "voided" | "return_label",
    audit: HistoricalSplitRepairAudit,
  ): Promise<void> {
    const providerShipmentId = asPositiveInteger(shipment.shipmentId, "provider shipment id");
    if (providerShipmentId !== candidate.providerShipmentId) {
      throw repairError(
        "PROVIDER_SHIPMENT_ID_CONFLICT",
        `Requested provider shipment ${candidate.providerShipmentId}, received ${providerShipmentId}`,
      );
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await resolveRetryRows(client, candidate.retryIds, providerShipmentId, audit, disposition);
      await resolveExceptions(
        client, providerShipmentId, audit,
        disposition === "voided"
          ? "ShipStation confirms the historical label was voided; no outbound fulfillment or inventory mutation was applied."
          : "ShipStation confirms the historical label is return transport; no outbound fulfillment or inventory mutation was applied.",
        null,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    loadRetryCandidates,
    inspectPackages,
    applyComponent,
    proveProviderPackageLinks,
    finalizeMappedPackage,
    finalizeRepairedPackage,
    finalizeNonOutboundPackage,
  });
}