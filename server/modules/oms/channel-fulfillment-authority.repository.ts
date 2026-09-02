import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  type ChannelFulfillmentCommand,
  planChannelFulfillmentCommands,
} from "./channel-fulfillment-command";
import {
  buildSupplementalChannelFulfillmentScope,
  reconcileChannelFulfillmentCommandSet,
  type ExistingChannelFulfillmentCommandSnapshot,
} from "./channel-fulfillment-command-reconciliation";
import {
  evaluateChannelFulfillmentWritebackPolicy,
  type ChannelFulfillmentWritebackPolicyDecision,
} from "./channel-fulfillment-authority.policy";
import { resolveProviderOrderId } from "./shipping-engine-order-identity";

const positiveIntegerSchema = z.number().int().positive();
const positiveBigintTextSchema = z.string().regex(/^[1-9]\d*$/).refine(
  (value) => BigInt(value) <= BigInt("9223372036854775807"),
  "must fit in a PostgreSQL bigint",
);
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
  suppressChannelWriteback: z.boolean().optional().default(false),
  suppressChannelProviders: z.array(
    z.string().trim().min(1).max(40).transform((value) => value.toLowerCase()),
  ).max(20).optional(),
  legacyHeaderPolicy: z.enum(["strict", "aggregate_projection"]).optional().default("strict"),
}).strict();

export type MaterializePhysicalPackageInput = z.input<typeof materializeInputSchema>;

const packageAllocationCommercialMaterializationInputSchema = z.object({
  packageAllocationPlanId: positiveBigintTextSchema,
  source: z.string().trim().min(1).max(80),
  correlationId: optionalIdentifier(100),
  causationId: optionalIdentifier(100),
}).strict();

export type MaterializePackageAllocationCommercialFulfillmentInput = z.input<
  typeof packageAllocationCommercialMaterializationInputSchema
>;

export type FulfillmentAuthorityErrorCode =
  | "INVALID_INPUT"
  | "LEGACY_SHIPMENT_NOT_FOUND"
  | "LEGACY_SHIPMENT_NOT_SHIPPED"
  | "PHYSICAL_SHIPMENT_NOT_FOUND"
  | "PACKAGE_IDENTITY_CONFLICT"
  | "PROVIDER_ORDER_IDENTITY_MISSING"
  | "OMS_LINEAGE_MISSING"
  | "CHANNEL_LINE_IDENTITY_MISSING"
  | "PACKAGE_ALLOCATION_PLAN_NOT_FOUND"
  | "PACKAGE_ALLOCATION_PLAN_STALE"
  | "PACKAGE_ALLOCATION_EFFECT_CONFLICT"
  | "CHANNEL_WRITEBACK_NOT_AUTHORIZED"
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

export interface MaterializePackageAllocationCommercialFulfillmentResult {
  readonly packageAllocationPlanId: string;
  readonly physicalShipmentIds: readonly number[];
  readonly channelCommands: readonly MaterializedChannelCommand[];
  readonly customerFulfillmentItemCount: number;
  readonly replayed: boolean;
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
  readonly packageAllocationEntryId: number | null;
  readonly packageAllocationEffectIntentId: number | null;
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
  materializePackageAllocationCommercialFulfillment(
    input: MaterializePackageAllocationCommercialFulfillmentInput,
  ): Promise<MaterializePackageAllocationCommercialFulfillmentResult>;
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
  correction_for_shipment_item_id: number | null;
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

interface PackageAllocationCommercialIntent {
  readonly id: string;
  readonly packageAllocationSourceLineId: string;
  readonly sourceWmsShipmentItemId: number;
  readonly quantity: number;
}

interface PackageAllocationCommercialEntry {
  readonly id: string;
  readonly packageAllocationEffectIntentId: string;
  readonly packageAllocationSourceLineId: string;
  readonly sourceWmsShipmentItemId: number;
  readonly packageAllocationPackageBindingId: string;
  readonly provider: string;
  readonly providerPhysicalShipmentId: string;
  readonly providerOrderId: string | null;
  readonly providerOrderKey: string | null;
  readonly trackingNumber: string;
  readonly carrier: string;
  readonly serviceCode: string | null;
  readonly businessShipmentRecognizedAt: Date;
  readonly quantity: number;
}

interface MaterializedPackageAllocationCommercialItem extends MaterializedCustomerItem {
  readonly packageAllocationEntryId: string;
  readonly packageAllocationEffectIntentId: string;
  readonly allocatedQuantity: number;
}

interface PackageAllocationCommercialPackage {
  readonly provider: string;
  readonly providerPhysicalShipmentId: string;
  readonly providerOrderId: string | null;
  readonly providerOrderKey: string | null;
  readonly trackingNumber: string;
  readonly carrier: string;
  readonly serviceCode: string | null;
  readonly businessShipmentRecognizedAt: Date;
  readonly entries: readonly PackageAllocationCommercialEntry[];
}

const ACTIVE_COMMAND_STATUSES = new Set(["shadow", "pending", "processing", "retry", "review"]);
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

function bigintTextOrNull(value: unknown): string | null {
  const normalized = normalizedNullable(value);
  if (!normalized || !/^[1-9]\d*$/.test(normalized)) return null;
  try {
    return BigInt(normalized) <= BigInt("9223372036854775807") ? normalized : null;
  } catch {
    return null;
  }
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

function canonicalizePackageAllocationCommercialInput(
  input: MaterializePackageAllocationCommercialFulfillmentInput,
) {
  const parsed = packageAllocationCommercialMaterializationInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new FulfillmentAuthorityError(
      "INVALID_INPUT",
      "Package-allocation commercial fulfillment input is invalid",
      { issues: parsed.error.issues },
    );
  }
  return Object.freeze({
    ...parsed.data,
    correlationId: parsed.data.correlationId ?? null,
    causationId: parsed.data.causationId ?? null,
  });
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

async function lockCurrentPackageAllocationCommercialPlan(
  tx: any,
  packageAllocationPlanId: string,
): Promise<{
  readonly current: boolean;
  readonly outcome: string;
  readonly planVersion: number;
  readonly currentGroupVersion: number;
}> {
  const plan = firstRow<{
    id: string;
    plan_version: number;
    outcome: string;
    current_version: number;
  }>(await tx.execute(sql`
    SELECT
      plan.id::text AS id,
      plan.plan_version,
      plan.outcome,
      allocation_group.current_version
    FROM wms.package_allocation_plans AS plan
    JOIN wms.package_allocation_groups AS allocation_group
      ON allocation_group.id = plan.package_allocation_group_id
    WHERE plan.id = ${packageAllocationPlanId}::bigint
    FOR UPDATE OF allocation_group
  `));
  if (!plan) {
    throw new FulfillmentAuthorityError(
      "PACKAGE_ALLOCATION_PLAN_NOT_FOUND",
      "The package-allocation plan does not exist",
      { packageAllocationPlanId },
    );
  }
  const outcome = String(plan.outcome);
  const planVersion = Number(plan.plan_version);
  const currentGroupVersion = Number(plan.current_version);
  return Object.freeze({
    current: outcome === "proposed" && planVersion === currentGroupVersion,
    outcome,
    planVersion,
    currentGroupVersion,
  });
}

async function loadPackageAllocationCommercialIntents(
  tx: any,
  packageAllocationPlanId: string,
): Promise<readonly PackageAllocationCommercialIntent[]> {
  const rows = rowsOf<Record<string, unknown>>(await tx.execute(sql`
    SELECT
      intent.id::text AS id,
      intent.package_allocation_source_line_id::text AS package_allocation_source_line_id,
      source.source_wms_shipment_item_id,
      intent.quantity
    FROM wms.package_allocation_effect_intents AS intent
    JOIN wms.package_allocation_source_lines AS source
      ON source.id = intent.package_allocation_source_line_id
    WHERE intent.package_allocation_plan_id = ${packageAllocationPlanId}::bigint
      AND intent.effect_type = 'commercial_fulfillment'
      AND intent.executable = FALSE
    ORDER BY source.source_wms_shipment_item_id, intent.id
    FOR UPDATE OF intent
  `));
  return Object.freeze(rows.map((row) => {
    const id = bigintTextOrNull(row.id);
    const sourceId = bigintTextOrNull(row.package_allocation_source_line_id);
    const sourceWmsShipmentItemId = asPositiveInteger(row.source_wms_shipment_item_id);
    const quantity = asPositiveInteger(row.quantity);
    if (!id || !sourceId || !sourceWmsShipmentItemId || !quantity) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_ALLOCATION_EFFECT_CONFLICT",
        "A persisted commercial intent has invalid identity or quantity",
        { packageAllocationPlanId, intentId: row.id },
      );
    }
    return Object.freeze({
      id,
      packageAllocationSourceLineId: sourceId,
      sourceWmsShipmentItemId,
      quantity,
    });
  }));
}

