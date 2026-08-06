import { sql } from "drizzle-orm";

import { normalizeTrackingNumber } from "./carrier-tracking.domain";

interface QueryExecutor {
  execute: (query: unknown) => Promise<unknown>;
}

interface TransactionExecutor extends QueryExecutor {
  transaction?: <T>(work: (tx: QueryExecutor) => Promise<T>) => Promise<T>;
}

export interface ShipStationProviderPackageEchoItem {
  lineItemKey?: string | null;
  sku?: string | null;
  quantity?: number | null;
}

export interface ShipStationProviderPackageEchoInput {
  providerShipmentId: number;
  trackingNumber: string;
  expectedWmsOrderId?: number | null;
  shipmentItems: readonly ShipStationProviderPackageEchoItem[];
  source: string;
}

export type ProviderPackageEchoStatus = "matched" | "no_match" | "ambiguous";

export interface ProviderPackageEchoResult {
  status: ProviderPackageEchoStatus;
  reason:
    | "exact_tracking_and_line_authority"
    | "exact_provider_and_legacy_package_identity"
    | "invalid_provider_identity"
    | "provider_lines_not_authoritative"
    | "provider_line_quantity_mismatch"
    | "provider_return_label"
    | "no_matching_physical_package"
    | "multiple_matching_physical_packages"
    | "provider_label_not_observed";
  physicalShipmentId: number | null;
  wmsOrderId: number | null;
  authoritativeLegacyShipmentIds: number[];
  shippingProviderLabelId: number | null;
  linkInserted: boolean;
}

interface ProviderLine {
  shipmentItemId: number;
  quantity: number;
}

interface PhysicalItemRow {
  physical_shipment_id: unknown;
  wms_order_item_id: unknown;
  quantity_shipped: unknown;
  shipment_item_purpose: unknown;
  legacy_wms_shipment_id: unknown;
}

interface LegacyAuthorityItemRow {
  legacy_wms_shipment_id: unknown;
  shipment_item_id: unknown;
  sku: unknown;
  quantity: unknown;
}

function resultRows(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseProviderLines(
  items: readonly ShipStationProviderPackageEchoItem[],
): ProviderLine[] | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const quantities = new Map<number, number>();
  for (const item of items) {
    const match = /^wms-item-([1-9][0-9]*)$/.exec(
      String(item.lineItemKey ?? "").trim(),
    );
    const shipmentItemId = match ? Number(match[1]) : 0;
    const quantity = Number(item.quantity);
    if (
      !Number.isSafeInteger(shipmentItemId)
      || shipmentItemId <= 0
      || !Number.isSafeInteger(quantity)
      || quantity <= 0
    ) {
      return null;
    }
    quantities.set(
      shipmentItemId,
      (quantities.get(shipmentItemId) ?? 0) + quantity,
    );
  }
  return [...quantities.entries()]
    .sort(([left], [right]) => left - right)
    .map(([shipmentItemId, quantity]) => ({ shipmentItemId, quantity }));
}

function sameQuantityMap<TKey>(
  left: ReadonlyMap<TKey, number>,
  right: ReadonlyMap<TKey, number>,
): boolean {
  return left.size === right.size
    && [...left.entries()].every(
      ([orderItemId, quantity]) => right.get(orderItemId) === quantity,
    );
}

function parseProviderSkuQuantities(
  items: readonly ShipStationProviderPackageEchoItem[],
): Map<string, number> | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const quantities = new Map<string, number>();
  for (const item of items) {
    const sku = String(item.sku ?? "").trim().toUpperCase();
    const quantity = Number(item.quantity);
    if (!sku || !Number.isSafeInteger(quantity) || quantity <= 0) return null;
    quantities.set(sku, (quantities.get(sku) ?? 0) + quantity);
  }
  return quantities;
}

function noMatch(
  reason: ProviderPackageEchoResult["reason"],
): ProviderPackageEchoResult {
  return {
    status: "no_match",
    reason,
    physicalShipmentId: null,
    wmsOrderId: null,
    authoritativeLegacyShipmentIds: [],
    shippingProviderLabelId: null,
    linkInserted: false,
  };
}

