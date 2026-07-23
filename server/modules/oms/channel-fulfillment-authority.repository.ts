import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  type ChannelFulfillmentCommand,
  planChannelFulfillmentCommands,
} from "./channel-fulfillment-command";
import {
  evaluateChannelFulfillmentWritebackPolicy,
} from "./channel-fulfillment-authority.policy";

const positiveIntegerSchema = z.number().int().positive();
const optionalIdentifier = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength).nullable().optional();

const materializeInputSchema = z.object({
  legacyWmsShipmentIds: z.array(positiveIntegerSchema).min(1),
  shippingProvider: z.string().trim().min(1).max(40).transform((value) => value.toLowerCase()),
  providerPhysicalShipmentId: z.string().trim().min(1).max(200),
  providerOrderId: optionalIdentifier(200),
  providerOrderKey: optionalIdentifier(200),
  trackingNumber: optionalIdentifier(200),
  carrier: optionalIdentifier(100),
  trackingUrl: z.string().trim().url().max(2_000).nullable().optional(),
  serviceCode: optionalIdentifier(100),
  shippedAt: z.date().nullable().optional(),
  source: z.string().trim().min(1).max(80),
  correlationId: optionalIdentifier(100),
  causationId: optionalIdentifier(100),
  suppressChannelProviders: z.array(
    z.string().trim().min(1).max(40).transform((value) => value.toLowerCase()),
  ).max(20).optional(),
}).strict();

export type MaterializePhysicalPackageInput = z.input<typeof materializeInputSchema>;

export type FulfillmentAuthorityErrorCode =
  | "INVALID_INPUT"
  | "LEGACY_SHIPMENT_NOT_FOUND"
  | "LEGACY_SHIPMENT_NOT_SHIPPED"
  | "PHYSICAL_SHIPMENT_NOT_FOUND"
  | "PACKAGE_IDENTITY_CONFLICT"
  | "PROVIDER_ORDER_IDENTITY_MISSING"
  | "OMS_LINEAGE_MISSING"
  | "CHANNEL_LINE_IDENTITY_MISSING"
  | "FULFILLMENT_AUTHORITY_EXCEEDED"
  | "DUPLICATE_WMS_LINEAGE"
  | "CANONICAL_STATE_CONFLICT"
  | "COMMAND_REQUEST_CONFLICT"
  | "LEASE_OWNERSHIP_LOST";

export class FulfillmentAuthorityError extends Error {
  readonly code: FulfillmentAuthorityErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: FulfillmentAuthorityErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "FulfillmentAuthorityError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export interface MaterializedChannelCommand {
  readonly id: number;
  readonly commandKey: string;
  readonly pushStatus: string;
  readonly replayed: boolean;
}

export interface MaterializePhysicalPackageResult {
  readonly physicalShipmentId: number;
  readonly shippingEngineOrderId: number;
  readonly channelCommands: readonly MaterializedChannelCommand[];
  readonly customerFulfillmentItemCount: number;
  readonly nonCustomerItemCount: number;
}

export interface ResolvedLegacyPhysicalPackage {
  readonly legacyWmsShipmentIds: readonly number[];
  readonly shippingProvider: string;
  readonly providerPhysicalShipmentId: string;
  readonly providerOrderId: string | null;
  readonly providerOrderKey: string | null;
  readonly trackingNumber: string;
  readonly carrier: string;
  readonly trackingUrl: string | null;
  readonly serviceCode: string | null;
  readonly shippedAt: Date | null;
}

export interface ClaimedChannelFulfillmentCommandItem {
  readonly physicalShipmentItemId: number;
  readonly shipmentRequestItemId: number;
  readonly legacyWmsShipmentId: number;
  readonly legacyWmsShipmentItemId: number;
  readonly omsOrderLineId: number;
  readonly channelOrderLineId: string;
  readonly quantity: number;
}

export interface ClaimedChannelFulfillmentCommand {
  readonly id: number;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly omsOrderId: number;
  readonly physicalShipmentId: number;
  readonly channelProvider: string;
  readonly channelFulfillmentScopeKey: string;
  readonly trackingNumber: string;
  readonly carrier: string;
  readonly trackingUrl: string | null;
  readonly shippedAt: Date | null;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly items: readonly ClaimedChannelFulfillmentCommandItem[];
}

export type ChannelFulfillmentAttemptOutcome =
  | "success"
  | "retry_scheduled"
  | "ignored"
  | "review_required"
  | "dead_lettered";