async function loadPackageAllocationCommercialCustomerItems(
  tx: any,
  packageAllocationPlanId: string,
  expectedIntentCount: number,
): Promise<ReadonlyMap<number, CanonicalCustomerItem>> {
  const rows = rowsOf<LegacyPackageRow>(await tx.execute(sql`
    SELECT
      shipment.id AS legacy_shipment_id,
      wms_order.id AS wms_order_id,
      shipment.status::text AS shipment_status,
      shipment.shipment_purpose,
      COALESCE(
        NULLIF(BTRIM(shipment.shipping_engine), ''),
        CASE WHEN shipment.shipstation_order_id IS NOT NULL THEN 'shipstation' END
      ) AS persisted_shipping_provider,
      COALESCE(
        NULLIF(BTRIM(shipment.engine_order_ref), ''),
        shipment.shipstation_order_id::text
      ) AS persisted_provider_order_id,
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
      source.source_wms_shipment_item_id AS legacy_shipment_item_id,
      source.shipment_item_purpose,
      source.order_item_id,
      source.replacement_for_order_item_id,
      source.correction_for_shipment_item_id,
      source.product_variant_id,
      source.sku,
      source.source_quantity::int AS quantity_shipped,
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
    FROM wms.package_allocation_effect_intents AS intent
    JOIN wms.package_allocation_source_lines AS source
      ON source.id = intent.package_allocation_source_line_id
    JOIN wms.outbound_shipment_items AS shipment_item
      ON shipment_item.id = source.source_wms_shipment_item_id
    JOIN wms.outbound_shipments AS shipment
      ON shipment.id = shipment_item.shipment_id
    JOIN wms.orders AS wms_order
      ON wms_order.id = shipment.order_id
    LEFT JOIN wms.order_items AS order_item
      ON order_item.id = source.order_item_id
    LEFT JOIN oms.oms_order_lines AS oms_line
      ON oms_line.id = order_item.oms_order_line_id
    LEFT JOIN oms.oms_orders AS oms_order
      ON oms_order.id = oms_line.order_id
    LEFT JOIN channels.channels AS channel
      ON channel.id = oms_order.channel_id
    LEFT JOIN LATERAL (
      SELECT MAX(event.paid_quantity)::int AS max_paid_quantity
      FROM oms.oms_order_line_authority_events AS event
      WHERE event.order_line_id = oms_line.id
    ) AS authority ON TRUE
    WHERE intent.package_allocation_plan_id = ${packageAllocationPlanId}::bigint
      AND intent.effect_type = 'commercial_fulfillment'
      AND intent.executable = FALSE
    ORDER BY source.source_wms_shipment_item_id
    FOR UPDATE OF shipment
  `));
  if (rows.length !== expectedIntentCount) {
    throw new FulfillmentAuthorityError(
      "OMS_LINEAGE_MISSING",
      "One or more commercial intents lack exact outbound-shipment lineage",
      { packageAllocationPlanId, expectedIntentCount, actualSourceCount: rows.length },
    );
  }
  const normalized = normalizeCustomerItems(rows);
  if (normalized.nonCustomerRows.length > 0 || normalized.customerItems.length !== expectedIntentCount) {
    throw new FulfillmentAuthorityError(
      "PACKAGE_ALLOCATION_EFFECT_CONFLICT",
      "Commercial fulfillment intents may materialize only customer-fulfillment source lines",
      {
        packageAllocationPlanId,
        commercialIntentCount: expectedIntentCount,
        customerSourceCount: normalized.customerItems.length,
        nonCustomerSourceCount: normalized.nonCustomerRows.length,
      },
    );
  }
  return new Map(normalized.customerItems.map((item) => [item.legacyWmsShipmentItemId, item]));
}

async function loadPackageAllocationCommercialEntries(
  tx: any,
  packageAllocationPlanId: string,
  intents: readonly PackageAllocationCommercialIntent[],
): Promise<readonly PackageAllocationCommercialEntry[]> {
  const intentBySource = new Map(intents.map((intent) => [intent.packageAllocationSourceLineId, intent]));
  const rows = rowsOf<Record<string, unknown>>(await tx.execute(sql`
    SELECT
      entry.id::text AS id,
      entry.package_allocation_source_line_id::text AS package_allocation_source_line_id,
      source.source_wms_shipment_item_id,
      entry.package_allocation_package_binding_id::text AS package_allocation_package_binding_id,
      binding.provider,
      binding.provider_physical_shipment_id,
      label.provider_order_id,
      label.provider_order_key,
      label.tracking_number,
      label.carrier,
      label.service_code,
      business.business_shipment_recognized_at,
      entry.quantity
    FROM wms.package_allocation_entries AS entry
    JOIN wms.package_allocation_source_lines AS source
      ON source.id = entry.package_allocation_source_line_id
    JOIN wms.package_allocation_package_bindings AS binding
      ON binding.id = entry.package_allocation_package_binding_id
     AND binding.package_allocation_group_id = entry.package_allocation_group_id
    JOIN wms.shipping_provider_labels AS label
      ON LOWER(BTRIM(label.provider)) = LOWER(BTRIM(binding.provider))
     AND BTRIM(label.provider_label_id) = BTRIM(binding.provider_physical_shipment_id)
    JOIN wms.declared_package_business_shipments AS business
      ON business.shipping_provider_label_id = label.id
    WHERE entry.package_allocation_plan_id = ${packageAllocationPlanId}::bigint
      AND entry.allocation_kind = 'primary_transfer'
      AND entry.target_kind = 'package'
      AND entry.package_allocation_source_line_id IN (
        SELECT commercial_intent.package_allocation_source_line_id
        FROM wms.package_allocation_effect_intents AS commercial_intent
        WHERE commercial_intent.package_allocation_plan_id = entry.package_allocation_plan_id
          AND commercial_intent.effect_type = 'commercial_fulfillment'
      )
      AND EXISTS (
        SELECT 1
        FROM wms.package_allocation_effect_intents AS package_intent
        WHERE package_intent.package_allocation_plan_id = entry.package_allocation_plan_id
          AND package_intent.package_allocation_package_binding_id = entry.package_allocation_package_binding_id
          AND (
            (
              package_intent.effect_type = 'active_label_tracking'
              AND label.label_status = 'active'
            )
            OR package_intent.effect_type = 'carrier_tracking'
          )
      )
    ORDER BY binding.provider, binding.provider_physical_shipment_id,
      source.source_wms_shipment_item_id, entry.id
  `));
  const totals = new Map<string, number>();
  const entries = rows.map((row): PackageAllocationCommercialEntry => {
    const id = bigintTextOrNull(row.id);
    const sourceId = bigintTextOrNull(row.package_allocation_source_line_id);
    const bindingId = bigintTextOrNull(row.package_allocation_package_binding_id);
    const sourceWmsShipmentItemId = asPositiveInteger(row.source_wms_shipment_item_id);
    const quantity = asPositiveInteger(row.quantity);
    const provider = normalizedNullable(row.provider)?.toLowerCase() ?? null;
    const providerPhysicalShipmentId = normalizedNullable(row.provider_physical_shipment_id);
    const trackingNumber = normalizedNullable(row.tracking_number);
    const carrier = normalizedNullable(row.carrier);
    const recognizedAt = toDateOrNull(row.business_shipment_recognized_at);
    const intent = sourceId ? intentBySource.get(sourceId) : undefined;
    if (
      !id || !sourceId || !bindingId || !sourceWmsShipmentItemId || !quantity
      || !provider || !providerPhysicalShipmentId || !trackingNumber || !carrier
      || !recognizedAt || !intent
    ) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_ALLOCATION_EFFECT_CONFLICT",
        "A commercial allocation entry lacks exact current package, label, or intent evidence",
        { packageAllocationPlanId, allocationEntryId: row.id },
      );
    }
    totals.set(sourceId, (totals.get(sourceId) ?? 0) + quantity);
    return Object.freeze({
      id,
      packageAllocationEffectIntentId: intent.id,
      packageAllocationSourceLineId: sourceId,
      sourceWmsShipmentItemId,
      packageAllocationPackageBindingId: bindingId,
      provider,
      providerPhysicalShipmentId,
      providerOrderId: normalizedNullable(row.provider_order_id),
      providerOrderKey: normalizedNullable(row.provider_order_key),
      trackingNumber,
      carrier,
      serviceCode: normalizedNullable(row.service_code),
      businessShipmentRecognizedAt: recognizedAt,
      quantity,
    });
  });
  for (const intent of intents) {
    const allocatedQuantity = totals.get(intent.packageAllocationSourceLineId) ?? 0;
    if (allocatedQuantity !== intent.quantity) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_ALLOCATION_EFFECT_CONFLICT",
        "Commercial intent quantity is not exactly covered by its originating package plan",
        {
          packageAllocationPlanId,
          packageAllocationEffectIntentId: intent.id,
          intentQuantity: intent.quantity,
          allocatedQuantity,
        },
      );
    }
  }
  return Object.freeze(entries);
}