async function inspectExactLegacyProviderPackageIdentity(
  db: QueryExecutor,
  input: {
    providerShipmentId: number;
    normalizedTracking: string;
    expectedWmsOrderId: number | null;
    shipmentItems: readonly ShipStationProviderPackageEchoItem[];
  },
): Promise<ProviderPackageEchoResult | null> {
  const result: any = await db.execute(sql`
    SELECT DISTINCT
      label.id AS shipping_provider_label_id,
      legacy_shipment.id AS legacy_wms_shipment_id,
      legacy_shipment.order_id AS wms_order_id
    FROM wms.shipping_provider_labels AS label
    JOIN wms.shipping_provider_label_links AS label_link
      ON label_link.shipping_provider_label_id = label.id
     AND label_link.legacy_wms_shipment_id IS NOT NULL
    JOIN wms.outbound_shipments AS legacy_shipment
      ON legacy_shipment.id = label_link.legacy_wms_shipment_id
    WHERE label.provider = 'shipstation'
      AND label.provider_label_id = ${String(input.providerShipmentId)}
      AND label.label_direction = 'outbound'
      AND label.label_status IN ('active', 'unknown')
      AND label.voided_at IS NULL
      AND label.normalized_tracking_number = ${input.normalizedTracking}
      AND legacy_shipment.status = 'shipped'
      AND (
        legacy_shipment.external_fulfillment_id =
          ${`shipstation_shipment:${input.providerShipmentId}`}
        OR legacy_shipment.external_fulfillment_id = CONCAT(
          'shipstation_combined:',
          ${String(input.providerShipmentId)},
          ':order:',
          legacy_shipment.order_id::text
        )
      )
      AND UPPER(
        REGEXP_REPLACE(
          COALESCE(legacy_shipment.tracking_number, ''),
          '[^A-Za-z0-9]',
          '',
          'g'
        )
      ) = ${input.normalizedTracking}
    ORDER BY legacy_shipment.id
  `);
  const rows = resultRows(result);
  if (rows.length === 0) return null;

  const candidateShipmentIds = [
    ...new Set(rows.map((row) => Number(row.legacy_wms_shipment_id))),
  ].filter((id) => Number.isSafeInteger(id) && id > 0);
  if (candidateShipmentIds.length === 0) return null;
  const providerItemQuantities = parseProviderLines(input.shipmentItems);
  const providerSkuQuantities = parseProviderSkuQuantities(input.shipmentItems);
  if (!providerItemQuantities && !providerSkuQuantities) return null;

  const authorityResult: any = await db.execute(sql`
    SELECT
      shipment.id AS legacy_wms_shipment_id,
      shipment_item.id AS shipment_item_id,
      UPPER(BTRIM(COALESCE(order_item.sku, catalog_variant.sku, ''))) AS sku,
      shipment_item.qty AS quantity
    FROM wms.outbound_shipments AS shipment
    JOIN wms.outbound_shipment_items AS shipment_item
      ON shipment_item.shipment_id = shipment.id
     AND shipment_item.qty > 0
    LEFT JOIN wms.order_items AS order_item
      ON order_item.id = COALESCE(
        shipment_item.order_item_id,
        shipment_item.replacement_for_order_item_id
      )
    LEFT JOIN catalog.product_variants AS catalog_variant
      ON catalog_variant.id = shipment_item.product_variant_id
    WHERE shipment.id IN (
      ${sql.join(candidateShipmentIds.map((id) => sql`${id}`), sql`, `)}
    )
      AND COALESCE(shipment.requires_review, false) = false
    ORDER BY shipment.id, shipment_item.id
  `);

  const wmsOrderIds = new Set(
    rows.map((row) => Number(row.wms_order_id)),
  );
  const shippingProviderLabelIds = new Set(
    rows.map((row) => Number(row.shipping_provider_label_id)),
  );
  if (
    [...wmsOrderIds].some((id) => !Number.isSafeInteger(id) || id <= 0)
    || [...shippingProviderLabelIds].some((id) => !Number.isSafeInteger(id) || id <= 0)
    || shippingProviderLabelIds.size !== 1
    || (
      input.expectedWmsOrderId !== null
      && !wmsOrderIds.has(input.expectedWmsOrderId)
    )
    || (input.expectedWmsOrderId === null && wmsOrderIds.size !== 1)
  ) {
    return {
      ...noMatch("multiple_matching_physical_packages"),
      status: "ambiguous",
    };
  }

  const actualByShipmentItemId = new Map<number, number>();
  const actualBySku = new Map<string, number>();
  const authorityShipmentIds = new Set<number>();
  for (const row of resultRows(authorityResult) as LegacyAuthorityItemRow[]) {
    const shipmentId = Number(row.legacy_wms_shipment_id);
    const shipmentItemId = Number(row.shipment_item_id);
    const quantity = Number(row.quantity);
    const sku = String(row.sku ?? "").trim().toUpperCase();
    if (
      !Number.isSafeInteger(shipmentId)
      || shipmentId <= 0
      || !Number.isSafeInteger(shipmentItemId)
      || shipmentItemId <= 0
      || !Number.isSafeInteger(quantity)
      || quantity <= 0
      || !candidateShipmentIds.includes(shipmentId)
    ) {
      return null;
    }
    authorityShipmentIds.add(shipmentId);
    actualByShipmentItemId.set(
      shipmentItemId,
      (actualByShipmentItemId.get(shipmentItemId) ?? 0) + quantity,
    );
    if (sku) {
      actualBySku.set(sku, (actualBySku.get(sku) ?? 0) + quantity);
    }
  }
  if (
    authorityShipmentIds.size !== candidateShipmentIds.length
    || candidateShipmentIds.some((id) => !authorityShipmentIds.has(id))
  ) {
    return null;
  }

  const hasExactItemProof = providerItemQuantities !== null && sameQuantityMap(
    new Map(providerItemQuantities.map((item) => [item.shipmentItemId, item.quantity])),
    actualByShipmentItemId,
  );
  const hasExactSkuProof = providerSkuQuantities !== null && sameQuantityMap(
    providerSkuQuantities,
    actualBySku,
  );
  if (!hasExactItemProof && !hasExactSkuProof) return null;

  const wmsOrderId = input.expectedWmsOrderId ?? [...wmsOrderIds][0];
  return {
    status: "matched",
    reason: "exact_provider_and_legacy_package_identity",
    physicalShipmentId: null,
    wmsOrderId,
    authoritativeLegacyShipmentIds: candidateShipmentIds,
    shippingProviderLabelId: [...shippingProviderLabelIds][0],
    linkInserted: false,
  };
}