export interface CompleteChannelFulfillmentAttemptInput {
  readonly commandId: number;
  readonly leaseToken: string;
  readonly outcome: ChannelFulfillmentAttemptOutcome;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly nextAttemptAt?: Date | null;
  readonly providerResponseId?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ClaimChannelFulfillmentCommandsInput {
  readonly now: Date;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly limit: number;
  readonly commandIds?: readonly number[];
}

export interface ChannelFulfillmentAuthorityRepository {
  resolveLegacyPhysicalPackage(legacyWmsShipmentId: number): Promise<ResolvedLegacyPhysicalPackage>;
  materializePhysicalPackage(input: MaterializePhysicalPackageInput): Promise<MaterializePhysicalPackageResult>;
  claimCommands(input: ClaimChannelFulfillmentCommandsInput): Promise<readonly ClaimedChannelFulfillmentCommand[]>;
  completeAttempt(input: CompleteChannelFulfillmentAttemptInput): Promise<void>;
}

interface LegacyPackageRow {
  legacy_shipment_id: number;
  wms_order_id: number;
  shipment_status: string;
  shipment_purpose: string;
  persisted_shipping_provider: string | null;
  persisted_provider_order_id: string | null;
  persisted_provider_order_key: string | null;
  persisted_physical_identity: string | null;
  persisted_tracking_number: string | null;
  persisted_carrier: string | null;
  requires_review: boolean | null;
  review_reason: string | null;
  wms_oms_order_ref: string | null;
  oms_order_id: number | null;
  oms_external_order_id: string | null;
  warehouse_id: number | null;
  priority_rank: string | null;
  ship_to_snapshot: Record<string, unknown>;
  legacy_shipment_item_id: number | null;
  shipment_item_purpose: string | null;
  order_item_id: number | null;
  replacement_for_order_item_id: number | null;
  product_variant_id: number | null;
  sku: string | null;
  quantity_shipped: number | null;
  oms_order_line_id: number | null;
  channel_provider: string | null;
  line_fulfillment_provider: string | null;
  channel_order_line_id: string | null;
  oms_order_status: string | null;
  oms_financial_status: string | null;
  paid_quantity: number | null;
  authority_fulfillable_quantity: number | null;
  max_authorized_quantity: number | null;
}

interface CanonicalCustomerItem {
  legacyWmsShipmentId: number;
  legacyWmsShipmentItemId: number;
  wmsOrderId: number;
  wmsOrderItemId: number;
  omsOrderId: number;
  omsOrderLineId: number;
  channelProvider: string;
  channelOrderLineId: string;
  productVariantId: number | null;
  sku: string;
  quantityShipped: number;
  quantityPlanned: number;
  currentAuthorizedQuantity: number;
  warehouseId: number | null;
  priorityRank: string | null;
  shipToSnapshot: Record<string, unknown>;
  lineFulfillmentProvider: string;
  omsOrderStatus: string | null;
  omsFinancialStatus: string | null;
  requiresReview: boolean;
  reviewReason: string | null;
}

interface MaterializedCustomerItem extends CanonicalCustomerItem {
  fulfillmentPlanId: number;
  fulfillmentPlanLineId: number;
  shipmentRequestId: number;
  shipmentRequestItemId: number;
  physicalShipmentItemId: number;
}

const ACTIVE_COMMAND_STATUSES = new Set(["pending", "processing", "retry", "review"]);
function rowsOf<T>(result: any): T[] {
  return Array.isArray(result?.rows) ? result.rows as T[] : [];
}

function firstRow<T>(result: any): T | null {
  return rowsOf<T>(result)[0] ?? null;
}

function asPositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedNullable(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value).trim() || null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toDateOrNull(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildShippingEngineCommandKey(input: {
  provider: string;
  providerOrderId: string | null;
  providerOrderKey: string | null;
}): string {
  const identity = input.providerOrderId
    ? `id:${input.providerOrderId}`
    : `key:${input.providerOrderKey}`;
  const readable = `shipping-order:v1:${input.provider}:${identity}`;
  return readable.length <= 300
    ? readable
    : `shipping-order:v1:${input.provider}:sha256:${hash(identity)}`;
}

export interface ParsedProviderPhysicalShipmentIdentity {
  readonly provider: string;
  readonly providerPhysicalShipmentId: string;
  readonly persistedIdentity: string;
  readonly legacyCombined: boolean;
}

export function buildProviderPhysicalShipmentIdentity(
  providerInput: string,
  providerPhysicalShipmentIdInput: string,
): string {
  const provider = normalizedNullable(providerInput)?.toLowerCase();
  const providerPhysicalShipmentId = normalizedNullable(providerPhysicalShipmentIdInput);
  if (!provider || !/^[a-z0-9_-]+$/.test(provider) || !providerPhysicalShipmentId) {
    throw new FulfillmentAuthorityError(
      "INVALID_INPUT",
      "Provider physical shipment identity is invalid",
      { provider: providerInput, providerPhysicalShipmentId: providerPhysicalShipmentIdInput },
    );
  }
  const identity = `provider_physical:v1:${provider}:${providerPhysicalShipmentId}`;
  if (identity.length > 200) {
    throw new FulfillmentAuthorityError(
      "INVALID_INPUT",
      "Provider physical shipment identity exceeds the legacy persistence limit",
      { provider, identityLength: identity.length, maxLength: 200 },
    );
  }
  return identity;
}

export function parseLegacyProviderPhysicalShipmentId(
  externalFulfillmentId: unknown,
): ParsedProviderPhysicalShipmentIdentity | null {
  const value = normalizedNullable(externalFulfillmentId);
  if (!value) return null;

  const direct = /^shipstation_shipment:(\d+)$/.exec(value);
  if (direct) {
    return {
      provider: "shipstation",
      providerPhysicalShipmentId: direct[1],
      persistedIdentity: value,
      legacyCombined: false,
    };
  }

  const combined = /^shipstation_combined:(\d+):order:\d+$/.exec(value);
  if (combined) {
    return {
      provider: "shipstation",
      providerPhysicalShipmentId: combined[1],
      persistedIdentity: value,
      legacyCombined: true,
    };
  }

  const providerNeutral = /^provider_physical:v1:([a-z0-9_-]+):(.+)$/.exec(value);
  if (providerNeutral) {
    return {
      provider: providerNeutral[1],
      providerPhysicalShipmentId: providerNeutral[2],
      persistedIdentity: value,
      legacyCombined: false,
    };
  }

  return null;
}

function buildIdList(values: readonly number[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

function canonicalizeInput(input: MaterializePhysicalPackageInput) {
  const parsed = materializeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new FulfillmentAuthorityError(
      "INVALID_INPUT",
      "Physical package materialization input is invalid",
      { issues: parsed.error.issues },
    );
  }

  const legacyWmsShipmentIds = [...new Set(parsed.data.legacyWmsShipmentIds)].sort((a, b) => a - b);
  return {
    ...parsed.data,
    legacyWmsShipmentIds,
    providerOrderId: parsed.data.providerOrderId ?? null,
    providerOrderKey: parsed.data.providerOrderKey ?? null,
    trackingNumber: parsed.data.trackingNumber ?? null,
    carrier: parsed.data.carrier ?? null,
    trackingUrl: parsed.data.trackingUrl ?? null,
    serviceCode: parsed.data.serviceCode ?? null,
    shippedAt: parsed.data.shippedAt ?? null,
    correlationId: parsed.data.correlationId ?? null,
    causationId: parsed.data.causationId ?? null,
    suppressChannelProviders: Object.freeze(
      [...new Set(parsed.data.suppressChannelProviders ?? [])].sort(),
    ),
  };
}

function assertCompatibleIdentity(
  field: string,
  persisted: unknown,
  incoming: string | null,
  legacyShipmentId: number,
): void {
  const normalizedPersisted = normalizedNullable(persisted);
  if (normalizedPersisted && incoming && normalizedPersisted !== incoming) {
    throw new FulfillmentAuthorityError(
      "PACKAGE_IDENTITY_CONFLICT",
      `Legacy shipment ${legacyShipmentId} has conflicting ${field}`,
      { field, legacyShipmentId, persisted: normalizedPersisted, incoming },
    );
  }
}

function normalizeCustomerItems(rows: readonly LegacyPackageRow[]): {
  customerItems: CanonicalCustomerItem[];
  nonCustomerRows: LegacyPackageRow[];
} {
  const customerItems: CanonicalCustomerItem[] = [];
  const nonCustomerRows: LegacyPackageRow[] = [];
  const orderItemToOmsLine = new Map<number, number>();

  for (const row of rows) {
    if (row.legacy_shipment_item_id === null) continue;
    const purpose = normalizedNullable(row.shipment_item_purpose) ?? "customer_fulfillment";
    if (purpose !== "customer_fulfillment") {
      nonCustomerRows.push(row);
      continue;
    }

    const legacyWmsShipmentItemId = asPositiveInteger(row.legacy_shipment_item_id);
    const wmsOrderItemId = asPositiveInteger(row.order_item_id);
    const omsOrderId = asPositiveInteger(row.oms_order_id);
    const omsOrderLineId = asPositiveInteger(row.oms_order_line_id);
    const quantityShipped = asPositiveInteger(row.quantity_shipped);
    const quantityPlanned = asPositiveInteger(row.max_authorized_quantity);
    const currentAuthorizedQuantity = Number(row.authority_fulfillable_quantity ?? 0);
    const channelProvider = normalizedNullable(row.channel_provider)?.toLowerCase() ?? null;
    const channelOrderLineId = normalizedNullable(row.channel_order_line_id);
    const lineFulfillmentProvider = (
      normalizedNullable(row.line_fulfillment_provider)?.toLowerCase()
      ?? channelProvider
    );
    const sku = normalizedNullable(row.sku);
    const reviewReason = normalizedNullable(row.review_reason);

    if (
      !legacyWmsShipmentItemId
      || !wmsOrderItemId
      || !omsOrderId
      || !omsOrderLineId
      || !quantityShipped
      || !sku
    ) {
      throw new FulfillmentAuthorityError(
        "OMS_LINEAGE_MISSING",
        `Customer fulfillment item ${row.legacy_shipment_item_id ?? "unknown"} lacks exact OMS/WMS lineage`,
        { legacyShipmentId: row.legacy_shipment_id, legacyShipmentItemId: row.legacy_shipment_item_id },
      );
    }
    if (!channelProvider || !channelOrderLineId) {
      throw new FulfillmentAuthorityError(
        "CHANNEL_LINE_IDENTITY_MISSING",
        `Customer fulfillment item ${legacyWmsShipmentItemId} lacks channel line identity`,
        {
          legacyShipmentId: row.legacy_shipment_id,
          legacyShipmentItemId: legacyWmsShipmentItemId,
          omsOrderLineId,
        },
      );
    }
    if (!quantityPlanned || quantityShipped > quantityPlanned) {
      throw new FulfillmentAuthorityError(
        "FULFILLMENT_AUTHORITY_EXCEEDED",
        `Shipment item ${legacyWmsShipmentItemId} exceeds proven paid authority`,
        {
          legacyShipmentId: row.legacy_shipment_id,
          legacyShipmentItemId: legacyWmsShipmentItemId,
          quantityShipped,
          paidQuantity: row.paid_quantity,
          maxAuthorizedQuantity: row.max_authorized_quantity,
        },
      );
    }
    if (
      !Number.isInteger(currentAuthorizedQuantity)
      || currentAuthorizedQuantity < 0
      || (quantityPlanned !== null && currentAuthorizedQuantity > quantityPlanned)
    ) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `OMS line ${omsOrderLineId} has invalid current fulfillment authority`,
        {
          omsOrderLineId,
          authorityFulfillableQuantity: row.authority_fulfillable_quantity,
          lifetimeAuthorizedQuantity: quantityPlanned,
        },
      );
    }
    const wmsOmsOrderRef = normalizedNullable(row.wms_oms_order_ref);
    const omsExternalOrderId = normalizedNullable(row.oms_external_order_id);
    if (/^[0-9]+$/.test(wmsOmsOrderRef ?? "") && Number(wmsOmsOrderRef) !== omsOrderId) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `WMS order ${row.wms_order_id} points to another OMS order`,
        { wmsOrderId: row.wms_order_id, wmsOmsOrderRef, omsOrderId },
      );
    }
    if (
      wmsOmsOrderRef?.startsWith("gid://")
      && omsExternalOrderId
      && wmsOmsOrderRef !== omsExternalOrderId
    ) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `WMS order ${row.wms_order_id} points to another channel order`,
        { wmsOrderId: row.wms_order_id, wmsOmsOrderRef, omsExternalOrderId },
      );
    }

    const existingOmsLine = orderItemToOmsLine.get(wmsOrderItemId);
    if (existingOmsLine && existingOmsLine !== omsOrderLineId) {
      throw new FulfillmentAuthorityError(
        "DUPLICATE_WMS_LINEAGE",
        `WMS order item ${wmsOrderItemId} maps to multiple OMS lines`,
        { wmsOrderItemId, omsOrderLineIds: [existingOmsLine, omsOrderLineId] },
      );
    }
    orderItemToOmsLine.set(wmsOrderItemId, omsOrderLineId);

    customerItems.push({
      legacyWmsShipmentId: Number(row.legacy_shipment_id),
      legacyWmsShipmentItemId,
      wmsOrderId: Number(row.wms_order_id),
      wmsOrderItemId,
      omsOrderId,
      omsOrderLineId,
      channelProvider,
      channelOrderLineId,
      productVariantId: asPositiveInteger(row.product_variant_id),
      sku,
      quantityShipped,
      quantityPlanned,
      currentAuthorizedQuantity,
      warehouseId: asPositiveInteger(row.warehouse_id),
      priorityRank: normalizedNullable(row.priority_rank),
      shipToSnapshot: row.ship_to_snapshot ?? {},
      lineFulfillmentProvider: lineFulfillmentProvider ?? channelProvider,
      omsOrderStatus: normalizedNullable(row.oms_order_status),
      omsFinancialStatus: normalizedNullable(row.oms_financial_status),
      requiresReview: row.requires_review === true,
      reviewReason,
    });
  }

  return { customerItems, nonCustomerRows };
}

