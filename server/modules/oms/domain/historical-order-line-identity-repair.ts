import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJson } from "@shared/utils/canonical-json";
import {
  normalizeShopifyLineVariantId,
  type ResolvedOrderLineIdentity,
} from "./order-line-catalog-identity";

const positiveInteger = z.number().int().positive().safe();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const safeText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .regex(/^[^\u0000-\u001f\u007f]*$/);

export const historicalIdentityRepairOrderIdSchema = positiveInteger;
export const historicalIdentityRepairApplySchema = z.object({
  expectedPreviewHash: hash,
  idempotencyKey: z.string().uuid(),
  reason: safeText(500),
});

export type HistoricalIdentityRepairApplyInput = z.infer<
  typeof historicalIdentityRepairApplySchema
>;

export class HistoricalIdentityRepairError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "HistoricalIdentityRepairError";
  }
}

export interface HistoricalRepairOrderEvidence {
  readonly id: number;
  readonly channelId: number;
  readonly status: string;
  readonly fulfillmentStatus: string | null;
  readonly financialStatus: string | null;
  readonly linkedWmsOrderIds: readonly number[];
}

export interface HistoricalRepairOmsLineEvidence {
  readonly id: number;
  readonly orderId: number;
  readonly productVariantId: number | null;
  readonly externalLineItemId: string | null;
  readonly externalProductId: string | null;
  readonly sourceSku: string | null;
  readonly quantity: number;
  readonly requiresShipping: boolean | null;
  readonly giftCard: boolean | null;
  readonly productExists: boolean | null;
  readonly authoritySourceInboxId: number | null;
}

export interface HistoricalRepairWmsItemEvidence {
  readonly id: number;
  readonly orderId: number;
  readonly warehouseStatus: string;
  readonly productVariantId: number | null;
  readonly sku: string;
  readonly quantity: number;
  readonly status: string;
  readonly pickedQuantity: number;
  readonly fulfilledQuantity: number;
}

export interface HistoricalRepairSourceInboxEvidence {
  readonly id: number;
  readonly provider: string;
  readonly topic: string;
  readonly status: string;
  readonly payload: unknown;
}

export interface HistoricalRepairLineEvidence {
  readonly omsLine: HistoricalRepairOmsLineEvidence;
  readonly wmsItems: readonly HistoricalRepairWmsItemEvidence[];
  readonly sourceInbox: HistoricalRepairSourceInboxEvidence | null;
}

export interface HistoricalRepairOrderAggregate {
  readonly order: HistoricalRepairOrderEvidence;
  readonly lines: readonly HistoricalRepairLineEvidence[];
}

export interface HistoricalRepairSourceLineIdentity {
  readonly externalLineItemId: string;
  readonly externalProductId: string;
  readonly externalVariantId: string;
  readonly sku: string | null;
}

export type HistoricalRepairLineDisposition = "safe" | "review";

export interface HistoricalRepairLinePreview {
  readonly omsOrderLineId: number;
  readonly disposition: HistoricalRepairLineDisposition;
  readonly code: string;
  readonly message: string;
  readonly sourceInboxId: number | null;
  readonly externalLineItemId: string | null;
  readonly externalProductId: string | null;
  readonly externalVariantId: string | null;
  readonly sourceSku: string | null;
  readonly currentOmsVariantId: number | null;
  readonly currentOmsQuantity: number;
  readonly resolvedVariantId: number | null;
  readonly resolvedCatalogSku: string | null;
  readonly wmsOrderId: number | null;
  readonly wmsOrderItemId: number | null;
  readonly currentWmsVariantId: number | null;
  readonly currentWmsSku: string | null;
  readonly currentWmsQuantity: number | null;
  readonly wmsItemStatus: string | null;
  readonly pickedQuantity: number | null;
  readonly fulfilledQuantity: number | null;
}

export interface HistoricalIdentityRepairPreview {
  readonly contractVersion: 1;
  readonly generatedAt: string;
  readonly omsOrderId: number;
  readonly channelId: number;
  readonly orderStatus: string;
  readonly linkedWmsOrderIds: readonly number[];
  readonly previewHash: string;
  readonly safeCount: number;
  readonly reviewCount: number;
  readonly lines: readonly HistoricalRepairLinePreview[];
}

