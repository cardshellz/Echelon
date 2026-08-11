import { createHash } from "node:crypto";
import type {
  ReturnBusinessContext,
  ReturnPolicy,
} from "@shared/schema";
import {
  deriveManualReturnLifecycle,
  snapshotReturnPolicy,
  type ReturnCaseLifecycle,
} from "../domain/return-case";
import {
  ReturnPolicyDomainError,
  resolveReturnPolicy,
  type ReturnPolicyCandidate,
} from "../domain/return-policy";

export const manualReturnReasonCodes = [
  "buyer_return",
  "damaged",
  "defective",
  "incorrect_item",
  "not_as_described",
  "carrier_damage",
  "other",
] as const;
export type ManualReturnReasonCode = typeof manualReturnReasonCodes[number];

export interface ReturnSourceOrderSearchQuery {
  search: string;
  channelId: number | null;
  page: number;
  limit: number;
}

export interface ReturnSourceOrderChannel {
  id: number;
  name: string;
  orderCount: number;
}

export interface ReturnSourceOrderSearchRow {
  omsOrderId: number;
  externalOrderNumber: string | null;
  externalOrderId: string;
  channelId: number;
  channelName: string;
  customerName: string | null;
  customerEmail: string | null;
  orderedAt: Date;
  fulfillmentStatus: string | null;
  wmsPartitionCount: number;
}

export interface ReturnSourceOrderItem {
  wmsOrderItemId: number;
  omsOrderLineId: number | null;
  externalLineItemId: string | null;
  sku: string;
  title: string;
  fulfilledQuantity: number;
  alreadyExpectedQuantity: number;
  returnableQuantity: number;
  unitPaidPriceCents: number;
}

export interface ReturnSourceOrderPartition {
  wmsOrderId: number;
  wmsOrderNumber: string;
  fulfillmentPartitionKey: string;
  warehouseStatus: string;
  items: ReturnSourceOrderItem[];
}

export interface ReturnSourceOrderDetail extends ReturnSourceOrderSearchRow {
  businessContext: ReturnBusinessContext;
  vendorId: number | null;
  storeConnectionId: number | null;
  partitions: ReturnSourceOrderPartition[];
}

export interface OpenReturnCaseInput {
  idempotencyKey: string;
  actor: string;
  omsOrderId: number;
  wmsOrderId: number;
  reasonCode: ManualReturnReasonCode;
  notes: string | null;
  items: Array<{ wmsOrderItemId: number; quantity: number }>;
}

export interface OpenReturnCaseResult {
  caseId: number;
  caseNumber: string;
  wmsReturnId: number;
  replayed: boolean;
}

type ResolvableReturnPolicy = ReturnPolicy & ReturnPolicyCandidate;

export interface LockedReturnSourceContext {
  omsOrderId: number;
  wmsOrderId: number;
  channelId: number;
  businessContext: ReturnBusinessContext;
  vendorId: number | null;
  storeConnectionId: number | null;
  policies: ResolvableReturnPolicy[];
  items: ReturnSourceOrderItem[];
}

export interface PersistOpenReturnCaseInput {
  source: LockedReturnSourceContext;
  idempotencyKey: string;
  requestHash: string;
  actor: string;
  reasonCode: ManualReturnReasonCode;
  notes: string | null;
  selectedItems: Array<ReturnSourceOrderItem & { quantity: number }>;
  policy: ReturnPolicy;
  lifecycle: ReturnCaseLifecycle;
  policySnapshot: ReturnType<typeof snapshotReturnPolicy>;
  now: Date;
}

export interface OpenReturnCaseTransaction {
  lockCommand(idempotencyKey: string): Promise<void>;
  findExisting(idempotencyKey: string): Promise<{ requestHash: string; result: OpenReturnCaseResult } | null>;
  loadSourceForUpdate(input: { omsOrderId: number; wmsOrderId: number; wmsOrderItemIds: number[] }): Promise<LockedReturnSourceContext | null>;
  persist(input: PersistOpenReturnCaseInput): Promise<OpenReturnCaseResult>;
}