async function acquireIdentityLocks(
  tx: any,
  provider: string,
  providerOrderIdentity: string,
  providerPhysicalShipmentId: string,
): Promise<void> {
  const keys = [
    `fulfillment:provider-order:${provider}:${providerOrderIdentity}`,
    `fulfillment:physical-package:${provider}:${providerPhysicalShipmentId}`,
  ].sort();
  for (const key of keys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

async function findOrCreatePlan(
  tx: any,
  item: CanonicalCustomerItem,
  source: string,
): Promise<number> {
  const existing = firstRow<{ id: number; oms_order_id: number }>(await tx.execute(sql`
    SELECT id, oms_order_id
    FROM wms.fulfillment_plans
    WHERE wms_order_id = ${item.wmsOrderId}
      AND plan_status = 'active'
    FOR UPDATE
  `));
  if (existing) {
    if (Number(existing.oms_order_id) !== item.omsOrderId) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `Active fulfillment plan for WMS order ${item.wmsOrderId} points to another OMS order`,
        { wmsOrderId: item.wmsOrderId, expectedOmsOrderId: item.omsOrderId, actualOmsOrderId: existing.oms_order_id },
      );
    }
    return Number(existing.id);
  }

  const inserted = firstRow<{ id: number }>(await tx.execute(sql`
    INSERT INTO wms.fulfillment_plans (
      oms_order_id,
      wms_order_id,
      plan_status,
      planner_version,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      ${item.omsOrderId},
      ${item.wmsOrderId},
      'active',
      'canonical-v1',
      ${JSON.stringify({ contractVersion: 1, source })}::jsonb,
      NOW(),
      NOW()
    )
    RETURNING id
  `));
  if (!inserted) {
    throw new FulfillmentAuthorityError("CANONICAL_STATE_CONFLICT", "Failed to create fulfillment plan");
  }
  return Number(inserted.id);
}

async function findOrCreatePlanLine(
  tx: any,
  item: CanonicalCustomerItem,
  fulfillmentPlanId: number,
): Promise<number> {
  const existing = firstRow<{
    id: number;
    wms_order_item_id: number;
    quantity_planned: number;
    quantity_cancelled: number;
    quantity_shipped: number;
  }>(await tx.execute(sql`
    SELECT id, wms_order_item_id, quantity_planned, quantity_cancelled, quantity_shipped
    FROM wms.fulfillment_plan_lines
    WHERE fulfillment_plan_id = ${fulfillmentPlanId}
      AND oms_order_line_id = ${item.omsOrderLineId}
    FOR UPDATE
  `));
  if (existing) {
    if (Number(existing.wms_order_item_id) !== item.wmsOrderItemId) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `Fulfillment plan line ${existing.id} conflicts with current authority lineage`,
        {
          fulfillmentPlanLineId: existing.id,
          expectedWmsOrderItemId: item.wmsOrderItemId,
          actualWmsOrderItemId: existing.wms_order_item_id,
        },
      );
    }

    const persistedPlanned = Number(existing.quantity_planned);
    const persistedShipped = Number(existing.quantity_shipped);
    if (persistedPlanned > item.quantityPlanned || persistedShipped > item.quantityPlanned) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `Fulfillment plan line ${existing.id} exceeds current lifetime authority`,
        {
          fulfillmentPlanLineId: existing.id,
          persistedQuantityPlanned: persistedPlanned,
          persistedQuantityShipped: persistedShipped,
          lifetimeAuthorizedQuantity: item.quantityPlanned,
        },
      );
    }

    const quantityCancelled = item.quantityPlanned - item.currentAuthorizedQuantity;
    if (
      persistedPlanned !== item.quantityPlanned
      || Number(existing.quantity_cancelled) !== quantityCancelled
    ) {
      await tx.execute(sql`
        UPDATE wms.fulfillment_plan_lines
        SET quantity_planned = ${item.quantityPlanned},
            quantity_cancelled = ${quantityCancelled},
            authority_snapshot = ${JSON.stringify({
              contractVersion: 1,
              lifetimeAuthorizedQuantity: item.quantityPlanned,
              currentAuthorizedQuantity: item.currentAuthorizedQuantity,
              channelOrderLineId: item.channelOrderLineId,
            })}::jsonb,
            updated_at = NOW()
        WHERE id = ${Number(existing.id)}
      `);
    }
    return Number(existing.id);
  }

  const quantityCancelled = item.quantityPlanned - item.currentAuthorizedQuantity;

  const inserted = firstRow<{ id: number }>(await tx.execute(sql`
    INSERT INTO wms.fulfillment_plan_lines (
      fulfillment_plan_id,
      oms_order_line_id,
      wms_order_item_id,
      product_variant_id,
      sku,
      quantity_planned,
      quantity_cancelled,
      quantity_shipped,
      line_status,
      authority_snapshot,
      created_at,
      updated_at
    ) VALUES (
      ${fulfillmentPlanId},
      ${item.omsOrderLineId},
      ${item.wmsOrderItemId},
      ${item.productVariantId},
      ${item.sku},
      ${item.quantityPlanned},
      ${quantityCancelled},
      0,
      'planned',
      ${JSON.stringify({
        contractVersion: 1,
        lifetimeAuthorizedQuantity: item.quantityPlanned,
        currentAuthorizedQuantity: item.currentAuthorizedQuantity,
        channelOrderLineId: item.channelOrderLineId,
      })}::jsonb,
      NOW(),
      NOW()
    )
    RETURNING id
  `));
  if (!inserted) {
    throw new FulfillmentAuthorityError("CANONICAL_STATE_CONFLICT", "Failed to create fulfillment plan line");
  }
  return Number(inserted.id);
}

async function findOrCreateShipmentRequest(
  tx: any,
  item: CanonicalCustomerItem,
  fulfillmentPlanId: number,
  source: string,
): Promise<number> {
  const existing = firstRow<{ id: number; fulfillment_plan_id: number; wms_order_id: number }>(await tx.execute(sql`
    SELECT id, fulfillment_plan_id, wms_order_id
    FROM wms.shipment_requests
    WHERE legacy_wms_shipment_id = ${item.legacyWmsShipmentId}
    FOR UPDATE
  `));
  if (existing) {
    if (
      Number(existing.fulfillment_plan_id) !== fulfillmentPlanId
      || Number(existing.wms_order_id) !== item.wmsOrderId
    ) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `Shipment request ${existing.id} conflicts with legacy shipment ${item.legacyWmsShipmentId}`,
        { legacyWmsShipmentId: item.legacyWmsShipmentId, shipmentRequestId: existing.id },
      );
    }
    await tx.execute(sql`
      UPDATE wms.shipment_requests
      SET request_status = 'shipped', updated_at = NOW()
      WHERE id = ${Number(existing.id)}
    `);
    return Number(existing.id);
  }

  const inserted = firstRow<{ id: number }>(await tx.execute(sql`
    INSERT INTO wms.shipment_requests (
      fulfillment_plan_id,
      wms_order_id,
      warehouse_id,
      legacy_wms_shipment_id,
      request_status,
      priority_rank,
      ship_to_snapshot,
      planner_reason,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      ${fulfillmentPlanId},
      ${item.wmsOrderId},
      ${item.warehouseId},
      ${item.legacyWmsShipmentId},
      'shipped',
      ${item.priorityRank},
      ${JSON.stringify(item.shipToSnapshot)}::jsonb,
      'legacy-runtime-authority-cutover',
      ${JSON.stringify({ contractVersion: 1, source })}::jsonb,
      NOW(),
      NOW()
    )
    RETURNING id
  `));
  if (!inserted) {
    throw new FulfillmentAuthorityError("CANONICAL_STATE_CONFLICT", "Failed to create shipment request");
  }
  return Number(inserted.id);
}

async function findOrCreateRequestItem(
  tx: any,
  item: CanonicalCustomerItem,
  shipmentRequestId: number,
  fulfillmentPlanLineId: number,
): Promise<number> {
  const existing = firstRow<{
    id: number;
    shipment_request_id: number;
    fulfillment_plan_line_id: number;
    quantity_requested: number;
  }>(await tx.execute(sql`
    SELECT id, shipment_request_id, fulfillment_plan_line_id, quantity_requested
    FROM wms.shipment_request_items
    WHERE legacy_wms_shipment_item_id = ${item.legacyWmsShipmentItemId}
    FOR UPDATE
  `));
  if (existing) {
    if (
      Number(existing.shipment_request_id) !== shipmentRequestId
      || Number(existing.fulfillment_plan_line_id) !== fulfillmentPlanLineId
      || Number(existing.quantity_requested) !== item.quantityShipped
    ) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `Shipment request item ${existing.id} conflicts with immutable legacy item ${item.legacyWmsShipmentItemId}`,
        { legacyWmsShipmentItemId: item.legacyWmsShipmentItemId, shipmentRequestItemId: existing.id },
      );
    }
    return Number(existing.id);
  }

  const aggregate = firstRow<{ requested_quantity: number }>(await tx.execute(sql`
    SELECT COALESCE(SUM(quantity_requested - quantity_cancelled), 0)::int AS requested_quantity
    FROM wms.shipment_request_items
    WHERE fulfillment_plan_line_id = ${fulfillmentPlanLineId}
  `));
  const priorRequested = Number(aggregate?.requested_quantity ?? 0);
  if (priorRequested + item.quantityShipped > item.quantityPlanned) {
    throw new FulfillmentAuthorityError(
      "FULFILLMENT_AUTHORITY_EXCEEDED",
      `Shipment requests exceed paid authority for OMS line ${item.omsOrderLineId}`,
      {
        omsOrderLineId: item.omsOrderLineId,
        priorRequested,
        requestedNow: item.quantityShipped,
        quantityPlanned: item.quantityPlanned,
      },
    );
  }

  const inserted = firstRow<{ id: number }>(await tx.execute(sql`
    INSERT INTO wms.shipment_request_items (
      shipment_request_id,
      fulfillment_plan_line_id,
      wms_order_item_id,
      legacy_wms_shipment_item_id,
      quantity_requested,
      quantity_cancelled,
      created_at,
      updated_at
    ) VALUES (
      ${shipmentRequestId},
      ${fulfillmentPlanLineId},
      ${item.wmsOrderItemId},
      ${item.legacyWmsShipmentItemId},
      ${item.quantityShipped},
      0,
      NOW(),
      NOW()
    )
    RETURNING id
  `));
  if (!inserted) {
    throw new FulfillmentAuthorityError("CANONICAL_STATE_CONFLICT", "Failed to create shipment request item");
  }
  return Number(inserted.id);
}