export interface HistoricalIdentityRepairLineChange {
  readonly omsOrderLineId: number;
  readonly wmsOrderItemId: number;
  readonly previousOmsVariantId: number | null;
  readonly productVariantId: number;
  readonly previousWmsVariantId: number | null;
  readonly previousWmsSku: string;
  readonly catalogSku: string;
}

export interface HistoricalIdentityRepairPreparedResult {
  readonly contractVersion: 1;
  readonly omsOrderId: number;
  readonly wmsOrderId: number;
  readonly previewHash: string;
  readonly repairedLines: readonly HistoricalIdentityRepairLineChange[];
}

export interface HistoricalIdentityRepairCommandRecord {
  readonly id: number;
  readonly omsOrderId: number;
  readonly wmsOrderId: number;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly previewHash: string;
  readonly operator: string;
  readonly reason: string;
  readonly status: "claim_pending" | "succeeded" | "failed";
  readonly targetOmsLineIds: readonly number[];
  readonly repairResult: HistoricalIdentityRepairPreparedResult;
  readonly claimResult: unknown;
  readonly lastErrorCode: string | null;
  readonly lastError: string | null;
}

const TERMINAL_OMS_STATUSES = new Set(["cancelled", "refunded", "shipped", "delivered"]);
const TERMINAL_WMS_STATUSES = new Set(["cancelled", "shipped", "completed"]);
const SAFE_WMS_ORDER_STATUSES = new Set(["pending", "ready"]);
const SUPPORTED_SOURCE_TOPICS = new Set(["orders/paid", "orders/updated"]);

function normalizeExternalProductId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("source product_id must be a lossless positive identity");
    }
    return String(value);
  }
  if (typeof value !== "string") throw new Error("source product_id is required");
  const normalized = value.trim().replace(/^gid:\/\/shopify\/Product\//, "");
  if (!/^[1-9][0-9]{0,99}$/.test(normalized)) {
    throw new Error("source product_id must be a positive Shopify identity");
  }
  return normalized;
}

function normalizeExternalLineItemId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("source line item id must be a lossless positive identity");
    }
    return String(value);
  }
  if (typeof value !== "string") throw new Error("source line item id is required");
  const normalized = value.trim().replace(/^gid:\/\/shopify\/LineItem\//, "");
  if (!/^[1-9][0-9]{0,99}$/.test(normalized)) {
    throw new Error("source line item id must be a positive Shopify identity");
  }
  return normalized;
}

function normalizeSourceSku(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new Error("source sku must be text or null");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("source sku is malformed");
  }
  return normalized;
}