export async function inspectShipStationProviderPackageEcho(
  db: QueryExecutor,
  input: ShipStationProviderPackageEchoInput,
): Promise<ProviderPackageEchoResult> {
  requiredPositiveInteger(input.providerShipmentId, "providerShipmentId");
  const expectedWmsOrderId = input.expectedWmsOrderId == null
    ? null
    : requiredPositiveInteger(input.expectedWmsOrderId, "expectedWmsOrderId");
  let normalizedTracking: string;
  try {
    normalizedTracking = normalizeTrackingNumber(input.trackingNumber);
  } catch {
    return noMatch("invalid_provider_identity");
  }

  const exactLegacyPackage = await inspectExactLegacyProviderPackageIdentity(
    db,
    {
      providerShipmentId: input.providerShipmentId,
      normalizedTracking,
      expectedWmsOrderId,
      shipmentItems: input.shipmentItems,
    },
  );
  if (exactLegacyPackage !== null) return exactLegacyPackage;

  const providerLines = parseProviderLines(input.shipmentItems);
  if (!providerLines) return noMatch("provider_lines_not_authoritative");
  const sourceItemIds = providerLines.map((line) => line.shipmentItemId);
  const sourceResult: any = await db.execute(sql`
    SELECT
      source_item.id,
      source_item.order_item_id,
      source_item.qty,
      source_shipment.order_id
    FROM wms.outbound_shipment_items AS source_item
    JOIN wms.outbound_shipments AS source_shipment
      ON source_shipment.id = source_item.shipment_id
    WHERE source_item.id IN (
      ${sql.join(sourceItemIds.map((id) => sql`${id}`), sql`, `)}
    )
    ORDER BY source_item.id
  `);
  const sourceRows = resultRows(sourceResult);
  if (sourceRows.length !== sourceItemIds.length) {
    return noMatch("provider_lines_not_authoritative");
  }
  const sourceById = new Map(sourceRows.map((row) => [Number(row.id), row]));
  const expectedQuantities = new Map<number, number>();
  const sourceWmsOrderIds = new Set<number>();
  for (const providerLine of providerLines) {
    const source = sourceById.get(providerLine.shipmentItemId);
    const orderItemId = Number(source?.order_item_id);
    const sourceQuantity = Number(source?.qty);
    if (
      !Number.isSafeInteger(Number(source?.order_id))
      || Number(source?.order_id) <= 0
      || !Number.isSafeInteger(orderItemId)
      || orderItemId <= 0
      || !Number.isSafeInteger(sourceQuantity)
      || sourceQuantity <= 0
    ) {
      return noMatch("provider_lines_not_authoritative");
    }
    sourceWmsOrderIds.add(Number(source.order_id));
    if (providerLine.quantity !== sourceQuantity) {
      return noMatch("provider_line_quantity_mismatch");
    }
    expectedQuantities.set(
      orderItemId,
      (expectedQuantities.get(orderItemId) ?? 0) + providerLine.quantity,
    );
  }
  if (
    sourceWmsOrderIds.size !== 1
    || (
      expectedWmsOrderId !== null
      && !sourceWmsOrderIds.has(expectedWmsOrderId)
    )
  ) {
    return noMatch("provider_lines_not_authoritative");
  }
  const [wmsOrderId] = sourceWmsOrderIds;

  const physicalResult: any = await db.execute(sql`
    SELECT
      physical.id AS physical_shipment_id,
      physical_item.wms_order_item_id,
      physical_item.quantity_shipped,
      physical_item.shipment_item_purpose,
      legacy_item.shipment_id AS legacy_wms_shipment_id
    FROM wms.physical_shipments AS physical
    JOIN wms.effective_physical_shipment_items AS physical_item
      ON physical_item.physical_shipment_id = physical.id
    LEFT JOIN wms.outbound_shipment_items AS legacy_item
      ON legacy_item.id = physical_item.legacy_wms_shipment_item_id
    WHERE physical.status = 'shipped'
      AND UPPER(
        REGEXP_REPLACE(
          COALESCE(physical.tracking_number, ''),
          '[^A-Za-z0-9]',
          '',
          'g'
        )
      ) = ${normalizedTracking}
    ORDER BY physical.id, physical_item.id
  `);
  const rowsByPhysical = new Map<number, PhysicalItemRow[]>();
  for (const row of resultRows(physicalResult) as PhysicalItemRow[]) {
    const physicalShipmentId = Number(row.physical_shipment_id);
    if (!Number.isSafeInteger(physicalShipmentId) || physicalShipmentId <= 0) {
      continue;
    }
    const existing = rowsByPhysical.get(physicalShipmentId) ?? [];
    existing.push(row);
    rowsByPhysical.set(physicalShipmentId, existing);
  }

  const matches: Array<{
    physicalShipmentId: number;
    legacyWmsShipmentIds: number[];
  }> = [];
  for (const [physicalShipmentId, rows] of rowsByPhysical) {
    const actualQuantities = new Map<number, number>();
    const legacyWmsShipmentIds = new Set<number>();
    let valid = rows.length > 0;
    for (const row of rows) {
      const orderItemId = Number(row.wms_order_item_id);
      const quantity = Number(row.quantity_shipped);
      const purpose = String(row.shipment_item_purpose ?? "");
      if (
        purpose !== "customer_fulfillment"
        || !Number.isSafeInteger(orderItemId)
        || orderItemId <= 0
        || !Number.isSafeInteger(quantity)
        || quantity <= 0
      ) {
        valid = false;
        break;
      }
      actualQuantities.set(
        orderItemId,
        (actualQuantities.get(orderItemId) ?? 0) + quantity,
      );
      const legacyWmsShipmentId = Number(row.legacy_wms_shipment_id);
      if (Number.isSafeInteger(legacyWmsShipmentId) && legacyWmsShipmentId > 0) {
        legacyWmsShipmentIds.add(legacyWmsShipmentId);
      }
    }
    if (valid && sameQuantityMap(expectedQuantities, actualQuantities)) {
      matches.push({
        physicalShipmentId,
        legacyWmsShipmentIds: [...legacyWmsShipmentIds].sort(
          (left, right) => left - right,
        ),
      });
    }
  }
  if (matches.length === 0) return noMatch("no_matching_physical_package");
  if (matches.length > 1) {
    return {
      ...noMatch("multiple_matching_physical_packages"),
      status: "ambiguous",
    };
  }
  const [match] = matches;
  return {
    status: "matched",
    reason: "exact_tracking_and_line_authority",
    physicalShipmentId: match.physicalShipmentId,
    wmsOrderId,
    authoritativeLegacyShipmentIds: match.legacyWmsShipmentIds,
    shippingProviderLabelId: null,
    linkInserted: false,
  };
}