async function findOrCreateShippingEngineOrder(
  tx: any,
  input: ReturnType<typeof canonicalizeInput>,
): Promise<number> {
  const commandKey = buildShippingEngineCommandKey({
    provider: input.shippingProvider,
    providerOrderId: input.providerOrderId,
    providerOrderKey: input.providerOrderKey,
  });
  const existingRows = rowsOf<{ id: number; provider_order_id: string | null; provider_order_key: string | null }>(await tx.execute(sql`
    SELECT id, provider_order_id, provider_order_key
    FROM wms.shipping_engine_orders
    WHERE provider = ${input.shippingProvider}
      AND (
        (${input.providerOrderId}::text IS NOT NULL AND provider_order_id = ${input.providerOrderId})
        OR (${input.providerOrderKey}::text IS NOT NULL AND provider_order_key = ${input.providerOrderKey})
        OR command_key = ${commandKey}
      )
    FOR UPDATE
  `));
  if (existingRows.length > 1) {
    throw new FulfillmentAuthorityError(
      "CANONICAL_STATE_CONFLICT",
      "Provider order identities resolve to multiple canonical shipping-engine orders",
      { provider: input.shippingProvider, providerOrderId: input.providerOrderId, providerOrderKey: input.providerOrderKey },
    );
  }
  const existing = existingRows[0];
  if (existing) {
    assertCompatibleIdentity("providerOrderId", existing.provider_order_id, input.providerOrderId, input.legacyWmsShipmentIds[0]);
    assertCompatibleIdentity("providerOrderKey", existing.provider_order_key, input.providerOrderKey, input.legacyWmsShipmentIds[0]);
    await tx.execute(sql`
      UPDATE wms.shipping_engine_orders
      SET provider_status = 'shipped', last_sync_at = NOW(), updated_at = NOW()
      WHERE id = ${Number(existing.id)}
    `);
    return Number(existing.id);
  }

  const inserted = firstRow<{ id: number }>(await tx.execute(sql`
    INSERT INTO wms.shipping_engine_orders (
      shipment_request_id,
      provider,
      command_key,
      provider_order_id,
      provider_order_key,
      provider_status,
      last_sync_at,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      NULL,
      ${input.shippingProvider},
      ${commandKey},
      ${input.providerOrderId},
      ${input.providerOrderKey},
      'shipped',
      NOW(),
      ${JSON.stringify({ contractVersion: 1, source: input.source })}::jsonb,
      NOW(),
      NOW()
    )
    RETURNING id
  `));
  if (!inserted) {
    throw new FulfillmentAuthorityError("CANONICAL_STATE_CONFLICT", "Failed to create shipping-engine order");
  }
  return Number(inserted.id);
}

async function linkShippingEngineRequests(
  tx: any,
  shippingEngineOrderId: number,
  shipmentRequestIds: readonly number[],
): Promise<void> {
  for (const shipmentRequestId of [...new Set(shipmentRequestIds)]) {
    await tx.execute(sql`
      INSERT INTO wms.shipping_engine_order_requests (
        shipping_engine_order_id,
        shipment_request_id,
        relationship_type,
        created_at
      ) VALUES (
        ${shippingEngineOrderId},
        ${shipmentRequestId},
        'primary',
        NOW()
      )
      ON CONFLICT (shipping_engine_order_id, shipment_request_id) DO NOTHING
    `);
  }

  const countRow = firstRow<{ request_count: number; only_request_id: number | null }>(await tx.execute(sql`
    SELECT COUNT(*)::int AS request_count, MIN(shipment_request_id)::bigint AS only_request_id
    FROM wms.shipping_engine_order_requests
    WHERE shipping_engine_order_id = ${shippingEngineOrderId}
  `));
  const requestCount = Number(countRow?.request_count ?? 0);
  await tx.execute(sql`
    UPDATE wms.shipping_engine_order_requests
    SET relationship_type = CASE WHEN ${requestCount} > 1 THEN 'combined' ELSE 'primary' END
    WHERE shipping_engine_order_id = ${shippingEngineOrderId}
  `);
  await tx.execute(sql`
    UPDATE wms.shipping_engine_orders
    SET shipment_request_id = CASE WHEN ${requestCount} = 1 THEN ${countRow?.only_request_id ?? null}::bigint ELSE NULL END,
        updated_at = NOW()
    WHERE id = ${shippingEngineOrderId}
  `);
}

async function findOrCreatePhysicalShipment(
  tx: any,
  input: ReturnType<typeof canonicalizeInput>,
  shippingEngineOrderId: number,
): Promise<number> {
  const existing = firstRow<{
    id: number;
    shipping_engine_order_id: number | null;
    tracking_number: string | null;
    carrier: string | null;
  }>(await tx.execute(sql`
    SELECT id, shipping_engine_order_id, tracking_number, carrier
    FROM wms.physical_shipments
    WHERE provider = ${input.shippingProvider}
      AND provider_physical_shipment_id = ${input.providerPhysicalShipmentId}
    FOR UPDATE
  `));
  if (existing) {
    if (
      existing.shipping_engine_order_id !== null
      && Number(existing.shipping_engine_order_id) !== shippingEngineOrderId
    ) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        "Physical package points to a different shipping-engine order",
        { physicalShipmentId: existing.id, shippingEngineOrderId, actualShippingEngineOrderId: existing.shipping_engine_order_id },
      );
    }
    assertCompatibleIdentity("trackingNumber", existing.tracking_number, input.trackingNumber, input.legacyWmsShipmentIds[0]);
    assertCompatibleIdentity("carrier", existing.carrier, input.carrier, input.legacyWmsShipmentIds[0]);
    return Number(existing.id);
  }

  const inserted = firstRow<{ id: number }>(await tx.execute(sql`
    INSERT INTO wms.physical_shipments (
      shipping_engine_order_id,
      shipment_request_id,
      provider,
      provider_physical_shipment_id,
      tracking_number,
      carrier,
      service_code,
      ship_date,
      status,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      ${shippingEngineOrderId},
      NULL,
      ${input.shippingProvider},
      ${input.providerPhysicalShipmentId},
      ${input.trackingNumber},
      ${input.carrier},
      ${input.serviceCode},
      ${input.shippedAt},
      'shipped',
      ${JSON.stringify({ contractVersion: 1, source: input.source })}::jsonb,
      NOW(),
      NOW()
    )
    RETURNING id
  `));
  if (!inserted) {
    throw new FulfillmentAuthorityError("CANONICAL_STATE_CONFLICT", "Failed to create physical shipment");
  }
  return Number(inserted.id);
}

async function findOrCreatePhysicalCustomerItem(
  tx: any,
  item: Omit<MaterializedCustomerItem, "physicalShipmentItemId">,
  physicalShipmentId: number,
): Promise<number> {
  const existing = firstRow<{
    id: number;
    physical_shipment_id: number;
    shipment_request_item_id: number;
    quantity_shipped: number;
  }>(await tx.execute(sql`
    SELECT id, physical_shipment_id, shipment_request_item_id, quantity_shipped
    FROM wms.physical_shipment_items
    WHERE legacy_wms_shipment_item_id = ${item.legacyWmsShipmentItemId}
    FOR UPDATE
  `));
  if (existing) {
    if (
      Number(existing.physical_shipment_id) !== physicalShipmentId
      || Number(existing.shipment_request_item_id) !== item.shipmentRequestItemId
      || Number(existing.quantity_shipped) !== item.quantityShipped
    ) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `Physical shipment item ${existing.id} conflicts with immutable legacy item ${item.legacyWmsShipmentItemId}`,
        { legacyWmsShipmentItemId: item.legacyWmsShipmentItemId, physicalShipmentItemId: existing.id },
      );
    }
    return Number(existing.id);
  }

  const inserted = firstRow<{ id: number }>(await tx.execute(sql`
    INSERT INTO wms.physical_shipment_items (
      physical_shipment_id,
      shipment_request_item_id,
      fulfillment_plan_line_id,
      wms_order_item_id,
      legacy_wms_shipment_item_id,
      shipment_item_purpose,
      replacement_for_order_item_id,
      product_variant_id,
      sku,
      quantity_shipped,
      created_at
    ) VALUES (
      ${physicalShipmentId},
      ${item.shipmentRequestItemId},
      ${item.fulfillmentPlanLineId},
      ${item.wmsOrderItemId},
      ${item.legacyWmsShipmentItemId},
      'customer_fulfillment',
      NULL,
      ${item.productVariantId},
      ${item.sku},
      ${item.quantityShipped},
      NOW()
    )
    RETURNING id
  `));
  if (!inserted) {
    throw new FulfillmentAuthorityError("CANONICAL_STATE_CONFLICT", "Failed to create physical shipment item");
  }
  return Number(inserted.id);
}