export interface OpenReturnCaseStore {
  searchSourceOrders(query: ReturnSourceOrderSearchQuery): Promise<{
    rows: ReturnSourceOrderSearchRow[];
    total: number;
    channels: ReturnSourceOrderChannel[];
  }>;
  getSourceOrder(omsOrderId: number): Promise<ReturnSourceOrderDetail | null>;
  transaction<T>(work: (tx: OpenReturnCaseTransaction) => Promise<T>): Promise<T>;
}

export class OpenReturnCaseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OpenReturnCaseError";
  }
}

export class OpenReturnCaseService {
  constructor(
    private readonly store: OpenReturnCaseStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async searchSourceOrders(query: ReturnSourceOrderSearchQuery) {
    const result = await this.store.searchSourceOrders(query);
    return {
      orders: result.rows.map(serializeSourceOrder),
      channels: result.channels,
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: result.total === 0 ? 0 : Math.ceil(result.total / query.limit),
      },
    };
  }

  async getSourceOrder(omsOrderId: number) {
    const order = await this.store.getSourceOrder(omsOrderId);
    if (!order) {
      throw new OpenReturnCaseError("RETURN_SOURCE_ORDER_NOT_FOUND", "Source order was not found.", 404, { omsOrderId });
    }
    return {
      ...serializeSourceOrder(order),
      businessContext: order.businessContext,
      vendorId: order.vendorId,
      storeConnectionId: order.storeConnectionId,
      partitions: order.partitions,
    };
  }

  async open(input: OpenReturnCaseInput): Promise<OpenReturnCaseResult> {
    const normalized = normalizeOpenInput(input);
    const requestHash = hashRequest(normalized);
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new OpenReturnCaseError("RETURN_CASE_CLOCK_INVALID", "Return case clock returned an invalid date.", 500);
    }

    return this.store.transaction(async (tx) => {
      await tx.lockCommand(normalized.idempotencyKey);
      const existing = await tx.findExisting(normalized.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new OpenReturnCaseError(
            "RETURN_CASE_IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used for a different return request.",
            409,
            { idempotencyKey: normalized.idempotencyKey },
          );
        }
        return { ...existing.result, replayed: true };
      }

      const source = await tx.loadSourceForUpdate({
        omsOrderId: normalized.omsOrderId,
        wmsOrderId: normalized.wmsOrderId,
        wmsOrderItemIds: normalized.items.map((item) => item.wmsOrderItemId),
      });
      if (!source) {
        throw new OpenReturnCaseError(
          "RETURN_SOURCE_PARTITION_NOT_FOUND",
          "The selected WMS fulfillment partition does not belong to this source order.",
          409,
          { omsOrderId: normalized.omsOrderId, wmsOrderId: normalized.wmsOrderId },
        );
      }

      const selectedItems = matchSelectedItems(normalized.items, source.items);
      let resolution;
      try {
        resolution = resolveReturnPolicy(source.policies, {
          businessContext: source.businessContext,
          channelId: source.channelId,
          vendorId: source.vendorId,
          storeConnectionId: source.storeConnectionId,
        });
      } catch (error) {
        if (error instanceof ReturnPolicyDomainError) {
          throw new OpenReturnCaseError(
            error.code,
            error.message,
            409,
            error.context,
          );
        }
        throw error;
      }
      if (!resolution) {
        throw new OpenReturnCaseError(
          "RETURN_CASE_POLICY_NOT_CONFIGURED",
          "No active return policy applies to this order.",
          409,
          {
            businessContext: source.businessContext,
            channelId: source.channelId,
            vendorId: source.vendorId,
            storeConnectionId: source.storeConnectionId,
          },
        );
      }

      const policy = resolution.winner;
      return tx.persist({
        source,
        idempotencyKey: normalized.idempotencyKey,
        requestHash,
        actor: normalized.actor,
        reasonCode: normalized.reasonCode,
        notes: normalized.notes,
        selectedItems,
        policy,
        lifecycle: deriveManualReturnLifecycle(policy, source.businessContext),
        policySnapshot: snapshotReturnPolicy(policy),
        now,
      });
    });
  }
}