function groupPackageAllocationCommercialEntries(
  entries: readonly PackageAllocationCommercialEntry[],
): readonly PackageAllocationCommercialPackage[] {
  const packages = new Map<string, PackageAllocationCommercialPackage & {
    entries: PackageAllocationCommercialEntry[];
  }>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.provider, entry.providerPhysicalShipmentId]);
    const existing = packages.get(key);
    if (existing) {
      if (
        existing.providerOrderId !== entry.providerOrderId
        || existing.providerOrderKey !== entry.providerOrderKey
        || existing.trackingNumber !== entry.trackingNumber
        || existing.carrier !== entry.carrier
        || existing.serviceCode !== entry.serviceCode
        || existing.businessShipmentRecognizedAt.getTime()
          !== entry.businessShipmentRecognizedAt.getTime()
      ) {
        throw new FulfillmentAuthorityError(
          "PACKAGE_IDENTITY_CONFLICT",
          "One package-allocation binding resolved to conflicting label evidence",
          { provider: entry.provider, providerPhysicalShipmentId: entry.providerPhysicalShipmentId },
        );
      }
      existing.entries.push(entry);
      continue;
    }
    packages.set(key, {
      provider: entry.provider,
      providerPhysicalShipmentId: entry.providerPhysicalShipmentId,
      providerOrderId: entry.providerOrderId,
      providerOrderKey: entry.providerOrderKey,
      trackingNumber: entry.trackingNumber,
      carrier: entry.carrier,
      serviceCode: entry.serviceCode,
      businessShipmentRecognizedAt: entry.businessShipmentRecognizedAt,
      entries: [entry],
    });
  }
  return Object.freeze([...packages.values()].map((pkg) => Object.freeze({
    ...pkg,
    entries: Object.freeze(pkg.entries),
  })));
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
  const existingRows = rowsOf<{
    id: number;
    provider_order_id: string | null;
    provider_order_key: string | null;
    incoming_provider_order_id_already_aliased: boolean;
  }>(await tx.execute(sql`
    SELECT
      engine.id,
      engine.provider_order_id,
      engine.provider_order_key,
      EXISTS (
        SELECT 1
        FROM wms.shipping_engine_order_provider_refs AS provider_ref
        WHERE provider_ref.shipping_engine_order_id = engine.id
          AND provider_ref.provider = ${input.shippingProvider}
          AND provider_ref.provider_order_id = ${input.providerOrderId}
      ) AS incoming_provider_order_id_already_aliased
    FROM wms.shipping_engine_orders AS engine
    WHERE engine.provider = ${input.shippingProvider}
      AND (
        (${input.providerOrderId}::text IS NOT NULL AND engine.provider_order_id = ${input.providerOrderId})
        OR (${input.providerOrderKey}::text IS NOT NULL AND engine.provider_order_key = ${input.providerOrderKey})
        OR engine.command_key = ${commandKey}
        OR EXISTS (
          SELECT 1
          FROM wms.shipping_engine_order_provider_refs AS provider_ref
          WHERE provider_ref.shipping_engine_order_id = engine.id
            AND provider_ref.provider = ${input.shippingProvider}
            AND provider_ref.provider_order_id = ${input.providerOrderId}
        )
      )
    FOR UPDATE OF engine
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
    assertCompatibleIdentity("providerOrderKey", existing.provider_order_key, input.providerOrderKey, input.legacyWmsShipmentIds[0]);
    const providerOrderIdResolution = resolveProviderOrderId({
      legacyHeaderPolicy: input.legacyHeaderPolicy,
      persistedProviderOrderId: normalizedNullable(existing.provider_order_id),
      persistedProviderOrderKey: normalizedNullable(existing.provider_order_key),
      incomingProviderOrderId: input.providerOrderId,
      incomingProviderOrderKey: input.providerOrderKey,
      incomingProviderOrderIdAlreadyAliased:
        existing.incoming_provider_order_id_already_aliased === true,
    });
    if (providerOrderIdResolution === "conflict") {
      assertCompatibleIdentity(
        "providerOrderId",
        existing.provider_order_id,
        input.providerOrderId,
        input.legacyWmsShipmentIds[0],
      );
    }
    await recordShippingEngineOrderProviderRef(
      tx,
      Number(existing.id),
      input,
      providerOrderIdResolution,
    );
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
  const shippingEngineOrderId = Number(inserted.id);
  await recordShippingEngineOrderProviderRef(
    tx,
    shippingEngineOrderId,
    input,
    "compatible",
  );
  return shippingEngineOrderId;
}

async function recordShippingEngineOrderProviderRef(
  tx: any,
  shippingEngineOrderId: number,
  input: ReturnType<typeof canonicalizeInput>,
  resolution: ReturnType<typeof resolveProviderOrderId>,
): Promise<void> {
  if (!input.providerOrderId) return;

  const stored = firstRow<{ shipping_engine_order_id: number }>(await tx.execute(sql`
    INSERT INTO wms.shipping_engine_order_provider_refs AS provider_ref (
      shipping_engine_order_id,
      provider,
      provider_order_id,
      source,
      first_observed_at,
      last_observed_at,
      metadata,
      created_at,
      updated_at
    ) VALUES (
      ${shippingEngineOrderId},
      ${input.shippingProvider},
      ${input.providerOrderId},
      'canonical_materialization',
      NOW(),
      NOW(),
      ${JSON.stringify({
        contractVersion: 1,
        inputSource: input.source,
        resolution,
      })}::jsonb,
      NOW(),
      NOW()
    )
    ON CONFLICT (provider, provider_order_id) DO UPDATE
    SET
      last_observed_at = GREATEST(
        provider_ref.last_observed_at,
        EXCLUDED.last_observed_at
      ),
      updated_at = NOW()
    WHERE provider_ref.shipping_engine_order_id = EXCLUDED.shipping_engine_order_id
    RETURNING shipping_engine_order_id
  `));
  if (!stored || Number(stored.shipping_engine_order_id) !== shippingEngineOrderId) {
    throw new FulfillmentAuthorityError(
      "CANONICAL_STATE_CONFLICT",
      "Provider order id is already assigned to another canonical shipping-engine order",
      {
        provider: input.shippingProvider,
        providerOrderId: input.providerOrderId,
        shippingEngineOrderId,
      },
    );
  }
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

async function findOrCreatePhysicalPackageAllocationCustomerItem(
  tx: any,
  item: Omit<MaterializedCustomerItem, "physicalShipmentItemId">,
  entry: PackageAllocationCommercialEntry,
  physicalShipmentId: number,
): Promise<number> {
  const existing = firstRow<{
    id: number;
    physical_shipment_id: number;
    shipment_request_item_id: number;
    fulfillment_plan_line_id: number;
    wms_order_item_id: number;
    quantity_shipped: number;
    sku: string;
  }>(await tx.execute(sql`
    SELECT
      id,
      physical_shipment_id,
      shipment_request_item_id,
      fulfillment_plan_line_id,
      wms_order_item_id,
      quantity_shipped,
      sku
    FROM wms.physical_shipment_items
    WHERE package_allocation_entry_id = ${entry.id}::bigint
    FOR UPDATE
  `));
  if (existing) {
    if (
      Number(existing.physical_shipment_id) !== physicalShipmentId
      || Number(existing.shipment_request_item_id) !== item.shipmentRequestItemId
      || Number(existing.fulfillment_plan_line_id) !== item.fulfillmentPlanLineId
      || Number(existing.wms_order_item_id) !== item.wmsOrderItemId
      || Number(existing.quantity_shipped) !== entry.quantity
      || String(existing.sku) !== item.sku
    ) {
      throw new FulfillmentAuthorityError(
        "CANONICAL_STATE_CONFLICT",
        `Physical shipment item ${existing.id} conflicts with package allocation entry ${entry.id}`,
        {
          packageAllocationEntryId: entry.id,
          physicalShipmentItemId: existing.id,
          expectedPhysicalShipmentId: physicalShipmentId,
        },
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
      package_allocation_entry_id,
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
      NULL,
      ${entry.id}::bigint,
      'customer_fulfillment',
      NULL,
      ${item.productVariantId},
      ${item.sku},
      ${entry.quantity},
      NOW()
    )
    RETURNING id
  `));
  if (!inserted) {
    throw new FulfillmentAuthorityError(
      "CANONICAL_STATE_CONFLICT",
      "Failed to create package-allocation physical shipment item",
      { packageAllocationEntryId: entry.id },
    );
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
    const productVariantId = asPositiveInteger(row.product_variant_id);
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
    if (!["replacement", "concession", "omission_correction"].includes(purpose)) {
      throw new FulfillmentAuthorityError(
        "OMS_LINEAGE_MISSING",
        `Non-customer physical item ${legacyItemId} has unsupported purpose ${purpose}`,
        { legacyShipmentItemId: legacyItemId, purpose },
      );
    }

    let correctionForPhysicalShipmentItemId: number | null = null;
    if (purpose === "omission_correction") {
      const correctionForLegacyShipmentItemId = asPositiveInteger(
        row.correction_for_shipment_item_id,
      );
      if (!correctionForLegacyShipmentItemId || !productVariantId) {
        throw new FulfillmentAuthorityError(
          "OMS_LINEAGE_MISSING",
          `Omission correction item ${legacyItemId} lacks exact original package lineage`,
          { legacyShipmentItemId: legacyItemId },
        );
      }
      const source = firstRow<{
        id: number;
        shipment_item_purpose: string;
        product_variant_id: number;
        quantity_shipped: number;
      }>(await tx.execute(sql`
        SELECT id, shipment_item_purpose, product_variant_id, quantity_shipped
        FROM wms.physical_shipment_items
        WHERE legacy_wms_shipment_item_id = ${correctionForLegacyShipmentItemId}
        FOR UPDATE
      `));
      if (
        !source
        || String(source.shipment_item_purpose) !== "customer_fulfillment"
        || Number(source.product_variant_id) !== productVariantId
        || Number(source.quantity_shipped) < quantity
      ) {
        throw new FulfillmentAuthorityError(
          "OMS_LINEAGE_MISSING",
          `Omission correction item ${legacyItemId} has no compatible canonical source line`,
          { legacyShipmentItemId: legacyItemId, correctionForLegacyShipmentItemId },
        );
      }
      correctionForPhysicalShipmentItemId = Number(source.id);
    }

    const existing = firstRow<{
      id: number;
      physical_shipment_id: number;
      shipment_item_purpose: string;
      correction_for_physical_shipment_item_id: number | null;
      quantity_shipped: number;
    }>(await tx.execute(sql`
      SELECT id, physical_shipment_id, shipment_item_purpose,
             correction_for_physical_shipment_item_id, quantity_shipped
      FROM wms.physical_shipment_items
      WHERE legacy_wms_shipment_item_id = ${legacyItemId}
      FOR UPDATE
    `));
    if (existing) {
      if (
        Number(existing.physical_shipment_id) !== physicalShipmentId
        || String(existing.shipment_item_purpose) !== purpose
        || (asPositiveInteger(existing.correction_for_physical_shipment_item_id) ?? null)
          !== correctionForPhysicalShipmentItemId
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
        correction_for_physical_shipment_item_id,
        product_variant_id,
        sku,
        quantity_shipped,
        created_at
      ) VALUES (
        ${physicalShipmentId}, NULL, NULL, NULL,
        ${legacyItemId},
        ${purpose},
        ${asPositiveInteger(row.replacement_for_order_item_id)},
        ${correctionForPhysicalShipmentItemId},
        ${productVariantId},
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
    FROM wms.effective_physical_shipment_items AS item
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

async function findLineWritebackDecisions(
  tx: any,
  items: readonly MaterializedCustomerItem[],
): Promise<Map<number, ChannelFulfillmentWritebackPolicyDecision>> {
  const decisions = new Map<number, ChannelFulfillmentWritebackPolicyDecision>();
  const uniqueLines = new Map<number, MaterializedCustomerItem>();
  for (const item of items) uniqueLines.set(item.fulfillmentPlanLineId, item);

  for (const [fulfillmentPlanLineId, item] of uniqueLines) {
    const aggregate = firstRow<{ shipped_quantity: number }>(await tx.execute(sql`
      SELECT COALESCE(SUM(quantity_shipped), 0)::int AS shipped_quantity
      FROM wms.effective_physical_shipment_items
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
    decisions.set(fulfillmentPlanLineId, decision);

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

  return decisions;
}

async function findLineWritebackEligibility(
  tx: any,
  items: readonly MaterializedCustomerItem[],
): Promise<Map<number, boolean>> {
  const decisions = await findLineWritebackDecisions(tx, items);
  return new Map(
    [...decisions.entries()].map(([fulfillmentPlanLineId, decision]) => [
      fulfillmentPlanLineId,
      decision.allowed,
    ]),
  );
}

async function insertChannelCommand(
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

async function insertPackageAllocationShadowChannelCommand(
  tx: any,
  command: ChannelFulfillmentCommand,
  input: ReturnType<typeof canonicalizePackageAllocationCommercialInput>,
  pkg: PackageAllocationCommercialPackage,
  legacyShipmentIds: readonly number[],
  materializedItems: readonly MaterializedPackageAllocationCommercialItem[],
): Promise<MaterializedChannelCommand> {
  const itemByPhysicalId = new Map(
    materializedItems.map((item) => [item.physicalShipmentItemId, item]),
  );
  const expectedItems = command.items.map((commandItem) => {
    const materialized = itemByPhysicalId.get(commandItem.physicalShipmentItemId);
    if (!materialized || materialized.allocatedQuantity !== commandItem.quantity) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_ALLOCATION_EFFECT_CONFLICT",
        "A planned shadow command item lacks exact commercial intent lineage",
        {
          commandKey: command.commandKey,
          physicalShipmentItemId: commandItem.physicalShipmentItemId,
        },
      );
    }
    return {
      ...commandItem,
      packageAllocationEntryId: materialized.packageAllocationEntryId,
      packageAllocationEffectIntentId: materialized.packageAllocationEffectIntentId,
    };
  });
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
    if (existing.request_hash !== command.requestHash || String(existing.push_status) !== "shadow") {
      throw new FulfillmentAuthorityError(
        "COMMAND_REQUEST_CONFLICT",
        "A package-allocation shadow command conflicts with prior canonical command state",
        {
          commandId: Number(existing.id),
          commandKey: command.commandKey,
          existingRequestHash: existing.request_hash,
          incomingRequestHash: command.requestHash,
          existingStatus: String(existing.push_status),
        },
      );
    }
    const persistedItems = rowsOf<Record<string, unknown>>(await tx.execute(sql`
      SELECT
        physical_shipment_item_id,
        package_allocation_effect_intent_id::text AS package_allocation_effect_intent_id,
        oms_order_line_id,
        channel_order_line_id,
        quantity_pushed
      FROM oms.channel_fulfillment_push_items
      WHERE channel_fulfillment_push_id = ${Number(existing.id)}
      ORDER BY physical_shipment_item_id
    `));
    const expected = expectedItems
      .map((item) => ({
        physicalShipmentItemId: item.physicalShipmentItemId,
        packageAllocationEffectIntentId: item.packageAllocationEffectIntentId,
        omsOrderLineId: item.omsOrderLineId,
        channelOrderLineId: item.channelOrderLineId,
        quantity: item.quantity,
      }))
      .sort((left, right) => left.physicalShipmentItemId - right.physicalShipmentItemId);
    const actual = persistedItems.map((row) => ({
      physicalShipmentItemId: asPositiveInteger(row.physical_shipment_item_id),
      packageAllocationEffectIntentId: bigintTextOrNull(row.package_allocation_effect_intent_id),
      omsOrderLineId: asPositiveInteger(row.oms_order_line_id),
      channelOrderLineId: normalizedNullable(row.channel_order_line_id),
      quantity: asPositiveInteger(row.quantity_pushed),
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new FulfillmentAuthorityError(
        "COMMAND_REQUEST_CONFLICT",
        "A replayed package-allocation shadow command has conflicting item provenance",
        { commandId: Number(existing.id), commandKey: command.commandKey },
      );
    }
    return {
      id: Number(existing.id),
      commandKey: command.commandKey,
      pushStatus: "shadow",
      replayed: true,
    };
  }

  const metadata = {
    contractVersion: 1,
    materializationContract: "package-allocation-commercial-shadow-v1",
    packageAllocationPlanId: input.packageAllocationPlanId,
    source: input.source,
    shippingProvider: pkg.provider,
    providerPhysicalShipmentId: pkg.providerPhysicalShipmentId,
    providerOrderId: pkg.providerOrderId,
    legacyWmsShipmentIds: [...legacyShipmentIds].sort((left, right) => left - right),
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
      'shadow',
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
    throw new FulfillmentAuthorityError(
      "CANONICAL_STATE_CONFLICT",
      "Failed to create package-allocation shadow channel command",
      { commandKey: command.commandKey },
    );
  }
  for (const item of expectedItems) {
    await tx.execute(sql`
      INSERT INTO oms.channel_fulfillment_push_items (
        channel_fulfillment_push_id,
        physical_shipment_item_id,
        oms_order_line_id,
        channel_order_line_id,
        quantity_pushed,
        package_allocation_effect_intent_id,
        metadata,
        created_at
      ) VALUES (
        ${Number(inserted.id)},
        ${item.physicalShipmentItemId},
        ${item.omsOrderLineId},
        ${item.channelOrderLineId},
        ${item.quantity},
        ${item.packageAllocationEffectIntentId}::bigint,
        ${JSON.stringify({
          contractVersion: 1,
          shipmentRequestItemId: item.shipmentRequestItemId,
          packageAllocationEntryId: item.packageAllocationEntryId,
        })}::jsonb,
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

async function assertPackageAllocationCommercialIntentCoverage(
  tx: any,
  intents: readonly PackageAllocationCommercialIntent[],
): Promise<void> {
  if (intents.length === 0) return;
  const intentIds = sql.join(intents.map((intent) => sql`${intent.id}::bigint`), sql`, `);
  const rows = rowsOf<Record<string, unknown>>(await tx.execute(sql`
    SELECT
      package_allocation_effect_intent_id::text AS intent_id,
      COALESCE(SUM(quantity_pushed), 0)::int AS materialized_quantity
    FROM oms.channel_fulfillment_push_items
    WHERE package_allocation_effect_intent_id IN (${intentIds})
    GROUP BY package_allocation_effect_intent_id
    ORDER BY package_allocation_effect_intent_id
  `));
  const totals = new Map(rows.map((row) => [
    bigintTextOrNull(row.intent_id),
    Number(row.materialized_quantity),
  ]));
  for (const intent of intents) {
    const materializedQuantity = totals.get(intent.id) ?? 0;
    if (materializedQuantity !== intent.quantity) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_ALLOCATION_EFFECT_CONFLICT",
        "Commercial intent was not exactly covered by its shadow command items",
        {
          packageAllocationEffectIntentId: intent.id,
          intentQuantity: intent.quantity,
          materializedQuantity,
        },
      );
    }
  }
}

async function loadCompletedPackageAllocationCommercialMaterialization(
  tx: any,
  input: ReturnType<typeof canonicalizePackageAllocationCommercialInput>,
  intents: readonly PackageAllocationCommercialIntent[],
): Promise<MaterializePackageAllocationCommercialFulfillmentResult | null> {
  if (intents.length === 0) return null;
  const intentIds = sql.join(intents.map((intent) => sql`${intent.id}::bigint`), sql`, `);
  const coverageRows = rowsOf<Record<string, unknown>>(await tx.execute(sql`
    SELECT
      package_allocation_effect_intent_id::text AS intent_id,
      COALESCE(SUM(quantity_pushed), 0)::int AS materialized_quantity
    FROM oms.channel_fulfillment_push_items
    WHERE package_allocation_effect_intent_id IN (${intentIds})
    GROUP BY package_allocation_effect_intent_id
  `));
  const coverage = new Map(coverageRows.map((row) => [
    bigintTextOrNull(row.intent_id),
    Number(row.materialized_quantity),
  ]));
  if (intents.some((intent) => coverage.get(intent.id) !== intent.quantity)) return null;

  const rows = rowsOf<Record<string, unknown>>(await tx.execute(sql`
    SELECT DISTINCT
      command.id,
      command.command_key,
      command.push_status,
      command.physical_shipment_id,
      command.metadata
    FROM oms.channel_fulfillment_push_items AS item
    JOIN oms.channel_fulfillment_pushes AS command
      ON command.id = item.channel_fulfillment_push_id
    WHERE item.package_allocation_effect_intent_id IN (${intentIds})
    ORDER BY command.physical_shipment_id, command.id
  `));
  if (rows.length === 0) return null;
  const commands: MaterializedChannelCommand[] = [];
  const physicalShipmentIds = new Set<number>();
  for (const row of rows) {
    const id = asPositiveInteger(row.id);
    const physicalShipmentId = asPositiveInteger(row.physical_shipment_id);
    const commandKey = normalizedNullable(row.command_key);
    const pushStatus = normalizedNullable(row.push_status);
    const metadata = row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : null;
    if (
      !id || !physicalShipmentId || !commandKey || !pushStatus || !metadata
      || metadata.materializationContract !== "package-allocation-commercial-shadow-v1"
      || metadata.packageAllocationPlanId !== input.packageAllocationPlanId
      || metadata.source !== input.source
    ) {
      throw new FulfillmentAuthorityError(
        "COMMAND_REQUEST_CONFLICT",
        "Persisted package-allocation commercial coverage has conflicting command metadata",
        { packageAllocationPlanId: input.packageAllocationPlanId, commandId: row.id },
      );
    }
    physicalShipmentIds.add(physicalShipmentId);
    commands.push({ id, commandKey, pushStatus, replayed: true });
  }
  const countRow = firstRow<{ item_count: number }>(await tx.execute(sql`
    SELECT COUNT(DISTINCT physical_shipment_item_id)::int AS item_count
    FROM oms.channel_fulfillment_push_items
    WHERE package_allocation_effect_intent_id IN (${intentIds})
  `));
  return Object.freeze({
    packageAllocationPlanId: input.packageAllocationPlanId,
    physicalShipmentIds: Object.freeze([...physicalShipmentIds].sort((left, right) => left - right)),
    channelCommands: Object.freeze(commands),
    customerFulfillmentItemCount: Number(countRow?.item_count ?? 0),
    replayed: true,
  });
}

async function loadExistingChannelCommandSnapshots(
  tx: any,
  command: ChannelFulfillmentCommand,
): Promise<ExistingChannelFulfillmentCommandSnapshot[]> {
  const rows = rowsOf<any>(await tx.execute(sql`
    SELECT
      command.id,
      command.command_key,
      command.request_hash,
      command.push_status,
      command.last_error_code,
      command.tracking_number,
      command.carrier,
      command.metadata,
      item.physical_shipment_item_id,
      physical_item.shipment_request_item_id,
      item.oms_order_line_id,
      item.channel_order_line_id,
      item.quantity_pushed
    FROM oms.channel_fulfillment_pushes AS command
    LEFT JOIN oms.channel_fulfillment_push_items AS item
      ON item.channel_fulfillment_push_id = command.id
    LEFT JOIN wms.physical_shipment_items AS physical_item
      ON physical_item.id = item.physical_shipment_item_id
    WHERE command.channel_provider = ${command.channelProvider}
      AND command.oms_order_id = ${command.omsOrderId}
      AND command.physical_shipment_id = ${command.physicalShipmentId}
    ORDER BY command.id, item.physical_shipment_item_id
    FOR UPDATE OF command
  `));
  const snapshots = new Map<number, {
    id: number;
    commandKey: string;
    requestHash: string | null;
    pushStatus: string;
    lastErrorCode: string | null;
    trackingNumber: string | null;
    carrier: string | null;
    shippingProvider: string | null;
    providerPhysicalShipmentId: string | null;
    items: ChannelFulfillmentCommand["items"][number][];
  }>();
  for (const row of rows) {
    const id = Number(row.id);
    const metadata = row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : {};
    const snapshot = snapshots.get(id) ?? {
      id,
      commandKey: String(row.command_key),
      requestHash: normalizedNullable(row.request_hash),
      pushStatus: String(row.push_status),
      lastErrorCode: normalizedNullable(row.last_error_code),
      trackingNumber: normalizedNullable(row.tracking_number),
      carrier: normalizedNullable(row.carrier),
      shippingProvider: normalizedNullable(metadata.shippingProvider)?.toLowerCase() ?? null,
      providerPhysicalShipmentId: normalizedNullable(metadata.providerPhysicalShipmentId),
      items: [],
    };
    const physicalShipmentItemId = asPositiveInteger(row.physical_shipment_item_id);
    if (physicalShipmentItemId) {
      const shipmentRequestItemId = asPositiveInteger(row.shipment_request_item_id);
      const omsOrderLineId = asPositiveInteger(row.oms_order_line_id);
      const channelOrderLineId = normalizedNullable(row.channel_order_line_id);
      const quantity = asPositiveInteger(row.quantity_pushed);
      if (!shipmentRequestItemId || !omsOrderLineId || !channelOrderLineId || !quantity) {
        throw new FulfillmentAuthorityError(
          "CANONICAL_STATE_CONFLICT",
          `Channel fulfillment command ${id} has incomplete immutable item lineage`,
          { commandId: id, physicalShipmentItemId },
        );
      }
      snapshot.items.push({
        physicalShipmentItemId,
        shipmentRequestItemId,
        omsOrderLineId,
        channelOrderLineId,
        quantity,
      });
    }
    snapshots.set(id, snapshot);
  }
  return [...snapshots.values()].map((snapshot) => Object.freeze({
    ...snapshot,
    items: Object.freeze(snapshot.items),
  }));
}

async function requeueCompatibleCommandConflict(
  tx: any,
  commandId: number,
  incomingRequestHash: string,
): Promise<boolean> {
  const idempotencyKey = `canonical-command-repair:${incomingRequestHash}`;
  const result = rowsOf<any>(await tx.execute(sql`
    WITH audit AS (
      INSERT INTO oms.channel_fulfillment_push_requeues (
        channel_fulfillment_push_id,
        idempotency_key,
        operator,
        reason,
        previous_status,
        previous_attempt_count,
        previous_error_code,
        previous_error_message,
        previous_request_hash,
        created_at
      )
      SELECT
        command.id,
        ${idempotencyKey},
        'system:canonical_materializer',
        'immutable command is an exact subset of the current canonical physical package',
        command.push_status,
        command.attempt_count,
        command.last_error_code,
        command.last_error,
        command.request_hash,
        NOW()
      FROM oms.channel_fulfillment_pushes AS command
      WHERE command.id = ${commandId}
        AND command.push_status = 'review'
        AND command.last_error_code = 'COMMAND_REQUEST_CONFLICT'
      ON CONFLICT (channel_fulfillment_push_id, idempotency_key) DO NOTHING
      RETURNING channel_fulfillment_push_id
    )
    UPDATE oms.channel_fulfillment_pushes AS command
    SET push_status = 'pending',
        next_attempt_at = NOW(),
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = NULL,
        last_error = NULL,
        completed_at = NULL,
        updated_at = NOW()
    FROM audit
    WHERE command.id = audit.channel_fulfillment_push_id
      AND command.push_status = 'review'
      AND command.last_error_code = 'COMMAND_REQUEST_CONFLICT'
    RETURNING command.id
  `));
  return result.length === 1;
}

async function persistChannelCommandSet(
  tx: any,
  command: ChannelFulfillmentCommand,
  input: ReturnType<typeof canonicalizeInput>,
  legacyShipmentIds: readonly number[],
): Promise<MaterializedChannelCommand[]> {
  const existing = await loadExistingChannelCommandSnapshots(tx, command);
  if (existing.length === 0) {
    return [await insertChannelCommand(tx, command, input, legacyShipmentIds)];
  }

  const reconciliation = reconcileChannelFulfillmentCommandSet({
    existingCommands: existing,
    incomingCommand: command,
    shippingProvider: input.shippingProvider,
    providerPhysicalShipmentId: input.providerPhysicalShipmentId,
  });
  if (reconciliation.kind === "conflict") {
    const activeIds = existing
      .filter((snapshot) => ACTIVE_COMMAND_STATUSES.has(snapshot.pushStatus))
      .map((snapshot) => snapshot.id);
    if (activeIds.length > 0) {
      await tx.execute(sql`
        UPDATE oms.channel_fulfillment_pushes
        SET push_status = 'review',
            last_error_code = 'COMMAND_REQUEST_CONFLICT',
            last_error = ${`Canonical command reconciliation failed: ${reconciliation.reason}`},
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE id IN (${buildIdList(activeIds)})
      `);
    }
    throw new FulfillmentAuthorityError(
      "COMMAND_REQUEST_CONFLICT",
      "Canonical physical package conflicts with prior immutable channel command coverage",
      {
        commandKey: command.commandKey,
        reason: reconciliation.reason,
        ...reconciliation.evidence,
      },
    );
  }

  const requeuedCommandIds = new Set<number>();
  for (const commandId of reconciliation.requeueCommandIds) {
    const requeued = await requeueCompatibleCommandConflict(
      tx,
      commandId,
      command.requestHash,
    );
    if (!requeued) {
      throw new FulfillmentAuthorityError(
        "COMMAND_REQUEST_CONFLICT",
        "Compatible channel command could not be requeued with a new audit record",
        { commandId, commandKey: command.commandKey },
      );
    }
    requeuedCommandIds.add(commandId);
  }

  const materialized: MaterializedChannelCommand[] = existing.map((snapshot) => ({
    id: snapshot.id,
    commandKey: snapshot.commandKey,
    pushStatus: requeuedCommandIds.has(snapshot.id)
      ? "pending"
      : snapshot.pushStatus,
    replayed: true,
  }));
  if (reconciliation.missingItems.length === 0) return materialized;

  const supplementalScope = buildSupplementalChannelFulfillmentScope(
    reconciliation.missingItems,
  );
  const supplemental = planChannelFulfillmentCommands({
    physicalShipmentId: command.physicalShipmentId,
    shippingProvider: input.shippingProvider,
    providerPhysicalShipmentId: input.providerPhysicalShipmentId,
    trackingNumber: command.trackingNumber,
    carrier: command.carrier,
    trackingUrl: command.trackingUrl,
    shippedAt: command.shippedAt,
    items: reconciliation.missingItems.map((item) => ({
      physicalShipmentItemId: item.physicalShipmentItemId,
      shipmentRequestItemId: item.shipmentRequestItemId,
      omsOrderId: command.omsOrderId,
      omsOrderLineId: item.omsOrderLineId,
      channelProvider: command.channelProvider,
      channelOrderLineId: item.channelOrderLineId,
      channelFulfillmentScopeKey: supplementalScope,
      quantityShipped: item.quantity,
    })),
  });
  if (supplemental.length !== 1) {
    throw new FulfillmentAuthorityError(
      "CANONICAL_STATE_CONFLICT",
      "Supplemental channel command planning did not produce exactly one command",
      { commandKey: command.commandKey, supplementalCount: supplemental.length },
    );
  }
  materialized.push(await insertChannelCommand(
    tx,
    supplemental[0],
    input,
    legacyShipmentIds,
  ));
  return materialized;
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
      && parsedPhysical.provider !== input.shippingProvider
    ) {
      throw new FulfillmentAuthorityError(
        "PACKAGE_IDENTITY_CONFLICT",
        `Legacy shipment ${row.legacy_shipment_id} belongs to another shipping provider`,
        { persistedPhysicalIdentity: row.persisted_physical_identity, providerPhysicalShipmentId: input.providerPhysicalShipmentId },
      );
    }
    if (input.legacyHeaderPolicy === "strict") {
      if (
        parsedPhysical
        && parsedPhysical.providerPhysicalShipmentId !== input.providerPhysicalShipmentId
      ) {
        throw new FulfillmentAuthorityError(
          "PACKAGE_IDENTITY_CONFLICT",
          `Legacy shipment ${row.legacy_shipment_id} belongs to another physical package`,
          {
            persistedPhysicalIdentity: row.persisted_physical_identity,
            providerPhysicalShipmentId: input.providerPhysicalShipmentId,
          },
        );
      }
      assertCompatibleIdentity("providerOrderId", row.persisted_provider_order_id, input.providerOrderId, row.legacy_shipment_id);
      assertCompatibleIdentity("providerOrderKey", row.persisted_provider_order_key, input.providerOrderKey, row.legacy_shipment_id);
      assertCompatibleIdentity("trackingNumber", row.persisted_tracking_number, input.trackingNumber, row.legacy_shipment_id);
      assertCompatibleIdentity("carrier", row.persisted_carrier, input.carrier, row.legacy_shipment_id);
    }
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

  async function materializePackageAllocationCommercialFulfillment(
    rawInput: MaterializePackageAllocationCommercialFulfillmentInput,
  ): Promise<MaterializePackageAllocationCommercialFulfillmentResult> {
    const input = canonicalizePackageAllocationCommercialInput(rawInput);
    if (typeof db?.transaction !== "function") {
      throw new FulfillmentAuthorityError(
        "INVALID_INPUT",
        "Package-allocation commercial materialization requires transactional database support",
      );
    }

    return db.transaction(async (tx: any) => {
      const planState = await lockCurrentPackageAllocationCommercialPlan(
        tx,
        input.packageAllocationPlanId,
      );
      const intents = await loadPackageAllocationCommercialIntents(
        tx,
        input.packageAllocationPlanId,
      );
      if (intents.length === 0) {
        return Object.freeze({
          packageAllocationPlanId: input.packageAllocationPlanId,
          physicalShipmentIds: Object.freeze([]),
          channelCommands: Object.freeze([]),
          customerFulfillmentItemCount: 0,
          replayed: true,
        });
      }
      const completed = await loadCompletedPackageAllocationCommercialMaterialization(
        tx,
        input,
        intents,
      );
      if (completed) return completed;
      if (!planState.current) {
        throw new FulfillmentAuthorityError(
          "PACKAGE_ALLOCATION_PLAN_STALE",
          "Commercial fulfillment requires the current proposed package-allocation plan",
          {
            packageAllocationPlanId: input.packageAllocationPlanId,
            planVersion: planState.planVersion,
            currentGroupVersion: planState.currentGroupVersion,
            outcome: planState.outcome,
          },
        );
      }
      const customerItems = await loadPackageAllocationCommercialCustomerItems(
        tx,
        input.packageAllocationPlanId,
        intents.length,
      );
      const entries = await loadPackageAllocationCommercialEntries(
        tx,
        input.packageAllocationPlanId,
        intents,
      );
      const packages = groupPackageAllocationCommercialEntries(entries);
      if (packages.length === 0) {
        throw new FulfillmentAuthorityError(
          "PACKAGE_ALLOCATION_EFFECT_CONFLICT",
          "Commercial intents have no exact qualifying physical packages",
          { packageAllocationPlanId: input.packageAllocationPlanId },
        );
      }

      const lockKeys = new Set<string>();
      for (const pkg of packages) {
        const providerOrderIdentity = pkg.providerOrderId ?? pkg.providerOrderKey;
        if (!providerOrderIdentity) {
          throw new FulfillmentAuthorityError(
            "PROVIDER_ORDER_IDENTITY_MISSING",
            "A package-allocation commercial package requires provider order identity",
            {
              packageAllocationPlanId: input.packageAllocationPlanId,
              shippingProvider: pkg.provider,
              providerPhysicalShipmentId: pkg.providerPhysicalShipmentId,
            },
          );
        }
        lockKeys.add(`fulfillment:provider-order:${pkg.provider}:${providerOrderIdentity}`);
        lockKeys.add(`fulfillment:physical-package:${pkg.provider}:${pkg.providerPhysicalShipmentId}`);
      }
      for (const key of [...lockKeys].sort()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      }

      const stagedBySourceItemId = new Map<
        number,
        Omit<MaterializedCustomerItem, "physicalShipmentItemId">
      >();
      for (const item of [...customerItems.values()].sort(
        (left, right) => left.legacyWmsShipmentItemId - right.legacyWmsShipmentItemId,
      )) {
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
        stagedBySourceItemId.set(item.legacyWmsShipmentItemId, {
          ...item,
          fulfillmentPlanId,
          fulfillmentPlanLineId,
          shipmentRequestId,
          shipmentRequestItemId,
        });
      }

      const materializedPackages: Array<{
        readonly pkg: PackageAllocationCommercialPackage;
        readonly canonicalInput: ReturnType<typeof canonicalizeInput>;
        readonly physicalShipmentId: number;
        readonly items: readonly MaterializedPackageAllocationCommercialItem[];
      }> = [];
      for (const pkg of packages) {
        const packageItems = pkg.entries.map((entry) => {
          const staged = stagedBySourceItemId.get(entry.sourceWmsShipmentItemId);
          if (!staged) {
            throw new FulfillmentAuthorityError(
              "OMS_LINEAGE_MISSING",
              "A package allocation entry has no staged OMS/WMS source lineage",
              {
                packageAllocationPlanId: input.packageAllocationPlanId,
                packageAllocationEntryId: entry.id,
              },
            );
          }
          return { entry, staged };
        });
        const legacyShipmentIds = [...new Set(
          packageItems.map(({ staged }) => staged.legacyWmsShipmentId),
        )].sort((left, right) => left - right);
        const canonicalInput = canonicalizeInput({
          legacyWmsShipmentIds: legacyShipmentIds,
          shippingProvider: pkg.provider,
          providerPhysicalShipmentId: pkg.providerPhysicalShipmentId,
          providerOrderId: pkg.providerOrderId,
          providerOrderKey: pkg.providerOrderKey,
          trackingNumber: pkg.trackingNumber,
          carrier: pkg.carrier,
          trackingUrl: null,
          serviceCode: pkg.serviceCode,
          shippedAt: pkg.businessShipmentRecognizedAt,
          source: input.source,
          correlationId: input.correlationId,
          causationId: input.causationId,
          suppressChannelWriteback: false,
          suppressChannelProviders: [],
          legacyHeaderPolicy: "aggregate_projection",
        });
        const shippingEngineOrderId = await findOrCreateShippingEngineOrder(
          tx,
          canonicalInput,
        );
        await linkShippingEngineRequests(
          tx,
          shippingEngineOrderId,
          packageItems.map(({ staged }) => staged.shipmentRequestId),
        );
        const physicalShipmentId = await findOrCreatePhysicalShipment(
          tx,
          canonicalInput,
          shippingEngineOrderId,
        );
        const materializedItems: MaterializedPackageAllocationCommercialItem[] = [];
        for (const { entry, staged } of packageItems) {
          const physicalShipmentItemId = await findOrCreatePhysicalPackageAllocationCustomerItem(
            tx,
            staged,
            entry,
            physicalShipmentId,
          );
          materializedItems.push({
            ...staged,
            physicalShipmentItemId,
            packageAllocationEntryId: entry.id,
            packageAllocationEffectIntentId: entry.packageAllocationEffectIntentId,
            allocatedQuantity: entry.quantity,
          });
        }
        materializedPackages.push({
          pkg,
          canonicalInput,
          physicalShipmentId,
          items: Object.freeze(materializedItems),
        });
      }

      const allMaterializedItems = materializedPackages.flatMap((pkg) => pkg.items);
      const planLineIds = [...new Set(
        allMaterializedItems.map((item) => item.fulfillmentPlanLineId),
      )].sort((left, right) => left - right);
      for (const fulfillmentPlanLineId of planLineIds) {
        await recalculatePlanLine(tx, fulfillmentPlanLineId);
      }
      const writebackDecisions = await findLineWritebackDecisions(
        tx,
        allMaterializedItems,
      );
      const blockedLines = [...writebackDecisions.entries()]
        .filter(([, decision]) => !decision.allowed)
        .map(([fulfillmentPlanLineId, decision]) => ({
          fulfillmentPlanLineId,
          reasons: decision.reasons,
        }));
      if (blockedLines.length > 0) {
        throw new FulfillmentAuthorityError(
          "CHANNEL_WRITEBACK_NOT_AUTHORIZED",
          "Package-allocation commercial fulfillment is blocked by current OMS authority",
          { packageAllocationPlanId: input.packageAllocationPlanId, blockedLines },
        );
      }

      const persistedCommands: MaterializedChannelCommand[] = [];
      for (const materializedPackage of materializedPackages) {
        const commands = planChannelFulfillmentCommands({
          physicalShipmentId: materializedPackage.physicalShipmentId,
          shippingProvider: materializedPackage.pkg.provider,
          providerPhysicalShipmentId: materializedPackage.pkg.providerPhysicalShipmentId,
          trackingNumber: materializedPackage.pkg.trackingNumber,
          carrier: materializedPackage.pkg.carrier,
          trackingUrl: null,
          shippedAt: materializedPackage.pkg.businessShipmentRecognizedAt.toISOString(),
          items: materializedPackage.items.map((item) => ({
            physicalShipmentItemId: item.physicalShipmentItemId,
            shipmentRequestItemId: item.shipmentRequestItemId,
            omsOrderId: item.omsOrderId,
            omsOrderLineId: item.omsOrderLineId,
            channelProvider: item.channelProvider,
            channelOrderLineId: item.channelOrderLineId,
            channelFulfillmentScopeKey: "order",
            quantityShipped: item.allocatedQuantity,
          })),
        });
        for (const command of commands) {
          const commandItems = materializedPackage.items.filter((item) => (
            item.omsOrderId === command.omsOrderId
            && item.channelProvider === command.channelProvider
          ));
          const legacyShipmentIds = [...new Set(
            commandItems.map((item) => item.legacyWmsShipmentId),
          )];
          persistedCommands.push(await insertPackageAllocationShadowChannelCommand(
            tx,
            command,
            input,
            materializedPackage.pkg,
            legacyShipmentIds,
            commandItems,
          ));
        }
      }
      await assertPackageAllocationCommercialIntentCoverage(tx, intents);

      return Object.freeze({
        packageAllocationPlanId: input.packageAllocationPlanId,
        physicalShipmentIds: Object.freeze(materializedPackages.map((pkg) => pkg.physicalShipmentId)),
        channelCommands: Object.freeze(persistedCommands),
        customerFulfillmentItemCount: allMaterializedItems.length,
        replayed: persistedCommands.every((command) => command.replayed),
      });
    });
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
          shipment_item.correction_for_shipment_item_id,
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

      const writebackCandidateItems = input.suppressChannelWriteback
        ? []
        : materializedCustomerItems.filter(
            (item) => !input.suppressChannelProviders.includes(item.channelProvider),
          );
      const lineWritebackEligibility = await findLineWritebackEligibility(
        tx,
        writebackCandidateItems,
      );

      const channelEligibleCustomerItems = writebackCandidateItems.filter(
        (item) => lineWritebackEligibility.get(item.fulfillmentPlanLineId) === true,
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
        persistedCommands.push(...await persistChannelCommandSet(
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
              completed_at = CASE
                WHEN attempt_count >= max_attempts THEN ${input.now}::timestamptz
                ELSE NULL::timestamptz
              END,
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
          push_item.package_allocation_effect_intent_id,
          physical_item.package_allocation_entry_id,
          COALESCE(
            physical_item.shipment_request_item_id,
            allocation_source.shipment_request_item_id
          ) AS shipment_request_item_id,
          COALESCE(
            physical_item.legacy_wms_shipment_item_id,
            allocation_source.source_wms_shipment_item_id
          ) AS legacy_wms_shipment_item_id,
          legacy_item.shipment_id AS legacy_wms_shipment_id,
          push_item.oms_order_line_id,
          push_item.channel_order_line_id,
          push_item.quantity_pushed
        FROM oms.channel_fulfillment_push_items AS push_item
        JOIN wms.physical_shipment_items AS physical_item
          ON physical_item.id = push_item.physical_shipment_item_id
        LEFT JOIN wms.package_allocation_entries AS allocation_entry
          ON allocation_entry.id = physical_item.package_allocation_entry_id
        LEFT JOIN wms.package_allocation_source_lines AS allocation_source
          ON allocation_source.id = allocation_entry.package_allocation_source_line_id
        JOIN wms.outbound_shipment_items AS legacy_item
          ON legacy_item.id = COALESCE(
            physical_item.legacy_wms_shipment_item_id,
            allocation_source.source_wms_shipment_item_id
          )
        WHERE push_item.channel_fulfillment_push_id IN (${buildIdList(dueIds)})
        ORDER BY push_item.channel_fulfillment_push_id, push_item.physical_shipment_item_id
      `));
      const itemsByCommand = new Map<number, ClaimedChannelFulfillmentCommandItem[]>();
      for (const item of itemRows) {
        const commandId = Number(item.channel_fulfillment_push_id);
        const list = itemsByCommand.get(commandId) ?? [];
        const physicalShipmentItemId = asPositiveInteger(item.physical_shipment_item_id);
        const packageAllocationEntryId = asPositiveInteger(item.package_allocation_entry_id);
        const packageAllocationEffectIntentId = asPositiveInteger(
          item.package_allocation_effect_intent_id,
        );
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
          packageAllocationEntryId,
          packageAllocationEffectIntentId,
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
            completed_at = CASE
              WHEN ${terminal}::boolean THEN ${input.completedAt}::timestamptz
              ELSE NULL::timestamptz
            END,
            updated_at = ${input.completedAt}
        WHERE id = ${input.commandId}
      `);
    });
  }

  return {
    resolveLegacyPhysicalPackage,
    materializePhysicalPackage,
    materializePackageAllocationCommercialFulfillment,
    claimCommands,
    completeAttempt,
  };
}
