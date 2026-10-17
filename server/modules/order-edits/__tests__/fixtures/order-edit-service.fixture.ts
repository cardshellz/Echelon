import { vi } from "vitest";
import { OrderEditService } from "../../application/order-edit.service";
import type {
  OrderEditProvider,
  OrderEditQuote,
  OrderEditSnapshot,
} from "../../application/order-edit-provider";
import type {
  OrderEditRecord,
  OrderEditReleaseProof,
  OrderEditStore,
  OrderEditWarehouse,
} from "../../application/order-edit-store";
import type { OrderEditQuoteInput } from "@shared/order-edits/order-edit.contract";
import { OrderEditError } from "../../domain/order-edit-error";
import { orderEditCatalogVariantsInputSchema } from "@shared/order-edits/order-edit-catalog";
import { buildOrderEditFinancials } from "../../domain/order-edit-financials";
import {
  OrderEditCommitNotSentError,
  OrderEditProviderError,
} from "../../application/order-edit-provider";

export const OP = "11111111-1111-4111-8111-111111111111";
export const KEY = "22222222-2222-4222-8222-222222222222";
export const REFUND_KEY = "33333333-3333-4333-8333-333333333333";
export const START = Date.parse("2026-10-05T12:00:00.000Z");
export const proof: OrderEditReleaseProof = {
  allocationRequired: true,
  wmsOrderIds: [9],
  shipmentIds: [7],
  contentFingerprint: "release-proof",
};

export function baseline(): OrderEditSnapshot {
  return {
    connectionId: 4,
    channelId: 36,
    orderId: "gid://shopify/Order/100",
    name: "#100",
    customerId: "gid://shopify/Customer/8",
    currency: "USD",
    updatedAt: new Date(START).toISOString(),
    editable: true,
    editableErrors: [],
    cancelled: false,
    closed: false,
    fullyPaid: true,
    totalCents: 2000,
    outstandingCents: 0,
    subtotalCents: 2000,
    taxCents: 0,
    netPaidCents: 2000,
    capturableCents: 0,
    shippingCents: 0,
    paymentUrl: null,
    memberPlan: null,
    memberPricingEnabled: false,
    discountsPresent: false,
    lines: [
      {
        id: "gid://shopify/LineItem/1",
        variantId: "gid://shopify/ProductVariant/10",
        title: "Product",
        variantTitle: "Single",
        sku: "TEST",
        quantity: 2,
        unfulfilledQuantity: 2,
        originalUnitPriceCents: 1000,
        discountedUnitPriceCents: 1000,
        totalCents: 2000,
        discountFingerprint: "none",
        unsupported: false,
      },
    ],
    transactions: [],
    refunds: [],
    contentFingerprint: "contents-original",
    fingerprint: "baseline",
    evidence: { countryCode: "US" },
  };
}

