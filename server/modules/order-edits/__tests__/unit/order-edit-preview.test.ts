import { describe, it, expect, vi } from "vitest";
import { OrderEditPreviewService } from "../../application/order-edit-preview.service";
import { OrderEditPreviewCache } from "../../application/order-edit-preview-cache";
import { priceOrderEditPreviewItems as priceDomainItems } from "../../domain/order-edit-preview-pricing";
import { toOrderEditPreviewPricingInput } from "../../application/order-edit-preview-pricing-input";
import {
  previewContext,
  previewInput,
  previewCalculation,
  PREVIEW_NOW,
  PREVIEW_LINE,
  PREVIEW_VARIANT,
} from "../fixtures/order-edit-preview.fixture";
import {
  orderEditPreviewInputSchema,
  orderEditPreviewSchema,
  ORDER_EDIT_PREVIEW_TTL_MS,
} from "@shared/order-edits/order-edit-preview";
import type { OrderEditPreviewContext } from "../../application/order-edit-preview-provider";
import type { OrderEditPlan } from "../../application/order-edit-provider";
import { buildOrderEditFinancials } from "../../domain/order-edit-financials";

function priceOrderEditPreviewItems(
  context: OrderEditPreviewContext,
  plan: OrderEditPlan,
) {
  return priceDomainItems(toOrderEditPreviewPricingInput(context), {
    changes: plan.changes,
    additions: plan.additions,
  });
}