function normalizeOpenInput(input: OpenReturnCaseInput): OpenReturnCaseInput {
  const idempotencyKey = normalizeRequiredText(input.idempotencyKey, "idempotencyKey", 160);
  const actor = normalizeRequiredText(input.actor, "actor", 255);
  const omsOrderId = requirePositiveSafeInteger(input.omsOrderId, "omsOrderId");
  const wmsOrderId = requirePositiveSafeInteger(input.wmsOrderId, "wmsOrderId");
  const notes = input.notes === null ? null : normalizeOptionalText(input.notes, "notes", 2_000);
  if (!manualReturnReasonCodes.includes(input.reasonCode)) {
    throw invalid("reasonCode", input.reasonCode);
  }
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 200) {
    throw new OpenReturnCaseError("RETURN_CASE_INPUT_INVALID", "Between 1 and 200 return items are required.", 400);
  }
  const seen = new Set<number>();
  const items = input.items.map((item) => {
    const wmsOrderItemId = requirePositiveSafeInteger(item.wmsOrderItemId, "wmsOrderItemId");
    const quantity = requirePositiveSafeInteger(item.quantity, "quantity");
    if (seen.has(wmsOrderItemId)) {
      throw new OpenReturnCaseError("RETURN_CASE_INPUT_INVALID", "A WMS order item may only appear once.", 400, { wmsOrderItemId });
    }
    seen.add(wmsOrderItemId);
    return { wmsOrderItemId, quantity };
  }).sort((left, right) => left.wmsOrderItemId - right.wmsOrderItemId);

  return { idempotencyKey, actor, omsOrderId, wmsOrderId, reasonCode: input.reasonCode, notes, items };
}

function matchSelectedItems(
  requested: OpenReturnCaseInput["items"],
  available: ReturnSourceOrderItem[],
): Array<ReturnSourceOrderItem & { quantity: number }> {
  const byId = new Map(available.map((item) => [item.wmsOrderItemId, item]));
  return requested.map((request) => {
    const item = byId.get(request.wmsOrderItemId);
    if (!item) {
      throw new OpenReturnCaseError(
        "RETURN_CASE_ITEM_NOT_FOUND",
        "A selected item does not belong to the chosen fulfillment partition.",
        409,
        { wmsOrderItemId: request.wmsOrderItemId },
      );
    }
    if (request.quantity > item.returnableQuantity) {
      throw new OpenReturnCaseError(
        "RETURN_CASE_QUANTITY_UNAVAILABLE",
        "The requested return quantity exceeds the remaining fulfilled quantity.",
        409,
        { wmsOrderItemId: request.wmsOrderItemId, requested: request.quantity, available: item.returnableQuantity },
      );
    }
    return { ...item, quantity: request.quantity };
  });
}

function hashRequest(input: OpenReturnCaseInput): string {
  return createHash("sha256").update(JSON.stringify({
    omsOrderId: input.omsOrderId,
    wmsOrderId: input.wmsOrderId,
    reasonCode: input.reasonCode,
    notes: input.notes,
    items: input.items,
  })).digest("hex");
}

function serializeSourceOrder(order: ReturnSourceOrderSearchRow) {
  return { ...order, orderedAt: order.orderedAt.toISOString() };
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalid(field, value);
  return Number(value);
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw invalid(field, value);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw invalid(field, value);
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string | null {
  if (typeof value !== "string") throw invalid(field, value);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw invalid(field, value);
  return normalized || null;
}

function invalid(field: string, value: unknown): OpenReturnCaseError {
  return new OpenReturnCaseError("RETURN_CASE_INPUT_INVALID", `${field} is invalid.`, 400, { field, value });
}