async function materializeNonCustomerItems(
  tx: any,
  rows: readonly LegacyPackageRow[],
  physicalShipmentId: number,
): Promise<number> {
  let count = 0;
  for (const row of rows) {
    const legacyItemId = asPositiveInteger(row.legacy_shipment_item_id);
    const quantity = asPositiveInteger(row.quantity_shipped);
    const sku = normalizedNullable(row.sku);
    const purpose = normalizedNullable(row.shipment_item_purpose);
    if (!legacyItemId || !quantity || !sku || !purpose) {
      throw new FulfillmentAuthorityError(
        "OMS_LINEAGE_MISSING",
        "Non-customer physical item lacks immutable inventory lineage",
        { legacyShipmentItemId: row.legacy_shipment_item_id, purpose },
      );
    }
    if (purpose === "replacement" && !asPositiveInteger(row.replacement_for_order_item_id)) {
      throw new FulfillmentAuthorityError(
        "OMS_LINEAGE_MISSING",
        `Replacement item ${legacyItemId} lacks replacement_for_order_item_id`,
        { legacyShipmentItemId: legacyItemId },
      );
    }

    const existing = firstRow<{ id: number; physical_shipment_id: number; quantity_shipped: number }>(await tx.execute(sql`
      SELECT id, physical_shipment_id, quantity_shipped
      FROM wms.physical_shipment_items
      WHERE legacy_wms_shipment_item_id = ${legacyItemId}
      FOR UPDATE
    `));
    if (existing) {
      if (
        Number(existing.physical_shipment_id) !== physicalShipmentId
        || Number(existing.quantity_shipped) !== quantity
      ) {
        throw new FulfillmentAuthorityError(
          "CANONICAL_STATE_CONFLICT",
          `Non-customer physical item ${legacyItemId} conflicts with prior materialization`,
          { legacyShipmentItemId: legacyItemId, physicalShipmentItemId: existing.id },
        );
      }
      count += 1;
      continue;
    }

    await tx.execute(sql`
      INSERT INTO wms.physical_shipment_items (
        physical_shipment_id,
        shipment_request_item_id,
        fulfillment_plan_line_id,
        wms_order_item_id,
        legacy_wms_shipment_item_id,
        shipment_item_purpose,
        replacement_for_order_item_id,
        product_variant_id,
        sku,
        quantity_shipped,
        created_at
      ) VALUES (
        ${physicalShipmentId}, NULL, NULL, NULL,
        ${legacyItemId},
        ${purpose},
        ${asPositiveInteger(row.replacement_for_order_item_id)},
        ${asPositiveInteger(row.product_variant_id)},
        ${sku},
        ${quantity},
        NOW()
      )
    `);
    count += 1;
  }
  return count;
}

async function recalculatePlanLine(tx: any, fulfillmentPlanLineId: number): Promise<void> {
  const line = firstRow<{
    quantity_planned: number;
    quantity_cancelled: number;
  }>(await tx.execute(sql`
    SELECT
      line.quantity_planned,
      line.quantity_cancelled
    FROM wms.fulfillment_plan_lines AS line
    WHERE line.id = ${fulfillmentPlanLineId}
    FOR UPDATE OF line
  `));
  if (!line) {
    throw new FulfillmentAuthorityError(
      "CANONICAL_STATE_CONFLICT",
      `Failed to recalculate fulfillment plan line ${fulfillmentPlanLineId}`,
      { fulfillmentPlanLineId },
    );
  }

  const aggregate = firstRow<{ calculated_quantity_shipped: number }>(await tx.execute(sql`
    SELECT COALESCE(SUM(item.quantity_shipped), 0)::int AS calculated_quantity_shipped
    FROM wms.physical_shipment_items AS item
    WHERE item.fulfillment_plan_line_id = ${fulfillmentPlanLineId}
      AND item.shipment_item_purpose = 'customer_fulfillment'
  `));

  const quantityPlanned = Number(line.quantity_planned);
  const quantityCancelled = Number(line.quantity_cancelled);
  const quantityShipped = Number(aggregate?.calculated_quantity_shipped ?? 0);
  if (
    !Number.isInteger(quantityShipped)
    || quantityShipped < 0
    || quantityShipped > quantityPlanned
  ) {
    throw new FulfillmentAuthorityError(
      "FULFILLMENT_AUTHORITY_EXCEEDED",
      `Physical shipments exceed lifetime authority for fulfillment plan line ${fulfillmentPlanLineId}`,
      {
        fulfillmentPlanLineId,
        quantityPlanned,
        quantityCancelled,
        quantityShipped,
        lifetimeAuthorizedQuantity: quantityPlanned,
      },
    );
  }

  await tx.execute(sql`
    UPDATE wms.fulfillment_plan_lines
    SET quantity_shipped = ${quantityShipped},
        line_status = CASE
          WHEN ${quantityShipped} >= ${quantityPlanned} THEN 'shipped'
          WHEN ${quantityShipped} > 0 THEN 'partially_shipped'
          WHEN ${quantityCancelled} >= ${quantityPlanned} THEN 'cancelled'
          ELSE 'planned'
        END,
        updated_at = NOW()
    WHERE id = ${fulfillmentPlanLineId}
  `);
}

async function findLineWritebackEligibility(
  tx: any,
  items: readonly MaterializedCustomerItem[],
): Promise<Map<number, boolean>> {
  const eligibility = new Map<number, boolean>();
  const uniqueLines = new Map<number, MaterializedCustomerItem>();
  for (const item of items) uniqueLines.set(item.fulfillmentPlanLineId, item);

  for (const [fulfillmentPlanLineId, item] of uniqueLines) {
    const aggregate = firstRow<{ shipped_quantity: number }>(await tx.execute(sql`
      SELECT COALESCE(SUM(quantity_shipped), 0)::int AS shipped_quantity
      FROM wms.physical_shipment_items
      WHERE fulfillment_plan_line_id = ${fulfillmentPlanLineId}
        AND shipment_item_purpose = 'customer_fulfillment'
    `));
    const shippedQuantity = Number(aggregate?.shipped_quantity ?? 0);
    const decision = evaluateChannelFulfillmentWritebackPolicy({
      channelProvider: item.channelProvider,
      lineFulfillmentProvider: item.lineFulfillmentProvider,
      omsOrderStatus: item.omsOrderStatus,
      omsFinancialStatus: item.omsFinancialStatus,
      requiresReview: item.requiresReview,
      reviewReason: item.reviewReason,
      currentAuthorizedQuantity: item.currentAuthorizedQuantity,
      cumulativePhysicalQuantity: shippedQuantity,
    });
    eligibility.set(fulfillmentPlanLineId, decision.allowed);

    if (decision.reasons.includes("physical_quantity_exceeds_current_authority")) {
      const affectedLegacyShipmentIds = [...new Set(
        items
          .filter((candidate) => candidate.fulfillmentPlanLineId === fulfillmentPlanLineId)
          .map((candidate) => candidate.legacyWmsShipmentId),
      )];
      const affectedIds = buildIdList(affectedLegacyShipmentIds);
      await tx.execute(sql`
        UPDATE wms.outbound_shipments
        SET requires_review = true,
            review_reason = COALESCE(
              NULLIF(BTRIM(review_reason), ''),
              'physical_shipment_exceeds_current_line_authority'
            ),
            updated_at = NOW()
        WHERE id IN (${affectedIds})
      `);
    }
  }

  return eligibility;
}

async function persistChannelCommand(
  tx: any,
  command: ChannelFulfillmentCommand,
  input: ReturnType<typeof canonicalizeInput>,
  legacyShipmentIds: readonly number[],
): Promise<MaterializedChannelCommand> {
  const existing = firstRow<{
    id: number;
    request_hash: string | null;
    push_status: string;
  }>(await tx.execute(sql`
    SELECT id, request_hash, push_status
    FROM oms.channel_fulfillment_pushes
    WHERE command_key = ${command.commandKey}
    FOR UPDATE
  `));
  if (existing) {
    if (existing.request_hash !== command.requestHash) {
      if (ACTIVE_COMMAND_STATUSES.has(String(existing.push_status))) {
        await tx.execute(sql`
          UPDATE oms.channel_fulfillment_pushes
          SET push_status = 'review',
              last_error_code = 'COMMAND_REQUEST_CONFLICT',
              last_error = 'Canonical physical package replay produced a different immutable request hash',
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
          WHERE id = ${Number(existing.id)}
        `);
      }
      throw new FulfillmentAuthorityError(
        "COMMAND_REQUEST_CONFLICT",
        `Channel command ${command.commandKey} conflicts with its prior request snapshot`,
        { commandId: existing.id, existingRequestHash: existing.request_hash, incomingRequestHash: command.requestHash },
      );
    }
    return {
      id: Number(existing.id),
      commandKey: command.commandKey,
      pushStatus: String(existing.push_status),
      replayed: true,
    };
  }

  const metadata = {
    contractVersion: 1,
    source: input.source,
    shippingProvider: input.shippingProvider,
    providerPhysicalShipmentId: input.providerPhysicalShipmentId,
    providerOrderId: input.providerOrderId,
    legacyWmsShipmentIds: [...legacyShipmentIds].sort((a, b) => a - b),
  };
  const inserted = firstRow<{ id: number; push_status: string }>(await tx.execute(sql`
    INSERT INTO oms.channel_fulfillment_pushes (
      oms_order_id,
      physical_shipment_id,
      channel_provider,
      channel_fulfillment_scope_key,
      command_key,
      request_hash,
      tracking_number,
      carrier,
      tracking_url,
      shipped_at,
      push_status,
      attempt_count,
      max_attempts,
      next_attempt_at,
      correlation_id,
      causation_id,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      ${command.omsOrderId},
      ${command.physicalShipmentId},
      ${command.channelProvider},
      ${command.channelFulfillmentScopeKey},
      ${command.commandKey},
      ${command.requestHash},
      ${command.trackingNumber},
      ${command.carrier},
      ${command.trackingUrl},
      ${command.shippedAt ? new Date(command.shippedAt) : null},
      'pending',
      0,
      12,
      NOW(),
      ${input.correlationId},
      ${input.causationId},
      ${JSON.stringify(metadata)}::jsonb,
      NOW(),
      NOW()
    )
    RETURNING id, push_status
  `));
  if (!inserted) {
    throw new FulfillmentAuthorityError("CANONICAL_STATE_CONFLICT", "Failed to create channel fulfillment command");
  }

  for (const item of command.items) {
    await tx.execute(sql`
      INSERT INTO oms.channel_fulfillment_push_items (
        channel_fulfillment_push_id,
        physical_shipment_item_id,
        oms_order_line_id,
        channel_order_line_id,
        quantity_pushed,
        metadata,
        created_at
      ) VALUES (
        ${Number(inserted.id)},
        ${item.physicalShipmentItemId},
        ${item.omsOrderLineId},
        ${item.channelOrderLineId},
        ${item.quantity},
        ${JSON.stringify({ contractVersion: 1, shipmentRequestItemId: item.shipmentRequestItemId })}::jsonb,
        NOW()
      )
    `);
  }

  return {
    id: Number(inserted.id),
    commandKey: command.commandKey,
    pushStatus: String(inserted.push_status),
    replayed: false,
  };
}