export function serviceHarness(
  quantity = 3,
  catalog?: import("../../application/order-edit-catalog").OrderEditCatalog,
  codeRedemptions?: import("../../application/order-edit-code-redemptions").OrderEditCodeRedemptions,
) {
  let now = START;
  let current = baseline();
  let saved: OrderEditRecord | null = null;
  let enabled = true;
  let locked = false;
  let held = false;
  const events: Array<{
    action: string;
    releaseProof?: OrderEditReleaseProof;
  }> = [];
  const connection = () => ({
    connectionId: 4,
    channelId: 36,
    name: "Test store",
    shopDomain: "test.myshopify.com",
    paymentWindowMinutes: 30,
    enabled,
  });
  const input: OrderEditQuoteInput = {
    connectionId: 4,
    omsOrderId: 1,
    expectedRevision: "baseline",
    requestKey: KEY,
    changes: [{ lineItemId: current.lines[0].id, quantity }],
    additions: [],
  };
  const store: OrderEditStore = {
    connections: async () => [connection()],
    settings: async () => connection(),
    saveSettings: async () => connection(),
    findOrders: async () => [],
    orderReference: async () => ({
      omsOrderId: 1,
      channelId: 36,
      connectionId: 4,
      externalOrderId: "100",
      externalCustomerId: "8",
      orderNumber: "#100",
      customerName: "Test",
      customerEmail: null,
      activeOperationId: saved?.id ?? null,
    }),
    withOrderLock: async (_id, work) => {
      if (locked) throw new OrderEditError("ORDER_EDIT_BUSY", "Busy");
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
      }
    },
    findByRequestKey: async (key) =>
      saved?.requestKey === key ? structuredClone(saved) : null,
    get: async () => {
      if (!saved) throw new Error("missing");
      return structuredClone(saved);
    },
    create: async (record) => {
      if (saved) throw new Error("one active operation");
      saved = structuredClone(record);
    },
    save: async (record, version, _actor, action, releaseProof) => {
      if (!saved || saved.version !== version) throw new Error("stale version");
      if (
        ["completed", "recovered", "expired"].includes(record.status) &&
        !releaseProof
      )
        throw new Error("missing proof");
      saved = structuredClone(record);
      events.push({ action, releaseProof });
      if (releaseProof) held = false;
    },
    pending: async () => (saved ? [saved.id] : []),
  };
  const quote: OrderEditQuote = {
    connectionId: 4,
    channelId: 36,
    orderId: current.orderId,
    operationId: OP,
    calculatedOrderId: "gid://shopify/CalculatedOrder/1",
    sessionId: "gid://shopify/OrderEditSession/1",
    baselineFingerprint: current.fingerprint,
    baseline: baseline(),
    plan: input,
    lines: [
      {
        title: "Product",
        variantTitle: "Single",
        originalLineId: current.lines[0].id,
        calculatedLineId: "gid://shopify/CalculatedLineItem/1",
        variantId: current.lines[0].variantId,
        quantity,
        originalUnitPriceCents: 1000,
        discountedUnitPriceCents: 1000,
        totalCents: quantity * 1000,
      },
    ],
    totalCents: quantity * 1000,
    outstandingCents: (quantity - 2) * 1000,
    deltaCents: (quantity - 2) * 1000,
    shippingCents: 0,
    createdAt: new Date(START).toISOString(),
    evidence: {},
  };
  const provider = {
    readOrder: vi.fn(async () => structuredClone(current)),
    searchVariants: vi.fn(async () => []),
    quote: vi.fn(async () => structuredClone(quote)),
    commit: vi.fn<OrderEditProvider["commit"]>(
      async (_connection, _quote, _operation, beforeCommitRequest) => {
        await beforeCommitRequest?.();
        current = {
          ...current,
          lines: [
            { ...current.lines[0], quantity, totalCents: quantity * 1000 },
          ],
          totalCents: quantity * 1000,
          subtotalCents: quantity * 1000,
          outstandingCents: (quantity - 2) * 1000,
          fullyPaid: quantity <= 2,
          contentFingerprint: "contents-edited",
          fingerprint: "edited",
          paymentUrl: "https://test.myshopify.com/pay",
        };
        return structuredClone(current);
      },
    ),
    reconcileCommit: vi.fn<OrderEditProvider["reconcileCommit"]>(async () => ({
      status: "applied" as const,
      snapshot: structuredClone(current),
    })),
    prepareRefund: vi.fn(async () => ({
      connectionId: 4,
      channelId: 36,
      orderId: current.orderId,
      operationId: OP,
      idempotencyKey: REFUND_KEY,
      currency: "USD" as const,
      amountCents: 2000 - quantity * 1000,
      parentTransactionId: "gid://shopify/OrderTransaction/1",
      gateway: "shopify_payments",
      note: "refund",
      contentFingerprint: current.contentFingerprint,
    })),
    refund: vi.fn<OrderEditProvider["refund"]>(async () => {
      current = {
        ...current,
        netPaidCents: current.totalCents,
        outstandingCents: 0,
      };
      return {
        status: "succeeded" as const,
        refundId: "gid://shopify/Refund/1",
        evidence: {
          id: "gid://shopify/Refund/1",
          note: "refund",
          amountCents: 1000,
          transactions: [],
        },
      };
    }),
    recoverUnpaid: vi.fn(async () => {
      current = baseline();
      return structuredClone(current);
    }),
    reconcileRecovery: vi.fn<OrderEditProvider["reconcileRecovery"]>(
      async () => ({
        status: "restored" as const,
        snapshot: structuredClone(current),
      }),
    ),
  } satisfies OrderEditProvider;
  const warehouse = {
    inspect: vi.fn(async () => ({
      editable: true,
      reasons: [],
      wmsOrderIds: [9],
    })),
    acquire: vi.fn(async () => {
      held = true;
    }),
    assertHeld: vi.fn(async () => {}),
    releaseUnsubmitted: vi.fn(async () => ({
      unsubmitted: true,
      ownership: held ? ("owned" as const) : ("none" as const),
      wmsOrderIds: held ? [9] : [],
      shipmentIds: [],
      contentFingerprint: "release-proof",
    })),
    reconcileAndRelease: vi.fn(async () => proof),
    releaseUnchanged: vi.fn(async () => proof),
    releaseFulfilledUnsubmitted: vi.fn(async () => ({
      ...proof,
      allocationRequired: false,
      fulfilledCancellation: true,
    })),
  } satisfies OrderEditWarehouse;
  let uuidCount = 0;
  const report = vi.fn();
  const service = new OrderEditService(
    store,
    provider,
    warehouse,
    () => new Date(now),
    () => (uuidCount++ === 0 ? OP : REFUND_KEY),
    report,
    undefined,
    catalog,
    codeRedemptions,
  );
  return {
    service,
    provider,
    warehouse,
    input,
    events,
    report,
    store,
    quote,
    record: () => saved!,
    setHeld: (value: boolean) => {
      held = value;
    },
    held: () => held,
    snapshot: () => current,
    setCurrent: (patch: Partial<OrderEditSnapshot>) => {
      current = { ...current, ...patch };
    },
    advance: (ms: number) => {
      now += ms;
    },
    disable: () => {
      enabled = false;
    },
  };
}