export async function reconcileShipStationProviderPackageEcho(
  db: TransactionExecutor,
  input: ShipStationProviderPackageEchoInput,
): Promise<ProviderPackageEchoResult> {
  const providerShipmentId = requiredPositiveInteger(
    input.providerShipmentId,
    "providerShipmentId",
  );
  const source = String(input.source ?? "").trim();
  if (!source || source.length > 80) {
    throw new Error("source must contain between 1 and 80 characters");
  }
  const work = async (tx: QueryExecutor): Promise<ProviderPackageEchoResult> => {
    const inspected = await inspectShipStationProviderPackageEcho(tx, input);
    if (inspected.status !== "matched") {
      return inspected;
    }
    const labelResult: any = await tx.execute(sql`
      SELECT id, label_status, label_direction
      FROM wms.shipping_provider_labels
      WHERE provider = 'shipstation'
        AND provider_label_id = ${String(providerShipmentId)}
      FOR UPDATE
    `);
    const labelRows = resultRows(labelResult);
    if (labelRows.length !== 1 || String(labelRows[0].label_status) === "voided") {
      return noMatch("provider_label_not_observed");
    }
    if (String(labelRows[0].label_direction) === "return") {
      return noMatch("provider_return_label");
    }
    const shippingProviderLabelId = requiredPositiveInteger(
      labelRows[0].id,
      "shippingProviderLabelId",
    );
    if (
      inspected.shippingProviderLabelId !== null
      && inspected.shippingProviderLabelId !== shippingProviderLabelId
    ) {
      return noMatch("provider_label_not_observed");
    }
    let linkInserted = false;
    if (inspected.physicalShipmentId !== null) {
      const inserted: any = await tx.execute(sql`
        INSERT INTO wms.shipping_provider_label_links (
          shipping_provider_label_id,
          physical_shipment_id,
          source,
          metadata,
          created_at,
          updated_at
        )
        VALUES (
          ${shippingProviderLabelId},
          ${inspected.physicalShipmentId},
          'cross_provider_package_echo',
          ${JSON.stringify({
            source,
            provider: "shipstation",
            providerShipmentId,
            proof: inspected.reason,
          })}::jsonb,
          NOW(),
          NOW()
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      linkInserted = resultRows(inserted).length === 1;
    } else if (inspected.authoritativeLegacyShipmentIds.length === 0) {
      return noMatch("no_matching_physical_package");
    }
    await tx.execute(sql`
      UPDATE wms.shipping_provider_labels
      SET last_link_reconciled_at = NOW(),
          next_link_reconcile_at = NULL,
          link_reconcile_attempts = 0,
          updated_at = NOW()
      WHERE id = ${shippingProviderLabelId}
    `);
    return {
      ...inspected,
      shippingProviderLabelId,
      linkInserted,
    };
  };
  return typeof db.transaction === "function" ? db.transaction(work) : work(db);
}
