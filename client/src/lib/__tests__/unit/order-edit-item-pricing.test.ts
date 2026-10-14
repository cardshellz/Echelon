import { describe, expect, it, vi } from "vitest";
import { orderEditOrderSchema } from "@shared/order-edits/order-edit.contract";
import { orderEditCatalogVariantsInputSchema } from "@shared/order-edits/order-edit-catalog";
import type { OrderEditTransport } from "@/lib/order-edits";
import {
  readOrderEditItemPricing,
  readOrderEditPricingTargets,
} from "@/lib/order-edit-item-pricing";

const variantId = "gid://shopify/ProductVariant/10";
const product = {
  productId: "gid://shopify/Product/1",
  title: "Sleeves",
  category: null,
  imageUrl: null,
};
const order = orderEditOrderSchema.parse({
  omsOrderId: 7,
  connectionId: 4,
  orderNumber: "#64043",
  customerName: "Fixture",
  customerEmail: null,
  activeOperationId: null,
  currency: "USD",
  revision: "revision-1",
  eligibility: { editable: true, reasons: [] },
  financialStatus: "Paid",
  warehouseStatus: "Not yet picking",
  totalCents: 233,
  lines: [
    {
      lineItemId: "gid://shopify/LineItem/1",
      variantId,
      title: "Sleeves",
      variantTitle: null,
      sku: "SLEEVE",
      quantity: 1,
      unitPriceCents: 279,
      totalCents: 233,
    },
  ],
});
const option = {
  variantId,
  title: "Sleeves",
  variantTitle: null,
  sku: "SLEEVE",
  priceCents: 279,
  retailPriceCents: 279,
  available: true,
};

function catalog() {
  return {
    catalogProducts: vi
      .fn<OrderEditTransport["catalogProducts"]>()
      .mockImplementation(async (connectionId, input) => ({
        connectionId,
        input,
        products: [product],
        pageInfo: { hasNextPage: false, endCursor: null },
      })),
    catalogVariants: vi
      .fn<OrderEditTransport["catalogVariants"]>()
      .mockImplementation(async (connectionId, input) => ({
        connectionId,
        input: orderEditCatalogVariantsInputSchema.parse(input),
        product,
        variants: [option],
        memberPlan: null,
        pageInfo: { hasNextPage: false, endCursor: null },
      })),
  };
}

describe("owned order item pricing metadata", () => {
  it("restores additions through title discovery and exact owned variant identity without inventing a price", async () => {
    const api = catalog();
    const result = await readOrderEditPricingTargets(
      api,
      order,
      [{ key: variantId, variantId, sku: null, title: "Sleeves", quantity: 1 }],
      new AbortController().signal,
    );
    expect(result).toEqual([[variantId, { variant: option, plan: null }]]);
    expect(api.catalogProducts).toHaveBeenCalledWith(
      4,
      { search: "Sleeves", category: null, after: null },
      expect.any(AbortSignal),
    );
  });
  it("uses SKU only for discovery and matches the exact variant under the owned order revision", async () => {
    const api = catalog();
    api.catalogVariants.mockImplementation(async (connectionId, input) => ({
      connectionId,
      input: orderEditCatalogVariantsInputSchema.parse(input),
      product,
      variants: [
        {
          ...option,
          variantId: "gid://shopify/ProductVariant/99",
          priceCents: 999,
          retailPriceCents: 999,
        },
        option,
      ],
      memberPlan: null,
      pageInfo: { hasNextPage: false, endCursor: null },
    }));
    const signal = new AbortController().signal;
    expect(await readOrderEditItemPricing(api, order, signal)).toEqual([
      [order.lines[0].lineItemId, { variant: option, plan: null }],
    ]);
    expect(api.catalogProducts).toHaveBeenCalledWith(
      4,
      { search: "SLEEVE", category: null, after: null },
      signal,
    );
    expect(api.catalogVariants).toHaveBeenCalledWith(
      4,
      {
        productId: product.productId,
        after: null,
        omsOrderId: 7,
        expectedRevision: "revision-1",
      },
      signal,
    );
    expect(order.lines[0].totalCents).toBe(233);
  });

  it("shares duplicate variant reads and retains original line order", async () => {
    const api = catalog();
    const duplicate = {
      ...order,
      lines: [
        ...order.lines,
        { ...order.lines[0], lineItemId: "gid://shopify/LineItem/2" },
      ],
    };
    const result = await readOrderEditItemPricing(
      api,
      duplicate,
      new AbortController().signal,
    );
    expect(result.map(([lineId]) => lineId)).toEqual(
      duplicate.lines.map((line) => line.lineItemId),
    );
    expect(api.catalogProducts).toHaveBeenCalledTimes(1);
    expect(api.catalogVariants).toHaveBeenCalledTimes(1);
  });

  it("keeps unknown metadata unknown instead of matching another variant or inventing a member plan", async () => {
    const api = catalog();
    api.catalogVariants.mockImplementation(async (connectionId, input) => ({
      connectionId,
      input: orderEditCatalogVariantsInputSchema.parse(input),
      product,
      variants: [{ ...option, variantId: "gid://shopify/ProductVariant/99" }],
      memberPlan: null,
      pageInfo: { hasNextPage: false, endCursor: null },
    }));
    expect(
      await readOrderEditItemPricing(api, order, new AbortController().signal),
    ).toEqual([]);
  });

  it("rejects a repeated pagination cursor rather than looping or selecting an unrelated SKU", async () => {
    const api = catalog();
    api.catalogVariants.mockImplementation(async (connectionId, input) => ({
      connectionId,
      input: orderEditCatalogVariantsInputSchema.parse(input),
      product,
      variants: [],
      memberPlan: null,
      pageInfo: { hasNextPage: true, endCursor: "repeated" },
    }));
    await expect(
      readOrderEditItemPricing(api, order, new AbortController().signal),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_CATALOG_UNAVAILABLE" });
    expect(api.catalogVariants).toHaveBeenCalledTimes(2);
  });

  it("stops cancelled discovery before making a request", async () => {
    const api = catalog();
    const controller = new AbortController();
    controller.abort();
    await expect(
      readOrderEditItemPricing(api, order, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(api.catalogProducts).not.toHaveBeenCalled();
  });
});