function validateLegacyHeaders(
  rows: readonly LegacyPackageRow[],
  input: ReturnType<typeof canonicalizeInput>,
): void {
  const foundIds = new Set(rows.map((row) => Number(row.legacy_shipment_id)));
  const missing = input.legacyWmsShipmentIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new FulfillmentAuthorityError(
      "LEGACY_SHIPMENT_NOT_FOUND",
      "One or more legacy WMS shipments were not found",
      { missingLegacyWmsShipmentIds: missing },
    );
  }

  for (const row of rows) {
    if (String(row.shipment_status) !== "shipped") {
      throw new FulfillmentAuthorityError(
        "LEGACY_SHIPMENT_NOT_SHIPPED",
        `Legacy WMS shipment ${row.legacy_shipment_id} is not shipped`,
        { legacyWmsShipmentId: row.legacy_shipment_id, status: row.shipment_status },
      );
    }
    const persistedProvider = normalizedNullable(row.persisted_shipping_provider)?.toLowerCase();
    if (persistedProvider && persistedProvider !== input.shippingProvider) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_IDENTITY_CONFLICT",
        `Legacy shipment ${row.legacy_shipment_id} belongs to another shipping provider`,
        { persistedProvider, incomingProvider: input.shippingProvider },
      );
    }
    const parsedPhysical = parseLegacyProviderPhysicalShipmentId(row.persisted_physical_identity);
    if (
      parsedPhysical
      && (
        parsedPhysical.provider !== input.shippingProvider
        || parsedPhysical.providerPhysicalShipmentId !== input.providerPhysicalShipmentId
      )
    ) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_IDENTITY_CONFLICT",
        `Legacy shipment ${row.legacy_shipment_id} belongs to another physical package`,
        { persistedPhysicalIdentity: row.persisted_physical_identity, providerPhysicalShipmentId: input.providerPhysicalShipmentId },
      );
    }
    assertCompatibleIdentity("providerOrderId", row.persisted_provider_order_id, input.providerOrderId, row.legacy_shipment_id);
    assertCompatibleIdentity("providerOrderKey", row.persisted_provider_order_key, input.providerOrderKey, row.legacy_shipment_id);
    assertCompatibleIdentity("trackingNumber", row.persisted_tracking_number, input.trackingNumber, row.legacy_shipment_id);
    assertCompatibleIdentity("carrier", row.persisted_carrier, input.carrier, row.legacy_shipment_id);
  }
}

function terminalStatusForOutcome(outcome: ChannelFulfillmentAttemptOutcome): string {
  switch (outcome) {
    case "success": return "success";
    case "ignored": return "ignored";
    case "review_required": return "review";
    case "dead_lettered": return "dead";
    case "retry_scheduled": return "retry";
  }
}