/** Extracts one exact line from immutable Shopify webhook evidence; never matches by title. */
export function extractHistoricalRepairSourceLine(
  source: HistoricalRepairSourceInboxEvidence,
  externalLineItemId: string | null,
): HistoricalRepairSourceLineIdentity {
  if (source.provider !== "shopify") throw new Error("source provider must be shopify");
  if (!SUPPORTED_SOURCE_TOPICS.has(source.topic)) {
    throw new Error("source topic must be orders/paid or orders/updated");
  }
  if (source.status !== "succeeded") throw new Error("source webhook must have succeeded");
  const lineId = normalizeExternalLineItemId(externalLineItemId);
  if (!source.payload || typeof source.payload !== "object" || Array.isArray(source.payload)) {
    throw new Error("source webhook payload must be an object");
  }
  const rawLines = (source.payload as Record<string, unknown>).line_items;
  if (!Array.isArray(rawLines)) throw new Error("source webhook line_items are required");
  const matches = rawLines.filter((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const value = (candidate as Record<string, unknown>).id;
    try {
      return normalizeExternalLineItemId(value) === lineId;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new Error(`source webhook must contain exactly one line_items match; found ${matches.length}`);
  }
  const match = matches[0] as Record<string, unknown>;
  if (match.requires_shipping === false || match.gift_card === true || match.product_exists === false) {
    throw new Error("source line is not an active physical fulfillment item");
  }
  const externalVariantId = normalizeShopifyLineVariantId(match.variant_id);
  if (!externalVariantId) throw new Error("source variant_id is required");
  return Object.freeze({
    externalLineItemId: lineId,
    externalProductId: normalizeExternalProductId(match.product_id),
    externalVariantId,
    sku: normalizeSourceSku(match.sku),
  });
}

function review(
  evidence: HistoricalRepairLineEvidence,
  code: string,
  message: string,
  source: HistoricalRepairSourceLineIdentity | null = null,
  identity: ResolvedOrderLineIdentity | null = null,
): HistoricalRepairLinePreview {
  const onlyWmsItem = evidence.wmsItems.length === 1 ? evidence.wmsItems[0] : null;
  return Object.freeze({
    omsOrderLineId: evidence.omsLine.id,
    disposition: "review",
    code,
    message,
    sourceInboxId: evidence.sourceInbox?.id ?? null,
    externalLineItemId: evidence.omsLine.externalLineItemId,
    externalProductId: source?.externalProductId ?? evidence.omsLine.externalProductId,
    externalVariantId: source?.externalVariantId ?? null,
    sourceSku: source?.sku ?? evidence.omsLine.sourceSku,
    currentOmsVariantId: evidence.omsLine.productVariantId,
    currentOmsQuantity: evidence.omsLine.quantity,
    resolvedVariantId: identity?.id ?? null,
    resolvedCatalogSku: identity?.sku ?? null,
    wmsOrderId: onlyWmsItem?.orderId ?? null,
    wmsOrderItemId: onlyWmsItem?.id ?? null,
    currentWmsVariantId: onlyWmsItem?.productVariantId ?? null,
    currentWmsSku: onlyWmsItem?.sku ?? null,
    currentWmsQuantity: onlyWmsItem?.quantity ?? null,
    wmsItemStatus: onlyWmsItem?.status ?? null,
    pickedQuantity: onlyWmsItem?.pickedQuantity ?? null,
    fulfilledQuantity: onlyWmsItem?.fulfilledQuantity ?? null,
  });
}

export function assessHistoricalIdentityRepairLine(input: {
  readonly order: HistoricalRepairOrderEvidence;
  readonly evidence: HistoricalRepairLineEvidence;
  readonly source: HistoricalRepairSourceLineIdentity | null;
  readonly sourceFailure?: string | null;
  readonly identity: ResolvedOrderLineIdentity | null;
  readonly identityFailure?: { code: string; message: string } | null;
}): HistoricalRepairLinePreview {
  const { order, evidence, source, identity } = input;
  const line = evidence.omsLine;
  if (TERMINAL_OMS_STATUSES.has(order.status)
      || order.fulfillmentStatus === "fulfilled"
      || order.financialStatus === "refunded"
      || order.financialStatus === "voided") {
    return review(
      evidence,
      "OMS_ORDER_TERMINAL",
      `OMS order is terminal (status=${order.status}, fulfillment=${order.fulfillmentStatus ?? "unknown"}, financial=${order.financialStatus ?? "unknown"})`,
      source,
      identity,
    );
  }
  if (line.requiresShipping !== true || line.giftCard === true || line.productExists === false) {
    return review(evidence, "OMS_LINE_NOT_ACTIVE_PHYSICAL", "OMS line is not an active physical fulfillment item", source, identity);
  }
  if (order.linkedWmsOrderIds.length !== 1) {
    return review(
      evidence,
      "WMS_ORDER_CARDINALITY_INVALID",
      `Expected one linked WMS order; found ${order.linkedWmsOrderIds.length}`,
      source,
      identity,
    );
  }
  if (evidence.wmsItems.length !== 1) {
    return review(evidence, "WMS_ITEM_CARDINALITY_INVALID", `Expected one linked WMS item; found ${evidence.wmsItems.length}`, source, identity);
  }
  const wmsItem = evidence.wmsItems[0];
  if (TERMINAL_WMS_STATUSES.has(wmsItem.warehouseStatus)) {
    return review(evidence, "WMS_ORDER_TERMINAL", `WMS order is terminal (${wmsItem.warehouseStatus})`, source, identity);
  }
  if (!SAFE_WMS_ORDER_STATUSES.has(wmsItem.warehouseStatus)) {
    return review(evidence, "WMS_ORDER_ACTIVE", `WMS order is not idle (${wmsItem.warehouseStatus})`, source, identity);
  }
  if (line.quantity <= 0 || wmsItem.quantity <= 0 || line.quantity !== wmsItem.quantity) {
    return review(
      evidence,
      "DEMAND_QUANTITY_INVALID",
      `OMS and WMS demand must be equal positive quantities (OMS=${line.quantity}, WMS=${wmsItem.quantity})`,
      source,
      identity,
    );
  }
  if (wmsItem.status !== "pending" || wmsItem.pickedQuantity !== 0 || wmsItem.fulfilledQuantity !== 0) {
    return review(evidence, "WMS_PHYSICAL_PROGRESS_PRESENT", "WMS line is not untouched pending work", source, identity);
  }
  if (input.sourceFailure) {
    return review(evidence, "SOURCE_EVIDENCE_INVALID", input.sourceFailure, source, identity);
  }
  if (!source) return review(evidence, "SOURCE_EVIDENCE_MISSING", "Exact source line evidence is missing");
  if (line.externalProductId && line.externalProductId !== source.externalProductId) {
    return review(evidence, "SOURCE_PRODUCT_IDENTITY_CONFLICT", "Stored and source product identities disagree", source, identity);
  }
  if (input.identityFailure) {
    return review(evidence, input.identityFailure.code, input.identityFailure.message, source, identity);
  }
  if (!identity) {
    return review(evidence, "CHANNEL_VARIANT_MAPPING_MISSING", "No canonical catalog identity matched the channel variant", source);
  }
  if (identity.matchedBy !== "channel_variant_id") {
    return review(evidence, "CHANNEL_VARIANT_MAPPING_REQUIRED", "Historical repair requires an exact channel-scoped variant mapping", source, identity);
  }
  const catalogSku = identity.sku?.trim() ?? "";
  if (!catalogSku) {
    return review(evidence, "CATALOG_SKU_MISSING", "Resolved catalog variant has no SKU", source, identity);
  }
  if (line.productVariantId !== null && line.productVariantId !== identity.id) {
    return review(evidence, "OMS_VARIANT_IDENTITY_CONFLICT", "OMS line already points at a different catalog variant", source, identity);
  }
  if (wmsItem.productVariantId !== null && wmsItem.productVariantId !== identity.id) {
    return review(evidence, "WMS_VARIANT_IDENTITY_CONFLICT", "WMS item already points at a different catalog variant", source, identity);
  }
  const currentWmsSku = wmsItem.sku.trim();
  if (currentWmsSku && currentWmsSku.toUpperCase() !== "UNKNOWN" && currentWmsSku !== catalogSku) {
    return review(evidence, "WMS_SKU_IDENTITY_CONFLICT", "WMS item already has a different non-placeholder SKU", source, identity);
  }
  return Object.freeze({
    ...review(evidence, "READY", "Line has exact source, catalog, and untouched WMS evidence", source, identity),
    disposition: "safe",
  });
}

export function isHistoricalIdentityRepairCandidate(line: HistoricalRepairLineEvidence): boolean {
  return line.omsLine.productVariantId == null || line.wmsItems.some((item) =>
    item.productVariantId == null || item.sku.trim() === "" || item.sku.trim().toUpperCase() === "UNKNOWN"
  );
}

export function historicalIdentityRepairPreviewHash(input: {
  readonly order: HistoricalRepairOrderEvidence;
  readonly lines: readonly HistoricalRepairLinePreview[];
}): string {
  const lines = [...input.lines].sort((left, right) => left.omsOrderLineId - right.omsOrderLineId)
    .map(({ message: _message, ...evidence }) => evidence);
  return createHash("sha256").update(canonicalJson({
    contractVersion: 1,
    order: input.order,
    lines,
  }), "utf8").digest("hex");
}

export function historicalIdentityRepairRequestHash(input: {
  readonly omsOrderId: number;
  readonly expectedPreviewHash: string;
  readonly reason: string;
}): string {
  return createHash("sha256").update(canonicalJson({ contractVersion: 1, ...input }), "utf8").digest("hex");
}
