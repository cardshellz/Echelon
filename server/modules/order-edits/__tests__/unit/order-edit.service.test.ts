import { describe, expect, it, vi } from "vitest";
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

const OP = "11111111-1111-4111-8111-111111111111";
const KEY = "22222222-2222-4222-8222-222222222222";
const REFUND_KEY = "33333333-3333-4333-8333-333333333333";
const START = Date.parse("2026-10-05T12:00:00.000Z");
const proof: OrderEditReleaseProof = {
  allocationRequired: true,
  wmsOrderIds: [9],
  shipmentIds: [7],
  contentFingerprint: "release-proof",
};

function baseline(): OrderEditSnapshot {
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
) {
  let now = START;
  let current = baseline();
  let saved: OrderEditRecord | null = null;
  let enabled = true;
  let locked = false;
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
    commit: vi.fn(async () => {
      current = {
        ...current,
        lines: [{ ...current.lines[0], quantity, totalCents: quantity * 1000 }],
        totalCents: quantity * 1000,
        subtotalCents: quantity * 1000,
        outstandingCents: (quantity - 2) * 1000,
        fullyPaid: quantity <= 2,
        contentFingerprint: "contents-edited",
        fingerprint: "edited",
        paymentUrl: "https://test.myshopify.com/pay",
      };
      return structuredClone(current);
    }),
    reconcileCommit: vi.fn(async () => ({
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
    acquire: vi.fn(async () => {}),
    assertHeld: vi.fn(async () => {}),
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
  );
  return {
    service,
    provider,
    warehouse,
    input,
    events,
    report,
    store,
    record: () => saved!,
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

describe("private order edit orchestration", () => {
  it("validates the connection before catalog discovery without changing orders, holds or money", async () => {
    const pageInfo = { hasNextPage: false, endCursor: null };
    const catalog = {
      categories: vi.fn(async (connectionId, input) => ({
        connectionId,
        input,
        categories: ["Toploaders"],
        pageInfo,
      })),
      products: vi.fn(async (connectionId, input) => ({
        connectionId,
        input,
        products: [],
        pageInfo,
      })),
      productVariants: vi.fn(async (connectionId, input) => ({
        connectionId,
        input: orderEditCatalogVariantsInputSchema.parse(input),
        product: {
          productId: input.productId,
          title: "Toploader",
          category: "Toploaders",
          imageUrl: null,
        },
        variants: [],
        pageInfo,
      })),
    } satisfies import("../../application/order-edit-catalog").OrderEditCatalog;
    const h = serviceHarness(3, catalog);
    const settings = vi.spyOn(h.store, "settings");
    await h.service.catalogCategories(4, { after: null });
    await h.service.catalogProducts(4, {
      search: "toploader",
      category: "Toploaders",
      after: null,
    });
    await h.service.catalogVariants(4, {
      productId: "gid://shopify/Product/10",
      after: null,
    });
    expect(settings).toHaveBeenCalledTimes(3);
    expect(h.events).toEqual([]);
    expect(h.warehouse.acquire).not.toHaveBeenCalled();
    expect(h.provider.quote).not.toHaveBeenCalled();
    expect(h.provider.readOrder).not.toHaveBeenCalled();
    settings.mockRejectedValue(
      new OrderEditError("CONNECTION_INVALID", "Connection unavailable"),
    );
    await expect(
      h.service.catalogProducts(999, {
        search: "toploader",
        category: null,
        after: null,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
    expect(catalog.products).toHaveBeenCalledTimes(1);
  });
  it("reports an unavailable catalog without falling back to another store", async () => {
    const h = serviceHarness();
    await expect(
      h.service.catalogProducts(4, {
        search: "toploader",
        category: null,
        after: null,
      }),
    ).rejects.toMatchObject({
      code: "ORDER_EDIT_CATALOG_UNAVAILABLE",
      status: 503,
    });
    expect(h.provider.searchVariants).not.toHaveBeenCalled();
  });
  it("derives catalog membership from the verified order customer without any financial or inventory command", async () => {
    const productVariants =
      vi.fn<
        import("../../application/order-edit-catalog").OrderEditCatalog["productVariants"]
      >();
    const catalog = { categories: vi.fn(), products: vi.fn(), productVariants };
    const h = serviceHarness(3, catalog);
    const planId = "5f966934-9ff2-4966-9e8f-d4292ca3290e";
    h.setCurrent({ memberPlan: planId, memberPricingEnabled: true });
    const input = {
      productId: "gid://shopify/Product/10",
      after: null,
      omsOrderId: 1,
      expectedRevision: "baseline",
    };
    await h.service.catalogVariants(4, input, "staff-a");
    expect(h.provider.readOrder).toHaveBeenCalledExactlyOnceWith(4, "100");
    expect(productVariants).toHaveBeenCalledExactlyOnceWith(4, input, {
      connectionId: 4,
      customerId: "gid://shopify/Customer/8",
      memberPlan: planId,
      memberPricingEnabled: true,
    });
    expect(h.provider.quote).not.toHaveBeenCalled();
    expect(h.provider.commit).not.toHaveBeenCalled();
    expect(h.warehouse.acquire).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });
  it.each([
    { customerId: "gid://shopify/Customer/999" },
    { connectionId: 99 },
    { channelId: 99 },
    { orderId: "gid://shopify/Order/999" },
    { fingerprint: "changed" },
  ])(
    "cannot price products using a different customer, store, order or revision: %j",
    async (patch) => {
      const catalog = {
        categories: vi.fn(),
        products: vi.fn(),
        productVariants: vi.fn(),
      };
      const h = serviceHarness(3, catalog);
      h.setCurrent(patch);
      await expect(
        h.service.catalogVariants(
          4,
          {
            productId: "gid://shopify/Product/10",
            omsOrderId: 1,
            expectedRevision: "baseline",
          },
          "staff-a",
        ),
      ).rejects.toMatchObject({
        code: patch.fingerprint
          ? "ORDER_EDIT_ORDER_CHANGED"
          : "ORDER_EDIT_IDENTITY_CHANGED",
      });
      expect(catalog.productVariants).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    },
  );
  it("rejects unpaired scope, missing actor, disabled editing and an active edit before catalog pricing", async () => {
    const catalog = {
      categories: vi.fn(),
      products: vi.fn(),
      productVariants: vi.fn(),
    };
    const h = serviceHarness(3, catalog);
    const input = {
      productId: "gid://shopify/Product/10",
      omsOrderId: 1,
      expectedRevision: "baseline",
    };
    await expect(
      h.service.catalogVariants(
        4,
        { productId: input.productId, omsOrderId: 1 },
        "staff-a",
      ),
    ).rejects.toThrow();
    await expect(h.service.catalogVariants(4, input)).rejects.toMatchObject({
      code: "ORDER_EDIT_CATALOG_UNAVAILABLE",
    });
    const reference = await h.store.orderReference(4, 1);
    vi.spyOn(h.store, "orderReference").mockResolvedValue({
      ...reference,
      activeOperationId: OP,
    });
    await expect(
      h.service.catalogVariants(4, input, "staff-a"),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_ALREADY_ACTIVE" });
    h.disable();
    await expect(
      h.service.catalogVariants(4, input, "staff-a"),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_CATALOG_UNAVAILABLE" });
    expect(catalog.productVariants).not.toHaveBeenCalled();
  });
  it("presents exact after-discount line totals instead of Shopify's pre-code legacy totals", async () => {
    const h = serviceHarness();
    const financials = buildOrderEditFinancials({
      lines: [
        { id: h.snapshot().lines[0].id, grossCents: 2000, netCents: 1800 },
      ],
      itemsNetCents: 1800,
      itemDiscountLabels: ["TEN"],
      shippingGrossCents: 500,
      shippingCents: 0,
      shippingDiscountLabels: ["Free shipping"],
      taxCents: 0,
      taxesIncluded: false,
      totalCents: 1800,
    });
    h.setCurrent({
      financials,
      totalCents: 1800,
      subtotalCents: 1800,
      netPaidCents: 1800,
    });
    const order = await h.service.order(4, 1);
    expect(order.lines[0].totalCents).toBe(1800);
    expect(order.financials).toEqual(financials);
    h.provider.quote.mockRejectedValueOnce(
      new OrderEditProviderError(
        "PROMOTION_PARITY_UNVERIFIED",
        "Discount requires review",
      ),
    );
    const failed = await h.service.quote(h.input, "staff");
    expect(failed).toMatchObject({
      quoteAvailable: false,
      lines: [{ totalCents: 1800 }],
      financials: { current: financials, quoted: null },
    });
  });
  it("shows restored quantities, totals, and zero debt after unpaid recovery", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.commit(OP, OP, "staff");
    h.advance(31 * 60_000);
    const recovered = await h.service.reconcile(OP, "staff");
    expect(recovered).toMatchObject({
      status: "recovered",
      updatedTotalCents: 2000,
      balanceDueCents: 0,
      lines: [{ quantity: 2, totalCents: 2000 }],
      settlement: { outstandingCents: 0, netPaidCents: 2000 },
    });
  });
  it("allows safe cancellation only after an explicit not-submitted result", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    h.provider.commit.mockRejectedValueOnce(
      new OrderEditCommitNotSentError("STOCK_CHANGED", "Stock changed"),
    );
    const rejected = await h.service.commit(OP, OP, "staff");
    expect(rejected.status).toBe("review_required");
    expect(rejected.canAbandon).toBe(true);
    expect(h.record()).toMatchObject({
      commitStartedAt: null,
      commitKey: null,
      paymentDeadline: null,
    });
    expect(h.events.map((event) => event.action)).toContain("commit_intent");
    expect(h.events.map((event) => event.action)).toContain(
      "commit_not_submitted",
    );
    await h.service.commit(OP, OP, "staff");
    expect(h.provider.commit).toHaveBeenCalledTimes(1);
    expect((await h.service.abandon(OP, "staff")).status).toBe("expired");
    expect(h.warehouse.releaseUnchanged).toHaveBeenCalledOnce();
  });
  it("does not treat a generic rejected provider error as proof nothing was sent", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    h.provider.commit.mockRejectedValueOnce(
      new OrderEditProviderError(
        "STOCK_CHANGED",
        "Unclassified phase",
        "rejected",
      ),
    );
    expect((await h.service.commit(OP, OP, "staff")).canAbandon).toBe(false);
    expect(h.record().commitStartedAt).not.toBeNull();
    await expect(h.service.abandon(OP, "staff")).rejects.toMatchObject({
      code: "ORDER_EDIT_ALREADY_SUBMITTED",
    });
  });
  it("retains automatic expiry after a transient payment readback outage", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.commit(OP, OP, "staff");
    h.provider.reconcileCommit.mockRejectedValueOnce(
      new OrderEditProviderError("SHOPIFY_UNAVAILABLE", "Read timed out"),
    );
    expect((await h.service.reconcile(OP, "staff")).status).toBe(
      "awaiting_payment",
    );
    expect(h.warehouse.reconcileAndRelease).not.toHaveBeenCalled();
    h.advance(31 * 60_000);
    await h.service.sweep();
    expect(h.record().status).toBe("recovered");
    expect(h.provider.commit).toHaveBeenCalledTimes(1);
    expect(h.provider.recoverUnpaid).toHaveBeenCalledTimes(1);
  });
  it("replays quote requests without acquiring or staging twice and rejects changed-key payloads", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.quote(h.input, "staff");
    expect(h.provider.quote).toHaveBeenCalledTimes(1);
    expect(h.warehouse.acquire).toHaveBeenCalledTimes(1);
    await expect(
      h.service.quote(
        { ...h.input, changes: [{ ...h.input.changes[0], quantity: 4 }] },
        "staff",
      ),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_KEY_REUSED" });
  });
  it("checks identity, payment and stale revision before creating or holding an operation", async () => {
    const h = serviceHarness();
    h.setCurrent({ customerId: "gid://shopify/Customer/99" });
    await expect(h.service.quote(h.input, "staff")).rejects.toMatchObject({
      code: "ORDER_EDIT_IDENTITY_CHANGED",
    });
    h.setCurrent({
      customerId: "gid://shopify/Customer/8",
      fingerprint: "changed",
    });
    await expect(h.service.quote(h.input, "staff")).rejects.toMatchObject({
      code: "ORDER_EDIT_STALE_ORDER",
    });
    expect(h.warehouse.acquire).not.toHaveBeenCalled();
    expect(h.record()).toBeNull();
  });
  it("never exposes or commits a staged preview when picking wins acquisition", async () => {
    const h = serviceHarness();
    h.warehouse.acquire.mockRejectedValue(
      new OrderEditError("ORDER_EDIT_PICKING_CUTOFF", "Picking started"),
    );
    expect((await h.service.quote(h.input, "staff")).status).toBe(
      "review_required",
    );
    expect(h.provider.quote).toHaveBeenCalledOnce();
    expect(h.record().quote).toBeNull();
    expect(h.record().error?.code).toBe("ORDER_EDIT_PICKING_CUTOFF");
    await h.service.commit(OP, OP, "staff");
    expect(h.provider.commit).not.toHaveBeenCalled();
    expect(h.provider.refund).not.toHaveBeenCalled();
  });
  it("overlaps preview and hold acquisition but exposes neither before both finish", async () => {
    const h = serviceHarness();
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    h.warehouse.acquire.mockReturnValueOnce(hold);
    const pending = h.service.quote(h.input, "staff");
    await vi.waitFor(() => expect(h.provider.quote).toHaveBeenCalledOnce());
    expect(h.record().status).toBe("preparing");
    expect(h.record().quote).toBeNull();
    releaseHold();
    expect((await pending).status).toBe("ready");
    expect(h.record().quote).not.toBeNull();
  });
  it("waits for a late hold after preview failure before unlocking cancellation", async () => {
    const h = serviceHarness();
    let releaseHold!: () => void;
    h.warehouse.acquire.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseHold = resolve;
      }),
    );
    h.provider.quote.mockRejectedValueOnce(
      new OrderEditProviderError("QUOTE_REJECTED", "Invalid quote"),
    );
    const pending = h.service.quote(h.input, "staff");
    await vi.waitFor(() => expect(h.provider.quote).toHaveBeenCalledOnce());
    expect(h.record().status).toBe("preparing");
    await expect(h.service.abandon(OP, "staff")).rejects.toMatchObject({
      code: "ORDER_EDIT_BUSY",
    });
    releaseHold();
    expect((await pending).status).toBe("review_required");
    expect(h.record().error?.code).toBe("QUOTE_REJECTED");
    expect((await h.service.abandon(OP, "staff")).status).toBe("expired");
    expect(h.warehouse.releaseUnchanged).toHaveBeenCalledOnce();
  });
  it("waits for a late preview after hold failure and retains the hold error", async () => {
    const h = serviceHarness();
    const staged = await h.provider.quote();
    h.provider.quote.mockClear();
    let releasePreview!: (quote: OrderEditQuote) => void;
    h.provider.quote.mockReturnValueOnce(
      new Promise<OrderEditQuote>((resolve) => {
        releasePreview = resolve;
      }),
    );
    h.warehouse.acquire.mockRejectedValueOnce(
      new OrderEditError("HOLD_FAILED", "Hold unavailable"),
    );
    const pending = h.service.quote(h.input, "staff");
    await vi.waitFor(() => expect(h.provider.quote).toHaveBeenCalledOnce());
    expect(h.record().status).toBe("preparing");
    releasePreview(staged);
    expect((await pending).status).toBe("review_required");
    expect(h.record().quote).toBeNull();
    expect(h.record().error?.code).toBe("HOLD_FAILED");
    expect(h.provider.commit).not.toHaveBeenCalled();
  });
  it("rechecks warehouse cutoff and quote revision at commit", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    h.warehouse.assertHeld.mockRejectedValue(
      new OrderEditError("ORDER_EDIT_PICKING_CUTOFF", "Picking started"),
    );
    await expect(h.service.commit(OP, OP, "staff")).rejects.toMatchObject({
      code: "ORDER_EDIT_PICKING_CUTOFF",
    });
    expect(h.provider.commit).not.toHaveBeenCalled();
  });
  it("audits the hold error and also reports the preview error when both fail", async () => {
    const h = serviceHarness();
    h.warehouse.acquire.mockRejectedValueOnce(
      new OrderEditError("HOLD_FAILED", "Hold unavailable"),
    );
    h.provider.quote.mockRejectedValueOnce(
      new OrderEditProviderError("QUOTE_REJECTED", "Invalid quote"),
    );
    await h.service.quote(h.input, "staff");
    expect(h.record().error?.code).toBe("HOLD_FAILED");
    expect(h.record().quote).toBeNull();
    expect(h.report).toHaveBeenCalledWith({
      operationId: OP,
      code: "QUOTE_REJECTED",
    });
    expect(h.events.at(-1)?.action).toBe("quote_failed_held");
    expect(h.provider.commit).not.toHaveBeenCalled();
  });
  it("persists a commit intent before the provider write and never commits again on retries", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    h.provider.commit.mockImplementation(async () => {
      expect(h.record().status).toBe("committing");
      expect(h.record().commitStartedAt).not.toBeNull();
      throw new Error("response lost");
    });
    expect((await h.service.commit(OP, OP, "staff")).status).toBe("committing");
    await h.service.commit(OP, OP, "staff");
    expect(h.provider.commit).toHaveBeenCalledTimes(1);
    expect(h.warehouse.reconcileAndRelease).not.toHaveBeenCalled();
  });
  it("serializes concurrent confirmations", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    const results = await Promise.allSettled([
      h.service.commit(OP, OP, "staff"),
      h.service.commit(OP, OP, "staff"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(h.provider.commit).toHaveBeenCalledTimes(1);
  });
  it("holds an increase for payment and uses the configured window from confirmation", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    h.advance(5 * 60_000);
    const operation = await h.service.commit(OP, OP, "staff");
    expect(operation.status).toBe("awaiting_payment");
    expect(operation.paymentDeadline).toBe(
      new Date(START + 35 * 60_000).toISOString(),
    );
    expect(operation.paymentUrl).toContain("/pay");
    expect(h.warehouse.reconcileAndRelease).not.toHaveBeenCalled();
  });
  it("releases only after full payment and atomic terminal release proof", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.commit(OP, OP, "staff");
    h.setCurrent({ fullyPaid: true, outstandingCents: 0, netPaidCents: 3000 });
    expect((await h.service.reconcile(OP, "staff")).status).toBe("completed");
    expect(h.events.at(-1)?.releaseProof).toEqual(proof);
    await h.service.reconcile(OP, "staff");
    expect(h.warehouse.reconcileAndRelease).toHaveBeenCalledTimes(1);
  });
  it.each([500, 999])(
    "never automatically recovers a partial additional payment of %s cents",
    async (extra) => {
      const h = serviceHarness();
      await h.service.quote(h.input, "staff");
      await h.service.commit(OP, OP, "staff");
      h.advance(31 * 60_000);
      h.setCurrent({
        netPaidCents: 2000 + extra,
        outstandingCents: 1000 - extra,
      });
      expect((await h.service.reconcile(OP, "staff")).error?.code).toBe(
        "ORDER_EDIT_PARTIAL_PAYMENT",
      );
      expect(h.provider.recoverUnpaid).not.toHaveBeenCalled();
    },
  );
  it("keeps in-flight payment held even after expiry", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.commit(OP, OP, "staff");
    h.advance(31 * 60_000);
    h.setCurrent({
      transactions: [
        {
          id: "pending",
          parentId: null,
          kind: "SALE",
          status: "PENDING",
          gateway: "shopify_payments",
          amountCents: 1000,
          manual: false,
        },
      ],
    });
    expect((await h.service.reconcile(OP, "staff")).error?.code).toBe(
      "ORDER_EDIT_PAYMENT_PENDING",
    );
    expect(h.provider.recoverUnpaid).not.toHaveBeenCalled();
  });
  it("automatically restores an unpaid increase once, even if new edits are disabled", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.commit(OP, OP, "staff");
    h.advance(31 * 60_000);
    h.disable();
    await h.service.sweep();
    expect(h.record().status).toBe("recovered");
    expect(h.provider.recoverUnpaid).toHaveBeenCalledTimes(1);
    expect(h.events.at(-1)?.releaseProof).toEqual(proof);
  });
  it("reconciles recovery after a lost response without a second inverse mutation", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.commit(OP, OP, "staff");
    h.advance(31 * 60_000);
    h.provider.recoverUnpaid.mockRejectedValueOnce(new Error("lost"));
    await h.service.reconcile(OP, "staff");
    h.setCurrent(baseline());
    expect((await h.service.reconcile(OP, "staff")).status).toBe("recovered");
    expect(h.provider.recoverUnpaid).toHaveBeenCalledTimes(1);
  });
  it("holds a late payment or content conflict during recovery", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.commit(OP, OP, "staff");
    h.advance(31 * 60_000);
    h.provider.reconcileRecovery.mockImplementation(async () => ({
      status: "conflict",
      snapshot: h.snapshot(),
    }));
    expect((await h.service.reconcile(OP, "staff")).status).toBe(
      "review_required",
    );
    expect(h.warehouse.reconcileAndRelease).not.toHaveBeenCalled();
  });
  it("persists a single refund intent and verifies it on later pending-to-success transitions", async () => {
    const h = serviceHarness(1);
    await h.service.quote(h.input, "staff");
    h.provider.refund.mockImplementationOnce(async () => {
      expect(h.record().refundIntent?.idempotencyKey).toBe(REFUND_KEY);
      return {
        status: "pending",
        refundId: "refund",
        evidence: {
          id: "refund",
          note: null,
          amountCents: 1000,
          transactions: [],
        },
      };
    });
    expect((await h.service.commit(OP, OP, "staff")).status).toBe("refunding");
    expect(h.warehouse.reconcileAndRelease).not.toHaveBeenCalled();
    h.setCurrent({ netPaidCents: 1000, outstandingCents: 0 });
    expect((await h.service.reconcile(OP, "staff")).status).toBe("completed");
    expect(h.provider.prepareRefund).toHaveBeenCalledTimes(1);
    expect(h.provider.refund).toHaveBeenCalledTimes(2);
    expect(h.provider.refund.mock.calls[0].slice(1)).toEqual(
      h.provider.refund.mock.calls[1].slice(1),
    );
  });
  it("keeps the hold when warehouse synchronization fails and retries readback, not the financial mutation", async () => {
    const h = serviceHarness(1);
    await h.service.quote(h.input, "staff");
    h.warehouse.reconcileAndRelease.mockRejectedValueOnce(
      new Error("OMS delayed"),
    );
    expect((await h.service.commit(OP, OP, "staff")).status).toBe(
      "synchronizing",
    );
    expect((await h.service.reconcile(OP, "staff")).status).toBe("completed");
    expect(h.provider.commit).toHaveBeenCalledTimes(1);
    expect(h.provider.prepareRefund).toHaveBeenCalledTimes(1);
  });
  it("abandons an unsubmitted quote without Shopify commit/refund", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    expect((await h.service.abandon(OP, "staff")).status).toBe("expired");
    expect(h.provider.commit).not.toHaveBeenCalled();
    expect(h.provider.refund).not.toHaveBeenCalled();
    expect(h.events.at(-1)?.releaseProof).toEqual(proof);
  });
  it("read-only status never causes a financial side effect", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.get(OP);
    expect(h.provider.commit).not.toHaveBeenCalled();
    expect(h.provider.refund).not.toHaveBeenCalled();
    expect(h.provider.recoverUnpaid).not.toHaveBeenCalled();
  });
  it("cancels a rejected unsubmitted edit after external fulfillment, without restoring or rewriting the order", async () => {
    const h = serviceHarness();
    h.provider.quote.mockRejectedValueOnce(
      new OrderEditProviderError("PROMOTION_UNSUPPORTED", "Unsupported"),
    );
    await h.service.quote(h.input, "staff");
    h.setCurrent({
      closed: true,
      fingerprint: "fulfilled",
      contentFingerprint: "fulfilled-contents",
      lines: h.snapshot().lines.map((line) => ({
        ...line,
        unfulfilledQuantity: 0,
        totalCents: 0,
      })),
      financials: buildOrderEditFinancials({
        lines: [
          { id: h.snapshot().lines[0].id, grossCents: 2000, netCents: 2000 },
        ],
        itemsNetCents: 2000,
        itemDiscountLabels: [],
        shippingGrossCents: 0,
        shippingCents: 0,
        shippingDiscountLabels: [],
        taxCents: 0,
        taxesIncluded: false,
        totalCents: 2000,
      }),
    });
    const result = await h.service.abandon(OP, "staff");
    expect(result).toMatchObject({
      status: "expired",
      canAbandon: false,
      updatedTotalCents: 2000,
      lines: [{ quantity: 2, totalCents: 2000 }],
    });
    expect(h.warehouse.releaseFulfilledUnsubmitted).toHaveBeenCalledOnce();
    expect(h.warehouse.releaseUnchanged).not.toHaveBeenCalled();
    expect(h.record().lastSnapshot).toEqual(h.snapshot());
    expect(h.events.at(-1)?.action).toBe(
      "uncommitted_edit_abandoned_after_fulfillment",
    );
    expect(h.provider.commit).not.toHaveBeenCalled();
    expect(h.provider.refund).not.toHaveBeenCalled();
    expect(h.provider.recoverUnpaid).not.toHaveBeenCalled();
    await h.service.abandon(OP, "staff");
    expect(h.warehouse.releaseFulfilledUnsubmitted).toHaveBeenCalledOnce();
  });
  it.each([
    "quantity",
    "price",
    "payment",
    "customer",
    "discount",
    "partial fulfillment",
  ])(
    "does not bypass cancellation verification after %s changes",
    async (change) => {
      const h = serviceHarness();
      await h.service.quote(h.input, "staff");
      const current = structuredClone(h.snapshot());
      current.closed = true;
      current.fingerprint = "fulfilled";
      current.lines = current.lines.map((line) => ({
        ...line,
        unfulfilledQuantity: 0,
        totalCents: 0,
      }));
      if (change === "quantity") current.lines[0].quantity += 1;
      if (change === "price") current.lines[0].originalUnitPriceCents += 1;
      if (change === "payment")
        current.transactions = [
          {
            id: "pending",
            parentId: null,
            kind: "SALE",
            status: "PENDING",
            gateway: "shopify_payments",
            amountCents: 1,
            manual: false,
          },
        ];
      if (change === "customer")
        current.customerId = "gid://shopify/Customer/999";
      if (change === "discount")
        current.lines[0].discountFingerprint = "changed";
      if (change === "partial fulfillment")
        current.lines[0].unfulfilledQuantity = 1;
      h.setCurrent(current);
      expect((await h.service.abandon(OP, "staff")).status).toBe(
        "review_required",
      );
      expect(h.warehouse.releaseUnchanged).not.toHaveBeenCalled();
      expect(h.warehouse.releaseFulfilledUnsubmitted).not.toHaveBeenCalled();
    },
  );
  it("retains the operation when terminal shipping verification fails", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    h.setCurrent({
      closed: true,
      fingerprint: "fulfilled",
      lines: h.snapshot().lines.map((line) => ({
        ...line,
        unfulfilledQuantity: 0,
        totalCents: 0,
      })),
    });
    h.warehouse.releaseFulfilledUnsubmitted.mockRejectedValueOnce(
      new OrderEditError(
        "ORDER_EDIT_PROVIDER_FULFILLMENT_PENDING",
        "Provider work is active",
      ),
    );
    await expect(h.service.abandon(OP, "staff")).rejects.toMatchObject({
      code: "ORDER_EDIT_PROVIDER_FULFILLMENT_PENDING",
    });
    expect(h.record().status).toBe("ready");
  });
  it.each([
    "unchanged",
    "different allocations",
    "missing breakdown",
    "different rules",
    "missing rules",
  ])(
    "compares exact financial and discount evidence for new operations: %s",
    async (change) => {
      const h = serviceHarness();
      const financials = buildOrderEditFinancials({
        lines: [
          { id: h.snapshot().lines[0].id, grossCents: 2000, netCents: 2000 },
        ],
        itemsNetCents: 2000,
        itemDiscountLabels: [],
        shippingGrossCents: 0,
        shippingCents: 0,
        shippingDiscountLabels: [],
        taxCents: 0,
        taxesIncluded: false,
        totalCents: 2000,
      });
      h.setCurrent({ financials, discountRules: [] });
      await h.service.quote(h.input, "staff");
      const current = structuredClone(h.snapshot());
      current.closed = true;
      current.fingerprint = "fulfilled";
      current.lines = current.lines.map((line) => ({
        ...line,
        unfulfilledQuantity: 0,
        totalCents: 0,
      }));
      if (change === "different allocations")
        current.financials = buildOrderEditFinancials({
          lines: [
            { id: current.lines[0].id, grossCents: 2100, netCents: 2000 },
          ],
          itemsNetCents: 2000,
          itemDiscountLabels: ["New discount"],
          shippingGrossCents: 0,
          shippingCents: 0,
          shippingDiscountLabels: [],
          taxCents: 0,
          taxesIncluded: false,
          totalCents: 2000,
        });
      if (change === "missing breakdown") current.financials = undefined;
      if (change === "different rules")
        current.discountRules = [
          {
            index: 0,
            type: "ManualDiscountApplication",
            targetType: "LINE_ITEM",
            allocationMethod: "ACROSS",
            targetSelection: "ALL",
            label: "New discount",
            value: { type: "fixed", amountCents: 100 },
          },
        ];
      if (change === "missing rules") current.discountRules = undefined;
      h.setCurrent(current);
      const before = structuredClone(h.snapshot());
      expect((await h.service.abandon(OP, "staff")).status).toBe(
        change === "unchanged" ? "expired" : "review_required",
      );
      expect(h.snapshot()).toEqual(before);
      expect(h.warehouse.releaseFulfilledUnsubmitted).toHaveBeenCalledTimes(
        change === "unchanged" ? 1 : 0,
      );
    },
  );
  it("continues polling an in-flight payment while hiding the hosted payment link", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.commit(OP, OP, "staff");
    h.setCurrent({
      transactions: [
        {
          id: "pending",
          parentId: null,
          kind: "SALE",
          status: "PENDING",
          gateway: "shopify_payments",
          amountCents: 1000,
          manual: false,
        },
      ],
    });
    const pending = await h.service.reconcile(OP, "staff");
    expect(pending.status).toBe("awaiting_payment");
    expect(pending.paymentUrl).toBeNull();
    h.setCurrent({
      transactions: [],
      fullyPaid: true,
      netPaidCents: 3000,
      outstandingCents: 0,
    });
    await h.service.sweep();
    expect(h.record().status).toBe("completed");
  });
  it("hides a payment link after expiry without changing the order in a GET", async () => {
    const h = serviceHarness();
    await h.service.quote(h.input, "staff");
    await h.service.commit(OP, OP, "staff");
    h.advance(31 * 60_000);
    expect((await h.service.get(OP)).paymentUrl).toBeNull();
    expect(h.provider.recoverUnpaid).not.toHaveBeenCalled();
  });
  it("reconciles a refund timeout using the original intent instead of creating a second one", async () => {
    const h = serviceHarness(1);
    await h.service.quote(h.input, "staff");
    h.provider.refund.mockRejectedValueOnce(
      new OrderEditProviderError(
        "SHOPIFY_UNAVAILABLE",
        "Response lost",
        "unknown",
      ),
    );
    expect((await h.service.commit(OP, OP, "staff")).status).toBe("refunding");
    await h.service.sweep();
    expect(h.record().status).toBe("completed");
    expect(h.provider.prepareRefund).toHaveBeenCalledTimes(1);
    expect(h.provider.refund.mock.calls[0].slice(1)).toEqual(
      h.provider.refund.mock.calls[1].slice(1),
    );
  });
  it.each(["REFUND_FAILED", "REFUND_AMBIGUOUS", "REFUND_RETRY_WINDOW_EXPIRED"])(
    "requires staff review for %s instead of an automatic refund retry",
    async (code) => {
      const h = serviceHarness(1);
      await h.service.quote(h.input, "staff");
      h.provider.refund.mockRejectedValueOnce(
        new OrderEditProviderError(code, "Manual reconciliation", "unknown"),
      );
      expect((await h.service.commit(OP, OP, "staff")).status).toBe(
        "review_required",
      );
      expect(h.warehouse.reconcileAndRelease).not.toHaveBeenCalled();
    },
  );
  it("offers abandon only before submission, including a rejected quote", async () => {
    const h = serviceHarness();
    h.provider.quote.mockRejectedValueOnce(
      new OrderEditProviderError(
        "PROMOTION_UNSUPPORTED",
        "Unsupported promotion",
      ),
    );
    const rejected = await h.service.quote(h.input, "staff");
    expect(rejected.canAbandon).toBe(true);
    expect((await h.service.abandon(OP, "staff")).canAbandon).toBe(false);
    const submitted = serviceHarness();
    await submitted.service.quote(submitted.input, "staff");
    expect((await submitted.service.commit(OP, OP, "staff")).canAbandon).toBe(
      false,
    );
  });
});