export function createChannelFulfillmentAuthorityRepository(
  db: any,
): ChannelFulfillmentAuthorityRepository {
  async function resolveLegacyPhysicalPackage(
    legacyWmsShipmentId: number,
  ): Promise<ResolvedLegacyPhysicalPackage> {
    if (!Number.isInteger(legacyWmsShipmentId) || legacyWmsShipmentId <= 0) {
      throw new FulfillmentAuthorityError(
        "INVALID_INPUT",
        "legacyWmsShipmentId must be a positive integer",
        { legacyWmsShipmentId },
      );
    }
    const row = firstRow<any>(await db.execute(sql`
      SELECT
        shipment.id,
        COALESCE(NULLIF(BTRIM(shipment.shipping_engine), ''),
          CASE WHEN shipment.shipstation_order_id IS NOT NULL THEN 'shipstation' END
        ) AS shipping_provider,
        COALESCE(NULLIF(BTRIM(shipment.engine_order_ref), ''), shipment.shipstation_order_id::text) AS provider_order_id,
        NULLIF(BTRIM(shipment.shipstation_order_key), '') AS provider_order_key,
        shipment.external_fulfillment_id,
        shipment.tracking_number,
        shipment.carrier,
        shipment.tracking_url,
        shipment.service_code,
        shipment.shipped_at
      FROM wms.outbound_shipments AS shipment
      WHERE shipment.id = ${legacyWmsShipmentId}
      LIMIT 1
    `));
    if (!row) {
      throw new FulfillmentAuthorityError(
        "LEGACY_SHIPMENT_NOT_FOUND",
        `Legacy WMS shipment ${legacyWmsShipmentId} was not found`,
        { legacyWmsShipmentId },
      );
    }

    const parsedPhysical = parseLegacyProviderPhysicalShipmentId(row.external_fulfillment_id);
    const provider = normalizedNullable(row.shipping_provider)?.toLowerCase();
    if (!parsedPhysical || !provider || parsedPhysical.provider !== provider) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_IDENTITY_CONFLICT",
        `Legacy WMS shipment ${legacyWmsShipmentId} lacks a stable provider physical shipment identity`,
        { legacyWmsShipmentId, shippingProvider: provider, externalFulfillmentId: row.external_fulfillment_id },
      );
    }
    const trackingNumber = normalizedNullable(row.tracking_number);
    const carrier = normalizedNullable(row.carrier);
    if (!trackingNumber || !carrier) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_IDENTITY_CONFLICT",
        `Legacy WMS shipment ${legacyWmsShipmentId} lacks tracking identity`,
        { legacyWmsShipmentId, trackingNumber, carrier },
      );
    }

    const packageIdentityFilter = parsedPhysical.provider === "shipstation"
      ? sql`(
          external_fulfillment_id = ${`shipstation_shipment:${parsedPhysical.providerPhysicalShipmentId}`}
          OR external_fulfillment_id LIKE ${`shipstation_combined:${parsedPhysical.providerPhysicalShipmentId}:order:%`}
          OR external_fulfillment_id = ${buildProviderPhysicalShipmentIdentity(
            parsedPhysical.provider,
            parsedPhysical.providerPhysicalShipmentId,
          )}
        )`
      : sql`external_fulfillment_id = ${parsedPhysical.persistedIdentity}`;
    const packageRows = rowsOf<{ id: number }>(await db.execute(sql`
      SELECT id
      FROM wms.outbound_shipments
      WHERE COALESCE(
              NULLIF(BTRIM(shipping_engine), ''),
              CASE WHEN shipstation_order_id IS NOT NULL THEN 'shipstation' END
            ) = ${provider}
        AND status = 'shipped'
        AND ${packageIdentityFilter}
      ORDER BY id
    `));
    const legacyIds = packageRows.map((candidate) => Number(candidate.id));
    if (!legacyIds.includes(legacyWmsShipmentId)) legacyIds.push(legacyWmsShipmentId);

    return {
      legacyWmsShipmentIds: Object.freeze([...new Set(legacyIds)].sort((a, b) => a - b)),
      shippingProvider: provider,
      providerPhysicalShipmentId: parsedPhysical.providerPhysicalShipmentId,
      providerOrderId: normalizedNullable(row.provider_order_id),
      providerOrderKey: normalizedNullable(row.provider_order_key),
      trackingNumber,
      carrier,
      trackingUrl: normalizedNullable(row.tracking_url),
      serviceCode: normalizedNullable(row.service_code),
      shippedAt: toDateOrNull(row.shipped_at),
    };
  }

  async function materializePhysicalPackage(
    rawInput: MaterializePhysicalPackageInput,
  ): Promise<MaterializePhysicalPackageResult> {
    const input = canonicalizeInput(rawInput);
    const providerOrderIdentity = input.providerOrderId ?? input.providerOrderKey;
    if (!providerOrderIdentity) {
      throw new FulfillmentAuthorityError(
        "PROVIDER_ORDER_IDENTITY_MISSING",
        "A provider order id or provider order key is required",
        { shippingProvider: input.shippingProvider, providerPhysicalShipmentId: input.providerPhysicalShipmentId },
      );
    }
    if (typeof db?.transaction !== "function") {
      throw new FulfillmentAuthorityError(
        "INVALID_INPUT",
        "Fulfillment authority repository requires transactional database support",
      );
    }

    return db.transaction(async (tx: any) => {
      await acquireIdentityLocks(
        tx,
        input.shippingProvider,
        providerOrderIdentity,
        input.providerPhysicalShipmentId,
      );

      const idList = buildIdList(input.legacyWmsShipmentIds);
      const contextRows = rowsOf<LegacyPackageRow>(await tx.execute(sql`
        SELECT
          shipment.id AS legacy_shipment_id,
          shipment.order_id AS wms_order_id,
          shipment.status::text AS shipment_status,
          shipment.shipment_purpose,
          COALESCE(NULLIF(BTRIM(shipment.shipping_engine), ''),
            CASE WHEN shipment.shipstation_order_id IS NOT NULL THEN 'shipstation' END
          ) AS persisted_shipping_provider,
          COALESCE(NULLIF(BTRIM(shipment.engine_order_ref), ''), shipment.shipstation_order_id::text) AS persisted_provider_order_id,
          NULLIF(BTRIM(shipment.shipstation_order_key), '') AS persisted_provider_order_key,
          shipment.external_fulfillment_id AS persisted_physical_identity,
          shipment.tracking_number AS persisted_tracking_number,
          shipment.carrier AS persisted_carrier,
          shipment.requires_review,
          shipment.review_reason,
          NULLIF(BTRIM(wms_order.oms_fulfillment_order_id), '') AS wms_oms_order_ref,
          oms_order.id AS oms_order_id,
          oms_order.external_order_id AS oms_external_order_id,
          wms_order.warehouse_id,
          wms_order.sort_rank AS priority_rank,
          jsonb_build_object(
            'name', wms_order.shipping_name,
            'company', wms_order.shipping_company,
            'address1', wms_order.shipping_address,
            'address2', wms_order.shipping_address2,
            'city', wms_order.shipping_city,
            'state', wms_order.shipping_state,
            'postalCode', wms_order.shipping_postal_code,
            'country', wms_order.shipping_country
          ) AS ship_to_snapshot,
          shipment_item.id AS legacy_shipment_item_id,
          shipment_item.shipment_item_purpose,
          shipment_item.order_item_id,
          shipment_item.replacement_for_order_item_id,
          shipment_item.product_variant_id,
          COALESCE(order_item.sku, replacement_item.sku, variant.sku) AS sku,
          shipment_item.qty::int AS quantity_shipped,
          order_item.oms_order_line_id,
          channel.provider AS channel_provider,
          oms_line.fulfillment_provider AS line_fulfillment_provider,
          oms_line.external_line_item_id AS channel_order_line_id,
          oms_order.status AS oms_order_status,
          oms_order.financial_status AS oms_financial_status,
          oms_line.paid_quantity::int AS paid_quantity,
          oms_line.authority_fulfillable_quantity::int AS authority_fulfillable_quantity,
          GREATEST(
            COALESCE(oms_line.paid_quantity, 0),
            COALESCE(authority.max_paid_quantity, 0)
          )::int AS max_authorized_quantity
        FROM wms.outbound_shipments AS shipment
        JOIN wms.orders AS wms_order ON wms_order.id = shipment.order_id
        LEFT JOIN wms.outbound_shipment_items AS shipment_item
          ON shipment_item.shipment_id = shipment.id
        LEFT JOIN wms.order_items AS order_item ON order_item.id = shipment_item.order_item_id
        LEFT JOIN wms.order_items AS replacement_item
          ON replacement_item.id = shipment_item.replacement_for_order_item_id
        LEFT JOIN catalog.product_variants AS variant ON variant.id = shipment_item.product_variant_id
        LEFT JOIN oms.oms_order_lines AS oms_line ON oms_line.id = order_item.oms_order_line_id
        LEFT JOIN oms.oms_orders AS oms_order ON oms_order.id = oms_line.order_id
        LEFT JOIN channels.channels AS channel ON channel.id = oms_order.channel_id
        LEFT JOIN LATERAL (
          SELECT MAX(event.paid_quantity)::int AS max_paid_quantity
          FROM oms.oms_order_line_authority_events AS event
          WHERE event.order_line_id = oms_line.id
        ) AS authority ON TRUE
        WHERE shipment.id IN (${idList})
        ORDER BY shipment.id, shipment_item.id
        FOR UPDATE OF shipment
      `));

      validateLegacyHeaders(contextRows, input);
      const { customerItems, nonCustomerRows } = normalizeCustomerItems(contextRows);
      if (customerItems.length === 0 && nonCustomerRows.length === 0) {
        throw new FulfillmentAuthorityError(
          "OMS_LINEAGE_MISSING",
          "Physical package has no item allocations",
          { legacyWmsShipmentIds: input.legacyWmsShipmentIds },
        );
      }

      const shippingEngineOrderId = await findOrCreateShippingEngineOrder(tx, input);
      const stagedCustomerItems: Array<Omit<MaterializedCustomerItem, "physicalShipmentItemId">> = [];
      for (const item of customerItems) {
        const fulfillmentPlanId = await findOrCreatePlan(tx, item, input.source);
        const fulfillmentPlanLineId = await findOrCreatePlanLine(tx, item, fulfillmentPlanId);
        const shipmentRequestId = await findOrCreateShipmentRequest(
          tx,
          item,
          fulfillmentPlanId,
          input.source,
        );
        const shipmentRequestItemId = await findOrCreateRequestItem(
          tx,
          item,
          shipmentRequestId,
          fulfillmentPlanLineId,
        );
        stagedCustomerItems.push({
          ...item,
          fulfillmentPlanId,
          fulfillmentPlanLineId,
          shipmentRequestId,
          shipmentRequestItemId,
        });
      }

      await linkShippingEngineRequests(
        tx,
        shippingEngineOrderId,
        stagedCustomerItems.map((item) => item.shipmentRequestId),
      );
      const physicalShipmentId = await findOrCreatePhysicalShipment(
        tx,
        input,
        shippingEngineOrderId,
      );

      const materializedCustomerItems: MaterializedCustomerItem[] = [];
      for (const item of stagedCustomerItems) {
        const physicalShipmentItemId = await findOrCreatePhysicalCustomerItem(
          tx,
          item,
          physicalShipmentId,
        );
        materializedCustomerItems.push({ ...item, physicalShipmentItemId });
      }
      const nonCustomerItemCount = await materializeNonCustomerItems(
        tx,
        nonCustomerRows,
        physicalShipmentId,
      );

      const planLineIds = [...new Set(
        materializedCustomerItems.map((item) => item.fulfillmentPlanLineId),
      )].sort((left, right) => left - right);
      for (const planLineId of planLineIds) {
        await recalculatePlanLine(tx, planLineId);
      }

      const lineWritebackEligibility = await findLineWritebackEligibility(
        tx,
        materializedCustomerItems,
      );

      const channelEligibleCustomerItems = materializedCustomerItems.filter(
        (item) => lineWritebackEligibility.get(item.fulfillmentPlanLineId) === true
          && !input.suppressChannelProviders.includes(item.channelProvider),
      );
      if (
        channelEligibleCustomerItems.length > 0
        && (!input.trackingNumber || !input.carrier)
      ) {
        throw new FulfillmentAuthorityError(
          "INVALID_INPUT",
          "A physical package requires tracking and carrier before channel writeback",
          {
            physicalShipmentId,
            channelProviders: [...new Set(
              channelEligibleCustomerItems.map((item) => item.channelProvider),
            )],
          },
        );
      }
      const commands = channelEligibleCustomerItems.length === 0
        ? []
        : planChannelFulfillmentCommands({
          physicalShipmentId,
          shippingProvider: input.shippingProvider,
          providerPhysicalShipmentId: input.providerPhysicalShipmentId,
          trackingNumber: input.trackingNumber!,
          carrier: input.carrier!,
          trackingUrl: input.trackingUrl,
          shippedAt: input.shippedAt?.toISOString() ?? null,
          items: channelEligibleCustomerItems.map((item) => ({
            physicalShipmentItemId: item.physicalShipmentItemId,
            shipmentRequestItemId: item.shipmentRequestItemId,
            omsOrderId: item.omsOrderId,
            omsOrderLineId: item.omsOrderLineId,
            channelProvider: item.channelProvider,
            channelOrderLineId: item.channelOrderLineId,
            channelFulfillmentScopeKey: "order",
            quantityShipped: item.quantityShipped,
          })),
        });

      const persistedCommands: MaterializedChannelCommand[] = [];
      for (const command of commands) {
        const legacyShipmentIds = channelEligibleCustomerItems
          .filter((item) => item.omsOrderId === command.omsOrderId)
          .map((item) => item.legacyWmsShipmentId);
        persistedCommands.push(await persistChannelCommand(
          tx,
          command,
          input,
          [...new Set(legacyShipmentIds)],
        ));
      }

      return Object.freeze({
        physicalShipmentId,
        shippingEngineOrderId,
        channelCommands: Object.freeze(persistedCommands),
        customerFulfillmentItemCount: materializedCustomerItems.length,
        nonCustomerItemCount,
      });
    });
  }

  async function claimCommands(
    input: ClaimChannelFulfillmentCommandsInput,
  ): Promise<readonly ClaimedChannelFulfillmentCommand[]> {
    if (
      !(input.now instanceof Date)
      || Number.isNaN(input.now.getTime())
      || !Number.isInteger(input.leaseDurationMs)
      || input.leaseDurationMs <= 0
      || !Number.isInteger(input.limit)
      || input.limit <= 0
      || !normalizedNullable(input.leaseToken)
    ) {
      throw new FulfillmentAuthorityError("INVALID_INPUT", "Invalid command claim input");
    }
    if (typeof db?.transaction !== "function") {
      throw new FulfillmentAuthorityError("INVALID_INPUT", "Command claiming requires a transaction");
    }
    const commandIds = input.commandIds
      ? [...new Set(input.commandIds.filter((id) => Number.isInteger(id) && id > 0))]
      : [];
    if (input.commandIds && commandIds.length === 0) {
      return Object.freeze([]);
    }
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseDurationMs);

    return db.transaction(async (tx: any) => {
      const expired = rowsOf<{
        id: number;
        attempt_count: number;
        max_attempts: number;
        request_hash: string;
        last_attempt_at: Date | string | null;
        correlation_id: string | null;
        causation_id: string | null;
      }>(await tx.execute(sql`
        SELECT id, attempt_count, max_attempts, request_hash, last_attempt_at, correlation_id, causation_id
        FROM oms.channel_fulfillment_pushes
        WHERE push_status = 'processing'
          AND lease_expires_at <= ${input.now}
        FOR UPDATE SKIP LOCKED
      `));
      for (const row of expired) {
        const exhausted = Number(row.attempt_count) >= Number(row.max_attempts);
        await tx.execute(sql`
          INSERT INTO oms.channel_fulfillment_push_attempts (
            channel_fulfillment_push_id,
            attempt_number,
            outcome,
            request_hash,
            error_code,
            error_message,
            started_at,
            completed_at,
            correlation_id,
            causation_id,
            metadata,
            created_at
          ) VALUES (
            ${Number(row.id)},
            ${Number(row.attempt_count)},
            ${exhausted ? "dead_lettered" : "retry_scheduled"},
            ${row.request_hash},
            'LEASE_EXPIRED',
            'Previous worker lease expired before completion',
            ${toDateOrNull(row.last_attempt_at) ?? input.now},
            ${input.now},
            ${row.correlation_id},
            ${row.causation_id},
            ${JSON.stringify({ reclaimed: true, exhausted })}::jsonb,
            ${input.now}
          )
          ON CONFLICT (channel_fulfillment_push_id, attempt_number) DO NOTHING
        `);
        await tx.execute(sql`
          UPDATE oms.channel_fulfillment_pushes
          SET push_status = CASE WHEN attempt_count >= max_attempts THEN 'dead' ELSE 'retry' END,
              next_attempt_at = ${input.now},
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error_code = 'LEASE_EXPIRED',
              last_error = 'Previous worker lease expired before completion',
              completed_at = CASE WHEN attempt_count >= max_attempts THEN ${input.now} ELSE NULL END,
              updated_at = ${input.now}
          WHERE id = ${Number(row.id)}
        `);
      }

      const idFilter = commandIds.length > 0
        ? sql`AND command.id IN (${buildIdList(commandIds)})`
        : sql``;
      const dueRows = rowsOf<{ id: number }>(await tx.execute(sql`
        SELECT command.id
        FROM oms.channel_fulfillment_pushes AS command
        WHERE command.push_status IN ('pending', 'retry')
          AND command.next_attempt_at <= ${input.now}
          AND command.attempt_count < command.max_attempts
          ${idFilter}
        ORDER BY command.next_attempt_at, command.id
        FOR UPDATE SKIP LOCKED
        LIMIT ${input.limit}
      `));
      if (dueRows.length === 0) return Object.freeze([]);

      const dueIds = dueRows.map((row) => Number(row.id));
      const claimedRows = rowsOf<any>(await tx.execute(sql`
        UPDATE oms.channel_fulfillment_pushes
        SET push_status = 'processing',
            attempt_count = attempt_count + 1,
            lease_token = ${input.leaseToken},
            lease_expires_at = ${leaseExpiresAt},
            last_attempt_at = ${input.now},
            updated_at = ${input.now}
        WHERE id IN (${buildIdList(dueIds)})
        RETURNING *
      `));
      const itemRows = rowsOf<any>(await tx.execute(sql`
        SELECT
          push_item.channel_fulfillment_push_id,
          push_item.physical_shipment_item_id,
          physical_item.shipment_request_item_id,
          physical_item.legacy_wms_shipment_item_id,
          legacy_item.shipment_id AS legacy_wms_shipment_id,
          push_item.oms_order_line_id,
          push_item.channel_order_line_id,
          push_item.quantity_pushed
        FROM oms.channel_fulfillment_push_items AS push_item
        JOIN wms.physical_shipment_items AS physical_item
          ON physical_item.id = push_item.physical_shipment_item_id
        JOIN wms.outbound_shipment_items AS legacy_item
          ON legacy_item.id = physical_item.legacy_wms_shipment_item_id
        WHERE push_item.channel_fulfillment_push_id IN (${buildIdList(dueIds)})
        ORDER BY push_item.channel_fulfillment_push_id, push_item.physical_shipment_item_id
      `));
      const itemsByCommand = new Map<number, ClaimedChannelFulfillmentCommandItem[]>();
      for (const item of itemRows) {
        const commandId = Number(item.channel_fulfillment_push_id);
        const list = itemsByCommand.get(commandId) ?? [];
        const physicalShipmentItemId = asPositiveInteger(item.physical_shipment_item_id);
        const shipmentRequestItemId = asPositiveInteger(item.shipment_request_item_id);
        const legacyWmsShipmentId = asPositiveInteger(item.legacy_wms_shipment_id);
        const legacyWmsShipmentItemId = asPositiveInteger(item.legacy_wms_shipment_item_id);
        const omsOrderLineId = asPositiveInteger(item.oms_order_line_id);
        const channelOrderLineId = normalizedNullable(item.channel_order_line_id);
        const quantity = asPositiveInteger(item.quantity_pushed);
        if (
          !physicalShipmentItemId
          || !shipmentRequestItemId
          || !legacyWmsShipmentId
          || !legacyWmsShipmentItemId
          || !omsOrderLineId
          || !channelOrderLineId
          || !quantity
        ) {
          throw new FulfillmentAuthorityError(
            "CANONICAL_STATE_CONFLICT",
            `Channel fulfillment command ${commandId} has incomplete physical-item lineage`,
            { commandId, item },
          );
        }
        list.push(Object.freeze({
          physicalShipmentItemId,
          shipmentRequestItemId,
          legacyWmsShipmentId,
          legacyWmsShipmentItemId,
          omsOrderLineId,
          channelOrderLineId,
          quantity,
        }));
        itemsByCommand.set(commandId, list);
      }

      return Object.freeze(claimedRows
        .sort((left, right) => dueIds.indexOf(Number(left.id)) - dueIds.indexOf(Number(right.id)))
        .map((row) => Object.freeze({
          id: Number(row.id),
          commandKey: String(row.command_key),
          requestHash: String(row.request_hash),
          omsOrderId: Number(row.oms_order_id),
          physicalShipmentId: Number(row.physical_shipment_id),
          channelProvider: String(row.channel_provider),
          channelFulfillmentScopeKey: String(row.channel_fulfillment_scope_key),
          trackingNumber: String(row.tracking_number),
          carrier: String(row.carrier),
          trackingUrl: normalizedNullable(row.tracking_url),
          shippedAt: toDateOrNull(row.shipped_at),
          attemptNumber: Number(row.attempt_count),
          maxAttempts: Number(row.max_attempts),
          leaseToken: String(row.lease_token),
          metadata: Object.freeze({ ...(row.metadata ?? {}) }),
          items: Object.freeze(itemsByCommand.get(Number(row.id)) ?? []),
        })));
    });
  }

  async function completeAttempt(input: CompleteChannelFulfillmentAttemptInput): Promise<void> {
    if (
      !Number.isInteger(input.commandId)
      || input.commandId <= 0
      || !normalizedNullable(input.leaseToken)
      || !(input.startedAt instanceof Date)
      || !(input.completedAt instanceof Date)
      || input.completedAt < input.startedAt
    ) {
      throw new FulfillmentAuthorityError("INVALID_INPUT", "Invalid command completion input");
    }
    await db.transaction(async (tx: any) => {
      const command = firstRow<any>(await tx.execute(sql`
        SELECT *
        FROM oms.channel_fulfillment_pushes
        WHERE id = ${input.commandId}
        FOR UPDATE
      `));
      if (!command) {
        throw new FulfillmentAuthorityError(
          "LEASE_OWNERSHIP_LOST",
          `Channel fulfillment command ${input.commandId} no longer exists`,
          { commandId: input.commandId },
        );
      }
      if (
        String(command.push_status) !== "processing"
        || String(command.lease_token ?? "") !== input.leaseToken
      ) {
        throw new FulfillmentAuthorityError(
          "LEASE_OWNERSHIP_LOST",
          `Worker no longer owns channel fulfillment command ${input.commandId}`,
          { commandId: input.commandId, pushStatus: command.push_status },
        );
      }

      const status = terminalStatusForOutcome(input.outcome);
      const terminal = status === "success" || status === "ignored" || status === "dead";
      if (status === "retry" && !input.nextAttemptAt) {
        throw new FulfillmentAuthorityError(
          "INVALID_INPUT",
          "Retry completion requires nextAttemptAt",
          { commandId: input.commandId },
        );
      }
      await tx.execute(sql`
        INSERT INTO oms.channel_fulfillment_push_attempts (
          channel_fulfillment_push_id,
          attempt_number,
          outcome,
          request_hash,
          provider_response_id,
          error_code,
          error_message,
          started_at,
          completed_at,
          correlation_id,
          causation_id,
          metadata,
          created_at
        ) VALUES (
          ${input.commandId},
          ${Number(command.attempt_count)},
          ${input.outcome},
          ${String(command.request_hash)},
          ${input.providerResponseId ?? null},
          ${input.errorCode ?? null},
          ${input.errorMessage?.slice(0, 1_000) ?? null},
          ${input.startedAt},
          ${input.completedAt},
          ${input.correlationId ?? command.correlation_id ?? null},
          ${input.causationId ?? command.causation_id ?? null},
          ${JSON.stringify(input.metadata ?? {})}::jsonb,
          ${input.completedAt}
        )
      `);
      await tx.execute(sql`
        UPDATE oms.channel_fulfillment_pushes
        SET push_status = ${status},
            channel_fulfillment_id = COALESCE(${input.providerResponseId ?? null}, channel_fulfillment_id),
            next_attempt_at = COALESCE(${input.nextAttemptAt ?? null}, next_attempt_at),
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_code = ${input.errorCode ?? null},
            last_error = ${input.errorMessage?.slice(0, 1_000) ?? null},
            completed_at = CASE WHEN ${terminal} THEN ${input.completedAt} ELSE NULL END,
            updated_at = ${input.completedAt}
        WHERE id = ${input.commandId}
      `);
    });
  }

  return {
    resolveLegacyPhysicalPackage,
    materializePhysicalPackage,
    claimCommands,
    completeAttempt,
  };
}