describe("read-only preview pricing", () => {
  it("prices protected member quantity increases while spending the fixed reward once", () => {
    const context = previewContext();
    const before = structuredClone(context);
    const priced = priceOrderEditPreviewItems(context, previewInput());
    expect(priced.itemsNetCents).toBe(22098);
    expect(
      priced.discounts.find((d) => d.key === "code:Reward")?.amountCents,
    ).toBe(1900);
    expect(priced.discounts.find((d) => d.key === "product")?.amountCents).toBe(
      6000,
    );
    expect(priced.lines.map((line) => line.quantity)).toEqual([1, 1]);
    expect(context).toEqual(before);
  });
  it("uses the canonical percentage/fixed stacking after product discounts", () => {
    const context = previewContext();
    context.snapshot.discountRules!.push({
      index: 2,
      type: "DiscountCodeApplication",
      targetType: "LINE_ITEM",
      allocationMethod: "ACROSS",
      targetSelection: "ALL",
      label: "TEN",
      value: { type: "percentage", percentage: 10 },
    });
    const priced = priceOrderEditPreviewItems(context, previewInput());
    expect(priced.itemsNetCents).toBe(19698);
    expect(
      priced.discounts.find((d) => d.key === "code:TEN")?.amountCents,
    ).toBe(2400);
    expect(
      priced.discounts.find((d) => d.key === "code:Reward")?.amountCents,
    ).toBe(1900);
  });
  it("counts a newly added variant and applies its own member price", () => {
    const context = previewContext();
    context.variants.push({
      variantId: "gid://shopify/ProductVariant/20",
      title: "Box",
      variantTitle: null,
      retailCents: 2000,
      memberCents: 1500,
      available: true,
      availableQuantity: 2,
    });
    const priced = priceOrderEditPreviewItems(context, {
      changes: [],
      additions: [
        { variantId: "gid://shopify/ProductVariant/20", quantity: 2 },
      ],
    });
    expect(priced.itemsNetCents).toBe(13099);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "rejects invalid/removing-all quantity %s",
    (quantity) => {
      expect(() =>
        priceOrderEditPreviewItems(previewContext(), previewInput(quantity)),
      ).toThrow();
    },
  );
  it("handles exact reductions and rejects fractional prorating", () => {
    const context = previewContext();
    const line = context.snapshot.lines[0];
    line.quantity = line.unfulfilledQuantity = 2;
    context.snapshot.previewProductDiscounts![0].amountCents = 6000;
    context.snapshot.previewProductDiscounts![0].automaticCents = 6000;
    context.snapshot.totalCents =
      context.snapshot.subtotalCents =
      context.snapshot.netPaidCents =
        22098;
    line.totalCents = 23998;
    context.snapshot.financials = buildOrderEditFinancials({
      lines: [{ id: PREVIEW_LINE, grossCents: 29998, netCents: 22098 }],
      itemsNetCents: 22098,
      itemDiscountLabels: ["Member discount", "Reward"],
      shippingGrossCents: 1199,
      shippingCents: 0,
      shippingDiscountLabels: ["Member free shipping"],
      taxCents: 0,
      taxesIncluded: false,
      totalCents: 22098,
    });
    expect(
      priceOrderEditPreviewItems(context, previewInput(1)).itemsNetCents,
    ).toBe(10099);
    context.snapshot.previewProductDiscounts![0].amountCents = 6001;
    expect(() => priceOrderEditPreviewItems(context, previewInput(1))).toThrow(
      /exact cents/,
    );
  });
  it("rejects unused rewards, changed member prices, stock shortages and unknown identities", () => {
    const variants = [
      previewContext(),
      previewContext(),
      previewContext(),
      previewContext(),
    ];
    variants[0].snapshot.discountRules![1].value = {
      type: "fixed",
      amountCents: 50000,
    };
    variants[1].variants[0].memberCents = 12000;
    variants[2].variants[0].availableQuantity = 0;
    variants[3].snapshot.previewProductDiscounts = [];
    for (const context of variants)
      expect(() =>
        priceOrderEditPreviewItems(context, previewInput()),
      ).toThrow();
    expect(() =>
      priceOrderEditPreviewItems(previewContext(), {
        changes: [{ lineItemId: "gid://shopify/LineItem/99", quantity: 2 }],
        additions: [],
      }),
    ).toThrow();
  });
  it("rejects incomplete, duplicate, unsafe money and unsupported discount scopes", () => {
    const contexts = [
      previewContext(),
      previewContext(),
      previewContext(),
      previewContext(),
    ];
    delete contexts[0].snapshot.previewProductDiscounts;
    contexts[1].variants.push(contexts[1].variants[0]);
    contexts[2].variants[0].retailCents = Number.MAX_SAFE_INTEGER + 1;
    contexts[3].snapshot.discountRules![1].targetSelection = "ENTITLED";
    for (const c of contexts)
      expect(() => priceOrderEditPreviewItems(c, previewInput())).toThrow();
  });
  it("rejects extraneous product evidence and unreconciled financial evidence", () => {
    const context = previewContext();
    context.snapshot.previewProductDiscounts!.push({
      lineId: "gid://shopify/LineItem/99",
      amountCents: 0,
      automaticCents: 0,
    });
    expect(() => priceOrderEditPreviewItems(context, previewInput())).toThrow(
      /exact product discount evidence/,
    );
    const malformed = previewContext();
    malformed.snapshot.financials!.totalCents += 1;
    expect(() => toOrderEditPreviewPricingInput(malformed)).toThrow();
  });
});

function harness() {
  let now = PREVIEW_NOW;
  const context = previewContext();
  const reference = {
    connectionId: 4,
    channelId: 36,
    omsOrderId: 1,
    externalOrderId: "100",
    externalCustomerId: "8",
    orderNumber: "#100",
    customerName: "Fixture",
    customerEmail: null,
    activeOperationId: null as string | null,
  };
  const store = {
    settings: vi.fn(async () => ({
      connectionId: 4,
      channelId: 36,
      name: "Fixture",
      shopDomain: "fixture.myshopify.com",
      enabled: true,
      paymentWindowMinutes: 30,
    })),
    orderReference: vi.fn(async () => structuredClone(reference)),
    create: vi.fn(),
    save: vi.fn(),
  };
  const provider = {
    readOrder: vi.fn(async () => structuredClone(context.snapshot)),
    preparePreview: vi.fn(async () => structuredClone(context)),
    preview: vi.fn(
      async (value: OrderEditPreviewContext, plan: OrderEditPlan) =>
        previewCalculation(value, { ...previewInput(), ...plan }),
    ),
    quote: vi.fn(),
    commit: vi.fn(),
    refund: vi.fn(),
  };
  const warehouse = {
    inspect: vi.fn(async () => ({
      editable: true,
      reasons: [] as string[],
      wmsOrderIds: [1],
    })),
    acquire: vi.fn(),
    releaseUnchanged: vi.fn(),
  };
  const service = new OrderEditPreviewService(
    store,
    provider,
    warehouse,
    () => new Date(now),
  );
  return {
    service,
    store,
    provider,
    warehouse,
    context,
    reference,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const scope = () => {
  const { changes, additions, ...s } = previewInput();
  return s;
};
describe("preview scope and read-only cache", () => {
  it("warms once, deduplicates identical previews and never acquires holds or creates operations", async () => {
    const h = harness();
    await h.service.warm(scope(), "staff-a");
    const [one, two] = await Promise.all([
      h.service.preview(previewInput(), "staff-a"),
      h.service.preview(previewInput(), "staff-a"),
    ]);
    expect(one).toEqual(two);
    expect(one.phase).toBe("preview");
    expect(h.provider.readOrder).toHaveBeenCalledTimes(1);
    expect(h.provider.preparePreview).toHaveBeenCalledTimes(1);
    expect(h.provider.preview).toHaveBeenCalledTimes(1);
    for (const fn of [
      h.provider.quote,
      h.provider.commit,
      h.provider.refund,
      h.warehouse.acquire,
      h.store.create,
      h.store.save,
    ])
      expect(fn).not.toHaveBeenCalled();
    one.financials.totalCents = 1;
    expect(
      (await h.service.preview(previewInput(), "staff-a")).financials
        .totalCents,
    ).toBe(22098);
  });
  it("isolates actors, quantities, additions and refreshes expired pricing context", async () => {
    const h = harness();
    await h.service.preview(previewInput(), "staff-a");
    await h.service.preview(previewInput(3), "staff-a");
    await h.service.preview(previewInput(), "staff-b");
    expect(h.provider.readOrder).toHaveBeenCalledTimes(2);
    expect(h.provider.preview).toHaveBeenCalledTimes(3);
    h.advance(ORDER_EDIT_PREVIEW_TTL_MS);
    await h.service.preview(previewInput(), "staff-a");
    expect(h.provider.readOrder).toHaveBeenCalledTimes(3);
  });
  it("checks live enablement and existing operations before reusing cached results", async () => {
    const h = harness();
    await h.service.preview(previewInput(), "staff-a");
    h.reference.activeOperationId = "active-operation";
    await expect(
      h.service.preview(previewInput(), "staff-a"),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_ALREADY_ACTIVE" });
    h.reference.activeOperationId = null;
    h.store.settings.mockResolvedValue({
      ...(await h.store.settings()),
      enabled: false,
    });
    await expect(
      h.service.preview(previewInput(), "staff-a"),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_DISABLED" });
    expect(h.provider.preview).toHaveBeenCalledTimes(1);
  });
  it("rejects changed revision, customer/channel mapping and picking", async () => {
    const h = harness();
    await expect(
      h.service.preview(
        { ...previewInput(), expectedRevision: "wrong" },
        "staff-a",
      ),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_ORDER_CHANGED" });
    h.reference.externalCustomerId = "999";
    await expect(h.service.warm(scope(), "staff-a")).rejects.toMatchObject({
      code: "ORDER_EDIT_IDENTITY_CHANGED",
    });
    h.reference.externalCustomerId = "8";
    h.reference.channelId = 99;
    await expect(h.service.warm(scope(), "staff-a")).rejects.toMatchObject({
      code: "ORDER_EDIT_IDENTITY_CHANGED",
    });
    h.reference.channelId = 36;
    h.warehouse.inspect.mockResolvedValue({
      editable: false,
      reasons: ["Picking started"],
      wmsOrderIds: [1],
    });
    await expect(h.service.warm(scope(), "staff-a")).rejects.toMatchObject({
      code: "ORDER_EDIT_UNAVAILABLE",
    });
    expect(h.provider.preview).not.toHaveBeenCalled();
  });
  it("does not cache failed calculations or late responses past context expiry", async () => {
    const h = harness();
    h.provider.preview.mockRejectedValueOnce(new Error("rate unavailable"));
    await expect(h.service.preview(previewInput(), "staff-a")).rejects.toThrow(
      "rate unavailable",
    );
    expect(
      (await h.service.preview(previewInput(), "staff-a")).financials
        .totalCents,
    ).toBe(22098);
    h.provider.preview.mockImplementationOnce(async () => {
      h.advance(ORDER_EDIT_PREVIEW_TTL_MS);
      return previewCalculation();
    });
    await expect(
      h.service.preview(previewInput(3), "staff-a"),
    ).rejects.toThrow();
  });
  it("strictly rejects command keys, browser prices and foreign fields on a preview", () => {
    for (const extra of [
      { requestKey: "uuid" },
      { totalCents: 1 },
      { customerId: "8" },
    ])
      expect(
        orderEditPreviewInputSchema.safeParse({ ...previewInput(), ...extra })
          .success,
      ).toBe(false);
    const value = {
      phase: "preview",
      input: previewInput(),
      calculatedAt: new Date(PREVIEW_NOW).toISOString(),
      expiresAt: new Date(PREVIEW_NOW + 60000).toISOString(),
      ...previewCalculation(),
    };
    expect(orderEditPreviewSchema.safeParse(value).success).toBe(true);
    expect(
      orderEditPreviewSchema.safeParse({
        ...value,
        phase: "ready",
        operationId: "uuid",
      }).success,
    ).toBe(false);
  });
});

describe("bounded preview cache", () => {
  it("rejects an invalid injected clock instead of retaining unbounded-expiry entries", async () => {
    const cache = new OrderEditPreviewCache(() => new Date(Number.NaN), 1, 1);
    const loader = vi.fn(async () => ({
      value: null,
      expiresAt: PREVIEW_NOW + 1000,
    }));
    await expect(
      cache.getOrLoad("invalid-clock", loader),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_PREVIEW_CLOCK_INVALID" });
    expect(loader).not.toHaveBeenCalled();
  });
  it("bounds concurrent work, shares matching work, evicts old results and does not cache failures", async () => {
    const cache = new OrderEditPreviewCache<{ total: number }>(
      () => new Date(PREVIEW_NOW),
      1,
      1,
    );
    let finish!: (value: {
      value: { total: number };
      expiresAt: number;
    }) => void;
    const loader = vi.fn(
      () =>
        new Promise<{ value: { total: number }; expiresAt: number }>((r) => {
          finish = r;
        }),
    );
    const one = cache.getOrLoad("one", loader);
    const same = cache.getOrLoad("one", loader);
    await expect(cache.getOrLoad("other", loader)).rejects.toMatchObject({
      code: "ORDER_EDIT_PREVIEW_BUSY",
    });
    finish({ value: { total: 1 }, expiresAt: PREVIEW_NOW + 1000 });
    expect(await one).toEqual(await same);
    expect(loader).toHaveBeenCalledTimes(1);
    await cache.getOrLoad("two", async () => ({
      value: { total: 2 },
      expiresAt: PREVIEW_NOW + 1000,
    }));
    const reload = vi.fn(async () => ({
      value: { total: 3 },
      expiresAt: PREVIEW_NOW + 1000,
    }));
    await cache.getOrLoad("one", reload);
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(
      cache.getOrLoad("failed", async () => {
        throw new Error("unavailable");
      }),
    ).rejects.toThrow("unavailable");
    expect((await cache.getOrLoad("failed", reload)).value.total).toBe(3);
  });
});
